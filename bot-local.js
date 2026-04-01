const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_URL  = 'https://ws-app-interna-production.up.railway.app';
const AUTH_DIR = path.join(__dirname, 'wa_auth_local');
const COLA_FILE = path.join(__dirname, 'cola_pendiente.json');
const PHONE    = process.env.WA_PHONE_NUMBER || '573133064614';
const REGEX    = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+?)(?:\s+(.+))?$/i;

// ── Cola local ───────────────────────────────────────────────────
function leerCola() {
  try { return fs.existsSync(COLA_FILE) ? JSON.parse(fs.readFileSync(COLA_FILE, 'utf8')) : []; }
  catch { return []; }
}
function guardarCola(cola) { fs.writeFileSync(COLA_FILE, JSON.stringify(cola, null, 2)); }
function encolar(item) {
  const cola = leerCola();
  if (cola.some(c => c.waMsgId === item.waMsgId)) return;
  cola.push(item);
  guardarCola(cola);
  console.log('[cola] Guardado localmente:', item.tipo, item.vendedora);
}
function desencolar(id) { guardarCola(leerCola().filter(c => c.waMsgId !== id)); }

// ── API ──────────────────────────────────────────────────────────
async function subirVenta(item) {
  const res = await fetch(`${API_URL}/api/venta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: item.tipo, vendedora: item.vendedora, telefono: item.telefono, equipo: item.equipo || '', waMsgId: item.waMsgId, key: 'ws-textil-2026' }),
  });
  return res.json();
}

async function reintentarCola() {
  const cola = leerCola();
  if (!cola.length) return;
  console.log('[cola] Reintentando', cola.length, 'pendiente(s)...');
  for (const item of cola) {
    try {
      const r = await subirVenta(item);
      if (r.ok) { desencolar(item.waMsgId); console.log('[cola] Subido #' + r.id); }
      else console.error('[cola] Error:', r.error);
    } catch (e) { console.log('[cola] Sin conexion, reintentando luego...'); break; }
  }
}

// ── Bot ──────────────────────────────────────────────────────────
let sockGlobal = null;

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sockGlobal = sock;
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    console.log('[bot] Solicitando pairing code para', PHONE, '...');
    await new Promise(r => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(PHONE);
      console.log('\n==============================');
      console.log('PAIRING CODE: ' + code);
      console.log('Ingresa en WhatsApp > Dispositivos vinculados > Vincular con numero de telefono');
      console.log('==============================\n');
    } catch (e) { console.error('[bot] Error pairing code:', e.message); }
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const ok = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexion cerrada. Reconectando:', ok);
      if (ok) setTimeout(conectar, 5000);
    } else if (connection === 'open') {
      console.log('✅ Bot conectado!');
      reintentarCola();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const msgTs = (msg.messageTimestamp || 0) * 1000;
      if (msgTs < Date.now() - 48 * 60 * 60 * 1000) continue;
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const match = texto.match(REGEX);
      if (!match) continue;

      const [, tipo, vendedora, telefono, equipo] = match;
      const waMsgId = msg.key.id;
      const chatId  = msg.key.remoteJid;
      console.log('[bot] Detectado: #' + tipo, vendedora, telefono);

      const item = { tipo, vendedora, telefono: telefono.replace(/\s/g, ''), equipo: equipo || '', waMsgId };
      try {
        const result = await subirVenta(item);
        if (result.ok) {
          desencolar(waMsgId);
          if (!result.duplicado) {
            const txt = tipo === 'pedido'
              ? `Pedido #${result.id} registrado\nVendedora: ${result.vendedora}\nTelefono: ${item.telefono}`
              : `Cotizacion #${result.id} registrada\nVendedora: ${result.vendedora}\nTelefono: ${item.telefono}`;
            await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
          }
        } else {
          encolar(item);
        }
      } catch (e) {
        console.error('[bot] Error:', e.message);
        encolar(item);
      }
    }
  });
}

setInterval(reintentarCola, 30_000);
conectar();
