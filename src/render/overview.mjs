import { PUBLIC_HANDLE } from '../product.mjs';
import { renderCrest, renderUnrankedCrest } from './crest.mjs';
import { renderContainedPrestige } from './prestige.mjs';
import {
  cardDocument,
  escapeXml,
  formatCompactNumber,
  formatExactNumber,
  formatExpandedNumber,
  metricText,
} from './svg.mjs';

const METRICS = Object.freeze([
  { label: 'TODAY SO FAR', value: (statistics) => statistics.periods.today.current.totalTokens },
  { label: 'LAST 7 DAYS', value: (statistics) => statistics.periods.rolling7.current.totalTokens },
  { label: 'LAST 30 DAYS', value: (statistics) => statistics.periods.rolling30.current.totalTokens },
  { label: 'ACTIVE DAYS', value: (statistics) => statistics.activity.activeDays },
]);
const METRIC_X = Object.freeze([16, 220, 424, 628]);
const RANK_TITLE_MAX_WIDTH = 202;

function estimatedRankTitleWidth(value) {
  const units = [...value].reduce((total, character) => {
    if (character === ' ') return total + 0.32;
    if ('MW@%'.includes(character)) return total + 0.82;
    if ('I1il.,:;!|·'.includes(character)) return total + 0.32;
    return total + 0.62;
  }, 0);
  return (units * 22 * 1.06) + (Math.max(0, value.length - 1) * 0.4);
}

function fittedRankTitleAttributes(value) {
  return estimatedRankTitleWidth(value) <= RANK_TITLE_MAX_WIDTH
    ? ''
    : ` textLength="${RANK_TITLE_MAX_WIDTH}" lengthAdjust="spacingAndGlyphs"`;
}

function rankPresentation(rank, dataState) {
  if (dataState === 'not-updated') {
    return {
      title: 'NO RANK YET',
      progress: 0,
      progressText: 'Available after first sync',
    };
  }
  if (rank.status === 'unranked') {
    return {
      title: 'UNRANKED',
      progress: 0,
      progressText: 'Lifetime total required to unlock ranks',
    };
  }
  const current = rank.current;
  if (rank.maxRank) {
    return {
      title: `${current.roman} · ${current.title.toUpperCase()}`,
      progress: 100,
      progressText: 'MAX RANK · 1T milestone reached',
    };
  }
  return {
    title: `${current.roman} · ${current.title.toUpperCase()}`,
    progress: rank.progressPercentage,
    progressText: `${rank.lowerBound ? '≥' : ''}${Math.round(rank.progressPercentage)}% to Rank ${rank.next.roman} · ${rank.next.title.toUpperCase()} · ${formatCompactNumber(rank.next.threshold)}`,
  };
}

function metricColumn(statistics, definition, x) {
  return [
    `<text class="label" x="${x}" y="174">${escapeXml(definition.label)}</text>`,
    `<text class="value" x="${x}" y="199">${escapeXml(metricText(definition.value(statistics)))}</text>`,
  ].join('\n');
}

