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
