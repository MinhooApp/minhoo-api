# Chat Push + Presence E2E (Mobile)

Objetivo: cerrar validacion real en dispositivo para chat con app:

- abierta (foreground)
- segundo plano (background)
- cerrada (terminated)

## Precondiciones

1. Backend en `main` actualizado.
2. Monitor activo:
   - `minhoo-chat-slo-monitor.timer`
3. App Android/iOS con permisos de notificaciones aceptados.
4. Dos cuentas reales:
   - Usuario A (emisor)
   - Usuario B (receptor)

## Caso 1: Foreground

1. Abrir chat entre A y B en ambos moviles.
2. A envia 3 mensajes.
3. Validar en B:
   - llegan en tiempo real sin recargar
   - badge/punto rojo sube inmediatamente
4. B abre chat y marca leido.
5. Validar en A:
   - estado delivered/read se actualiza

## Caso 2: Background

1. Dejar app de B en segundo plano (no cerrada).
2. A envia 3 mensajes.
3. Validar:
   - B recibe push
   - al tocar push abre conversacion correcta
   - contador unread y punto rojo quedan consistentes

## Caso 3: Terminated

1. Forzar cierre total de app B.
2. A envia 3 mensajes.
3. Validar:
   - B recibe push con app cerrada
   - al abrir desde push entra al chat correcto
   - no se pierden mensajes ni duplica badge

## Validacion backend simultanea

Mientras ejecutas los 3 casos:

```bash
cd /var/www/minhoo-api/minhoo_api
npm run -s ops:monitor:realtime-push -- --strict --minutes 20 --min-realtime-events 2
npm run -s ops:monitor:slo:chat -- --strict
```

Al cerrar pruebas:

```bash
sudo npm run -s ops:report:slo:chat24h -- --hours 24 --strict
```

## Criterio de cierre

- 3/3 casos OK.
- `ops:monitor:slo:chat` => `ok=true` sin `failures`.
- `ops:monitor:realtime-push` sin riesgos HIGH.
- `ops:report:slo:chat24h` sin `failures`.
