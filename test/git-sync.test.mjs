import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as defaultFileSystem from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import { CARD_ARTIFACT_PATHS } from '../src/card-catalog.mjs';
import {
  GitRepositoryError,
  createGitRunner,
  inspectDedicatedRepository,
  withRepositoryLock,
} from '../src/git/repository.mjs';
import { GitPublishError, publishChanges } from '../src/git/publish.mjs';
import {
  run as runSyncCommand,
  synchronizeDevice,
} from '../src/commands/sync.mjs';
import { publishCards } from '../src/commands/publish-cards.mjs';

const DEVICE_ID = `device-${'1'.repeat(32)}`;
const WRITER_KEY = '2'.repeat(64);
const WRITER_KEY_HASH = createHash('sha256').update(WRITER_KEY).digest('hex');
const DEVICE_PATH = `data/devices/${DEVICE_ID}.json`;
const PROFILE_PATH = `data/profiles/${DEVICE_ID}.json`;
const OTHER_DEVICE_PATH = `data/devices/device-${'3'.repeat(32)}.json`;
const CARD_PATHS = [...CARD_ARTIFACT_PATHS];

const execFileAsync = promisify(execFile);

function ok(stdout = '') {
  return { exitCode: 0, stdout, stderr: '' };
}

function failed(stderr = 'failed', exitCode = 1) {
  return { exitCode, stdout: '', stderr };
}

test('sync command reports account profile and device fallback success explicitly', async () => {
  const cases = [
    ['pushed', 'updated', null, 'Sanitized snapshots published (account profile updated).\n'],
    ['noop', 'fallback', null, 'Snapshots are already up to date (device fallback).\n'],
    [
      'pushed',
      'fallback',
      'APP_SERVER_PROTOCOL',
      'Sanitized snapshots published (device fallback; account profile failed: APP_SERVER_PROTOCOL).\n',
    ],
    [
      'noop',
      'fallback',
      'private bearer token',
      'Snapshots are already up to date (device fallback; account profile failed: APP_SERVER_FAILED).\n',
    ],
  ];

  for (const [statusValue, profileStatus, profileErrorCode, expected] of cases) {
    let stdout = '';
    let stderr = '';
    const status = await runSyncCommand(
      [],
      {
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: (value) => { stderr += value; } },
      },
      {
        publishChangesImpl: async () => ({
          status: statusValue,
          profileStatus,
          profileErrorCode,
        }),
      },
    );

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(stdout, expected);
  }
});

function repositoryRunner({
  cwd,
  remoteUrl = 'https://github.com/jukrap/codex-renown.git',
  fetchUrls = [remoteUrl],
  pushUrls = [remoteUrl],
  advertisedBranch = 'main',
  gitDirectory = path.join(cwd, '.git'),
  trackedStatus = '',
} = {}) {
  const calls = [];
  const runner = async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.join('\0');
    if (command === 'rev-parse\0--show-toplevel') return ok(cwd);
    if (command === 'rev-parse\0--is-bare-repository') return ok('false');
    if (command === 'rev-parse\0--path-format=absolute\0--git-dir') return ok(gitDirectory);
    if (command === 'symbolic-ref\0--quiet\0--short\0HEAD') return ok('main');
    if (command === 'rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{upstream}') {
      return ok('origin/main');
    }
    if (command === 'remote\0get-url\0--all\0origin') return ok(fetchUrls.join('\n'));
    if (command === 'remote\0get-url\0--push\0--all\0origin') {
      return ok(pushUrls.join('\n'));
    }
    if (command === 'ls-remote\0--symref\0origin\0HEAD') {
      return ok(`ref: refs/heads/${advertisedBranch}\tHEAD\n${'a'.repeat(40)}\tHEAD`);
    }
    if (command === 'symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD') {
      return ok('origin/main');
    }
    if (command === 'status\0--porcelain=v1\0--untracked-files=no') return ok(trackedStatus);
    throw new Error(`Unexpected git argv: ${JSON.stringify(args)}`);
  };
  return { runner, calls };
}

