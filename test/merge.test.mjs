import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeUsage, UsageMergeError } from '../src/domain/merge.mjs';
import { SCHEMA_VERSION } from '../src/domain/schema.mjs';

const NOW = '2026-07-21T12:00:00.000Z';
const WRITER_KEY_HASH = 'a'.repeat(64);

function deviceId(character) {
  return `device-${character.repeat(32)}`;
}

function day(date, overrides = {}) {
  return {
    date,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    sessions: 1,
    ...overrides,
  };
}

function source(days = [], overrides = {}) {
  const totals = days.length === 0
    ? { startDate: '2026-07-21', endDate: '2026-07-21' }
    : { startDate: days[0].date, endDate: '2026-07-21' };
  return {
    status: 'ok',
    lastSuccessfulAt: '2026-07-21T11:00:00.000Z',
    days,
    coverage: {
      totals,
      sessions: days.some((entry) => entry.sessions === null) ? null : { ...totals },
    },
    ...overrides,
  };
}

function device(character, codex = source(), overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: deviceId(character),
    writerKeyHash: WRITER_KEY_HASH,
    generatedAt: '2026-07-21T11:00:00.000Z',
    timezone: 'Asia/Seoul',
    collectorVersion: '1.0.0',
    sources: { codex },
    ...overrides,
  };
}

function profile(character, overrides = {}) {
  const daily = overrides.daily ?? [{ date: '2026-07-21', totalTokens: 700 }];
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'codex-profile',
    deviceId: deviceId(character),
    writerKeyHash: WRITER_KEY_HASH,
    collectedAt: '2026-07-21T11:00:00.000Z',
    dateBasis: 'provider-calendar-date',
    daily,
    coverage: daily.length === 0
      ? { startDate: null, endDate: null, bucketCount: 0 }
      : {
          startDate: daily[0].date,
          endDate: daily.at(-1).date,
          bucketCount: daily.length,
        },
    ...overrides,
    daily,
  };
}

function metric(overrides = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    sessions: 0,
    ...overrides,
  };
}

test('all device Codex usage is aggregated by sorted calendar day', () => {
  const first = device('1', source([
    day('2026-07-20', {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 10,
      sessions: 2,
    }),
  ]));
  const second = device('2', source([
    day('2026-07-20', {
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 7,
      cacheWriteTokens: 8,
      totalTokens: 26,
      sessions: 3,
    }),
    day('2026-07-21', { totalTokens: 50, sessions: 4 }),
  ]));

  const result = mergeUsage({
    deviceSnapshots: [second, first],
    profileCandidates: [],
    asOf: NOW,
  });

  assert.equal(result.codexSource, 'devices');
  assert.equal(result.codexDataState, 'device-fallback');
  assert.equal(result.timezone, 'Asia/Seoul');
  assert.deepEqual(result.days, [
    {
      date: '2026-07-20',
      codex: metric({
        input: 6,
        output: 8,
        cacheRead: 10,
        cacheWrite: 12,
        total: 36,
        sessions: 5,
      }),
    },
    {
      date: '2026-07-21',
      codex: metric({
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        total: 50,
        sessions: 4,
      }),
    },
  ]);
  assert.equal(Object.hasOwn(result.days[0], 'claude'), false);
  assert.equal(result.diagnostics.deviceCount, 2);
  assert.deepEqual(
    mergeUsage({ deviceSnapshots: [first, second], profileCandidates: [], asOf: NOW }),
    result,
  );
});

test('fresh account profile is authoritative and preserves provider calendar lifetime', () => {
  const local = device('1', source([
    day('2026-07-19', { totalTokens: 9_999 }),
    day('2026-07-21', { totalTokens: 8_888 }),
  ]));
  const candidate = profile('2', {
    daily: [
      { date: '2026-07-20', totalTokens: 500 },
      { date: '2026-07-21', totalTokens: 700 },
    ],
    lifetimeTotalTokens: 19_300_000_000,
  });

  const result = mergeUsage({
    deviceSnapshots: [local],
    profileCandidates: [candidate],
    asOf: NOW,
  });

  assert.equal(result.codexSource, 'profile');
  assert.equal(result.codexDataState, 'profile-current');
  assert.equal(result.codexLifetimeTotalTokens, 19_300_000_000);
  assert.deepEqual(result.days, [
    {
      date: '2026-07-20',
      codex: metric({
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        total: 500,
        sessions: null,
      }),
    },
    {
      date: '2026-07-21',
      codex: metric({
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        total: 700,
        sessions: null,
      }),
    },
  ]);
  assert.deepEqual(result.coverage.codex, {
    dateBasis: 'provider-calendar-date',
    totals: { startDate: '2026-07-20', endDate: '2026-07-21' },
    breakdown: null,
    sessions: null,
  });
  assert.equal(result.diagnostics.codexLifetimeCoverage, 'provider-reported');
});

