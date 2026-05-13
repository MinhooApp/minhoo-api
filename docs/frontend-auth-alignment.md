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