function publicationRunner({
  cwd,
  staged = true,
  pushResults = [ok()],
  fetchedOids = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)],
  remoteChangedPaths = [],
  rebaseResult = ok(),
  initialAhead = 0,
  initialBehind = 0,
  pendingMessage = 'feat(data): anonymized usage snapshot update',
  pendingParentCount = 1,
  pendingPaths = [DEVICE_PATH],
  pendingStatuses = pendingPaths.map(() => 'M'),
  localHeadPublished = false,
  commitResult = ok(),
  statusAfterRebase = '',
  headBlobOid = '8'.repeat(40),
  indexBlobOid = headBlobOid,
  workingBlobOid = headBlobOid,
  ownedDirtyStatus = '',
  unsafeAttributeValue = null,
  unsafeAttributePath = null,
  configuredHooks = '',
  configuredHookScope = '--local',
  worktreeConfigEnabled = false,
  trackedPaths = [DEVICE_PATH, ...CARD_PATHS],
} = {}) {
  const calls = [];
  let fetchCount = 0;
  let commitCount = initialAhead;
  let pushCount = 0;
  let stagedState = staged;
  let stagedPaths = [];
  let rebased = false;
  let merged = false;
  let initialTrackedStatus = ownedDirtyStatus;

  const runner = async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.join('\0');

    if (command === 'rev-parse\0--show-toplevel') return ok(cwd);
    if (command === 'rev-parse\0--is-bare-repository') return ok('false');
    if (command === 'rev-parse\0--path-format=absolute\0--git-dir') {
      return ok(path.join(cwd, '.git'));
    }
    if (command === 'symbolic-ref\0--quiet\0--short\0HEAD') return ok('main');
    if (command === 'rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{upstream}') {
      return ok('origin/main');
    }
    if (command === 'remote\0get-url\0--all\0origin'
      || command === 'remote\0get-url\0--push\0--all\0origin') {
      return ok('https://github.com/jukrap/codex-renown.git');
    }
    if (command === 'ls-remote\0--symref\0origin\0HEAD') {
      return ok(`ref: refs/heads/main\tHEAD\n${'a'.repeat(40)}\tHEAD`);
    }
    if (command === 'symbolic-ref\0--quiet\0--short\0refs/remotes/origin/HEAD') {
      return ok('origin/main');
    }
    if (command === 'status\0--porcelain=v1\0--untracked-files=no') {
      return ok(rebased ? statusAfterRebase : initialTrackedStatus);
    }
    if (command === 'status\0--porcelain=v1\0--untracked-files=all') {
      return ok(rebased ? statusAfterRebase : initialTrackedStatus);
    }
    if (command === 'status\0--porcelain=v1\0-z\0--untracked-files=no') {
      const status = rebased ? statusAfterRebase : initialTrackedStatus;
      return ok(status.length === 0 ? '' : `${status}\0`);
    }
    if (command === 'config\0--local\0--bool\0--get\0extensions.worktreeConfig') {
      return worktreeConfigEnabled ? ok('true') : failed('', 1);
    }
    if (args[0] === 'config' && args.includes('--get-regexp')) {
      return configuredHooks.length > 0 && args[1] === configuredHookScope
        ? ok(configuredHooks)
        : failed('', 1);
    }
    if (command === 'ls-files\0--cached\0-z'
      || command === 'ls-tree\0-r\0--name-only\0-z\0refs/remotes/origin/main') {
      return ok(trackedPaths.length === 0 ? '' : `${trackedPaths.join('\0')}\0`);
    }
    if (args[0] === 'check-attr' && args[1] === '-z') {
      const separator = args.indexOf('--');
      const attributes = args.slice(2, separator).filter(
        (argument) => !argument.startsWith('--source='),
      );
      const publicationPaths = args.slice(separator + 1);
      return ok(publicationPaths.flatMap((publicationPath) => attributes.flatMap(
        (attribute) => [
          publicationPath,
          attribute,
          unsafeAttributeValue !== null
            && (unsafeAttributePath === null || unsafeAttributePath === publicationPath)
            ? unsafeAttributeValue
            : 'unspecified',
        ],
      )).join('\0') + '\0');
    }
    if (command === [
      'fetch',
      '--no-prune',
      '--no-prune-tags',
      '--no-tags',
      '--recurse-submodules=no',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ].join('\0')) {
      fetchCount += 1;
      return ok();
    }
    if (command === 'rev-parse\0--verify\0refs/remotes/origin/main') {
      return ok(fetchedOids[Math.max(0, fetchCount - 1)]);
    }
    if (command === 'rev-list\0--left-right\0--count\0HEAD...refs/remotes/origin/main') {
      const behind = rebased || merged ? 0 : initialBehind;
      return ok(`${commitCount}\t${behind}`);
    }
    if (command === ['rev-list', '--parents', '-n', '1', 'HEAD'].join('\0')) {
      const remoteOid = fetchedOids[Math.max(0, fetchCount - 1)];
      const parents = Array.from(
        { length: pendingParentCount },
        (_value, index) => (index === 0 ? remoteOid : '9'.repeat(40)),
      );
      return ok(['f'.repeat(40), ...parents].join(' '));
    }
    if (command === 'log\0-1\0--format=%B\0HEAD') return ok(`${pendingMessage}\n`);
    if (command === [
      'diff-tree',
      '--no-ext-diff',
      '--no-textconv',
      '--no-commit-id',
      '--name-status',
      '-z',
      '-r',
      'HEAD',
      '--',
    ].join('\0')) {
      return ok(pendingPaths.flatMap(
        (pendingPath, index) => [pendingStatuses[index] ?? 'M', pendingPath],
      ).join('\0') + '\0');
    }
    if (command.startsWith('rev-parse\0--verify\0HEAD:')) return ok(headBlobOid);
    if (command.startsWith('rev-parse\0--verify\0:')) return ok(indexBlobOid);
    if (command.startsWith('hash-object\0--no-filters\0--\0')) return ok(workingBlobOid);
    if (command === 'add\0--\0data/devices/device-11111111111111111111111111111111.json') {
      stagedPaths = stagedState ? [DEVICE_PATH] : [];
      return ok();
    }
    if (command.startsWith('add\0--\0cards/overview.svg')) {
      stagedPaths = stagedState ? [...CARD_PATHS] : [];
      return ok();
    }
    if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      return stagedState ? failed('', 1) : ok();
    }
    if (args[0] === 'diff' && args.includes('--quiet')) return ok();
    if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
      return ok(stagedPaths.join('\n'));
    }
    if (command.startsWith('restore\0--staged\0--\0')) {
      stagedState = false;
      stagedPaths = [];
      return ok();
    }
    if (command.startsWith('restore\0--worktree\0--\0')) {
      initialTrackedStatus = '';
      return ok();
    }
    if (args[0] === 'commit') {
      if (commitResult.exitCode !== 0) {
        return commitResult;
      }
      commitCount = 1;
      stagedState = false;
      stagedPaths = [];
      return ok();
    }
    if (command === [
      'push',
      '--porcelain',
      '--no-follow-tags',
      '--no-signed',
      '--recurse-submodules=no',
      '--receive-pack=git-receive-pack',
      'origin',
      'HEAD:refs/heads/main',
    ].join('\0')) {
      const result = pushResults[Math.min(pushCount, pushResults.length - 1)];
      pushCount += 1;
      return result.exitCode === 0 && result.stdout.length === 0
        ? { ...result, stdout: '=\tHEAD:refs/heads/main\t[up to date]\nDone\n' }
        : result;
    }
    if (command === 'merge-base\0--is-ancestor\0HEAD\0refs/remotes/origin/main') {
      return localHeadPublished ? ok() : failed('', 1);
    }
    if (command.startsWith('merge-base\0--is-ancestor\0')) return ok();
    if (args[0] === 'log' && args.includes('--diff-filter=ACDMRTUXB')) {
      return ok(remoteChangedPaths.length === 0 ? '' : `${remoteChangedPaths.join('\0')}\0`);
    }
    if (args.length === 6
      && args[0] === 'rebase'
      && args[1] === '--no-update-refs'
      && args[2] === '--no-autostash'
      && args[3] === '--no-rebase-merges'
      && args[4] === '--no-gpg-sign'
      && args[5] === 'refs/remotes/origin/main') {
      if (rebaseResult.exitCode === 0) {
        rebased = true;
      }
      return rebaseResult;
    }
    if (command === 'rebase\0--no-gpg-sign\0refs/remotes/origin/main') {
      if (rebaseResult.exitCode === 0) {
        rebased = true;
      }
      return rebaseResult;
    }
    if (command === 'merge\0--no-verify-signatures\0--ff-only\0refs/remotes/origin/main') {
      merged = true;
      return ok();
    }
    if (command === 'rebase\0--abort') return ok();
    if (command.startsWith('merge-base\0HEAD\0refs/remotes/origin/main')) {
      return ok(fetchedOids[Math.max(0, fetchCount - 1)]);
    }
    throw new Error(`Unexpected git argv: ${JSON.stringify(args)}`);
  };

  return {
    runner,
    calls,
    get pushCount() { return pushCount; },
  };
}

