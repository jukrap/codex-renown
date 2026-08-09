import { PUBLIC_HANDLE } from '../product.mjs';
import { renderContainedPrestige } from './prestige.mjs';
import {
  cardDocument,
  coverageLabel,
  escapeXml,
  metricText,
} from './svg.mjs';

const WEEKDAY_LABELS = Object.freeze(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
const STAT_X = Object.freeze([16, 112, 208, 304]);

function metricBlock(label, metric, x, detail = '') {
  const status = metric.coverage === 'complete' ? detail : coverageLabel(metric.coverage);
  return [
    `<text class="label" x="${x}" y="145">${escapeXml(label)}</text>`,
    `<text class="value" x="${x}" y="166">${escapeXml(metricText(metric))}</text>`,
    ...(status
      ? [`<text class="meta" x="${x}" y="180">${escapeXml(status)}</text>`]
      : []),
  ].join('\n');
}

export function renderActivity(statistics, {
  theme = 'github',
  identity = PUBLIC_HANDLE,
} = {}) {
  if (!Array.isArray(statistics.heatmap.cells) || statistics.heatmap.cells.length !== 371) {
    throw new TypeError('activity heatmap must contain exactly 371 cells');
  }

  const cellSize = 5;
  const gap = 2;
  const originX = 31;
  const originY = 55;
  const cells = statistics.heatmap.cells.map((cell, index) => {
    const week = Math.floor(index / 7);
    const weekday = index % 7;
    const x = originX + week * (cellSize + gap);
    const y = originY + weekday * (cellSize + gap);
    const state = ['active', 'zero', 'unknown', 'future'].includes(cell.state)
      ? cell.state
      : 'unknown';
    const level = Number.isInteger(cell.level) && cell.level >= 0 && cell.level <= 4
      ? cell.level
      : 0;
    const coverage = ['complete', 'partial'].includes(cell.coverage)
      ? cell.coverage
      : 'unknown';
    return `<rect class="heat-cell state-${state} level-${level} coverage-${coverage}" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="1"/>`;
  });
  const weekdayLabels = WEEKDAY_LABELS.map((label, index) => (
    `<text class="meta" x="25" y="${originY + index * (cellSize + gap) + 5}" text-anchor="end">${label}</text>`
  ));
  const empty = statistics.heatmap.cells.every((cell) => cell.state !== 'active');
  const hasPartial = statistics.heatmap.cells.some((cell) => cell.coverage === 'partial');
  const statusLine = statistics.codexDataState === 'not-updated'
    ? 'ACTIVITY · Awaiting first sync'
    : `ACTIVITY · 53 weeks through ${statistics.asOf}${empty ? ' · No observed usage yet' : hasPartial ? ' · partial coverage' : ' · Monday start'}`;
  const peakMetric = {
    value: statistics.activity.peak.totalTokens,
    coverage: statistics.activity.peak.coverage,
    lowerBound: statistics.activity.peak.lowerBound,
  };
  const peakDate = statistics.activity.peak.date === null
    ? ''
    : statistics.activity.peak.date.slice(5);

  const body = [
    renderContainedPrestige({ width: 416, height: 190 }),
    `<text class="heading" x="16" y="27">CODEX RENOWN · ${escapeXml(identity)}</text>`,
    `<text class="subheading" x="16" y="43">${escapeXml(statusLine)}</text>`,
    ...weekdayLabels,
    ...cells,
    `<text class="meta" x="31" y="117">${escapeXml(statistics.heatmap.startDate)}</text>`,
    `<text class="meta" x="400" y="117" text-anchor="end">${escapeXml(statistics.heatmap.endDate)}</text>`,
    '<line class="divider" x1="16" y1="127" x2="400" y2="127"/>',
    metricBlock('ACTIVE DAYS', statistics.activity.activeDays, STAT_X[0]),
    metricBlock('CURRENT STREAK', statistics.activity.currentStreak, STAT_X[1]),
    metricBlock('LONGEST STREAK', statistics.activity.longestStreak, STAT_X[2]),
    metricBlock('PEAK', peakMetric, STAT_X[3], peakDate),
  ].join('\n');

  return cardDocument({
    id: 'codex-renown-activity',
    width: 416,
    height: 190,
    theme,
    title: `Codex Renown activity for ${identity}`,
    description: `A 53 by 7 Codex activity heatmap with active days, streaks, and peak usage through ${statistics.asOf}. Unknown days are outlined and partial observations are dashed.`,
    body,
  });
}
