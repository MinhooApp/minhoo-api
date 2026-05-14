# test-chat-slo-traffic

Genera trafico real para chat en rutas criticas SLO y valida que el monitor de chat
ya tenga muestras suficientes para:

- `POST /api/v1/chat` (full)
- `GET /api/v1/chat/message/:id?summary=1`

## Uso rapido

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s test:chat:slo-traffic
```

## Variables utiles

- `API_BASE_URL` (default: `http://127.0.0.1:3000/api/v1`)
- `TOKEN_A`, `USER_A`, `TOKEN_B`, `USER_B` (opcional, recomendado para evitar login por password)
- `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_LOGIN_UUID`
- `VIEWER_EMAIL`, `VIEWER_PASSWORD`, `VIEWER_LOGIN_UUID`
- `OWNER_PASSWORD_ALT`, `VIEWER_PASSWORD_ALT` (fallback opcional)
- `CHAT_SLO_TEST_SEND_ITERATIONS` (default: `10`)
- `CHAT_SLO_TEST_SUMMARY_ITERATIONS` (default: `14`)
- `CHAT_SLO_TEST_LIST_SUMMARY_ITERATIONS` (default: `12`)
- `CHAT_SLO_TEST_LIST_FULL_ITERATIONS` (default: `12`)
- `CHAT_SLO_TEST_EXPECT_MIN_SEND` (default: `5`)
- `CHAT_SLO_TEST_EXPECT_MIN_MSG_SUMMARY` (default: `10`)
- `CHAT_SLO_TEST_EXPECT_MIN_LIST_SUMMARY` (default: `10`)
- `CHAT_SLO_TEST_EXPECT_MIN_LIST_FULL` (default: `10`)
- `CHAT_SLO_TEST_SEND_MAX_ATTEMPTS` (default: `SEND_ITERATIONS * 4`)
- `CHAT_SLO_TEST_SEND_RETRY_WAIT_MS` (default: `1500`)
- `CHAT_SLO_TEST_SEND_BETWEEN_WAIT_MS` (default: `120`)

## Salida esperada

```text
[pass] chat SLO traffic created send_samples=...
[ok] chat SLO critical route traffic checks passed
```

## Nota de credenciales

Si falla login, el script prueba fallback automatico de password con:

1. `OWNER_PASSWORD` / `VIEWER_PASSWORD`
2. `OWNER_PASSWORD_ALT` / `VIEWER_PASSWORD_ALT`
3. `Eder2010#`
4. `Eder2013#`
