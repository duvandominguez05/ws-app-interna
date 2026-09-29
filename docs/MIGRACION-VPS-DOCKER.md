# Migracion W&S a VPS con Docker

Decision recomendada: sacar la app de Railway y correrla en un VPS con Docker Compose. No recomiendo dejarla solo en el PC de la oficina, porque si el PC esta apagado nadie puede entrar desde celular ni desde otros computadores.

## Arquitectura propuesta

Servidor fijo:
- VPS Ubuntu 24.04.
- Docker Compose.
- App W&S en `app`.
- Base SQLite en `/opt/ws-app-interna/data`.
- Caddy para HTTPS cuando haya dominio.
- Evolution API, Postgres y Redis en perfil separado, solo cuando se migre WhatsApp.

Local opcional:
- El vigilante de cada PC de diseno.
- Automatizaciones que leen carpetas locales.
- Procesos que pueden apagarse y reanudarse al otro dia.

En Docker Desktop local el proyecto debe verse como `ws-app-interna-local`.

Estado local verificado el 2026-09-01:
- App W&S en Docker local: OK.
- Data Railway restaurada en la app: OK.
- Evolution API/Postgres/Redis en Docker local: arranca OK.
- Evolution Postgres restaurado: OK, pero solo contiene migraciones; no trae `Instance`, `Message`, `Contact` ni `Chat`.
- Redis Railway: no hay respaldo valido todavia; el intento quedo en archivo parcial de 0 bytes.
- WhatsApp real: pendiente validar/reconectar antes de borrar Railway.

## Opcion de hosting

Mi recomendacion para produccion es Hetzner 8 GB si hay disponibilidad. El stack actual en Railway consume cerca de 2.7 GB RAM sumando app, Evolution, Postgres y Redis; por eso 4 GB puede servir para la app sola, pero queda apretado si tambien subimos WhatsApp/Evolution.

Alternativas:
- Barato recomendado: Hetzner 8 GB. Buen costo fijo mensual, mucho trafico incluido en region EU.
- Mas simple y conocido: DigitalOcean 4 GB para app sola o 8 GB si tambien va Evolution.
- Temporal local: Docker en el PC, solo para pruebas internas. No sirve como produccion si otros dependen de la app cuando el PC esta apagado.

Railway cobra por consumo de RAM, CPU, volumen y salida. Un VPS baja el riesgo porque el costo queda fijo por maquina y Docker limita recursos.

Fuentes consultadas el 2026-09-01:
- Railway pricing: https://docs.railway.com/pricing/plans
- Hetzner Cloud: https://www.hetzner.com/cloud/cost-optimized/
- DigitalOcean Droplets: https://www.digitalocean.com/pricing/droplets
- Cloudflare Tunnel: https://developers.cloudflare.com/tunnel/

## Freno de consumo incluido

El `docker-compose.yml` arranca la app asi:
- `CRONS_ENABLED=0`: no corren bots, escaneos ni tareas automaticas al migrar.
- `NOTIFICATIONS_ENABLED=0`: no envia WhatsApp/Telegram/documentos mientras probamos.
- `APP_MEM_LIMIT=1536m`: limite de memoria de la app.
- `APP_CPUS=1.0`: limite de CPU de la app.

Despues de validar, se enciende por etapas:
1. App y facturas/cotizaciones.
2. Datos migrados.
3. Dominio/HTTPS.
4. Evolution y WhatsApp.
5. Crones y notificaciones.

## Pasos en Windows

Desde el proyecto:

```powershell
cd C:\CLAUDE\ws-app-interna
.\scripts\New-RailwaySshKey.ps1
.\scripts\Backup-RailwayAppData.ps1
.\scripts\Backup-RailwayEvolution.ps1
```

Eso crea un backup del volumen `/app/data` de Railway en:

```text
C:\CLAUDE\railway-backups
```

No borrar Railway hasta que ese backup exista y la app nueva este funcionando.

El backup de Evolution Postgres queda como `evolution-postgres-YYYYMMDD-HHmmss.sql.gz`. Redis se omite por defecto; si se necesita intentar ese respaldo, ejecutar `.\scripts\Backup-RailwayEvolution.ps1 -IncludeRedis`.

Advertencia practica: el backup de Postgres de Evolution puede no traer la sesion de WhatsApp. En la restauracion local verificada quedaron `Instance`, `Message`, `Contact` y `Chat` en cero. Por eso el corte debe asumir que WhatsApp puede requerir reconexion por QR o una exportacion adicional de Redis/volumen si se confirma que ahi esta la sesion.

## Pasos en el VPS

Entrar al servidor:

```bash
ssh root@IP_DEL_SERVIDOR
```

Preparar carpeta:

```bash
mkdir -p /opt/ws-app-interna
cd /opt/ws-app-interna
```

Copiar o clonar el proyecto en esa carpeta. Luego:

```bash
cp .env.example .env
nano .env
bash scripts/Deploy-Vps-Ubuntu.sh
```

Verificar:

```bash
docker compose ps
curl http://127.0.0.1:3000/api/health
```

El primer arranque debe mostrar:

```json
{
  "ok": true,
  "crons_enabled": false,
  "notifications_enabled": false
}
```

## Restaurar data desde Railway

Copiar el backup al VPS:

```powershell
scp C:\CLAUDE\railway-backups\ws-app-interna-data-YYYYMMDD-HHmmss.tgz root@IP_DEL_SERVIDOR:/opt/ws-app-interna/backups/
```

Restaurar en el VPS:

```bash
cd /opt/ws-app-interna
tar -xzf backups/ws-app-interna-data-YYYYMMDD-HHmmss.tgz -C /opt/ws-app-interna
chown -R 1000:1000 /opt/ws-app-interna/data
docker compose restart app
curl http://127.0.0.1:3000/api/health
```

## Publicar con dominio

Cuando el DNS del dominio apunte al VPS:

```bash
docker compose --profile proxy up -d caddy
```

En `.env`:

```env
PUBLIC_HOST=app.tu-dominio.com
PUBLIC_URL=https://app.tu-dominio.com
GOOGLE_REDIRECT_URI=https://app.tu-dominio.com/api/gmail/callback
```

## Migrar Evolution

Solo cuando la app este estable:

```bash
docker compose --profile evolution up -d
```

Luego configurar en `.env`:

```env
EVOLUTION_API_URL=http://evolution-api:8080
EVOLUTION_API_KEY=...
WA_NOTIF_APIKEY=...
EVOLUTION_WEBHOOK_TOKEN=...
```

Y registrar webhooks desde la app usando el dominio nuevo.

En local, para ver todo el stack:

```powershell
.\scripts\Docker-App.ps1 status
```

## Apagar Railway de forma segura

El borrado esta preparado, pero solo debe ejecutarse despues de:
- Backup local verificado.
- App en VPS funcionando.
- Dominio nuevo funcionando.
- Facturas/cotizaciones probadas.
- WhatsApp/Evolution migrado o decidido como apagado.
- Evolution Postgres respaldado.
- Minimo 24-48 horas sin depender de Railway.

Comando final:

```powershell
cd C:\CLAUDE\ws-app-interna
.\scripts\Railway-Decommission-AfterBackup.ps1 -ConfirmDeletion TENGO_BACKUP_Y_APP_NUEVA_FUNCIONANDO
```
