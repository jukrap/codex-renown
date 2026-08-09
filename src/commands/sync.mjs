import { createHash, randomUUID } from 'node:crypto';
import * as defaultFileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { collectCodexProfile } from '../collectors/codex-profile.mjs';
import { collectDeviceUsage } from './collect.mjs';
import { LOCAL_CONFIG_FILENAME, loadLocalConfig } from '../config.mjs';
import {
  SCHEMA_VERSION,
  validateDeviceSnapshot,
  validateProfileCandidate,
} from '../domain/schema.mjs';
import { GitPublishError, publishChanges } from '../git/publish.mjs';
import { stableStringify, writeJsonAtomic } from '../lib/atomic-file.mjs';
import { CLI_NAME, TARGET_REPOSITORY } from '../product.mjs';

const DEVICE_ID_PATTERN = /^device-[0-9a-f]{32}$/;
const TEMP_PREFIX = 'agent-card-sync-';
const HELP = `Usage: ${CLI_NAME} sync

Collect and publish only this device's sanitized usage snapshots.
Account profile failures publish device fallback data with a sanitized error code.
Run this command from a dedicated clone of ${TARGET_REPOSITORY}.
`;

const ERROR_MESSAGES = Object.freeze({
  CLOCK_INVALID: 'The synchronization clock is invalid',
  LOCAL_CONFIG_CHANGED: 'The local configuration changed during synchronization',
  PROFILE_CANDIDATE_INVALID: 'The profile candidate is invalid',
  PUBLIC_FILE_INVALID: 'An existing public data file is invalid',
  TEMP_CLEANUP_FAILED: 'Temporary synchronization files could not be removed',
  TEMP_CREATE_FAILED: 'Temporary synchronization storage could not be created',
  WRITER_KEY_CONFLICT: 'The public snapshot belongs to a different local writer',
});

export class SyncCommandError extends GitPublishError {
  constructor(code) {
    super(code);
    this.name = 'SyncCommandError';
    this.message = ERROR_MESSAGES[code] ?? 'Device synchronization failed';
  }
}

function syncError(code) {
  return new SyncCommandError(code);
}

function write(stream, value) {
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
}

function safeProfileErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : 'APP_SERVER_FAILED';
}

function writerKeyHash(writerKey) {
  return createHash('sha256').update(writerKey, 'utf8').digest('hex');
}

function safeInstant(now) {
  let value;
  try {
    value = now();
  } catch {
    throw syncError('CLOCK_INVALID');
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw syncError('CLOCK_INVALID');
  }
  return value.toISOString();
}

async function readJsonIfPresent(filePath, validate, fileSystem) {
  let contents;
  try {
    contents = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw syncError('PUBLIC_FILE_INVALID');
  }
  try {
    return {
      value: validate(JSON.parse(contents)),
      contents,
    };
  } catch {
    throw syncError('PUBLIC_FILE_INVALID');
  }
}

async function writeContentsAtomic({
  filePath,
  contents,
  fileSystem,
  stagingDirectory,
}) {
  const temporaryPath = path.join(
    stagingDirectory,
    `agent-card-sync-${process.pid}-${randomUUID()}.tmp`,
  );
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fileSystem.rename(temporaryPath, filePath);
  } catch {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw syncError('PUBLIC_FILE_INVALID');
      }
    }
    throw syncError('PUBLIC_FILE_INVALID');
  }
}

async function writeRawAtomic(
  filePath,
  contents,
  validate,
  fileSystem,
  stagingDirectory,
) {
  try {
    validate(JSON.parse(contents));
  } catch {
    throw syncError('PUBLIC_FILE_INVALID');
  }
  await writeContentsAtomic({
    filePath,
    contents,
    fileSystem,
    stagingDirectory,
  });
}

async function writeJsonDestinationAtomic(
  filePath,
  value,
  validate,
  fileSystem,
  stagingDirectory,
) {
  try {
    validate(value);
    await writeContentsAtomic({
      filePath,
      contents: stableStringify(value),
      fileSystem,
      stagingDirectory,
    });
  } catch (error) {
    if (error instanceof GitPublishError) {
      throw error;
    }
    throw syncError('PUBLIC_FILE_INVALID');
  }
}

