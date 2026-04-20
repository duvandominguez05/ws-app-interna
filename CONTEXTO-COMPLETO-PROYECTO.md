# W&S Textil — App Interna: Contexto Completo del Proyecto

## Qué es esto
App interna de producción para **W&S Textil**, una empresa de uniformes deportivos en Colombia (Bogotá). Maneja todo el flujo desde que un cliente pide una cotización hasta que se entrega el producto final.

---

## Stack Técnico

| Capa | Tecnología |
|------|-----------|
| **Backend** | Node.js puro (sin Express), HTTP server vanilla — `server.js` (645 líneas) |
| **Frontend** | HTML + CSS + JS vanilla, todo en 3 archivos: `index.html`, `public/css/style.css`, `public/js/app.js` |
| **Base de datos** | Archivos JSON en disco (`data/*.json`) — NO hay base de datos real |
| **Hosting** | Railway (auto-deploy on git push) |
| **Automatizaciones** | n8n (self-hosted en Railway) — 11 workflows |
| **Bot WhatsApp** | Baileys (local en PC) + Puppeteer (alternativo) — corre en la PC del dueño, NO en Railway |
| **Notificaciones** | Telegram Bot → grupo "W&S Textil Admin" |
| **Integraciones** | Google Drive (OAuth2), Gmail, WeTransfer (vía n8n) |
| **PWA** | manifest.json configurado, se puede instalar como app |

### URLs
- **Producción**: `https://ws-app-interna-production.up.railway.app`
- **API Key**: `ws-textil-2026`

---

## Estructura de Archivos

```
ws-app-interna/
├── server.js              # Backend completo (645 líneas, Node.js puro)
├── index.html             # Frontend completo (809 líneas, HTML)
├── public/
│   ├── css/style.css      # Estilos (1759 líneas)
│   └── js/app.js          # Lógica frontend (2746 líneas)
├── bot.js                 # Bot WA con Baileys (91 líneas)
├── bot-puppeteer.js       # Bot WA alternativo con Puppeteer (218 líneas)
├── data/                  # "Base de datos" JSON
│   ├── pedidos.json       # Pedidos y cotizaciones
│   ├── calandra.json      # Registros de metraje calandra
│   ├── arreglos.json      # Arreglos manuales
│   ├── satelites.json     # Movimientos satélites costura
│   ├── docsNums.json      # Numeración facturas/cotizaciones
│   └── nextId.json        # Auto-increment ID pedidos
├── WORKFLOWS/             # 11 workflows de n8n (JSON exportados)
├── manifest.json          # PWA config
├── package.json           # Solo 5 dependencias
└── iniciar-bot.bat        # Script para arrancar bot en Windows
```

---

## Secciones de la App (Sidebar)

### 1. Vista General (Dashboard)
- KPIs: activos, diseño, producción, listos, m² calandra, pendientes satélites
- Panel de entregas próximas
- Pipeline de producción (cuántos en cada etapa)
- Resumen de satélites pendientes
- Resumen calandra semanal
- Timeline de todos los pedidos activos

### 2. Ventas (Bandeja)
- Dos columnas: **Cotizaciones** y **Pedidos confirmados**
- Búsqueda por equipo o teléfono
- Cada tarjeta muestra: equipo, teléfono, vendedora, fecha creación
- Acción: completar pedido (agregar prendas, fecha entrega, notas)

### 3. Diseño (Kanban)
- 3 columnas: **Hacer diseño** → **Confirmado** → **Enviado a calandra**
- Tarjetas arrastrables entre columnas
- Cada tarjeta: equipo, vendedora, items, fecha entrega

### 4. Producción (Kanban)
- 6 columnas: **Llegó impresión** → **Corte** → **Calidad** → **Costura** → **Listo** → **Enviado al cliente**
- Mismo sistema de tarjetas con arrastrar

### 5. WeTransfer
- Control de envíos y descargas de PDFs vía WeTransfer
- Registro manual o automático (n8n detecta descargas vía Gmail)
- Resumen del día

