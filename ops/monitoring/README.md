# Risk Alerts: Email + Telegram

This package enables automated risk monitoring with alerts through:

- Email (SMTP)
- Telegram Bot

## 1) Required env vars

Add these keys to `/var/www/minhoo-api/minhoo_api/.env`:

```dotenv
# Existing (email)
RISK_ALERT_EMAIL=info@minhoo.app
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=your-user
EMAIL_PASS=your-pass
EMAIL_FROM=Minhoo <noreply@minhoo.app>
EMAIL_ALLOW_INSECURE_TLS=0

# New (telegram)
RISK_ALERT_TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=123456:abcDEF...
TELEGRAM_CHAT_ID=-1001234567890
# Optional (forum topic/thread id)
TELEGRAM_THREAD_ID=

# Optional (transport)
TELEGRAM_HTTP_FAMILY=4

# Capacity thresholds (70/80/90 policy)
RISK_BASELINE_SAFE_RPS=55
RISK_CAPACITY_WARN_PCT=70
RISK_CAPACITY_SCALE_PCT=80
RISK_CAPACITY_CRITICAL_PCT=90
RISK_MIN_MEM_AVAILABLE_MB=700
RISK_LOAD_WARN_FACTOR=1.75
RISK_LOAD_CRITICAL_FACTOR=2.2
RISK_SCALE_ACTION_HINT=Scale now: increase VM size or add a second host.
RISK_MONITOR_STATE_FILE=/tmp/minhoo-risk-monitor-state.json
```

## 2) Test notifications manually

```bash
cd /var/www/minhoo-api/minhoo_api
node scripts/postdeploy-risk-watch.js --send-test-email --send-test-telegram
```

You can also send both with one flag:

```bash
node scripts/postdeploy-risk-watch.js --send-test-all
```

## 3) Install automatic timer (every 1 minute)

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/monitoring/install-risk-monitor.sh
```

## 4) Verify runtime

```bash
systemctl status minhoo-risk-monitor.timer --no-pager -n 30
systemctl list-timers minhoo-risk-monitor.timer
journalctl -u minhoo-risk-monitor.service --since "30 min ago" --no-pager
```

If you are using cron fallback:

```bash
crontab -l
tail -n 200 /var/www/minhoo-api/backups/risk-monitor-cron.log
```

## 5) Capacity policy and runbook

- Policy: `/var/www/minhoo-api/minhoo_api/ops/monitoring/CAPACITY_SCALING_POLICY.md`
- Incident runbook: `/var/www/minhoo-api/minhoo_api/ops/RUNBOOK_INCIDENT_RESPONSE.md`

## 6) Feed cache monitor (Cloudflare + summary cache)

Install automatic timer (every 5 minutes):

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/monitoring/install-feed-cache-monitor.sh
```

Manual run:

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:cache:feeds -- --cycles=1 --strict --auth-token=TU_TOKEN
```

Verify runtime:

```bash
systemctl status minhoo-feed-cache-monitor.timer --no-pager -n 30
systemctl list-timers minhoo-feed-cache-monitor.timer
journalctl -u minhoo-feed-cache-monitor.service --since "60 min ago" --no-pager
```

Alert behavior:

- If strict monitor fails, systemd triggers `minhoo-feed-cache-alert.service` via `OnFailure=`.
- Alert channels:
  - Email: `FEED_CACHE_ALERT_EMAIL_ENABLED=1` + `FEED_CACHE_ALERT_EMAIL` (fallback `RISK_ALERT_EMAIL`) + `EMAIL_*`
  - Telegram: `TELEGRAM_BOT_TOKEN` + `FEED_CACHE_ALERT_TELEGRAM_CHAT_ID` (fallback `TELEGRAM_CHAT_ID`)
  - Optional network family: `FEED_CACHE_ALERT_TELEGRAM_HTTP_FAMILY=4` (fallback `TELEGRAM_HTTP_FAMILY`)
- Anti-spam cooldown: `FEED_CACHE_ALERT_COOLDOWN_SECONDS` (default 900s)

Manual alert test:

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:alert:cache:feeds:test
```

Check alert logs:

```bash
journalctl -u minhoo-feed-cache-alert.service --since "60 min ago" --no-pager
```

## 7) Feed SLO monitor (Day 1 baseline)

