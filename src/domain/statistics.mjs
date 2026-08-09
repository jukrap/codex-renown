import {
  addDays,
  assertIsoDate,
  assertTimeZone,
  dateAtInstant,
  daysBetween,
  eachDay,
  heatmapRange,
  monthStart,
  periodRanges,
  shiftMonthStart,
  trendBuckets,
} from './calendar.mjs';
import {
  evaluateAchievements,
  selectRepresentativeAchievements,
} from './achievements.mjs';
import { computeTokenRank } from './rank.mjs';

const BREAKDOWN_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CODEX_SOURCES = new Set(['none', 'devices', 'profile']);
const CODEX_DATA_STATES = new Set([
  'not-updated',
  'device-fallback',
  'profile-current',
  'profile-retained',
]);

export class StatisticsError extends TypeError {
  constructor(code, path = '$') {
    super(`${code} at ${path}`);
    this.name = 'StatisticsError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path) {
  throw new StatisticsError(code, path);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeAdd(left, right, path) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    fail('SAFE_INTEGER_OVERFLOW', path);
  }
  return result;
}

function assertNonNegativeSafeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('NON_NEGATIVE_SAFE_INTEGER', path);
  }
  return value;
}

function validateDate(value, path) {
  try {
    return assertIsoDate(value);
  } catch {
    fail('DATE', path);
  }
}

function validateTimezone(value) {
  try {
    return assertTimeZone(value);
  } catch {
    fail('TIMEZONE', '$.timezone');
  }
}

function resolveAsOf(value, timezone) {
  if (typeof value === 'string' && ISO_DATE_PATTERN.test(value)) {
    return validateDate(value, '$.asOf');
  }

  const epochMs = value instanceof Date
    ? value.valueOf()
    : typeof value === 'number'
      ? value
      : Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    fail('AS_OF', '$.asOf');
  }
  try {
    return dateAtInstant(epochMs, timezone);
  } catch {
    fail('AS_OF', '$.asOf');
  }
}

function normalizeRange(value, path) {
  if (value === null) {
    return null;
  }
  if (!isObject(value)) {
    fail('COVERAGE_RANGE', path);
  }
  const startDate = validateDate(value.startDate, `${path}.startDate`);
  const endDate = validateDate(value.endDate, `${path}.endDate`);
  if (startDate > endDate) {
    fail('COVERAGE_RANGE', path);
  }
  return { startDate, endDate };
}

function normalizeCoverage(value) {
  const path = '$.coverage.codex';
  if (!isObject(value) || typeof value.dateBasis !== 'string' || value.dateBasis.length === 0) {
    fail('COVERAGE', path);
  }
  return {
    dateBasis: value.dateBasis,
    totals: normalizeRange(value.totals, `${path}.totals`),
    breakdown: normalizeRange(value.breakdown, `${path}.breakdown`),
    sessions: normalizeRange(value.sessions, `${path}.sessions`),
  };
}

function normalizeMetric(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isObject(value)) {
    fail('METRIC', path);
  }

  const result = {};
  for (const field of BREAKDOWN_FIELDS) {
    const fieldValue = value[field];
    result[field] = fieldValue === null
      ? null
      : assertNonNegativeSafeInteger(fieldValue, `${path}.${field}`);
  }
  result.total = assertNonNegativeSafeInteger(value.total, `${path}.total`);
  result.sessions = value.sessions === null
    ? null
    : assertNonNegativeSafeInteger(value.sessions, `${path}.sessions`);

  const knownBreakdown = BREAKDOWN_FIELDS.reduce(
    (sum, field) => result[field] === null
      ? sum
      : safeAdd(sum, result[field], `${path}.${field}`),
    0,
  );
  if (knownBreakdown > result.total) {
    fail('BREAKDOWN_EXCEEDS_TOTAL', path);
  }
  return result;
}