### 6. Arreglos
- Dos secciones: "En pedidos activos" (vinculados a pedidos) y "Registros manuales"
- Registro manual de arreglos con equipo + qué falta
- **Problema reportado**: sidebar de arreglos no se entiende, confuso

### 7. Calandra (Metraje)
- Métricas: metros esta semana, metros hoy, archivos hoy
- Selector de ancho de tela (1.40m a 1.70m)
- Registro manual o automático (n8n detecta PDFs en Google Drive)
- Panel de PDFs pendientes de envío por WeTransfer
- Lista de todos los registros

### 8. Satélites (Costura)
- Control de entrega/recepción de prendas a satélites externos
- 4 satélites: Marcela, Yamile, Wilson, Cristina
- Resumen por satélite con pendientes
- **Problema reportado**: sidebar no se entiende

### 9. Facturas (Cotizaciones)
- Generador de cotizaciones y facturas en PDF
- Datos cliente, items con cantidad/precio/talla
- Selección de cuenta Bancolombia
- Historial con búsqueda y filtros
- Genera PDF con html2pdf.js

---

## Flujo de un Pedido (Estados)

```
bandeja → hacer-diseno → confirmado → enviado-calandra → llego-impresion → corte → calidad → costura → listo → enviado-final
```

- **Cotización**: entra en `bandeja`
- **Pedido confirmado**: entra en `hacer-diseno` directamente
- El movimiento entre estados se hace arrastrando tarjetas en el kanban
- `ultimoMovimiento` se actualiza en cada cambio de estado

### Cómo entran pedidos:
1. **Manual**: botón "Nuevo pedido" en la app
2. **Bot WhatsApp**: mensaje `#cotizar vendedora telefono equipo` o `#pedido vendedora telefono equipo` en el grupo de WA
3. **Vendedoras válidas**: Betty, Graciela, Ney, Wendy, Paola

---

## APIs del Backend

| Método | Ruta | Función |
|--------|------|---------|
| GET | `/api/pedidos` | Lista todos los pedidos |
| POST | `/api/pedidos` | Sync completo desde frontend (merge inteligente) |
| DELETE | `/api/pedidos/:id` | Elimina un pedido |
| POST | `/api/venta` | Bot crea cotización/pedido (requiere API key) |
| GET/POST | `/api/calandra` | Registros de metraje calandra |
| DELETE | `/api/calandra/:id` | Borra registro calandra |
| DELETE | `/api/calandra/reset` | Limpia todos los registros |
| GET | `/api/drive-pdfs` | PDFs de Drive con estado WeTransfer |
| GET/POST | `/api/wetransfer` | Registros WeTransfer |
| GET/POST | `/api/docs/nums` | Numeración facturas/cotizaciones |
| GET/POST | `/api/pendientes-wt` | PDFs pendientes de enviar por WT |
| GET/POST | `/api/arreglos` | Control de arreglos |
| GET/POST | `/api/satelites` | Movimientos de satélites |

### Sincronización Frontend ↔ Backend
- El frontend guarda en **localStorage** Y sincroniza con el servidor via POST `/api/pedidos`
- Merge inteligente: gana el que tenga `ultimoMovimiento` más reciente
- Pedidos creados por el bot en el servidor se sincronizan al frontend
- Los eliminados del cliente se trackean para no re-aparecer

---

## Workflows de n8n (11 en total)

### Alertas y Notificaciones (Telegram)
1. **Alerta Fechas Próximas** — Diario 8am, avisa pedidos que vencen en 1-2 días
2. **Alertas Fechas Vencidas** — Diario 7pm, avisa pedidos con fecha vencida (1x/día/pedido)
3. **Alertas Sin Movimiento** — Diario 7pm, avisa pedidos parados +3 días (re-avisa cada 3 días)
4. **Listo para Entregar** — Avisa cuando un pedido pasa a estado "listo"

