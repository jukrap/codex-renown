import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkoutSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNodeSha = '820762786026740c76f36085b0efc47a31fe5020';

async function readRepositoryFile(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('workflows pin every action to an approved full commit SHA', async () => {
  const workflows = await Promise.all([
    readRepositoryFile('.github/workflows/ci.yml'),
    readRepositoryFile('.github/workflows/render-cards.yml'),
  ]);

  for (const workflow of workflows) {
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)];
    assert.ok(uses.length > 0, 'workflow must use the pinned setup actions');
    for (const [, action] of uses) {
      assert.match(action, /^[^@]+@[0-9a-f]{40}$/);
    }
    assert.match(workflow, new RegExp(`actions/checkout@${checkoutSha}`));
    assert.match(workflow, new RegExp(`actions/setup-node@${setupNodeSha}`));
    assert.match(workflow, /persist-credentials:\s*false/);
  }
});

test('CI is read-only and runs every repository quality gate', async () => {
  const ci = await readRepositoryFile('.github/workflows/ci.yml');

  assert.match(ci, /^permissions:\r?\n  contents: read$/m);
  assert.doesNotMatch(ci, /contents:\s*write/);
  assert.match(ci, /^concurrency:\s*$/m);
  assert.match(ci, /timeout-minutes:\s*\d+/);
  assert.match(ci, /node-version:\s*24/);
  assert.doesNotMatch(ci, /node-version:\s*20/);
  assert.match(ci, /npm ci --ignore-scripts/);
  assert.match(ci, /npm run check:syntax/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run validate/);
  assert.match(ci, /npm run check:determinism/);
});

test('card rendering is bounded, loop-free, and writes only in its render job', async () => {
  const workflow = await readRepositoryFile('.github/workflows/render-cards.yml');

  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.equal(workflow.match(/contents:\s*write/g)?.length, 1);
  assert.match(workflow, /^\s{4}permissions:\r?\n\s{6}contents: write$/m);
  assert.match(workflow, /^concurrency:\s*$/m);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /timeout-minutes:\s*\d+/);

  assert.match(workflow, /cron:\s*['"]27 15 \* \* \*['"]/);
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s{2}push:\s*$/m);
  assert.match(workflow, /paths-ignore:[\s\S]*- ['"]cards\/\*\*['"]/);

  assert.doesNotMatch(workflow, /date -u \+%F/);
  assert.match(workflow, /new Date\(\)\.toISOString\(\)/);
  assert.match(workflow, /scripts\/resolve-render-context\.mjs --instant/);
  assert.match(workflow, /npm run render -- --as-of "\$CARD_AS_OF" --as-of-instant "\$CARD_AS_OF_INSTANT"/);
  assert.match(workflow, /npm run validate/);
  assert.match(workflow, /npm run check:determinism -- --as-of "\$CARD_AS_OF" --as-of-instant "\$CARD_AS_OF_INSTANT"/);
  assert.match(workflow, /npm run check:syntax/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(
    workflow,
    /CODEX_BEARER_TOKEN|ANTHROPIC_API_KEY|\.codex|\.claude|npm run (?:collect|profile|sync)/i,
  );

  const addCommands = [...workflow.matchAll(/^\s*git add\b.*$/gm)]
    .map(([line]) => line.trim());
  assert.deepEqual(addCommands, ['git add -- "${card_paths[@]}"']);
  assert.match(workflow, /mapfile -t card_paths < <\(node scripts\/list-card-paths\.mjs\)/);
  assert.match(workflow, /"\$\{#card_paths\[@\]\}" -ne 35/);
  assert.doesNotMatch(workflow, /git add -- cards\//);
  assert.match(workflow, /push origin HEAD:main/);
  assert.doesNotMatch(workflow, /git\s+push[^\r\n]*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/);
  assert.doesNotMatch(workflow, /git config --local credential\.helper/);
});

test('publish retries at most three times and rebuilds after rebasing latest main', async () => {
  const workflow = await readRepositoryFile('.github/workflows/render-cards.yml');

  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /git fetch --no-tags origin main/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /git rebase --abort/);

  const publishStep = workflow.indexOf('- name: Publish rendered cards');
  assert.notEqual(publishStep, -1);
  const tokenReferences = [...workflow.matchAll(/\$\{\{\s*github\.token\s*\}\}/g)];
  assert.equal(tokenReferences.length, 1);
  assert.ok(tokenReferences[0].index > publishStep);

  const retryBlock = workflow.slice(workflow.indexOf('for attempt in 1 2 3'));
  assert.match(retryBlock, /npm ci --ignore-scripts/);
  assert.match(retryBlock, /npm run check:syntax/);
  assert.match(retryBlock, /npm test/);
  assert.match(retryBlock, /npm run validate/);
  assert.match(retryBlock, /npm run render -- --as-of "\$CARD_AS_OF" --as-of-instant "\$CARD_AS_OF_INSTANT"/);
  assert.match(retryBlock, /npm run check:determinism -- --as-of "\$CARD_AS_OF" --as-of-instant "\$CARD_AS_OF_INSTANT"/);
});

test('both workflows resolve one captured instant through strict repository timezone data', async () => {
  const workflows = await Promise.all([
    readRepositoryFile('.github/workflows/ci.yml'),
    readRepositoryFile('.github/workflows/render-cards.yml'),
  ]);

  for (const workflow of workflows) {
    assert.equal(workflow.match(/new Date\(\)\.toISOString\(\)/g)?.length, 1);
    assert.match(workflow, /scripts\/resolve-render-context\.mjs --instant/);
    assert.match(workflow, /--as-of-instant "\$CARD_AS_OF_INSTANT"/);
    assert.doesNotMatch(workflow, /date\s+(?:-u\s+)?\+%F/);
  }
});

test('Dependabot checks npm and GitHub Actions every week', async () => {
  const dependabot = await readRepositoryFile('.github/dependabot.yml');

  assert.match(dependabot, /^version:\s*2$/m);
  assert.match(dependabot, /package-ecosystem:\s*['"]npm['"]/);
  assert.match(dependabot, /package-ecosystem:\s*['"]github-actions['"]/);
  assert.equal(dependabot.match(/interval:\s*['"]weekly['"]/g)?.length, 2);
});
