import { spawn as defaultSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { PRODUCT_NAME } from '../product.mjs';

export const DEFAULT_PROFILE_TIMEOUT_MS = 15_000;
export const MAX_PROFILE_RESPONSE_BYTES = 1024 * 1024;
export const CODEX_APP_SERVER_ARGS = Object.freeze([
  'app-server',
  '--listen',
  'stdio://',
]);

const WINDOWS_NPM_CODEX_BINARIES = Object.freeze({
  arm64: Object.freeze([
    '@openai', 'codex-win32-arm64', 'vendor',
    'aarch64-pc-windows-msvc', 'bin', 'codex.exe',
  ]),
  x64: Object.freeze([
    '@openai', 'codex-win32-x64', 'vendor',
    'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
  ]),
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COLLECTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RFC3339_PATTERN = /^(?<date>\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const INITIALIZE_REQUEST_ID = 1;
const USAGE_REQUEST_ID = 2;
const RESPONSE_FIELDS = new Set(['id', 'result', 'error']);
const NOTIFICATION_FIELDS = new Set(['method', 'params', 'emittedAtMs']);
const PROTOCOL_ERROR_FIELDS = new Set(['code', 'message', 'data']);
const EXPECTED_SUMMARY_FIELDS = new Set([
  'currentStreakDays',
  'lifetimeTokens',
  'longestRunningTurnSec',
  'longestStreakDays',
  'peakDailyTokens',
]);

const ERROR_MESSAGES = Object.freeze({
  ACCOUNT_USAGE_FAILED: 'Codex account usage could not be read',
  APP_SERVER_EXITED: 'Codex App Server exited before returning account usage',
  APP_SERVER_FAILED: 'Codex App Server could not be started',
  APP_SERVER_OUTPUT_TOO_LARGE: 'Codex App Server output exceeded the safe limit',
  APP_SERVER_PROTOCOL: 'Codex App Server returned an invalid protocol message',
  APP_SERVER_TIMEOUT: 'Codex App Server account usage request timed out',
  APP_SERVER_UNSUPPORTED: 'Codex App Server does not support account usage',
  INVALID_ARGUMENT: 'Codex profile collector received an invalid argument',
  INVALID_SCHEMA: 'Codex account usage did not match the expected schema',
});

export class CodexProfileError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? 'Codex profile collection failed');
    this.name = 'CodexProfileError';
    this.code = code;
  }
}

function profileError(code) {
  return new CodexProfileError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, expectedKeys) {
  return Object.keys(value).every((key) => expectedKeys.has(key));
}

function assertSafeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw profileError('INVALID_SCHEMA');
  }
  return value;
}

function assertCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw profileError('INVALID_SCHEMA');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw profileError('INVALID_SCHEMA');
  }
  return value;
}

function normalizeProviderCalendarDate(value) {
  if (typeof value !== 'string') {
    throw profileError('INVALID_SCHEMA');
  }
  if (DATE_PATTERN.test(value)) {
    return assertCalendarDate(value);
  }

  const match = RFC3339_PATTERN.exec(value);
  if (!match) {
    throw profileError('INVALID_SCHEMA');
  }
  const calendarDate = assertCalendarDate(match.groups.date);
  if (Number.isNaN(new Date(value).getTime())) {
    throw profileError('INVALID_SCHEMA');
  }
  return calendarDate;
}

function normalizeCollectedAt(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw profileError('INVALID_ARGUMENT');
    }
    return value.toISOString();
  }
  if (typeof value !== 'string' || !COLLECTED_AT_PATTERN.test(value)) {
    throw profileError('INVALID_ARGUMENT');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw profileError('INVALID_ARGUMENT');
  }
  return value;
}

