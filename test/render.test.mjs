import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SaxesParser } from 'saxes';

import {
  CARD_ARTIFACT_PATHS,
  CARD_NAMES,
  CARD_VIEW_BOXES,
  THEME_NAMES,
  cardFilename,
} from '../src/card-catalog.mjs';
import { eachDay } from '../src/domain/calendar.mjs';
import { computeStatistics } from '../src/domain/statistics.mjs';
import { renderCards, run as runRenderCommand } from '../src/commands/render.mjs';
import { renderAchievements } from '../src/render/achievements.mjs';
import { renderActivity } from '../src/render/activity.mjs';
import { renderCompact } from '../src/render/compact.mjs';
import { renderOverview } from '../src/render/overview.mjs';
import { renderRecords } from '../src/render/records.mjs';
import { renderTrends } from '../src/render/trends.mjs';
import { renderTrophyCase } from '../src/render/trophy-case.mjs';
import {
  CARD_STYLE,
  formatCompactNumber,
  formatExactNumber,
  formatExpandedNumber,
} from '../src/render/svg.mjs';

const AS_OF = '2026-07-21';
function profileStatistics(lifetimeTotalTokens = 19_300_000_000) {
  const dates = eachDay('2026-06-01', AS_OF);
  const days = dates.map((date, index) => ({
    date,
    codex: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: (index + 1) * 1_000_000,
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
    codexLifetimeTotalTokens: lifetimeTotalTokens,
  }, { asOf: AS_OF });
}

function renderAll(statistics = profileStatistics()) {
  return {
    overview: renderOverview(statistics),
    achievements: renderAchievements(statistics),
    'trophy-case': renderTrophyCase(statistics),
    records: renderRecords(statistics),
    trends: renderTrends(statistics),
    activity: renderActivity(statistics),
    compact: renderCompact(statistics),
  };
}

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/giu).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left, right) {
  const luminances = [relativeLuminance(left), relativeLuminance(right)]
    .toSorted((first, second) => second - first);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

function cssVariables(declarations) {
  return Object.fromEntries(declarations.split(';').filter(Boolean).map((declaration) => {
    const separator = declaration.indexOf(':');
    return [declaration.slice(0, separator), declaration.slice(separator + 1)];
  }));
}

function assertXml(svg) {
  const parser = new SaxesParser({ xmlns: true });
  let error = null;
  parser.onerror = (value) => {
    error = value;
  };
  parser.write(svg).close();
  assert.equal(error, null);
}

function numericAttribute(tag, name, defaultValue = null) {
  const match = new RegExp(`\\s${name}="(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))"`, 'u').exec(tag);
  return match === null ? defaultValue : Number(match[1]);
}

function assertGeometryWithin(svg, width, height) {
  for (const match of svg.matchAll(/<rect\b[^>]*>/gu)) {
    const tag = match[0];
    const x = numericAttribute(tag, 'x', 0);
    const y = numericAttribute(tag, 'y', 0);
    const rectWidth = numericAttribute(tag, 'width');
    const rectHeight = numericAttribute(tag, 'height');
    assert.ok(x >= 0 && y >= 0 && rectWidth >= 0 && rectHeight >= 0);
    assert.ok(x + rectWidth <= width && y + rectHeight <= height, tag);
  }
  for (const match of svg.matchAll(/<line\b[^>]*>/gu)) {
    const tag = match[0];
    for (const [xName, yName] of [['x1', 'y1'], ['x2', 'y2']]) {
      const x = numericAttribute(tag, xName);
      const y = numericAttribute(tag, yName);
      assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, tag);
    }
  }
  for (const match of svg.matchAll(/<text\b[^>]*>/gu)) {
    const tag = match[0];
    const x = numericAttribute(tag, 'x');
    const y = numericAttribute(tag, 'y');
    assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, tag);
  }
}

function assertSafeCard(svg, viewBox) {
  assertXml(svg);
  const [, , rawWidth, rawHeight] = viewBox.split(' ');
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  assert.match(svg, /<title id="[^"]+">/);
  assert.match(svg, /<desc id="[^"]+">/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-labelledby="[^"]+ [^"]+"/);
  assert.match(svg, new RegExp(`width="${width}" height="${height}" viewBox="${viewBox}"`));
  assert.match(svg, /prefers-color-scheme:\s*dark/);
  assert.doesNotMatch(svg, /<script|<foreignObject|<image|<a\b|<use\b/i);
  assert.doesNotMatch(svg, /\son[a-z]+\s*=|\s(?:href|xlink:href)\s*=|data:|@import|url\s*\(/i);
  assert.equal(svg.includes('\r'), false);
  assert.equal(svg.endsWith('\n'), true);
  assertGeometryWithin(svg, width, height);
}

function captureStream() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(value);
    },
    text() {
      return chunks.join('');
    },
  };
}

