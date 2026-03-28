# Security Flow Hardening - 2026-03-28

## Summary
This release documents the flow-security hardening deployed on 2026-03-28.

Production code was deployed from commit `40b420d` on `main` and validated with preflight + smoke checks.

## Scope
### 1) Protected notification test endpoint
- Route `/api/v1/service/send` now requires:
  - `TokenValidation()`
  - `EnsureAdmin()`

File:
- `src/_routes/estandar/service/service_routes.ts`

### 2) JWT transport hardening
- Token extraction no longer accepts query/body by default in production.
- Legacy token transport can be toggled with env if needed.

Files:
- `src/libs/middlewares/verify_jwt.ts`
- `src/libs/middlewares/optional_jwt.ts`

### 3) Auth fail-open control
- DB/auth backend failure in `TokenValidation` is no longer fail-open by default in production.
- Controlled by env to support emergency degraded mode.

File:
- `src/libs/middlewares/verify_jwt.ts`

### 4) Socket handshake hardening
- Query-token usage in socket handshake is now controlled and disabled by default in production.

File:
- `src/_sockets/socket_controller.ts`

### 5) Follow legacy endpoint consistency
- Legacy `POST /user/follow` now validates:
  - target user id
  - self-follow rejection
  - target existence/status
  - bidirectional block policy

File:
- `src/useCases/user/add/add.ts`

### 6) Signed media access tokens (`sat`)
- Added short-lived HMAC token for media playback/download.
- Coverage includes:
  - audio by key
  - document by key
  - video by key
  - image by id
  - video by uid
- Enforced by default in production.

File:
- `src/useCases/media/create/create.ts`

### 7) Login enumeration reduction
- Pre-login blocked/deleted account check now returns generic invalid credentials message.

File:
- `src/_routes/estandar/auth/auth_routes.ts`

## Runtime configuration
Recommended/expected production values:

```env
AUTH_ALLOW_TOKEN_IN_QUERY_BODY=0
AUTH_DB_FAIL_OPEN=0
SOCKET_ALLOW_QUERY_TOKEN=0
MEDIA_ACCESS_TOKEN_ENFORCE=1
MEDIA_ACCESS_TOKEN_TTL_SECONDS=600
MEDIA_ACCESS_SIGNING_SECRET=<long-random-secret>
```

Notes:
- `MEDIA_ACCESS_TOKEN_ENFORCE` defaults to `1` in production.
- If `MEDIA_ACCESS_TOKEN_ENFORCE=1` and `MEDIA_ACCESS_SIGNING_SECRET` is missing, media endpoints return configuration error.

## Validation performed
### Pre-deploy
- `npm run build`
- `npm run ops:preflight:prod` => `pass: true`

### Post-deploy
- Service restart: `minhoo-api.service` active
- `npm run ops:smoke:release` => `pass: true`

Checks passed:
- `ping`
- `live`
- `ready`
- `bootstrap_home`
- `internal_summary_routes`
- `internal_perf_check`

## Rollback
If needed:
1. Roll back to previous known-good commit/artifact.
2. Restart service (`systemctl restart minhoo-api`).
3. Run `npm run ops:smoke:release`.