async function temporaryRepository(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-git-sync-test-'));
  await mkdir(path.join(cwd, '.git'), { recursive: true });
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function source(days = []) {
  return {
    status: 'ok',
    lastSuccessfulAt: '2026-07-19T00:00:00.000Z',
    days,
    coverage: {
      totals: { startDate: '2026-07-19', endDate: '2026-07-19' },
      sessions: { startDate: '2026-07-19', endDate: '2026-07-19' },
    },
  };
}

function snapshot(writerKeyHash = WRITER_KEY_HASH) {
  return {
    schemaVersion: 2,
    deviceId: DEVICE_ID,
    writerKeyHash,
    generatedAt: '2026-07-19T00:00:00.000Z',
    timezone: 'Asia/Seoul',
    collectorVersion: '0.1.0',
    sources: { codex: source() },
  };
}

test('Git runner는 argv 배열과 shell:false, timeout, 출력 제한만 사용한다', async () => {
  let observed;
  const runner = createGitRunner({
    timeoutMs: 4321,
    maxOutputBytes: 12345,
    env: {
      PATH: 'safe-path',
      HOME: 'safe-home',
      SSH_AUTH_SOCK: 'safe-agent',
      CODEX_BEARER_TOKEN: 'private-upper',
      codex_bearer_token: 'private-lower',
      LaNg: 'ko_KR.UTF-8',
      lc_ALL: 'ko_KR.UTF-8',
      GIT_DIR: 'D:\\attacker-repository',
      git_index_file: 'D:\\attacker-index',
      Git_Object_Directory: 'D:\\attacker-objects',
      GIT_EXEC_PATH: 'D:\\attacker-bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'D:\\attacker-hook.exe',
      GIT_EXTERNAL_DIFF: 'D:\\attacker-diff.exe',
      GIT_SSH_COMMAND: 'D:\\attacker-ssh.exe',
      GIT_ATTR_NOSYSTEM: '0',
      Git_Terminal_Prompt: '1',
    },
    execFileImpl(command, args, options, callback) {
      observed = { command, args, options };
      callback(null, 'main\n', '');
    },
  });

  const result = await runner(['branch', '--show-current'], { cwd: 'D:\\safe-clone' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'main\n');
  assert.equal(observed.command, 'git');
  assert.deepEqual(observed.args.slice(-2), ['branch', '--show-current']);
  for (const safeConfig of [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.attributesFile=/dev/null',
    'commit.gpgSign=false',
    'push.gpgSign=false',
    'merge.verifySignatures=false',
    'rebase.updateRefs=false',
    'rebase.autoStash=false',
  ]) {
    assert.ok(observed.args.includes(safeConfig));
  }
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.timeout, 4321);
  assert.equal(observed.options.maxBuffer, 12345);
  assert.equal(observed.options.env.PATH, 'safe-path');
  assert.equal(observed.options.env.HOME, 'safe-home');
  assert.equal(observed.options.env.SSH_AUTH_SOCK, 'safe-agent');
  assert.equal(observed.options.env.LC_ALL, 'C');
  assert.equal(observed.options.env.LANG, 'C');
  assert.equal(observed.options.env.GIT_ATTR_NOSYSTEM, '1');
  assert.equal(observed.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(Object.hasOwn(observed.options.env, 'LaNg'), false);
  assert.equal(Object.hasOwn(observed.options.env, 'lc_ALL'), false);
  assert.equal(
    Object.keys(observed.options.env).some((key) => key.toLowerCase() === 'codex_bearer_token'),
    false,
  );
  assert.deepEqual(
    Object.keys(observed.options.env)
      .filter((key) => key.toLowerCase().startsWith('git_'))
      .sort(),
    ['GIT_ATTR_NOSYSTEM', 'GIT_TERMINAL_PROMPT'],
  );
});

test('전용 clone, target repository identity, upstream/default branch, clean tracked state를 검증한다', async () => {
  const cwd = path.resolve('D:\\safe-agent-card-clone');
  const success = repositoryRunner({ cwd });
  const repository = await inspectDedicatedRepository({ cwd, runner: success.runner });

  assert.equal(repository.remote, 'origin');
  assert.equal(repository.branch, 'main');
  assert.equal(repository.remoteRef, 'refs/remotes/origin/main');
  assert.ok(success.calls.every(({ args }) => Array.isArray(args)));

  for (const [options, code] of [
    [{ remoteUrl: 'https://github.com/attacker/codex-renown.git' }, 'REPOSITORY_IDENTITY_MISMATCH'],
    [{ remoteUrl: 'https://secret@github.com/jukrap/codex-renown.git' }, 'REPOSITORY_IDENTITY_MISMATCH'],
    [{ fetchUrls: [
      'https://github.com/jukrap/codex-renown.git',
      'https://github.com/attacker/codex-renown.git',
    ] }, 'REPOSITORY_IDENTITY_MISMATCH'],
    [{ pushUrls: ['https://github.com/attacker/codex-renown.git'] }, 'REPOSITORY_IDENTITY_MISMATCH'],
    [{ pushUrls: [
      'https://github.com/jukrap/codex-renown.git',
      'https://github.com/attacker/codex-renown.git',
    ] }, 'REPOSITORY_IDENTITY_MISMATCH'],
    [{ advertisedBranch: 'develop' }, 'DEFAULT_BRANCH_MISMATCH'],
    [{ gitDirectory: path.join(cwd, '.git', 'worktrees', 'linked') }, 'DEDICATED_CLONE_REQUIRED'],
    [{ trackedStatus: ' M src/index.mjs' }, 'TRACKED_WORKTREE_DIRTY'],
  ]) {
    const fake = repositoryRunner({ cwd, ...options });
    await assert.rejects(
      inspectDedicatedRepository({ cwd, runner: fake.runner }),
      (error) => error instanceof GitRepositoryError && error.code === code,
    );
  }
});

test('실제 Git CLI로 만든 독립 clone 형태도 동일한 repository 계약을 통과한다', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-real-git-test-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const git = (args) => execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });

  await git(['init', '--initial-branch=main']);
  await writeFile(path.join(cwd, 'README.md'), 'fixture\n');
  await git(['add', '--', 'README.md']);
  await git([
    '-c', 'user.name=sync-test',
    '-c', 'user.email=sync-test@invalid',
    'commit', '-m', 'fixture', '--', 'README.md',
  ]);
  await git(['remote', 'add', 'origin', 'https://github.com/jukrap/codex-renown.git']);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  await git(['update-ref', 'refs/remotes/origin/main', stdout.trim()]);
  await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await git(['branch', '--set-upstream-to=origin/main', 'main']);

  const realRunner = createGitRunner();
  const runner = (args, options) => args.join('\0') === 'ls-remote\0--symref\0origin\0HEAD'
    ? Promise.resolve(ok(`ref: refs/heads/main\tHEAD\n${stdout.trim()}\tHEAD`))
    : realRunner(args, options);
  const repository = await inspectDedicatedRepository({ cwd, runner });
  assert.equal(path.resolve(repository.root).toLowerCase(), path.resolve(cwd).toLowerCase());
  assert.equal(repository.branch, 'main');
  assert.equal(repository.remote, 'origin');
});

