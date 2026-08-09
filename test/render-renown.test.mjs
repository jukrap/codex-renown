import assert from 'node:assert/strict';
import test from 'node:test';

import { CARD_NAMES, CARD_VIEW_BOXES } from '../src/card-catalog.mjs';
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_CATEGORIES } from '../src/domain/achievements.mjs';
import { eachDay } from '../src/domain/calendar.mjs';
import { computeStatistics } from '../src/domain/statistics.mjs';
import { PUBLIC_HANDLE } from '../src/product.mjs';
import { renderAchievements } from '../src/render/achievements.mjs';
import { renderActivity } from '../src/render/activity.mjs';
import { renderCompact } from '../src/render/compact.mjs';
import { renderOverview } from '../src/render/overview.mjs';
import { renderRecords } from '../src/render/records.mjs';
import { renderTrends } from '../src/render/trends.mjs';
import { renderTrophyCase } from '../src/render/trophy-case.mjs';
import { validateSvgDocument } from '../src/render/svg-validator.mjs';

const AS_OF = '2026-07-21';

function statisticsFixture() {
  const dates = eachDay('2026-01-01', AS_OF);
  const days = dates
    .filter((_, index) => (index + 1) % 40 !== 0)
    .map((date, index) => ({
      date,
      codex: {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        total: index < 7 ? 900_000_000 : 100_000_000,
        sessions: null,
      },
    }));
  return computeStatistics({
    timezone: 'UTC',
    codexSource: 'profile',
    days,
    coverage: {
      codex: {
        dateBasis: 'provider-calendar-date',
        totals: { startDate: dates[0], endDate: dates.at(-1) },
        breakdown: null,
        sessions: null,
      },
    },
    codexLifetimeTotalTokens: 19_300_000_000,
  }, { asOf: AS_OF });
}

function renderAll(statistics = statisticsFixture(), options = {}) {
  return {
    overview: renderOverview(statistics, options),
    achievements: renderAchievements(statistics, options),
    'trophy-case': renderTrophyCase(statistics, options),
    records: renderRecords(statistics, options),
    trends: renderTrends(statistics, options),
    activity: renderActivity(statistics, options),
    compact: renderCompact(statistics, options),
  };
}

test('seven cards use approved canvases, identity anchors, and safe deterministic SVG', () => {
  const cards = renderAll();
  assert.deepEqual(Object.keys(cards), CARD_NAMES);
  for (const name of CARD_NAMES) {
    const svg = cards[name];
    assert.equal(svg, renderAll()[name]);
    assert.equal(validateSvgDocument(svg, { filePath: `${name}.svg` }), true);
    assert.match(svg, new RegExp(`viewBox="${CARD_VIEW_BOXES[name]}"`, 'u'));
    assert.match(svg, /CODEX RENOWN/);
    assert.match(svg, new RegExp(PUBLIC_HANDLE, 'u'));
    assert.match(svg, /contained-prestige/);
  }
});

test('device fallback keeps the rank title concise while preserving lower-bound marks', () => {
  const statistics = computeStatistics({
    timezone: 'UTC',
    codexSource: 'devices',
    codexDataState: 'device-fallback',
    days: [{
      date: '2026-07-20',
      codex: {
        input: 0,
        output: 0,
        cacheRead: 8_700_000_000,
        cacheWrite: 0,
        total: 8_700_000_000,
        sessions: 1,
      },
    }],
    coverage: {
      codex: {
        dateBasis: 'UTC',
        totals: { startDate: '2026-07-20', endDate: '2026-07-20' },
        breakdown: { startDate: '2026-07-20', endDate: '2026-07-20' },
        sessions: { startDate: '2026-07-20', endDate: '2026-07-20' },
      },
    },
  }, { asOf: AS_OF });
  const overview = renderOverview(statistics);

  assert.match(overview, /XIV · PARAGON/);
  assert.doesNotMatch(overview, /AT LEAST RANK|RANK XIV/);
  assert.doesNotMatch(overview, /textLength="202"/);
  assert.match(overview, /≥74% to Rank XV · MYTHIC · 10B/);
});

