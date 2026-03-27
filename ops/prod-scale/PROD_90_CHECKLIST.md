# Minhoo API - Single Server 90% Checklist

Use this checklist before scaling to more users.  
Target: secure, stable, and fast on one server first.

## Security

- [ ] `INTERNAL_DEBUG_ALLOW_REMOTE=0`
- [ ] `INTERNAL_DEBUG_TOKEN` configured
- [ ] `CORS_ALLOW_ALL_IN_PROD=false`
- [ ] `CORS_ORIGINS` contains only trusted domains
- [ ] Auth and app route rate limits configured in `.env`

## Runtime Stability

- [ ] `SHUTDOWN_GRACE_MS` >= `15000`
- [ ] `HTTP_SOCKET_TIMEOUT_MS` >= `30000`
- [ ] `HTTP_MAX_HEADERS_COUNT` >= `64`
- [ ] `HTTP_MAX_REQUESTS_PER_SOCKET` >= `500`
- [ ] `DB_SYNC_ON_BOOT=false` in production

## Health Probes

- [ ] `GET /api/v1/live` returns `200`
- [ ] `GET /api/v1/ready` returns `200` (or `503` if DB is not ready)
- [ ] Ready endpoint is used by orchestrator/load balancer (not ping)

## Performance Baseline

- [ ] `npm run ops:preflight:prod` has `error_count = 0`
- [ ] P95 API latency under target in production logs
- [ ] No persistent `Skipped frames` style backend stalls (CPU saturation)
- [ ] DB pool settings validated against real concurrent traffic

## Operational Commands

```bash
cd /var/www/minhoo-api/minhoo_api
npm run build
npm run ops:preflight:prod
curl -s -o /dev/null -w "live=%{http_code}\n" http://127.0.0.1:3000/api/v1/live
curl -s -o /dev/null -w "ready=%{http_code}\n" http://127.0.0.1:3000/api/v1/ready
```

## Traffic Light (Go/No-Go)

- RED: Any preflight error, `ready` failing persistently, or debug exposed publicly.
- YELLOW: Preflight passes but p95 latency unstable under expected load.
- GREEN: Preflight clean, health probes stable, and latency/CPU within target.
