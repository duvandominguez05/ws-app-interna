const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ── CONFIGURACIÓN ────────────────────────────────────────────────
const RAILWAY_URL = 'https://ws-app-interna-production.up.railway.app';
const API_KEY     = 'ws-textil-2026';
const AUTH_DIR    = path.join(__dirname, 'wa_auth_local');
const COLA_FILE   = path.join(__dirname, 'cola_pendiente.json');
const REGEX       = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+)/i;

// ── Cola local (persiste en disco) ──────────────────────────────

function leerCola() {
  try {
    if (!fs.existsSync(COLA_FILE)) return [];
    return JSON.parse(fs.readFileSync(COLA_FILE, 'utf8'));
  } catch { return []; }
}

function guardarCola(cola) {
  fs.writeFileSync(COLA_FILE, JSON.stringify(cola, null, 2));
}

function encolar(item) {
  const cola = leerCola();
  // No encolar duplicados por waMsgId
  if (cola.some(c => c.waMsgId === item.waMsgId)) return;
  cola.push(item);
  guardarCola(cola);
  console.log(`[cola] Guardado localmente: ${item.tipo} de ${item.vendedora} (${item.waMsgId})`);
}

function desencolar(waMsgId) {
  const cola = leerCola().filter(c => c.waMsgId !== waMsgId);
  guardarCola(cola);
}

// ── Envío al servidor ────────────────────────────────────────────

async function subirAlServidor(item) {
  const response = await fetch(`${RAILWAY_URL}/api/venta`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      tipo:      item.tipo,
      vendedora: item.vendedora,
      telefono:  item.telefono,
      waMsgId:   item.waMsgId,
      key:       API_KEY,
    }),
  });
  return response.json();
}

// ── Procesar un mensaje detectado ────────────────────────────────

async function procesarMensaje(tipo, vendedora, telefono, waMsgId) {
  const item = { tipo, vendedora, telefono, waMsgId };

  try {
    const result = await subirAlServidor(item);

    if (result.ok) {
      if (result.duplicado) {
        console.log(`⚠️  Duplicado ignorado: waMsgId=${waMsgId}`);
      } else {
        console.log(`✅ Pedido #${result.id} subido — ${vendedora} ${tipo}`);
      }
      desencolar(waMsgId);
      return result;
    } else {
      console.error(`❌ Error servidor: ${result.error} → encolando`);
      encolar(item);
    }

  } catch (err) {
    console.error(`❌ Sin conexión con Railway: ${err.message} → encolando`);
    encolar(item);
  }
  return null;
}

// ── Reintentar cola pendiente ────────────────────────────────────

async function reintentarCola() {
  const cola = leerCola();
  if (cola.length === 0) return;

  console.log(`[cola] Reintentando ${cola.length} pendiente(s)...`);

  for (const item of cola) {
    try {
      const result = await subirAlServidor(item);

      if (result.ok) {
        if (result.duplicado) {
          console.log(`⚠️  Cola: duplicado ignorado waMsgId=${item.waMsgId}`);
        } else {
          console.log(`✅ Cola: subido pedido #${result.id} — ${item.vendedora} ${item.tipo}`);
        }
        desencolar(item.waMsgId);
      } else {
        console.error(`❌ Cola: error servidor para ${item.waMsgId}: ${result.error}`);
      }

    } catch (err) {
      console.log(`[cola] Aún sin conexión (${err.message}), se reintentará...`);
      break; // Si no hay red, no seguir intentando el resto
    }
  }
}

// ── Bot WhatsApp ─────────────────────────────────────────────────

let sockGlobal = null;

async function conectarBot() {
  console.log('🚀 Iniciando Bot Local de W&S Textil...');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = sockGlobal = makeWASocket({
    auth:                  state,
    printQRInTerminal:     true,
    browser:               Browsers.macOS('Edge'),
    connectTimeoutMs:      60000,
    defaultQueryTimeoutMs: 0,
    syncFullHistory:       true, // Pide historial al reconectarse
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('❌ Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) conectarBot();
    } else if (connection === 'open') {
      console.log('✅ Bot Conectado — revisando cola pendiente...');
      reintentarCola(); // Al reconectar, subir lo que quedó pendiente
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      // Ignorar mensajes de más de 48 horas
      const msgTs = (msg.messageTimestamp || 0) * 1000;
      if (msgTs < Date.now() - 48 * 60 * 60 * 1000) continue;

      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const match = texto.match(REGEX);
      if (!match) continue;

      const [, tipo, vendedora, telefono] = match;
      const waMsgId = msg.key.id;
      const chatId  = msg.key.remoteJid;

      console.log(`📡 Detectado: #${tipo} de ${vendedora} — procesando...`);
      const result = await procesarMensaje(tipo, vendedora, telefono.replace(/\s/g, ''), waMsgId);

      // Responder al grupo (reply al mensaje original)
      if (result && result.ok && !result.duplicado && sockGlobal) {
        const esPedido = tipo.toLowerCase() === 'pedido';
        const textoRespuesta = esPedido
          ? `*Pedido #${result.id} registrado*\nVendedora: ${result.vendedora}\nTelefono: ${telefono.replace(/\s/g, '')}\nEstado: En diseno`
          : `*Cotizacion #${result.id} registrada*\nVendedora: ${result.vendedora}\nTelefono: ${telefono.replace(/\s/g, '')}`;
        await sockGlobal.sendMessage(chatId, { text: textoRespuesta }, { quoted: msg });
      }
    }
  });
}

// ── Reintento periódico cada 30 segundos ────────────────────────
setInterval(reintentarCola, 30_000);

conectarBot();