### Calandra / Google Drive
5. **Calandra - PDF Drive a Railway + Telegram** — Cada 5 min revisa Google Drive por PDFs nuevos, extrae dimensiones del nombre, registra en API, notifica por Telegram
6. **Watcher PDF Drive** — Monitoreo adicional de Drive

### WeTransfer
7. **WeTransfer Descargado** — Detecta emails de WeTransfer (descarga) vía Gmail, registra en API
8. **WeTransfer - Registrar Enviados App Web** — Registra envíos desde la app web
9. **PDF Drive vs WeTransfer - Alerta WA** — Compara PDFs en Drive vs enviados por WT, alerta los faltantes

### Reportes Semanales
10. **Reporte Semanal Producción** — Lunes 8am, resumen: entregados, activos por etapa, sin movimiento, vencidos
11. **Reporte Semanal Calandra** — Domingo 7pm, resumen: metros totales, por día, mejor día, equipo top

### Grupos de Telegram usados
- **W&S Textil Admin** (chatId: `-5135765805`) — alertas admin, reportes, calandra
- **Producción** (chatId: `-1003751103154`) — alertas sin movimiento

---

## Bot de WhatsApp

- Corre **localmente** en la PC del dueño (no en Railway)
- Usa **Baileys** (bot.js) o **Puppeteer** (bot-puppeteer.js)
- Se conecta vía pairing code (no QR)
- Escucha en un grupo específico de WA
- Regex: `#cotizar|pedido vendedora telefono [equipo]`
- Crea ventas automáticamente en la API
- Al iniciar, revisa los últimos 3 días de mensajes para no perder ninguno
- Control de duplicados por `waMsgId` y por teléfono+mes

---

## Infraestructura en Railway

Servicios corriendo:
1. **ws-app-interna** — La app Node.js (backend + frontend)
2. **n8n** — Automatizaciones (self-hosted)
3. **Evolution API** — API de WhatsApp (para otras líneas de venta, NO para el bot interno)
4. **Chatwoot** — Chat/CRM para ventas externas

---

## Problemas Conocidos y Pendientes

### Problemas Resueltos (sesión anterior)
1. ✅ Bot se auto-arrancaba al prender PC — eliminadas 4 tareas programadas de Windows
2. ✅ Spam de Telegram "PDF sin dimensiones" — agregado `staticData.alertados` con TTL 30 días
3. ✅ Spam de alertas sin movimiento — migrado de array a objeto con timestamps, re-notifica cada 3 días
4. ✅ Google OAuth se vencía cada 7 días — App estaba en modo "Prueba", publicada a Producción

### Pendientes Inmediatos
1. **Reconectar credenciales OAuth en n8n** — Después de publicar a Producción, hay que reconectar "Google Drive account" y "Google account (Gmail)" en n8n > Credentials
2. **Reimportar 5 workflows modificados en n8n** — Los cambios están en el repo pero NUNCA se reimportaron a n8n:
   - `Calandra - PDF Drive a Railway + Telegram.json`
   - `Alertas Sin Movimiento.json`
   - `Alertas Fechas Vencidas.json`
   - `Reporte Semanal Producción.json`
   - `Reporte Semanal Calandra.json`
3. **Redeploy Evolution API** — Certificado SDK expirado (Apr 16, 2026)
4. **Verificar Calandra registre PDFs** — Después de reconectar credenciales

### Problemas de UX / Interfaz (reportados por el dueño)
1. **"Casi no le están usando"** — La interfaz necesita reestructuración completa
2. **Sidebar de Costura no se entiende** — La sección de satélites es confusa
3. **Sidebar de Arreglos no se entiende** — La sección de arreglos es confusa
4. **La app en general necesita ser más intuitiva** — Para que las vendedoras y el equipo la usen realmente

