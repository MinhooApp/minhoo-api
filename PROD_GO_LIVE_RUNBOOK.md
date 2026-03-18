# PROD GO-LIVE RUNBOOK

## 1) Preflight (must pass before deploy)

Run in the server environment with production `.env` loaded:

```bash
npm run build
npm run ops:preflight:prod
```

Expected:
- `pass: true` in preflight output.
- No TypeScript build errors.

## 2) Required production env

Minimum secure values:

```bash
NODE_ENV=production
DB_SYNC_ON_BOOT=false
CORS_ORIGINS=https://app.example.com,https://www.example.com
CORS_ALLOW_ALL_IN_PROD=false
TRUST_PROXY=true
INTERNAL_DEBUG_TOKEN=<long-random-secret>
INTERNAL_DEBUG_IP_ALLOWLIST=<ip1>,<ip2>
```

Notes:
- `DB_SYNC_ON_BOOT` must be `false` in production.
- If `CORS_ALLOW_ALL_IN_PROD=true`, it is treated as a security warning.
- Internal debug endpoints in production require:
  - `x-internal-debug: true`
  - `x-internal-debug-token: <INTERNAL_DEBUG_TOKEN>`
  - client IP in `INTERNAL_DEBUG_IP_ALLOWLIST` when configured.

## 3) Database migration

```bash
npm run migration
```

If migration fails:
- stop deployment,
- fix migration issue,
- rerun migration before restart.

### 3.1) Legacy DB drift safeguard (important)

Before running migrations in older environments, check status:

```bash
node ./node_modules/sequelize-cli/lib/sequelize db:migrate:status --config config/config.js
```

If many migrations appear as `down` but tables/indexes already exist, do **not** run full `npm run migration` blindly.
That means `SequelizeMeta` is out of sync with the real schema.

In that case, use controlled baseline commands:

1. Dry-run (no changes, shows what would be marked):
```bash
npm run ops:baseline:sequelize-meta
```

2. Apply baseline only up to a safe cutoff migration:
```bash
npm run ops:baseline:sequelize-meta -- --apply --yes --through <migration-file.js>
```

3. If you intentionally want to mark all pending as applied:
```bash
npm run ops:baseline:sequelize-meta -- --apply --yes --all
```

4. Recheck status:
```bash
node ./node_modules/sequelize-cli/lib/sequelize db:migrate:status --config config/config.js
```

After baseline is correct, run only truly pending migrations:

```bash
npm run migration
```

## 4) Restart app

Use your process manager (systemd/pm2). Example with systemd:

```bash
sudo systemctl restart minhoo-api
sudo systemctl status minhoo-api --no-pager
```

## 5) Smoke tests after restart

```bash
SMOKE_BASE_URL=https://api.example.com \
SMOKE_AUTH_TOKEN=<real-jwt> \
INTERNAL_DEBUG_TOKEN=<same-token-as-env> \
npm run ops:smoke:release
```

Expected:
- `"pass": true`
- `ping`, `bootstrap_home`, `internal_summary_routes`, `internal_perf_check` all `ok: true`.

## 6) Quick manual checks

```bash
curl -s https://api.example.com/api/v1/ping
curl -s "https://api.example.com/api/v1/post?summary=1&size=20" -H "Authorization: Bearer <jwt>"
curl -s "https://api.example.com/api/v1/reel?summary=1&size=20" -H "Authorization: Bearer <jwt>"
curl -s "https://api.example.com/api/v1/bootstrap/home?include=posts,reels,services,notifications" -H "Authorization: Bearer <jwt>"
```

Inspect logs for:
- `[resp-metrics]`
- `[summary-metrics]`
- `[summary-compare]`
- `[bootstrap-metrics]`
- no unexpected `[summary-warning]` spikes.

## 7) Rollback procedure

If smoke fails or high error rate appears:

1. Revert to previous release artifact/commit.
2. Restart service:
```bash
sudo systemctl restart minhoo-api
```
3. Re-run:
```bash
npm run ops:smoke:release
```
4. Keep internal debug routes restricted.

## 8) Release gate

Go to production only if all are true:
- build passes,
- preflight passes,
- migration passes,
- smoke passes,
- no critical error spike after restart.
