# Chat Realtime Tests

Runner de pruebas de integración para chat-only realtime.

## Requisitos

- API arriba en `http://127.0.0.1:3000` (o custom con `API_BASE_URL` / `SOCKET_URL`)
- 2 usuarios válidos con token JWT

## Variables

- `TOKEN_A` (requerido)
- `TOKEN_B` (requerido)
- `USER_A` (opcional, si no se envía se intenta leer del token)
- `USER_B` (opcional, si no se envía se intenta leer del token)
- `API_BASE_URL` (opcional, default `http://127.0.0.1:3000/api/v1`)
- `SOCKET_URL` (opcional, default `http://127.0.0.1:3000`)
- `TEST_TIMEOUT_MS` (opcional, default `12000`)

## Ejecutar

```bash
cd /var/www/minhoo-api/minhoo_api
TOKEN_A="..." TOKEN_B="..." USER_A=26 USER_B=98 npm run test:chat:realtime
```

## Qué valida

1. `bind-user` correcto para ambos sockets.
2. Aislamiento de evento `chats` (solo usuario objetivo recibe refresh).
3. Rechazo `USER_MISMATCH` al pedir refresh de otro usuario.
4. Envío DM por HTTP + entrega realtime en `room/chat/{chatId}` al receptor.
5. Rechazo `FORBIDDEN_CHAT` en `chat:join` cuando el usuario no pertenece al chat.

