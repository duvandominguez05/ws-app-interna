# Plan "Cero Clics" — W&S Enterprise

> Automatización integral de la app interna para que los pedidos avancen de fase solos, detectando eventos en WhatsApp, Drive y Gmail.

---

## Visión general

Que la app W&S **avance los pedidos de fase sola**, detectando eventos en WhatsApp, Drive y Gmail. Nadie entra a la app a mover pedidos manualmente.

---

## Cómo se divide el trabajo técnico

```
┌─────────────────────────────────────────────────────┐
│  WhatsApp (tiempo real)  → Webhook directo a app   │
│  Drive + Gmail + Reportes → n8n (ya funcionando)   │
└─────────────────────────────────────────────────────┘
```

**Nada que ya funciona se rompe.** Los 11 workflows de n8n siguen activos.

### Workflows n8n existentes (no se tocan)

- Watcher PDF Drive
- Calandra PDF Drive a Railway + Telegram
- WeTransfer Descargado
- WeTransfer Registrar Enviados App Web
- Alerta Fechas Próximas
- Alertas Fechas Vencidas
- Alertas Sin Movimiento
- Listo para Entregar
- PDF Drive vs WeTransfer - Alerta WA
- Reporte Semanal Calandra
- Reporte Semanal Producción

---

## Plan maestro — 5 Sprints

### Sprint 1 — Conectividad WhatsApp (EN EJECUCIÓN)

**Objetivo:** que la app pueda recibir y entender lo que pasa en WhatsApp.

- [ ] Crear endpoint `POST /api/evolution-webhook` en `server.js`
- [ ] Guardar cada evento crudo en `data/evolution-events/YYYY-MM-DD.json` (para debug)
- [ ] Detectar etiqueta **"En proceso 👍👍👍"** → auto-crear pedido (asignado a Betty, estado Confirmado)
- [ ] Dedupe robusto (JID + fecha + contenido — no solo JID, porque un cliente puede tener varios pedidos)
- [ ] Capturar hash de los 3 stickers
- [ ] Conectar cada sticker a su acción:
  - **APROBADO** (cliente) → Esperando aprobación → Listo para Calandra
  - **DISEÑO LISTO** (diseñador) → En diseño → Esperando aprobación + aviso Betty
  - **TERMINADO** (costurera) → En costura → Listo para Entregar

**Pausa de verificación:** 1 semana probando con el equipo real antes de pasar a Sprint 2.

---

### Sprint 2 — Drive como fuente de verdad

**Objetivo:** cada pedido tiene su carpeta Drive automática y los archivos se ven en la app.

- [ ] Al crear un pedido → n8n auto-crea carpeta Drive `2026_ID_Equipo_Cliente`
- [ ] Mostrar archivos del Drive en la tarjeta del pedido (link vivo, no copias)

---

### Sprint 3 — Cierre automático de diseño

**Objetivo:** la fase de diseño se cierra sola cuando el cliente aprueba.

- [ ] Grupo WA diseñadores → detecta foto subida → marca "diseño enviado al cliente"
- [ ] Cliente responde sticker APROBADO → mueve a "Listo para Calandra" *(ya cubierto por Sprint 1)*

---

### Sprint 4 — Cierre automático de producción

**Objetivo:** calandra y costura cierran solas.

- [ ] Gmail watcher **enviados a calandra** → mueve pedido a "Enviado Calandra" *(complementa al workflow "WeTransfer Descargado" que ya existe)*
- [ ] **Semáforo 24h:** borde rojo en el Kanban si un pedido lleva >24h estancado en la misma fase

---

### Sprint 5 — Mini-app costureras

**Objetivo:** vista móvil simple para las satélites de costura.

- [ ] Vista móvil minimalista: "mis pedidos asignados", botón grande **"✅ Terminé"** con foto obligatoria
- [ ] Evaluar contra sticker TERMINADO: cuál funciona mejor con el equipo

---

## Los 3 stickers WhatsApp