test('profiles older than 48 hours remain as the last known account snapshot', () => {
  const local = device('1', source([day('2026-07-21', { totalTokens: 321 })]));
  const stale = profile('2', {
    collectedAt: '2026-07-19T11:59:59.000Z',
    daily: [{ date: '2026-07-19', totalTokens: 999 }],
    lifetimeTotalTokens: 999,
  });

  const result = mergeUsage({
    deviceSnapshots: [local],
    profileCandidates: [stale],
    asOf: NOW,
  });

  assert.equal(result.codexSource, 'profile');
  assert.equal(result.codexDataState, 'profile-retained');
  assert.equal(result.days[0].codex.total, 999);
  assert.equal(result.codexLifetimeTotalTokens, 999);
  assert.equal(result.diagnostics.freshProfileCandidateCount, 0);
  assert.equal(result.diagnostics.selectedProfileState, 'retained');
  assert.equal(result.diagnostics.selectedProfileCollectedAt, stale.collectedAt);
});

test('no successful public snapshot has a distinct not-updated state', () => {
  const result = mergeUsage({
    deviceSnapshots: [],
    profileCandidates: [],
    asOf: NOW,
    timezone: 'UTC',
  });

  assert.equal(result.codexSource, 'none');
  assert.equal(result.codexDataState, 'not-updated');
  assert.deepEqual(result.days, []);
  assert.equal(result.coverage.codex.totals, null);
  assert.equal(result.diagnostics.selectedProfileState, 'none');
});

test('equal profile timestamps select lexical device id deterministically', () => {
  const first = profile('1', {
    daily: [{ date: '2026-07-21', totalTokens: 111 }],
  });
  const second = profile('f', {
    daily: [{ date: '2026-07-21', totalTokens: 999 }],
  });

  const left = mergeUsage({
    profileCandidates: [second, first],
    asOf: NOW,
    timezone: 'UTC',
  });
  const right = mergeUsage({
    profileCandidates: [first, second],
    asOf: NOW,
    timezone: 'UTC',
  });

  assert.deepEqual(left, right);
  assert.equal(left.days[0].codex.total, 111);
});

test('invalid v1 candidates are counted and never replace valid device data', () => {
  const local = device('1', source([day('2026-07-21', { totalTokens: 444 })]));
  const old = profile('2', { schemaVersion: 1 });

  const result = mergeUsage({
    deviceSnapshots: [local],
    profileCandidates: [old],
    asOf: NOW,
  });

  assert.equal(result.codexSource, 'devices');
  assert.equal(result.days[0].codex.total, 444);
  assert.equal(result.diagnostics.invalidProfileCandidateCount, 1);
});

test('local coverage is the intersection shared by every device', () => {
  const first = device('1', source([day('2026-07-18')], {
    coverage: {
      totals: { startDate: '2026-07-18', endDate: '2026-07-21' },
      sessions: { startDate: '2026-07-18', endDate: '2026-07-21' },
    },
  }));
  const second = device('2', source([day('2026-07-20')], {
    coverage: {
      totals: { startDate: '2026-07-20', endDate: '2026-07-21' },
      sessions: { startDate: '2026-07-20', endDate: '2026-07-21' },
    },
  }));

  const result = mergeUsage({
    deviceSnapshots: [first, second],
    asOf: NOW,
  });

  assert.deepEqual(result.coverage.codex, {
    dateBasis: 'Asia/Seoul',
    totals: { startDate: '2026-07-20', endDate: '2026-07-21' },
    breakdown: { startDate: '2026-07-20', endDate: '2026-07-21' },
    sessions: { startDate: '2026-07-20', endDate: '2026-07-21' },
  });
});

test('duplicates, timezone mismatch, and safe integer overflow fail closed', () => {
  const duplicate = device('1');
  assert.throws(
    () => mergeUsage({
      deviceSnapshots: [duplicate, structuredClone(duplicate)],
      asOf: NOW,
    }),
    (error) => error instanceof UsageMergeError && error.code === 'DUPLICATE_DEVICE',
  );

  assert.throws(
    () => mergeUsage({
      deviceSnapshots: [
        device('1'),
        device('2', source(), { timezone: 'UTC' }),
      ],
      asOf: NOW,
    }),
    (error) => error instanceof UsageMergeError && error.code === 'TIMEZONE_MISMATCH',
  );

  assert.throws(
    () => mergeUsage({
      deviceSnapshots: [
        device('1', source([day('2026-07-21', { totalTokens: Number.MAX_SAFE_INTEGER })])),
        device('2', source([day('2026-07-21', { totalTokens: 1 })])),
      ],
      asOf: NOW,
    }),
    (error) => error instanceof UsageMergeError && error.code === 'SAFE_INTEGER_OVERFLOW',
  );
});
