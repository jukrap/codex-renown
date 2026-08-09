import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CODEX_APP_SERVER_ARGS,
  CodexProfileError,
  MAX_PROFILE_RESPONSE_BYTES,
  collectCodexProfile,
  createCodexAppServerRunner,
  normalizeCodexProfile,
} from '../src/collectors/codex-profile.mjs';
import { run as runProfileCommand } from '../src/commands/profile.mjs';

const FIXED_NOW = '2026-07-19T12:34:56.000Z';
const DEVICE_ID = 'device-00112233445566778899aabbccddeeff';
const WRITER_KEY = '11'.repeat(32);
const PRIVATE_DETAILS = 'C:\\Users\\private\\profile.json raw-account-response';

function expectProfileError(error, code) {
  assert.ok(error instanceof CodexProfileError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(PRIVATE_DETAILS), false);
  assert.equal(error.stack.includes(PRIVATE_DETAILS), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

function makeExistingCandidate(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'codex-profile',
    deviceId: DEVICE_ID,
    writerKeyHash: createHash('sha256').update(WRITER_KEY, 'utf8').digest('hex'),
    collectedAt: '2026-07-18T10:00:00.000Z',
    dateBasis: 'provider-calendar-date',
    daily: [{ date: '2026-07-18', totalTokens: 50 }],
    lifetimeTotalTokens: 500,
    coverage: {
      startDate: '2026-07-18',
      endDate: '2026-07-18',
      bucketCount: 1,
    },
    ...overrides,
  };
}

async function makeTempDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

class FakeStdin extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.writes = [];
    this.ended = false;
  }

  write(value) {
    this.writes.push(value);
    this.onWrite?.(value);
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killCalls = 0;
    this.stdin = new FakeStdin((value) => {
      onMessage?.(JSON.parse(value), this);
    });
  }

  kill() {
    this.killCalls += 1;
    this.killed = true;
    return true;
  }
}

function appServerFixture(onMessage) {
  const observed = { calls: [], child: null };
  return {
    observed,
    spawnImpl(command, args, options) {
      observed.calls.push({ command, args: [...args], options });
      observed.child = new FakeChild(onMessage);
      return observed.child;
    },
  };
}

