import {
  PublicSchemaError,
  validateDeviceSnapshot,
  validateIanaTimezone,
  validateProfileCandidate,
} from './schema.mjs';

const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const DEFAULT_PROFILE_FRESHNESS_HOURS = 48;
const DEFAULT_DEVICE_STALE_HOURS = 72;
const DEFAULT_FUTURE_CLOCK_SKEW_MINUTES = 5;

const LOCAL_METRIC_FIELDS = Object.freeze([
  ['inputTokens', 'input'],
  ['outputTokens', 'output'],
  ['cacheReadTokens', 'cacheRead'],
  ['cacheWriteTokens', 'cacheWrite'],
  ['totalTokens', 'total'],
]);

export class UsageMergeError extends TypeError {
  constructor(code, path = '$') {
    super(`${code} at ${path}`);
    this.name = 'UsageMergeError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path) {
  throw new UsageMergeError(code, path);
}

function assertArray(value, path) {
  if (!Array.isArray(value)) {
    fail('ARRAY', path);
  }
}

function durationToMilliseconds(value, unitMilliseconds, path) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER / unitMilliseconds
  ) {
    fail('DURATION', path);
  }
  return value * unitMilliseconds;
}

function parseAsOf(value) {
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    fail('AS_OF', '$.asOf');
  }
  return parsed.valueOf();
}

function safeAdd(left, right, path) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    fail('SAFE_INTEGER_OVERFLOW', path);
  }
  return value;
}

function emptyLocalAccumulator() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    sessionTotal: 0,
    sessionUnknown: false,
  };
}

function localMetric(accumulator) {
  if (accumulator === undefined) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      sessions: 0,
    };
  }
  return {
    input: accumulator.input,
    output: accumulator.output,
    cacheRead: accumulator.cacheRead,
    cacheWrite: accumulator.cacheWrite,
    total: accumulator.total,
    sessions: accumulator.sessionUnknown ? null : accumulator.sessionTotal,
  };
}

function profileMetric(total) {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total,
    sessions: null,
  };
}

function aggregateLocalSource(deviceSnapshots) {
  const byDate = new Map();
  let dayRecordCount = 0;
  let knownSessionRecordCount = 0;
  let unknownSessionRecordCount = 0;

  for (const snapshot of deviceSnapshots) {
    for (const day of snapshot.sources.codex.days) {
      dayRecordCount += 1;
      const current = byDate.get(day.date) ?? emptyLocalAccumulator();
      for (const [inputField, outputField] of LOCAL_METRIC_FIELDS) {
        current[outputField] = safeAdd(
          current[outputField],
          day[inputField],
          `$.days.${day.date}.codex.${outputField}`,
        );
      }

      if (day.sessions === null) {
        current.sessionUnknown = true;
        unknownSessionRecordCount += 1;
      } else {
        current.sessionTotal = safeAdd(
          current.sessionTotal,
          day.sessions,
          `$.days.${day.date}.codex.sessions`,
        );
        knownSessionRecordCount += 1;
      }
      byDate.set(day.date, current);
    }
  }

  return {
    byDate,
    dayRecordCount,
    knownSessionRecordCount,
    unknownSessionRecordCount,
  };
}

function sessionCoverage(aggregate) {
  if (aggregate.dayRecordCount === 0) {
    return 'none';
  }
  if (aggregate.unknownSessionRecordCount === 0) {
    return 'complete';
  }
  if (aggregate.knownSessionRecordCount === 0) {
    return 'unavailable';
  }
  return 'partial';
}

function intersectCoverage(devices, field) {
  const ranges = devices.map((snapshot) => snapshot.sources.codex.coverage[field]);
  if (ranges.length === 0 || ranges.some((range) => range === null)) {
    return null;
  }

  const startDate = ranges.reduce(
    (latest, range) => (range.startDate > latest ? range.startDate : latest),
    ranges[0].startDate,
  );
  const endDate = ranges.reduce(
    (earliest, range) => (range.endDate < earliest ? range.endDate : earliest),
    ranges[0].endDate,
  );
  return startDate <= endDate ? { startDate, endDate } : null;
}

function localSourceCoverage(devices, timezone) {
  const totals = intersectCoverage(devices, 'totals');
  return {
    dateBasis: timezone,
    totals,
    breakdown: totals === null ? null : { ...totals },
    sessions: intersectCoverage(devices, 'sessions'),
  };
}

