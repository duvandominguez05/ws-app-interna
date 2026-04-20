const { Client, LocalAuth } = require('whatsapp-web.js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'https://ws-app-interna-production.up.railway.app';
// Formatos aceptados:
//   #pedido nombre telefono [equipo]
//   #pedido telefono nombre [equipo]
// El teléfono puede tener espacios: "324 9900664"
const REGEX = /^#(cotizar|pedido)\s+(.+)$/i;

function parsearMensaje(texto) {
  const m = texto.match(REGEX);
  if (!m) return null;
  const tipo = m[1];
  const resto = m[2].trim();

  // Buscar la primera secuencia que sea un teléfono (>= 7 dígitos, puede incluir espacios/guiones entre dígitos)
  const telMatch = resto.match(/\d(?:[\s\-\+]?\d){6,14}/);
  if (!telMatch) return null;

  const telefono = telMatch[0].replace(/\s+/g, ''); // quitar espacios internos
  const antes = resto.slice(0, telMatch.index).trim();
  const despues = resto.slice(telMatch.index + telMatch[0].length).trim();

  let vendedora, equipo;
  if (antes) {
    // nombre telefono [equipo]
    vendedora = antes.split(/\s+/)[0];
    equipo = despues;
  } else {
    // telefono nombre [equipo]
    const parts = despues.split(/\s+/);
    vendedora = parts[0];
    equipo = parts.slice(1).join(' ');
  }

  if (!vendedora) return null;
  return [null, tipo, vendedora, telefono, equipo || undefined];
}
const DIAS_HISTORICO = 7;
const LOG_FILE = path.join(__dirname, 'logs', 'bot.log');
const PROCESADOS_FILE = path.join(__dirname, 'logs', 'procesados.json');

// Asegurar que la carpeta logs exista
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'));
}

// Borrar lock file de Chrome si quedo colgado
function limpiarLockChrome() {
  const lockFile = path.join(__dirname, 'wa_auth_puppeteer', 'session', 'SingletonLock');
  try { if (fs.existsSync(lockFile)) { fs.unlinkSync(lockFile); } } catch {}
}

function log(msg) {
  const linea = `[${new Date().toLocaleString('es-CO')}] ${msg}`;
  console.log(linea);
  fs.appendFileSync(LOG_FILE, linea + '\n');
}

// Registro local de mensajes ya procesados
function leerProcesados() {
  try {
    if (!fs.existsSync(PROCESADOS_FILE)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(PROCESADOS_FILE, 'utf8')));
  } catch { return new Set(); }
}

function guardarProcesado(waMsgId) {
  const set = leerProcesados();
  set.add(waMsgId);
  fs.writeFileSync(PROCESADOS_FILE, JSON.stringify([...set]));
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
  setTimeout(() => { limpiarLockChrome(); client.initialize(); }, 5000);
});

// Reiniciar automaticamente si puppeteer falla al inicializar
process.on('unhandledRejection', (reason) => {
  log(`Error no manejado: ${reason}`);
  if (String(reason).includes('Execution context was destroyed') ||
      String(reason).includes('browser is already running') ||
      String(reason).includes('Session closed')) {
    log('Reiniciando bot en 5 segundos...');
    setTimeout(() => { limpiarLockChrome(); client.initialize(); }, 5000);
  }
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
    const procesados = leerProcesados();
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    if (!grupos.length) return;

    const limite = Date.now() - DIAS_HISTORICO * 24 * 60 * 60 * 1000;
    let procesadosNuevos = 0;

    for (const grupo of grupos) {
      let mensajes;
      try {
        mensajes = await grupo.fetchMessages({ limit: 500 });
      } catch (e) {
        log(`[historico] ⚠️ No se pudo leer grupo "${grupo.name}": ${e.message}`);
        continue;
      }
      for (const msg of mensajes) {
        const ts = (msg.timestamp || 0) * 1000;
        if (ts < limite) continue;
        const texto = msg.body || '';
        const match = parsearMensaje(texto);
        if (!match) continue;

        const waMsgId = msg.id._serialized;

        // Si ya fue procesado antes, saltar
        if (procesados.has(waMsgId)) continue;

        const [, tipo, vendedora, telefono, equipo] = match;
        try {
          const result = await subirVenta(tipo, vendedora, telefono, equipo, waMsgId);
          guardarProcesado(waMsgId);
          if (result.ok && !result.duplicado) {
            log(`[historico] ✅ Registrado: #${result.id} ${tipo} ${vendedora} ${telefono.trim()}${equipo ? ` | ${equipo}` : ''}`);
            procesadosNuevos++;
            await msg.reply(mensajeRespuesta(tipo, result, equipo));
          } else {
            log(`[historico] ⚠️ Duplicado ignorado: ${texto.trim()}`);
          }
        } catch (e) {
          log(`[historico] ❌ Error: ${e.message}`);
        }
      }
    }
    log(`[historico] Revisión completada — ${procesadosNuevos} nuevo(s) registrado(s)`);
  } catch (e) {
    log(`[historico] ❌ Error revisando histórico: ${e.message}`);
  }
}

client.on('message', async (msg) => {
  const texto = msg.body || '';
  const match = parsearMensaje(texto);
  if (!match) return;

  const [, tipo, vendedora, telefono, equipo] = match;
  const waMsgId = msg.id._serialized;
  log(`[bot] Detectado: #${tipo} ${vendedora} ${telefono.trim()}${equipo ? ` | equipo: ${equipo}` : ''}`);

  try {
    const result = await subirVenta(tipo, vendedora, telefono, equipo, waMsgId);
    guardarProcesado(waMsgId);
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

limpiarLockChrome();
client.initialize();
