# Handoff: ws-app-interna — Bot WhatsApp en Railway

## Estado actual (28 Mar 2026)

El proyecto está deployado en Railway y la app web funciona. El problema es que el **bot de WhatsApp no se conecta** porque la sesión guardada en el volumen de Railway está inválida (el usuario cerró la sesión desde el teléfono).

El bot entra en loop: intenta conectarse con la sesión vieja → WhatsApp la rechaza → `Reconectando: false` → se detiene.

---

## El problema concreto

El bot usa Baileys (@whiskeysockets/baileys) con sesión guardada en `/app/data/wa_auth/` (volumen de Railway).

La sesión está corrupta/inválida. Hay que:
1. Borrar `/app/data/wa_auth/` desde dentro del proceso vivo
2. Que el bot genere un QR nuevo en los logs
3. Escanear ese QR con WhatsApp del número del bot
4. Guardar la nueva sesión como variable `WA_CREDS_B64` en Railway

**Lo que ya se intentó sin éxito:**
- `railway run rm -rf /app/data/wa_auth` → el volumen no está montado en `railway run`
- `railway run node -e "require('fs').rmSync(...)"` → dijo "borrado" pero el volumen no era el real
- Agregar endpoint `POST /api/reset-wa` en server.js → está en el código, el deploy está activo, pero al llamarlo con curl no aparece el QR en los logs

**El endpoint `/api/reset-wa` ya existe en server.js** (líneas 432-443). Hace:
```js
if (sockGlobal) { sockGlobal.end(); sockGlobal = null; }
fs.rmSync(AUTH_DIR, { recursive: true, force: true });
setTimeout(() => conectarBot(), 1000);
```

Puede que no esté funcionando porque `printQRInTerminal: false` en `makeWASocket` — el QR no se imprime automáticamente. Se imprime solo si llega el evento `qr` y se llama `qrcode.generate()`.

---

## Archivos del proyecto

- **Repositorio GitHub:** `duvandominguez05/ws-app-interna` (rama `main`)
- **Railway:** proyecto `content-creativity`, servicio `ws-app-interna`
- **URL pública:** `https://ws-app-interna-production.up.railway.app`
- **Volumen Railway:** `ws-app-interna-volume` montado en `/app/data`

### Archivos locales
- `C:/CLAUDE/ws-app-interna/server.js` — servidor + bot todo en uno
- `C:/CLAUDE/ws-app-interna/index.html` — frontend app web
- `C:/CLAUDE/ws-app-interna/package.json`
- `C:/CLAUDE/ws-app-interna/.gitignore`

---

## Arquitectura

Un solo proceso Node.js (`server.js`) que hace dos cosas:
1. **Servidor HTTP** en puerto `$PORT` (Railway lo pone en 8080) — sirve `index.html` y los endpoints `/api/*`
2. **Bot WhatsApp** con Baileys — escucha mensajes en grupo, crea pedidos/cotizaciones

### Variables de entorno en Railway
- `WA_GRUPO_ID` = `573506974711-16128410420@g.us` (ID del grupo de WhatsApp)
- `WA_CREDS_B64` = sesión WhatsApp en base64 (ACTUALMENTE VACÍA o inexistente — se borró para forzar QR nuevo)

### Volumen Railway
Montado en `/app/data`. Contiene:
- `wa_auth/` — sesión WhatsApp (creds.json + keys)
- `pedidos.json` — datos de pedidos
- `nextId.json` — contador de IDs
- `calandra.json`, `wetransfer.json`, `docsNums.json` — otros datos

---

## Cómo funciona el bot

Lee mensajes del grupo de WhatsApp. Cuando detecta:
```
#pedido Betty 3124567890
#cotizar Wendy 3001234567
```
Crea el pedido/cotización en el servidor y responde confirmación.

Vendedoras válidas: `betty`, `graciela`, `ney`, `wendy`, `paola`

Regex: `/^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+)/i`

---

## Lo que hay que resolver

### Paso 1: Forzar QR nuevo
El endpoint `POST /api/reset-wa` ya existe. Llamarlo con:
```bash
curl -X POST https://ws-app-interna-production.up.railway.app/api/reset-wa
```
Debería borrar la sesión y llamar `conectarBot()` de nuevo, lo que dispara el evento `qr`.

Si no funciona, el problema puede ser que `printQRInTerminal` está en `false` (línea 38 de server.js) — cambiar a `true` y hacer push.

### Paso 2: Ver el QR
En Railway → Deployments → Deploy Logs → desplazar al inicio del log actual.
El QR aparece como texto ASCII en los logs.

### Paso 3: Escanear el QR
Con WhatsApp del número del bot (no del usuario, sino el número dedicado al bot).
WhatsApp → Dispositivos vinculados → Vincular dispositivo → Escanear QR

### Paso 4: Guardar la sesión
Una vez conectado, guardar la sesión para que sobreviva redeploys:
```bash
cd C:/CLAUDE/ws-app-interna
railway variables --set "WA_CREDS_B64=$(railway run cat /app/data/wa_auth/creds.json | base64 -w 0)"
```
O desde terminal local si tienes acceso al volumen.

---

## Código relevante de server.js

```js
// Top del archivo — polyfill crypto para Node 18
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

// Restaurar sesión desde variable de entorno al iniciar
const AUTH_DIR_INIT = path.join(__dirname, 'data', 'wa_auth');
if (process.env.WA_CREDS_B64 && !fs.existsSync(path.join(AUTH_DIR_INIT, 'creds.json'))) {
  fs.mkdirSync(AUTH_DIR_INIT, { recursive: true });
  fs.writeFileSync(
    path.join(AUTH_DIR_INIT, 'creds.json'),
    Buffer.from(process.env.WA_CREDS_B64, 'base64').toString('utf8')
  );
}

// Bot
const AUTH_DIR = path.join(__dirname, 'data', 'wa_auth');
let sockGlobal = null;

async function conectarBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false }); // <-- cambiar a true si no aparece QR
  sockGlobal = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR:\n');
      qrcode.generate(qr, { small: true }); // imprime QR en logs de Railway
    }
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) conectarBot();
    }
  });
}
```

---

## Dependencias (package.json)
```json
{
  "dependencies": {
    "@hapi/boom": "^10.0.1",
    "@whiskeysockets/baileys": "^6.5.0",
    "node-fetch": "^2.7.0",
    "qrcode-terminal": "^0.12.0"
  }
}
```

---

## Comandos útiles Railway CLI
```bash
cd C:/CLAUDE/ws-app-interna
railway login
railway link  # seleccionar: content-creativity → production → ws-app-interna
railway redeploy
railway variables  # ver variables
railway variables --set "NOMBRE=valor"
railway logs  # ver logs en tiempo real
```

---

## Historial de problemas resueltos
- `ReferenceError: crypto is not defined` → polyfill `global.crypto = webcrypto` al top de server.js
- App web mostraba pedidos vacíos → `guardar()` se llamaba al inicio con localStorage vacío, sobreescribía servidor. Fix: `if (pedidos.length > 0) guardar()`
- Bot en proceso separado (bot.js) → fusionado en server.js para Railway (un solo proceso)
- Sesión WhatsApp no persistía entre redeploys → Railway Volume en `/app/data` + variable `WA_CREDS_B64`
