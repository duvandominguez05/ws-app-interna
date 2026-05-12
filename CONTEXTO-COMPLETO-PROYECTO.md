# W&S Textil — App Interna: Contexto Completo del Proyecto

## Qué es esto
App interna de producción para **W&S Textil**, una empresa de uniformes deportivos en Colombia (Bogotá). Maneja todo el flujo desde que un cliente pide una cotización hasta que se entrega el producto final.

---

## Stack Técnico

| Capa | Tecnología |
|------|-----------|
| **Backend** | Node.js puro (sin Express), HTTP server vanilla — `server.js` (~2,436 líneas) |
| **Frontend** | HTML + CSS + JS vanilla: `index.html`, `public/css/style.css`, `public/js/app.js` |
| **Base de datos** | Archivos JSON en disco (`data/*.json`) — NO hay base de datos relacional |
| **Hosting** | Railway (auto-deploy on git push) |
| **Automatizaciones** | n8n (self-hosted en Railway) — 13 workflows |
| **Bot WhatsApp** | Baileys (`bot-local.js`) — corre local en la PC del dueño con cola offline |
| **Notificaciones** | Telegram Bot → grupo "W&S Textil Admin" + WA grupo "Trabajo en familia" |
| **Integraciones** | Google Drive (OAuth2), Gmail, WeTransfer (vía n8n), Evolution API, Chatwoot, Gemini Flash |
| **PWA** | manifest.json configurado, se puede instalar como app |

### URLs
- **Producción**: `https://ws-app-interna-production.up.railway.app`
- **API Key**: `ws-textil-2026`

---

## Estructura de Archivos

```
ws-app-interna/
├── server.js              # Backend completo (~2,436 líneas, Node.js puro)
│                          # Incluye: 30+ endpoints API, webhook Evolution,
│                          # detector de comprobantes Gemini Flash,
│                          # lector de tablero con Gemini Vision,
│                          # notificaciones Telegram/WA/Chatwoot,
│                          # sistema de PDFs huérfanos, sync-todo
├── index.html             # Frontend completo (914 líneas, HTML)
├── public/
│   ├── css/style.css      # Estilos (~1,868 líneas, glassmorphism, dark mode)
│   └── js/app.js          # Lógica frontend (~3,932 líneas)
│                          # Dashboard "Mi Día" por roles, kanban,
│                          # satélites proactivos, arreglos triage
├── bot-local.js           # Bot WA activo con Baileys + cola offline (121 líneas)
├── bot.js                 # Bot WA original (legacy, sin cola offline)
├── bot-puppeteer.js       # Bot WA alternativo Puppeteer (backup)
├── data/                  # "Base de datos" JSON
│   ├── pedidos.json       # Pedidos y cotizaciones
│   ├── calandra.json      # Registros de metraje calandra
│   ├── arreglos.json      # Arreglos manuales
│   ├── satelites.json     # Movimientos satélites costura
│   ├── docsNums.json      # Numeración facturas/cotizaciones
│   ├── nextId.json        # Auto-increment ID pedidos
│   ├── wetransfer.json    # Registros WeTransfer
│   ├── comprobantes-detectados.json  # Pagos detectados por Gemini
│   ├── notificaciones.json          # Campana compartida
│   ├── config.json                  # Configuración compartida
│   └── evolution-events/            # Logs crudos de webhooks
├── WORKFLOWS/             # 13 workflows de n8n (JSON exportados)
├── n8n/                   # Workflow adicional n8n
├── manifest.json          # PWA config
├── package.json           # 5 dependencias
├── iniciar-bot.bat        # Script para arrancar server + bot local
└── PLAN_CERO_CLICS.md     # Roadmap de automatización (5 sprints)
```

---

## Secciones de la App (Sidebar)

### 1. Vista General (Dashboard)
- KPIs: activos, diseño, producción, listos, m² calandra, pendientes satélites
- **Dashboard "Mi Día"** con selector de rol (Ventas/Diseño/Producción/Costura)
- Panel de entregas próximas
- Pipeline de producción (cuántos en cada etapa)
- Resumen de satélites pendientes
- Resumen calandra semanal

### 2. Torre de Control
- Vista de semáforos: pedidos con alertas por antigüedad
- Timeline visual de todos los pedidos activos

