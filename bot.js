const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const path = require('path');

const API_URL    = process.env.API_URL   || 'https://ws-app-interna-production.up.railway.app';
const AUTH_DIR   = path.join(__dirname, 'wa_auth_local');
const GRUPO_ID   = process.env.WA_GRUPO_ID || '573506974711-16128410420@g.us';
const PHONE_NUMBER = (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, '');

const REGEX = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+?)(?:\s+([A-Za-zÁÉÍÓÚáéíóúñÑ].+))?$/i;

let sockGlobal = null;

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
  });
  sockGlobal = sock;

  sock.ev.on('creds.update', saveCreds);

  // Pedir pairing code apenas el socket esté listo, antes del QR
  if (PHONE_NUMBER && !sock.authState.creds.registered) {
    console.log(`[bot] Solicitando pairing code para ${PHONE_NUMBER}...`);
    await new Promise(r => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log(`\n==============================`);
      console.log(`📱 PAIRING CODE: ${code}`);
      console.log(`Ingresa en WhatsApp > Dispositivos vinculados > Vincular con número`);
      console.log(`==============================\n`);
    } catch (e) {
      console.error('[bot] Error pairing code:', e.message);
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(conectar, 5000);
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
