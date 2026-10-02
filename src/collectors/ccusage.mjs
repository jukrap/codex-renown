import { execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CCUSAGE_VERSION = '20.0.26';
export const DEFAULT_CCUSAGE_TIMEOUT_MS = 30_000;
export const DEFAULT_CCUSAGE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const DEFAULT_CCUSAGE_ENTRY_PATH = fileURLToPath(
  new URL('../../node_modules/ccusage/src/cli.js', import.meta.url),
);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IANA_TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_.+-]+)+)$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;
const REPORTS = new Set(['daily', 'session']);

const ERROR_MESSAGES = Object.freeze({
  CCUSAGE_COMMAND_FAILED: 'ccusage command failed',
  CCUSAGE_COMMAND_TIMEOUT: 'ccusage command timed out',
  CCUSAGE_DUPLICATE_DATE: 'ccusage returned duplicate dates',
  CCUSAGE_INVALID_ARGUMENT: 'ccusage collector received an invalid argument',
  CCUSAGE_INVALID_JSON: 'ccusage returned invalid JSON',
  CCUSAGE_INVALID_TIMEZONE: 'ccusage collector requires a valid IANA timezone',
  CCUSAGE_OUTPUT_TOO_LARGE: 'ccusage output exceeded the safe limit',
  CCUSAGE_SCHEMA_MISMATCH: 'ccusage output did not match the pinned contract',
});

export class CcusageCollectorError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? 'ccusage collector failed');
    this.name = 'CcusageCollectorError';
    this.code = code;
  }
}

function collectorError(code) {
  return new CcusageCollectorError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOutput(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw collectorError('CCUSAGE_INVALID_JSON');
    }
  }
  if (!isPlainObject(value)) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
  return value;
}

function assertExactTopLevel(value, arrayKey) {
  if (!isPlainObject(value)
    || !Array.isArray(value[arrayKey])
    || !isPlainObject(value.totals)) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }

  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [arrayKey, 'totals'].sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
}

function assertToken(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
  return value;
}

function assertTokenFields(value) {
  if (!isPlainObject(value)) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheCreationTokens',
    'cacheReadTokens',
    'totalTokens',
  ]) {
    assertToken(value[field]);
  }
}

function assertDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
  return value;
}

export function assertIanaTimezone(timezone) {
  if (typeof timezone !== 'string'
    || timezone.length > 100
    || !IANA_TIMEZONE_PATTERN.test(timezone)) {
    throw collectorError('CCUSAGE_INVALID_TIMEZONE');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw collectorError('CCUSAGE_INVALID_TIMEZONE');
  }
  return timezone;
}