test('overview and compact make lifetime renown and the current crest unmistakable', () => {
  const { overview, compact } = renderAll();
  for (const svg of [overview, compact]) {
    assert.match(svg, /19\.3B TOKENS/);
    assert.match(svg, /MYTHIC/);
    assert.match(svg, /crest-frame-epic/);
    assert.equal((svg.match(/class="crest-pip"/gu) ?? []).length, 3);
  }
  assert.match(overview, /XV · MYTHIC/);
  assert.doesNotMatch(overview, /RANK XV/);
  assert.match(compact, /RANK XV/);
  assert.match(overview, /19,300,000,000 account total/);
  assert.match(overview, /62% to Rank XVI · ASCENDANT · 25B/);
});

test('rank achievements show four representatives and the full twenty-node ladder', () => {
  const achievements = renderAll().achievements;
  assert.equal((achievements.match(/class="rank-node/g) ?? []).length, 20);
  assert.equal((achievements.match(/class="representative-badge /g) ?? []).length, 4);
  for (const label of [
    'Mythic Realm',
    'Seven-Day Siege',
    'Monthbound',
    'Active Centurion',
  ]) {
    assert.match(achievements, new RegExp(label, 'u'));
  }
});

test('representative achievement badges reserve padding for current and longest labels', () => {
  const current = renderAll().achievements;
  const currentBadges = [...current.matchAll(
    /<rect class="representative-badge [^"]+" x="([0-9.]+)" y="146" width="([0-9.]+)" height="36"/gu,
  )].map((match) => ({ x: Number(match[1]), width: Number(match[2]) }));

  assert.equal(currentBadges.length, 4);
  assert.equal(currentBadges[0].x, 16);
  assert.equal(new Set(currentBadges.map(({ width }) => width)).size > 1, true);
  for (let index = 1; index < currentBadges.length; index += 1) {
    const previous = currentBadges[index - 1];
    assert.equal(
      Math.round((currentBadges[index].x - previous.x - previous.width) * 100) / 100,
      6,
    );
  }
  assert.equal(
    Math.round((currentBadges.at(-1).x + currentBadges.at(-1).width) * 100) / 100,
    400,
  );
  assert.match(
    current,
    /<text class="badge-meta"[^>]*font-size="6\.5"[^>]*letter-spacing="\.1"[^>]*>◆ CONSISTENCY<\/text>/u,
  );

  const longestRepresentatives = ACHIEVEMENT_CATEGORIES.map((category) => ({
    ...ACHIEVEMENT_CATALOG.filter((entry) => entry.category === category).at(-1),
    state: 'unlocked',
  }));
  const longest = renderAchievements({
    ...statisticsFixture(),
    achievementRepresentatives: longestRepresentatives,
  });
  assert.match(
    longest,
    /<text class="badge-label"[^>]*textLength="[0-9.]+" lengthAdjust="spacingAndGlyphs">Transcendent Trillion<\/text>/u,
  );
  assert.equal(validateSvgDocument(longest, { filePath: 'achievements.svg' }), true);
});

test('trophy case renders all four categories and sixteen icon-bearing badge states', () => {
  const trophyCase = renderAll()['trophy-case'];
  for (const label of ['RENOWN', 'MOMENTUM', 'CONSISTENCY', 'JOURNEY']) {
    assert.match(trophyCase, new RegExp(label, 'u'));
  }
  assert.equal((trophyCase.match(/class="achievement-badge /g) ?? []).length, 16);
  assert.equal((trophyCase.match(/class="achievement-icon /g) ?? []).length, 16);
  assert.match(trophyCase, /achievement-unlocked/);
  assert.match(trophyCase, /achievement-locked/);
  assert.match(trophyCase, /achievement-unknown/);
});

test('analytical cards retain records, trends, and the 53 by 7 activity grid', () => {
  const { records, trends, activity } = renderAll();
  assert.match(records, /BEST 7-DAY RUN/);
  assert.match(records, /BEST FULL MONTH/);
  assert.match(trends, /30 DAYS/);
  assert.match(trends, /12 WEEKS/);
  assert.match(trends, /12 MONTHS/);
  assert.equal((activity.match(/class="heat-cell /g) ?? []).length, 371);
});

test('theme and escaped identity options flow through every renderer', () => {
  const cards = renderAll(statisticsFixture(), {
    theme: 'midnight',
    identity: '@owner<&',
  });
  for (const svg of Object.values(cards)) {
    assert.match(svg, /--bg:#f8faff/);
    assert.match(svg, /@owner&lt;&amp;/);
    assert.doesNotMatch(svg, /@owner<&/);
  }
});