function profileCandidate() {
  const daily = eachDay('2026-06-01', AS_OF).map((date, index) => ({
    date,
    totalTokens: (index + 1) * 1_000_000,
  }));
  return {
    schemaVersion: 2,
    kind: 'codex-profile',
    deviceId: `device-${'1'.repeat(32)}`,
    writerKeyHash: 'a'.repeat(64),
    collectedAt: '2026-07-21T12:00:00.000Z',
    dateBasis: 'provider-calendar-date',
    daily,
    lifetimeTotalTokens: 19_300_000_000,
    coverage: {
      startDate: daily[0].date,
      endDate: daily.at(-1).date,
      bucketCount: daily.length,
    },
  };
}

test('all seven cards are accessible deterministic SVGs within fixed canvases', () => {
  const cards = renderAll();
  for (const name of CARD_NAMES) {
    assertSafeCard(cards[name], CARD_VIEW_BOXES[name]);
    assert.equal(cards[name], renderAll()[name]);
  }
  assert.equal((cards.activity.match(/class="heat-cell /g) ?? []).length, 371);
  assert.equal((cards.achievements.match(/class="rank-node/g) ?? []).length, 20);
  assert.equal((cards.achievements.match(/class="representative-badge /g) ?? []).length, 4);
});

test('overview and compact lead with lifetime tokens and Rank XV Mythic', () => {
  const { overview, compact } = renderAll();

  assert.match(overview, /19\.3B TOKENS PROCESSED/);
  assert.match(overview, /19\.3 billion · 19,300,000,000 account total/);
  assert.match(overview, /XV · MYTHIC/);
  assert.doesNotMatch(overview, /RANK XV/);
  assert.match(overview, /62% to Rank XVI · ASCENDANT · 25B/);
  assert.match(overview, /TODAY SO FAR/);
  assert.match(overview, /LAST 7 DAYS/);
  assert.match(overview, /LAST 30 DAYS/);
  assert.match(overview, /ACTIVE DAYS/);
  assert.match(compact, /RANK XV · MYTHIC/);
  assert.match(compact, /19\.3B TOKENS/);
  assert.doesNotMatch(overview + compact, /Claude|Complete|Mixed/);
});

test('achievements and records expose rank track, seals, and complete windows', () => {
  const { achievements, records } = renderAll();

  assert.match(achievements, /15 \/ 20 ranks unlocked/);
  assert.match(achievements, /Mythic Realm/);
  assert.match(achievements, /Heavy Day/);
  assert.match(achievements, /Monthbound/);
  assert.match(achievements, /Trailblazer/);
  assert.match(achievements, /seal-unlocked/);
  assert.match(achievements, /seal-locked/);

  assert.match(records, /PEAK DAY/);
  assert.match(records, /BEST 7-DAY RUN/);
  assert.match(records, /BEST 30-DAY RUN/);
  assert.match(records, /BEST FULL MONTH/);
  assert.doesNotMatch(records, /Not enough complete history/);
});

test('partial and unknown states retain symbols, labels, and dashed outlines', () => {
  const statistics = profileStatistics();
  statistics.periods.today.current.totalTokens = {
    value: 123,
    coverage: 'partial',
    lowerBound: true,
  };
  statistics.trends.daily[0].totalTokens = {
    value: 123,
    coverage: 'partial',
    lowerBound: true,
  };
  statistics.trends.daily[1].totalTokens = {
    value: null,
    coverage: 'unknown',
    lowerBound: false,
  };
  statistics.heatmap.cells[0] = {
    ...statistics.heatmap.cells[0],
    state: 'active',
    totalTokens: 123,
    coverage: 'partial',
    level: 1,
  };

  const overview = renderOverview(statistics);
  const trends = renderTrends(statistics);
  const activity = renderActivity(statistics);
  assert.match(overview, />≥123</);
  assert.match(trends, /state-partial/);
  assert.match(trends, /state-unknown/);
  assert.match(activity, /coverage-partial/);
  assert.match(CARD_STYLE, /stroke-dasharray/);
});

test('light and dark neutral palettes meet text and RPG accent contrast', () => {
  const themes = Array.from(CARD_STYLE.matchAll(/:root\{([^}]+)\}/gu), (match) => (
    cssVariables(match[1])
  ));

  assert.equal(themes.length, 2);
  for (const theme of themes) {
    assert.ok(contrastRatio(theme['--text'], theme['--bg']) >= 4.5);
    assert.ok(contrastRatio(theme['--muted'], theme['--bg']) >= 4.5);
    for (const accent of ['--accent', '--common', '--uncommon', '--rare', '--epic', '--legendary']) {
      assert.ok(contrastRatio(theme[accent], theme['--bg']) >= 3, accent);
    }
  }
});

test('number formatters preserve compact, expanded, and exact hierarchy', () => {
  assert.equal(formatCompactNumber(19_300_000_000), '19.3B');
  assert.equal(formatExpandedNumber(19_300_000_000), '19.3 billion');
  assert.equal(formatExactNumber(19_300_000_000), '19,300,000,000');
  assert.equal(formatCompactNumber(Number.MAX_SAFE_INTEGER), '9.01Q');
  assert.throws(() => formatCompactNumber(Number.MAX_SAFE_INTEGER + 1));
});

test('overview keeps a safe-integer lifetime readable at max rank', () => {
  const overview = renderOverview(profileStatistics(Number.MAX_SAFE_INTEGER));

  assertSafeCard(overview, CARD_VIEW_BOXES.overview);
  assert.match(overview, /9\.01Q TOKENS PROCESSED/);
  assert.match(overview, /9,007,199,254,740,991 account total/);
  assert.match(overview, /XX · TRANSCENDENT/);
  assert.doesNotMatch(overview, /RANK XX/);
  assert.match(overview, /textLength="202" lengthAdjust="spacingAndGlyphs"/);
  assert.match(overview, /MAX RANK/);
});

test('renderCards atomically writes all 35 themed schema v2 cards', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-render-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const candidate = profileCandidate();
  await mkdir(path.join(cwd, 'data', 'profiles'), { recursive: true });
  await writeFile(
    path.join(cwd, 'data', 'profiles', `${candidate.deviceId}.json`),
    `${JSON.stringify(candidate)}\n`,
    'utf8',
  );

  const result = await renderCards({
    cwd,
    asOf: AS_OF,
    asOfInstant: '2026-07-21T12:00:00.000Z',
  });
  assert.deepEqual(Object.keys(result.cardPaths), CARD_ARTIFACT_PATHS);
  for (const theme of THEME_NAMES) {
    for (const name of CARD_NAMES) {
      const contents = await readFile(
        path.join(cwd, 'cards', cardFilename(name, theme)),
        'utf8',
      );
      assertSafeCard(contents, CARD_VIEW_BOXES[name]);
    }
  }
});

test('stale account profiles render as retained snapshots instead of device fallback', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-render-retained-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const candidate = profileCandidate();
  await mkdir(path.join(cwd, 'data', 'profiles'), { recursive: true });
  await writeFile(
    path.join(cwd, 'data', 'profiles', `${candidate.deviceId}.json`),
    `${JSON.stringify(candidate)}\n`,
    'utf8',
  );

  await renderCards({
    cwd,
    asOf: '2026-07-25',
    asOfInstant: '2026-07-25T12:00:00.000Z',
  });
  const overview = await readFile(path.join(cwd, 'cards', 'overview.svg'), 'utf8');
  assert.match(overview, /19.3B TOKENS PROCESSED/);
  assert.match(overview, /ACCOUNT SNAPSHOT/);
  assert.match(overview, /Last updated 2026-07-21/);
  assert.doesNotMatch(overview, /DEVICE FALLBACK/);
});

test('validation failure preserves every existing card byte', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-render-atomic-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'cards'), { recursive: true });
  await Promise.all(CARD_ARTIFACT_PATHS.map((artifactPath) => (
    writeFile(
      path.join(cwd, 'cards', path.basename(artifactPath)),
      `old-${artifactPath}\n`,
      'utf8',
    )
  )));

  let calls = 0;
  await assert.rejects(
    () => renderCards({
      cwd,
      asOf: AS_OF,
      validateSvg() {
        calls += 1;
        if (calls === 3) {
          throw new Error('fixture validator rejection');
        }
      },
    }),
    /fixture validator rejection/,
  );

  assert.equal(calls, 3);
  for (const artifactPath of CARD_ARTIFACT_PATHS) {
    assert.equal(
      await readFile(path.join(cwd, 'cards', path.basename(artifactPath)), 'utf8'),
      `old-${artifactPath}\n`,
    );
  }
});

test('empty public data renders valid not-updated and unknown cards', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-render-empty-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await renderCards({ cwd, asOf: AS_OF });
  const overview = await readFile(path.join(cwd, 'cards', 'overview.svg'), 'utf8');
  const achievements = await readFile(path.join(cwd, 'cards', 'achievements.svg'), 'utf8');
  assert.match(overview, /NO USAGE SNAPSHOT YET/);
  assert.match(overview, /NOT UPDATED YET/);
  assert.match(overview, /Awaiting first sync/);
  assert.match(achievements, /NOT UPDATED YET/);
  assert.match(achievements, /Awaiting first sync/);
  assert.doesNotMatch(overview + achievements, /DEVICE FALLBACK|UNRANKED/);
  assertSafeCard(overview, CARD_VIEW_BOXES.overview);
});

test('render CLI and determinism check report 35 cards', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-render-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stdout = captureStream();
  const stderr = captureStream();

  assert.equal(await runRenderCommand([], { stdout, stderr }, { cwd }), 2);
  assert.match(stderr.text(), /--as-of YYYY-MM-DD/);
  assert.equal(
    await runRenderCommand(
      ['--as-of', AS_OF],
      { stdout, stderr },
      {
        cwd,
        withRepositoryLockImpl: (_options, operation) => operation(),
      },
    ),
    0,
  );
  assert.match(stdout.text(), /Rendered 35 cards as of 2026-07-21/);

  const valid = spawnSync(
    process.execPath,
    ['scripts/check-render-determinism.mjs', '--as-of', AS_OF],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Deterministic SVG OK \(35 cards, as-of 2026-07-21\)/);
});
