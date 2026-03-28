const http = require('http');
const fs   = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

// ── Restaurar sesión WhatsApp desde variable de entorno ──────────
const AUTH_DIR_INIT = path.join(__dirname, 'data', 'wa_auth');
if (process.env.WA_CREDS_B64 && !fs.existsSync(path.join(AUTH_DIR_INIT, 'creds.json'))) {
  fs.mkdirSync(AUTH_DIR_INIT, { recursive: true });
  fs.writeFileSync(
    path.join(AUTH_DIR_INIT, 'creds.json'),
    Buffer.from(process.env.WA_CREDS_B64, 'base64').toString('utf8')
  );
  console.log('[bot] creds.json restaurado desde variable de entorno');
}

// ── Bot WhatsApp (Baileys) ───────────────────────────────────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

const AUTH_DIR = path.join(__dirname, 'data', 'wa_auth');
const GRUPO_ID = process.env.WA_GRUPO_ID || '573506974711-16128410420@g.us';
const REGEX    = /^#(cotizar|pedido)\s+(\w+)\s+([\d\s\-\+]+)/i;

let sockGlobal = null;

function enviarAlerta(texto) {
  if (!sockGlobal) return;
  sockGlobal.sendMessage(GRUPO_ID, { text: texto }).catch(e => {
    console.error('[bot] Error enviando alerta:', e.message);
  });
}

async function conectarBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sockGlobal = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escanea este QR con WhatsApp del número del bot:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[bot] Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) conectarBot();
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
        const result = await crearVentaInterna(tipo, vendedora, telefono.replace(/\s/g, ''));
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

conectarBot();

const PORT = process.env.PORT || 3000;
const DATA_FILE   = path.join(__dirname, 'data', 'pedidos.json');
const NEXTID_FILE = path.join(__dirname, 'data', 'nextId.json');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

function crearVentaInterna(tipo, vendedora, telefono) {
  const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
  const vendedoraNorm = vendedora.toLowerCase();
  if (!VENDEDORAS_VALIDAS.includes(vendedoraNorm))
    return { ok: false, error: `Vendedora no reconocida: ${vendedora}` };

  const pedidos = leerPedidos();
  const nextId  = leerNextId();

  const nuevo = {
    id:          nextId,
    equipo:      '',
    telefono:    String(telefono).trim(),
    vendedora:   vendedora.charAt(0).toUpperCase() + vendedora.slice(1).toLowerCase(),
    tipoBandeja: tipo,
    estado:      tipo === 'pedido' ? 'hacer-diseno' : 'bandeja',
    creadoEn:    new Date().toLocaleDateString('es-CO'),
    ultimoMovimiento: new Date().toISOString(),
    items:       [],
    fechaEntrega: '',
    notas:       '',
    arreglo:     null,
    origenBot:   true,
  };

  pedidos.push(nuevo);
  guardarPedidos(pedidos, nextId + 1);
  console.log(`[bot] Nueva ${tipo} #${nextId} — ${vendedora} — ${telefono}`);
  return { ok: true, id: nextId, tipo, vendedora: nuevo.vendedora, telefono };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function leerPedidos() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return []; }
}

function leerNextId() {
  try {
    if (!fs.existsSync(NEXTID_FILE)) return 1;
    return JSON.parse(fs.readFileSync(NEXTID_FILE, 'utf8')).nextId || 1;
  } catch { return 1; }
}

function guardarPedidos(pedidos, nextId) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(pedidos, null, 2));
  if (nextId) fs.writeFileSync(NEXTID_FILE, JSON.stringify({ nextId }));
}

const ESTADOS_VALIDOS = [
  'bandeja','hacer-diseno','confirmado','enviado-calandra',
  'llego-impresion','corte','calidad','costura','listo','enviado-final'
];

