// ═══════════════════════════════════════════════════════════════
// db.js — Capa de datos SQLite para W&S Textil ERP
// Reemplaza todas las operaciones con archivos JSON
// ═══════════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'ws-textil.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');    // Mejor rendimiento en lecturas concurrentes
db.pragma('busy_timeout = 5000');   // Espera hasta 5s si otra operación está escribiendo

// ── Crear tablas ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calandra (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS arreglos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS satelites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wetransfer (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comprobantes (
    cid TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notificaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS docs_nums (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS docs_historial (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evolution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pdfs_ignorados (
    tipo TEXT NOT NULL,
    idItem TEXT NOT NULL,
    PRIMARY KEY (tipo, idItem)
  );
  CREATE TABLE IF NOT EXISTS pendientes_wt (
    id INTEGER PRIMARY KEY DEFAULT 1,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS facturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    tipo TEXT NOT NULL,
    cliente_nombre TEXT,
    cliente_telefono TEXT,
    cliente_nit TEXT,
    cliente_correo TEXT,
    vendedora TEXT,
    items TEXT NOT NULL,
    subtotal INTEGER DEFAULT 0,
    abono INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    fecha TEXT NOT NULL,
    pedido_id INTEGER,
    drive_file_id TEXT,
    drive_link TEXT,
    pdf_size INTEGER,
    wa_enviado_a TEXT,
    wa_enviado_fecha TEXT,
    origen TEXT DEFAULT 'app',
    notas TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facturas_tipo ON facturas(tipo);
  CREATE INDEX IF NOT EXISTS idx_facturas_telefono ON facturas(cliente_telefono);
  CREATE INDEX IF NOT EXISTS idx_facturas_fecha ON facturas(fecha);
  CREATE INDEX IF NOT EXISTS idx_facturas_pedido ON facturas(pedido_id);
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    telefono TEXT UNIQUE,
    nit TEXT,
    correo TEXT,
    ciudad TEXT,
    direccion TEXT,
    notas TEXT,
    total_comprado INTEGER DEFAULT 0,
    num_compras INTEGER DEFAULT 0,
    ultima_compra TEXT,
    primer_compra TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_clientes_telefono ON clientes(telefono);
  CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(nombre);

  CREATE TABLE IF NOT EXISTS documentos_salientes_wa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    instance TEXT,
    vendedora TEXT NOT NULL,
    cliente_telefono TEXT,
    cliente_push_name TEXT,
    file_name_original TEXT,
    tipo_mime TEXT,
    drive_file_id TEXT,
    drive_link TEXT,
    bytes INTEGER,
    es_factura INTEGER,
    gemini_analizado INTEGER DEFAULT 0,
    gemini_resultado TEXT,
    factura_id INTEGER,
    pedido_id INTEGER,
    revisado INTEGER DEFAULT 0,
    fecha_captura TEXT NOT NULL,
    fecha_revision TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_docwa_vendedora ON documentos_salientes_wa(vendedora);
  CREATE INDEX IF NOT EXISTS idx_docwa_cliente ON documentos_salientes_wa(cliente_telefono);
  CREATE INDEX IF NOT EXISTS idx_docwa_fecha ON documentos_salientes_wa(fecha_captura);
  CREATE INDEX IF NOT EXISTS idx_docwa_revisado ON documentos_salientes_wa(revisado);

  CREATE TABLE IF NOT EXISTS costureras_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER,
    costurera_slug TEXT NOT NULL,
    costurera_nombre TEXT NOT NULL,
    equipo TEXT,
    prenda TEXT,
    cantidad_enviada INTEGER NOT NULL,
    cantidad_recibida INTEGER,
    faltante INTEGER DEFAULT 0,
    fecha_envio TEXT NOT NULL,
    fecha_recepcion TEXT,
    observaciones TEXT,
    enviado_por TEXT,
    recibido_por TEXT,
    confirmado_costurera INTEGER DEFAULT 0,
    fecha_confirmacion TEXT,
    aviso_7dias_enviado INTEGER DEFAULT 0,
    aviso_7dias_fecha TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cm_costurera ON costureras_movimientos(costurera_slug);
  CREATE INDEX IF NOT EXISTS idx_cm_pedido ON costureras_movimientos(pedido_id);
  CREATE INDEX IF NOT EXISTS idx_cm_fenvio ON costureras_movimientos(fecha_envio);
  CREATE INDEX IF NOT EXISTS idx_cm_pendientes ON costureras_movimientos(fecha_recepcion);

  -- Decisiones manuales del jefe sobre candidatos a venta (panel WA)
  CREATE TABLE IF NOT EXISTS ventas_decisiones (
    candidato_key TEXT PRIMARY KEY,
    decision TEXT NOT NULL,
    pedido_id INTEGER,
    vendedora TEXT,
    monto INTEGER,
    ts INTEGER NOT NULL
  );
`);

// ── Migraciones in-place (ALTER TABLE no soporta IF NOT EXISTS en SQLite) ──
function _addColumnSafe(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
// 2026-06-03: file_hash en documentos_salientes_wa para cruzar con Drive CATALOGO
_addColumnSafe('documentos_salientes_wa', 'file_hash TEXT');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_docwa_hash ON documentos_salientes_wa(file_hash)'); } catch {}

// ── Prepared statements ──────────────────────────────────────────
const S = {
  getPedidos:       db.prepare('SELECT data FROM pedidos ORDER BY id'),
  upsertPedido:     db.prepare('INSERT OR REPLACE INTO pedidos (id, data) VALUES (?, ?)'),
  deletePedido:     db.prepare('DELETE FROM pedidos WHERE id = ?'),
  maxPedidoId:      db.prepare('SELECT COALESCE(MAX(id), 0) as m FROM pedidos'),
  deleteAllPedidos: db.prepare('DELETE FROM pedidos'),

  getCalandra:       db.prepare('SELECT data FROM calandra ORDER BY id'),
  upsertCalandra:    db.prepare('INSERT OR REPLACE INTO calandra (id, data) VALUES (?, ?)'),
  deleteCalandra:    db.prepare('DELETE FROM calandra WHERE id = ?'),
  deleteAllCalandra: db.prepare('DELETE FROM calandra'),

  getArreglos:       db.prepare('SELECT data FROM arreglos ORDER BY id'),
  deleteAllArreglos: db.prepare('DELETE FROM arreglos'),
  insertArreglo:     db.prepare('INSERT INTO arreglos (data) VALUES (?)'),

  getSatelites:       db.prepare('SELECT data FROM satelites ORDER BY id'),
  deleteAllSatelites: db.prepare('DELETE FROM satelites'),
  insertSatelite:     db.prepare('INSERT INTO satelites (data) VALUES (?)'),

  getWt:       db.prepare('SELECT data FROM wetransfer ORDER BY id'),
  upsertWt:    db.prepare('INSERT OR REPLACE INTO wetransfer (id, data) VALUES (?, ?)'),

  getComp:        db.prepare('SELECT data FROM comprobantes'),
  upsertComp:     db.prepare('INSERT OR REPLACE INTO comprobantes (cid, data) VALUES (?, ?)'),
  deleteAllComp:  db.prepare('DELETE FROM comprobantes'),

  getNotifs:       db.prepare('SELECT data FROM notificaciones ORDER BY id'),
  deleteAllNotifs: db.prepare('DELETE FROM notificaciones'),
  insertNotif:     db.prepare('INSERT INTO notificaciones (data) VALUES (?)'),

  getConfig:  db.prepare('SELECT key, value FROM config'),
  setConfig:  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'),

  getDocsNums: db.prepare('SELECT key, value FROM docs_nums'),
  setDocsNum:  db.prepare('INSERT OR REPLACE INTO docs_nums (key, value) VALUES (?, ?)'),

  getDocsHist:       db.prepare('SELECT data FROM docs_historial ORDER BY id DESC'),
  upsertDocsHist:    db.prepare('INSERT OR REPLACE INTO docs_historial (id, data) VALUES (?, ?)'),
  deleteAllDocsHist: db.prepare('DELETE FROM docs_historial'),

  insertEvolution:    db.prepare('INSERT INTO evolution_events (fecha, data) VALUES (?, ?)'),
  getEvolutionFecha:  db.prepare('SELECT data FROM evolution_events WHERE fecha = ?'),

  getIgnorados:    db.prepare('SELECT tipo, idItem FROM pdfs_ignorados'),
  insertIgnorado:  db.prepare('INSERT OR IGNORE INTO pdfs_ignorados (tipo, idItem) VALUES (?, ?)'),

  getPendWt: db.prepare('SELECT data FROM pendientes_wt WHERE id = 1'),
  setPendWt: db.prepare('INSERT OR REPLACE INTO pendientes_wt (id, data) VALUES (1, ?)'),

  // Facturas
  insertFactura: db.prepare(`INSERT INTO facturas
    (numero, tipo, cliente_nombre, cliente_telefono, cliente_nit, cliente_correo, vendedora,
     items, subtotal, abono, total, fecha, pedido_id, drive_file_id, drive_link, pdf_size,
     origen, notas, creado_en)
    VALUES (@numero, @tipo, @cliente_nombre, @cliente_telefono, @cliente_nit, @cliente_correo, @vendedora,
            @items, @subtotal, @abono, @total, @fecha, @pedido_id, @drive_file_id, @drive_link, @pdf_size,
            @origen, @notas, @creado_en)`),
  updateFacturaDrive: db.prepare('UPDATE facturas SET drive_file_id = ?, drive_link = ?, actualizado_en = ? WHERE id = ?'),
  updateFacturaWa: db.prepare('UPDATE facturas SET wa_enviado_a = ?, wa_enviado_fecha = ?, actualizado_en = ? WHERE id = ?'),
  getFacturas: db.prepare(`SELECT * FROM facturas ORDER BY id DESC LIMIT ? OFFSET ?`),
  getFacturasByTel: db.prepare(`SELECT * FROM facturas WHERE cliente_telefono = ? ORDER BY id DESC`),
  getFacturasByPedido: db.prepare(`SELECT * FROM facturas WHERE pedido_id = ? ORDER BY id DESC`),
  getFacturaById: db.prepare(`SELECT * FROM facturas WHERE id = ?`),
  getFacturaByNumero: db.prepare(`SELECT * FROM facturas WHERE numero = ? AND tipo = ?`),
  countFacturas: db.prepare(`SELECT COUNT(*) as n FROM facturas WHERE tipo = ?`),
  sumFacturasPeriodo: db.prepare(`SELECT SUM(total) as total, COUNT(*) as n FROM facturas WHERE tipo = 'factura' AND fecha >= ? AND fecha <= ?`),
  deleteFactura: db.prepare(`DELETE FROM facturas WHERE id = ?`),

  // Clientes
  upsertCliente: db.prepare(`INSERT INTO clientes
    (nombre, telefono, nit, correo, ciudad, direccion, notas, creado_en, actualizado_en)
    VALUES (@nombre, @telefono, @nit, @correo, @ciudad, @direccion, @notas, @creado_en, @actualizado_en)
    ON CONFLICT(telefono) DO UPDATE SET
      nombre = COALESCE(excluded.nombre, nombre),
      nit = COALESCE(excluded.nit, nit),
      correo = COALESCE(excluded.correo, correo),
      ciudad = COALESCE(excluded.ciudad, ciudad),
      direccion = COALESCE(excluded.direccion, direccion),
      notas = COALESCE(excluded.notas, notas),
      actualizado_en = excluded.actualizado_en`),
  bumpClienteCompra: db.prepare(`UPDATE clientes
    SET total_comprado = total_comprado + ?,
        num_compras = num_compras + 1,
        ultima_compra = ?,
        primer_compra = COALESCE(primer_compra, ?),
        actualizado_en = ?
    WHERE telefono = ?`),
  getClientes: db.prepare(`SELECT * FROM clientes ORDER BY total_comprado DESC LIMIT ? OFFSET ?`),
  getClienteByTel: db.prepare(`SELECT * FROM clientes WHERE telefono = ?`),
  searchClientes: db.prepare(`SELECT * FROM clientes WHERE nombre LIKE ? OR telefono LIKE ? ORDER BY total_comprado DESC LIMIT 50`),
};

// ═════════════════════════════════════════════════════════════════
// PEDIDOS
// ═════════════════════════════════════════════════════════════════
function leerPedidos() {
  return S.getPedidos.all().map(r => JSON.parse(r.data));
}

function leerNextId() {
  return (S.maxPedidoId.get().m || 0) + 1;
}

function guardarPedidos(pedidos, _nextId) {
  // _nextId se ignora — se calcula automáticamente con MAX(id)+1
  const tx = db.transaction((arr) => {
    const currentIds = new Set(S.getPedidos.all().map(r => JSON.parse(r.data).id));
    const newIds = new Set(arr.map(p => p.id));
    for (const id of currentIds) {
      if (!newIds.has(id)) S.deletePedido.run(id);
    }
    for (const p of arr) {
      S.upsertPedido.run(p.id, JSON.stringify(p));
    }
  });
  tx(pedidos);
}

function upsertPedido(p) {
  S.upsertPedido.run(p.id, JSON.stringify(p));
}

function deletePedido(id) {
  S.deletePedido.run(id);
}

// ═════════════════════════════════════════════════════════════════
// CALANDRA
// ═════════════════════════════════════════════════════════════════
function leerCalandra() {
  return S.getCalandra.all().map(r => JSON.parse(r.data));
}
function insertCalandra(reg) {
  S.upsertCalandra.run(reg.id, JSON.stringify(reg));
}
function deleteCalandra(id) { S.deleteCalandra.run(id); }
function resetCalandra() { S.deleteAllCalandra.run(); }
function guardarCalandraArray(arr) {
  const tx = db.transaction((items) => {
    S.deleteAllCalandra.run();
    for (const r of items) S.upsertCalandra.run(r.id || Date.now(), JSON.stringify(r));
  });
  tx(arr);
}

// ═════════════════════════════════════════════════════════════════
// ARREGLOS (reemplazo completo)
// ═════════════════════════════════════════════════════════════════
function leerArreglos() {
  return S.getArreglos.all().map(r => JSON.parse(r.data));
}
function guardarArreglos(arr) {
  const tx = db.transaction((items) => {
    S.deleteAllArreglos.run();
    for (const item of items) S.insertArreglo.run(JSON.stringify(item));
  });
  tx(arr);
}

// ═════════════════════════════════════════════════════════════════
// SATELITES (reemplazo completo)
// ═════════════════════════════════════════════════════════════════
function leerSatelites() {
  return S.getSatelites.all().map(r => JSON.parse(r.data));
}
function guardarSatelites(arr) {
  const tx = db.transaction((items) => {
    S.deleteAllSatelites.run();
    for (const item of items) S.insertSatelite.run(JSON.stringify(item));
  });
  tx(arr);
}

// ═════════════════════════════════════════════════════════════════
// WETRANSFER
// ═════════════════════════════════════════════════════════════════
function leerWetransfer() {
  return S.getWt.all().map(r => JSON.parse(r.data));
}
function insertWetransfer(reg) {
  S.upsertWt.run(reg.id, JSON.stringify(reg));
}

// ═════════════════════════════════════════════════════════════════
// COMPROBANTES DETECTADOS
// ═════════════════════════════════════════════════════════════════
function leerComprobantes() {
  return S.getComp.all().map(r => JSON.parse(r.data));
}
function guardarComprobantes(lista) {
  const tx = db.transaction((items) => {
    S.deleteAllComp.run();
    for (const item of items) {
      const cid = item.messageId || String(item.id || Date.now());
      S.upsertComp.run(cid, JSON.stringify(item));
    }
  });
  tx(lista);
}
function upsertComprobante(comp) {
  const cid = comp.messageId || String(comp.id || Date.now());
  S.upsertComp.run(cid, JSON.stringify(comp));
}

// ═════════════════════════════════════════════════════════════════
// VENTAS_DECISIONES — panel WA del jefe
// candidato_key suele ser el messageId del comprobante o "<tipo>:<id>"
// ═════════════════════════════════════════════════════════════════
function leerDecisionVenta(candidatoKey) {
  const r = db.prepare('SELECT * FROM ventas_decisiones WHERE candidato_key = ?').get(candidatoKey);
  return r || null;
}
function guardarDecisionVenta({ candidatoKey, decision, pedidoId, vendedora, monto }) {
  db.prepare('INSERT OR REPLACE INTO ventas_decisiones (candidato_key, decision, pedido_id, vendedora, monto, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(candidatoKey, decision, pedidoId || null, vendedora || null, monto || null, Date.now());
}
function listarDecisionesVentas() {
  return db.prepare('SELECT * FROM ventas_decisiones ORDER BY ts DESC').all();
}

// ═════════════════════════════════════════════════════════════════
// NOTIFICACIONES
// ═════════════════════════════════════════════════════════════════
function leerNotifs() {
  return S.getNotifs.all().map(r => JSON.parse(r.data));
}
function guardarNotifs(arr) {
  const tx = db.transaction((items) => {
    S.deleteAllNotifs.run();
    for (const item of items.slice(-200)) S.insertNotif.run(JSON.stringify(item));
  });
  tx(arr);
}

// ═════════════════════════════════════════════════════════════════
// CONFIG (key-value)
// ═════════════════════════════════════════════════════════════════
function leerConfig() {
  const obj = {};
  for (const r of S.getConfig.all()) {
    try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; }
  }
  return obj;
}
function guardarConfig(obj) {
  const tx = db.transaction((o) => {
    for (const [k, v] of Object.entries(o)) S.setConfig.run(k, JSON.stringify(v));
  });
  tx(obj);
}

// ═════════════════════════════════════════════════════════════════
// DOCS NUMS + HISTORIAL
// ═════════════════════════════════════════════════════════════════
function leerDocsNums() {
  const obj = { nextCot: 210, nextFac: 501 };
  for (const r of S.getDocsNums.all()) {
    try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; }
  }
  return obj;
}
function guardarDocsNums(obj) {
  if (obj.nextCot !== undefined) S.setDocsNum.run('nextCot', JSON.stringify(obj.nextCot));
  if (obj.nextFac !== undefined) S.setDocsNum.run('nextFac', JSON.stringify(obj.nextFac));
}
function leerDocsHistorial() {
  return S.getDocsHist.all().map(r => JSON.parse(r.data));
}
function guardarDocsHistorial(arr) {
  const tx = db.transaction((items) => {
    S.deleteAllDocsHist.run();
    for (const item of items.slice(0, 100)) S.upsertDocsHist.run(item.id, JSON.stringify(item));
  });
  tx(arr);
}

// ═════════════════════════════════════════════════════════════════
// EVOLUTION EVENTS
// ═════════════════════════════════════════════════════════════════
function insertEvolutionEvent(fecha, data) {
  S.insertEvolution.run(fecha, JSON.stringify(data));
}
function leerEvolutionEvents(fecha) {
  return S.getEvolutionFecha.all(fecha).map(r => JSON.parse(r.data));
}

// ═════════════════════════════════════════════════════════════════
// PDFs IGNORADOS
// ═════════════════════════════════════════════════════════════════
function leerIgnorados() {
  const result = { drive: [], wt: [] };
  for (const r of S.getIgnorados.all()) {
    if (r.tipo === 'drive') result.drive.push(r.idItem);
    else if (r.tipo === 'wt') result.wt.push(r.idItem);
  }
  return result;
}
function insertIgnorado(tipo, idItem) {
  S.insertIgnorado.run(tipo, String(idItem));
}

// ═════════════════════════════════════════════════════════════════
// PENDIENTES WT
// ═════════════════════════════════════════════════════════════════
function leerPendientesWt() {
  const r = S.getPendWt.get();
  if (!r) return { pendientes: [], ts: null };
  return JSON.parse(r.data);
}
function guardarPendientesWt(data) {
  S.setPendWt.run(JSON.stringify(data));
}

// ═════════════════════════════════════════════════════════════════
// MIGRACIÓN AUTOMÁTICA DESDE JSON
// ═════════════════════════════════════════════════════════════════
function migrar() {
  const D = path.join(__dirname, 'data');

  function migrarArray(jsonFile, fn) {
    const fp = path.join(D, jsonFile);
    if (!fs.existsSync(fp)) return;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(data)) return;
      fn(data);
      fs.renameSync(fp, fp + '.bak');
      console.log(`[db] Migrado ${jsonFile} → SQLite (${data.length} registros)`);
    } catch (e) { console.error(`[db] Error migrando ${jsonFile}:`, e.message); }
  }

  function migrarObj(jsonFile, fn) {
    const fp = path.join(D, jsonFile);
    if (!fs.existsSync(fp)) return;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      fn(data);
      fs.renameSync(fp, fp + '.bak');
      console.log(`[db] Migrado ${jsonFile} → SQLite`);
    } catch (e) { console.error(`[db] Error migrando ${jsonFile}:`, e.message); }
  }

  migrarArray('pedidos.json', (arr) => {
    const tx = db.transaction((items) => {
      for (const p of items) S.upsertPedido.run(p.id, JSON.stringify(p));
    });
    tx(arr);
  });

  // nextId.json ya no se necesita
  const nip = path.join(D, 'nextId.json');
  if (fs.existsSync(nip)) {
    try { fs.renameSync(nip, nip + '.bak'); } catch {}
    console.log('[db] nextId.json → .bak (ahora se calcula con MAX(id)+1)');
  }

  migrarArray('calandra.json', (arr) => {
    const tx = db.transaction((items) => {
      for (const r of items) S.upsertCalandra.run(r.id || Date.now(), JSON.stringify(r));
    });
    tx(arr);
  });

  migrarArray('arreglos.json', guardarArreglos);
  migrarArray('satelites.json', guardarSatelites);

  migrarArray('wetransfer.json', (arr) => {
    const tx = db.transaction((items) => {
      for (const r of items) S.upsertWt.run(r.id || Date.now(), JSON.stringify(r));
    });
    tx(arr);
  });

  migrarArray('comprobantes-detectados.json', guardarComprobantes);
  migrarArray('notificaciones.json', guardarNotifs);
  migrarArray('docsHistorial.json', guardarDocsHistorial);

  migrarObj('config.json', guardarConfig);
  migrarObj('docsNums.json', guardarDocsNums);
  migrarObj('pendientes-wt.json', guardarPendientesWt);

  // PDFs ignorados
  const ignP = path.join(D, 'pdfs-ignorados.json');
  if (fs.existsSync(ignP)) {
    try {
      const ign = JSON.parse(fs.readFileSync(ignP, 'utf8'));
      if (ign.drive) ign.drive.forEach(id => insertIgnorado('drive', id));
      if (ign.wt) ign.wt.forEach(id => insertIgnorado('wt', id));
      fs.renameSync(ignP, ignP + '.bak');
      console.log('[db] Migrado pdfs-ignorados.json → SQLite');
    } catch (e) { console.error('[db] Error migrando pdfs-ignorados:', e.message); }
  }
}

migrar();
console.log('[db] SQLite inicializado en', DB_PATH);

// ═════════════════════════════════════════════════════════════════
// FACTURAS / COTIZACIONES
// ═════════════════════════════════════════════════════════════════
function crearFactura(data) {
  const now = new Date().toISOString();
  const fila = {
    numero: String(data.numero || '').trim(),
    tipo: data.tipo || 'factura',
    cliente_nombre: data.cliente_nombre || null,
    cliente_telefono: data.cliente_telefono || null,
    cliente_nit: data.cliente_nit || null,
    cliente_correo: data.cliente_correo || null,
    vendedora: data.vendedora || null,
    items: JSON.stringify(data.items || []),
    subtotal: Math.round(Number(data.subtotal) || 0),
    abono: Math.round(Number(data.abono) || 0),
    total: Math.round(Number(data.total) || 0),
    fecha: data.fecha || now.slice(0, 10),
    pedido_id: data.pedido_id ? parseInt(data.pedido_id, 10) : null,
    drive_file_id: data.drive_file_id || null,
    drive_link: data.drive_link || null,
    pdf_size: data.pdf_size ? parseInt(data.pdf_size, 10) : null,
    origen: data.origen || 'app',
    notas: data.notas || null,
    creado_en: now,
  };
  const res = S.insertFactura.run(fila);
  // Si tiene cliente con teléfono, actualizar/crear cliente
  if (fila.cliente_telefono) {
    upsertCliente({
      nombre: fila.cliente_nombre,
      telefono: fila.cliente_telefono,
      nit: fila.cliente_nit,
      correo: fila.cliente_correo,
    });
    if (fila.tipo === 'factura' && fila.total > 0) {
      S.bumpClienteCompra.run(fila.total, fila.fecha, fila.fecha, now, fila.cliente_telefono);
    }
  }
  return { id: res.lastInsertRowid, ...fila };
}

function setFacturaDrive(id, drive_file_id, drive_link) {
  S.updateFacturaDrive.run(drive_file_id, drive_link, new Date().toISOString(), id);
}
function setFacturaWaEnviada(id, telefono) {
  S.updateFacturaWa.run(telefono, new Date().toISOString(), new Date().toISOString(), id);
}

function leerFacturas(limit = 100, offset = 0) {
  return S.getFacturas.all(limit, offset).map(r => ({
    ...r,
    items: (() => { try { return JSON.parse(r.items); } catch { return []; } })(),
  }));
}
function leerFacturasPorTelefono(tel) {
  return S.getFacturasByTel.all(tel).map(r => ({
    ...r,
    items: (() => { try { return JSON.parse(r.items); } catch { return []; } })(),
  }));
}
function leerFacturasPorPedido(pedidoId) {
  return S.getFacturasByPedido.all(pedidoId).map(r => ({
    ...r,
    items: (() => { try { return JSON.parse(r.items); } catch { return []; } })(),
  }));
}
function leerFacturaPorId(id) {
  const r = S.getFacturaById.get(id);
  if (!r) return null;
  try { r.items = JSON.parse(r.items); } catch { r.items = []; }
  return r;
}
function leerFacturaPorNumero(numero, tipo) {
  const r = S.getFacturaByNumero.get(numero, tipo);
  if (!r) return null;
  try { r.items = JSON.parse(r.items); } catch { r.items = []; }
  return r;
}
function contarFacturasPorTipo(tipo) {
  const r = S.countFacturas.get(tipo);
  return r ? r.n : 0;
}
function sumarFacturasPeriodo(desde, hasta) {
  const r = S.sumFacturasPeriodo.get(desde, hasta);
  return { total: r ? (r.total || 0) : 0, n: r ? r.n : 0 };
}
function eliminarFactura(id) { S.deleteFactura.run(id); }

// ═════════════════════════════════════════════════════════════════
// CLIENTES
// ═════════════════════════════════════════════════════════════════
function upsertCliente(data) {
  const now = new Date().toISOString();
  S.upsertCliente.run({
    nombre: data.nombre || null,
    telefono: data.telefono,
    nit: data.nit || null,
    correo: data.correo || null,
    ciudad: data.ciudad || null,
    direccion: data.direccion || null,
    notas: data.notas || null,
    creado_en: data.creado_en || now,
    actualizado_en: now,
  });
}
function leerClientes(limit = 100, offset = 0) {
  return S.getClientes.all(limit, offset);
}
function leerClientePorTel(tel) {
  return S.getClienteByTel.get(tel);
}
function buscarClientes(q) {
  const wild = `%${q}%`;
  return S.searchClientes.all(wild, wild);
}

// ═════════════════════════════════════════════════════════════════
// COSTUREsRAS — registro envio/recepcion de lotes a costura
// ═════════════════════════════════════════════════════════════════
const _cmInsert = db.prepare(`
  INSERT INTO costureras_movimientos
    (pedido_id, costurera_slug, costurera_nombre, equipo, prenda, cantidad_enviada,
     fecha_envio, enviado_por, observaciones)
  VALUES (@pedido_id, @costurera_slug, @costurera_nombre, @equipo, @prenda, @cantidad_enviada,
          @fecha_envio, @enviado_por, @observaciones)
`);
const _cmRecepcion = db.prepare(`
  UPDATE costureras_movimientos
  SET cantidad_recibida = @cantidad_recibida,
      faltante = @faltante,
      fecha_recepcion = @fecha_recepcion,
      recibido_por = @recibido_por,
      observaciones = COALESCE(@observaciones, observaciones)
  WHERE id = @id
`);
const _cmConfirmaCostu = db.prepare(`
  UPDATE costureras_movimientos
  SET confirmado_costurera = 1, fecha_confirmacion = @fecha
  WHERE id = @id AND costurera_slug = @slug
`);
const _cmMarkAviso7 = db.prepare(`
  UPDATE costureras_movimientos
  SET aviso_7dias_enviado = 1, aviso_7dias_fecha = @fecha
  WHERE id = @id
`);
const _cmGetById = db.prepare(`SELECT * FROM costureras_movimientos WHERE id = ?`);
const _cmListPendientes = db.prepare(`
  SELECT * FROM costureras_movimientos
  WHERE fecha_recepcion IS NULL
  ORDER BY fecha_envio DESC
`);
const _cmListPorCostu = db.prepare(`
  SELECT * FROM costureras_movimientos
  WHERE costurera_slug = ?
  ORDER BY fecha_envio DESC
  LIMIT ?
`);
const _cmListPendPorCostu = db.prepare(`
  SELECT * FROM costureras_movimientos
  WHERE costurera_slug = ? AND fecha_recepcion IS NULL
  ORDER BY fecha_envio ASC
`);
const _cmListSemana = db.prepare(`
  SELECT * FROM costureras_movimientos
  WHERE fecha_recepcion >= @desde AND fecha_recepcion <= @hasta
  ORDER BY fecha_recepcion ASC
`);
const _cmListSinAviso7 = db.prepare(`
  SELECT * FROM costureras_movimientos
  WHERE fecha_recepcion IS NULL
    AND aviso_7dias_enviado = 0
    AND fecha_envio <= @limite
`);

function crearMovimientoCostura(data) {
  const res = _cmInsert.run({
    pedido_id: data.pedido_id || null,
    costurera_slug: data.costurera_slug,
    costurera_nombre: data.costurera_nombre,
    equipo: data.equipo || null,
    prenda: data.prenda || null,
    cantidad_enviada: data.cantidad_enviada,
    fecha_envio: data.fecha_envio || new Date().toISOString(),
    enviado_por: data.enviado_por || null,
    observaciones: data.observaciones || null,
  });
  return res.lastInsertRowid;
}

function recibirMovimientoCostura(id, data) {
  _cmRecepcion.run({
    id,
    cantidad_recibida: data.cantidad_recibida,
    faltante: data.faltante || 0,
    fecha_recepcion: data.fecha_recepcion || new Date().toISOString(),
    recibido_por: data.recibido_por || null,
    observaciones: data.observaciones || null,
  });
}

function confirmarRecibidoCostura(id, slug) {
  _cmConfirmaCostu.run({ id, slug, fecha: new Date().toISOString() });
}

function marcarAviso7DiasCostura(id) {
  _cmMarkAviso7.run({ id, fecha: new Date().toISOString() });
}

function leerMovimientoCostura(id) {
  return _cmGetById.get(id);
}

function leerMovimientosCosturaPendientes() {
  return _cmListPendientes.all();
}

function leerMovimientosCostureraPorSlug(slug, limit = 50) {
  return _cmListPorCostu.all(slug, limit);
}

function leerMovimientosCostureraPendientes(slug) {
  return _cmListPendPorCostu.all(slug);
}

function leerMovimientosCosturaSemana(desde, hasta) {
  return _cmListSemana.all({ desde, hasta });
}

function leerMovimientosCosturaSinAviso7Dias(limiteIso) {
  return _cmListSinAviso7.all({ limite: limiteIso });
}

// ═════════════════════════════════════════════════════════════════
// DOCUMENTOS SALIENTES WHATSAPP (captura facturas manuales de vendedoras)
// ═════════════════════════════════════════════════════════════════

const _docwaInsert = db.prepare(`
  INSERT OR IGNORE INTO documentos_salientes_wa
    (message_id, instance, vendedora, cliente_telefono, cliente_push_name,
     file_name_original, tipo_mime, drive_file_id, drive_link, bytes,
     es_factura, gemini_analizado, gemini_resultado, factura_id, pedido_id,
     revisado, fecha_captura, file_hash)
  VALUES
    (@message_id, @instance, @vendedora, @cliente_telefono, @cliente_push_name,
     @file_name_original, @tipo_mime, @drive_file_id, @drive_link, @bytes,
     @es_factura, @gemini_analizado, @gemini_resultado, @factura_id, @pedido_id,
     @revisado, @fecha_captura, @file_hash)
`);
const _docwaPorHash = db.prepare(`
  SELECT * FROM documentos_salientes_wa
  WHERE file_hash = @hash
  ORDER BY fecha_captura DESC
`);
const _docwaUpdateHash = db.prepare(`
  UPDATE documentos_salientes_wa SET file_hash = @hash WHERE id = @id
`);
const _docwaListSemana = db.prepare(`
  SELECT * FROM documentos_salientes_wa
  WHERE fecha_captura >= @desde
  ORDER BY fecha_captura DESC
`);
const _docwaListNoRevisados = db.prepare(`
  SELECT * FROM documentos_salientes_wa
  WHERE revisado = 0
  ORDER BY fecha_captura DESC
`);
const _docwaPorId = db.prepare(`SELECT * FROM documentos_salientes_wa WHERE id = ?`);
const _docwaMarcarRevisado = db.prepare(`
  UPDATE documentos_salientes_wa
  SET revisado = 1, es_factura = @es_factura, factura_id = @factura_id, fecha_revision = @fecha_revision
  WHERE id = @id
`);
const _docwaSetGemini = db.prepare(`
  UPDATE documentos_salientes_wa
  SET gemini_analizado = 1, es_factura = @es_factura, gemini_resultado = @gemini_resultado
  WHERE id = @id
`);

function insertDocumentoSalienteWA(data) {
  const row = {
    message_id: data.message_id || null,
    instance: data.instance || null,
    vendedora: data.vendedora,
    cliente_telefono: data.cliente_telefono || null,
    cliente_push_name: data.cliente_push_name || null,
    file_name_original: data.file_name_original || null,
    tipo_mime: data.tipo_mime || null,
    drive_file_id: data.drive_file_id || null,
    drive_link: data.drive_link || null,
    bytes: data.bytes || null,
    es_factura: data.es_factura == null ? null : (data.es_factura ? 1 : 0),
    gemini_analizado: data.gemini_analizado ? 1 : 0,
    gemini_resultado: data.gemini_resultado || null,
    factura_id: data.factura_id || null,
    pedido_id: data.pedido_id || null,
    revisado: data.revisado ? 1 : 0,
    fecha_captura: data.fecha_captura || new Date().toISOString(),
    file_hash: data.file_hash || null,
  };
  return _docwaInsert.run(row);
}
function leerDocumentosSalientesPorHash(hash) {
  if (!hash) return [];
  return _docwaPorHash.all({ hash });
}
function actualizarHashDocSaliente(id, hash) {
  return _docwaUpdateHash.run({ id, hash });
}
function leerDocumentosSalientesWASemana(desdeIso) {
  return _docwaListSemana.all({ desde: desdeIso });
}
function leerDocumentosSalientesWANoRevisados() {
  return _docwaListNoRevisados.all();
}
function leerDocumentoSalienteWAporId(id) {
  return _docwaPorId.get(id);
}
function marcarDocumentoSalienteRevisado(id, esFactura, facturaId) {
  return _docwaMarcarRevisado.run({
    id,
    es_factura: esFactura ? 1 : 0,
    factura_id: facturaId || null,
    fecha_revision: new Date().toISOString(),
  });
}
function setDocumentoSalienteGemini(id, esFactura, resultado) {
  return _docwaSetGemini.run({
    id,
    es_factura: esFactura ? 1 : 0,
    gemini_resultado: typeof resultado === 'string' ? resultado : JSON.stringify(resultado || {}),
  });
}

// ═════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════
module.exports = {
  raw: db,
  leerPedidos, leerNextId, guardarPedidos, upsertPedido, deletePedido,
  leerCalandra, insertCalandra, deleteCalandra, resetCalandra, guardarCalandraArray,
  leerArreglos, guardarArreglos,
  leerSatelites, guardarSatelites,
  leerWetransfer, insertWetransfer,
  leerComprobantes, guardarComprobantes, upsertComprobante,
  leerDecisionVenta, guardarDecisionVenta, listarDecisionesVentas,
  leerNotifs, guardarNotifs,
  leerConfig, guardarConfig,
  leerDocsNums, guardarDocsNums, leerDocsHistorial, guardarDocsHistorial,
  insertEvolutionEvent, leerEvolutionEvents,
  leerIgnorados, insertIgnorado,
  leerPendientesWt, guardarPendientesWt,
  // Facturas
  crearFactura, setFacturaDrive, setFacturaWaEnviada,
  leerFacturas, leerFacturasPorTelefono, leerFacturasPorPedido,
  leerFacturaPorId, leerFacturaPorNumero,
  contarFacturasPorTipo, sumarFacturasPeriodo, eliminarFactura,
  // Clientes
  upsertCliente, leerClientes, leerClientePorTel, buscarClientes,
  // Costureras
  crearMovimientoCostura, recibirMovimientoCostura, confirmarRecibidoCostura,
  marcarAviso7DiasCostura, leerMovimientoCostura,
  leerMovimientosCosturaPendientes, leerMovimientosCostureraPorSlug,
  leerMovimientosCostureraPendientes, leerMovimientosCosturaSemana,
  leerMovimientosCosturaSinAviso7Dias,
  // Documentos salientes WhatsApp (captura facturas manuales)
  insertDocumentoSalienteWA, leerDocumentosSalientesWASemana,
  leerDocumentosSalientesWANoRevisados, leerDocumentoSalienteWAporId,
  marcarDocumentoSalienteRevisado, setDocumentoSalienteGemini,
  leerDocumentosSalientesPorHash, actualizarHashDocSaliente,
};
