import { PUBLIC_HANDLE } from '../product.mjs';
import { renderCrest, renderUnrankedCrest } from './crest.mjs';
import { renderContainedPrestige } from './prestige.mjs';
import {
  cardDocument,
  escapeXml,
  formatCompactNumber,
  metricText,
} from './svg.mjs';

function presentation(rank, dataState) {
  if (dataState === 'not-updated') {
    return { title: 'NOT UPDATED YET', progress: 0, progressText: 'Run first sync' };
  }
  if (rank.status === 'unranked') {
    return { title: 'UNRANKED', progress: 0, progressText: 'Lifetime total required' };
  }
  if (rank.maxRank) {
    return {
      title: `RANK ${rank.current.roman} · ${rank.current.title.toUpperCase()}`,
      progress: 100,
      progressText: 'MAX RANK',
    };
  }
  return {
    title: `RANK ${rank.current.roman} · ${rank.current.title.toUpperCase()}`,
    progress: rank.progressPercentage,
    progressText: `${rank.lowerBound ? '≥' : ''}${Math.round(rank.progressPercentage)}% to ${rank.next.title.toUpperCase()} · ${formatCompactNumber(rank.next.threshold)}`,
  };
}

export function renderCompact(statistics, {
  theme = 'github',
  identity = PUBLIC_HANDLE,
} = {}) {
  const rank = presentation(statistics.rank, statistics.codexDataState);
  const progressWidth = Math.round((rank.progress / 100) * 312 * 100) / 100;
  const crest = statistics.rank.status === 'ranked'
    ? renderCrest(statistics.rank.current.rank, { x: 12, y: 12, size: 64 })
    : renderUnrankedCrest({ x: 12, y: 12, size: 64 });
  const body = [
    renderContainedPrestige({ width: 416, height: 96, inset: 6, length: 14 }),
    crest,
    `<text class="label" x="88" y="20">CODEX RENOWN · ${escapeXml(identity)}</text>`,
    `<text class="small-value" x="88" y="39">${escapeXml(rank.title)}</text>`,
    `<text class="rank-title" x="88" y="63">${escapeXml(metricText(statistics.lifetime.totalTokens))} TOKENS</text>`,
    '<rect class="progress-track" x="88" y="70" width="312" height="6" rx="3"/>',
    ...(progressWidth > 0
      ? [`<rect class="progress-fill" x="88" y="70" width="${progressWidth}" height="6" rx="3"/>`]
      : []),
    `<text class="meta" x="88" y="88">${escapeXml(rank.progressText)}</text>`,
    `<text class="meta" x="400" y="88" text-anchor="end">${escapeXml(statistics.asOf)}</text>`,
  ].join('\n');

  return cardDocument({
    id: 'codex-renown-compact',
    width: 416,
    height: 96,
    theme,
    title: `Codex Renown compact badge for ${identity}`,
    description: `Compact lifetime token total, rank crest, and next-rank progress as of ${statistics.asOf}.`,
    body,
  });
}