| Sticker | Color | Quién lo usa | Función |
|---|---|---|---|
| **APROBADO** | Verde fuerte (#22C55E) | Cliente | Aprueba diseño → va a calandra |
| **DISEÑO LISTO** | Azul fuerte (#2563EB) | Diseñador | Diseño terminado → avisa a Betty |
| **TERMINADO** | Verde oscuro (#16A34A) | Costurera | Equipo listo → lista para entregar |

### Specs técnicas

- **Tamaño:** 512 x 512 píxeles (cuadrado exacto)
- **Formato:** PNG con fondo transparente
- **Peso:** menos de 100 KB
- **Margen:** ~16 px en cada lado
- **Fuente:** Impact, Bebas Neue o Montserrat Black (gorda y legible)
- **Logo W&S:** pequeño en una esquina

### Herramientas recomendadas

- **Sticker Maker** (app Play Store / App Store) — gratis, recorta y exporta a WhatsApp automático
- **Canva** — si prefieres diseñar en computador (plantillas 512x512 listas)

### Stickers futuros (si los 3 iniciales funcionan)

- **PAGADO** — Betty confirma pago recibido
- **DESPACHADO** — cuando sale del taller con guía
- **CAMBIOS** — cliente pide ajustes antes de aprobar

---

## Flujo técnico de los stickers

```
1. Cliente manda sticker APROBADO en WhatsApp
        ↓
2. Evolution API detecta el sticker y manda POST a la app:
   {
     "event": "messages.upsert",
     "type": "stickerMessage",
     "hash": "a3f5b9c2...",
     "from": "573001234567",
     "timestamp": 1713800000
   }
        ↓
3. App recibe en /api/evolution-webhook
        ↓
4. App identifica hash → acción: mover a Listo para Calandra
        ↓
5. App busca en data/pedidos.json el pedido del teléfono
   en estado "Esperando aprobación"
        ↓
6. Lo encuentra → cambia estado → guarda JSON
        ↓
7. Kanban se refresca → pedido aparece en columna nueva
```

**Todo en menos de 2 segundos. Nadie toca la app.**

### Mapeo sticker → acción

| Sticker llega | La app ejecuta |
|---|---|
| APROBADO (del cliente) | `moverPedido(id, "Listo para Calandra")` |
| DISEÑO LISTO (del diseñador) | `moverPedido(id, "Esperando aprobación cliente")` + `notificarBetty(id)` |
| TERMINADO (de la costurera) | `moverPedido(id, "Listo para Entregar")` |

### Cómo se empareja sticker con pedido

1. **Por teléfono del remitente** (método principal, cubre 80% de casos)
2. **Por grupo + contexto** (grupos con cliente específico)
3. **Por texto antes del sticker** (menciona nombre de equipo)

### Casos borde a resolver con la marcha

- Cliente con 2 pedidos activos → pedir que mencione nombre de equipo
- Sticker enviado por error → botón "deshacer último cambio" en la app
- Sticker equivocado para la fase → la app solo acepta el sticker que corresponde al estado actual

---

## Ideas aprobadas en evaluación (no comprometidas)

- **Validador de pagos** — Betty pega pantallazo → reglas simples → marca tentativo, siempre confirma humano
- **Guía de envío OCR** — detectar número de guía en foto → auto-mover a "Enviado final"
- **Auto-backup diario** de `data/pedidos.json` a Drive
- **Reportes a WhatsApp grupo producción** cada viernes
- **Recordatorio pagos pendientes** cada 3 días a Betty
- **Cumpleaños de clientes** (si se guarda fecha de nacimiento)

---

## Regla de oro

> **Terminado un sprint → pausa de 1 semana probando con el equipo real antes del siguiente.**
>
> Si algo no funciona en producción, se ajusta. Si funciona, se sigue.

---

## Pendientes para arrancar Sprint 1

**De parte del usuario (Duvan):**

1. Crear los 3 stickers (empezar por APROBADO y mandarlo de prueba)
2. Confirmar **URL de Evolution API en Railway**
3. Decidir: ¿webhook público o con token/secreto? *(recomendado: token)*

**De parte de Claude:**

1. Crear endpoint `POST /api/evolution-webhook` en `server.js`
2. Crear carpeta `data/evolution-events/` para logs crudos
3. Implementar dedupe por JID + fecha + contenido
4. Capturar hash cuando lleguen los stickers de prueba

---

## Infraestructura actual (referencia rápida)

- **App:** Node.js HTTP server (`server.js`) + vanilla HTML/CSS/JS en Railway
- **Datos:** JSON files en `data/*.json` (no hay DB relacional)
- **Drive:** carpeta compartida "corel" (diseñadores) + carpeta PDFs finales
- **WhatsApp:** Evolution API en Railway
- **Automatización:** n8n en Railway (11 workflows activos)
- **Deploy:** auto-deploy al hacer `git push` a `main`

### Identificadores clave

- URL prod: `https://ws-app-interna-production.up.railway.app`
- Carpeta PDFs Drive (ID): `1qaEI69DxqwDCE_Ce4UKHAQjCVcdgx_qy`
- Telegram admin: `-5135765805`
- Telegram grupo producción: `-1003751103154`
- Convención PDFs calandra: `NombreEquipo_AltoEnCm.pdf` (ancho asumido = 1.0 m)
