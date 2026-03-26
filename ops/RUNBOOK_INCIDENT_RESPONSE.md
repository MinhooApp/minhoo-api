# Incident Runbook (Production)

## Trigger

Runbook starts when monitor sends a `HIGH` risk alert or capacity reaches `>=80%`.

## First 5 minutes

1. Confirm alert details in Telegram/Email and monitor log.
2. Run quick health checks:

```bash
cd /var/www/minhoo-api/minhoo_api
node scripts/postdeploy-risk-watch.js
systemctl is-active minhoo-api nginx mysql redis-server
curl -s http://127.0.0.1:3000/api/v1/ping
```

3. Classify severity:

- `SEV-1`: service down, repeated failed checks, or capacity `>=90%`.
- `SEV-2`: latency degradation or capacity `80-89%`.
- `SEV-3`: warning-only signals (`70-79%`).

## Immediate actions

### SEV-2 (80-89%)

- Scale infrastructure immediately.
- Freeze deployments and schema changes.
- Monitor every minute for 15 minutes.

### SEV-1 (>=90% or service down)

- Scale now and apply temporary containment (reduce non-critical feed pressure).
- Restart affected service only if health checks are failing.
- Keep traffic controls until utilization is below 80%.

## Recovery verification

Keep incident open until all are true for 15 minutes:

- Services active.
- Ping endpoints stable.
- Capacity utilization below 70%.
- No new `HIGH` risks.

## Communication template

- Incident started: timestamp, severity, impact.
- Action taken: scale/contain/restart.
- Current status: recovering/stable.
- Incident closed: root cause + preventive action.

## Useful files

- Monitor script: `/var/www/minhoo-api/minhoo_api/scripts/postdeploy-risk-watch.js`
- Cron log: `/var/www/minhoo-api/backups/risk-monitor-cron.log`
- Scaling policy: `/var/www/minhoo-api/minhoo_api/ops/monitoring/CAPACITY_SCALING_POLICY.md`
