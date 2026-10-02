import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CCUSAGE_VERSION,
  buildCcusageArgs,
  collectCcusage,
  createCcusageRunner,
  normalizeCcusageDaily,
} from '../src/collectors/ccusage.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagePath = join(projectRoot, 'node_modules', 'ccusage', 'package.json');

test('installed ccusage version and empty Codex home satisfy the pinned contract', async (t) => {
  try {
    await access(packagePath);
  } catch {
    t.skip('ccusage dependency is not installed');
    return;
  }

  const installed = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(installed.version, CCUSAGE_VERSION);

  const isolatedRoot = await mkdtemp(join(tmpdir(), 'agent-card-ccusage-'));
  const codexRoot = join(isolatedRoot, 'codex');
  await mkdir(codexRoot, { recursive: true });

  try {
    const runner = createCcusageRunner({
      entryPath: join(dirname(packagePath), 'src', 'cli.js'),
      timeoutMs: 20_000,
    });
    const environment = {
      ...process.env,
      HOME: isolatedRoot,
      USERPROFILE: isolatedRoot,
      CODEX_HOME: codexRoot,
    };

    let stdout;
    try {
      stdout = await runner(buildCcusageArgs('daily', 'UTC'), { env: environment });
    } catch (error) {
      assert.fail(`codex empty-home contract failed: ${error.code ?? 'UNKNOWN'}`);
    }
    const parsed = JSON.parse(stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ['daily', 'totals']);
    assert.deepEqual(normalizeCcusageDaily(parsed, { timezone: 'UTC' }), []);
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true });
  }
});

test('installed ccusage counts cumulative Codex events once across the timezone boundary', async (t) => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'agent-card-codex-events-'));
  t.after(() => rm(isolatedRoot, { force: true, recursive: true }));
  const codexRoot = join(isolatedRoot, 'codex');
  const sessions = join(codexRoot, 'sessions', '2026', '07', '18');
  await mkdir(sessions, { recursive: true });
  const usage = (input, cached, output) => ({
    input_tokens: input, cached_input_tokens: cached, output_tokens: output,
    reasoning_output_tokens: 0, total_tokens: input + output,
  });
  const tokenEvent = (timestamp, total, last) => ({
    timestamp, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  });
  const events = [
    { timestamp: '2026-07-18T14:00:00Z', type: 'session_meta',
      payload: { id: 'synthetic-contract-session', timestamp: '2026-07-18T14:00:00Z' } },
    { timestamp: '2026-07-18T14:00:00Z', type: 'turn_context', payload: { model: 'gpt-5' } },
    tokenEvent('2026-07-18T14:59:00Z', usage(100, 40, 20), usage(100, 40, 20)),
    tokenEvent('2026-07-18T15:01:00Z', usage(180, 60, 30), usage(80, 20, 10)),
    tokenEvent('2026-07-18T15:02:00Z', usage(180, 60, 30), usage(80, 20, 10)),
  ];
  await writeFile(join(sessions, 'rollout-2026-07-18-contract.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const runner = createCcusageRunner({ timeoutMs: 20_000 });
  const result = await collectCcusage({
    timezone: 'Asia/Seoul',
    includeSessions: true,
    runner,
    runnerOptions: { env: { HOME: isolatedRoot, USERPROFILE: isolatedRoot, CODEX_HOME: codexRoot } },
  });
  assert.deepEqual(result.days.map(({ date, totalTokens }) => ({ date, totalTokens })), [
    { date: '2026-07-18', totalTokens: 120 },
    { date: '2026-07-19', totalTokens: 90 },
  ]);
  assert.equal(result.sessionStatus, 'ok');
});