test('실제 Git에서도 hostile hook/fsmonitor/gpg/diff config를 실행하지 않는다', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-hostile-git-test-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const git = (args) => execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'safety-test']);
  await git(['config', 'user.email', 'safety-test@invalid']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'initial\n');
  await git(['add', '--', 'tracked.txt']);
  await git(['commit', '-m', 'initial']);

  const helperPath = path.join(cwd, '.git', 'hooks', 'hostile-helper');
  await writeFile(helperPath, '#!/bin/sh\nprintf ran >> git-helper-marker\nexit 1\n');
  await defaultFileSystem.chmod(helperPath, 0o755);
  await defaultFileSystem.copyFile(helperPath, path.join(cwd, '.git', 'hooks', 'pre-commit'));
  await defaultFileSystem.chmod(path.join(cwd, '.git', 'hooks', 'pre-commit'), 0o755);
  await git(['config', 'core.fsmonitor', helperPath]);
  await git(['config', 'commit.gpgSign', 'true']);
  await git(['config', 'gpg.program', helperPath]);
  await git(['config', 'diff.external', helperPath]);
  await git(['config', 'diff.trustExitCode', 'true']);
  await git(['config', 'hook.pre-commit.enabled', 'true']);
  await git(['config', 'hook.pre-commit.command', helperPath]);

  const runner = createGitRunner();
  assert.equal((await runner(['status', '--porcelain=v1'], { cwd })).exitCode, 0);
  assert.equal((await runner([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--quiet',
  ], { cwd })).exitCode, 0);
  assert.equal((await runner([
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'safe automation commit',
  ], { cwd })).exitCode, 0);
  await assert.rejects(
    readFile(path.join(cwd, 'git-helper-marker'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
});

test('실제 rebase는 updateRefs 설정이 켜져 있어도 다른 local branch를 이동하지 않는다', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-rebase-refs-test-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const git = (args) => execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'safety-test']);
  await git(['config', 'user.email', 'safety-test@invalid']);
  await writeFile(path.join(cwd, 'README.md'), 'base\n');
  await git(['add', '--', 'README.md']);
  await git(['commit', '-m', 'base']);
  const baseOid = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, ...DEVICE_PATH.split('/')), 'local\n');
  await git(['add', '--', DEVICE_PATH]);
  await git(['commit', '-m', 'feat(data): anonymized usage snapshot update']);
  const originalLocalOid = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['branch', 'side-ref', originalLocalOid]);

  await git(['switch', '--detach', baseOid]);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, ...OTHER_DEVICE_PATH.split('/')), 'remote\n');
  await git(['add', '--', OTHER_DEVICE_PATH]);
  await git(['commit', '-m', 'remote data']);
  const remoteOid = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['switch', 'main']);
  await git(['remote', 'add', 'origin', 'https://github.com/jukrap/codex-renown.git']);
  await git(['update-ref', 'refs/remotes/origin/main', remoteOid]);
  await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await git(['branch', '--set-upstream-to=origin/main', 'main']);
  await git(['config', 'rebase.updateRefs', 'true']);
  await git(['config', 'rebase.autoStash', 'true']);

  const realRunner = createGitRunner();
  const publicationCalls = [];
  const runner = (args, options) => {
    publicationCalls.push(args);
    if (args[0] === 'ls-remote') {
      return Promise.resolve(ok(`ref: refs/heads/main\tHEAD\n${remoteOid}\tHEAD`));
    }
    if (args[0] === 'fetch') {
      return Promise.resolve(ok());
    }
    if (args[0] === 'push') {
      return Promise.resolve(failed('authentication failed'));
    }
    return realRunner(args, options);
  };

  let publicationError;
  try {
    await publishChanges({
      cwd,
      runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
        collisionPaths: [DEVICE_PATH],
        commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    });
  } catch (error) {
    publicationError = error;
  }

  const finalSideOid = (await git(['rev-parse', 'side-ref'])).stdout.trim();
  const finalMainOid = (await git(['rev-parse', 'main'])).stdout.trim();
  assert.equal(
    publicationError?.code,
    'PUSH_AUTH_FAILED',
    `main=${finalMainOid} side=${finalSideOid} original=${originalLocalOid} calls=${JSON.stringify(publicationCalls)}`,
  );
  assert.equal(finalSideOid, originalLocalOid);
  assert.notEqual(finalMainOid, originalLocalOid);
});

test('process lock은 동시 실행을 막고 성공·실패 모두에서 해제된다', async (t) => {
  const cwd = await temporaryRepository(t);
  let releaseFirst;
  let announceFirst;
  const firstEntered = new Promise((resolve) => {
    announceFirst = resolve;
  });
  const first = withRepositoryLock({ cwd }, async () => new Promise((resolve) => {
    releaseFirst = resolve;
    announceFirst();
  }));

  await firstEntered;
  await assert.rejects(
    withRepositoryLock({ cwd }, async () => undefined),
    (error) => error.code === 'SYNC_ALREADY_RUNNING',
  );
  releaseFirst('done');
  assert.equal(await first, 'done');
  assert.equal(await withRepositoryLock({ cwd }, async () => 'again'), 'again');

  await assert.rejects(
    withRepositoryLock({ cwd }, async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(await withRepositoryLock({ cwd }, async () => 'recovered'), 'recovered');
});

test('오래됐고 owner process가 종료된 lock도 자동 삭제하지 않고 fail closed한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const lockPath = path.join(cwd, '.git', 'agent-card-sync.lock');
  const current = new Date('2026-07-19T12:00:00.000Z');
  const owner = {
    version: 1,
    pid: 424242,
    createdAt: '2026-07-19T10:00:00.000Z',
    token: '11111111-1111-4111-8111-111111111111',
  };
  await writeFile(lockPath, `${JSON.stringify(owner)}\n`);

  await assert.rejects(
    withRepositoryLock({
      cwd,
      now: () => new Date(current),
      staleAfterMs: 30 * 60 * 1_000,
      isProcessAlive: () => false,
    }, async () => 'unreachable'),
    (error) => error.code === 'SYNC_STALE_LOCK',
  );
  assert.equal(await readFile(lockPath, 'utf8'), `${JSON.stringify(owner)}\n`);
});

test('stale lock 판단 중 replacement가 가능해도 canonical lock rename을 시도하지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  const lockPath = path.join(cwd, '.git', 'agent-card-sync.lock');
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: 424242,
    createdAt: '2026-07-19T10:00:00.000Z',
    token: '44444444-4444-4444-8444-444444444444',
  })}\n`);
  let canonicalRenames = 0;
  const fileSystem = {
    ...defaultFileSystem,
    async rename(from, to) {
      if (from === lockPath) {
        canonicalRenames += 1;
      }
      return defaultFileSystem.rename(from, to);
    },
  };

  await assert.rejects(
    withRepositoryLock({
      cwd,
      fileSystem,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
      isProcessAlive: () => false,
    }, async () => undefined),
    (error) => error.code === 'SYNC_STALE_LOCK',
  );
  assert.equal(canonicalRenames, 0);
});

test('fresh/dead lock과 오래됐지만 live인 lock, malformed lock은 회수하지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  const lockPath = path.join(cwd, '.git', 'agent-card-sync.lock');
  const current = new Date('2026-07-19T12:00:00.000Z');
  const writeOwner = (createdAt) => writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: 424242,
    createdAt,
    token: '22222222-2222-4222-8222-222222222222',
  })}\n`);

  await writeOwner('2026-07-19T11:59:59.000Z');
  await assert.rejects(
    withRepositoryLock({
      cwd,
      now: () => new Date(current),
      staleAfterMs: 30 * 60 * 1_000,
      isProcessAlive: () => false,
    }, async () => undefined),
    (error) => error.code === 'SYNC_ALREADY_RUNNING',
  );
  await rm(lockPath);

  await writeOwner('2026-07-19T10:00:00.000Z');
  await assert.rejects(
    withRepositoryLock({
      cwd,
      now: () => new Date(current),
      staleAfterMs: 30 * 60 * 1_000,
      isProcessAlive: () => true,
    }, async () => undefined),
    (error) => error.code === 'SYNC_ALREADY_RUNNING',
  );
  await rm(lockPath);

  await writeFile(lockPath, '{}\n');
  await assert.rejects(
    withRepositoryLock({
      cwd,
      now: () => new Date(current),
      isProcessAlive: () => false,
    }, async () => undefined),
    (error) => error.code === 'SYNC_LOCK_INVALID',
  );
  assert.equal(await readFile(lockPath, 'utf8'), '{}\n');
});

