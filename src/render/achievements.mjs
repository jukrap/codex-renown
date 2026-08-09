import { TOKEN_RANKS } from '../domain/rank.mjs';
import { PUBLIC_HANDLE } from '../product.mjs';
import { renderCrest, renderUnrankedCrest } from './crest.mjs';
import { renderAchievementIcon } from './icons.mjs';
import { renderContainedPrestige } from './prestige.mjs';
import {
  cardDocument,
  escapeXml,
  formatCompactNumber,
} from './svg.mjs';

const BADGE_ROW_X = 16;
const BADGE_ROW_WIDTH = 384;
const BADGE_GAP = 6;
const BADGE_MIN_WIDTH = 78;
const BADGE_TEXT_OFFSET = 27;
const BADGE_RIGHT_PADDING = 7;
const BADGE_LABEL_SIZE = 7;
const BADGE_META_SIZE = 6.5;

function roundLayout(value) {
  return Math.round(value * 100) / 100;
}

function characterWidth(character) {
  if (character === ' ') return 0.32;
  if ('MW@%'.includes(character)) return 0.82;
  if ('I1il.,:;!|'.includes(character)) return 0.32;
  if (character === '-') return 0.4;
  return 0.56;
}

function estimatedTextWidth(value, fontSize, { bold = false } = {}) {
  const units = [...value].reduce((total, character) => total + characterWidth(character), 0);
  return roundLayout(units * fontSize * (bold ? 1.04 : 1));
}

function fittedTextAttributes(value, maxWidth, fontSize, options) {
  if (estimatedTextWidth(value, fontSize, options) <= maxWidth) {
    return '';
  }
  return ` textLength="${roundLayout(maxWidth)}" lengthAdjust="spacingAndGlyphs"`;
}

function representativeBadgeWidth(entry) {
  const meta = `${entry.state === 'unlocked' ? '◆' : entry.state === 'locked' ? '◇' : '—'} ${entry.category.toUpperCase()}`;
  const contentWidth = Math.max(
    estimatedTextWidth(entry.label, BADGE_LABEL_SIZE, { bold: true }),
    estimatedTextWidth(meta, BADGE_META_SIZE),
  );
  return Math.max(
    BADGE_MIN_WIDTH,
    Math.ceil(BADGE_TEXT_OFFSET + contentWidth + BADGE_RIGHT_PADDING),
  );
}

function representativeBadgeLayouts(entries) {
  const contentWidth = BADGE_ROW_WIDTH - (BADGE_GAP * (entries.length - 1));
  const preferred = entries.map(representativeBadgeWidth);
  const preferredTotal = preferred.reduce((total, width) => total + width, 0);
  const minimumTotal = BADGE_MIN_WIDTH * entries.length;
  const widths = preferredTotal <= contentWidth
    ? preferred.map((width) => width + ((contentWidth - preferredTotal) / entries.length))
    : (() => {
      const availableGrowth = contentWidth - minimumTotal;
      const requestedGrowth = preferred
        .map((width) => width - BADGE_MIN_WIDTH)
        .reduce((total, width) => total + width, 0);
      return preferred.map((width) => (
        BADGE_MIN_WIDTH + (((width - BADGE_MIN_WIDTH) / requestedGrowth) * availableGrowth)
      ));
    })();

  let x = BADGE_ROW_X;
  return widths.map((width, index) => {
    const roundedWidth = index === widths.length - 1
      ? roundLayout((BADGE_ROW_X + BADGE_ROW_WIDTH) - x)
      : roundLayout(width);
    const layout = Object.freeze({ x: roundLayout(x), width: roundedWidth });
    x += roundedWidth + BADGE_GAP;
    return layout;
  });
}

function presentation(rank, dataState) {
  if (dataState === 'not-updated') {
    return {
      roman: '—', title: 'NOT UPDATED YET', currentRank: 0, progress: 0,
      progressText: 'Run first sync to unlock ranks',
    };
  }
  if (rank.status === 'unranked') {
    return {
      roman: '—', title: 'UNRANKED', currentRank: 0, progress: 0,
      progressText: 'Lifetime total required',
    };
  }
  if (rank.maxRank) {
    return {
      roman: rank.current.roman,
      title: rank.current.title.toUpperCase(),
      currentRank: rank.current.rank,
      progress: 100,
      progressText: 'MAX RANK',
    };
  }
  return {
    roman: rank.current.roman,
    title: rank.current.title.toUpperCase(),
    currentRank: rank.current.rank,
    progress: rank.progressPercentage,
    progressText: `${rank.lowerBound ? '≥' : ''}${Math.round(rank.progressPercentage)}% to ${rank.next.title.toUpperCase()} · ${formatCompactNumber(rank.next.threshold)}`,
  };
}

