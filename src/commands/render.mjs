import * as defaultFileSystem from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  CARD_ARTIFACT_PATHS,
  CARD_NAMES,
  THEME_NAMES,
  cardFilename,
} from '../card-catalog.mjs';
import {
  assertIsoDate,
  assertIsoUtcInstant,
  dateAtInstant,
  endOfDayInstant,
} from '../domain/calendar.mjs';
import { mergeUsage } from '../domain/merge.mjs';
import {
  validateDeviceSnapshot,
  validateProfileCandidate,
} from '../domain/schema.mjs';
import { computeStatistics } from '../domain/statistics.mjs';
import { withRepositoryLock as defaultWithRepositoryLock } from '../git/repository.mjs';
import { CLI_NAME } from '../product.mjs';
import { renderAchievements } from '../render/achievements.mjs';
import { renderActivity } from '../render/activity.mjs';
import { renderCompact } from '../render/compact.mjs';
import { renderOverview } from '../render/overview.mjs';
import { renderRecords } from '../render/records.mjs';
import { validateSvgDocument } from '../render/svg-validator.mjs';
import { renderTrends } from '../render/trends.mjs';
import { renderTrophyCase } from '../render/trophy-case.mjs';


const HELP = `Render deterministic static SVG cards

Usage:
  ${CLI_NAME} render --as-of YYYY-MM-DD [--as-of-instant ISO_UTC_INSTANT]

The optional instant controls freshness checks. Without it, freshness uses the
deterministic end of the as-of date in the configured timezone.
`;

export class RenderCommandError extends Error {
  constructor(code) {
    super(`Card rendering failed: ${code}`);
    this.name = 'RenderCommandError';
    this.code = code;
  }
}

function fail(code) {
  throw new RenderCommandError(code);
}

function write(stream, value) {
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
}

function validateAsOf(value) {
  try {
    return assertIsoDate(value);
  } catch {
    fail('INVALID_AS_OF');
  }
}

function resolveMergeInstant(asOf, requestedInstant, timezone) {
  if (requestedInstant === undefined) {
    try {
      return endOfDayInstant(asOf, timezone);
    } catch {
      fail('INVALID_AS_OF_INSTANT');
    }
  }

  let instant;
  try {
    instant = assertIsoUtcInstant(requestedInstant);
  } catch {
    fail('INVALID_AS_OF_INSTANT');
  }
  if (dateAtInstant(Date.parse(instant), timezone) !== asOf) {
    fail('AS_OF_INSTANT_DATE_MISMATCH');
  }
  return instant;
}

async function listJsonFiles(directory, fileSystem) {
  let entries;
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    fail('PUBLIC_DATA_READ_FAILED');
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .toSorted();
}

async function loadPublicJson(directory, validator, fileSystem) {
  const values = [];
  for (const filename of await listJsonFiles(directory, fileSystem)) {
    let parsed;
    try {
      const contents = await fileSystem.readFile(path.join(directory, filename), 'utf8');
      parsed = JSON.parse(contents);
      validator(parsed);
    } catch {
      fail('PUBLIC_DATA_INVALID');
    }
    if (`${parsed.deviceId}.json` !== filename) {
      fail('PUBLIC_DATA_FILENAME');
    }
    values.push(parsed);
  }
  return values;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function prepareStagingRoot(stagingRoot, fileSystem) {
  try {
    await fileSystem.mkdir(stagingRoot, { recursive: true });
    const [stat, realParent, realRoot] = await Promise.all([
      fileSystem.lstat(stagingRoot),
      fileSystem.realpath(path.dirname(stagingRoot)),
      fileSystem.realpath(stagingRoot),
    ]);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || pathKey(path.dirname(realRoot)) !== pathKey(realParent)
    ) {
      fail('UNSAFE_STAGING_ROOT');
    }
    return realRoot;
  } catch (error) {
    if (error instanceof RenderCommandError) {
      throw error;
    }
    fail('UNSAFE_STAGING_ROOT');
  }
}

async function assertSafeStagingDirectory(
  stagingDirectory,
  expectedRealRoot,
  fileSystem,
) {
  try {
    const [stat, realDirectory] = await Promise.all([
      fileSystem.lstat(stagingDirectory),
      fileSystem.realpath(stagingDirectory),
    ]);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || pathKey(path.dirname(realDirectory)) !== pathKey(expectedRealRoot)
    ) {
      fail('UNSAFE_STAGING_ROOT');
    }
  } catch (error) {
    if (error instanceof RenderCommandError) {
      throw error;
    }
    fail('UNSAFE_STAGING_ROOT');
  }
}