function normalizeInput(merged) {
  if (!isObject(merged)) {
    fail('MERGED_USAGE', '$');
  }
  const timezone = validateTimezone(merged.timezone);
  if (!Array.isArray(merged.days)) {
    fail('DAYS', '$.days');
  }
  if (!isObject(merged.coverage)) {
    fail('COVERAGE', '$.coverage');
  }
  if (!CODEX_SOURCES.has(merged.codexSource)) {
    fail('CODEX_SOURCE', '$.codexSource');
  }
  const codexDataState = merged.codexDataState ?? (
    merged.codexSource === 'profile'
      ? 'profile-current'
      : merged.codexSource === 'devices'
        ? 'device-fallback'
        : 'not-updated'
  );
  if (!CODEX_DATA_STATES.has(codexDataState)
    || (codexDataState === 'not-updated' && merged.codexSource !== 'none')
    || (codexDataState === 'device-fallback' && merged.codexSource !== 'devices')
    || (codexDataState.startsWith('profile-') && merged.codexSource !== 'profile')) {
    fail('CODEX_DATA_STATE', '$.codexDataState');
  }

  const days = new Map();
  for (const [index, value] of merged.days.entries()) {
    const path = `$.days[${index}]`;
    if (!isObject(value)) {
      fail('DAY', path);
    }
    const date = validateDate(value.date, `${path}.date`);
    if (days.has(date)) {
      fail('DUPLICATE_DATE', `${path}.date`);
    }
    days.set(date, {
      date,
      codex: normalizeMetric(value.codex, `${path}.codex`),
    });
  }

  const codexLifetimeTotalTokens = Object.hasOwn(merged, 'codexLifetimeTotalTokens')
    ? assertNonNegativeSafeInteger(
        merged.codexLifetimeTotalTokens,
        '$.codexLifetimeTotalTokens',
      )
    : null;
  if (codexLifetimeTotalTokens !== null && merged.codexSource !== 'profile') {
    fail('LIFETIME_PROVENANCE', '$.codexLifetimeTotalTokens');
  }

  return {
    timezone,
    codexSource: merged.codexSource,
    codexDataState,
    days,
    coverage: normalizeCoverage(merged.coverage.codex),
    codexLifetimeTotalTokens,
  };
}

function inRange(date, range) {
  return range !== null && range.startDate <= date && date <= range.endDate;
}

function observedMetric(value, coverage) {
  if (coverage === 'unknown') {
    return { value: null, coverage, lowerBound: false };
  }
  return {
    value,
    coverage,
    lowerBound: coverage === 'partial',
  };
}

function completeMetric(value) {
  return observedMetric(value, 'complete');
}

function partialMetric(value) {
  return observedMetric(value, 'partial');
}

function unknownMetric() {
  return observedMetric(null, 'unknown');
}

function hasKnownSignal(metric) {
  if (metric === null) {
    return false;
  }
  if (metric.total > 0 || (metric.sessions !== null && metric.sessions > 0)) {
    return true;
  }
  return BREAKDOWN_FIELDS.some((field) => metric[field] !== null && metric[field] > 0);
}

function totalForDate(input, date) {
  const raw = input.days.get(date)?.codex ?? null;
  if (inRange(date, input.coverage.totals)) {
    return completeMetric(raw?.total ?? 0);
  }
  if (raw !== null && raw.total > 0) {
    return partialMetric(raw.total);
  }
  return unknownMetric();
}

function sessionsForDate(input, date) {
  const raw = input.days.get(date)?.codex ?? null;
  if (inRange(date, input.coverage.sessions)) {
    if (raw?.sessions === null) {
      return unknownMetric();
    }
    return completeMetric(raw?.sessions ?? 0);
  }
  if (raw?.sessions !== null && raw?.sessions !== undefined && hasKnownSignal(raw)) {
    return partialMetric(raw.sessions);
  }
  return unknownMetric();
}

function aggregateMetrics(metrics, path) {
  const known = metrics.filter((metric) => metric.value !== null);
  if (known.length === 0) {
    return unknownMetric();
  }
  const value = known.reduce(
    (sum, metric) => safeAdd(sum, metric.value, path),
    0,
  );
  return metrics.every((metric) => metric.coverage === 'complete')
    ? completeMetric(value)
    : partialMetric(value);
}

