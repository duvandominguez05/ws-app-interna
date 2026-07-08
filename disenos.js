// ═══════════════════════════════════════════════════════════════════
// disenos.js — Match automatico de disenos enviados por WA
//
// Flujo:
//   1. Watcher Drive (n8n) llama registrarCatalogo() con cada JPG nuevo
//      de la carpeta CATALOGO — guarda {fileId, nombre, sha256, phash}
//   2. Webhook Evolution llama procesarImagenSaliente() cuando una vendedora
//      manda una imagen a un cliente por WA. Descarga, hashea, matchea.
//   3. Si matchea + hay pedido activo del cliente -> nombra + avanza estado.
//   4. Notif Telegram admin en cada caso (matcheado / no matcheado / sin pedido).
//
// Convive con el ERP existente. NO crea pedidos.
// Solo NOMBRA y AVANZA los que ya existen por sticker/comprobante.
// ═══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

let db = null; // se setea en init()

// ═══ Init tabla ═══
function init(dbInstance) {
  db = dbInstance;
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS disenos_catalogo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      nombre TEXT NOT NULL,
      sha256 TEXT,
      phash TEXT,
      size_bytes INTEGER,
      modified_time TEXT,
      created_server TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_disenos_file_id ON disenos_catalogo(file_id);
    CREATE INDEX IF NOT EXISTS idx_disenos_sha256 ON disenos_catalogo(sha256);
    CREATE INDEX IF NOT EXISTS idx_disenos_nombre ON disenos_catalogo(nombre);

    CREATE TABLE IF NOT EXISTS disenos_enviados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      diseno_catalogo_id INTEGER,
      pedido_id INTEGER,
      telefono_cliente TEXT,
      instancia_vendedora TEXT,
      wa_msg_id TEXT,
      match_metodo TEXT,
      match_confianza REAL,
      ts_envio TEXT NOT NULL,
      ts_registrado TEXT NOT NULL,
      FOREIGN KEY (diseno_catalogo_id) REFERENCES disenos_catalogo(id)
    );
    CREATE INDEX IF NOT EXISTS idx_env_tel ON disenos_enviados(telefono_cliente);
    CREATE INDEX IF NOT EXISTS idx_env_ped ON disenos_enviados(pedido_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_env_wa_msg ON disenos_enviados(wa_msg_id);
  `);
  console.log('[disenos] tablas listas — disenos_catalogo, disenos_enviados');
}

// ═══ Hashing helpers ═══

function calcularSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// pHash simple con jimp: reduce a 8x8, promedio grises, bit por pixel.
// Devuelve 64 bits en hex (16 chars). Compara con Hamming distance.
async function calcularPHash(buffer) {
  try {
    const img = await Jimp.read(buffer);
    img.resize(8, 8).greyscale();
    let sum = 0;
    const pixels = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const p = img.getPixelColor(x, y);
        const gray = (p >>> 24) & 0xFF; // R (post greyscale es todos iguales)
        pixels.push(gray);
        sum += gray;
      }
    }
    const avg = sum / 64;
    let bits = '';
    for (const p of pixels) bits += (p >= avg ? '1' : '0');
    // Convertir 64 bits a 16 hex chars
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.substr(i, 4), 2).toString(16);
    }
    return hex;
  } catch (e) {
    console.error('[phash error]', e.message);
    return null;
  }
}

function hammingDistance(hex1, hex2) {
  if (!hex1 || !hex2 || hex1.length !== hex2.length) return 999;
  let d = 0;
  for (let i = 0; i < hex1.length; i++) {
    let x = parseInt(hex1[i], 16) ^ parseInt(hex2[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

// ═══ Registrar en catalogo ═══

// Idempotente: mismo fileId + mismo sha256 -> skip. Mismo fileId con nuevo sha256 -> nueva version.
function registrarCatalogo({ fileId, nombre, sha256, phash, sizeBytes, modifiedTime }) {
  if (!fileId || !nombre) throw new Error('fileId y nombre requeridos');
  const existente = db.raw.prepare('SELECT id, sha256, version FROM disenos_catalogo WHERE file_id = ? ORDER BY id DESC LIMIT 1').get(fileId);
  if (existente && existente.sha256 === sha256) {
    return { ok: true, accion: 'skip', id: existente.id };
  }
  const nuevaVersion = existente ? (existente.version + 1) : 1;
  const info = db.raw.prepare(`
    INSERT INTO disenos_catalogo (file_id, nombre, sha256, phash, size_bytes, modified_time, created_server, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, nombre, sha256 || null, phash || null, sizeBytes || null, modifiedTime || null, new Date().toISOString(), nuevaVersion);
  return { ok: true, accion: existente ? 'reemplazo' : 'nuevo', id: info.lastInsertRowid, version: nuevaVersion };
}

