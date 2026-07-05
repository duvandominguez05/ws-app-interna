// ═══════════════════════════════════════════════════════════════════
// v2-server.js — ERP paralelo al viejo. NO borra nada del original.
// Objetivo: mostrar el estado real de cada pedido desde que se crea
// hasta que se entrega, sin pedirle nada a nadie (monitor pasivo).
//
// Convive con server.js. Se registra bajo /api/v2/* y sirve /v2.
// Tablas propias: v2_pedidos, v2_eventos (misma db, prefijo v2_).
// ═══════════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'ws-textil.db');

let db = null;

function initV2() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT,
      cliente TEXT,
      equipo TEXT,
      vendedora TEXT,
      etapa TEXT NOT NULL DEFAULT 'confirmado',
      creado_en TEXT NOT NULL,
      ultimo_movimiento TEXT NOT NULL,
      origen TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_v2_pedidos_tel ON v2_pedidos(telefono);
    CREATE INDEX IF NOT EXISTS idx_v2_pedidos_etapa ON v2_pedidos(etapa);
    CREATE INDEX IF NOT EXISTS idx_v2_pedidos_mov ON v2_pedidos(ultimo_movimiento);

    CREATE TABLE IF NOT EXISTS v2_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      etapa_de TEXT,
      etapa_a TEXT,
      tipo TEXT NOT NULL,
      titulo TEXT,
      detalle TEXT,
      foto_url TEXT,
      fuente TEXT,
      meta TEXT,
      FOREIGN KEY (pedido_id) REFERENCES v2_pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_eventos_pedido ON v2_eventos(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_v2_eventos_ts ON v2_eventos(ts);
  `);

  console.log('[v2] tablas listas — v2_pedidos, v2_eventos');
}

// ═══════════════════════════════════════════════════════════════════
// ETAPAS canonicas (orden = progresion natural)
// ═══════════════════════════════════════════════════════════════════
const ETAPAS = [
  'confirmado',       // comprobante detectado
  'en_diseno',        // se creo, aun no hay JPG enviado
  'diseno_enviado',   // vendedora envio JPG al cliente (etiqueta "En Proceso")
  'en_calandra',      // PDF aparecio en Drive (calandra imprimiendo)
  'en_costura',       // registrado en /costura
  'listo',            // etiqueta WA "Hecho"
  'entregado',        // etiqueta WA "Entregado"
];

function etapaValida(e) { return ETAPAS.includes(e); }

// ═══════════════════════════════════════════════════════════════════
// HELPERS DB
// ═══════════════════════════════════════════════════════════════════

function rowToPedido(r) {
  if (!r) return null;
  return {
    id: r.id,
    telefono: r.telefono,
    cliente: r.cliente,
    equipo: r.equipo,
    vendedora: r.vendedora,
    etapa: r.etapa,
    creadoEn: r.creado_en,
    ultimoMovimiento: r.ultimo_movimiento,
    origen: r.origen,
    meta: r.meta ? safeJson(r.meta) : null,
  };
}

function rowToEvento(r) {
  return {
    id: r.id,
    pedidoId: r.pedido_id,
    ts: r.ts,
    etapaDe: r.etapa_de,
    etapaA: r.etapa_a,
    tipo: r.tipo,
    titulo: r.titulo,
    detalle: r.detalle,
    fotoUrl: r.foto_url,
    fuente: r.fuente,
    meta: r.meta ? safeJson(r.meta) : null,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Upsert por telefono: crea pedido si no existe, o retorna el existente.
// Regla: si no viene equipo/cliente, no lo pisamos.
function upsertPorTelefono({ telefono, cliente, equipo, vendedora, origen, meta }) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) throw new Error('telefono requerido');

  const existente = db.prepare('SELECT * FROM v2_pedidos WHERE telefono = ? ORDER BY id DESC LIMIT 1').get(tel);
  const ahora = new Date().toISOString();

  if (existente) {
    const updates = [];
    const args = [];
    if (cliente && !existente.cliente) { updates.push('cliente = ?'); args.push(cliente); }
    if (equipo && !existente.equipo) { updates.push('equipo = ?'); args.push(equipo); }
    if (vendedora && !existente.vendedora) { updates.push('vendedora = ?'); args.push(vendedora); }
    if (updates.length) {
      args.push(existente.id);
      db.prepare(`UPDATE v2_pedidos SET ${updates.join(', ')} WHERE id = ?`).run(...args);
    }
    return { id: existente.id, creado: false };
  }

  const info = db.prepare(`
    INSERT INTO v2_pedidos (telefono, cliente, equipo, vendedora, etapa, creado_en, ultimo_movimiento, origen, meta)
    VALUES (?, ?, ?, ?, 'confirmado', ?, ?, ?, ?)
  `).run(tel, cliente || null, equipo || null, vendedora || null, ahora, ahora, origen || null, meta ? JSON.stringify(meta) : null);

  const id = info.lastInsertRowid;
  addEvento(id, {
    tipo: 'creado',
    titulo: 'Pedido creado',
    detalle: origen || null,
    fuente: origen || null,
    etapaA: 'confirmado',
    meta,
  });
  return { id, creado: true };
}

function addEvento(pedidoId, { tipo, titulo, detalle, fotoUrl, fuente, etapaDe, etapaA, meta }) {
  if (!pedidoId) throw new Error('pedidoId requerido');
  if (!tipo) throw new Error('tipo requerido');
  const p = db.prepare('SELECT id, etapa FROM v2_pedidos WHERE id = ?').get(pedidoId);
  if (!p) throw new Error('pedido no existe');

  const ahora = new Date().toISOString();
  const _etapaDe = etapaDe || p.etapa;
  let _etapaA = etapaA;
  if (_etapaA && !etapaValida(_etapaA)) _etapaA = null;

  db.prepare(`
    INSERT INTO v2_eventos (pedido_id, ts, etapa_de, etapa_a, tipo, titulo, detalle, foto_url, fuente, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pedidoId, ahora, _etapaDe, _etapaA || null, tipo, titulo || null, detalle || null, fotoUrl || null, fuente || null, meta ? JSON.stringify(meta) : null);

  if (_etapaA && _etapaA !== p.etapa) {
    db.prepare('UPDATE v2_pedidos SET etapa = ?, ultimo_movimiento = ? WHERE id = ?').run(_etapaA, ahora, pedidoId);
  } else {
    db.prepare('UPDATE v2_pedidos SET ultimo_movimiento = ? WHERE id = ?').run(ahora, pedidoId);
  }
  return true;
}