function rankNodes(currentRank) {
  const slot = 302 / TOKEN_RANKS.length;
  return TOKEN_RANKS.map(({ rank }, index) => {
    const x = Math.round((98 + index * slot + 3) * 100) / 100;
    const className = rank === currentRank
      ? 'rank-node-current'
      : rank < currentRank
        ? 'rank-node-unlocked'
        : 'rank-node';
    return `<rect class="${className}" x="${x}" y="119" width="8" height="8" rx="2"/>`;
  });
}

function representativeBadge(entry, { x, width }) {
  const stateClass = `seal-${entry.state}`;
  const marker = entry.state === 'unlocked' ? '◆' : entry.state === 'locked' ? '◇' : '—';
  const meta = `${marker} ${entry.category.toUpperCase()}`;
  const textWidth = width - BADGE_TEXT_OFFSET - BADGE_RIGHT_PADDING;
  const labelFit = fittedTextAttributes(
    entry.label,
    textWidth,
    BADGE_LABEL_SIZE,
    { bold: true },
  );
  const metaFit = fittedTextAttributes(meta, textWidth, BADGE_META_SIZE);
  return [
    `<rect class="representative-badge ${stateClass}" x="${x}" y="146" width="${width}" height="36" rx="5"/>`,
    `<g class="achievement-state-${entry.state}">${renderAchievementIcon(entry.iconId, { x: x + 5, y: 155, size: 18 })}</g>`,
    `<text class="badge-label" x="${x + BADGE_TEXT_OFFSET}" y="160"${labelFit}>${escapeXml(entry.label)}</text>`,
    `<text class="badge-meta" x="${x + BADGE_TEXT_OFFSET}" y="174" fill="var(--muted)" font-family="system-ui,sans-serif" font-size="6.5" letter-spacing=".1"${metaFit}>${escapeXml(meta)}</text>`,
  ].join('\n');
}

export function renderAchievements(statistics, {
  theme = 'github',
  identity = PUBLIC_HANDLE,
} = {}) {
  if (!Array.isArray(statistics.achievementRepresentatives)
    || statistics.achievementRepresentatives.length !== 4) {
    throw new TypeError('rank achievements require four representatives');
  }
  const rank = presentation(statistics.rank, statistics.codexDataState);
  const progressWidth = Math.round((rank.progress / 100) * 302 * 100) / 100;
  const crest = statistics.rank.status === 'ranked'
    ? renderCrest(statistics.rank.current.rank, { x: 16, y: 55, size: 64 })
    : renderUnrankedCrest({ x: 16, y: 55, size: 64 });
  const badgeLayouts = representativeBadgeLayouts(statistics.achievementRepresentatives);
  const body = [
    renderContainedPrestige({ width: 416, height: 190 }),
    `<text class="heading" x="16" y="27">CODEX RENOWN · ${escapeXml(identity)}</text>`,
    `<text class="subheading" x="16" y="43">RANK ACHIEVEMENTS · ${statistics.codexDataState === 'not-updated' ? 'Awaiting first sync' : `${statistics.rank.unlockedCount} / 20 ranks unlocked`}</text>`,
    crest,
    '<text class="label" x="98" y="63">CURRENT TOKEN RANK</text>',
    `<text class="value" x="98" y="87">RANK ${escapeXml(rank.roman)} · ${escapeXml(rank.title)}</text>`,
    '<rect class="progress-track" x="98" y="98" width="302" height="8" rx="4"/>',
    ...(progressWidth > 0
      ? [`<rect class="progress-fill" x="98" y="98" width="${progressWidth}" height="8" rx="4"/>`]
      : []),
    `<text class="meta" x="98" y="116">${escapeXml(rank.progressText)}</text>`,
    ...rankNodes(rank.currentRank),
    '<line class="divider" x1="16" y1="138" x2="400" y2="138"/>',
    ...statistics.achievementRepresentatives.map((entry, index) => (
      representativeBadge(entry, badgeLayouts[index])
    )),
  ].join('\n');

  return cardDocument({
    id: 'codex-renown-achievements',
    width: 416,
    height: 190,
    theme,
    title: `Codex Renown rank achievements for ${identity}`,
    description: `Current crest, twenty-rank lifetime ladder, and four representative personal milestones as of ${statistics.asOf}.`,
    body,
  });
}
