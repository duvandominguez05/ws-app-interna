const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const path = require('path');

const API_URL  = process.env.API_URL   || 'https://ws-app-interna-production.up.railway.app';
const AUTH_DIR = path.join(__dirname, 'wa_auth_local');
const GRUPO_ID = process.env.WA_GRUPO_ID || '573506974711-16128410420@g.us';
const PHONE_NUMBER = (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');

const REGEX = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+?)(?:\s+([A-Za-zÁÉÍÓÚáéíóúñÑ].+))?$/i;

let sockGlobal = null;
let pairingRequested = false;

async function enviarAlerta(texto) {
  if (!sockGlobal) return;
  try {
    await sockGlobal.sendMessage(GRUPO_ID, { text: texto });
  } catch (e) {
    console.error('[bot] Error enviando alerta:', e.message);
  }
}

async function crearVenta(tipo, vendedora, telefono, equipo) {
  const res = await fetch(`${API_URL}/api/venta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo, vendedora, telefono: telefono.replace(/\s/g, ''), equipo: equipo || '', key: 'ws-textil-2026' }),
  });
  return res.json();
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.0'],
  });
  sockGlobal = sock;
  pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && PHONE_NUMBER && !pairingRequested) {
      pairingRequested = true;
      // Esperar un momento antes de pedir el código
      await new Promise(r => setTimeout(r, 2000));
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log(`\n==============================`);
        console.log(`📱 PAIRING CODE: ${code}`);
        console.log(`Ingresa este código en WhatsApp:`);
        console.log(`Ajustes → Dispositivos vinculados → Vincular con número de teléfono`);
        console.log(`==============================\n`);
      } catch (e) {
        console.error('[bot] Error obteniendo pairing code:', e.message);
        pairingRequested = false;
      }
    }

    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(conectar, 5000);
      }
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

      const [, tipo, vendedora, telefono, equipo] = match;
      console.log(`[bot] Detectado: #${tipo} ${vendedora} ${telefono}${equipo ? ` | equipo: ${equipo}` : ''}`);

      try {
        const result = await crearVenta(tipo, vendedora, telefono, equipo);
        const jid = msg.key.remoteJid;
        if (result.ok) {
          const equipoLinea = equipo ? `\n🏷️ Equipo: ${equipo}` : '';
          await sock.sendMessage(jid, {
            text: `✅ ${tipo === 'pedido' ? 'Pedido' : 'Cotización'} #${result.id} creado\n👤 Vendedora: ${result.vendedora}\n📞 Tel: ${result.telefono}${equipoLinea}`,
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

process.on('uncaughtException', err => console.error('[bot] Error no capturado:', err.message));
process.on('unhandledRejection', err => console.error('[bot] Promesa rechazada:', err?.message || err));

conectar();
