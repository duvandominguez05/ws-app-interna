const http = require('http');
const fs   = require('fs');
const path = require('path');

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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        guardarPedidos(pedidos);

        console.log(`[webhook] #${pedido.id} ${pedido.equipo}: ${estadoAnterior} → ${estado}`);
        return json(res, 200, { ok: true, id: pedido.id, equipo: pedido.equipo, estadoAnterior, estadoNuevo: estado });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/venta — chatbot WhatsApp crea cotización/pedido ─
  // Body: { tipo: 'cotizar'|'pedido', vendedora, telefono }
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

        const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
        const vendedoraNorm = vendedora.toLowerCase();
        if (!VENDEDORAS_VALIDAS.includes(vendedoraNorm))
          return json(res, 400, { error: `Vendedora no reconocida: ${vendedora}` });

        const pedidos = leerPedidos();
        let nextId = leerNextId();

        const nuevo = {
          id:          nextId,
          equipo:      '',
          telefono:    String(telefono).trim(),
          vendedora:   vendedora.charAt(0).toUpperCase() + vendedora.slice(1).toLowerCase(),
          tipoBandeja: tipo,
          estado:      tipo === 'pedido' ? 'hacer-diseno' : 'bandeja',
          creadoEn:    new Date().toLocaleDateString('es-CO'),
          items:       [],
          fechaEntrega: '',
          notas:       '',
          arreglo:     null,
          origenBot:   true,
        };

        pedidos.push(nuevo);
        guardarPedidos(pedidos, nextId + 1);

        console.log(`[bot] Nueva ${tipo} #${nextId} — ${vendedora} — ${telefono}`);
        return json(res, 200, { ok: true, id: nextId, tipo, vendedora: nuevo.vendedora, telefono });

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
