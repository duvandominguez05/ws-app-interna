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
  // Mostrar QR en terminal
  const qrcode = require('qrcode-terminal');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ Bot WhatsApp conectado y listo!');
  const chats = await client.getChats();
  console.log('[bot] Chats disponibles:', chats.length);
  chats.forEach(c => console.log(' -', c.name || c.id.user, '| isGroup:', c.isGroup));
});

client.on('disconnected', (reason) => {
  console.log('Bot desconectado:', reason);
  client.initialize();
});

client.on('message', async (msg) => {
  console.log('[bot] Mensaje recibido:', msg.body);
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
      const equipoLinea = equipo ? `\nEquipo: ${equipo}` : '';
      await msg.reply(`✅ ${tipo === 'pedido' ? 'Pedido' : 'Cotización'} #${result.id} creado\nVendedora: ${result.vendedora}\nTel: ${result.telefono}${equipoLinea}`);
    } else {
      await msg.reply(`❌ Error: ${result.error}`);
    }
  } catch (e) {
    console.error('[bot] Error al crear venta:', e.message);
  }
});

client.initialize();