http.createServer((req, res) => {

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /api/pedidos — lista todos los pedidos ──────────────
  if (req.method === 'GET' && req.url === '/api/pedidos') {
    return json(res, 200, { pedidos: leerPedidos(), nextId: leerNextId() });
  }

  // ── POST /api/pedidos — app sincroniza su estado al servidor ─
  if (req.method === 'POST' && req.url === '/api/pedidos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { pedidos, nextId } = JSON.parse(body);
        if (!Array.isArray(pedidos)) return json(res, 400, { error: 'pedidos debe ser array' });
        guardarPedidos(pedidos, nextId);
        return json(res, 200, { ok: true, total: pedidos.length });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/webhook — n8n actualiza estado de un pedido ───
  if (req.method === 'POST' && req.url === '/api/webhook') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { equipo, estado, nota } = JSON.parse(body);
        if (!equipo || !estado) return json(res, 400, { error: 'Faltan campos: equipo, estado' });
        if (!ESTADOS_VALIDOS.includes(estado)) return json(res, 400, { error: `Estado inválido: ${estado}` });

        const pedidos = leerPedidos();
        // Busca por nombre del equipo (case-insensitive, parcial)
        const pedido = pedidos.find(p =>
          p.equipo && p.equipo.toLowerCase().includes(equipo.toLowerCase()) &&
          p.estado !== 'enviado-final'
        );

        if (!pedido) return json(res, 404, { error: `No se encontró pedido activo con equipo: ${equipo}` });

        const estadoAnterior = pedido.estado;
        pedido.estado = estado;
        if (nota) pedido.notaWebhook = nota;
        pedido.ultimaActWebhook = new Date().toISOString();
        pedido.ultimoMovimiento = new Date().toISOString();
        guardarPedidos(pedidos);

        console.log(`[webhook] #${pedido.id} ${pedido.equipo}: ${estadoAnterior} → ${estado}`);

        // Alertas automáticas al grupo de WhatsApp
        if (estado === 'listo') {
          enviarAlerta(`✅ *Pedido listo:* ${pedido.equipo}\n👤 Vendedora: ${pedido.vendedora}\n📞 Tel: ${pedido.telefono}`);
        } else if (estado === 'costura') {
          enviarAlerta(`🧵 *Nuevo en costura:* ${pedido.equipo}\n¿Quién lo toma? (Marcela / Yamile / Wilson / Cristina)`);
        }
        return json(res, 200, { ok: true, id: pedido.id, equipo: pedido.equipo, estadoAnterior, estadoNuevo: estado });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/venta — chatbot WhatsApp crea cotización/pedido ─
  if (req.method === 'POST' && req.url === '/api/venta') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, vendedora, telefono } = JSON.parse(body);
        if (!tipo || !vendedora || !telefono)
          return json(res, 400, { error: 'Faltan campos: tipo, vendedora, telefono' });
        if (!['cotizar', 'pedido'].includes(tipo))
          return json(res, 400, { error: 'tipo debe ser cotizar o pedido' });
        const result = crearVentaInterna(tipo, vendedora, String(telefono).replace(/\s/g, ''));
        return json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/calandra — n8n registra envío de PDF a calandra ─
  // Body: { equipo, alto, ancho?, archivo?, diseñador? }
  // alto en cm, ancho en metros (opcional, default 1.50)
  if (req.method === 'POST' && req.url === '/api/calandra') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { equipo, alto, ancho, archivo, disenador } = JSON.parse(body);
        if (!equipo || !alto)
          return json(res, 400, { error: 'Faltan campos: equipo, alto' });

        const altoCm  = parseFloat(alto);
        if (isNaN(altoCm) || altoCm <= 0)
          return json(res, 400, { error: 'alto debe ser un número positivo en cm' });

        const metros  = parseFloat((altoCm / 100).toFixed(3));
        const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');

        let registros = [];
        try {
          if (fs.existsSync(CAL_FILE))
            registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
        } catch {}

        // Clave de semana ISO (lunes como inicio)
        const hoy = new Date();
        const diaSemana = hoy.getDay() === 0 ? 6 : hoy.getDay() - 1;
        const lunes = new Date(hoy);
        lunes.setDate(hoy.getDate() - diaSemana);
        const semana = `${lunes.getFullYear()}-W${String(Math.ceil((lunes.getDate()) / 7)).padStart(2,'0')}-${lunes.getMonth()+1}`;

        const registro = {
          id:        Date.now(),
          equipo:    String(equipo).trim(),
          alto:      altoCm,
          metros,
          semana,
          fecha:     hoy.toLocaleDateString('es-CO'),
          archivo:   archivo || '',
          disenador: disenador || '',
          origen:    'drive',
        };

        registros.push(registro);
        fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
        fs.writeFileSync(CAL_FILE, JSON.stringify(registros, null, 2));

        console.log(`[calandra] ${equipo} — ${altoCm}cm = ${metros}m | ${archivo || ''}`);
        return json(res, 200, { ok: true, metros, equipo, semana, id: registro.id });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── DELETE /api/calandra/:id — borra un registro ────────────
  if (req.method === 'DELETE' && req.url.startsWith('/api/calandra/')) {
    const id = req.url.split('/')[3];
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    let registros = [];
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
    const antes = registros.length;
    registros = registros.filter(r => String(r.id) !== String(id));
    fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
    fs.writeFileSync(CAL_FILE, JSON.stringify(registros, null, 2));
    console.log(`[calandra] borrado id=${id}, quedaron ${registros.length}/${antes}`);
    return json(res, 200, { ok: true, borrado: antes !== registros.length });
  }

  // ── GET /api/calandra — devuelve todos los registros ────────
  if (req.method === 'GET' && req.url === '/api/calandra') {
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    let registros = [];
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
    return json(res, 200, { registros });
  }

  // ── POST /api/wetransfer — registra envío o descarga ────────
  // Body: { tipo: 'enviado'|'descargado', archivo, equipo? }
  if (req.method === 'POST' && req.url === '/api/wetransfer') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, archivo, equipo } = JSON.parse(body);
        if (!tipo || !archivo)
          return json(res, 400, { error: 'Faltan campos: tipo, archivo' });
        if (!['enviado', 'descargado'].includes(tipo))
          return json(res, 400, { error: 'tipo debe ser enviado o descargado' });

        const WT_FILE = path.join(__dirname, 'data', 'wetransfer.json');
        let registros = [];
        try {
          if (fs.existsSync(WT_FILE))
            registros = JSON.parse(fs.readFileSync(WT_FILE, 'utf8'));
        } catch {}

        const registro = {
          id:      Date.now(),
          tipo,
          archivo: String(archivo).trim(),
          equipo:  equipo ? String(equipo).trim() : '',
          fecha:   new Date().toLocaleDateString('es-CO'),
          hora:    new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
          ts:      new Date().toISOString(),
        };

        registros.push(registro);
        fs.mkdirSync(path.dirname(WT_FILE), { recursive: true });
        fs.writeFileSync(WT_FILE, JSON.stringify(registros, null, 2));

        console.log(`[wetransfer] ${tipo} — ${archivo} ${equipo ? `(${equipo})` : ''}`);
        return json(res, 200, { ok: true, id: registro.id, tipo, archivo });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/wetransfer — devuelve todos los registros ──────
  if (req.method === 'GET' && req.url === '/api/wetransfer') {
    const WT_FILE = path.join(__dirname, 'data', 'wetransfer.json');
    let registros = [];
    try {
      if (fs.existsSync(WT_FILE))
        registros = JSON.parse(fs.readFileSync(WT_FILE, 'utf8'));
    } catch {}
    return json(res, 200, { registros });
  }

  // ── GET /api/docs/nums — devuelve nextCot y nextFac ─────────
  if (req.method === 'GET' && req.url === '/api/docs/nums') {
    const NUMS_FILE = path.join(__dirname, 'data', 'docsNums.json');
    let nums = { nextCot: 210, nextFac: 501 };
    try {
      if (fs.existsSync(NUMS_FILE)) nums = JSON.parse(fs.readFileSync(NUMS_FILE, 'utf8'));
    } catch {}
    return json(res, 200, nums);
  }

  // ── POST /api/docs/nums — guarda nextCot y nextFac ──────────
  if (req.method === 'POST' && req.url === '/api/docs/nums') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { nextCot, nextFac } = JSON.parse(body);
        const NUMS_FILE = path.join(__dirname, 'data', 'docsNums.json');
        fs.mkdirSync(path.dirname(NUMS_FILE), { recursive: true });
        fs.writeFileSync(NUMS_FILE, JSON.stringify({ nextCot, nextFac }));
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── Archivos estáticos ──────────────────────────────────────
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => console.log(`W&S App corriendo en puerto ${PORT}`));
