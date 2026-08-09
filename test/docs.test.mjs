import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PUBLIC_DOCS = Object.freeze([
  'README.md',
  'README.ko.md',
  'SECURITY.md',
  'docs/setup-windows.md',
  'docs/setup-unix.md',
  'docs/migration-codex-renown.md',
]);

async function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('public documentation covers the Codex Renown serverless flow', async () => {
  const [english, korean] = await Promise.all([read('README.md'), read('README.ko.md')]);

  for (const document of [english, korean]) {
    for (const command of [
      'npm ci',
      'npm run setup -- --timezone',
      'npm run sync',
      'npm run profile',
      'npm run publish-cards',
    ]) {
      assert.match(document, new RegExp(command.replaceAll(' ', '\\s+')));
    }
    assert.match(document, /Codex Renown/);
    assert.match(document, /Your Codex usage, told through milestones\./);
    assert.match(document, /unofficial community project/i);
    assert.match(document, /Node(?:\.js)? 24/i);
    assert.match(document, /ccusage codex/i);
    assert.match(document, /App Server/i);
    assert.match(document, /account\/usage\/read/);
    assert.match(document, /AGENT_CARD_CODEX_BIN/);
    assert.match(document, /account profile updated/i);
    assert.match(document, /device fallback/i);
    assert.match(document, /APP_SERVER_PROTOCOL/);
    assert.match(document, /ChatGPT/);
    assert.match(document, /API[- ]key/i);
    assert.match(document, /profile candidate/i);
    assert.match(document, /schema (?:version )?2/i);
    assert.match(document, /Rank XV/i);
    assert.match(document, /Mythic/i);
    assert.match(document, /Ascendant/i);
    assert.match(document, /16 (?:achievements|개 업적)/i);
    assert.match(document, /35 (?:SVG|개)/i);
    assert.match(document, /raw (?:logs?|prompts?)/i);
    assert.match(document, /session IDs?/i);
    assert.match(document, /60 days|60일/i);
    assert.match(document, /delayed|지연/i);
    assert.match(document, /dropped|누락/i);
    assert.match(document, /Unknown/);
    assert.match(document, /Partial/);
    assert.match(document, /agent-card/);
    assert.doesNotMatch(document, /Claude Code/i);
    assert.doesNotMatch(document, /Mixed|≈/);
  }

  assert.match(english, /newest valid account profile candidate.{0,100}up to 48 hours.{0,100}last account snapshot/is);
  assert.match(english, /never adds account profile totals to local totals/is);
  assert.match(english, /local Codex totals only when no retainable account snapshot exists/is);
  assert.match(english, /NOT UPDATED YET/);
  assert.match(korean, /가장 최신의 유효한 account profile candidate.{0,100}48시간.{0,100}account snapshot/is);
  assert.match(korean, /절대 더하지 않습니다/is);
  assert.match(korean, /보존할 account snapshot이 없을 때만.{0,80}로컬 Codex 합계로 fallback/is);
  assert.match(korean, /NOT UPDATED YET/);
});

test('README files contain the seven-card GitHub layout and compact alternative', async () => {
  const documents = await Promise.all([read('README.md'), read('README.ko.md')]);
  for (const document of documents) {
    for (const [card, width] of [
      ['overview', '100%'],
      ['achievements', '49%'],
      ['records', '49%'],
      ['trophy-case', '100%'],
      ['trends', '49%'],
      ['activity', '49%'],
      ['compact', '416'],
    ]) {
      const rawUrl = `https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/${card}.svg`;
      assert.match(
        document,
        new RegExp(`<img width="${width.replace('%', '\\%')}" src="${rawUrl.replaceAll('.', '\\.')}`),
      );
    }
    for (const theme of ['github', 'midnight', 'aurora', 'ember', 'monochrome']) {
      assert.match(document, new RegExp(theme, 'i'));
    }
    assert.match(document, /overview-midnight\.svg/);
  }
});