function emitJson(child, value) {
  child.stdout.write(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
}

function successfulAppServer(payload = {
  dailyUsageBuckets: [
    { startDate: '2026-07-17', tokens: 100 },
    { startDate: '2026-07-18', tokens: 250 },
  ],
  summary: {
    lifetimeTokens: 987654321,
    currentStreakDays: 9,
    longestRunningTurnSec: 120,
    longestStreakDays: 20,
    peakDailyTokens: 500,
  },
}) {
  return appServerFixture((message, child) => {
    if (message.method === 'initialize') {
      emitJson(child, { method: 'account/updated', params: {} });
      emitJson(child, { id: message.id, result: { serverInfo: {} } });
    } else if (message.method === 'account/usage/read') {
      emitJson(child, { id: message.id, result: payload });
    }
  });
}

test('normalizer publishes only daily totals and optional lifetime total', () => {
  const result = normalizeCodexProfile({
    dailyUsageBuckets: [
      { startDate: '2026-07-17', tokens: 100 },
      { startDate: '2026-07-18T12:00:00Z', tokens: 250 },
    ],
    summary: {
      lifetimeTokens: 987654321,
      currentStreakDays: 9,
      longestRunningTurnSec: 120,
      longestStreakDays: 20,
      peakDailyTokens: 500,
    },
  }, { collectedAt: FIXED_NOW });

  assert.deepEqual(result, {
    dateBasis: 'provider-calendar-date',
    daily: [
      { date: '2026-07-17', totalTokens: 100 },
      { date: '2026-07-18', totalTokens: 250 },
    ],
    lifetimeTotalTokens: 987654321,
    coverage: {
      startDate: '2026-07-17',
      endDate: '2026-07-18',
      bucketCount: 2,
    },
  });
  assert.equal(JSON.stringify(result).includes('Streak'), false);
  assert.equal(JSON.stringify(result).includes('peak'), false);
});

test('null or missing buckets and lifetime remain empty or unknown', () => {
  for (const payload of [
    { dailyUsageBuckets: null, summary: { lifetimeTokens: null } },
    { summary: {} },
  ]) {
    const result = normalizeCodexProfile(payload, { collectedAt: FIXED_NOW });
    assert.deepEqual(result.daily, []);
    assert.deepEqual(result.coverage, {
      startDate: null,
      endDate: null,
      bucketCount: 0,
    });
    assert.equal(Object.hasOwn(result, 'lifetimeTotalTokens'), false);
  }
});

test('normalizer rejects protocol drift, partial buckets, and invalid summary values', () => {
  const cases = [
    { summary: {}, unknown: true },
    { dailyUsageBuckets: [{ startDate: '2026-07-18', tokens: 1, extra: 2 }], summary: {} },
    { dailyUsageBuckets: [{ startDate: '2026-07-18' }], summary: {} },
    { dailyUsageBuckets: [], summary: { futureField: 1 } },
    { dailyUsageBuckets: [], summary: { currentStreakDays: -1 } },
    { dailyUsageBuckets: 'changed', summary: {} },
    { dailyUsageBuckets: [], summary: null },
  ];
  for (const payload of cases) {
    assert.throws(
      () => normalizeCodexProfile(payload, { collectedAt: FIXED_NOW }),
      (error) => expectProfileError(error, 'INVALID_SCHEMA'),
    );
  }
});

test('dates are exact date or RFC3339 values, unique, ascending, and bounded', () => {
  for (const startDate of [
    '2026-02-30',
    '2026-07-18 trailing',
    '2026-07-18T00:00:00',
    '2026-07-18T24:00:00Z',
    '2026-07-18T00:00:00+15:00',
    '2026-07-21',
  ]) {
    assert.throws(
      () => normalizeCodexProfile({
        dailyUsageBuckets: [{ startDate, tokens: 1 }],
        summary: {},
      }, { collectedAt: FIXED_NOW }),
      (error) => expectProfileError(error, 'INVALID_SCHEMA'),
    );
  }

  for (const dailyUsageBuckets of [
    [
      { startDate: '2026-07-18', tokens: 1 },
      { startDate: '2026-07-18T12:00:00Z', tokens: 2 },
    ],
    [
      { startDate: '2026-07-19', tokens: 1 },
      { startDate: '2026-07-18', tokens: 2 },
    ],
  ]) {
    assert.throws(
      () => normalizeCodexProfile({ dailyUsageBuckets, summary: {} }, {
        collectedAt: FIXED_NOW,
      }),
      (error) => expectProfileError(error, 'INVALID_SCHEMA'),
    );
  }

  const preserved = normalizeCodexProfile({
    dailyUsageBuckets: [{ startDate: '2026-07-19T23:30:00-10:00', tokens: 12 }],
    summary: {},
  }, { collectedAt: FIXED_NOW });
  assert.equal(preserved.daily[0].date, '2026-07-19');
  assert.doesNotThrow(() => normalizeCodexProfile({
    dailyUsageBuckets: [{ startDate: '2026-07-20', tokens: 1 }],
    summary: {},
  }, { collectedAt: FIXED_NOW }));
});

test('all usage counts are non-negative safe integers', () => {
  for (const tokens of [-1, 1.5, '1', Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeCodexProfile({
        dailyUsageBuckets: [{ startDate: '2026-07-19', tokens }],
        summary: {},
      }, { collectedAt: FIXED_NOW }),
      (error) => expectProfileError(error, 'INVALID_SCHEMA'),
    );
  }
  for (const lifetimeTokens of [-1, 1.5, '10', Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeCodexProfile({
        dailyUsageBuckets: [],
        summary: { lifetimeTokens },
      }, { collectedAt: FIXED_NOW }),
      (error) => expectProfileError(error, 'INVALID_SCHEMA'),
    );
  }
});

test('runner uses shell-free stdio App Server and the required request order', async () => {
  const fixture = successfulAppServer();
  const runner = createCodexAppServerRunner({
    spawnImpl: fixture.spawnImpl,
    platform: 'win32',
  });
  const result = await runner({
    cwd: 'C:\\repo',
    env: {
      CODEX_BEARER_TOKEN: PRIVATE_DETAILS,
      safe_marker: 'kept',
    },
    timeoutMs: 100,
  });

  assert.equal(fixture.observed.calls.length, 1);
  const call = fixture.observed.calls[0];
  assert.equal(call.command, 'codex.exe');
  assert.deepEqual(call.args, CODEX_APP_SERVER_ARGS);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.env, { safe_marker: 'kept' });

  const requests = fixture.observed.child.stdin.writes.map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'account/usage/read',
  ]);
  assert.deepEqual(requests[0].params.clientInfo, {
    name: 'codex_renown',
    title: 'Codex Renown',
    version: '0.1.0',
  });
  assert.deepEqual(requests[0].params.capabilities, { experimentalApi: true });
  assert.equal(requests[2].params, null);
  assert.equal(result.summary.lifetimeTokens, 987654321);
  assert.equal(fixture.observed.child.stdin.ended, true);
  assert.equal(fixture.observed.child.killCalls, 1);
});