function maximumProviderDate(collectedAt) {
  const collectedDate = collectedAt.slice(0, 10);
  const nextDay = new Date(`${collectedDate}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay.toISOString().slice(0, 10);
}

function validateNullableSummaryCounts(summary) {
  if (!hasOnlyKeys(summary, EXPECTED_SUMMARY_FIELDS)) {
    throw profileError('INVALID_SCHEMA');
  }
  for (const field of EXPECTED_SUMMARY_FIELDS) {
    if (Object.hasOwn(summary, field) && summary[field] !== null) {
      assertSafeCount(summary[field]);
    }
  }
}

export function normalizeCodexProfile(payload, { collectedAt } = {}) {
  const safeCollectedAt = normalizeCollectedAt(collectedAt);
  if (!isPlainObject(payload)
    || !hasOnlyKeys(payload, new Set(['dailyUsageBuckets', 'summary']))
    || !isPlainObject(payload.summary)) {
    throw profileError('INVALID_SCHEMA');
  }

  validateNullableSummaryCounts(payload.summary);
  const buckets = payload.dailyUsageBuckets ?? [];
  if (!Array.isArray(buckets)) {
    throw profileError('INVALID_SCHEMA');
  }

  const daily = [];
  let previousDate;
  const maximumDate = maximumProviderDate(safeCollectedAt);
  for (const bucket of buckets) {
    if (!isPlainObject(bucket)
      || !hasOnlyKeys(bucket, new Set(['startDate', 'tokens']))
      || !Object.hasOwn(bucket, 'startDate')
      || !Object.hasOwn(bucket, 'tokens')) {
      throw profileError('INVALID_SCHEMA');
    }
    const date = normalizeProviderCalendarDate(bucket.startDate);
    const totalTokens = assertSafeCount(bucket.tokens);
    if ((previousDate !== undefined && date <= previousDate) || date > maximumDate) {
      throw profileError('INVALID_SCHEMA');
    }
    previousDate = date;
    daily.push({ date, totalTokens });
  }

  const normalized = {
    dateBasis: 'provider-calendar-date',
    daily,
    coverage: daily.length === 0
      ? { startDate: null, endDate: null, bucketCount: 0 }
      : {
          startDate: daily[0].date,
          endDate: daily.at(-1).date,
          bucketCount: daily.length,
        },
  };

  if (Object.hasOwn(payload.summary, 'lifetimeTokens')
    && payload.summary.lifetimeTokens !== null) {
    normalized.lifetimeTotalTokens = assertSafeCount(payload.summary.lifetimeTokens);
  }
  return normalized;
}

function defaultIsFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function windowsPathValue(env) {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path') {
      return value;
    }
  }
  return undefined;
}

function normalizeWindowsPathDirectory(value) {
  let directory = value.trim();
  if (directory.length >= 2 && directory.startsWith('"') && directory.endsWith('"')) {
    directory = directory.slice(1, -1);
  }
  if (directory.length === 0
    || CONTROL_CHARACTER_PATTERN.test(directory)
    || !path.win32.isAbsolute(directory)) {
    return null;
  }
  return directory;
}

function resolveWindowsNpmCodex(env, arch, isFile) {
  const binaryParts = WINDOWS_NPM_CODEX_BINARIES[arch];
  if (binaryParts === undefined) {
    return undefined;
  }
  const pathValue = windowsPathValue(env);
  if (typeof pathValue !== 'string' || CONTROL_CHARACTER_PATTERN.test(pathValue)) {
    return undefined;
  }

  for (const entry of pathValue.split(path.win32.delimiter)) {
    const directory = normalizeWindowsPathDirectory(entry);
    if (directory === null) {
      continue;
    }
    const hasCodexShim = ['codex.cmd', 'codex.ps1', 'codex']
      .some((name) => isFile(path.win32.join(directory, name)));
    if (!hasCodexShim) {
      continue;
    }
    const candidate = path.win32.join(
      directory,
      'node_modules', '@openai', 'codex', 'node_modules',
      ...binaryParts,
    );
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCodexCommand(env, platform, arch, isFile) {
  const override = env?.AGENT_CARD_CODEX_BIN;
  if (override === undefined) {
    if (platform === 'win32') {
      return resolveWindowsNpmCodex(env, arch, isFile) ?? 'codex.exe';
    }
    return 'codex';
  }
  if (typeof override !== 'string'
    || override.trim() !== override
    || override.length === 0
    || CONTROL_CHARACTER_PATTERN.test(override)) {
    throw profileError('INVALID_ARGUMENT');
  }
  const isAbsolute = platform === 'win32'
    ? path.win32.isAbsolute(override)
    : path.posix.isAbsolute(override);
  if (!isAbsolute) {
    throw profileError('INVALID_ARGUMENT');
  }
  return override;
}

function sanitizedChildEnvironment(env) {
  const environment = { ...env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'codex_bearer_token') {
      delete environment[key];
    }
  }
  return environment;
}

function assertRunnerArguments({ cwd, env, timeoutMs, platform }) {
  if ((cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0))
    || env === null
    || typeof env !== 'object'
    || Array.isArray(env)
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')) {
    throw profileError('INVALID_ARGUMENT');
  }
}

function isProtocolError(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, PROTOCOL_ERROR_FIELDS)
    && Number.isInteger(value.code)
    && typeof value.message === 'string';
}

function classifyResponseError(error) {
  if (!isProtocolError(error)) {
    return profileError('APP_SERVER_PROTOCOL');
  }
  if (error.code === -32601) {
    return profileError('APP_SERVER_UNSUPPORTED');
  }
  return profileError('ACCOUNT_USAGE_FAILED');
}

function safeEnd(child) {
  try {
    child.stdin?.end();
  } catch {
    // Process cleanup is best-effort. Raw failures are intentionally discarded.
  }
}

function safeKill(child) {
  try {
    if (child.killed !== true) {
      child.kill();
    }
  } catch {
    // Process cleanup is best-effort. Raw failures are intentionally discarded.
  }
}

export function createCodexAppServerRunner({
  spawnImpl = defaultSpawn,
  platform = process.platform,
  arch = process.arch,
  isFile = defaultIsFile,
} = {}) {
  if (typeof spawnImpl !== 'function' || typeof isFile !== 'function') {
    throw profileError('INVALID_ARGUMENT');
  }

  return function runCodexAppServer({
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = DEFAULT_PROFILE_TIMEOUT_MS,
  } = {}) {
    assertRunnerArguments({ cwd, env, timeoutMs, platform });
    const childEnvironment = sanitizedChildEnvironment(env);
    const command = resolveCodexCommand(childEnvironment, platform, arch, isFile);

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(command, CODEX_APP_SERVER_ARGS, {
          cwd,
          env: childEnvironment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        reject(profileError('APP_SERVER_FAILED'));
        return;
      }

      if (!child
        || typeof child.on !== 'function'
        || typeof child.stdout?.on !== 'function'
        || typeof child.stderr?.on !== 'function'
        || typeof child.stdin?.write !== 'function') {
        safeEnd(child ?? {});
        safeKill(child ?? {});
        reject(profileError('APP_SERVER_FAILED'));
        return;
      }

      let settled = false;
      let stage = 'initializing';
      let stdoutBuffer = '';
      let outputBytes = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let timer;

      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        safeEnd(child);
        safeKill(child);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };

      const failProtocol = () => finish(profileError('APP_SERVER_PROTOCOL'));

      const writeMessage = (message) => {
        if (settled) {
          return;
        }
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
          finish(profileError('APP_SERVER_FAILED'));
        }
      };

      const handleResponse = (message) => {
        if (!hasOnlyKeys(message, RESPONSE_FIELDS)
          || !Object.hasOwn(message, 'id')
          || (message.id !== INITIALIZE_REQUEST_ID && message.id !== USAGE_REQUEST_ID)
          || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) {
          failProtocol();
          return;
        }

        if (message.id === INITIALIZE_REQUEST_ID) {
          if (stage !== 'initializing') {
            failProtocol();
            return;
          }
          if (Object.hasOwn(message, 'error')) {
            finish(classifyResponseError(message.error));
            return;
          }
          if (!isPlainObject(message.result)) {
            failProtocol();
            return;
          }

          stage = 'reading-usage';
          writeMessage({ method: 'initialized' });
          writeMessage({
            id: USAGE_REQUEST_ID,
            method: 'account/usage/read',
            params: null,
          });
          return;
        }

        if (stage !== 'reading-usage') {
          failProtocol();
          return;
        }
        if (Object.hasOwn(message, 'error')) {
          finish(classifyResponseError(message.error));
          return;
        }
        if (!isPlainObject(message.result)) {
          failProtocol();
          return;
        }
        stage = 'complete';
        finish(undefined, message.result);
      };

      const handleLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) {
          failProtocol();
          return;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          failProtocol();
          return;
        }
        if (!isPlainObject(message)) {
          failProtocol();
          return;
        }

        if (Object.hasOwn(message, 'id')) {
          handleResponse(message);
          return;
        }

        if (!hasOnlyKeys(message, NOTIFICATION_FIELDS)
          || typeof message.method !== 'string'
          || message.method.length === 0
          || (Object.hasOwn(message, 'params')
            && message.params !== null
            && !isPlainObject(message.params))
          || (Object.hasOwn(message, 'emittedAtMs')
            && !Number.isSafeInteger(message.emittedAtMs))) {
          failProtocol();
        }
      };

      const accountBytes = (chunk) => {
        if (!(chunk instanceof Uint8Array)) {
          failProtocol();
          return false;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_PROFILE_RESPONSE_BYTES) {
          finish(profileError('APP_SERVER_OUTPUT_TOO_LARGE'));
          return false;
        }
        return true;
      };

      child.stdout.on('data', (chunk) => {
        if (settled || !accountBytes(chunk)) {
          return;
        }
        try {
          stdoutBuffer += decoder.decode(chunk, { stream: true });
        } catch {
          failProtocol();
          return;
        }

        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (!settled && newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          handleLine(line);
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk) => {
        if (!settled) {
          accountBytes(chunk);
        }
      });

      child.stdout.on('end', () => {
        if (settled) {
          return;
        }
        try {
          stdoutBuffer += decoder.decode();
        } catch {
          failProtocol();
          return;
        }
        if (stdoutBuffer.length > 0) {
          handleLine(stdoutBuffer);
          stdoutBuffer = '';
        }
      });

      const failStart = () => finish(profileError('APP_SERVER_FAILED'));
      child.on('error', failStart);
      child.stdout.on('error', failStart);
      child.stderr.on('error', failStart);
      if (typeof child.stdin?.on === 'function') {
        child.stdin.on('error', failStart);
      }
      child.on('exit', () => {
        if (!settled) {
          finish(profileError('APP_SERVER_EXITED'));
        }
      });

      timer = setTimeout(
        () => finish(profileError('APP_SERVER_TIMEOUT')),
        timeoutMs,
      );

      writeMessage({
        id: INITIALIZE_REQUEST_ID,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'codex_renown',
            title: PRODUCT_NAME,
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      });
    });
  };
}

export async function collectCodexProfile({
  cwd = process.cwd(),
  env = process.env,
  runner,
  timeoutMs = DEFAULT_PROFILE_TIMEOUT_MS,
  collectedAt = new Date().toISOString(),
} = {}) {
  if ((runner !== undefined && typeof runner !== 'function')
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0) {
    throw profileError('INVALID_ARGUMENT');
  }
  const safeCollectedAt = normalizeCollectedAt(collectedAt);
  const execute = runner ?? createCodexAppServerRunner();

  let payload;
  try {
    payload = await execute({ cwd, env, timeoutMs });
  } catch (error) {
    if (error instanceof CodexProfileError) {
      throw error;
    }
    throw profileError('APP_SERVER_FAILED');
  }
  return normalizeCodexProfile(payload, { collectedAt: safeCollectedAt });
}