function publicRange(value) {
  return { startDate: value.start, endDate: value.end };
}

function summarizeRange(input, range) {
  const dates = eachDay(range.startDate, range.endDate);
  return {
    range: { ...range },
    totalTokens: aggregateMetrics(
      dates.map((date) => totalForDate(input, date)),
      `$.statistics.ranges.${range.startDate}.${range.endDate}.totalTokens`,
    ),
    sessions: aggregateMetrics(
      dates.map((date) => sessionsForDate(input, date)),
      `$.statistics.ranges.${range.startDate}.${range.endDate}.sessions`,
    ),
  };
}

function comparison(current, previous) {
  if (current.coverage !== 'complete' || previous.coverage !== 'complete') {
    return { kind: 'unknown', percentage: null };
  }
  if (current.value === previous.value) {
    return { kind: 'flat', percentage: 0 };
  }
  if (previous.value === 0) {
    return { kind: 'new', percentage: null };
  }
  return {
    kind: 'percent',
    percentage: ((current.value - previous.value) / previous.value) * 100,
  };
}

function periodStatistics(input, ranges) {
  return Object.fromEntries(Object.entries(ranges).map(([name, value]) => {
    const current = summarizeRange(input, publicRange(value.current));
    const previous = summarizeRange(input, publicRange(value.previous));
    return [name, {
      current,
      previous,
      comparison: comparison(current.totalTokens, previous.totalTokens),
    }];
  }));
}

function trackedStartDate(input, asOf) {
  const candidates = [];
  for (const { date } of input.days.values()) {
    if (date <= asOf) {
      candidates.push(date);
    }
  }
  const coverageStart = input.coverage.totals?.startDate;
  if (coverageStart !== undefined && coverageStart <= asOf) {
    candidates.push(coverageStart);
  }
  return candidates.length === 0 ? null : candidates.toSorted()[0];
}

function lifetimeStatistics(input, asOf) {
  const startDate = trackedStartDate(input, asOf);
  const range = startDate === null ? null : { startDate, endDate: asOf };
  const tracked = range === null
    ? { totalTokens: unknownMetric(), sessions: unknownMetric() }
    : summarizeRange(input, range);
  const providerReported = input.codexLifetimeTotalTokens === null
    ? null
    : completeMetric(input.codexLifetimeTotalTokens);

  return {
    range,
    trackedTotalTokens: tracked.totalTokens,
    totalTokens: providerReported ?? tracked.totalTokens,
    sessions: tracked.sessions,
    provenance: providerReported === null ? 'tracked-daily' : 'provider-reported',
  };
}

function stateForMetric(metric) {
  if (metric.value === null || (metric.coverage === 'partial' && metric.value === 0)) {
    return 'unknown';
  }
  return metric.value === 0 ? 'zero' : 'active';
}

