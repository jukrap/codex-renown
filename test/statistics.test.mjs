import assert from 'node:assert/strict';
import test from 'node:test';

import { eachDay } from '../src/domain/calendar.mjs';
import { computeStatistics, StatisticsError } from '../src/domain/statistics.mjs';

function range(startDate, endDate) {
  return { startDate, endDate };
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

function day(date, overrides = {}) {
  return { date, codex: metric(overrides) };
}

function merged(overrides = {}) {
  const codexSource = overrides.codexSource ?? 'devices';
  const totals = overrides.totals ?? null;
  const result = {
    timezone: overrides.timezone ?? 'UTC',
    codexSource,
    days: overrides.days ?? [],
    coverage: {
      codex: {
        dateBasis: codexSource === 'profile'
          ? 'provider-calendar-date'
          : (overrides.timezone ?? 'UTC'),
        totals,
        breakdown: overrides.breakdown ?? totals,
        sessions: overrides.sessions ?? totals,
      },
    },
  };
  if (Object.hasOwn(overrides, 'codexDataState')) {
    result.codexDataState = overrides.codexDataState;
  }
  if (Object.hasOwn(overrides, 'codexLifetimeTotalTokens')) {
    result.codexLifetimeTotalTokens = overrides.codexLifetimeTotalTokens;
  }
  return result;
}

function complete(value) {
  return { value, coverage: 'complete', lowerBound: false };
}

function partial(value) {
  return { value, coverage: 'partial', lowerBound: true };
}

function unknown() {
  return { value: null, coverage: 'unknown', lowerBound: false };
}

test('no successful snapshot remains distinct from an observed zero', () => {
  const stats = computeStatistics(merged({
    codexSource: 'none',
    codexDataState: 'not-updated',
  }), { asOf: '2026-07-21' });

  assert.equal(stats.codexDataState, 'not-updated');
  assert.deepEqual(stats.lifetime.totalTokens, unknown());
  assert.equal(stats.rank.status, 'unranked');
  assert.deepEqual(stats.periods.today.current.totalTokens, unknown());
});

test('missing dates are zero only inside declared Codex coverage', () => {
  const observed = range('2026-07-19', '2026-07-21');
  const stats = computeStatistics(merged({
    days: [day('2026-07-20', { total: 9 })],
    totals: observed,
  }), { asOf: '2026-07-21' });

  assert.deepEqual(stats.periods.today.current.totalTokens, complete(0));
  assert.deepEqual(stats.lifetime.totalTokens, complete(9));
  assert.deepEqual(stats.activity.activeDays, complete(1));
  assert.equal(stats.activity.peak.date, '2026-07-20');
  assert.equal(
    stats.heatmap.cells.find((cell) => cell.date === '2026-07-19').state,
    'zero',
  );

  const later = computeStatistics(merged({
    days: [day('2026-07-20', { total: 9 })],
    totals: observed,
  }), { asOf: '2026-07-22' });
  assert.deepEqual(later.periods.today.current.totalTokens, unknown());
  assert.deepEqual(later.lifetime.totalTokens, partial(9));
});

test('fresh account profile uses one provider calendar and exact lifetime rank', () => {
  const observed = range('2026-07-20', '2026-07-21');
  const stats = computeStatistics(merged({
    codexSource: 'profile',
    days: [
      day('2026-07-20', {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        total: 100,
        sessions: null,
      }),
      day('2026-07-21', {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        total: 200,
        sessions: null,
      }),
    ],
    totals: observed,
    breakdown: null,
    sessions: null,
    codexLifetimeTotalTokens: 19_300_000_000,
  }), { asOf: '2026-07-21' });

  assert.equal(stats.calendarLabel, 'Codex account calendar');
  assert.deepEqual(stats.periods.today.current.totalTokens, complete(200));
  assert.deepEqual(stats.periods.today.current.sessions, unknown());
  assert.deepEqual(stats.lifetime.totalTokens, complete(19_300_000_000));
  assert.equal(stats.lifetime.provenance, 'provider-reported');
  assert.equal(stats.rank.current.roman, 'XV');
  assert.equal(stats.rank.current.title, 'Mythic');
  assert.equal(Math.round(stats.rank.progressPercentage), 62);
  assert.equal(stats.rank.lowerBound, false);
});

test('device fallback lifetime is an observed lower bound', () => {
  const stats = computeStatistics(merged({
    days: [day('2026-07-20', { total: 100_000 })],
    totals: range('2026-07-20', '2026-07-20'),
  }), { asOf: '2026-07-21' });

  assert.deepEqual(stats.lifetime.totalTokens, partial(100_000));
  assert.equal(stats.lifetime.provenance, 'tracked-daily');
  assert.equal(stats.rank.current.roman, 'IV');
  assert.equal(stats.rank.lowerBound, true);
  assert.equal(stats.calendarLabel, 'UTC');
});

test('records use complete coverage, zero-fill missing dates, and break ties early', () => {
  const stats = computeStatistics(merged({
    days: [
      day('2026-01-01', { total: 100 }),
      day('2026-02-28', { total: 100 }),
    ],
    totals: range('2026-01-01', '2026-02-28'),
  }), { asOf: '2026-02-28' });

  assert.deepEqual(stats.records.peakDay, {
    value: 100,
    startDate: '2026-01-01',
    endDate: '2026-01-01',
    coverage: 'complete',
    lowerBound: false,
  });
  assert.deepEqual(stats.records.best7, {
    value: 100,
    startDate: '2026-01-01',
    endDate: '2026-01-07',
    coverage: 'complete',
    lowerBound: false,
  });
  assert.deepEqual(stats.records.best30, {
    value: 100,
    startDate: '2026-01-01',
    endDate: '2026-01-30',
    coverage: 'complete',
    lowerBound: false,
  });
  assert.deepEqual(stats.records.bestMonth, {
    value: 100,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    coverage: 'complete',
    lowerBound: false,
  });
});

test('records remain unknown without a fully covered candidate window', () => {
  const stats = computeStatistics(merged({
    days: [day('2026-07-21', { total: 1 })],
    totals: range('2026-07-21', '2026-07-21'),
  }), { asOf: '2026-07-21' });

  assert.equal(stats.records.peakDay.value, 1);
  assert.deepEqual(stats.records.best7, {
    value: null,
    startDate: null,
    endDate: null,
    coverage: 'unknown',
    lowerBound: false,
  });
  assert.equal(stats.records.best30.value, null);
  assert.equal(stats.records.bestMonth.value, null);
});

test('activity, streak, peak, trends, and heatmap stay Codex-only', () => {
  const observed = range('2026-07-18', '2026-07-21');
  const stats = computeStatistics(merged({
    days: [
      day('2026-07-18', { total: 10 }),
      day('2026-07-19', { total: 20 }),
      day('2026-07-21', { total: 30 }),
    ],
    totals: observed,
  }), { asOf: '2026-07-21' });

  assert.deepEqual(stats.activity.activeDays, complete(3));
  assert.deepEqual(stats.activity.currentStreak, complete(1));
  assert.deepEqual(stats.activity.longestStreak, partial(2));
  assert.equal(stats.activity.peak.date, '2026-07-21');
  assert.equal(stats.trends.daily.length, 30);
  assert.equal(stats.trends.weekly.length, 12);
  assert.equal(stats.trends.monthly.length, 12);
  assert.equal(stats.heatmap.cells.length, 371);
  assert.equal(stats.heatmap.cells.filter((cell) => cell.state === 'active').length, 3);
});

test('statistics exposes 16 coverage-aware achievements and four representatives', () => {
  const dates = eachDay('2026-01-01', '2026-05-31');
  const days = dates
    .filter((_, index) => (index + 1) % 40 !== 0)
    .map((date, index) => day(date, {
      total: index < 7 ? 900_000_000 : 100_000_000,
    }));
  const stats = computeStatistics(merged({
    codexSource: 'profile',
    days,
    totals: range('2026-01-01', '2026-05-31'),
    breakdown: null,
    sessions: null,
    codexLifetimeTotalTokens: 19_300_000_000,
  }), { asOf: '2026-05-31' });

  assert.equal(stats.achievements.length, 16);
  assert.deepEqual(
    stats.achievementRepresentatives.map((achievement) => achievement.label),
    ['Mythic Realm', 'Seven-Day Siege', 'Monthbound', 'Active Centurion'],
  );
});

test('a later longer streak is exact even when coverage starts active', () => {
  const observed = range('2026-07-15', '2026-07-21');
  const stats = computeStatistics(merged({
    days: [
      day('2026-07-15', { total: 10 }),
      day('2026-07-17', { total: 10 }),
      day('2026-07-18', { total: 10 }),
      day('2026-07-19', { total: 10 }),
      day('2026-07-20', { total: 10 }),
      day('2026-07-21', { total: 10 }),
    ],
    totals: observed,
  }), { asOf: '2026-07-21' });

  assert.deepEqual(stats.activity.currentStreak, complete(5));
  assert.deepEqual(stats.activity.longestStreak, complete(5));
});

test('comparisons require complete periods and use deterministic percentage semantics', () => {
  const observed = range('2026-07-08', '2026-07-21');
  const days = [
    day('2026-07-08', { total: 50 }),
    day('2026-07-15', { total: 100 }),
  ];
  const stats = computeStatistics(merged({ days, totals: observed }), {
    asOf: '2026-07-21',
  });

  assert.deepEqual(stats.periods.rolling7.previous.totalTokens, complete(50));
  assert.deepEqual(stats.periods.rolling7.current.totalTokens, complete(100));
  assert.deepEqual(stats.periods.rolling7.comparison, {
    kind: 'percent',
    percentage: 100,
  });
});

test('safe integer overflow and malformed coverage fail closed', () => {
  assert.throws(
    () => computeStatistics(merged({
      days: [
        day('2026-07-20', { total: Number.MAX_SAFE_INTEGER }),
        day('2026-07-21', { total: 1 }),
      ],
      totals: range('2026-07-20', '2026-07-21'),
    }), { asOf: '2026-07-21' }),
    (error) => error instanceof StatisticsError && error.code === 'SAFE_INTEGER_OVERFLOW',
  );

  assert.throws(
    () => computeStatistics(merged({
      totals: range('2026-07-22', '2026-07-21'),
    }), { asOf: '2026-07-21' }),
    (error) => error instanceof StatisticsError && error.code === 'COVERAGE_RANGE',
  );
});
