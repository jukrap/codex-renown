# Compatibility and upgrades

## Verified baseline — 2026-10-02

| Component | Verified version | Evidence |
|---|---|---|
| Node.js | 24.19.0 on Windows | Repository quality gates |
| Codex CLI | 0.159.3 and 0.160.0 | Signed-in `account/usage/read`, normalized in memory |
| ccusage | 20.0.26, pinned | Empty history, synthetic cumulative events, and local history |
| actions/checkout | 7.0.1 | Workflow SHA verified against the upstream tag |
| actions/setup-node | 7.0.0 | Existing workflow SHA verified against the upstream tag |

These versions are a tested baseline, not a guarantee for future experimental App Server changes. The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes initialization and generating protocol schemas from the CLI being used.

## Account response compatibility

Recent CLIs add optional `threadUsage` to the account usage response. Older Renown versions reject that response with `INVALID_SCHEMA`, retaining the last account snapshot. Renown now accepts this field when absent, null, or an object, and discards its contents before creating public data. Only validated account daily totals, optional lifetime tokens, and coverage are published. No thread-specific request is made.

Unknown top-level fields, invalid totals, malformed dates, and protocol errors still fail closed. If account collection fails, the existing profile remains intact. An old account snapshot is not replaced with smaller local totals.

On Windows, native CLI discovery supports both nested and hoisted npm platform packages for x64 and arm64. It runs the native executable without a shell. `AGENT_CARD_CODEX_BIN` remains the absolute-path override.

## Update an existing clone

Stop its scheduled sync first. From a clean dedicated clone on `main`:

```console
node --version
npm version
codex --version
git pull --ff-only
npm ci --ignore-scripts
npm run check
npm run check:determinism -- --as-of 2026-10-02
npm run profile
npm run sync
```

Use today's date for `--as-of`. Confirm both `node --version` and the `node` entry in `npm version` are 24 or newer. On Windows, an npm wrapper may use its adjacent Node executable even when `PATH` contains a newer runtime.

`profile` writes a sanitized local profile candidate; it does not push. `sync` publishes the device snapshot and a fresh account candidate. Look for `account profile updated`, then verify the GitHub render workflow succeeds and the card's collection date changes. Resume the scheduler after those checks.

If collection reports `INVALID_SCHEMA` or `APP_SERVER_PROTOCOL`, record the safe error code and CLI version. Generate the experimental schema into ignored temporary storage for comparison:

```console
codex app-server generate-json-schema --experimental --out .agent-card-tmp/app-server-schema
```

Do not publish raw App Server responses, authentication files, or diagnostic output containing private account or thread details. A successful render alone does not prove that account collection succeeded.

## Dependency maintenance

Update ccusage's exact pin in `package.json`, `package-lock.json`, `src/collectors/ccusage.mjs`, and `THIRD_PARTY_NOTICES.md` together. Its installed-binary contract test checks cumulative event deduplication and the configured timezone's date boundary, not just an empty history.

GitHub Actions use full commit SHAs. Verify replacement SHAs against upstream tags and update the approved values in `test/workflows.test.mjs` with the workflows. Run syntax, tests, public-artifact validation, and deterministic rendering before merging dependency updates.
