const http = require('http');
const fs   = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

// ── Configuración de Seguridad ───────────────────────────────────
const API_KEY = process.env.API_KEY || 'ws-textil-2026';

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

function crearVentaInterna(tipo, vendedora, telefono, waMsgId, equipo) {
  const tipoNorm = tipo.toLowerCase();
  const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
  const vendedoraNorm = vendedora.toLowerCase();
  if (!VENDEDORAS_VALIDAS.includes(vendedoraNorm))
    return { ok: false, error: `Vendedora no reconocida: ${vendedora}` };

  const pedidos = leerPedidos();
  
  // Control de Duplicados por waMsgId
  if (waMsgId && pedidos.some(p => p.waMsgId === waMsgId)) {
    console.log(`[api] Pedido duplicado ignorado: waMsgId=${waMsgId}`);
    const existnte = pedidos.find(p => p.waMsgId === waMsgId);
    return { ok: true, id: existnte.id, tipo: tipoNorm, vendedora: existnte.vendedora, telefono, duplicado: true };
  }

  const nextId  = leerNextId();

  const nuevo = {
    id:          nextId,
    equipo:      equipo ? String(equipo).trim() : '',
    telefono:    String(telefono).trim(),
    vendedora:   vendedora.charAt(0).toUpperCase() + vendedora.slice(1).toLowerCase(),
    tipoBandeja: tipoNorm,
    estado:      tipoNorm === 'pedido' ? 'hacer-diseno' : 'bandeja',
    creadoEn:    new Date().toLocaleDateString('es-CO'),
    ultimoMovimiento: new Date().toISOString(),
    items:       [],
    fechaEntrega: '',
    notas:       '',
    arreglo:     null,
    origenBot:   true,
    waMsgId:     waMsgId || null,
  };

  pedidos.push(nuevo);
  guardarPedidos(pedidos, nextId + 1);
  console.log(`[api] Nueva ${tipoNorm} #${nextId} — ${vendedora} — ${telefono} (${waMsgId || 'manual'})`);
  return { ok: true, id: nextId, tipo: tipoNorm, vendedora: nuevo.vendedora, telefono };
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
        const { pedidos: incoming, nextId } = JSON.parse(body);
        if (!Array.isArray(incoming)) return json(res, 400, { error: 'pedidos debe ser array' });

        // Merge: preservar campos del servidor que el cliente puede no tener
        const existing = leerPedidos();
        const mapaExisting = new Map(existing.map(p => [p.id, p]));
        const merged = incoming.map(p => {
          const e = mapaExisting.get(p.id);
          if (!e) return p;
          return {
            ...p,
            equipo: p.equipo || e.equipo || '',
            notaWebhook: p.notaWebhook || e.notaWebhook,
            ultimaActWebhook: p.ultimaActWebhook || e.ultimaActWebhook,
          };
        });
        // Preservar pedidos del servidor que el cliente no tiene (creados por bot en otro momento)
        const incomingIds = new Set(incoming.map(p => p.id));
        existing.forEach(e => { if (!incomingIds.has(e.id)) merged.push(e); });
        merged.sort((a, b) => a.id - b.id);

        guardarPedidos(merged, nextId);
        return json(res, 200, { ok: true, total: merged.length });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/wa-status — estado simulado ────────────────────
  if (req.method === 'GET' && req.url === '/api/wa-status') {
    return json(res, 200, { ok: true, status: 'modo-local-habilitado' });
  }

  // ── POST /api/venta — bot local crea cotización/pedido ─────
  if (req.method === 'POST' && req.url === '/api/venta') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, vendedora, telefono, waMsgId, equipo, key } = JSON.parse(body);

        // Validación de API Key
        if (key !== API_KEY) return json(res, 401, { error: 'Contraseña de API inválida' });

        if (!tipo || !vendedora || !telefono)
          return json(res, 400, { error: 'Faltan campos: tipo, vendedora, telefono' });

        const tipoNorm = tipo.toLowerCase();
        if (!['cotizar', 'pedido'].includes(tipoNorm))
          return json(res, 400, { error: 'tipo debe ser cotizar o pedido' });

        const result = crearVentaInterna(tipo, vendedora, String(telefono).replace(/\s/g, ''), waMsgId, equipo);
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
        const { equipo, alto, ancho, archivo, disenador, fechaDrive, semana: semanaBody } = JSON.parse(body);
        if (!equipo || !alto)
          return json(res, 400, { error: 'Faltan campos: equipo, alto' });

        let altoCm  = parseFloat(alto);
        if (isNaN(altoCm) || altoCm < 0) altoCm = 0;

        const metros  = parseFloat((altoCm / 100).toFixed(3));
        const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');

        let registros = [];
        try {
          if (fs.existsSync(CAL_FILE))
            registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
        } catch {}

        // Usar fecha real del PDF si viene, si no usar hoy
        const fechaReal = fechaDrive || new Date().toLocaleDateString('es-CO');
        const semana = semanaBody || fechaReal;

        const registro = {
          id:         Date.now(),
          equipo:     String(equipo).trim(),
          alto:       altoCm,
          metros,
          semana,
          fecha:      fechaReal,
          archivo:    archivo || '',
          disenador:  disenador || '',
          origen:     'drive',
        };

        // Evitar duplicados por nombre de archivo
        const yaExiste = registros.some(r => r.archivo === registro.archivo);
        if (!yaExiste) {
          registros.push(registro);
          fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
          fs.writeFileSync(CAL_FILE, JSON.stringify(registros, null, 2));
        }

        console.log(`[calandra] ${yaExiste ? 'duplicado ignorado' : 'registrado'}: ${equipo} — ${altoCm}cm = ${metros}m | ${archivo || ''}`);
        return json(res, 200, { ok: true, metros, equipo, semana, id: registro.id, duplicado: yaExiste });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── DELETE /api/calandra/reset — limpia todos los registros ──
  if (req.method === 'DELETE' && req.url === '/api/calandra/reset') {
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
    fs.writeFileSync(CAL_FILE, JSON.stringify([], null, 2));
    console.log('[calandra] reset completo');
    return json(res, 200, { ok: true, mensaje: 'Calandra limpiada' });
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

  // ── GET /api/drive-pdfs — todos los PDFs de Drive ordenados por fecha real ──
  if (req.method === 'GET' && req.url === '/api/drive-pdfs') {
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    const WT_FILE  = path.join(__dirname, 'data', 'pendientes-wt.json');
    let registros = [];
    let enviados = new Set();
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
    try {
      if (fs.existsSync(WT_FILE)) {
        const wt = JSON.parse(fs.readFileSync(WT_FILE, 'utf8'));
        const pendientes = (wt.pendientes || []).map(p => p.nombre.toLowerCase());
        // Los que NO están en pendientes fueron enviados
        registros.forEach(r => {
          const nombre = (r.archivo || '').toLowerCase();
          if (!pendientes.includes(nombre)) enviados.add(nombre);
        });
      }
    } catch {}
    // Ordenar del más nuevo al más viejo por fecha real
    registros.sort((a, b) => b.id - a.id);
    const result = registros.map(r => ({
      ...r,
      enviado: enviados.has((r.archivo || '').toLowerCase())
    }));
    return json(res, 200, { pdfs: result });
  }

  // ── GET /api/calandra — devuelve todos los registros ────────
  if (req.method === 'GET' && req.url === '/api/calandra') {
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    let registros = [];
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
    registros.sort((a, b) => b.id - a.id);
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

  // ── GET /api/docs/nums — devuelve nextCot, nextFac e historial ──
  if (req.method === 'GET' && req.url === '/api/docs/nums') {
    const NUMS_FILE = path.join(__dirname, 'data', 'docsNums.json');
    const HIST_FILE = path.join(__dirname, 'data', 'docsHistorial.json');
    let nums = { nextCot: 210, nextFac: 501 };
    let historial = [];
    try { if (fs.existsSync(NUMS_FILE)) nums = JSON.parse(fs.readFileSync(NUMS_FILE, 'utf8')); } catch {}
    try { if (fs.existsSync(HIST_FILE)) historial = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
    return json(res, 200, { ...nums, historial });
  }

  // ── POST /api/docs/nums — guarda nextCot, nextFac e historial ──
  if (req.method === 'POST' && req.url === '/api/docs/nums') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { nextCot, nextFac, historial } = JSON.parse(body);
        const NUMS_FILE = path.join(__dirname, 'data', 'docsNums.json');
        const HIST_FILE = path.join(__dirname, 'data', 'docsHistorial.json');
        fs.mkdirSync(path.dirname(NUMS_FILE), { recursive: true });
        fs.writeFileSync(NUMS_FILE, JSON.stringify({ nextCot, nextFac }));
        // Merge historial: combinar con lo existente, sin duplicados por id
        if (Array.isArray(historial) && historial.length > 0) {
          let existente = [];
          try { if (fs.existsSync(HIST_FILE)) existente = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
          const todos = [...historial, ...existente];
          const vistos = new Set();
          const merged = todos.filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; });
          merged.sort((a, b) => b.id - a.id);
          fs.writeFileSync(HIST_FILE, JSON.stringify(merged.slice(0, 100), null, 2));
        }
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/pendientes-wt — n8n registra PDFs sin enviar ──
  // Body: { pendientes: [{nombre, fecha}], semana }
  if (req.method === 'POST' && req.url === '/api/pendientes-wt') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { pendientes, semana } = JSON.parse(body);
        if (!Array.isArray(pendientes)) return json(res, 400, { error: 'pendientes debe ser array' });
        const FILE = path.join(__dirname, 'data', 'pendientes-wt.json');
        const registro = {
          ts: new Date().toISOString(),
          semana: semana || '',
          pendientes,
        };
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(registro, null, 2));
        console.log(`[pendientes-wt] ${pendientes.length} pendientes registrados`);
        return json(res, 200, { ok: true, total: pendientes.length });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/pendientes-wt — devuelve último reporte ────────
  if (req.method === 'GET' && req.url === '/api/pendientes-wt') {
    const FILE = path.join(__dirname, 'data', 'pendientes-wt.json');
    let data = { pendientes: [], ts: null };
    try { if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    return json(res, 200, data);
  }

  // ── GET /api/arreglos ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/arreglos') {
    const FILE = path.join(__dirname, 'data', 'arreglos.json');
    let data = [];
    try { if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    return json(res, 200, { arreglos: data });
  }

  // ── POST /api/arreglos — reemplaza lista completa ────────────
  if (req.method === 'POST' && req.url === '/api/arreglos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { arreglos } = JSON.parse(body);
        if (!Array.isArray(arreglos)) return json(res, 400, { error: 'arreglos debe ser array' });
        const FILE = path.join(__dirname, 'data', 'arreglos.json');
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(arreglos, null, 2));
        return json(res, 200, { ok: true, total: arreglos.length });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── GET /api/satelites ───────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/satelites') {
    const FILE = path.join(__dirname, 'data', 'satelites.json');
    let data = [];
    try { if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    return json(res, 200, { movimientos: data });
  }

  // ── POST /api/satelites — reemplaza lista completa ──────────
  if (req.method === 'POST' && req.url === '/api/satelites') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { movimientos } = JSON.parse(body);
        if (!Array.isArray(movimientos)) return json(res, 400, { error: 'movimientos debe ser array' });
        const FILE = path.join(__dirname, 'data', 'satelites.json');
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(movimientos, null, 2));
        return json(res, 200, { ok: true, total: movimientos.length });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── GET /api/wa-status — el bot corre local, no en Railway ──
  if (req.method === 'GET' && req.url === '/api/wa-status') {
    return json(res, 200, { ok: true, status: 'bot-local' });
  }

  // ── Archivos estáticos ──────────────────────────────────────
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  
  if (req.url !== '/' && !fs.existsSync(filePath)) {
    const publicPath = path.join(__dirname, 'public', req.url);
    if (fs.existsSync(publicPath)) filePath = publicPath;
  }
  
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

}).listen(PORT, () => {
  console.log(`W&S App corriendo en puerto ${PORT}`);
  limpiezaAutomatica(); // al arrancar
});