### Problemas Arquitectónicos
1. **No hay base de datos real** — Todo son archivos JSON en disco. Si el servidor se reinicia mientras escribe, se corrompe.
2. **Frontend monolítico** — 2746 líneas de JS en un solo archivo, 1759 de CSS en uno
3. **Sync bidireccional frágil** — localStorage + servidor con merge manual es propenso a conflictos
4. **Sin autenticación** — Cualquiera con la URL puede ver/modificar todo
5. **Sin SSR ni framework** — Todo vanilla, difícil de mantener y escalar
6. **Evolution API** — Certificado expirado, servicio posiblemente degradado

---

## Contexto del Negocio

- **W&S Textil** hace uniformes deportivos personalizados (sublimación)
- Flujo: cliente pide cotización → se diseña → se imprime en calandra (sublimación) → se corta → calidad → costura (parte va a satélites externos) → listo → se entrega
- **5 vendedoras**: Betty, Graciela, Ney, Wendy, Paola
- **4 satélites de costura**: Marcela, Yamile, Wilson, Cristina
- PDFs de diseño se suben a Google Drive y se envían a la calandra para impresión
- Los PDFs impresos se envían al cliente por WeTransfer
- Todo se coordina por WhatsApp + esta app + Telegram para alertas admin
- Zona horaria: America/Bogota (UTC-5)

---

## Lo que se necesita

El dueño quiere:
1. **Reestructurar toda la interfaz** — Que sea más intuitiva y que la gente la use
2. **Arreglar sidebar de costura y arreglos** — No se entienden
3. **Integrar Evolution API con los otros WhatsApp de ventas** — Tienen otras líneas de WA para ventas
4. **Planear bien todo antes de implementar** — Quiere segunda opinión

---

## Commits Recientes (últimos 30)

```
c7ade89 fix(calandra): incluir driveIndex en mapeo del frontend
f58ba6a fix(calandra): asignar driveIndex antes de filtrar para preservar orden Drive
518ebcb fix(calandra): actualizar driveIndex en registros existentes
b7ef5ff fix(calandra): corregir JSON body del POST, quitar campos nulos
d562997 fix(calandra): ordenar por driveIndex para mantener orden de Google Drive
cda9693 fix(calandra): mejorar sort por modifiedTime/createdTime/id
7933f5e fix(calandra): ordenar por modifiedTime, guardar modifiedTime en registro
41db528 Fix webapp kanban sync conflict and ultimoMovimiento state
fcd0a29 fix(wetransfer): sort records by id descending (newest first)
2e07280 chore: remove temporary DELETE /api/wetransfer/all endpoint
4178c50 temp: add DELETE /api/wetransfer/all to clean bad records
587e342 fix(wetransfer): use Bogota timezone for fecha/hora fields
7758db8 fix(wetransfer): save gmailId and prevent duplicate registrations
3a30d86 fix: prevent duplicate pedidos by phone+month, fix phone regex
2c122dc feat(bot): review last 3 days messages on startup, skip duplicates via waMsgId
72fed15 feat(bot): improve response message format, add windows autostart script
9626488 fix(railway): remove bot from railway start script, bot runs locally only
e61f0cd fix(bot-local): use pairing code instead of QR terminal
606e124 fix(bot): request pairing code before QR event using creds.registered check
fa6597e fix(bot): fix pairing code timing, add delay before request
bfc8698 fix(bot): usar pairing code en Railway, borrar sesión local
93da46e fix(bot): agregar --experimental-global-webcrypto para Node 18
e764481 feat(bot): agregar sesión WA y correr bot junto con servidor en Railway
42a423a fix(pedidos): eliminar pedido del servidor y no reagregar en sync
f1929d0 fix: pedidos eliminados no vuelven al hacer sync con servidor
4ed8203 fix: ID único en calandra para evitar colisiones cuando n8n envía múltiples PDFs simultáneos
2a26985 fix: deduplicar por archivo en frontend, los drive vienen solo del servidor
8bf72bf fix: ordenar PDFs de Drive por createdTime real, enviar fechaDrive+semana+createdTime al servidor
d507b39 feat: app muestra PDFs de Drive con estado WeTransfer enviado/pendiente
96dbc06 feat: endpoint reset calandra para limpiar datos viejos
```
