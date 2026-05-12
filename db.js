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
`);

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
  leerNotifs, guardarNotifs,
  leerConfig, guardarConfig,
  leerDocsNums, guardarDocsNums, leerDocsHistorial, guardarDocsHistorial,
  insertEvolutionEvent, leerEvolutionEvents,
  leerIgnorados, insertIgnorado,
  leerPendientesWt, guardarPendientesWt,
};
