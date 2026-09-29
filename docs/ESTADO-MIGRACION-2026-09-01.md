# Estado migracion 2026-09-01

## Hecho

- App Docker construida como `ws-app-interna:local`.
- Proyecto Docker Desktop: `ws-app-interna-local`.
- Contenedores locales levantados:
  - `ws-app-interna-local-app-1`
  - `ws-app-interna-local-evolution-api-1`
  - `ws-app-interna-local-evolution-postgres-1`
  - `ws-app-interna-local-evolution-redis-1`
- URL local de staging: http://127.0.0.1:3000
- Healthcheck OK.
- `CRONS_ENABLED=0`.
- `NOTIFICATIONS_ENABLED=0`.
- Railway app data respaldada.
- Railway Evolution Postgres respaldado.
- Evolution Postgres restaurado en Docker local.
- Evolution API local responde `200 OK` en http://127.0.0.1:8080
- Data Railway restaurada en `C:\CLAUDE\ws-app-interna\data`.

## Backups

Backup Railway:

```text
C:\CLAUDE\railway-backups\ws-app-interna-data-20260901-121950.tgz
```

Backup local antes de restaurar Railway:

```text
C:\CLAUDE\railway-backups\ws-app-interna-local-data-before-restore-20260901-122200.zip
```

Backup Evolution Postgres:

```text
C:\CLAUDE\railway-backups\evolution-postgres-20260901-122903.sql.gz
```

Redis Evolution:

```text
C:\CLAUDE\railway-backups\evolution-redis-20260901-122903.tgz.partial
```

Ese parcial quedo en 0 bytes; Redis no quedo respaldado. Se trata como estado secundario/cache hasta validarlo mejor.

Importante: ese archivo parcial no es respaldo valido y no protege la sesion de WhatsApp si dependia de Redis.

## Conteos despues de restaurar

- `pedidos`: 141
- `facturas`: 37
- `clientes`: 21
- `calandra`: 1575
- `costureras_movimientos`: 5
- `evolution_events`: 516049
- `notificaciones`: 13
- `documentos_salientes_wa`: 9651
- `wetransfer`: 1262

## Estado Evolution local

- Postgres local tiene 30 tablas.
- `_prisma_migrations`: 42
- `Instance`: 0
- `Message`: 0
- `Contact`: 0
- `Chat`: 0

Conclusion: Evolution arranca local y la base existe, pero la instancia WhatsApp no quedo recuperada desde Postgres. Antes de borrar Railway hay que probar si se recupera por `wa_auth`/volumen de app o reconectar las instancias por QR.

## Endpoints verificados

- `GET /api/health`: OK.
- `GET /api/facturas`: 37 registros.
- `GET /api/clientes`: 21 registros.
- `GET /costura.html`: 200 OK.
- `GET /`: 200 OK.
- `GET /api/test-wa-grupo`: bloqueado correctamente con `NOTIFICATIONS_ENABLED=0`.

## Consumo local observado

- Memoria app en reposo: cerca de 34 MiB.
- Memoria Evolution API en reposo: cerca de 81 MiB.
- Memoria Evolution Postgres durante/ver despues de restauracion: cerca de 444 MiB.
- Memoria Redis local: cerca de 3 MiB.
- Limite Docker configurado: 1.5 GiB.
- CPU en reposo: 0%.

## Donde verlo en Docker Desktop

En Docker Desktop entrar a `Containers` y volver a la lista principal. Deben aparecer dos proyectos:

- `n8n-ws-local`
- `ws-app-interna-local`

La app W&S esta en `ws-app-interna-local`, no dentro de `n8n-ws-local`.

## No hecho todavia

- No se borro Railway.
- No se migro a un VPS publico.
- No se apunto dominio a VPS.
- No se configuro `.env` con secretos reales.
- No se activaron crones.
- No se activaron notificaciones.
- No se valido WhatsApp/Evolution con instancia real conectada.
- No se respaldo Redis de Evolution; el intento quedo en 0 bytes.

## Siguiente paso

Crear el VPS, copiar el proyecto, restaurar el backup y probar la app por dominio. Despues se configuran secretos reales, se reconecta o valida WhatsApp/Evolution, y se deja 24-48 horas sin depender de Railway. Solo despues de eso se debe ejecutar `scripts\Railway-Decommission-AfterBackup.ps1`.
