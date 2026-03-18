# Paquete Frontend: `summary=1` + `bootstrap/home`

## 1) Orden de migración (impacto alto / riesgo bajo)

1. Home (`/bootstrap/home`) como request inicial.
2. Bandeja de chats (`/chat?summary=1`).
3. Notificaciones (`/notification?summary=1`).
4. Followers/Follows (`/user/followers|follows?...&summary=1`).
5. Lista de mensajes (`/chat/message/:id?summary=1`).
6. Feed de posts (`/post?summary=1` y `/post/suggested?summary=1`).
7. Feed de reels (`/reel?summary=1` y `/reel/suggested?summary=1`).

Regla de compatibilidad: si falla summary o faltan campos para pintar UI, fallback inmediato a endpoint legacy (sin `summary=1`) solo para esa pantalla/sección.

---

## 2) Estrategia por pantalla

### Home
- Endpoint actual sugerido:
  - `GET /api/v1/post?size=5`
  - `GET /api/v1/reel?size=6`
  - `GET /api/v1/service?size=4`
  - `GET /api/v1/notification?limit=5`
- Endpoint nuevo sugerido:
  - `GET /api/v1/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5`
- Headers recomendados:
  - `Authorization: Bearer <jwt>` (si hay sesión)
  - `x-session-key: <stable-device-or-session-id>`
- Campos mínimos para primer paint:
  - `body.meta.authenticated`, `body.meta.userId`
  - `body.sections.posts.items[]` (post summary)
  - `body.sections.reels.items[]` (reel summary)
  - `body.sections.services.items[]` (service summary)
  - `body.sections.notifications.items[]` + `unreadCount`
- Riesgos si faltan campos:
  - `sections.notifications` no llega para usuarios sin token.
  - `excerpt` o `thumbnail` nulos en algunos contenidos.
- Fallback:
  - Si `bootstrap/home` falla, disparar llamadas summary en paralelo por sección.
  - Si solo falla una sección, conservar las demás y pedir esa sección por su endpoint individual.
- QA checklist:
  - [ ] Home pinta skeleton < 300 ms tras respuesta.
  - [ ] Si no hay token, Home no rompe por `notifications` ausente.
  - [ ] Scroll inicial funciona con posts/reels/services desde bootstrap.
  - [ ] Unread badge usa `sections.notifications.unreadCount`.

### Feed de posts
- Endpoint actual sugerido:
  - `GET /api/v1/post?page=<n>&size=<m>`
  - `GET /api/v1/post/suggested?page=<n>&size=<m>`
- Endpoint nuevo sugerido:
  - `GET /api/v1/post?page=<n>&size=<m>&summary=1`
  - `GET /api/v1/post/suggested?page=<n>&size=<m>&summary=1`
- Límites:
  - `size` máximo backend: `20`.
- Campos mínimos:
  - `id`, `excerpt`, `createdAt`, `counts`, `media`, `author`, `liked`, `saved`
- Riesgos:
  - UI que espere `post.post` completo o listas anidadas legacy (`comments`, `likes`) puede romper.
- Fallback:
  - Si falta `media` o `author` para componentes legacy, cargar endpoint sin summary.
- QA checklist:
  - [ ] Card de post renderiza texto corto + autor + counts.
  - [ ] Like/Save conserva estado local y servidor.
  - [ ] Paginación respeta `size<=20`.
  - [ ] Sin regresión en navegación a detalle de post.

### Feed de reels
- Endpoint actual sugerido:
  - `GET /api/v1/reel?page=<n>&size=<m>`
  - `GET /api/v1/reel/suggested?page=<n>&size=<m>`
- Endpoint nuevo sugerido:
  - `GET /api/v1/reel?page=<n>&size=<m>&summary=1`
  - `GET /api/v1/reel/suggested?page=<n>&size=<m>&summary=1`
- Parámetro opcional:
  - `loop=1` para repetir contenido cuando se termina.
- Límites:
  - `size` máximo backend: `20`.
- Campos mínimos:
  - `id`, `description`, `thumbnail_url`, `stream_url|video_uid`, `counts`, `creator`, `createdAt`