test('stale lock read 직전 ENOENT race는 새 lock 획득으로 안전하게 재시도한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const lockPath = path.join(cwd, '.git', 'agent-card-sync.lock');
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: 424242,
    createdAt: '2026-07-19T10:00:00.000Z',
    token: '33333333-3333-4333-8333-333333333333',
  })}\n`);
  let raced = false;
  const fileSystem = {
    ...defaultFileSystem,
    async lstat(target) {
      if (!raced && target === lockPath) {
        raced = true;
        await defaultFileSystem.rm(lockPath);
        const error = new Error('raced');
        error.code = 'ENOENT';
        throw error;
      }
      return defaultFileSystem.lstat(target);
    },
  };

  const result = await withRepositoryLock({
    cwd,
    fileSystem,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    isProcessAlive: () => false,
  }, async () => 'retried');
  assert.equal(result, 'retried');
  assert.equal(raced, true);
});

test('hard-link 뒤 candidate unlink 실패는 canonical lock을 남기지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  const lockPath = path.join(cwd, '.git', 'agent-card-sync.lock');
  let failedCandidateUnlink = false;
  const fileSystem = {
    ...defaultFileSystem,
    async unlink(target) {
      if (!failedCandidateUnlink && target.includes('.candidate-')) {
        failedCandidateUnlink = true;
        const error = new Error('unlink blocked');
        error.code = 'EACCES';
        throw error;
      }
      return defaultFileSystem.unlink(target);
    },
  };

  await assert.rejects(
    withRepositoryLock({ cwd, fileSystem }, async () => 'unreachable'),
    (error) => error.code === 'SYNC_LOCK_FAILED',
  );
  await assert.rejects(readFile(lockPath, 'utf8'), (error) => error.code === 'ENOENT');
  const gitEntries = await defaultFileSystem.readdir(path.join(cwd, '.git'));
  assert.equal(gitEntries.some((name) => name.includes('.candidate-')), false);
});

test('변경이 없고 pending commit도 없으면 commit과 push를 생략한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({ cwd, staged: false });

  const result = await publishChanges({
    cwd,
    runner: fake.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH, PROFILE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => ({ stagePaths: [DEVICE_PATH] }),
      validate: async () => true,
    }),
  });

  assert.equal(result.status, 'noop');
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.calls.some(({ args }) => args[0] === 'commit'), false);
});

test('초기 fast-forward는 공개 data/card 변경만 자동 반영한다', async (t) => {
  const safeCwd = await temporaryRepository(t);
  const safe = publicationRunner({
    cwd: safeCwd,
    staged: false,
    initialBehind: 1,
    remoteChangedPaths: [OTHER_DEVICE_PATH, CARD_PATHS[0]],
  });
  let safeBuildCount = 0;
  const result = await publishChanges({
    cwd: safeCwd,
    runner: safe.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => {
        safeBuildCount += 1;
        return { stagePaths: [DEVICE_PATH] };
      },
      validate: async () => true,
    }),
  });
  assert.equal(result.status, 'noop');
  assert.equal(safeBuildCount, 1);
  assert.ok(safe.calls.some(
    ({ args }) => args.join(' ') === 'merge --no-verify-signatures --ff-only refs/remotes/origin/main',
  ));

  const unsafeCwd = await temporaryRepository(t);
  const unsafe = publicationRunner({
    cwd: unsafeCwd,
    initialBehind: 1,
    remoteChangedPaths: ['src/git/publish.mjs'],
  });
  let unsafeBuildCount = 0;
  await assert.rejects(
    publishChanges({
      cwd: unsafeCwd,
      runner: unsafe.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
        commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => {
          unsafeBuildCount += 1;
          return { stagePaths: [DEVICE_PATH] };
        },
        validate: async () => true,
      }),
    }),
    (error) => error.code === 'REMOTE_UPDATE_REQUIRES_RESTART',
  );
  assert.equal(unsafeBuildCount, 0);
  assert.equal(unsafe.calls.some(({ args }) => ['merge', 'rebase'].includes(args[0])), false);
});

test('configured hook과 전체 tree의 unsafe attribute는 mutation 전에 차단한다', async (t) => {
  const cases = [
    {
      name: 'configured hook',
      options: { configuredHooks: 'hook.pre-commit.command hostile-helper' },
    },
    {
      name: 'configured worktree hook',
      options: {
        configuredHooks: 'hook.pre-commit.command hostile-helper',
        configuredHookScope: '--worktree',
        worktreeConfigEnabled: true,
      },
    },
    {
      name: 'filter=false driver',
      options: { unsafeAttributeValue: 'false', unsafeAttributePath: DEVICE_PATH },
    },
    {
      name: 'publication 밖 tracked path filter',
      options: {
        trackedPaths: ['README.md', DEVICE_PATH],
        unsafeAttributeValue: 'hostile',
        unsafeAttributePath: 'README.md',
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-git-policy-test-'));
      try {
        await mkdir(path.join(cwd, '.git'), { recursive: true });
        const fake = publicationRunner({ cwd, ...fixture.options });
        await assert.rejects(
          publishChanges({
            cwd,
            runner: fake.runner,
            resolvePlan: async () => ({
              allowedPaths: [DEVICE_PATH],
              commitMessage: 'feat(data): anonymized usage snapshot update',
              build: async () => ({ stagePaths: [DEVICE_PATH] }),
              validate: async () => true,
            }),
          }),
          (error) => error.code === 'GIT_STATE_INVALID',
        );
        assert.equal(fake.calls.some(({ args }) => args[0] === 'add'), false);
        assert.equal(fake.pushCount, 0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test('valid한 exact owned tracked dirt만 HEAD로 복구한 뒤 다시 build한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    staged: false,
    ownedDirtyStatus: ` M ${DEVICE_PATH}`,
  });
  let validations = 0;
  const result = await publishChanges({
    cwd,
    runner: fake.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => ({ stagePaths: [DEVICE_PATH] }),
      validate: async () => { validations += 1; },
    }),
  });

  assert.equal(result.status, 'noop');
  assert.ok(validations >= 3);
  assert.ok(fake.calls.some(
    ({ args }) => args.join(' ') === `restore --worktree -- ${DEVICE_PATH}`,
  ));
});

test('owned scope 밖 tracked dirt는 자동 복구하지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({ cwd, ownedDirtyStatus: ' M README.md' });
  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
        commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => error.code === 'PUBLICATION_SCOPE_VIOLATION',
  );
  assert.equal(fake.calls.some(({ args }) => args[0] === 'restore'), false);
});

test('pending publication은 정확히 한 개의 고정 메시지 non-merge commit만 허용한다', async (t) => {
  const cases = [
    {
      name: 'secret path를 추가했다 되돌린 두 commit',
      options: { initialAhead: 2, pendingPaths: ['private-secret.txt'] },
    },
    {
      name: '허용 path의 과거 blob을 숨긴 두 commit',
      options: { initialAhead: 2, pendingPaths: [DEVICE_PATH] },
    },
    {
      name: '고정 메시지와 다른 commit',
      options: { initialAhead: 1, pendingMessage: 'forged publication' },
    },
    {
      name: 'merge commit',
      options: { initialAhead: 1, pendingParentCount: 2 },
    },
    {
      name: '허용 path를 삭제한 commit',
      options: { initialAhead: 1, pendingStatuses: ['D'] },
    },
    {
      name: 'HEAD와 working blob이 다른 commit',
      options: { initialAhead: 1, workingBlobOid: '7'.repeat(40) },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-history-test-'));
      try {
        await mkdir(path.join(cwd, '.git'), { recursive: true });
        const fake = publicationRunner({ cwd, staged: false, ...fixture.options });
        await assert.rejects(
          publishChanges({
            cwd,
            runner: fake.runner,
            resolvePlan: async () => ({
              allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
              build: async () => ({ stagePaths: [DEVICE_PATH] }),
              validate: async () => true,
            }),
          }),
          (error) => error.code === 'LOCAL_HISTORY_UNSAFE',
        );
        assert.equal(fake.pushCount, 0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test('유효한 pending publication에 새 수집 변경이 있으면 새 commit 대신 amend한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({ cwd, initialAhead: 1 });
  const result = await publishChanges({
    cwd,
    runner: fake.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => ({ stagePaths: [DEVICE_PATH] }),
      validate: async () => true,
    }),
  });

  assert.equal(result.status, 'pushed');
  assert.ok(fake.calls.some(
    ({ args }) => args.join(' ') === `commit --no-gpg-sign --amend --no-edit -- ${DEVICE_PATH}`,
  ));
  assert.equal(fake.calls.some(({ args }) => args[0] === 'commit' && args.includes('-m')), false);
});

test('주입 API도 push 상한을 세 번보다 크게 늘릴 수 없다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({ cwd });
  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      maxPushAttempts: 4,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => error.code === 'INVALID_PUBLICATION_PLAN',
  );
  assert.equal(fake.calls.length, 0);
});

test('non-fast-forward는 자기 path가 그대로일 때만 rebase 후 최대 범위에서 재시도한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    remoteChangedPaths: [OTHER_DEVICE_PATH],
    pushResults: [
      failed('! [rejected] main -> main (non-fast-forward)'),
      ok(),
    ],
  });
  let validationCount = 0;

  const result = await publishChanges({
    cwd,
    runner: fake.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH, PROFILE_PATH],
      collisionPaths: [DEVICE_PATH, PROFILE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => ({ stagePaths: [DEVICE_PATH] }),
      validate: async () => { validationCount += 1; },
    }),
  });

  assert.equal(result.status, 'pushed');
  assert.equal(result.attempts, 2);
  assert.equal(fake.pushCount, 2);
  assert.ok(validationCount >= 2, 'rebase 이후 최신 데이터도 다시 검증한다');
  assert.ok(fake.calls.some(
    ({ args }) => args.join(' ') === [
      'rebase',
      '--no-update-refs',
      '--no-autostash',
      '--no-rebase-merges',
      '--no-gpg-sign',
      'refs/remotes/origin/main',
    ].join(' '),
  ));
  assert.ok(fake.calls.every(({ args }) => !args.includes('--force')));
  assert.ok(fake.calls.every(({ args }) => !args.includes('--ours') && !args.includes('--theirs')));
});

test('push 오류 문구가 없어도 원격 ref 전진을 확인해 bounded rebase를 수행한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed('전송 계층 오류'), ok()],
  });
  const result = await publishChanges({
    cwd,
    runner: fake.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => ({ stagePaths: [DEVICE_PATH] }),
      validate: async () => true,
    }),
  });

  assert.equal(result.status, 'pushed');
  assert.equal(result.attempts, 2);
  assert.equal(fake.pushCount, 2);
});

test('push 응답 유실 뒤 fetched remote가 HEAD를 포함하면 재충돌 없이 게시 성공으로 본다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed('transport reset')],
    localHeadPublished: true,
  });
  const result = await publishChanges({
    cwd,
    runner: fake.runner,
    resolvePlan: async () => ({
      allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
      build: async () => ({ stagePaths: [DEVICE_PATH] }),
      validate: async () => true,
    }),
  });

  assert.equal(result.status, 'pushed');
  assert.equal(result.attempts, 1);
  assert.equal(fake.pushCount, 1);
  assert.equal(fake.calls.some(({ args }) => args[0] === 'rebase'), false);
});

test('rebase 성공 후 hook이 tracked file을 더럽히면 다음 push 전에 중단한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed('non-fast-forward'), ok()],
    statusAfterRebase: ` M ${DEVICE_PATH}`,
  });

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => error.code === 'PUBLICATION_SCOPE_VIOLATION',
  );
  assert.equal(fake.pushCount, 1);
});

test('계속되는 non-fast-forward는 총 세 번의 push 뒤 중단한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [
      failed('non-fast-forward'),
      failed('non-fast-forward'),
      failed('non-fast-forward'),
    ],
  });

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      maxPushAttempts: 3,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => error.code === 'PUSH_RETRY_EXHAUSTED',
  );
  assert.equal(fake.pushCount, 3);
  assert.equal(
    fake.calls.filter(
      ({ args }) => args.join(' ') === [
        'rebase',
        '--no-update-refs',
        '--no-autostash',
        '--no-rebase-merges',
        '--no-gpg-sign',
        'refs/remotes/origin/main',
      ].join(' '),
    ).length,
    2,
  );
});

test('NFF 뒤 원격에서 자기 device/profile path가 바뀌면 collision으로 즉시 중단한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed('fetch first (non-fast-forward)')],
    remoteChangedPaths: [DEVICE_PATH],
  });

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH, PROFILE_PATH],
        collisionPaths: [DEVICE_PATH, PROFILE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => error instanceof GitPublishError && error.code === 'REMOTE_PATH_COLLISION',
  );
  assert.equal(fake.pushCount, 1);
  assert.equal(fake.calls.some(({ args }) => args[0] === 'rebase'), false);
});

test('NFF 뒤 원격 code/config 변경은 현재 process rebase 전에 중단한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed('fetch first (non-fast-forward)')],
    remoteChangedPaths: ['package.json'],
  });

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
        collisionPaths: [DEVICE_PATH],
        commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => error.code === 'REMOTE_UPDATE_REQUIRES_RESTART',
  );
  assert.equal(fake.pushCount, 1);
  assert.equal(fake.calls.some(({ args }) => args[0] === 'rebase'), false);
});

test('rebase conflict는 abort하고 commit을 보존하며 raw stderr를 노출하지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed('non-fast-forward')],
    rebaseResult: failed('CONFLICT C:\\Users\\private\\secret.json'),
  });

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => {
      assert.equal(error.code, 'REBASE_CONFLICT');
      assert.doesNotMatch(String(error), /Users|private|secret/);
      return true;
    },
  );
  assert.ok(fake.calls.some(({ args }) => args.join(' ') === 'rebase --abort'));
});

test('auth/기타 push 실패는 안전한 코드만 반환하고 로컬 commit을 보존한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const fake = publicationRunner({
    cwd,
    pushResults: [failed("fatal: Authentication failed for 'https://token@github.com/private'")],
  });

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
      commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => ({ stagePaths: [DEVICE_PATH] }),
        validate: async () => true,
      }),
    }),
    (error) => {
      assert.equal(error.code, 'PUSH_AUTH_FAILED');
      assert.doesNotMatch(String(error), /token|github\.com\/private/);
      return true;
    },
  );
  assert.equal(fake.calls.some(({ args }) => args[0] === 'reset'), false);
});

test('sync는 임시 snapshot을 검증하고 최신 writer ownership 확인 후 자신의 성공 경로만 게시한다', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, '.agent-card.local.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  }));
  await writeFile(path.join(cwd, ...DEVICE_PATH.split('/')), JSON.stringify(snapshot()));

  let capturedPlan;
  let validationCount = 0;
  const result = await synchronizeDevice({
    cwd,
    publishChangesImpl: async ({ resolvePlan }) => {
      capturedPlan = await resolvePlan();
      await capturedPlan.validate();
      const built = await capturedPlan.build();
      await capturedPlan.validate();
      return { status: 'noop', ...built };
    },
    collectSnapshot: async ({ snapshotPath }) => {
      const previous = JSON.parse(await readFile(snapshotPath, 'utf8'));
      assert.equal(previous.writerKeyHash, WRITER_KEY_HASH, 'latest snapshot으로 temp를 seed한다');
      const next = snapshot();
      await writeFile(snapshotPath, JSON.stringify(next));
      return next;
    },
    collectProfile: async () => {
      const error = new Error('expired private bearer');
      error.code = 'AUTH_FAILED';
      throw error;
    },
    validateRepository: async () => { validationCount += 1; },
  });

  assert.equal(result.status, 'noop');
  assert.deepEqual(capturedPlan.allowedPaths, [DEVICE_PATH, PROFILE_PATH]);
  assert.deepEqual(result.stagePaths, [DEVICE_PATH]);
  assert.equal(result.profileErrorCode, 'AUTH_FAILED');
  assert.ok(validationCount >= 2);
  assert.doesNotMatch(capturedPlan.commitMessage, new RegExp(`${DEVICE_ID}|${WRITER_KEY}|\\d{4,}`));
});

test('수집 중 원격 기준 writer가 바뀌면 기존 파일을 덮거나 stage하지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, '.agent-card.local.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  }));
  const destination = path.join(cwd, ...DEVICE_PATH.split('/'));
  await writeFile(destination, JSON.stringify(snapshot()));

  await assert.rejects(
    synchronizeDevice({
      cwd,
      publishChangesImpl: async ({ resolvePlan }) => {
        const plan = await resolvePlan();
        return plan.build();
      },
      collectSnapshot: async ({ snapshotPath }) => {
        const next = snapshot();
        await writeFile(snapshotPath, JSON.stringify(next));
        await writeFile(destination, JSON.stringify(snapshot('f'.repeat(64))));
        return next;
      },
      collectProfile: async () => { throw new Error('fallback'); },
      validateRepository: async () => true,
    }),
    (error) => error.code === 'WRITER_KEY_CONFLICT',
  );
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).writerKeyHash, 'f'.repeat(64));
});

test('sync는 build 뒤 checkpoint에서도 local config를 다시 읽고 변경 시 rollback한다', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  const configPath = path.join(cwd, '.agent-card.local.json');
  const config = {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  };
  await writeFile(configPath, JSON.stringify(config));
  const destination = path.join(cwd, ...DEVICE_PATH.split('/'));
  const originalContents = JSON.stringify(snapshot());
  await writeFile(destination, originalContents);

  await assert.rejects(
    synchronizeDevice({
      cwd,
      publishChangesImpl: async ({ resolvePlan }) => {
        const plan = await resolvePlan();
        await plan.validate();
        await plan.build();
        await writeFile(configPath, JSON.stringify({ ...config, timezone: 'UTC' }));
        try {
          await plan.validate();
        } catch (error) {
          await plan.rollback();
          throw error;
        }
        throw new Error('unreachable');
      },
      collectSnapshot: async ({ snapshotPath }) => {
        const next = { ...snapshot(), generatedAt: '2026-07-19T01:00:00.000Z' };
        await writeFile(snapshotPath, JSON.stringify(next));
        return next;
      },
      collectProfile: async () => { throw new Error('fallback'); },
      validateRepository: async () => true,
    }),
    (error) => error.code === 'LOCAL_CONFIG_CHANGED',
  );
  assert.equal(await readFile(destination, 'utf8'), originalContents);
});

test('설치 후 repository validation이 실패하면 원래 snapshot을 복구하고 push를 막는다', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, '.agent-card.local.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  }));
  const destination = path.join(cwd, ...DEVICE_PATH.split('/'));
  const original = snapshot();
  const originalContents = `  ${JSON.stringify(original, null, 4)}\r\n`;
  await writeFile(destination, originalContents);
  let validations = 0;

  await assert.rejects(
    synchronizeDevice({
      cwd,
      publishChangesImpl: async ({ resolvePlan }) => {
        const plan = await resolvePlan();
        await plan.validate();
        await plan.build();
        try {
          await plan.validate();
        } catch (error) {
          await plan.rollback();
          throw error;
        }
        throw new Error('unreachable');
      },
      collectSnapshot: async ({ snapshotPath }) => {
        const next = {
          ...snapshot(),
          generatedAt: '2026-07-19T01:00:00.000Z',
        };
        await writeFile(snapshotPath, JSON.stringify(next));
        return next;
      },
      collectProfile: async () => { throw new Error('fallback'); },
      validateRepository: async () => {
        validations += 1;
        if (validations === 2) {
          throw new Error('C:\\Users\\private\\invalid public file');
        }
        return true;
      },
    }),
  );
  assert.equal(await readFile(destination, 'utf8'), originalContents);
});

test('sync commit 실패는 원래 raw bytes를 복구하고 public temp를 남기지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, '.agent-card.local.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  }));
  const destination = path.join(cwd, ...DEVICE_PATH.split('/'));
  const originalContents = `\n${JSON.stringify(snapshot(), null, 3)}\r\n`;
  await writeFile(destination, originalContents);
  const fake = publicationRunner({ cwd, commitResult: failed('private hook output') });

  await assert.rejects(
    synchronizeDevice({
      cwd,
      gitRunner: fake.runner,
      collectSnapshot: async ({ snapshotPath }) => {
        const next = { ...snapshot(), generatedAt: '2026-07-19T01:00:00.000Z' };
        await writeFile(snapshotPath, JSON.stringify(next));
        return next;
      },
      collectProfile: async () => { throw new Error('fallback'); },
      validateRepository: async () => true,
    }),
    (error) => error.code === 'COMMIT_FAILED',
  );

  assert.equal(await readFile(destination, 'utf8'), originalContents);
  const publicEntries = await defaultFileSystem.readdir(path.dirname(destination));
  assert.equal(publicEntries.some((name) => /\.(?:tmp|restore)$/u.test(name)), false);
  assert.ok(fake.calls.some(({ args }) => args[0] === 'restore' && args.includes('--staged')));
});

test('post-commit validation 실패는 commit 아래의 pre-build bytes로 rollback하지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  const destination = path.join(cwd, ...DEVICE_PATH.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, 'original\n');
  const fake = publicationRunner({ cwd });
  let validations = 0;
  let rollbacks = 0;
  let completions = 0;

  await assert.rejects(
    publishChanges({
      cwd,
      runner: fake.runner,
      resolvePlan: async () => ({
        allowedPaths: [DEVICE_PATH],
        commitMessage: 'feat(data): anonymized usage snapshot update',
        build: async () => {
          await writeFile(destination, 'committed\n');
          return { stagePaths: [DEVICE_PATH] };
        },
        validate: async () => {
          validations += 1;
          if (validations === 4) {
            throw new Error('post-commit validation failed');
          }
        },
        rollback: async () => {
          rollbacks += 1;
          await writeFile(destination, 'original\n');
        },
        complete: async () => { completions += 1; },
      }),
    }),
    (error) => error.code === 'VALIDATION_FAILED',
  );

  assert.equal(await readFile(destination, 'utf8'), 'committed\n');
  assert.equal(rollbacks, 0);
  assert.equal(completions, 0);
  assert.ok(fake.calls.some(({ args }) => args[0] === 'commit'));
});

test('sync uses App Server profile collection without credential environment variables', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, '.agent-card.local.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  }));
  await writeFile(path.join(cwd, ...DEVICE_PATH.split('/')), JSON.stringify(snapshot()));

  let runnerOptions;
  const result = await synchronizeDevice({
    cwd,
    env: {},
    now: () => new Date('2026-07-19T01:00:00.000Z'),
    publishChangesImpl: async ({ resolvePlan }) => {
      const plan = await resolvePlan();
      const built = await plan.build();
      return { status: 'noop', ...built };
    },
    collectSnapshot: async ({ snapshotPath }) => {
      const next = snapshot();
      await writeFile(snapshotPath, JSON.stringify(next));
      return next;
    },
    profileRunner: async (options) => {
      runnerOptions = options;
      return {
        dailyUsageBuckets: [{ startDate: '2026-07-18', tokens: 123 }],
        summary: {
          lifetimeTokens: 456,
          currentStreakDays: 7,
          peakDailyTokens: 123,
        },
      };
    },
    validateRepository: async () => true,
  });

  assert.equal(runnerOptions.cwd, cwd);
  assert.deepEqual(runnerOptions.env, {});
  assert.ok(result.stagePaths.includes(PROFILE_PATH));
  const candidate = JSON.parse(await readFile(
    path.join(cwd, ...PROFILE_PATH.split('/')),
    'utf8',
  ));
  assert.deepEqual(candidate.daily, [{ date: '2026-07-18', totalTokens: 123 }]);
  assert.equal(candidate.lifetimeTotalTokens, 456);
  assert.equal(JSON.stringify(candidate).includes('currentStreakDays'), false);
  assert.equal(JSON.stringify(candidate).includes('peakDailyTokens'), false);
});

test('profile collector가 반환한 invalid candidate는 fallback으로 숨기지 않는다', async (t) => {
  const cwd = await temporaryRepository(t);
  await mkdir(path.join(cwd, 'data', 'devices'), { recursive: true });
  await writeFile(path.join(cwd, '.agent-card.local.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    writerKey: WRITER_KEY,
    timezone: 'Asia/Seoul',
  }));
  const destination = path.join(cwd, ...DEVICE_PATH.split('/'));
  await writeFile(destination, JSON.stringify(snapshot()));

  await assert.rejects(
    synchronizeDevice({
      cwd,
      publishChangesImpl: async ({ resolvePlan }) => {
        const plan = await resolvePlan();
        return plan.build();
      },
      collectSnapshot: async ({ snapshotPath }) => {
        const next = snapshot();
        await writeFile(snapshotPath, JSON.stringify(next));
        return next;
      },
      collectProfile: async () => ({ bearer: 'private-secret' }),
      validateRepository: async () => true,
    }),
    (error) => error.code === 'PROFILE_CANDIDATE_INVALID',
  );
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), snapshot());
});

test('publish-cards는 render/validate 후 정확히 35개 카드만 bounded publisher에 넘긴다', async (t) => {
  const cwd = await temporaryRepository(t);
  const order = [];
  let capturedPlan;

  const result = await publishCards({
    cwd,
    asOf: '2026-07-19',
    renderCards: async () => { order.push('render'); },
    validateRepository: async () => { order.push('validate'); },
    publishChangesImpl: async ({ resolvePlan }) => {
      capturedPlan = await resolvePlan();
      await capturedPlan.build();
      await capturedPlan.validate();
      return { status: 'noop' };
    },
  });

  assert.equal(result.status, 'noop');
  assert.deepEqual(capturedPlan.allowedPaths, CARD_PATHS);
  assert.deepEqual(capturedPlan.collisionPaths, CARD_PATHS);
  assert.deepEqual(order, ['render', 'validate']);
});

test('publish-cards commit 실패는 35개 카드 raw bytes를 모두 복구한다', async (t) => {
  const cwd = await temporaryRepository(t);
  const originals = new Map();
  await mkdir(path.join(cwd, 'cards'), { recursive: true });
  for (const [index, cardPath] of CARD_PATHS.entries()) {
    const contents = `<?xml version="1.0"?>\r\n<svg data-original="${index}"></svg>\r\n`;
    originals.set(cardPath, contents);
    await writeFile(path.join(cwd, ...cardPath.split('/')), contents);
  }
  const fake = publicationRunner({ cwd, commitResult: failed('private hook output') });

  await assert.rejects(
    publishCards({
      cwd,
      asOf: '2026-07-19',
      gitRunner: fake.runner,
      renderCards: async () => {
        for (const cardPath of CARD_PATHS) {
          await writeFile(path.join(cwd, ...cardPath.split('/')), '<svg>changed</svg>\n');
        }
      },
      validateRepository: async () => true,
    }),
    (error) => error.code === 'COMMIT_FAILED',
  );

  for (const cardPath of CARD_PATHS) {
    assert.equal(
      await readFile(path.join(cwd, ...cardPath.split('/')), 'utf8'),
      originals.get(cardPath),
    );
  }
  const publicEntries = await defaultFileSystem.readdir(path.join(cwd, 'cards'));
  assert.equal(publicEntries.some((name) => /\.(?:tmp|restore)$/u.test(name)), false);
});

test('publish-cards의 실제 renderCards/validateRepository programmatic API가 호환된다', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-card-publish-api-test-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));

  const result = await publishCards({
    cwd,
    asOf: '2026-07-19',
    publishChangesImpl: async ({ resolvePlan }) => {
      const plan = await resolvePlan();
      const built = await plan.build();
      await plan.validate();
      return { status: 'noop', ...built };
    },
  });

  assert.equal(result.status, 'noop');
  for (const cardPath of CARD_PATHS) {
    assert.match(await readFile(path.join(cwd, ...cardPath.split('/')), 'utf8'), /<svg\b/u);
  }
});
