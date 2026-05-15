# Frontend — Contratos con el API de Feed

## 1. Feed de Posts `/api/v1/post` y `/api/v1/post/suggested`

### Parámetros requeridos

| Parámetro | Tipo | Ejemplo | Notas |
|-----------|------|---------|-------|
| `page` | number | `0`, `1`, `2` | Empieza en 0 |
| `size` | number | `20` | Máximo permitido: 20 |
| `summary` | string | `"1"` | Siempre enviarlo para mejor performance |
| `session_key` | string | `"a1b2c3d4-uuid"` | Ver reglas abajo |

---

## 2. Reglas del `session_key` — LO MÁS IMPORTANTE

El backend usa este valor para mantener el estado del feed entre páginas.
Sin él, las páginas 1, 2, 3... devuelven vacío.

### Cuándo generarlo y cuándo cambiarlo

```
Al montar el componente del feed  →  generar 1 UUID nuevo
Al hacer scroll (páginas 1, 2…)  →  reusar el mismo UUID
Al hacer pull-to-refresh          →  generar UUID NUEVO  ← crítico para ver posts nuevos
Al hacer login                    →  NO es necesario (el backend usa u:{userId})
```

### Por qué pull-to-refresh necesita UUID nuevo

El backend guarda en Redis un `stableFeedIds` por sesión.
Si el UUID no cambia, el feed devuelve el mismo orden aunque haya posts nuevos.
Al cambiar el UUID se limpia el estado y los posts nuevos aparecen al tope.

### Implementación (pseudocódigo)

```js
// Al montar el feed
let sessionKey = uuid()

// Cargar página
const loadPage = (page) => {
  fetch(`/api/v1/post?page=${page}&size=20&summary=1&session_key=${sessionKey}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
}

// Pull-to-refresh → UUID nuevo → posts nuevos aparecen al tope
const onRefresh = () => {
  sessionKey = uuid()
  loadPage(0)
}
```

---

## 3. Detectar última página

```js
// La API devuelve:
// { page, size, count, posts: [...] }
//
// Hay más páginas si:
const hasMore = posts.length === size

// NO usar: page * size < count
// El algoritmo de ranking puede agotarse antes que el total de posts en BD
```

---

## 4. Enviar token al entrar al feed tras login

El CDN cachea el feed anónimo 75 segundos.
Si el primer request tras login va SIN token, el CDN sirve el feed público
y el usuario ve contenido no personalizado por ~75s.

```js
// MAL — race condition
onLoginSuccess(() => {
  setUser(user)   // actualiza estado async
  navigate('/feed') // el feed carga antes de que el token esté disponible
})