function listarCatalogo({ limit = 100 } = {}) {
  return db.raw.prepare('SELECT * FROM disenos_catalogo ORDER BY id DESC LIMIT ?').all(limit);
}

function statsCatalogo() {
  const total = db.raw.prepare('SELECT COUNT(*) c FROM disenos_catalogo').get().c;
  const enviados = db.raw.prepare('SELECT COUNT(*) c FROM disenos_enviados').get().c;
  return { total, enviados };
}

// ═══ Match ═══

// Busca match. Prioriza sha256 exacto, cae a pHash con umbral.
// Devuelve { catalogo, metodo, confianza } o null.
function buscarMatch({ sha256, phash }) {
  // 1) sha256 exacto
  if (sha256) {
    const r = db.raw.prepare('SELECT * FROM disenos_catalogo WHERE sha256 = ? ORDER BY id DESC LIMIT 1').get(sha256);
    if (r) return { catalogo: r, metodo: 'sha256', confianza: 1.0 };
  }
  // 2) pHash (Hamming distance <= 5 sobre 64 bits)
  if (phash) {
    const filas = db.raw.prepare('SELECT * FROM disenos_catalogo WHERE phash IS NOT NULL ORDER BY id DESC LIMIT 500').all();
    let mejor = null;
    let mejorDist = 999;
    for (const f of filas) {
      const d = hammingDistance(phash, f.phash);
      if (d < mejorDist) { mejor = f; mejorDist = d; }
    }
    if (mejor && mejorDist <= 5) {
      const confianza = 1 - (mejorDist / 64);
      return { catalogo: mejor, metodo: 'phash', confianza, distancia: mejorDist };
    }
  }
  return null;
}

// Registrar un envio detectado (para historial + evitar procesar el mismo wa_msg_id 2 veces).
function registrarEnvio({ disenoCatalogoId, pedidoId, telefonoCliente, instanciaVendedora, waMsgId, metodo, confianza, tsEnvio }) {
  try {
    db.raw.prepare(`
      INSERT INTO disenos_enviados (diseno_catalogo_id, pedido_id, telefono_cliente, instancia_vendedora, wa_msg_id, match_metodo, match_confianza, ts_envio, ts_registrado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(disenoCatalogoId || null, pedidoId || null, telefonoCliente || null, instanciaVendedora || null, waMsgId || null, metodo || null, confianza || null, tsEnvio || new Date().toISOString(), new Date().toISOString());
    return true;
  } catch (e) {
    // UNIQUE constraint fail = ya lo procesamos
    if (String(e.message || '').includes('UNIQUE')) return false;
    console.error('[disenos registrarEnvio]', e.message);
    return false;
  }
}

function envioYaProcesado(waMsgId) {
  if (!waMsgId) return false;
  const r = db.raw.prepare('SELECT id FROM disenos_enviados WHERE wa_msg_id = ?').get(waMsgId);
  return !!r;
}

// ═══ Buscar pedido activo por telefono ═══

// Busca el pedido mas reciente activo (con pago o sticker) del telefono dado.
// Retorna { id, equipo, estado, ... } o null.
function buscarPedidoActivoPorTel(pedidos, telefono) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return null;
  const candidatos = pedidos.filter(p => {
    const tp = String(p.telefono || '').replace(/\D/g, '');
    return tp === tel && p.estado !== 'enviado-final' && p.estado !== 'archivado';
  });
  if (!candidatos.length) return null;
  // Ordenar por fecha de creacion desc
  candidatos.sort((a, b) => {
    const ta = new Date(a.creadoEn || a.creadoTs || 0).getTime();
    const tb = new Date(b.creadoEn || b.creadoTs || 0).getTime();
    return tb - ta;
  });
  return candidatos[0];
}

module.exports = {
  init,
  calcularSha256,
  calcularPHash,
  hammingDistance,
  registrarCatalogo,
  listarCatalogo,
  statsCatalogo,
  buscarMatch,
  registrarEnvio,
  envioYaProcesado,
  buscarPedidoActivoPorTel,
};
