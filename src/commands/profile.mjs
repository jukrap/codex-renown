import { createHash } from 'node:crypto';
import * as defaultFileSystem from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  CodexProfileError,
  collectCodexProfile,
} from '../collectors/codex-profile.mjs';
import { SCHEMA_VERSION, validateProfileCandidate } from '../domain/schema.mjs';
import { writeJsonAtomic } from '../lib/atomic-file.mjs';
import { CLI_NAME } from '../product.mjs';

const DEVICE_ID_PATTERN = /^device-[0-9a-f]{32}$/;
const WRITER_KEY_PATTERN = /^[0-9a-f]{64}$/;

const HELP = `Collect the experimental Codex account profile

Usage:
  ${CLI_NAME} profile

Requirements:
  Install a recent Codex CLI and sign in with ChatGPT before running this command.
  API-key users and unsupported App Server versions can still use local-log cards.

Windows:
  Prefer the npm-installed native CLI binary on PATH over packaged codex.exe.

Options:
  AGENT_CARD_CODEX_BIN may point to an absolute Codex CLI executable path.

The account usage API is experimental. Collection failures preserve the last
valid profile candidate, and rendering retains it as the last account snapshot.
`;

function write(stream, value) {
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
}

async function defaultLoadConfig(configPath, options) {
  const { loadLocalConfig } = await import('../config.mjs');
  return loadLocalConfig(configPath, options);
}

function safeConfig(config) {
  if (config === null
    || typeof config !== 'object'
    || config.schemaVersion !== 1
    || !DEVICE_ID_PATTERN.test(config.deviceId)
    || !WRITER_KEY_PATTERN.test(config.writerKey)) {
    throw new TypeError('invalid local configuration');
  }
  return config;
}

async function readExistingCandidate(candidatePath, fileSystem) {
  let contents;
  try {
    contents = await fileSystem.readFile(candidatePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    const safeError = new Error('Profile candidate read failed');
    safeError.code = 'PROFILE_READ_ERROR';
    throw safeError;
  }

  try {
    return validateProfileCandidate(JSON.parse(contents));
  } catch {
    const safeError = new Error('Existing profile candidate is invalid');
    safeError.code = 'EXISTING_PROFILE_INVALID';
    throw safeError;
  }
}

function safeCollectedAt(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('invalid clock');
  }
  return value.toISOString();
}

function commandFailure(io, code) {
  write(io.stderr, `Codex profile collection failed: ${code}`);
  return 1;
}

export async function run(
  args = [],
  io = { stdout: process.stdout, stderr: process.stderr },
  {
    cwd = process.cwd(),
    env = process.env,
    now = () => new Date(),
    profileRunner,
    loadConfig = defaultLoadConfig,
    fileSystem = defaultFileSystem,
    writeProfile = writeJsonAtomic,
  } = {},
) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    write(io.stdout, HELP);
    return 0;
  }
  if (args.length !== 0) {
    write(io.stderr, 'Usage error: profile accepts no arguments');
    return 2;
  }

  const configPath = path.join(cwd, '.agent-card.local.json');
  let config;
  try {
    config = safeConfig(await loadConfig(configPath, { fileSystem }));
  } catch {
    return commandFailure(io, 'CONFIG_ERROR');
  }

  const writerKeyHash = createHash('sha256')
    .update(config.writerKey, 'utf8')
    .digest('hex');
  const destination = path.join(cwd, 'data', 'profiles', `${config.deviceId}.json`);
  let existing;
  try {
    existing = await readExistingCandidate(destination, fileSystem);
  } catch (error) {
    return commandFailure(io, error?.code === 'PROFILE_READ_ERROR'
      ? 'PROFILE_READ_ERROR'
      : 'EXISTING_PROFILE_INVALID');
  }
  if (existing
    && (existing.deviceId !== config.deviceId
      || existing.writerKeyHash !== writerKeyHash)) {
    return commandFailure(io, 'WRITER_KEY_CONFLICT');
  }

  let collectedAt;
  try {
    collectedAt = safeCollectedAt(now);
  } catch {
    return commandFailure(io, 'CLOCK_ERROR');
  }

  let normalized;
  try {
    normalized = await collectCodexProfile({
      cwd,
      env,
      runner: profileRunner,
      collectedAt,
    });
  } catch (error) {
    return commandFailure(
      io,
      error instanceof CodexProfileError ? error.code : 'APP_SERVER_FAILED',
    );
  }

  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'codex-profile',
    deviceId: config.deviceId,
    writerKeyHash,
    collectedAt,
    dateBasis: normalized.dateBasis,
    daily: normalized.daily,
    ...(Object.hasOwn(normalized, 'lifetimeTotalTokens')
      ? { lifetimeTotalTokens: normalized.lifetimeTotalTokens }
      : {}),
    coverage: normalized.coverage,
  };
  try {
    await writeProfile(destination, candidate, {
      validate: validateProfileCandidate,
      fileSystem,
    });
  } catch {
    return commandFailure(io, 'WRITE_ERROR');
  }

  write(io.stdout, `Codex profile snapshot updated (${candidate.daily.length} daily buckets).`);
  return 0;
}