function assertOwnership(value, config, publicWriterKeyHash) {
  if (value !== null
    && (value.deviceId !== config.deviceId
      || value.writerKeyHash !== publicWriterKeyHash)) {
    throw syncError('WRITER_KEY_CONFLICT');
  }
}

function sameConfig(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.deviceId === right.deviceId
    && left.writerKey === right.writerKey
    && left.timezone === right.timezone;
}

function publicPaths(config) {
  if (!DEVICE_ID_PATTERN.test(config.deviceId)) {
    throw syncError('PUBLIC_FILE_INVALID');
  }
  return {
    device: `data/devices/${config.deviceId}.json`,
    profile: `data/profiles/${config.deviceId}.json`,
  };
}

async function defaultCollectProfile({
  cwd,
  config,
  env,
  profileRunner,
  collectedAt,
}) {
  const normalized = await collectCodexProfile({
    cwd,
    env,
    runner: profileRunner,
    collectedAt,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'codex-profile',
    deviceId: config.deviceId,
    writerKeyHash: writerKeyHash(config.writerKey),
    collectedAt,
    dateBasis: normalized.dateBasis,
    daily: normalized.daily,
    ...(Object.hasOwn(normalized, 'lifetimeTotalTokens')
      ? { lifetimeTotalTokens: normalized.lifetimeTotalTokens }
      : {}),
    coverage: normalized.coverage,
  };
}

function quietIo() {
  const sink = { write() {} };
  return { stdout: sink, stderr: sink };
}

async function defaultValidateRepository({ cwd }) {
  const validator = await import('./validate.mjs');
  if (typeof validator.validateRepository === 'function') {
    return validator.validateRepository({ cwd });
  }
  if (typeof validator.validatePublicArtifacts === 'function') {
    return validator.validatePublicArtifacts({ cwd });
  }
  if (typeof validator.run !== 'function') {
    throw new TypeError('validate command has no programmatic entry point');
  }
  const status = await validator.run([], quietIo(), { cwd });
  if (status !== 0) {
    throw new TypeError('repository validation failed');
  }
  return true;
}

async function createTemporaryDirectory(fileSystem) {
  try {
    return await fileSystem.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  } catch {
    throw syncError('TEMP_CREATE_FAILED');
  }
}

async function cleanupTemporaryDirectory(directory, fileSystem) {
  const resolvedDirectory = path.resolve(directory);
  const expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolvedDirectory) !== expectedParent
    || !path.basename(resolvedDirectory).startsWith(TEMP_PREFIX)) {
    throw syncError('TEMP_CLEANUP_FAILED');
  }
  try {
    await fileSystem.rm(resolvedDirectory, { recursive: true, force: true });
  } catch {
    throw syncError('TEMP_CLEANUP_FAILED');
  }
}

async function restoreArtifact(
  filePath,
  previous,
  validate,
  fileSystem,
  stagingDirectory,
) {
  if (previous === null) {
    try {
      await fileSystem.unlink(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw syncError('PUBLIC_FILE_INVALID');
      }
    }
    return;
  }
  await writeRawAtomic(
    filePath,
    previous.contents,
    validate,
    fileSystem,
    stagingDirectory,
  );
}