async function stageCards({
  cards,
  outputDirectory,
  fileSystem,
  validateSvg,
}) {
  await fileSystem.mkdir(outputDirectory, { recursive: true });
  const stagingRoot = path.join(path.dirname(outputDirectory), '.agent-card-tmp');
  const realStagingRoot = await prepareStagingRoot(stagingRoot, fileSystem);
  const stagingDirectory = await fileSystem.mkdtemp(path.join(stagingRoot, '.render-'));
  await assertSafeStagingDirectory(stagingDirectory, realStagingRoot, fileSystem);
  try {
    for (const artifactPath of CARD_ARTIFACT_PATHS) {
      const contents = cards[artifactPath];
      const filename = path.posix.basename(artifactPath);
      await validateSvg(contents, { filePath: artifactPath });
      await fileSystem.writeFile(
        path.join(stagingDirectory, filename),
        contents,
        { encoding: 'utf8', flag: 'wx', mode: 0o644 },
      );
    }

    for (const artifactPath of CARD_ARTIFACT_PATHS) {
      const filename = path.posix.basename(artifactPath);
      await fileSystem.rename(
        path.join(stagingDirectory, filename),
        path.join(outputDirectory, filename),
      );
    }
  } finally {
    await fileSystem.rm(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * Loads all sanitized public snapshots, computes coverage-aware statistics, and
 * atomically replaces the 35 deterministic theme card files after every SVG has
 * passed validation.
 */
export async function renderCards({
  cwd = process.cwd(),
  asOf,
  asOfInstant,
  outputDirectory = path.join(cwd, 'cards'),
  fileSystem = defaultFileSystem,
  validateSvg = validateSvgDocument,
} = {}) {
  const asOfDate = validateAsOf(asOf);
  const deviceSnapshots = await loadPublicJson(
    path.join(cwd, 'data', 'devices'),
    validateDeviceSnapshot,
    fileSystem,
  );
  const profileCandidates = await loadPublicJson(
    path.join(cwd, 'data', 'profiles'),
    validateProfileCandidate,
    fileSystem,
  );
  const timezone = deviceSnapshots[0]?.timezone ?? 'UTC';
  const freshnessInstant = resolveMergeInstant(asOfDate, asOfInstant, timezone);
  const merged = mergeUsage({
    deviceSnapshots,
    profileCandidates,
    asOf: freshnessInstant,
  });
  const statistics = computeStatistics(merged, { asOf: asOfDate });
  const cards = Object.fromEntries(THEME_NAMES.flatMap((theme) => {
    const options = { theme };
    const themedCards = {
      overview: renderOverview(statistics, {
        ...options,
        staleDeviceCount: merged.diagnostics.staleDeviceCount,
        retainedProfileCollectedAt: merged.diagnostics.selectedProfileCollectedAt,
      }),
      achievements: renderAchievements(statistics, options),
      'trophy-case': renderTrophyCase(statistics, options),
      records: renderRecords(statistics, options),
      trends: renderTrends(statistics, options),
      activity: renderActivity(statistics, options),
      compact: renderCompact(statistics, options),
    };
    return CARD_NAMES.map((cardName) => [
      `cards/${cardFilename(cardName, theme)}`,
      themedCards[cardName],
    ]);
  }));
  const resolvedOutputDirectory = path.resolve(cwd, outputDirectory);
  await stageCards({
    cards,
    outputDirectory: resolvedOutputDirectory,
    fileSystem,
    validateSvg,
  });

  return {
    asOf: asOfDate,
    asOfInstant: freshnessInstant,
    cardPaths: Object.fromEntries(CARD_ARTIFACT_PATHS.map((artifactPath) => [
      artifactPath,
      path.join(resolvedOutputDirectory, path.posix.basename(artifactPath)),
    ])),
  };
}

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    return { help: true };
  }
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--as-of' && args[index + 1] && options.asOf === undefined) {
      options.asOf = args[index + 1];
      index += 1;
    } else if (
      argument === '--as-of-instant'
      && args[index + 1]
      && options.asOfInstant === undefined
    ) {
      options.asOfInstant = args[index + 1];
      index += 1;
    } else {
      return { invalid: true };
    }
  }
  return options.asOf === undefined ? { invalid: true } : options;
}

export async function run(
  args = [],
  io = { stdout: process.stdout, stderr: process.stderr },
  dependencies = {},
) {
  const options = parseArgs(args);
  if (options.help) {
    write(io.stdout, HELP);
    return 0;
  }
  if (options.invalid) {
    write(
      io.stderr,
      `Usage: ${CLI_NAME} render --as-of YYYY-MM-DD [--as-of-instant ISO_UTC_INSTANT]`,
    );
    return 2;
  }

  try {
    const {
      renderCardsImpl = renderCards,
      repositoryLockOptions = {},
      withRepositoryLockImpl = defaultWithRepositoryLock,
      ...renderOptions
    } = dependencies;
    const cwd = renderOptions.cwd ?? process.cwd();
    const fileSystem = renderOptions.fileSystem ?? defaultFileSystem;
    const result = await withRepositoryLockImpl(
      { ...repositoryLockOptions, cwd, fileSystem },
      () => renderCardsImpl({
        ...renderOptions,
        cwd,
        fileSystem,
        asOf: options.asOf,
        asOfInstant: options.asOfInstant,
      }),
    );
    write(io.stdout, `Rendered ${CARD_ARTIFACT_PATHS.length} cards as of ${result.asOf}.`);
    return 0;
  } catch (error) {
    const code = error instanceof RenderCommandError
      || (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code))
      ? error.code
      : 'RENDER_FAILED';
    write(io.stderr, `Render failed: ${code}`);
    return 1;
  }
}