function activityStatistics(input, asOf, lifetimeRange) {
  if (lifetimeRange === null) {
    return {
      activeDays: unknownMetric(),
      currentStreak: unknownMetric(),
      longestStreak: unknownMetric(),
      peak: { date: null, totalTokens: null, coverage: 'unknown', lowerBound: false },
    };
  }

  const dates = eachDay(lifetimeRange.startDate, lifetimeRange.endDate);
  let activeDays = 0;
  let currentRun = 0;
  let longestRun = 0;
  let sawKnown = false;
  let sawUnknown = false;
  let leftBoundaryRun = 0;
  let peak = null;
  let peakIncomplete = false;

  for (const [index, date] of dates.entries()) {
    const totalTokens = totalForDate(input, date);
    const state = stateForMetric(totalTokens);
    if (state === 'unknown') {
      sawUnknown = true;
      currentRun = 0;
      peakIncomplete = true;
      continue;
    }

    sawKnown = true;
    if (state === 'active') {
      if (index === leftBoundaryRun) {
        leftBoundaryRun += 1;
      }
      activeDays += 1;
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
      if (
        peak === null
        || totalTokens.value > peak.totalTokens
        || (totalTokens.value === peak.totalTokens && date < peak.date)
      ) {
        peak = { date, totalTokens: totalTokens.value };
      }
      if (totalTokens.coverage !== 'complete') {
        peakIncomplete = true;
      }
    } else {
      currentRun = 0;
    }
  }

  const binaryCoverage = !sawKnown
    ? 'unknown'
    : sawUnknown
      ? 'partial'
      : 'complete';
  const activeDaysMetric = binaryCoverage === 'unknown'
    ? unknownMetric()
    : observedMetric(activeDays, binaryCoverage);
  const longestCoverage = binaryCoverage === 'complete'
    && leftBoundaryRun > 0
    && leftBoundaryRun === longestRun
    ? 'partial'
    : binaryCoverage;
  const longestStreakMetric = longestCoverage === 'unknown'
    ? unknownMetric()
    : observedMetric(longestRun, longestCoverage);

  let currentStreak = 0;
  let currentCoverage = 'partial';
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const state = stateForMetric(totalForDate(input, dates[index]));
    if (state === 'active') {
      currentStreak += 1;
      continue;
    }
    if (state === 'zero') {
      currentCoverage = 'complete';
    } else if (currentStreak === 0) {
      currentCoverage = 'unknown';
    }
    break;
  }
  const currentStreakMetric = currentCoverage === 'unknown'
    ? unknownMetric()
    : observedMetric(currentStreak, currentCoverage);

  const peakCoverage = peak === null
    ? (sawUnknown ? 'unknown' : 'complete')
    : (peakIncomplete ? 'partial' : 'complete');
  return {
    activeDays: activeDaysMetric,
    currentStreak: currentStreakMetric,
    longestStreak: longestStreakMetric,
    peak: {
      date: peak?.date ?? null,
      totalTokens: peak?.totalTokens ?? (peakCoverage === 'complete' ? 0 : null),
      coverage: peakCoverage,
      lowerBound: peakCoverage === 'partial',
    },
  };
}

function trendStatistics(input, ranges) {
  return Object.fromEntries(Object.entries(ranges).map(([name, buckets]) => [
    name,
    buckets.map((bucket) => summarizeRange(input, publicRange(bucket))),
  ]));
}

function nearestRank(values, fraction) {
  return values[Math.ceil(values.length * fraction) - 1];
}

function heatmapStatistics(input, asOf) {
  const range = heatmapRange(asOf);
  const entries = range.dates.map((date) => {
    if (date > asOf) {
      return {
        date,
        state: 'future',
        totalTokens: null,
        coverage: 'unknown',
        level: 0,
      };
    }
    const totalTokens = totalForDate(input, date);
    const state = stateForMetric(totalTokens);
    return {
      date,
      state,
      totalTokens: state === 'active' || state === 'zero' ? totalTokens.value : null,
      coverage: totalTokens.coverage,
      level: 0,
    };
  });

  const positive = entries
    .filter((entry) => entry.state === 'active')
    .map((entry) => entry.totalTokens)
    .toSorted((left, right) => left - right);
  const thresholds = positive.length === 0
    ? []
    : [
        nearestRank(positive, 0.25),
        nearestRank(positive, 0.5),
        nearestRank(positive, 0.75),
      ];

  for (const entry of entries) {
    if (entry.state === 'active') {
      entry.level = 1 + thresholds.filter((threshold) => entry.totalTokens > threshold).length;
    }
  }

  return {
    startDate: range.start,
    endDate: range.end,
    thresholds,
    cells: entries,
  };
}

function completeTotalsRange(input, asOf) {
  const coverage = input.coverage.totals;
  if (coverage === null || coverage.startDate > asOf) {
    return null;
  }
  const endDate = coverage.endDate < asOf ? coverage.endDate : asOf;
  return coverage.startDate <= endDate
    ? { startDate: coverage.startDate, endDate }
    : null;
}

function unknownRecord() {
  return {
    value: null,
    startDate: null,
    endDate: null,
    coverage: 'unknown',
    lowerBound: false,
  };
}

function completeRecord(value, startDate, endDate) {
  return {
    value,
    startDate,
    endDate,
    coverage: 'complete',
    lowerBound: false,
  };
}