test('runner discovers the npm Windows native binary before a packaged codex.exe', async () => {
  const fixture = successfulAppServer();
  const npmBin = 'C:\\Users\\developer\\AppData\\Roaming\\npm';
  const shim = path.win32.join(npmBin, 'codex.cmd');
  const expected = path.win32.join(
    npmBin,
    'node_modules', '@openai', 'codex', 'node_modules',
    '@openai', 'codex-win32-x64', 'vendor',
    'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
  );
  const checked = [];
  const runner = createCodexAppServerRunner({
    spawnImpl: fixture.spawnImpl,
    platform: 'win32',
    arch: 'x64',
    isFile(value) {
      checked.push(value);
      return value === shim || value === expected;
    },
  });

  await runner({
    cwd: 'C:\\repo',
    env: { Path: '"C:\\Missing";"C:\\Users\\developer\\AppData\\Roaming\\npm"' },
    timeoutMs: 100,
  });

  assert.equal(checked.length, 5);
  assert.ok(checked.includes(shim));
  assert.equal(checked.at(-1), expected);
  assert.equal(fixture.observed.calls[0].command, expected);
  assert.doesNotMatch(fixture.observed.calls[0].command, /WindowsApps/iu);
});

test('runner supports a validated absolute executable override', async () => {
  const fixture = successfulAppServer();
  const runner = createCodexAppServerRunner({
    spawnImpl: fixture.spawnImpl,
    platform: 'win32',
  });
  await runner({
    cwd: 'C:\\repo',
    env: { AGENT_CARD_CODEX_BIN: 'C:\\Tools\\codex.exe' },
    timeoutMs: 100,
  });
  assert.equal(fixture.observed.calls[0].command, 'C:\\Tools\\codex.exe');

  for (const override of ['codex.exe', ' C:\\Tools\\codex.exe', 'C:\\Tools\\bad\n.exe']) {
    await assert.rejects(
      async () => runner({
        cwd: 'C:\\repo',
        env: { AGENT_CARD_CODEX_BIN: override },
        timeoutMs: 100,
      }),
      (error) => expectProfileError(error, 'INVALID_ARGUMENT'),
    );
  }

  const unixFixture = successfulAppServer();
  const unixRunner = createCodexAppServerRunner({
    spawnImpl: unixFixture.spawnImpl,
    platform: 'linux',
  });
  await unixRunner({ cwd: '/repo', env: {}, timeoutMs: 100 });
  assert.equal(unixFixture.observed.calls[0].command, 'codex');
});

