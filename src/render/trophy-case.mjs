import { ACHIEVEMENT_CATEGORIES } from '../domain/achievements.mjs';
import { PUBLIC_HANDLE } from '../product.mjs';
import { renderAchievementIcon } from './icons.mjs';
import { renderContainedPrestige } from './prestige.mjs';
import {
  cardDocument,
  escapeXml,
  formatCompactNumber,
} from './svg.mjs';

const CATEGORY_LABELS = Object.freeze({
  renown: 'RENOWN',
  momentum: 'MOMENTUM',
  consistency: 'CONSISTENCY',
  journey: 'JOURNEY',
});
const CATEGORY_X = Object.freeze([16, 220, 424, 628]);

function targetText(entry) {
  if (entry.category === 'consistency' || entry.category === 'journey') {
    return `${entry.target} DAYS`;
  }
  return `${formatCompactNumber(entry.target)} TOKENS`;
}

function badge(entry, x, y) {
  const stateLabel = entry.state.toUpperCase();
  return [
    `<rect class="achievement-badge seal-${entry.state} achievement-${entry.state}" x="${x}" y="${y}" width="190" height="38" rx="6"/>`,
    `<g class="achievement-state-${entry.state}">${renderAchievementIcon(entry.iconId, { x: x + 9, y: y + 7, size: 24 })}</g>`,
    `<text class="small-value" x="${x + 42}" y="${y + 16}">${escapeXml(entry.label)}</text>`,
    `<text class="meta" x="${x + 42}" y="${y + 30}">${escapeXml(stateLabel)} · ${escapeXml(targetText(entry))}</text>`,
  ].join('\n');
}

export function renderTrophyCase(statistics, {
  theme = 'github',
  identity = PUBLIC_HANDLE,
} = {}) {
  if (!Array.isArray(statistics.achievements) || statistics.achievements.length !== 16) {
    throw new TypeError('trophy case requires all 16 achievements');
  }
  const notUpdated = statistics.codexDataState === 'not-updated';
  const body = [
    renderContainedPrestige({ width: 846, height: 276 }),
    `<text class="heading" x="16" y="27">CODEX RENOWN · ${escapeXml(identity)}</text>`,
    `<text class="subheading" x="16" y="44">TROPHY CASE · ${notUpdated ? 'Awaiting first sync' : 'personal usage milestones'}</text>`,
    `<text class="meta" x="830" y="27" text-anchor="end">${notUpdated ? 'Not updated yet' : `Updated ${escapeXml(statistics.asOf)}`}</text>`,
    '<line class="divider" x1="16" y1="54" x2="830" y2="54"/>',
    ...ACHIEVEMENT_CATEGORIES.flatMap((category, categoryIndex) => {
      const x = CATEGORY_X[categoryIndex];
      const entries = statistics.achievements.filter((entry) => entry.category === category);
      return [
        `<text class="label" x="${x}" y="72">${CATEGORY_LABELS[category]}</text>`,
        ...entries.map((entry, entryIndex) => badge(entry, x, 80 + (entryIndex * 44))),
      ];
    }),
    '<text class="meta" x="830" y="265" text-anchor="end">◆ unlocked · ◇ locked · dashed unknown</text>',
  ].join('\n');

  return cardDocument({
    id: 'codex-renown-trophy-case',
    width: 846,
    height: 276,
    theme,
    title: `Codex Renown trophy case for ${identity}`,
    description: `Sixteen personal Codex usage milestones across renown, momentum, consistency, and journey as of ${statistics.asOf}. Locked and unknown achievements remain visibly distinct without relying on color.`,
    body,
  });
}