### 3. PDFs Sin Asignar (Huérfanos)
- Archivos en Drive/WT que no coinciden con ningún pedido
- Sugerencias automáticas por similitud de nombres
- Acciones: vincular a pedido, crear pedido nuevo, ignorar

### 4. Tablero (Foto)
- Sube foto del tablero físico de producción
- Gemini Vision lee las columnas y extrae los pedidos
- Sincroniza automáticamente con la app

### 5. Ventas (Bandeja)
- Dos columnas: **Cotizaciones** y **Pedidos confirmados**
- Búsqueda por equipo o teléfono
- Completar pedido (agregar prendas, fecha entrega, notas)

### 6. Diseño (Kanban)
- 3 columnas: **Hacer diseño** → **Confirmado** → **Enviado a calandra**
- Asignación de diseñador por pedido

### 7. Producción (Kanban)
- 6 columnas: **Llegó impresión** → **Corte** → **Calidad** → **Costura** → **Listo** → **Enviado**

### 8. Arreglos (Triage)
- Vista unificada tipo "emergencias" con tarjetas urgentes
- Arreglos de pedidos en producción + registros manuales
- Botones rápidos "Marcar Resuelto"

### 9. WeTransfer
- Control de envíos y descargas de PDFs
- Registro manual o automático (n8n detecta descargas vía Gmail)

### 10. Calandra (Metraje)
- Métricas: metros esta semana, metros hoy, archivos hoy
- Selector de ancho de tela
- Panel de PDFs pendientes de envío por WeTransfer

### 11. Satélites (Costura) — REDISEÑADO
- **Vista proactiva de dos columnas**:
  - "📦 Para Enviar" — pedidos en estado `costura`, con dropdown de satélite
  - "🧵 En Satélite" — pedidos en estado `en-satelite`, con botón "Recibir"
- Historial colapsable de movimientos

### 12. Facturas y Cotizaciones
- Generador de cotizaciones y facturas en PDF (html2pdf.js)
- Historial con búsqueda y filtros

---

## Flujo de un Pedido (Estados)

```
bandeja → hacer-diseno → confirmado → enviado-calandra → llego-impresion → corte → calidad → costura → en-satelite → listo → enviado-final
```

### Cómo entran pedidos:
1. **Manual**: botón "Nuevo pedido" en la app
2. **Bot WhatsApp local**: mensaje `#cotizar vendedora telefono equipo` o `#pedido ...`
3. **Reacción WhatsApp** (Evolution API): 🟡 = cotización, 🎨 = diseño confirmado
4. **Sticker WhatsApp** (Evolution API): sticker "VENTA CONFIRMADA"
5. **Etiqueta "En proceso"** (Evolution API): auto-crea pedido confirmado
6. **Foto del tablero** (Gemini Vision): lee el tablero físico y sincroniza

### Automatizaciones implementadas (Sprint 1 Cero Clics — COMPLETADO):
- Reacciones WhatsApp: 🟡 cotización, 🎨 diseño→confirmado, 📦 llegó impresión, 🧵 costura lista, ✅ entregado
- Sticker de venta → avanza cotización o crea pedido directo
- Detector de comprobantes de pago con Gemini Flash
- Resumen de comprobantes a las 8PM a cada vendedora por WA
- Auto-avance: cuando PDF en Drive + correo WeTransfer están listos → enviado-calandra

---

## APIs del Backend (30+ endpoints)

