# Codex Renown Windows scheduled sync

Existing Agent Card Tracker installations must complete the [migration runbook](migration-codex-renown.md) before changing scheduler paths.

This guide runs the same `npm run sync` command with Windows Task Scheduler. Use a dedicated clone; scheduled sync refuses a linked worktree, the wrong repository/branch, or unrelated tracked changes.

## 1. Prepare the dedicated clone

Install Git, Node.js 24 or newer, and npm. Clone and initialize this computer with the same IANA timezone used by every other device:

```powershell
git clone https://github.com/jukrap/codex-renown.git D:\codex-renown
Set-Location D:\codex-renown
npm ci
npm run setup -- --timezone Asia/Seoul
npm run sync
```

The first manual sync proves that local collection, validation, the `origin/main` upstream, and Git push authentication all work. Run it as the same Windows user that will own the scheduled task. Do not copy `.agent-card.local.json` from another computer.

The clone is an operational directory, not a development checkout. Keep its tracked working tree clean. When `package-lock.json` changes after an update, run `npm ci` again from this directory.

## 2. Resolve the npm executable

Task Scheduler does not load an interactive PowerShell profile and may have a smaller `PATH`. Resolve the executable once:

```powershell
(Get-Command npm.cmd).Source
```

Record the absolute `npm.cmd` path returned on this computer. Do not guess a path from another machine.

Check `node --version` and `npm version` in the task's environment: both must use Node.js 24 or newer. Adding another Node directory to `PATH` may not change the runtime used by an existing `npm.cmd`, which can select the `node.exe` beside it. Use npm from the intended Node installation and verify again after changing a scheduled task.

## 3. Create the Task Scheduler task

Open **Task Scheduler** and choose **Create Task**.

On **General**:

- use the same user that completed the manual Git push;
- use the least privilege needed and leave **Run with highest privileges** off;
- choose **Run only when user is logged on** if your Git credential manager requires an interactive user session.

On **Triggers**, add a daily trigger after normal development activity. The exact minute does not need to match GitHub Actions.

On **Actions**, create **Start a program** with:

- **Program/script**: the absolute `npm.cmd` path found above
- **Add arguments**: `run sync`
- **Start in (optional)**: `D:\codex-renown`

The **Start in** value is required in practice: it is the sync working directory containing `.agent-card.local.json`, `package.json`, and the target Git repository. Do not include quotes around the value in that field.

On **Conditions**, enable network availability if appropriate for the computer. On **Settings**:

- allow the task to run as soon as possible after a missed start;
- stop it after a bounded period suitable for the connection;
- if the task is already running, choose **Do not start a new instance**.

The application also takes a process lock, but preventing an overlapping task gives clearer Task Scheduler history.

## 4. Environment and credentials

The IANA timezone and anonymous writer identity are in the ignored local config, so they do not depend on the scheduler environment. Git credentials must be available non-interactively to the task's user. Prefer Git Credential Manager or another user-scoped credential facility with access limited to this repository.

For account-wide Codex totals, install a recent Codex CLI and complete its ChatGPT sign-in as the same Windows user that owns the task. When both the desktop app and npm CLI are installed, the collector automatically prefers the npm package's native binary beside the `codex` shim instead of the packaged WindowsApps `codex.exe`. Task Scheduler may have a smaller `PATH`; if automatic discovery cannot find that binary, add the npm CLI directory to that user's environment or set the non-secret `AGENT_CARD_CODEX_BIN` environment variable to the executable's absolute path.

Successful sync output says `account profile updated` when account-wide usage was collected and `device fallback` when only local-log totals were published.

Do not copy CLI authentication files or place credentials in **Add arguments**, a PowerShell command string, exported task XML, repository files, wrappers, or captured logs. If the CLI is missing, signed in only with an API key, or does not support App Server account usage, sync still publishes local Codex aggregates and rendering falls back to device totals. Git credentials must remain available non-interactively to the task's user.

## 5. Test and monitor

In Task Scheduler, right-click the task and choose **Run**. Confirm:

1. the task finishes successfully;
2. `data/devices/` receives only this device's sanitized snapshot change;
3. the commit reaches `origin/main` or the command reports no change;
4. the **Render Codex Renown cards** GitHub Actions workflow finishes afterward.

The command output is deliberately limited, but scheduler history and any extra logs still reveal execution times. Restrict their access and retention. Never enable shell tracing around collection or print the scheduled user's environment.

For a manual check from the same working directory and user:

```powershell
Set-Location D:\codex-renown
npm run sync
npm run validate
```

## Recovery

- **Task cannot find npm or node:** re-check the absolute `npm.cmd` path and the scheduled user's environment, then run the task interactively as that user.
- **Authentication failure:** repair Git credentials for that user and rerun. The local commit is preserved; do not force-push.
- **Dirty working tree:** remove the operational clone's unrelated edits or create a fresh dedicated clone and a fresh device config. Do not copy the old config between computers.
- **Device/profile ownership collision:** stop every task using the duplicated config, identify the real owner, and create a fresh config for the duplicate device. Resolve overlapping raw logs before syncing.
- **`REMOTE_UPDATE_REQUIRES_RESTART`:** disable the task, update the dedicated clone from `origin/main` without force-pushing, run `npm ci --ignore-scripts` and `npm run validate`, then launch a fresh sync. If one verified publication commit was preserved, rebase only that commit and abort on any conflict.
- **Stale card:** run `npm run sync`, then manually dispatch **Render Codex Renown cards**. If Actions is unavailable, follow the `npm run publish-cards -- --as-of YYYY-MM-DD` recovery described in the README.

### SYNC_STALE_LOCK

The lock is fail-closed to avoid deleting a lock that another process replaced or reacquired after inspection. Do not remove it merely because its timestamp looks old.

1. In Task Scheduler, end the agent-card task and choose **Disable** so it cannot restart during recovery.
2. Verify that no `agent-card`, `npm`, or `node` process is running `sync`, `render`, or `publish-cards` for `D:\codex-renown`. Check Task Manager's **Details** and **Command line** columns and the task history. If you cannot prove which clone a remaining process owns, leave the task disabled and do not delete the lock until that process has exited; a reboot with the task still disabled is the conservative fallback.
3. Inspect the exact lock file without editing it:

   ```powershell
   Get-Content -LiteralPath 'D:\codex-renown\.git\agent-card-sync.lock'
   ```

4. Only after the process check is clear, delete that one file:

   ```powershell
   Remove-Item -LiteralPath 'D:\codex-renown\.git\agent-card-sync.lock'
   ```

5. Keep the task disabled, rerun the original `npm run sync`, `npm run render -- --as-of YYYY-MM-DD`, or `npm run publish-cards -- --as-of YYYY-MM-DD` command manually, and re-enable the task only after it finishes.

Never use `Remove-Item -Recurse`, a wildcard, or a command targeting `.git` as a whole for this recovery.

When retiring this computer, disable the task first. Keeping its public device snapshot preserves its historical contribution and eventually marks it stale; deleting that snapshot removes its history from later cards.