test('scheduler guides use sync and preserve stable local contracts', async () => {
  const windows = await read('docs/setup-windows.md');
  const unix = await read('docs/setup-unix.md');

  for (const document of [windows, unix]) {
    assert.match(document, /codex-renown/);
    assert.match(document, /npm run sync/);
    assert.match(document, /ChatGPT/);
    assert.match(document, /AGENT_CARD_CODEX_BIN/);
    assert.match(document, /\.agent-card\.local\.json/);
    assert.match(document, /\.git[/\\]agent-card-sync\.lock/);
    assert.match(document, /account profile updated/i);
    assert.match(document, /device fallback/i);
    assert.match(document, /secret|credential|authentication/i);
    assert.doesNotMatch(document, /Claude Code|CLAUDE_CONFIG_DIR/i);
  }
  assert.match(windows, /Task Scheduler/i);
  assert.match(windows, /Start in|working directory/i);
  assert.match(windows, /codex\.exe/i);
  assert.match(unix, /launchd/);
  assert.match(unix, /cron/);
  assert.match(unix, /WorkingDirectory|working directory/i);
});

test('security policy documents schema v2, artifact allowlist, and App Server boundaries', async () => {
  const security = await read('SECURITY.md');
  assert.match(security, /Codex Renown/);
  assert.match(security, /private vulnerability reporting/i);
  assert.match(security, /current `main`/i);
  assert.match(security, /coordinated disclosure/i);
  assert.match(security, /schema-version 2/i);
  assert.match(security, /raw logs/i);
  assert.match(security, /public.{0,80}aggregate/is);
  assert.match(security, /App Server response bodies/i);
  assert.match(security, /CLI authentication state/i);
  assert.match(security, /AGENT_CARD_CODEX_BIN/);
  assert.match(security, /35.{0,40}SVG/is);
  assert.match(security, /allowlist/i);
});

test('legacy bearer environment and unofficial endpoint guidance are absent', async () => {
  await assert.rejects(read('.env.example'), (error) => error?.code === 'ENOENT');
  const combined = (await Promise.all(PUBLIC_DOCS.map(read))).join('\n');
  assert.doesNotMatch(combined, /\.ai-agent-playbook|archive\/|archive\\/i);
  assert.doesNotMatch(combined, /Authorization:\s*Bearer\s+\S+/i);
  assert.doesNotMatch(combined, /CODEX_BEARER_TOKEN/i);
  assert.doesNotMatch(combined, /backend-api\/wham\/profiles\/me/i);
  assert.doesNotMatch(combined, /unofficial (?:profile )?endpoint/i);
});

test('README files explain one calendar basis and concise lower-bound fallback', async () => {
  const [english, korean] = await Promise.all([read('README.md'), read('README.ko.md')]);
  for (const document of [english, korean]) {
    assert.match(document, /Codex account calendar/);
    assert.match(document, /IANA timezone/i);
    assert.match(document, /DEVICE FALLBACK/);
    assert.match(document, /XIV · Paragon/i);
    assert.match(document, /≥/);
    assert.match(document, /records?/i);
    assert.doesNotMatch(document, /At least Rank/);
  }
  assert.match(english, /two date systems are never added together/i);
  assert.match(korean, /서로 다른 날짜 체계를 더하지 않습니다/);
});

test('legacy multi-provider plans are explicitly superseded', async () => {
  for (const plan of [
    'docs/plans/2026-07-19-multi-device-agent-card.md',
    'docs/plans/2026-07-19-multi-device-agent-card-design.md',
  ]) {
    const contents = await read(plan);
    assert.match(contents, /Superseded on 2026-07-22/);
    assert.match(contents, /2026-07-21-codex-renown-design\.md/);
    assert.match(contents, /historical context/);
  }
});
test('migration runbook covers every machine and a stop-update-verify-resume sequence', async () => {
  const migration = await read('docs/migration-codex-renown.md');
  assert.match(migration, /agent-card-tracker/);
  assert.match(migration, /jukrap\/codex-renown/);
  assert.match(migration, /every (?:clone|computer)|모든 (?:clone|컴퓨터)/i);
  assert.match(migration, /stop.{0,120}update.{0,120}verify.{0,120}resume/is);
  assert.match(migration, /\.agent-card\.local\.json/);
  assert.match(migration, /AGENT_CARD_CODEX_BIN/);
  assert.match(migration, /agent-card-sync\.lock/);
  assert.match(migration, /git remote set-url origin https:\/\/github\.com\/jukrap\/codex-renown\.git/);
  assert.match(migration, /npm ci --ignore-scripts/);
  assert.match(migration, /npm run validate/);
  assert.match(migration, /npm run sync/);
});