# Realtime Suite Stable (CI)

## Commands

- Local stable run:
  - `npm run test:realtime:suite:stable`
- CI mode (adds one extra retry to each test):
  - `npm run test:realtime:suite:ci`
- Stop on first failure:
  - `npm run test:realtime:suite:ci -- --bail`

## What it does

- Runs the realtime/regression suite in a fixed order.
- Logs in owner/viewer automatically and injects runtime tokens/env for each test.
- Adds cooldown pauses between tests.
- Retries known flaky tests by default (`chat`, `profile:saved-state`, `orbit:comment-realtime`).
- Includes locale regression for notifications (`test:notification:locale`).
- Prints a final pass/fail summary and exits with code `1` if any test fails.

## Optional env vars

- `SUITE_OWNER_EMAIL`
- `SUITE_OWNER_PASSWORD`
- `SUITE_OWNER_LOGIN_UUID`
- `SUITE_VIEWER_EMAIL`
- `SUITE_VIEWER_PASSWORD`
- `SUITE_VIEWER_LOGIN_UUID`
- `SUITE_TEST_TIMEOUT_MS` (default `120000`)
- `SUITE_COOLDOWN_MS` (default `1200`)
- `SUITE_RETRY_COOLDOWN_MS` (default `2000`)
- `API_BASE_URL` (default `http://127.0.0.1:3000/api/v1`)
- `SOCKET_URL` (default `http://127.0.0.1:3000`)

## CI example

```bash
npm ci
npm run build
npm run test:realtime:suite:ci -- --bail
```

## GitHub Actions

- Workflow file:
  - `.github/workflows/realtime-suite.yml`
- Triggers:
  - `push` (`main`, `server`)
  - `pull_request` (target `main`, `server`)
  - `workflow_dispatch`

### GitHub Secrets required

- `CI_DB_HOST`
- `CI_DB_NAME`
- `CI_DB_USER`
- `CI_DB_PASSWORD`
- `CI_JWT_SECRET`
- `CI_SECRETORPRIVATEKEY`
- `SUITE_OWNER_EMAIL`
- `SUITE_OWNER_PASSWORD`
- `SUITE_VIEWER_EMAIL`
- `SUITE_VIEWER_PASSWORD`

Optional:
- `SUITE_OWNER_LOGIN_UUID`
- `SUITE_VIEWER_LOGIN_UUID`

### Branch protection (block merge if tests fail)

- Go to: `Settings > Branches > Branch protection rules`.
- Add rule for your target branch (for example `main`).
- Enable:
  - `Require a pull request before merging`
  - `Require status checks to pass before merging`
- Select the check:
  - `Realtime Stable Suite / Realtime Stable Suite`

### Block deploy if tests fail

- In your deploy workflow/job, add dependency on this check/job.
- If `Realtime Stable Suite` fails, deploy must not run.
