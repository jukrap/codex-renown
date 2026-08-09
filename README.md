# Codex Renown

[한국어 문서](README.ko.md)

> Your Codex usage, told through milestones.

Codex Renown publishes account-wide Codex token usage as seven deterministic GitHub profile cards. It uses local collection, Git synchronization, and GitHub Actions, so no continuously running personal server is required.

Codex Renown is an unofficial community project. It is not affiliated with or endorsed by OpenAI. Its ranks and achievements are personal usage milestones, not global rankings or measures of productivity, code quality, or engineering impact.

## Cards

Seven card types are available:

- `overview.svg` — lifetime tokens, exact account total, current crest, next-rank progress, today, 7 days, 30 days, and active days
- `achievements.svg` — current crest, the 20-rank track, and four representative achievements
- `trophy-case.svg` — all 16 achievements across Renown, Momentum, Consistency, and Journey
- `records.svg` — peak day, best 7-day and 30-day windows, and best complete calendar month
- `trends.svg` — compact 30-day, 12-week, and 12-month charts
- `activity.svg` — a 53×7 heatmap, active days, streaks, and peak usage
- `compact.svg` — an optional 416×96 crest and rank badge

Recommended GitHub profile layout:

```html
<p>
  <img width="100%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/overview.svg" alt="Codex Renown overview">
</p>
<p>
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/achievements.svg" alt="Codex Renown rank achievements">
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/records.svg" alt="Codex Renown records">
</p>
<p>
  <img width="100%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/trophy-case.svg" alt="Codex Renown trophy case">
</p>
<p>
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/trends.svg" alt="Codex Renown trends">
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/activity.svg" alt="Codex Renown activity">
</p>
```

Use the compact alternative on its own when space is limited:

```html
<img width="416" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/compact.svg" alt="Codex Renown compact rank badge">
```

GitHub may cache raw files briefly after an update.

## Themes

Every card has automatic light/dark colors and five static theme families. The canonical filenames use `github`; the other themes add a suffix.

| Theme | Filename example |
|---|---|
| `github` | `overview.svg` |
| `midnight` | `overview-midnight.svg` |
| `aurora` | `overview-aurora.svg` |
| `ember` | `overview-ember.svg` |
| `monochrome` | `overview-monochrome.svg` |

Seven card types × five themes produce exactly 35 SVG files in the flat `cards/` allowlist. To switch themes, change every image URL to the same suffix; for example:

```html
<img width="100%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/overview-midnight.svg" alt="Codex Renown midnight overview">
```

All SVGs are self-contained and deterministic. They include `<title>/<desc>` accessibility metadata and use no external font, image, link, animation, or gradient.

## Ranks, crests, and achievements

Lifetime tokens alone determine the representative rank. Progress between thresholds is linear.

| Rank | Title | Minimum |
|---:|---|---:|
| I | Novice | 0 |
| II | Initiate | 10K |
| III | Apprentice | 50K |
| IV | Adept | 100K |
| V | Scout | 500K |
| VI | Adventurer | 1M |
| VII | Knight | 5M |
| VIII | Veteran | 10M |
| IX | Elite | 50M |
| X | Champion | 100M |
| XI | Hero | 500M |
| XII | Warlord | 1B |
| XIII | Overlord | 2.5B |
| XIV | Paragon | 5B |
| XV | Mythic | 10B |
| XVI | Ascendant | 25B |
| XVII | Immortal | 50B |
| XVIII | Sovereign | 100B |
| XIX | Eternal | 250B |
| XX | Transcendent | 1T |

Ranks I–IV are Common, V–VIII Uncommon, IX–XII Rare, XIII–XVI Epic, and XVII–XX Legendary. Each rank has a unique glyph; frame silhouette and one-to-four pips reinforce rarity without relying on color.

An exact lifetime of 19.3B is `Rank XV · Mythic`, about 62% from 10B to `Ascendant · 25B`. A device fallback is an observed lower bound, so the overview labels it `DEVICE FALLBACK` and keeps the title concise as `XIV · Paragon`, while totals and progress use `≥`. A missing lifetime after a successful update is `Unranked`; before the first successful sync, cards show `Not updated yet`. A lifetime of 1T or more is `MAX RANK`.

The 16 achievements cover cumulative renown, peak and rolling momentum, streak consistency, and active-day journey. A locked badge uses an outline; Unknown is dashed; unlocked state also has a visible marker. They are milestones defined by this project, not a percentile.

## Coverage and records

Missing dates become zero only inside declared coverage. Outside coverage they remain Unknown:

- `≥` and dashed outlines mean Partial, known lower-bound data.
- `—` and outline-only bars or cells mean Unknown.
- `0` means an observed zero and is not Unknown.

Account profile dates use the `Codex account calendar`; device fallback dates use the configured IANA timezone. The two date systems are never added together. Records consider only fully covered candidate windows, zero-fill missing dates inside coverage, and choose the earlier range on ties.

## How it works