- Riesgos:
  - Pantallas que dependan de metadata de reel no incluida en summary.
- Fallback:
  - Si no hay `stream_url` ni `video_uid`, pedir item puntual legacy por `GET /api/v1/reel/:id`.
- QA checklist:
  - [ ] Player inicia con summary sin consulta adicional.
  - [ ] `loop=1` evita quedarse pegado al final.
  - [ ] Infinite scroll estable en red lenta.

### Bandeja de chats
- Endpoint actual sugerido:
  - `GET /api/v1/chat`
- Endpoint nuevo sugerido:
  - `GET /api/v1/chat?summary=1`
- Campos mínimos:
  - `chatId`, `lastMessage`, `unreadCount`, `updatedAt`, `user`
- Riesgos:
  - Componentes que lean estructura legacy `Chat.users`/`Chat.messages`.
- Fallback:
  - Adapter: mapear summary al modelo UI; si falta `lastMessage`, usar texto `"Sin mensajes"`.
  - Si falla mapping, volver a `/chat` legacy.
- QA checklist:
  - [ ] Inbox abre con nombre/avatar/último mensaje.
  - [ ] Badge de no leídos correcto por chat.
  - [ ] Orden por `updatedAt` correcto.

### Lista de mensajes
- Endpoint actual sugerido:
  - `GET /api/v1/chat/message/:id?limit=50&beforeMessageId=<id>&sort=asc`
- Endpoint nuevo sugerido:
  - `GET /api/v1/chat/message/:id?summary=1&limit=50&beforeMessageId=<id>&sort=asc`
- Límites:
  - `limit` máximo backend: `200`.
- Campos mínimos:
  - `id`, `text`, `type`, `senderId`, `date`, `status`, `mediaUrl`, `sender`, `replyToMessageId`
- Riesgos:
  - UI que espere payload completo del sender en cada mensaje.
- Fallback:
  - Si falta campo crítico de render, solicitar solo esa página legacy.
- QA checklist:
  - [ ] Render de burbujas correcto para own/other user.
  - [ ] Paginación hacia atrás con `beforeMessageId` sin duplicados.
  - [ ] Estado `read/sent/delivered` visible sin regresión.

### Notificaciones
- Endpoint actual sugerido:
  - `GET /api/v1/notification?limit=20&cursor=<id>`
- Endpoint nuevo sugerido:
  - `GET /api/v1/notification?summary=1&limit=20&cursor=<id>`
- Límites:
  - `limit` máximo backend: `20`.
- Campos mínimos:
  - `id`, `type`, `createdAt`, `actor`, `target`, `read`
- Importante de contrato:
  - `body` es array directo (no `body.notifications`).
  - Paginación por headers: `X-Paging-Next-Cursor`.
- Riesgos:
  - Cliente asumiendo objeto en body.
- Fallback:
  - Si parser actual requiere objeto, envolver localmente: `{ notifications: body }`.
- QA checklist:
  - [ ] Lista pinta actor + texto por `type`.
  - [ ] Tap abre destino con `target.kind` y `target.id`.
  - [ ] Paginación por cursor usando header `X-Paging-Next-Cursor`.

### Followers / Follows
- Endpoint actual sugerido:
  - `GET /api/v1/user/followers/:id?`
  - `GET /api/v1/user/follows/:id?`
- Endpoint nuevo sugerido:
  - `GET /api/v1/user/followers/:id?summary=1&limit=20&cursor=<id>`
  - `GET /api/v1/user/follows/:id?summary=1&limit=20&cursor=<id>`
- Campos mínimos:
  - `id`, `username`, `avatar`, `flags`
- Importante de contrato:
  - Followers summary retorna `body.followers[]` + `body.paging.next_cursor`.
  - Follows summary retorna `body.following[]` + `body.paging.next_cursor`.
- Riesgos:
  - Cliente mezclando naming `follows` vs `following`.
- Fallback:
  - Normalizar en adapter a una sola llave local `items`.
- QA checklist:
  - [ ] Avatar/username renderizan sin cargar perfil completo.
  - [ ] Follow/unfollow mantiene estado visual.
  - [ ] Scroll con cursor no repite elementos.

