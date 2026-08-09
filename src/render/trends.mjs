import { PUBLIC_HANDLE } from '../product.mjs';
import { renderContainedPrestige } from './prestige.mjs';
import {
  cardDocument,
  escapeXml,
  formatCompactNumber,
} from './svg.mjs';

function metricState(metric) {
  if (metric?.value === null || metric?.value === undefined) {
    return 'unknown';
  }
  if (metric.coverage === 'partial') {
    return 'partial';
  }
  return metric.value === 0 ? 'zero' : 'active';
}

function chart(statistics, name, label, y) {
  const buckets = statistics.trends[name];
  const knownValues = buckets
    .map((bucket) => bucket.totalTokens.value)
    .filter((value) => value !== null);
  const maximum = Math.max(0, ...knownValues);
  const hasPartial = buckets.some((bucket) => bucket.totalTokens.coverage === 'partial');
  const plotX = 118;
  const plotWidth = 282;
  const plotHeight = 25;
  const baseline = y + 29;
  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(2, Math.floor(slot - 2));
  const bars = buckets.map((bucket, index) => {
    const metric = bucket.totalTokens;
    const state = metricState(metric);
    const height = state === 'unknown'
      ? 7
      : metric.value === 0 || maximum === 0
        ? 1
        : Math.max(2, Math.round((metric.value / maximum) * plotHeight));
    const x = Math.round((plotX + index * slot) * 100) / 100;
    return `<rect class="trend-bar state-${state}" x="${x}" y="${baseline - height}" width="${barWidth}" height="${height}" rx="1"/>`;
  });
  const peak = knownValues.length === 0 ? '—' : formatCompactNumber(maximum);
  const qualifier = hasPartial ? '≥' : '';

  return [
    `<text class="label" x="16" y="${y + 11}">${escapeXml(label)}</text>`,
    `<text class="meta" x="16" y="${y + 25}">Peak ${qualifier}${escapeXml(peak)}</text>`,
    `<line class="divider" x1="${plotX}" y1="${baseline}" x2="400" y2="${baseline}"/>`,
    ...bars,
  ].join('\n');
}

export function renderTrends(statistics, {
  theme = 'github',
  identity = PUBLIC_HANDLE,
} = {}) {
  const allBuckets = [
    ...statistics.trends.daily,
    ...statistics.trends.weekly,
    ...statistics.trends.monthly,
  ];
  const empty = allBuckets.every((bucket) => bucket.totalTokens.value === null);
  const statusLine = statistics.codexDataState === 'not-updated'
    ? 'USAGE TRENDS · Awaiting first sync'
    : `USAGE TRENDS · ${statistics.asOf} · ${statistics.calendarLabel}${empty ? ' · No observed usage yet' : ''}`;
  const body = [
    renderContainedPrestige({ width: 416, height: 190 }),
    `<text class="heading" x="16" y="27">CODEX RENOWN · ${escapeXml(identity)}</text>`,
    `<text class="subheading" x="16" y="43">${escapeXml(statusLine)}</text>`,
    '<text class="meta" x="400" y="43" text-anchor="end">≥ partial · dashed unknown</text>',
    chart(statistics, 'daily', '30 DAYS', 55),
    '<line class="divider" x1="16" y1="92" x2="400" y2="92"/>',
    chart(statistics, 'weekly', '12 WEEKS', 98),
    '<line class="divider" x1="16" y1="135" x2="400" y2="135"/>',
    chart(statistics, 'monthly', '12 MONTHS', 141),
    '<text class="meta" x="400" y="184" text-anchor="end">Monday weeks · calendar months</text>',
  ].join('\n');

  return cardDocument({
    id: 'codex-renown-trends',
    width: 416,
    height: 190,
    theme,
    title: `Codex Renown usage trends for ${identity}`,
    description: `Daily, weekly, and monthly Codex token charts as of ${statistics.asOf}. Partial bars are dashed and unknown bars are outlines.`,
    body,
  });
}