async function installArtifacts({
  devicePath,
  profilePath,
  device,
  profile,
  previousDevice,
  previousProfile,
  fileSystem,
  stagingDirectory,
}) {
  let deviceInstalled = false;
  let profileInstalled = false;
  try {
    await writeJsonDestinationAtomic(
      devicePath,
      device,
      validateDeviceSnapshot,
      fileSystem,
      stagingDirectory,
    );
    deviceInstalled = true;
    if (profile !== null) {
      await writeJsonDestinationAtomic(
        profilePath,
        profile,
        validateProfileCandidate,
        fileSystem,
        stagingDirectory,
      );
      profileInstalled = true;
    }
  } catch (error) {
    try {
      if (profileInstalled) {
        await restoreArtifact(
          profilePath,
          previousProfile,
          validateProfileCandidate,
          fileSystem,
          stagingDirectory,
        );
      }
      if (deviceInstalled) {
        await restoreArtifact(
          devicePath,
          previousDevice,
          validateDeviceSnapshot,
          fileSystem,
          stagingDirectory,
        );
      }
    } catch {
      throw syncError('PUBLIC_FILE_INVALID');
    }
    if (error instanceof GitPublishError) {
      throw error;
    }
    throw syncError('PUBLIC_FILE_INVALID');
  }

  return async () => {
    await restoreArtifact(
      devicePath,
      previousDevice,
      validateDeviceSnapshot,
      fileSystem,
      stagingDirectory,
    );
    if (profile !== null) {
      await restoreArtifact(
        profilePath,
        previousProfile,
        validateProfileCandidate,
        fileSystem,
        stagingDirectory,
      );
    }
  };
}