function dateInTimezone(timestamp, timezone) {
  if (typeof timestamp !== 'string' || !RFC3339_PATTERN.test(timestamp)) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) {
    throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function normalizeCcusageSessions(output, { timezone } = {}) {
  const safeTimezone = assertIanaTimezone(timezone);
  const parsed = parseOutput(output);
  assertExactTopLevel(parsed, 'sessions');

  const lastActivityBySession = new Map();
  for (const session of parsed.sessions) {
    if (!isPlainObject(session)
      || typeof session.sessionId !== 'string'
      || session.sessionId.length === 0
      || typeof session.lastActivity !== 'string') {
      throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
    }

    const timestamp = new Date(session.lastActivity).getTime();
    if (!RFC3339_PATTERN.test(session.lastActivity) || Number.isNaN(timestamp)) {
      throw collectorError('CCUSAGE_SCHEMA_MISMATCH');
    }
    const scope = typeof session.projectPath === 'string'
      ? session.projectPath
      : (typeof session.directory === 'string' ? session.directory : '');
    const identity = `${session.sessionId}\u0000${scope}`;
    const previous = lastActivityBySession.get(identity);
    if (previous === undefined || timestamp > previous.timestamp) {
      lastActivityBySession.set(identity, {
        timestamp,
        value: session.lastActivity,
      });
    }
  }

  const counts = new Map();
  for (const { value } of lastActivityBySession.values()) {
    const date = dateInTimezone(value, safeTimezone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function normalizeCcusageDaily(output, { timezone, sessionOutput = null } = {}) {
  const safeTimezone = assertIanaTimezone(timezone);
  const parsed = parseOutput(output);
  assertExactTopLevel(parsed, 'daily');
  assertTokenFields(parsed.totals);

  const sessionCounts = sessionOutput === null
    ? null
    : normalizeCcusageSessions(sessionOutput, { timezone: safeTimezone });
  const seenDates = new Set();
  const days = parsed.daily.map((row) => {
    assertTokenFields(row);
    const date = assertDate(row.date);
    if (seenDates.has(date)) {
      throw collectorError('CCUSAGE_DUPLICATE_DATE');
    }
    seenDates.add(date);
    return {
      date,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheCreationTokens,
      totalTokens: row.totalTokens,
      sessions: sessionCounts === null ? null : (sessionCounts.get(date) ?? 0),
    };
  });

  return days.sort((left, right) => left.date.localeCompare(right.date));
}

export function buildCcusageArgs(report, timezone) {
  if (!REPORTS.has(report)) {
    throw collectorError('CCUSAGE_INVALID_ARGUMENT');
  }
  const safeTimezone = assertIanaTimezone(timezone);
  const args = [
    'codex',
    report,
    '--json',
    '--offline',
    '--no-cost',
    '--timezone',
    safeTimezone,
  ];
  args.push('--speed', 'auto');
  return args;
}

function classifyCommandError(error) {
  if (error instanceof CcusageCollectorError) {
    return error;
  }
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return collectorError('CCUSAGE_OUTPUT_TOO_LARGE');
  }
  if (error?.code === 'ETIMEDOUT' || error?.killed === true) {
    return collectorError('CCUSAGE_COMMAND_TIMEOUT');
  }
  return collectorError('CCUSAGE_COMMAND_FAILED');
}

function stdoutFromRunnerResult(result) {
  if (typeof result === 'string') {
    return result;
  }
  if (isPlainObject(result)
    && (result.exitCode === undefined || result.exitCode === 0)
    && typeof result.stdout === 'string') {
    return result.stdout;
  }
  throw collectorError('CCUSAGE_COMMAND_FAILED');
}

function sanitizedChildEnvironment(overrides) {
  const environment = {
    ...process.env,
    ...(overrides ?? {}),
  };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'codex_bearer_token') {
      delete environment[key];
    }
  }
  return environment;
}

export function createCcusageRunner({
  entryPath = DEFAULT_CCUSAGE_ENTRY_PATH,
  timeoutMs = DEFAULT_CCUSAGE_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_CCUSAGE_MAX_OUTPUT_BYTES,
  execFileImpl = execFile,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw collectorError('CCUSAGE_INVALID_ARGUMENT');
  }

  return (args, { cwd, env } = {}) => new Promise((resolve, reject) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      reject(collectorError('CCUSAGE_INVALID_ARGUMENT'));
      return;
    }
    execFileImpl(
      process.execPath,
      [entryPath, ...args],
      {
        cwd,
        encoding: 'utf8',
        env: sanitizedChildEnvironment(env),
        maxBuffer: maxOutputBytes,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(classifyCommandError(error));
          return;
        }
        if (typeof stdout !== 'string'
          || Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
          reject(collectorError('CCUSAGE_OUTPUT_TOO_LARGE'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const defaultRunner = createCcusageRunner();

async function runSafely(runner, args, runnerOptions) {
  try {
    return stdoutFromRunnerResult(await runner(args, runnerOptions));
  } catch (error) {
    throw classifyCommandError(error);
  }
}

export async function collectCcusage({
  timezone,
  includeSessions = true,
  runner = defaultRunner,
  runnerOptions,
} = {}) {
  const safeTimezone = assertIanaTimezone(timezone);
  const dailyOutput = await runSafely(
    runner,
    buildCcusageArgs('daily', safeTimezone),
    runnerOptions,
  );

  let sessionOutput = null;
  let sessionStatus = 'not-requested';
  if (includeSessions) {
    try {
      sessionOutput = await runSafely(
        runner,
        buildCcusageArgs('session', safeTimezone),
        runnerOptions,
      );
      normalizeCcusageSessions(sessionOutput, { timezone: safeTimezone });
      sessionStatus = 'ok';
    } catch {
      sessionOutput = null;
      sessionStatus = 'unavailable';
    }
  }

  return {
    days: normalizeCcusageDaily(dailyOutput, {
      timezone: safeTimezone,
      sessionOutput,
    }),
    sessionStatus,
  };
}