export function renderOverview(statistics, {
  staleDeviceCount = 0,
  retainedProfileCollectedAt = null,
  theme = 'github',
  identity = PUBLIC_HANDLE,
} = {}) {
  const lifetime = statistics.lifetime.totalTokens;
  const notUpdated = statistics.codexDataState === 'not-updated';
  const rank = rankPresentation(statistics.rank, statistics.codexDataState);
  const headline = notUpdated
    ? 'NO USAGE SNAPSHOT YET'
    : lifetime.value === null
      ? '— TOKENS PROCESSED'
      : `${metricText(lifetime)} TOKENS PROCESSED`;
  const exactLine = notUpdated
    ? 'Run setup and sync to publish your first snapshot'
    : lifetime.value === null
      ? 'Lifetime total unavailable'
      : `${lifetime.coverage === 'partial' ? 'At least ' : ''}${formatExpandedNumber(lifetime.value)} · ${lifetime.coverage === 'partial' ? '≥' : ''}${formatExactNumber(lifetime.value)} ${statistics.lifetime.provenance === 'provider-reported' ? 'account total' : 'tracked tokens'}`;
  const sourceLabel = {
    'not-updated': 'NOT UPDATED YET',
    'device-fallback': 'DEVICE FALLBACK',
    'profile-current': 'ACCOUNT-WIDE CODEX',
    'profile-retained': 'ACCOUNT SNAPSHOT',
  }[statistics.codexDataState] ?? 'DEVICE FALLBACK';
  const retainedDate = typeof retainedProfileCollectedAt === 'string'
    ? retainedProfileCollectedAt.slice(0, 10)
    : null;
  const sourceMeta = statistics.codexDataState === 'profile-retained'
    ? retainedDate === null
      ? 'Previous update retained'
      : `Last updated ${retainedDate}`
    : notUpdated
      ? 'Awaiting first sync'
      : staleDeviceCount > 0
        ? staleDeviceCount === 1
          ? '1 stale device'
          : `${staleDeviceCount} stale devices`
        : null;
  const progressWidth = Math.round((rank.progress / 100) * 196 * 100) / 100;
  const rankTitleFit = fittedRankTitleAttributes(rank.title);
  const crest = statistics.rank.status === 'ranked'
    ? renderCrest(statistics.rank.current.rank, { x: 750, y: 64, size: 72 })
    : renderUnrankedCrest({ x: 750, y: 64, size: 72 });

  const body = [
    renderContainedPrestige({ width: 846, height: 210 }),
    `<text class="heading" x="16" y="27">CODEX RENOWN · ${escapeXml(identity)}</text>`,
    `<text class="subheading" x="16" y="44">As of ${escapeXml(statistics.asOf)} · ${escapeXml(statistics.calendarLabel)} · Your Codex usage, told through milestones.</text>`,
    `<text class="label" x="830" y="27" text-anchor="end">${sourceLabel}</text>`,
    ...(sourceMeta === null
      ? []
      : [`<text class="meta" x="830" y="44" text-anchor="end">${escapeXml(sourceMeta)}</text>`]),
    '<line class="divider" x1="16" y1="54" x2="830" y2="54"/>',
    '<text class="label" x="16" y="72">ALL-TIME CODEX USAGE</text>',
    `<text class="hero" x="16" y="111">${escapeXml(headline)}</text>`,
    `<text class="exact" x="16" y="132">${escapeXml(exactLine)}</text>`,
    '<line class="divider" x1="510" y1="64" x2="510" y2="145"/>',
    '<text class="label" x="532" y="72">TOKEN RENOWN</text>',
    `<text class="rank-title" x="532" y="101"${rankTitleFit}>${escapeXml(rank.title)}</text>`,
    '<rect class="progress-track" x="532" y="115" width="196" height="8" rx="4"/>',
    ...(progressWidth > 0
      ? [`<rect class="progress-fill" x="532" y="115" width="${progressWidth}" height="8" rx="4"/>`]
      : []),
    `<text class="meta" x="532" y="140">${escapeXml(rank.progressText)}</text>`,
    crest,
    '<line class="divider" x1="16" y1="156" x2="830" y2="156"/>',
    '<line class="divider" x1="204" y1="166" x2="204" y2="200"/>',
    '<line class="divider" x1="408" y1="166" x2="408" y2="200"/>',
    '<line class="divider" x1="612" y1="166" x2="612" y2="200"/>',
    ...METRICS.map((definition, index) => metricColumn(statistics, definition, METRIC_X[index])),
  ].join('\n');

  return cardDocument({
    id: 'codex-renown-overview',
    width: 846,
    height: 210,
    theme,
    title: `Codex Renown profile for ${identity}`,
    description: `All-time Codex tokens, lifetime rank crest, next-rank progress, and recent account activity as of ${statistics.asOf}.`,
    body,
  });
}