// BIEN — esperar que el token esté en los headers antes de cargar el feed
onLoginSuccess(async () => {
  await setAuthToken(token)   // asegurar que el interceptor HTTP ya tiene el token
  navigate('/feed')
})
```

---

## 5. Resumen de comportamientos esperados

| Acción del usuario | Comportamiento correcto |
|--------------------|------------------------|
| Abre el feed | Genera nuevo `session_key`, carga página 0 |
| Hace scroll | Incrementa `page`, reutiliza mismo `session_key` |
| Pull-to-refresh | Genera nuevo `session_key`, carga página 0 |
| Hace login | Espera que el token esté listo, luego carga feed |
| Vuelve a la pantalla (onFocus) | Genera nuevo `session_key`, recarga página 0 para ver posts nuevos |

---

## 6. Contrato UI — Worker cancela servicio en `in_progress`

### Endpoint

`PUT /api/v1/offer/cancel/{offerId}`

### Regla backend

El worker puede cancelar su oferta en estados activos del servicio:

- `statusId=1` (searching)
- `statusId=2` (assigned)
- `statusId=3` (in_progress)
- `statusId=4` **solo si** `manual_closed_at` es `null` (orden aún abierta del lado cliente)

### Qué debe hacer el front del cliente

Cuando el backend responda el servicio actualizado, en `offers[]` usar estos flags por oferta:

- `worker_canceled=true`
- `client_card_disabled=true`
- `client_interaction_enabled=false`
- `client_can_open=false`
- `client_can_rate=false`
- `client_disable_reason="worker_canceled"`

Con esos flags:

1. Pintar la tarjeta del worker en gris.
2. No permitir tap para entrar a esa tarjeta.
3. Ocultar/deshabilitar botón de calificar para esa tarjeta.

### Fuente de verdad

Además de los flags, la base del estado sigue siendo:

- `accepted=false`
- `canceled=true`
- `removed=false`

---

## 7. Contrato UI — Cliente cancela a 1 trabajador (sin cancelar la orden)

### Endpoint

`DELETE /api/v1/offer/remove/{offerId}`

Compatibilidad:

- `PUT /api/v1/offer/remove/{offerId}`
- `POST /api/v1/offer/remove/{offerId}`

### Regla backend

El cliente (dueño de la orden) puede remover un trabajador en estados activos:

- `statusId=1` (searching)
- `statusId=2` (assigned)
- `statusId=3` (in_progress)
- `statusId=4` **solo si** `manual_closed_at` es `null` (orden aún abierta del lado cliente)

Esto **NO cancela la orden completa**. Solo remueve ese trabajador/oferta.

### Estado esperado de esa oferta removida

- `accepted=false`
- `removed=true`
- `canceled=false`

### Flags para front (en `service.offers[]`)

Para la oferta removida por cliente:

- `client_card_disabled=true`
- `client_interaction_enabled=false`
- `client_can_open=false`
- `client_can_rate=false`
- `client_disable_reason="client_removed"`

### Comportamiento de UI

1. Pintar la tarjeta de ese trabajador en gris.
2. No permitir abrir esa tarjeta.
3. No permitir calificar a ese trabajador desde esa oferta removida.
4. Mantener la orden activa con los demás trabajadores.

---

## 8. Contrato UI — Perfil verificado (tick)

### Flujo de envío

1. Subir 4 imágenes con media API (Cloudflare):
- selfie
- documento frente
- documento atrás
- selfie sosteniendo documento

2. Enviar IDs al endpoint:

`POST /api/v1/user/verification/submit`

Body:

```json
{
  "selfie_image_id": "cf_image_id_1",
  "document_front_image_id": "cf_image_id_2",
  "document_back_image_id": "cf_image_id_3",
  "selfie_with_document_image_id": "cf_image_id_4",
  "doc_type": "national_id",
  "doc_country": "US"
}
```

### Estados posibles

- `unverified`
- `processing`
- `manual_review`
- `approved`
- `rejected`

### Consultar estado

`GET /api/v1/user/verification/status`

Response (resumen):

```json
{
  "success": true,
  "data": {
    "profile_verified": true,
    "profile_verification_status": "approved",
    "latest_request": {
      "id": 123,
      "status": "approved"
    }
  }
}
```

### Regla del tick en front

Mostrar tick al final del nombre cuando:

- `profile_verified=true`

Campos expuestos en payloads de perfil/resumen:

- `profile_verified`
- `verified_badge`
- `profile_verification_status`

### Revisión manual (admin)

Cola:

`GET /api/v1/admin/users/profile-verification/queue`

Aprobar/Rechazar:

`PATCH /api/v1/admin/users/profile-verification/{requestId}/review`

Body:

```json
{
  "action": "approve"
}
```

o

```json
{
  "action": "reject",
  "reason": "Documento ilegible"
}
```

---

## 9. Contrato UI — Moderación previa a publicar media

Para evitar publicar contenido bloqueado, el flujo correcto es:

1. `direct-upload` (imagen/video)
2. `POST /api/v1/media/moderate`  **(NUEVO, obligatorio antes de confirm)**
3. Si `blocked=false` → llamar `confirm`
4. Si `blocked=true` → **NO** llamar `confirm` ni crear post/reel/chat

### Endpoint

`POST /api/v1/media/moderate`

Headers:

- `Authorization: Bearer <token>`

Body (imagen):

```json
{
  "asset_type": "image",
  "image_id": "r2img-98-1778121589836-7f0e4f1e4878d675.jpg",
  "context": "feed",
  "locale": "es"
}
```

Body (video):

```json
{
  "asset_type": "video",
  "video_uid": "aabbccddeeff00112233445566778899",
  "context": "feed",
  "locale": "en"
}
```

### Response 200

```json
{
  "success": true,
  "data": {
    "moderation": {
      "blocked": false,
      "categories": [],
      "signals": []
    },
    "confirm_payload": {
      "moderation_blocked": false,
      "moderation_categories": []
    }
  }
}
```

### Response 502 (falló proveedor de moderación)

- Detener publicación en front.
- Mostrar mensaje de error al usuario.

### Response 503 (proveedor no configurado)

- Detener publicación en front.
- Mostrar mensaje técnico para QA/ops.

### Integración con `confirm`

Cuando moderación devuelve 200, enviar exactamente `confirm_payload` en:

- `POST /api/v1/media/image/confirm`
- `POST /api/v1/media/video/confirm`

---

## 10. Contrato UI — Chat Admin con audio, foto y video

### Objetivo

Admin Web debe poder:

- recibir mensajes `text|voice|image|video` del usuario
- enviar mensajes `text|voice|image|video` al usuario

### Endpoints de conversación admin

- Listar mensajes:
`GET /api/v1/admin/users/:id/chat/messages?limit=50&sort=desc&before_message_id=`
- Enviar mensaje:
`POST /api/v1/admin/users/:id/chat/messages`

Nota: toda respuesta viene envuelta en `header` y `body`.

### Flujo de envío para media (audio/foto/video)

1. Crear upload:
- audio: `POST /api/v1/media/audio/direct-upload`
- foto: `POST /api/v1/media/image/direct-upload`
- video: `POST /api/v1/media/video/direct-upload`

2. Subir binario al `upload_url`.

3. Confirmar upload:
- audio: `POST /api/v1/media/audio/confirm`
- foto: `POST /api/v1/media/image/confirm`
- video: `POST /api/v1/media/video/confirm`

4. Tomar `recommended_chat_payload` del confirm y usarlo en:
`POST /api/v1/admin/users/:id/chat/messages`

### Request de envío (admin chat)

`POST /api/v1/admin/users/:id/chat/messages`

Body base:

```json
{
  "message_type": "text|voice|image|video",
  "message": "opcional para media, requerido para text sin e2e",
  "media_url": "requerido en voice/image/video",
  "media_mime": "opcional",
  "media_duration_ms": 12000,
  "media_size_bytes": 345678,
  "waveform": [0.1, 0.4, 0.8],
  "metadata": {},
  "client_message_id": "admin-web-msg-uuid"
}
```

Ejemplo audio:

```json
{
  "message_type": "voice",
  "media_url": "/api/v1/media/audio/play?key=aud-12-1778.m4a",
  "media_mime": "audio/m4a",
  "media_duration_ms": 9300,
  "media_size_bytes": 231122,
  "waveform": [0.04, 0.22, 0.6, 0.33],
  "client_message_id": "adm-voice-001"
}
```

Ejemplo foto:

```json
{
  "message_type": "image",
  "media_url": "/api/v1/media/image/play?id=r2img-98-1778121589836-7f0e4f1e4878d675.jpg",
  "media_mime": "image/webp",
  "media_size_bytes": 487221,
  "client_message_id": "adm-img-001"
}
```

Ejemplo video:

```json
{
  "message_type": "video",
  "media_url": "/api/v1/media/video/play?key=vid-12-1778121589.mp4",
  "media_mime": "video/mp4",
  "media_duration_ms": 44200,
  "media_size_bytes": 8721221,
  "metadata": {
    "thumbnail_url": "https://videodelivery.net/<uid>/thumbnails/thumbnail.jpg?time=1s",
    "delivery": "r2"
  },
  "client_message_id": "adm-vid-001"
}
```

### Response esperada al enviar

`body.message` viene normalizado y listo para pintar con campos como:

- `id`
- `messageType` y `message_type`
- `text`
- `mediaUrl` y `media_url`
- `mediaDownloadUrl` y `media_download_url` (video)
- `thumbnailUrl` y `thumbnail_url` (video)
- `sender_type` (`admin|user`)
- `direction` (`outgoing|incoming`)
- `status` (`sent|delivered|read`)
- `createdAt` / `created_at`

### Response esperada al listar

`body.messages[]` (y alias `body.data[]`) trae el mismo contrato de mensaje normalizado.

### Realtime para evitar parpadeo

1. Al abrir conversación, unir sala:

Socket emit:

```json
{
  "event": "chat:join",
  "payload": { "chatId": 1234 }
}
```

2. Escuchar eventos de mensajes:

- `room/chat/{chatId}`
- `chat/{chatId}`
- `chat` (compat)

3. Escuchar estados (`delivered/read`):

- `room/chat/status/{chatId}`
- `chat/status/{chatId}`
- `chat:status` (compat)

4. Refrescar listado lateral cuando llegue:

- `chats/{userId}`
- `chats`

---

## 11. Contrato UI — Historial de chats finalizados (Admin Web)

### Problema que resuelve

Cuando un chat se finaliza (`PATCH /api/v1/admin/users/:id/chat/finalize`), deja de salir en el listado activo.
Para poder verlo en historial, Admin Web debe usar estos contratos:

- `GET /api/v1/admin/users/chat/history`
- `GET /api/v1/admin/users/:id/chat/messages?include_finalized=1`

### A) Listado de historial (sidebar/lista de conversaciones)

`GET /api/v1/admin/users/chat/history?page=1&limit=20&status=finalized&q=`

Parámetros:

- `page` (default `1`)
- `limit` (default `20`, max `100`)
- `status`: `all | active | finalized`
- `q`: busca por `username` o `name + last_name`
- `user_id` (opcional): filtra por usuario específico

Response (`body`):

```json
{
  "page": 1,
  "limit": 20,
  "count": 3,
  "status": "finalized",
  "items": [
    {
      "chat_id": 1234,
      "conversation_id": 1234,
      "conversation_type": "support_admin",
      "deleted_by": -1,
      "finalized": true,
      "is_finalized": true,
      "user_id": 887,
      "counterpart": {
        "id": 887,
        "user_type": "user",
        "name": "Juan",
        "last_name": "Perez",
        "username": "juanp",
        "image_profil": "https://...",
        "profile_verified": false,
        "profile_verification_status": "unverified"
      },
      "last_message": {
        "id": 99881,
        "sender_id": 887,
        "sender_type": "user",
        "text": "gracias",
        "message_type": "text",
        "media_url": null,
        "date": "2026-05-14T04:05:12.000Z",
        "status": "read"
      }
    }
  ]
}
```

### B) Abrir mensajes de un chat finalizado

`GET /api/v1/admin/users/:id/chat/messages?limit=50&sort=desc&before_message_id=&include_finalized=1`

Reglas:

- Si `include_finalized=1`, el backend devuelve mensajes aunque el chat esté finalizado (`deletedBy=-1`).
- Si no se envía `include_finalized`, mantiene comportamiento normal (solo chat visible activo).
- En chat finalizado no se ejecuta mark-as-read.

Response (`body`, campos relevantes):

```json
{
  "conversation_id": 1234,
  "conversation_type": "support_admin",
  "user_id": 887,
  "chat_id": 1234,
  "deleted_by": -1,
  "finalized": true,
  "is_finalized": true,
  "include_finalized": true,
  "count": 50,
  "messages": []
}
```

### Recomendación de UI (Admin Web)

1. Tab "Activos": llamar `status=active`.
2. Tab "Finalizados": llamar `status=finalized`.
3. Al abrir un item finalizado, pedir mensajes con `include_finalized=1`.

---

## 12. Contrato móvil — Reanudación Segura + Headers de Diagnóstico (2026-05-14)

### Objetivo

Evitar que el feed se quede cargando al volver del background/lockscreen y evitar quedar sirviendo feed anónimo por carrera de token.

### Flujo recomendado al volver a foreground (`onFocus` / `AppState=active`)

1. Cancelar requests inflight de Home/Feed anteriores.
2. Resetear estado paginado:
- `page = 0`
- `hasMore = true`
- `session_key = uuid()` nuevo
3. Validar sesión rápida:
- `GET /api/v1/auth/session/ping`
- Si responde `401` con `action=refresh`, ejecutar `/auth/refresh` y reintentar `ping` una vez.
4. Cargar `GET /api/v1/bootstrap/home?...` como primer paint.
5. Si bootstrap llega parcial (`X-Bootstrap-Partial=1`), pedir en paralelo solo secciones degradadas.
6. Cargar feed `page=0` y recién después habilitar scroll/infinite pagination.

### Headers nuevos a leer en cliente

En `/post`, `/post/suggested`, `/reel`, `/reel/suggested`, `/bootstrap/home`:

| Header | Valores típicos | Acción frontend |
|--------|------------------|-----------------|
| `X-Auth-Optional-Token` | `0` / `1` | Diagnóstico: confirma si request salió con token o no |
| `X-Auth-Optional-State` | `missing`, `invalid_token`, `expired_token`, `session_miss`, `backend_unavailable`, `user_unavailable`, `verified` | Decide refresh/retry/logout |
| `X-Auth-Action-Hint` | `refresh`, `retry`, `logout` | Prioridad de recuperación sin adivinar |
| `X-Auth-Error-Code` | `AUTH_*` | Telemetría y clasificación de error |

Headers extra de bootstrap:

| Header | Valores típicos | Acción frontend |
|--------|------------------|-----------------|
| `X-Bootstrap-Partial` | `0` / `1` | Si es `1`, mostrar home con secciones disponibles y disparar refill incremental |
| `X-Bootstrap-Partial-Sections` | `posts,reels,services,notifications` (csv) | Reintentar solo esas secciones |
| `X-Bootstrap-Notifications-Cache` | `hit`, `miss`, `coalesced`, `bypass`, `error` | Si `error`, no romper badge; usar `0` y reintento diferido |

### Reglas de recuperación recomendadas

- `state=missing` y usuario debería estar logueado:
  - esperar token en interceptor y repetir request una vez.
- `state=invalid_token|expired_token|session_miss`:
  - ejecutar refresh y repetir request una vez.
- `state=backend_unavailable`:
  - retry con backoff (no logout).
- `state=user_unavailable`:
  - limpiar sesión local y mandar a login.

### Pseudocódigo de control de loader (anti “spinner infinito”)

```js
async function loadHomeAndFeedSafe() {
  setLoading(true)
  try {
    await ensureSessionReady() // ping + refresh si aplica

    const home = await api.get("/bootstrap/home?include=posts,reels,services,notifications")
    const partial = home.headers["x-bootstrap-partial"] === "1"
    const partialSections = String(home.headers["x-bootstrap-partial-sections"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    renderHome(home.data.body)

    if (partial && partialSections.length) {
      refillOnly(partialSections) // requests por sección en paralelo
    }

    sessionKey = uuid()
    const feed = await api.get(`/post?page=0&size=20&summary=1&session_key=${sessionKey}`)
    renderFeed(feed.data.body.posts || [])
  } catch (e) {
    showRetryState()
  } finally {
    setLoading(false) // SIEMPRE quitar loader
  }
}
```

---

## 13. Contrato Avatar — Cloudflare Direct Only (2026-05-15)

### Objetivo

Unificar la carga de avatar para evitar perfiles que abren sin foto y luego muestran imagen con retraso.

### Regla backend (nuevo)

Para `avatar_url` / `image_profil` en update de perfil:

- Aceptado:
  - URL directa Cloudflare Images (`https://imagedelivery.net/.../<image_id>/public`)
  - `image_id` de Cloudflare Images (el backend lo resuelve a URL directa)
  - `/api/v1/media/image/play?id=<cloudflare_image_id>` (el backend lo resuelve a URL directa)
- Rechazado:
  - `r2img-*` como avatar persistido
  - `/api/v1/media/image/play?id=r2img-*`
  - URLs externas que no sean Cloudflare Images

### Endpoints impactados

- `POST /api/v1/worker`
- `PUT /api/v1/worker/profile`
- `PUT /api/v1/user/profile` (update perfil usuario)
- `POST /api/v1/auth` (signup, cuando llega avatar por URL)

### Recomendación frontend

1. Para avatar nuevo, preferir multipart directo al endpoint de profile.
2. Si frontend usa `image_id`, enviar solo `cloudflare_image_id` (no `r2img-*`).
3. No persistir ni reutilizar `avatar_url` con `/api/v1/media/image/play?id=r2img-*`.