function profileCoverage(candidate) {
  const totals = candidate.coverage.startDate === null
    ? null
    : {
        startDate: candidate.coverage.startDate,
        endDate: candidate.coverage.endDate,
      };
  return {
    dateBasis: candidate.dateBasis,
    totals,
    breakdown: null,
    sessions: null,
  };
}

function profileFingerprint(candidate) {
  return JSON.stringify([
    candidate.deviceId,
    candidate.writerKeyHash,
    candidate.collectedAt,
    candidate.daily.map((day) => [day.date, day.totalTokens]),
    Object.hasOwn(candidate, 'lifetimeTotalTokens') ? candidate.lifetimeTotalTokens : null,
    candidate.coverage.startDate,
    candidate.coverage.endDate,
    candidate.coverage.bucketCount,
  ]);
}

function compareStrings(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareProfiles(left, right) {
  const timeDifference = Date.parse(right.collectedAt) - Date.parse(left.collectedAt);
  if (timeDifference !== 0) {
    return timeDifference;
  }
  const deviceDifference = compareStrings(left.deviceId, right.deviceId);
  if (deviceDifference !== 0) {
    return deviceDifference;
  }
  return compareStrings(profileFingerprint(left), profileFingerprint(right));
}

function hasRetainableProfileData(candidate) {
  return candidate.daily.length > 0 || Object.hasOwn(candidate, 'lifetimeTotalTokens');
}

function validateAndSortDevices(deviceSnapshots, configuredTimezone) {
  const sorted = deviceSnapshots
    .map((snapshot) => validateDeviceSnapshot(snapshot))
    .toSorted((left, right) => compareStrings(left.deviceId, right.deviceId));

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].deviceId === sorted[index].deviceId) {
      fail('DUPLICATE_DEVICE', `$.deviceSnapshots[${index}].deviceId`);
    }
  }

  const timezone = sorted.length > 0
    ? sorted[0].timezone
    : validateIanaTimezone(configuredTimezone ?? 'UTC');
  if (configuredTimezone !== undefined) {
    const validatedTimezone = validateIanaTimezone(configuredTimezone);
    if (validatedTimezone !== timezone) {
      fail('TIMEZONE_MISMATCH', '$.timezone');
    }
  }
  for (const snapshot of sorted) {
    if (snapshot.timezone !== timezone) {
      fail('TIMEZONE_MISMATCH', '$.deviceSnapshots');
    }
  }

  return { sorted, timezone };
}

function selectProfileCandidates(profileCandidates, asOfMs, freshnessMs, futureClockSkewMs) {
  const valid = [];
  let invalidProfileCandidateCount = 0;

  for (const candidate of profileCandidates) {
    try {
      valid.push(validateProfileCandidate(candidate));
    } catch (error) {
      if (!(error instanceof PublicSchemaError)) {
        throw error;
      }
      invalidProfileCandidateCount += 1;
    }
  }

  const selectable = valid.filter((candidate) => {
    const ageMs = asOfMs - Date.parse(candidate.collectedAt);
    return ageMs >= -futureClockSkewMs;
  }).toSorted(compareProfiles);
  const fresh = selectable.filter((candidate) => (
    asOfMs - Date.parse(candidate.collectedAt) <= freshnessMs
  ));
  const selected = fresh[0]
    ?? selectable.find((candidate) => hasRetainableProfileData(candidate))
    ?? null;

  return {
    selected,
    selectedState: selected === null
      ? 'none'
      : fresh.includes(selected)
        ? 'current'
        : 'retained',
    validProfileCandidateCount: valid.length,
    invalidProfileCandidateCount,
    freshProfileCandidateCount: fresh.length,
  };
}

/**
 * Deterministically merges sanitized, public usage snapshots.
 *
 * The newest selectable Codex profile candidate is authoritative for all Codex
 * dates. A stale candidate remains selected as the last known account snapshot
 * instead of allowing a time-based fallback to replace previously published
 * totals. Local Codex records are used only when no retainable profile exists.
 */
