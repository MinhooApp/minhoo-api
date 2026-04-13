# Production Scale Package (Blue/Green)

This folder contains ready-to-apply server config for:

- `minhoo-api.service` (blue instance on `:3000`, hardened)
- `minhoo-api-green.service` (second Node instance on `:3001`)
- Nginx upstream load balancing (`:3000` + `:3001`)
- Nginx auth throttling and `/api/v1/internal/*` localhost-only protection
- MySQL tuning drop-in (`max_connections`, `thread_cache_size`, `innodb_buffer_pool_size`)
- Additional systemd hardening on green service (`PrivateDevices`, kernel protections, SUID restrictions)
- Automatic `.env.green` generation (copies `.env` and enforces `PORT=3001`)
- Automatic feed cache warm-up after each blue/green restart (`bootstrap/home`, `post/reel summary`)

Application-level graceful shutdown is also supported via `SHUTDOWN_GRACE_MS` in env.

## Apply

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/prod-scale/apply-prod-scale.sh
```

If you also want to activate MySQL tuning immediately:

```bash
sudo bash ops/prod-scale/apply-prod-scale.sh --restart-mysql
```

Backups are created automatically:

- Nginx: `/etc/nginx/sites-backup/api.minhoo.xyz.bak.<timestamp>`
- systemd: `/etc/systemd/system/*.bak.<timestamp>`
- MySQL: `/etc/mysql/mysql.conf.d/*.bak.<timestamp>`
- Green env: `/var/www/minhoo-api/minhoo_api/.env.green.bak.<timestamp>` (if existed)

## Validate

```bash
systemctl status minhoo-api.service --no-pager -n 30
systemctl status minhoo-api-green.service --no-pager -n 30
curl -s http://127.0.0.1:3000/api/v1/ping
curl -s http://127.0.0.1:3001/api/v1/ping
curl -s -o /dev/null -w "blue_ready_http=%{http_code}\n" http://127.0.0.1:3000/api/v1/ready
curl -s -o /dev/null -w "green_ready_http=%{http_code}\n" http://127.0.0.1:3001/api/v1/ready
SMOKE_BASE_URL=http://127.0.0.1:3000 INTERNAL_DEBUG_TOKEN="$(awk -F= '/^INTERNAL_DEBUG_TOKEN=/{print $2}' .env)" npm run ops:smoke:release
```

Single-server go/no-go checklist:

```bash
cat ops/prod-scale/PROD_90_CHECKLIST.md
```

## Rollback

```bash
cd /var/www/minhoo-api/minhoo_api
sudo bash ops/prod-scale/rollback-prod-scale.sh
```

Rollback now restores both service backups when available:

- `/etc/systemd/system/minhoo-api.service.bak.*`
- `/etc/systemd/system/minhoo-api-green.service.bak.*`