// ── Limpieza automática cada 30 días ────────────────────────────
// Borra registros más antiguos de 30 días, dejando mínimo los 6 más recientes
function limpiezaAutomatica() {
  // ── Limpieza Desactivada a petición del usuario para preservar historial perpetuo ──
  return;
  
  const LIMITE_MS  = 30 * 24 * 60 * 60 * 1000; // 30 días en ms
  const MIN_ITEMS  = 6;
  const ahora      = Date.now();
  const CLEAN_FILE = path.join(__dirname, 'data', 'ultimaLimpieza.json');

  // Solo ejecutar si pasaron al menos 24h desde la última limpieza
  try {
    if (fs.existsSync(CLEAN_FILE)) {
      const { ts } = JSON.parse(fs.readFileSync(CLEAN_FILE, 'utf8'));
      if (ahora - ts < 24 * 60 * 60 * 1000) return;
    }
  } catch {}

  const archivos = [
    { file: path.join(__dirname, 'data', 'pedidos.json'),        campo: 'id' },
    { file: path.join(__dirname, 'data', 'arreglos.json'),       campo: 'id' },
    { file: path.join(__dirname, 'data', 'satelites.json'),      campo: 'id' },
    { file: path.join(__dirname, 'data', 'docsHistorial.json'),  campo: 'id' },
    { file: path.join(__dirname, 'data', 'wetransfer.json'),     campo: 'id' },
    { file: path.join(__dirname, 'data', 'calandra.json'),       campo: 'id' },
  ];

  for (const { file, campo } of archivos) {
    try {
      if (!fs.existsSync(file)) continue;
      let lista = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(lista) || lista.length <= MIN_ITEMS) continue;

      // El campo 'id' es timestamp en ms para todos los registros
      const recientes = lista.filter(x => (ahora - (x[campo] || 0)) < LIMITE_MS);
      // Si quedan menos de MIN_ITEMS, tomar los MIN_ITEMS más nuevos
      const resultado = recientes.length >= MIN_ITEMS
        ? recientes
        : lista.sort((a, b) => (b[campo] || 0) - (a[campo] || 0)).slice(0, MIN_ITEMS);

      if (resultado.length < lista.length) {
        fs.writeFileSync(file, JSON.stringify(resultado, null, 2));
        console.log(`[limpieza] ${path.basename(file)}: ${lista.length} → ${resultado.length} registros`);
      }
    } catch (e) {
      console.error(`[limpieza] Error en ${file}: ${e.message}`);
    }
  }

  fs.mkdirSync(path.dirname(CLEAN_FILE), { recursive: true });
  fs.writeFileSync(CLEAN_FILE, JSON.stringify({ ts: ahora }));
  console.log('[limpieza] Completada');
}

// Repetir cada 24 horas mientras el servidor esté corriendo
setInterval(limpiezaAutomatica, 24 * 60 * 60 * 1000);