test('runner returns fixed safe codes for account and method errors', async () => {
  for (const [errorCode, expected] of [
    [-32001, 'ACCOUNT_USAGE_FAILED'],
    [-32601, 'APP_SERVER_UNSUPPORTED'],
  ]) {
    const fixture = appServerFixture((message, child) => {
      if (message.method === 'initialize') {
        emitJson(child, { id: message.id, result: {} });
      } else if (message.method === 'account/usage/read') {
        emitJson(child, {
          id: message.id,
          error: { code: errorCode, message: PRIVATE_DETAILS },
        });
      }
    });
    const runner = createCodexAppServerRunner({
      spawnImpl: fixture.spawnImpl,
      platform: 'linux',
    });
    await assert.rejects(
      runner({ cwd: '/repo', env: {}, timeoutMs: 100 }),
      (error) => expectProfileError(error, expected),
    );
    assert.equal(fixture.observed.child.killCalls, 1);
  }
});

test('runner rejects malformed, invalid UTF-8, duplicate, and unknown responses', async () => {
  const writers = [
    (child) => child.stdout.write(Buffer.from('{bad json\n')),
    (child) => child.stdout.write(Buffer.from([0xc3, 0x28, 0x0a])),
    (child) => {
      emitJson(child, { id: 1, result: {} });
      emitJson(child, { id: 1, result: {} });
    },
    (child) => emitJson(child, { id: 99, result: {} }),
    (child) => emitJson(child, { id: 1, result: {}, extra: true }),
  ];

  for (const writeResponse of writers) {
    const fixture = appServerFixture((message, child) => {
      if (message.method === 'initialize') {
        writeResponse(child);
      }
    });
    const runner = createCodexAppServerRunner({
      spawnImpl: fixture.spawnImpl,
      platform: 'linux',
    });
    await assert.rejects(
      runner({ cwd: '/repo', env: {}, timeoutMs: 100 }),
      (error) => expectProfileError(error, 'APP_SERVER_PROTOCOL'),
    );
    assert.equal(fixture.observed.child.stdin.ended, true);
    assert.equal(fixture.observed.child.killCalls, 1);
  }
});

test('runner enforces the combined one MiB output limit', async () => {
  for (const streamName of ['stdout', 'stderr']) {
    const fixture = appServerFixture((message, child) => {
      if (message.method === 'initialize') {
        child[streamName].write(Buffer.alloc(MAX_PROFILE_RESPONSE_BYTES + 1, 120));
      }
    });
    const runner = createCodexAppServerRunner({
      spawnImpl: fixture.spawnImpl,
      platform: 'linux',
    });
    await assert.rejects(
      runner({ cwd: '/repo', env: {}, timeoutMs: 100 }),
      (error) => expectProfileError(error, 'APP_SERVER_OUTPUT_TOO_LARGE'),
    );
    assert.equal(fixture.observed.child.killCalls, 1);
  }
});

test('runner handles timeout, early exit, missing CLI, and spawn failure with cleanup', async () => {
  const timeoutFixture = appServerFixture(() => {});
  const timeoutRunner = createCodexAppServerRunner({
    spawnImpl: timeoutFixture.spawnImpl,
    platform: 'linux',
  });
  await assert.rejects(
    timeoutRunner({ cwd: '/repo', env: {}, timeoutMs: 10 }),
    (error) => expectProfileError(error, 'APP_SERVER_TIMEOUT'),
  );
  assert.equal(timeoutFixture.observed.child.stdin.ended, true);
  assert.equal(timeoutFixture.observed.child.killCalls, 1);

  const exitFixture = appServerFixture((_message, child) => {
    queueMicrotask(() => child.emit('exit', 1));
  });
  const exitRunner = createCodexAppServerRunner({
    spawnImpl: exitFixture.spawnImpl,
    platform: 'linux',
  });
  await assert.rejects(
    exitRunner({ cwd: '/repo', env: {}, timeoutMs: 100 }),
    (error) => expectProfileError(error, 'APP_SERVER_EXITED'),
  );
  assert.equal(exitFixture.observed.child.killCalls, 1);

  const missingFixture = appServerFixture((_message, child) => {
    queueMicrotask(() => {
      const error = new Error(PRIVATE_DETAILS);
      error.code = 'ENOENT';
      child.emit('error', error);
    });
  });
  const missingRunner = createCodexAppServerRunner({
    spawnImpl: missingFixture.spawnImpl,
    platform: 'linux',
  });
  await assert.rejects(
    missingRunner({ cwd: '/repo', env: {}, timeoutMs: 100 }),
    (error) => expectProfileError(error, 'APP_SERVER_FAILED'),
  );
  assert.equal(missingFixture.observed.child.stdin.ended, true);
  assert.equal(missingFixture.observed.child.killCalls, 1);

  const spawnRunner = createCodexAppServerRunner({
    spawnImpl: () => { throw new Error(PRIVATE_DETAILS); },
    platform: 'linux',
  });
  await assert.rejects(
    spawnRunner({ cwd: '/repo', env: {}, timeoutMs: 100 }),
    (error) => expectProfileError(error, 'APP_SERVER_FAILED'),
  );
});