1. On every computer, the pinned collector runs `ccusage codex` against that user's local history and reduces it to daily aggregates.
2. Each computer owns one `data/devices/<opaque-device-id>.json` and may publish one sanitized account profile candidate.
3. `npm run sync` validates and pushes only that computer's device/profile paths.
4. GitHub Actions merges public snapshots and deterministically renders all 35 allowlisted SVGs.

Git is the synchronization layer. GitHub Actions cannot read local logs or local CLI authentication.

## Requirements and quick start

- Node.js 24 or newer and npm
- Git
- a dedicated clone of `https://github.com/jukrap/codex-renown.git` on every participating computer
- non-interactive push authentication for scheduled runs
- one shared IANA timezone, such as `Asia/Seoul`

```console
git clone https://github.com/jukrap/codex-renown.git
cd codex-renown
npm ci
npm run setup -- --timezone Asia/Seoul
npm run sync
```

`setup` generates a different anonymous device ID and private writer key on each computer. Never copy `.agent-card.local.json`; copied identities create ownership conflicts and can double-count copied history.

The primary executable name is `codex-renown`. The legacy `agent-card` executable remains an alias. Existing npm script names, `.agent-card.local.json`, `AGENT_CARD_CODEX_BIN`, and `.git/agent-card-sync.lock` remain stable during migration.

For unattended collection, follow the [Windows Task Scheduler guide](docs/setup-windows.md) or the [macOS/Linux launchd and cron guide](docs/setup-unix.md). Existing installations should follow the [Codex Renown migration runbook](docs/migration-codex-renown.md) on every clone before resuming schedulers.

## Account profile and device fallback

`npm run profile` and `npm run sync` start the signed-in Codex CLI App Server with shell-free JSONL stdio, initialize experimental API support, and call `account/usage/read`. This is not screen scraping and does not require a bearer environment variable.

Account-wide collection requires a recent Codex CLI on `PATH` and a ChatGPT sign-in for the same operating-system user that runs sync. On Windows, discovery prefers the npm-installed native binary. Use the non-secret `AGENT_CARD_CODEX_BIN` absolute-path override only when discovery is insufficient.

Source selection is deterministic:

1. the newest valid account profile candidate; candidates up to 48 hours old are current, and older candidates remain as the clearly dated last account snapshot;
2. all devices' local Codex totals only when no retainable account snapshot exists;
3. a distinct `NOT UPDATED YET` state when no source has completed a successful sync.

The merger never adds account profile totals to local totals. Profile staleness changes the status label, not the selected data, so a scheduled render cannot replace previously published account totals with a smaller fallback. `npm run sync` reports `account profile updated` or `device fallback` explicitly. When account collection falls back, the same status line includes a sanitized error code such as `APP_SERVER_PROTOCOL` without exposing raw App Server output.

Authentication failure, missing CLI, unsupported method, timeout, protocol drift, or malformed output preserves the last valid profile candidate, which rendering keeps as the last account snapshot. API-key-only users and App Server environments without account usage can still publish device fallback cards from local logs.

Test account collection independently:

```console
npm run profile
```

## Public schema and privacy boundary

Public device snapshots and profile candidates use schema version 2 and permit only the Codex source. Public artifacts may contain opaque device identity, writer-key hash, collection time, timezone, sanitized status, daily token aggregates, optional session counts, account daily totals, lifetime total, and coverage.

They do not contain raw logs, prompts, responses, project names, file paths, session IDs, email, hostname, username, Git credentials, API keys, CLI authentication state, stderr, or App Server response bodies. Exact JSON and 35-card allowlists reject unknown fields and unlisted files; the SVG validator rejects active or external content.

The aggregate is intentionally public and can reveal token volume, active dates, timezone, collection cadence, and stale-device events. Use a private repository if that metadata is too sensitive. Git history retains previously committed aggregates.

See [SECURITY.md](SECURITY.md) for reporting and threat boundaries.

## Automation and recovery

The render workflow runs after data pushes, daily off the hour, and by manual dispatch. Scheduled workflows are best effort: runs may be delayed or dropped and can disable schedules after 60 days without repository activity.

If cards are stale:

1. run `npm run sync`;
2. inspect or dispatch **Render Codex Renown cards** in GitHub Actions;
3. if Actions is unavailable, run `npm run publish-cards -- --as-of YYYY-MM-DD`.

The recovery command renders, validates, and stages only the 35 card paths with bounded conflict handling. Sync never force-pushes. `REMOTE_UPDATE_REQUIRES_RESTART` means upstream code or configuration changed: stop the scheduler, update the clone, run `npm ci --ignore-scripts` and `npm run validate`, then start a fresh sync.

`sync`, `render`, and `publish-cards` share `.git/agent-card-sync.lock`. On `SYNC_STALE_LOCK`, stop the scheduler and prove that no process uses that clone before deleting only that exact lock file. Never recursively clean `.git`.

## Local commands

```console
npm run collect
npm run profile
npm run render -- --as-of YYYY-MM-DD
npm run validate
npm run check:determinism -- --as-of YYYY-MM-DD
npm run publish-cards -- --as-of YYYY-MM-DD
npm run check
```

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).