function listPedidos({ etapa, limit = 200 } = {}) {
  let rows;
  if (etapa && etapa !== 'todos') {
    rows = db.prepare('SELECT * FROM v2_pedidos WHERE etapa = ? ORDER BY ultimo_movimiento DESC LIMIT ?').all(etapa, limit);
  } else {
    rows = db.prepare('SELECT * FROM v2_pedidos ORDER BY ultimo_movimiento DESC LIMIT ?').all(limit);
  }
  return rows.map(rowToPedido);
}

function getPedido(id) {
  const r = db.prepare('SELECT * FROM v2_pedidos WHERE id = ?').get(id);
  return rowToPedido(r);
}

function getTimeline(pedidoId) {
  const rows = db.prepare('SELECT * FROM v2_eventos WHERE pedido_id = ? ORDER BY ts ASC, id ASC').all(pedidoId);
  return rows.map(rowToEvento);
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM v2_pedidos').get().c;
  const porEtapa = db.prepare('SELECT etapa, COUNT(*) c FROM v2_pedidos GROUP BY etapa').all();
  const map = {};
  for (const e of ETAPAS) map[e] = 0;
  for (const r of porEtapa) map[r.etapa] = r.c;
  return { total, porEtapa: map };
}

// ═══════════════════════════════════════════════════════════════════
// ROUTER — llamado desde server.js si req.url.startsWith('/api/v2/')
// ═══════════════════════════════════════════════════════════════════

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function handleV2Request(req, res) {
  const url = req.url;
  const method = req.method;

  try {
    // GET /api/v2/estado
    if (method === 'GET' && url === '/api/v2/estado') {
      return json(res, 200, { ok: true, version: 'v2-alpha', etapas: ETAPAS, ...stats() });
    }

    // GET /api/v2/pedidos?etapa=X&limit=N
    if (method === 'GET' && url.startsWith('/api/v2/pedidos') && !url.match(/\/api\/v2\/pedidos\/\d+/)) {
      const u = new URL(url, 'http://localhost');
      const etapa = u.searchParams.get('etapa') || undefined;
      const limit = parseInt(u.searchParams.get('limit') || '200', 10);
      return json(res, 200, { pedidos: listPedidos({ etapa, limit }), stats: stats() });
    }

    // GET /api/v2/pedidos/:id
    const mGet = url.match(/^\/api\/v2\/pedidos\/(\d+)$/);
    if (method === 'GET' && mGet) {
      const id = Number(mGet[1]);
      const p = getPedido(id);
      if (!p) return json(res, 404, { error: 'no existe' });
      const eventos = getTimeline(id);
      return json(res, 200, { pedido: p, eventos });
    }

    // POST /api/v2/pedidos/upsert
    if (method === 'POST' && url === '/api/v2/pedidos/upsert') {
      const body = await readBody(req);
      const { telefono, cliente, equipo, vendedora, origen, meta } = body || {};
      const r = upsertPorTelefono({ telefono, cliente, equipo, vendedora, origen, meta });
      return json(res, 200, { ok: true, ...r });
    }

    // POST /api/v2/pedidos/:id/evento
    const mEv = url.match(/^\/api\/v2\/pedidos\/(\d+)\/evento$/);
    if (method === 'POST' && mEv) {
      const id = Number(mEv[1]);
      const body = await readBody(req);
      addEvento(id, body || {});
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'ruta v2 no encontrada', url });
  } catch (e) {
    console.error('[v2 handler error]', e.message);
    return json(res, 500, { error: e.message });
  }
}

module.exports = {
  initV2,
  handleV2Request,
  ETAPAS,
  // exportados para hooks de server.js (mirror desde detectores viejos)
  upsertPorTelefono,
  addEvento,
  listPedidos,
  getPedido,
  getTimeline,
  stats,
};