test('collector works without credentials in env and sanitizes runner failures', async () => {
  let observed;
  const result = await collectCodexProfile({
    cwd: '/repo',
    env: {},
    timeoutMs: 123,
    collectedAt: FIXED_NOW,
    runner: async (options) => {
      observed = options;
      return {
        dailyUsageBuckets: [{ startDate: '2026-07-18', tokens: 10 }],
        summary: { lifetimeTokens: 50 },
      };
    },
  });
  assert.deepEqual(observed, { cwd: '/repo', env: {}, timeoutMs: 123 });
  assert.equal(result.lifetimeTotalTokens, 50);

  await assert.rejects(
    collectCodexProfile({
      cwd: '/repo',
      env: {},
      collectedAt: FIXED_NOW,
      runner: async () => { throw new Error(PRIVATE_DETAILS); },
    }),
    (error) => expectProfileError(error, 'APP_SERVER_FAILED'),
  );
});

test('profile command writes a validated candidate without environment credentials', async (t) => {
  const cwd = await makeTempDirectory(t, 'agent-card-profile-success-');
  const output = makeIo();
  let runnerOptions;

  const status = await runProfileCommand([], output.io, {
    cwd,
    env: {},
    now: () => new Date(FIXED_NOW),
    loadConfig: async () => ({
      schemaVersion: 1,
      deviceId: DEVICE_ID,
      writerKey: WRITER_KEY,
      timezone: 'Asia/Seoul',
    }),
    profileRunner: async (options) => {
      runnerOptions = options;
      return {
        dailyUsageBuckets: [
          { startDate: '2026-07-17', tokens: 100 },
          { startDate: '2026-07-18', tokens: 250 },
        ],
        summary: { lifetimeTokens: 987654321 },
      };
    },
  });

  assert.equal(status, 0);
  assert.equal(runnerOptions.cwd, cwd);
  assert.deepEqual(runnerOptions.env, {});
  const candidate = JSON.parse(await readFile(
    path.join(cwd, 'data', 'profiles', `${DEVICE_ID}.json`),
    'utf8',
  ));
  assert.deepEqual(candidate, {
    schemaVersion: 2,
    kind: 'codex-profile',
    deviceId: DEVICE_ID,
    writerKeyHash: createHash('sha256').update(WRITER_KEY, 'utf8').digest('hex'),
    collectedAt: FIXED_NOW,
    dateBasis: 'provider-calendar-date',
    daily: [
      { date: '2026-07-17', totalTokens: 100 },
      { date: '2026-07-18', totalTokens: 250 },
    ],
    lifetimeTotalTokens: 987654321,
    coverage: {
      startDate: '2026-07-17',
      endDate: '2026-07-18',
      bucketCount: 2,
    },
  });
  assert.match(output.output().stdout, /2 daily buckets/);
  assert.equal(output.output().stdout.includes(DEVICE_ID), false);
  assert.equal(output.output().stderr, '');
});