| Método | Ruta | Función |
|--------|------|---------|
| GET | `/api/pedidos` | Lista todos los pedidos |
| POST | `/api/pedidos` | Sync completo con merge inteligente |
| DELETE | `/api/pedidos/:id` | Elimina un pedido |
| POST | `/api/venta` | Bot crea cotización/pedido (requiere API key) |
| GET/POST | `/api/calandra` | Registros de metraje |
| DELETE | `/api/calandra/:id` | Borra registro calandra |
| DELETE | `/api/calandra/reset` | Limpia todos los registros |
| GET | `/api/drive-pdfs` | PDFs de Drive con estado WT |
| GET/POST | `/api/wetransfer` | Registros WeTransfer |
| GET/POST | `/api/docs/nums` | Numeración facturas/cotizaciones |
| GET/POST | `/api/pendientes-wt` | PDFs pendientes de WT |
| GET/POST | `/api/arreglos` | Control de arreglos |
| GET/POST | `/api/satelites` | Movimientos de satélites |
| GET/POST | `/api/notificaciones` | Campana compartida |
| GET/POST | `/api/config` | Configuración compartida |
| GET | `/api/sync-todo` | Todo el estado en 1 request (mobile) |
| POST | `/api/evolution-webhook` | Webhook Evolution API (reacciones, stickers, etiquetas, imágenes) |
| POST | `/api/webhook/chatwoot` | Webhook Chatwoot (etiquetas) |
| POST | `/api/tablero/foto` | Lectura del tablero con Gemini Vision |
| GET | `/api/pdfs-huerfanos` | Archivos sin pedido asociado |
| POST | `/api/pdfs-huerfanos/vincular` | Vincular archivo a pedido |
| POST | `/api/pdfs-huerfanos/crear-pedido` | Crear pedido desde archivo |
| POST | `/api/pdfs-huerfanos/ignorar` | Ignorar archivo |
| GET | `/api/comprobantes-detectados` | Comprobantes detectados por Gemini |
| POST | `/api/comprobantes-detectados/marcar-procesados` | Marcar como procesados |
| GET | `/api/health-reacciones` | Health check del sistema de reacciones |
| GET | `/api/evolution-logs` | Logs de eventos Evolution |
| GET | `/api/telegram-updates` | Diagnóstico Telegram |

---

## Workflows de n8n (13 en total)

### Alertas y Notificaciones
1. **Alerta Fechas Próximas** — Diario 8am → pedidos que vencen en 1-2 días
2. **Alertas Fechas Vencidas** — Diario 7pm → pedidos con fecha vencida
3. **Alertas Sin Movimiento** — Diario 7pm → pedidos parados +3 días
4. **Listo para Entregar** — Cuando un pedido pasa a "listo"

### Calandra / Google Drive
5. **Calandra - PDF Drive a Railway + Telegram** — Cada 5min → PDFs nuevos en Drive
6. **Watcher PDF Drive** — Monitor adicional de Drive

### WeTransfer
7. **WeTransfer Descargado** — Detecta emails WT vía Gmail
8. **WeTransfer - Registrar Enviados** — Registra envíos desde la app
9. **PDF Drive vs WeTransfer - Alerta WA** — Compara y alerta faltantes

### Reportes
10. **Reporte Semanal Producción** — Lunes 8am
11. **Reporte Semanal Calandra** — Domingo 7pm
12. **Resumen Comprobantes 8PM** — Pagos detectados por Gemini
13. **Recordatorio Foto Tablero 8AM** — Recordatorio diario

---

## Contexto del Negocio

- **W&S Textil** hace uniformes deportivos personalizados (sublimación)
- Flujo: cliente pide cotización → se diseña → se imprime en calandra → se corta → calidad → costura (satélites externos) → listo → se entrega
- **5 vendedoras**: Betty, Graciela, Ney, Wendy, Paola
- **4 satélites de costura**: Marcela, Yamile, Wilson, Cristina
- Zona horaria: America/Bogota (UTC-5)

---

## Infraestructura en Railway

1. **ws-app-interna** — La app Node.js (backend + frontend)
2. **n8n** — Automatizaciones (self-hosted)
3. **Evolution API** — WhatsApp multi-instancia (ws-ventas, ws-ney, ws-wendy, ws-paola)
4. **Chatwoot** — Chat/CRM para ventas externas

---

## Estado del Plan Cero Clics

| Sprint | Estado |
|--------|--------|
| Sprint 1 — Conectividad WhatsApp | ✅ Completado (reacciones, stickers, etiquetas, comprobantes Gemini) |
| Sprint 2 — Drive como fuente de verdad | ⏳ Pendiente |
| Sprint 3 — Cierre automático de diseño | ⏳ Pendiente |
| Sprint 4 — Cierre automático de producción | ⏳ Pendiente |
| Sprint 5 — Mini-app costureras | ⏳ Pendiente |

*Última actualización: Mayo 9, 2026*
