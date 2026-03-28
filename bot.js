const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const path = require('path');
const http = require('http');
const qrcode = require('qrcode-terminal');

const API_URL  = process.env.API_URL   || 'http://localhost:3000';
const AUTH_DIR = path.join(__dirname, 'data', 'wa_auth');
const GRUPO_ID = process.env.WA_GRUPO_ID || '573506974711-16128410420@g.us';

const REGEX = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+)/i;

// Socket global para que server.js pueda enviar alertas
let sockGlobal = null;

async function enviarAlerta(texto) {
  if (!sockGlobal) return;
  try {
    await sockGlobal.sendMessage(GRUPO_ID, { text: texto });
  } catch (e) {
    console.error('[bot] Error enviando alerta:', e.message);
  }
}

async function crearVenta(tipo, vendedora, telefono) {
  const res = await fetch(`${API_URL}/api/venta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo, vendedora, telefono: telefono.replace(/\s/g, '') }),
  });
  return res.json();
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sockGlobal = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR con WhatsApp del número del bot:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) conectar();
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp conectado');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const match = texto.match(REGEX);
      if (!match) continue;

      const [, tipo, vendedora, telefono] = match;
      console.log(`[bot] Detectado: #${tipo} ${vendedora} ${telefono}`);

      try {
        const result = await crearVenta(tipo, vendedora, telefono);
        const jid = msg.key.remoteJid;
        if (result.ok) {
          await sock.sendMessage(jid, {
            text: `✅ ${tipo === 'pedido' ? 'Pedido' : 'Cotización'} #${result.id} creado\n👤 Vendedora: ${result.vendedora}\n📞 Tel: ${result.telefono}`,
          });
        } else {
          await sock.sendMessage(jid, { text: `❌ Error: ${result.error}` });
        }
      } catch (e) {
        console.error('[bot] Error al crear venta:', e.message);
      }
    }
  });
}

conectar();

// Servidor interno para recibir alertas desde server.js
const BOT_PORT = process.env.BOT_PORT || 3001;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/alerta') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { texto } = JSON.parse(body);
        await enviarAlerta(texto);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(BOT_PORT, () => console.log(`[bot] Servidor interno en puerto ${BOT_PORT}`));
