const { Client, LocalAuth } = require('whatsapp-web.js');
const fetch = require('node-fetch');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const REGEX = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+?)(?:\s+(.+))?$/i;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wa_auth_puppeteer' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
});

client.on('qr', (qr) => {
  console.log('\n==============================');
  console.log('Escanea el QR con WhatsApp del celular bot:');
  console.log('(Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo)');
  console.log('==============================\n');
  const qrcode = require('qrcode-terminal');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Bot WhatsApp conectado y listo!');
});

client.on('disconnected', (reason) => {
  console.log('Bot desconectado:', reason);
  setTimeout(() => client.initialize(), 5000);
});

client.on('message', async (msg) => {
  const texto = msg.body || '';
  const match = texto.match(REGEX);
  if (!match) return;

  const [, tipo, vendedora, telefono, equipo] = match;
  console.log(`[bot] Detectado: #${tipo} ${vendedora} ${telefono}${equipo ? ` | equipo: ${equipo}` : ''}`);

  try {
    const res = await fetch(`${API_URL}/api/venta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo,
        vendedora,
        telefono: telefono.replace(/\s/g, ''),
        equipo: equipo || '',
        key: 'ws-textil-2026'
      }),
    });
    const result = await res.json();
    if (result.ok) {
      const esPedido = tipo.toLowerCase() === 'pedido';
      const equipoLinea = equipo ? `\n🏷️ *Equipo:* ${equipo}` : '';
      const estadoLinea = esPedido ? `\n📋 *Estado:* En diseño` : '';
      const texto = esPedido
        ? `✅ *Pedido #${result.id} registrado*\n👤 *Vendedora:* ${result.vendedora}\n📞 *Teléfono:* ${result.telefono}${equipoLinea}${estadoLinea}`
        : `✅ *Cotización #${result.id} registrada*\n👤 *Vendedora:* ${result.vendedora}\n📞 *Teléfono:* ${result.telefono}${equipoLinea}`;
      await msg.reply(texto);
    } else {
      await msg.reply(`❌ *Error:* ${result.error}`);
    }
  } catch (e) {
    console.error('[bot] Error al crear venta:', e.message);
  }
});

client.initialize();