test('profile command preserves an existing candidate on collection failure', async (t) => {
  const cwd = await makeTempDirectory(t, 'agent-card-profile-failure-');
  const destination = path.join(cwd, 'data', 'profiles', `${DEVICE_ID}.json`);
  await mkdir(path.dirname(destination), { recursive: true });
  const previous = `${JSON.stringify(makeExistingCandidate(), null, 2)}\n`;
  await writeFile(destination, previous, 'utf8');
  const output = makeIo();

  const status = await runProfileCommand([], output.io, {
    cwd,
    env: {},
    now: () => new Date(FIXED_NOW),
    loadConfig: async () => ({
      schemaVersion: 1,
      deviceId: DEVICE_ID,
      writerKey: WRITER_KEY,
      timezone: 'Asia/Seoul',
    }),
    profileRunner: async () => { throw new Error(PRIVATE_DETAILS); },
  });

  assert.equal(status, 1);
  assert.equal(await readFile(destination, 'utf8'), previous);
  assert.match(output.output().stderr, /APP_SERVER_FAILED/);
  assert.equal(output.output().stderr.includes(cwd), false);
  assert.equal(output.output().stderr.includes(PRIVATE_DETAILS), false);
});

for (const [name, overrides, expectedCode] of [
  ['writer ownership conflict', { writerKeyHash: 'ff'.repeat(32) }, 'WRITER_KEY_CONFLICT'],
  ['device identity mismatch', { deviceId: `device-${'ff'.repeat(16)}` }, 'WRITER_KEY_CONFLICT'],
]) {
  test(`${name} aborts before App Server collection`, async (t) => {
    const cwd = await makeTempDirectory(t, 'agent-card-profile-conflict-');
    const destination = path.join(cwd, 'data', 'profiles', `${DEVICE_ID}.json`);
    await mkdir(path.dirname(destination), { recursive: true });
    const previous = `${JSON.stringify(makeExistingCandidate(overrides), null, 2)}\n`;
    await writeFile(destination, previous, 'utf8');
    const output = makeIo();
    let runnerCalls = 0;

    const status = await runProfileCommand([], output.io, {
      cwd,
      env: {},
      loadConfig: async () => ({
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        writerKey: WRITER_KEY,
        timezone: 'Asia/Seoul',
      }),
      profileRunner: async () => {
        runnerCalls += 1;
        return { dailyUsageBuckets: [], summary: {} };
      },
    });

    assert.equal(status, 1);
    assert.equal(runnerCalls, 0);
    assert.equal(await readFile(destination, 'utf8'), previous);
    assert.equal(
      output.output().stderr,
      `Codex profile collection failed: ${expectedCode}\n`,
    );
  });
}

test('a malformed existing candidate fails closed before App Server collection', async (t) => {
  const cwd = await makeTempDirectory(t, 'agent-card-profile-malformed-');
  const destination = path.join(cwd, 'data', 'profiles', `${DEVICE_ID}.json`);
  await mkdir(path.dirname(destination), { recursive: true });
  const previous = '{"malformed":"candidate"}\n';
  await writeFile(destination, previous, 'utf8');
  const output = makeIo();
  let runnerCalls = 0;

  const status = await runProfileCommand([], output.io, {
    cwd,
    env: {},
    loadConfig: async () => ({
      schemaVersion: 1,
      deviceId: DEVICE_ID,
      writerKey: WRITER_KEY,
      timezone: 'Asia/Seoul',
    }),
    profileRunner: async () => {
      runnerCalls += 1;
      return { dailyUsageBuckets: [], summary: {} };
    },
  });

  assert.equal(status, 1);
  assert.equal(runnerCalls, 0);
  assert.equal(await readFile(destination, 'utf8'), previous);
  assert.equal(
    output.output().stderr,
    'Codex profile collection failed: EXISTING_PROFILE_INVALID\n',
  );
});

test('profile command help documents App Server prerequisites and snapshot retention', async () => {
  const output = makeIo();
  const status = await runProfileCommand(['--help'], output.io);

  assert.equal(status, 0);
  assert.match(output.output().stdout, /experimental/i);
  assert.match(output.output().stdout, /ChatGPT/);
  assert.match(output.output().stdout, /AGENT_CARD_CODEX_BIN/);
  assert.match(output.output().stdout, /npm-installed native/i);
  assert.match(output.output().stdout, /codex\.exe/i);
  assert.match(output.output().stdout, /last account snapshot/i);
  assert.match(output.output().stdout, /local-log cards/i);
  assert.doesNotMatch(output.output().stdout, /bearer|endpoint/i);
});