export async function synchronizeDevice({
  cwd = process.cwd(),
  env = process.env,
  now = () => new Date(),
  profileRunner,
  gitRunner,
  usageRunner,
  collectUsage,
  fileSystem = defaultFileSystem,
  loadConfig = loadLocalConfig,
  collectSnapshot = collectDeviceUsage,
  collectProfile = defaultCollectProfile,
  validateRepository = defaultValidateRepository,
  publishChangesImpl = publishChanges,
  maxPushAttempts,
} = {}) {
  let pendingRollback = null;
  const rollbackPending = async () => {
    const rollback = pendingRollback;
    if (rollback === null) {
      return;
    }
    await rollback();
    if (pendingRollback === rollback) {
      pendingRollback = null;
    }
  };
  const completePending = async () => {
    pendingRollback = null;
  };

  return publishChangesImpl({
    cwd,
    runner: gitRunner,
    fileSystem,
    maxPushAttempts,
    resolvePlan: async () => {
      const configPath = path.join(cwd, LOCAL_CONFIG_FILENAME);
      const config = await loadConfig(configPath, { fileSystem });
      const paths = publicPaths(config);
      const publicWriterKeyHash = writerKeyHash(config.writerKey);
      const deviceDestination = path.join(cwd, ...paths.device.split('/'));
      const profileDestination = path.join(cwd, ...paths.profile.split('/'));
      const stagingDirectory = path.join(cwd, '.git');

      return {
        allowedPaths: [paths.device, paths.profile],
        collisionPaths: [paths.device, paths.profile],
        commitMessage: 'feat(data): anonymized usage snapshot update',
        rollback: rollbackPending,
        complete: completePending,
        validate: async () => {
          const currentConfig = await loadConfig(configPath, { fileSystem });
          if (!sameConfig(config, currentConfig)) {
            throw syncError('LOCAL_CONFIG_CHANGED');
          }
          const currentDevice = await readJsonIfPresent(
            deviceDestination,
            validateDeviceSnapshot,
            fileSystem,
          );
          const currentProfile = await readJsonIfPresent(
            profileDestination,
            validateProfileCandidate,
            fileSystem,
          );
          assertOwnership(currentDevice?.value ?? null, config, publicWriterKeyHash);
          assertOwnership(currentProfile?.value ?? null, config, publicWriterKeyHash);
          const result = await validateRepository({ cwd, fileSystem });
          if (result === false) {
            throw new TypeError('invalid public repository');
          }
          return true;
        },
        build: async () => {
          const previousDevice = await readJsonIfPresent(
            deviceDestination,
            validateDeviceSnapshot,
            fileSystem,
          );
          const previousProfile = await readJsonIfPresent(
            profileDestination,
            validateProfileCandidate,
            fileSystem,
          );
          assertOwnership(previousDevice?.value ?? null, config, publicWriterKeyHash);
          assertOwnership(previousProfile?.value ?? null, config, publicWriterKeyHash);

          const temporaryDirectory = await createTemporaryDirectory(fileSystem);
          const temporaryDevicePath = path.join(temporaryDirectory, 'device.json');
          const temporaryProfilePath = path.join(temporaryDirectory, 'profile.json');
          try {
            if (previousDevice !== null) {
              await writeJsonAtomic(temporaryDevicePath, previousDevice.value, {
                validate: validateDeviceSnapshot,
                fileSystem,
              });
            }

            await collectSnapshot({
              cwd,
              configPath,
              snapshotPath: temporaryDevicePath,
              now,
              runner: usageRunner,
              collectUsage,
              fileSystem,
            });
            const deviceRecord = await readJsonIfPresent(
              temporaryDevicePath,
              validateDeviceSnapshot,
              fileSystem,
            );
            if (deviceRecord === null) {
              throw syncError('PUBLIC_FILE_INVALID');
            }
            const device = deviceRecord.value;
            assertOwnership(device, config, publicWriterKeyHash);

            const profileCollectedAt = safeInstant(now);
            let candidate = null;
            let profileErrorCode = null;
            try {
              candidate = await collectProfile({
                cwd,
                config,
                env,
                profileRunner,
                collectedAt: profileCollectedAt,
                fileSystem,
              });
            } catch (error) {
              profileErrorCode = safeProfileErrorCode(error);
              candidate = null;
            }

            let profile = null;
            if (candidate !== null) {
              try {
                validateProfileCandidate(candidate);
              } catch {
                throw syncError('PROFILE_CANDIDATE_INVALID');
              }
              assertOwnership(candidate, config, publicWriterKeyHash);
              await writeJsonAtomic(temporaryProfilePath, candidate, {
                validate: validateProfileCandidate,
                fileSystem,
              });
              const profileRecord = await readJsonIfPresent(
                temporaryProfilePath,
                validateProfileCandidate,
                fileSystem,
              );
              profile = profileRecord?.value ?? null;
            }

            const latestConfig = await loadConfig(configPath, { fileSystem });
            if (!sameConfig(config, latestConfig)) {
              throw syncError('LOCAL_CONFIG_CHANGED');
            }
            const latestDevice = await readJsonIfPresent(
              deviceDestination,
              validateDeviceSnapshot,
              fileSystem,
            );
            const latestProfile = await readJsonIfPresent(
              profileDestination,
              validateProfileCandidate,
              fileSystem,
            );
            assertOwnership(latestDevice?.value ?? null, config, publicWriterKeyHash);
            assertOwnership(latestProfile?.value ?? null, config, publicWriterKeyHash);

            pendingRollback = await installArtifacts({
              devicePath: deviceDestination,
              profilePath: profileDestination,
              device,
              profile,
              previousDevice: latestDevice,
              previousProfile: latestProfile,
              fileSystem,
              stagingDirectory,
            });
            return {
              stagePaths: profile === null
                ? [paths.device]
                : [paths.device, paths.profile],
              profileStatus: profile === null ? 'fallback' : 'updated',
              profileErrorCode: profile === null ? profileErrorCode : null,
            };
          } finally {
            try {
              await cleanupTemporaryDirectory(temporaryDirectory, fileSystem);
            } catch (error) {
              if (pendingRollback !== null) {
                try {
                  await rollbackPending();
                } catch {
                  throw syncError('PUBLIC_FILE_INVALID');
                }
              }
              throw error;
            }
          }
        },
      };
    },
  });
}

export async function run(
  args = [],
  io = { stdout: process.stdout, stderr: process.stderr },
  dependencies = {},
) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    write(io.stdout, HELP);
    return 0;
  }
  if (args.length !== 0) {
    write(io.stderr, 'Sync failed: INVALID_ARGUMENT');
    return 2;
  }

  try {
    const result = await synchronizeDevice(dependencies);
    const profileStatus = result.profileStatus === 'updated'
      ? 'account profile updated'
      : result.profileErrorCode === null || result.profileErrorCode === undefined
        ? 'device fallback'
        : 'device fallback; account profile failed: '
          + safeProfileErrorCode({ code: result.profileErrorCode });
    if (result.status === 'noop') {
      write(io.stdout, `Snapshots are already up to date (${profileStatus}).`);
    } else {
      write(io.stdout, `Sanitized snapshots published (${profileStatus}).`);
    }
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : 'SYNC_FAILED';
    write(io.stderr, `Sync failed: ${code}`);
    return 1;
  }
}
