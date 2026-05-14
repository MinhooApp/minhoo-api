# Feed SLO Baseline (Day 1)

## Objective

Define and continuously check backend SLOs for TikTok-style feed readiness.

## Primary SLOs

- `GET /api/v1/post?summary=1` p95: `<= 250ms`
- `GET /api/v1/reel?summary=1` p95: `<= 220ms`
- `GET /api/v1/bootstrap/home` p95: `<= 1200ms`
- Global 5xx rate (observability window): `<= 0.5%`

## Secondary Guardrails

- Global 429 rate: `<= 4%` (warning by default)
- Bootstrap cache hit rate: `>= 55%` (when enough samples)
- Bootstrap notifications cache hit rate: `>= 45%` (when enough samples)

## Run Command

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:slo:feeds -- --strict
```

JSON output:

```bash
npm run -s ops:monitor:slo:feeds -- --strict --json
```

## Environment Variables

Defined in `.env.example` under "Feed SLO monitor (Day 1)".

Key knobs:

- `FEED_SLO_POST_SUMMARY_P95_MS`
- `FEED_SLO_REEL_SUMMARY_P95_MS`
- `FEED_SLO_BOOTSTRAP_FULL_P95_MS`
- `FEED_SLO_MAX_5XX_PERCENT`
- `FEED_SLO_MAX_429_PERCENT`
- `FEED_SLO_MIN_ROUTE_SAMPLES`
- `FEED_SLO_MIN_WINDOW_REQUESTS`

## Notes

- The monitor uses `/api/v1/internal/observability/overview`.
- In production, it requires `INTERNAL_DEBUG_TOKEN`.
- If strict mode is enabled, any SLO failure exits with code `1`.

