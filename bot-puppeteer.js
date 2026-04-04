const { Client, LocalAuth } = require('whatsapp-web.js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'https://ws-app-interna-production.up.railway.app';
const REGEX = /^#(cotizar|pedido)\s+(\w+)\s+([\d][\d\s\-\+]{6,14}[\d])(?:\s+(.+))?$/i;
const DIAS_HISTORICO = 7;
const LOG_FILE = path.join(__dirname, 'logs', 'bot.log');

// Asegurar que la carpeta logs exista
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'));
}

function log(msg) {
  const linea = `[${new Date().toLocaleString('es-CO')}] ${msg}`;
  console.log(linea);
  fs.appendFileSync(LOG_FILE, linea + '\n');
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wa_auth_puppeteer' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
});

client.on('qr', (qr) => {
  log('QR generado — escanea con WhatsApp > Dispositivos vinculados');
  const qrcode = require('qrcode-terminal');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  log('✅ Bot WhatsApp conectado y listo!');
  await revisarHistorico();
});

client.on('disconnected', (reason) => {
  log(`Bot desconectado: ${reason}`);
  setTimeout(() => client.initialize(), 5000);
});

async function subirVenta(tipo, vendedora, telefono, equipo, waMsgId) {
  const res = await fetch(`${API_URL}/api/venta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tipo,
      vendedora,
      telefono: telefono.replace(/\s/g, ''),
      equipo: equipo || '',
      waMsgId,
      key: 'ws-textil-2026'
    }),
  });
  return res.json();
}

function mensajeRespuesta(tipo, result, equipo) {
  const esPedido = tipo.toLowerCase() === 'pedido';
  const equipoLinea = equipo ? `\n🏷️ *Equipo:* ${equipo}` : '';
  const estadoLinea = esPedido ? `\n📋 *Estado:* En diseño` : '';
  return esPedido
    ? `✅ *Pedido #${result.id} registrado*\n👤 *Vendedora:* ${result.vendedora}\n📞 *Teléfono:* ${result.telefono}${equipoLinea}${estadoLinea}`
    : `✅ *Cotización #${result.id} registrada*\n👤 *Vendedora:* ${result.vendedora}\n📞 *Teléfono:* ${result.telefono}${equipoLinea}`;
}

async function revisarHistorico() {
  try {
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    if (!grupos.length) return;

    const limite = Date.now() - DIAS_HISTORICO * 24 * 60 * 60 * 1000;
    let procesados = 0;

    for (const grupo of grupos) {
      const mensajes = await grupo.fetchMessages({ limit: 500 });
      for (const msg of mensajes) {
        const ts = (msg.timestamp || 0) * 1000;
        if (ts < limite) continue;
        const texto = msg.body || '';
        const match = texto.match(REGEX);
        if (!match) continue;

        const [, tipo, vendedora, telefono, equipo] = match;
        try {
          const result = await subirVenta(tipo, vendedora, telefono, equipo, msg.id._serialized);
          if (result.ok && !result.duplicado) {
            log(`[historico] ✅ Registrado: #${result.id} ${tipo} ${vendedora} ${telefono.trim()}${equipo ? ` | ${equipo}` : ''}`);
            procesados++;
            await msg.reply(mensajeRespuesta(tipo, result, equipo));
          }
        } catch (e) {
          log(`[historico] ❌ Error: ${e.message}`);
        }
      }
    }
    log(`[historico] Revisión completada — ${procesados} nuevo(s) registrado(s)`);
  } catch (e) {
    log(`[historico] ❌ Error revisando histórico: ${e.message}`);
  }
}

client.on('message', async (msg) => {
  const texto = msg.body || '';
  const match = texto.match(REGEX);
  if (!match) return;

  const [, tipo, vendedora, telefono, equipo] = match;
  log(`[bot] Detectado: #${tipo} ${vendedora} ${telefono.trim()}${equipo ? ` | equipo: ${equipo}` : ''}`);

  try {
    const result = await subirVenta(tipo, vendedora, telefono, equipo, msg.id._serialized);
    if (result.ok) {
      if (!result.duplicado) {
        log(`[bot] ✅ Registrado: #${result.id} ${tipo} ${vendedora}`);
        await msg.reply(mensajeRespuesta(tipo, result, equipo));
      } else {
        log(`[bot] ⚠️ Duplicado ignorado: ${texto.trim()}`);
      }
    } else {
      log(`[bot] ❌ Error API: ${result.error}`);
      await msg.reply(`❌ *Error:* ${result.error}`);
    }
  } catch (e) {
    log(`[bot] ❌ Error al crear venta: ${e.message}`);
  }
});

client.initialize();
