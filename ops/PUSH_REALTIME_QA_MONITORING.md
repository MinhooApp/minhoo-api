# Push + Realtime QA & Monitoring

## Scope

This package covers points 4, 5, and 6:

1. CI gate for realtime regression suite.
2. QA flow for localized notifications/push (ES/EN).
3. Runtime monitoring for push + realtime health.

## 4) CI Gate (push/PR)

### Applied in repository

- Workflow: `.github/workflows/realtime-suite.yml`
- Triggers:
  - `push` on `main`, `server`
  - `pull_request` targeting `main`, `server`
  - `workflow_dispatch`
- Required suite command:
  - `npm run test:realtime:suite:ci -- --bail`

### Branch protection (GitHub UI)

To block merge/deploy when the suite fails, enable in GitHub:

1. `Settings > Branches > Branch protection rules`.
2. Rule for `main`.
3. Enable:
   - `Require a pull request before merging`
   - `Require status checks to pass before merging`
4. Select check:
   - `Realtime Stable Suite / Realtime Stable Suite`

## 5) QA Final (App closed + language)

### Automated backend QA (language routing)

Run:

```bash
npm run test:notification:locale
```

What it validates:

- Receiver language `es` => notification text in Spanish.
- Receiver language `en` => notification text in English.
- Language is updated through profile endpoint and restored at the end.

### Manual device QA matrix (required)

Test both Android and iOS, with app states:

- `foreground`
- `background`
- `terminated` (fully closed)

For each state, validate in both app languages:

- `es`
- `en`

Expected:

1. Push banner appears (not only sound).
2. Push title/body follow receiver language.
3. Tap push opens the correct screen (chat/post/orbit).
4. In-app notification list matches language behavior.

### Fast operational log checks

```bash
sudo journalctl -u minhoo-api -n 120 --no-pager | rg "\[push\]|✅ Push|\[realtime-direct\]"
```

## 6) Monitoring & Alerts (realtime/push)

### New monitor command

```bash
npm run ops:monitor:realtime-push
```

Useful flags:

```bash
node ./scripts/monitor-realtime-push-health.js --minutes 30 --strict
node ./scripts/monitor-realtime-push-health.js --minutes 15 --json
node ./scripts/monitor-realtime-push-health.js --minutes 10 --max-http-5xx 0 --min-realtime-events 1
```

What it detects:

- Push disabled by missing Firebase credentials.
- Push send errors.
- Realtime activity drop.
- HTTP 5xx spikes from `resp-metrics` logs.
- Performance warning emissions.

Exit codes:

- `0`: healthy (or only non-strict warnings)
- `1`: high risk detected (or warnings in `--strict` mode)

### Cron example (every 5 minutes)

```bash
*/5 * * * * cd /var/www/minhoo-api/minhoo_api && /usr/bin/node ./scripts/monitor-realtime-push-health.js --minutes 10 --strict >> /var/log/minhoo-realtime-push-monitor.log 2>&1
```