function bestWindow(input, asOf, windowDays, path) {
  const range = completeTotalsRange(input, asOf);
  if (range === null || daysBetween(range.startDate, range.endDate) + 1 < windowDays) {
    return unknownRecord();
  }

  const lastStart = addDays(range.endDate, -(windowDays - 1));
  let best = null;
  for (const startDate of eachDay(range.startDate, lastStart)) {
    const endDate = addDays(startDate, windowDays - 1);
    const value = eachDay(startDate, endDate).reduce(
      (sum, date) => safeAdd(
        sum,
        input.days.get(date)?.codex?.total ?? 0,
        `${path}.${startDate}`,
      ),
      0,
    );
    if (best === null || value > best.value) {
      best = completeRecord(value, startDate, endDate);
    }
  }
  return best ?? unknownRecord();
}

function bestCompleteMonth(input, asOf) {
  const range = completeTotalsRange(input, asOf);
  if (range === null) {
    return unknownRecord();
  }

  let current = monthStart(range.startDate);
  if (current < range.startDate) {
    current = shiftMonthStart(current, 1);
  }
  let best = null;
  while (current <= range.endDate) {
    const endDate = addDays(shiftMonthStart(current, 1), -1);
    if (endDate > range.endDate) {
      break;
    }
    const value = eachDay(current, endDate).reduce(
      (sum, date) => safeAdd(
        sum,
        input.days.get(date)?.codex?.total ?? 0,
        `$.statistics.records.bestMonth.${current}`,
      ),
      0,
    );
    if (best === null || value > best.value) {
      best = completeRecord(value, current, endDate);
    }
    current = shiftMonthStart(current, 1);
  }
  return best ?? unknownRecord();
}

function recordStatistics(input, asOf) {
  return {
    peakDay: bestWindow(input, asOf, 1, '$.statistics.records.peakDay'),
    best7: bestWindow(input, asOf, 7, '$.statistics.records.best7'),
    best30: bestWindow(input, asOf, 30, '$.statistics.records.best30'),
    bestMonth: bestCompleteMonth(input, asOf),
  };
}

function recordMetric(record) {
  return {
    value: record.value,
    coverage: record.coverage,
    lowerBound: record.lowerBound,
  };
}

/**
 * Computes deterministic, coverage-aware Codex card statistics.
 * Missing dates are zero only inside declared coverage.
 */
export function computeStatistics(merged, { asOf } = {}) {
  const input = normalizeInput(merged);
  if (asOf === undefined) {
    fail('AS_OF', '$.asOf');
  }
  const asOfDate = resolveAsOf(asOf, input.timezone);
  const ranges = periodRanges(asOfDate);
  const periods = periodStatistics(input, ranges);
  const lifetime = lifetimeStatistics(input, asOfDate);
  const activity = activityStatistics(input, asOfDate, lifetime.range);
  const rank = computeTokenRank(lifetime.totalTokens);
  const records = recordStatistics(input, asOfDate);
  const achievements = evaluateAchievements({
    lifetime: lifetime.totalTokens,
    peakDay: {
      value: activity.peak.totalTokens,
      coverage: activity.peak.coverage,
      lowerBound: activity.peak.lowerBound,
    },
    best7: recordMetric(records.best7),
    bestMonth: recordMetric(records.bestMonth),
    longestStreak: activity.longestStreak,
    activeDays: activity.activeDays,
  });

  return {
    asOf: asOfDate,
    timezone: input.timezone,
    dateBasis: input.coverage.dateBasis,
    calendarLabel: input.coverage.dateBasis === 'provider-calendar-date'
      ? 'Codex account calendar'
      : input.timezone,
    codexSource: input.codexSource,
    codexDataState: input.codexDataState,
    periods,
    lifetime,
    rank,
    achievements,
    achievementRepresentatives: selectRepresentativeAchievements(achievements),
    records,
    activity,
    trends: trendStatistics(input, trendBuckets(asOfDate)),
    heatmap: heatmapStatistics(input, asOfDate),
  };
}