export function mergeUsage({
  deviceSnapshots = [],
  profileCandidates = [],
  asOf = new Date(),
  timezone,
  profileFreshnessHours = DEFAULT_PROFILE_FRESHNESS_HOURS,
  deviceStaleHours = DEFAULT_DEVICE_STALE_HOURS,
  futureClockSkewMinutes = DEFAULT_FUTURE_CLOCK_SKEW_MINUTES,
} = {}) {
  assertArray(deviceSnapshots, '$.deviceSnapshots');
  assertArray(profileCandidates, '$.profileCandidates');

  const asOfMs = parseAsOf(asOf);
  const profileFreshnessMs = durationToMilliseconds(
    profileFreshnessHours,
    HOUR_MS,
    '$.profileFreshnessHours',
  );
  const deviceStaleMs = durationToMilliseconds(
    deviceStaleHours,
    HOUR_MS,
    '$.deviceStaleHours',
  );
  const futureClockSkewMs = durationToMilliseconds(
    futureClockSkewMinutes,
    MINUTE_MS,
    '$.futureClockSkewMinutes',
  );

  const { sorted: devices, timezone: mergedTimezone } = validateAndSortDevices(
    deviceSnapshots,
    timezone,
  );
  const profileSelection = selectProfileCandidates(
    profileCandidates,
    asOfMs,
    profileFreshnessMs,
    futureClockSkewMs,
  );
  const selectedProfile = profileSelection.selected;
  const initializedDeviceCount = devices.filter(
    (snapshot) => snapshot.sources.codex.lastSuccessfulAt !== null,
  ).length;

  const localCodexAggregate = aggregateLocalSource(devices);
  const profileByDate = new Map(
    selectedProfile?.daily.map((day) => [day.date, day.totalTokens]) ?? [],
  );

  const dates = new Set();
  if (selectedProfile === null) {
    for (const date of localCodexAggregate.byDate.keys()) {
      dates.add(date);
    }
  } else {
    for (const date of profileByDate.keys()) {
      dates.add(date);
    }
  }

  const days = [...dates].toSorted().map((date) => ({
    date,
    codex: selectedProfile === null
      ? localMetric(localCodexAggregate.byDate.get(date))
      : profileMetric(profileByDate.get(date) ?? 0),
  }));

  const staleDeviceCount = devices.reduce((count, snapshot) => {
    const ageMs = asOfMs - Date.parse(snapshot.generatedAt);
    return count + (ageMs > deviceStaleMs ? 1 : 0);
  }, 0);
  const selectedProfileAgeHours = selectedProfile === null
    ? null
    : Math.max(0, asOfMs - Date.parse(selectedProfile.collectedAt)) / HOUR_MS;
  const codexSource = selectedProfile !== null
    ? 'profile'
    : initializedDeviceCount > 0
      ? 'devices'
      : 'none';
  const codexDataState = selectedProfile !== null
    ? profileSelection.selectedState === 'current'
      ? 'profile-current'
      : 'profile-retained'
    : initializedDeviceCount > 0
      ? 'device-fallback'
      : 'not-updated';

  const codexCoverage = selectedProfile === null
    ? localSourceCoverage(devices, mergedTimezone)
    : profileCoverage(selectedProfile);

  const result = {
    codexSource,
    codexDataState,
    timezone: mergedTimezone,
    days,
    coverage: {
      codex: codexCoverage,
    },
    diagnostics: {
      deviceCount: devices.length,
      staleDeviceCount,
      profileCandidateCount: profileCandidates.length,
      validProfileCandidateCount: profileSelection.validProfileCandidateCount,
      invalidProfileCandidateCount: profileSelection.invalidProfileCandidateCount,
      freshProfileCandidateCount: profileSelection.freshProfileCandidateCount,
      selectedProfileState: profileSelection.selectedState,
      selectedProfileAgeHours,
      selectedProfileCollectedAt: selectedProfile?.collectedAt ?? null,
      selectedProfileCoverage: selectedProfile === null
        ? null
        : { ...selectedProfile.coverage },
      codexLifetimeCoverage:
        selectedProfile !== null && Object.hasOwn(selectedProfile, 'lifetimeTotalTokens')
          ? 'provider-reported'
          : 'unavailable',
      dateBasis: {
        codex: codexCoverage.dateBasis,
        profileDatesPreserved: selectedProfile !== null,
      },
      breakdownCoverage: {
        codex: selectedProfile === null
          ? {
              tokens: localCodexAggregate.dayRecordCount === 0 ? 'none' : 'complete',
              sessions: sessionCoverage(localCodexAggregate),
            }
          : {
              tokens: selectedProfile.daily.length === 0 ? 'none' : 'unavailable',
              sessions: selectedProfile.daily.length === 0 ? 'none' : 'unavailable',
            },
      },
    },
  };

  if (selectedProfile !== null && Object.hasOwn(selectedProfile, 'lifetimeTotalTokens')) {
    result.codexLifetimeTotalTokens = selectedProfile.lifetimeTotalTokens;
  }

  return result;
}