Manual run:

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:slo:feeds -- --strict
```

JSON output:

```bash
npm run -s ops:monitor:slo:feeds -- --strict --json
```

Reference:

- `/var/www/minhoo-api/minhoo_api/ops/monitoring/SLO_FEED_DAY1.md`

## 8) Feed SLO sampling (24h) + automatic daily report

Install timers/services:

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/monitoring/install-feed-slo-monitoring.sh
```

Manual sample run (append one JSONL sample):

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:slo:sample
```

Optional strict exit behavior (default collector mode does not fail systemd on SLO breach):

```bash
FEED_SLO_SAMPLE_FAIL_ON_BREACH=1 npm run -s ops:monitor:slo:sample
```

Manual 24h report run:

```bash
npm run -s ops:report:slo:feeds24h
```

Dry-run report (print only, no email/telegram):

```bash
npm run -s ops:report:slo:feeds24h -- --no-send
```

Verify runtime:

```bash
systemctl status minhoo-feed-slo-sampler.timer --no-pager -n 30
systemctl status minhoo-feed-slo-report.timer --no-pager -n 30
systemctl list-timers minhoo-feed-slo-sampler.timer minhoo-feed-slo-report.timer
journalctl -u minhoo-feed-slo-sampler.service --since "24 hours ago" --no-pager
journalctl -u minhoo-feed-slo-report.service --since "24 hours ago" --no-pager
```

## 9) Content idempotency monitor (POST /post + POST /reel)

Manual run:

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:idempotency
```

JSON output:

```bash
IDEMP_MONITOR_JSON=1 npm run -s ops:monitor:idempotency
```

Install automatic timer (every 5 minutes):

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/monitoring/install-idempotency-monitor.sh
```

Verify runtime:

```bash
systemctl status minhoo-idempotency-monitor.timer --no-pager -n 30
systemctl list-timers minhoo-idempotency-monitor.timer
journalctl -u minhoo-idempotency-monitor.service --since "60 min ago" --no-pager
journalctl -u minhoo-idempotency-alert.service --since "60 min ago" --no-pager
```

Key thresholds in `.env`:

- `IDEMP_MONITOR_LOOKBACK_MINUTES`
- `IDEMP_MONITOR_STUCK_MINUTES`
- `IDEMP_MONITOR_MAX_STUCK`
- `IDEMP_MONITOR_MIN_SAMPLES`
- `IDEMP_MONITOR_MAX_CONFLICT_RATE_PCT`
- `IDEMP_MONITOR_MAX_SERVER_ERROR_RATE_PCT`
- `IDEMP_MONITOR_REQUIRE_RECENT_ACTIVITY`

## 10) Chat SLO monitor (summary/list/message/send)

Manual run:

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:slo:chat -- --strict
```

JSON output:

```bash
CHAT_SLO_JSON=1 npm run -s ops:monitor:slo:chat
```

Install automatic timer (every 5 minutes):

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/monitoring/install-chat-slo-monitor.sh
```

Verify runtime:

```bash
systemctl status minhoo-chat-slo-monitor.timer --no-pager -n 30
systemctl list-timers minhoo-chat-slo-monitor.timer
journalctl -u minhoo-chat-slo-monitor.service --since "60 min ago" --no-pager
journalctl -u minhoo-chat-slo-alert.service --since "60 min ago" --no-pager
```

Key thresholds in `.env`:

- `CHAT_SLO_MIN_WINDOW_REQUESTS`
- `CHAT_SLO_MIN_ROUTE_SAMPLES`
- `CHAT_SLO_CHAT_SUMMARY_P95_MS`
- `CHAT_SLO_CHAT_MESSAGE_SUMMARY_P95_MS`
- `CHAT_SLO_CHAT_SEND_P95_MS`
- `CHAT_SLO_CHAT_FULL_P95_MS`
- `CHAT_SLO_MAX_5XX_PERCENT`
- `CHAT_SLO_MAX_429_PERCENT`
- `CHAT_SLO_MAX_4XX_PERCENT`
- `CHAT_SLO_STRICT_429`
- `CHAT_SLO_STRICT_4XX`
- `CHAT_SLO_REQUIRE_TRAFFIC`

24h burn-in report:

```bash
cd /var/www/minhoo-api/minhoo_api
sudo npm run -s ops:report:slo:chat24h -- --hours 24 --strict
```

JSON output:

```bash
CHAT_SLO_REPORT_JSON=1 sudo npm run -s ops:report:slo:chat24h
```

Mobile push/presence E2E checklist:

- `/var/www/minhoo-api/minhoo_api/ops/monitoring/CHAT_PUSH_PRESENCE_E2E.md`