---

## 3) Contrato mínimo (DTOs recomendados en frontend)

```ts
type UserSummary = {
  id: number | null;
  username: string | null;
  name: string | null;
  avatar: string | null;
  verified: boolean;
};

type PostSummary = {
  id: number | null;
  excerpt: string | null;
  createdAt: string | null;
  counts: { likes: number; comments: number; saves: number; shares: number };
  media: { url: string | null; is_image: boolean } | null;
  author: UserSummary | null;
  liked: boolean;
  saved: boolean;
};

type ReelSummary = {
  id: number | null;
  description: string | null;
  thumbnail_url: string | null;
  stream_url: string | null;
  video_uid: string | null;
  createdAt: string | null;
  counts: { likes: number; comments: number; saves: number; views: number };
  creator: UserSummary | null;
};

type ServiceSummary = {
  id: number | null;
  title: string | null;
  short_description: string | null;
  price: string | null;
  thumbnail: string | null;
  provider: UserSummary | null;
  status: string | null;
  createdAt: string | null;
};

type NotificationSummary = {
  id: number | null;
  type: string | null;
  createdAt: string | null;
  actor: UserSummary | null;
  target:
    | { kind: "post"; id: number | null; excerpt: string | null; media: { url: string | null; is_image: boolean } | null }
    | { kind: "reel"; id: number | null; excerpt: string | null; thumbnail: string | null }
    | { kind: "service"; id: number | null; excerpt: string | null; rate: number | null }
    | { kind: "message"; id: number | null; excerpt: string | null }
    | { kind: "offer"; id: number | null; serviceId: number | null }
    | null;
  read: boolean;
};
```

---

## 4) Plan de fallback (sin romper cliente actual)

1. Intentar endpoint nuevo (`summary=1` o `bootstrap/home`).
2. Validar campos mínimos requeridos para la pantalla.
3. Si faltan campos críticos o hay error 4xx/5xx/network:
   - fallback inmediato al endpoint legacy equivalente.
4. Registrar evento de observabilidad del fallback:
   - `screen`, `endpoint_new`, `fallback_reason`, `latency_ms`, `bytes`.
5. Mantener feature flag remoto:
   - `use_summary_home`, `use_summary_chat`, etc., para rollback rápido.

---

## 5) QA rápido por impacto (antes de release)

1. Red lenta simulada (3G Fast/Slow):
   - comparar TTFP (time to first paint) antes/después en Home y Chat Inbox.
2. Conteo de requests en carga inicial Home:
   - objetivo: bajar de 4-6 requests a 1 request (`bootstrap/home`) + incrementales.
3. Bytes descargados por pantalla:
   - objetivo: reducción visible al usar `summary=1`.
4. Compatibilidad visual:
   - validar cards, avatares, contadores, estados de lectura.
5. Resiliencia:
   - desconectar/reconectar red y confirmar fallback sin crash.

---

## 6) Integración exacta de `GET /api/v1/bootstrap/home`

Requests que reemplaza en primer paint de Home:
- `GET /api/v1/post?summary=1&size=5`
- `GET /api/v1/reel?summary=1&size=6`
- `GET /api/v1/service?summary=1&size=4`
- `GET /api/v1/notification?summary=1&limit=5` (si autenticado)

Requests que deben seguir incrementales después del primer paint:
- `GET /api/v1/post?page=1&size=10&summary=1`
- `GET /api/v1/reel?page=1&size=15&summary=1`
- `GET /api/v1/service/onGoing?page=1&size=10&summary=1`
- `GET /api/v1/notification?summary=1&limit=20&cursor=<nextCursor>`

---

## 7) Métricas cliente antes/después

Medir por pantalla y guardar baseline vs rollout:
- `time_to_first_render_ms`
- `requests_on_initial_load`
- `bytes_downloaded_initial`
- `time_to_interactive_ms`
- `fallback_rate_percent`

Objetivo esperado:
- menos round trips en Home,
- menor payload en feeds/chats/notificaciones,
- mejor percepción en 3G/latencia alta.
