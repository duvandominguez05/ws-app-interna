// ═══════════════════════════════════════════════════════════════════
// gmail-wt.js — Integración Gmail + parser WeTransfer
//
// Lee correos de noreply@wetransfer.com en el Gmail conectado,
// parsea el nombre del archivo y los matchea con pedidos.
//
// Requiere env vars:
//   GOOGLE_CLIENT_ID         (de Google Cloud Console)
//   GOOGLE_CLIENT_SECRET     (de Google Cloud Console)
//   GOOGLE_REDIRECT_URI      (ej: https://ws-app-interna-production.up.railway.app/api/gmail/callback)
//
// Tokens persistidos en data/gmail_tokens.json (refresh_token vive ahí).
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'data', 'gmail_tokens.json');
const STATE_FILE  = path.join(__dirname, 'data', 'gmail_wt_state.json');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'https://ws-app-interna-production.up.railway.app/api/gmail/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

// ── Token storage ─────────────────────────────────────────────────────
function _leerTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return null; }
}
function _guardarTokens(tokens) {
  try { fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function estaConectado() {
  const t = _leerTokens();
  return !!(t && t.refresh_token);
}

// ── Sync state (cuál fue el último email procesado) ──────────────────
function _leerState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ultimoTs: 0, ultimoIds: [] }; }
}
function _guardarState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── OAuth helpers ─────────────────────────────────────────────────────
function getAuthUrl() {
  if (!CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID no configurado en env vars');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // fuerza emitir refresh_token aunque ya haya consentimiento previo
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function intercambiarCodigo(code) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID/SECRET no configurados');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Token exchange falló: ' + JSON.stringify(data));
  if (!data.refresh_token) throw new Error('Google no devolvió refresh_token (¿ya estaba autorizado? quita la app de https://myaccount.google.com/permissions y reintenta)');
  _guardarTokens({
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 30000,
    conectado_en: new Date().toISOString(),
  });
  return { ok: true };
}

async function getAccessToken() {
  const t = _leerTokens();
  if (!t || !t.refresh_token) throw new Error('Gmail no está conectado. Ir a /api/gmail/auth primero.');
  // Si el access_token sigue válido, reutilizar
  if (t.access_token && t.expires_at && Date.now() < t.expires_at) return t.access_token;
  // Refresh
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Refresh falló: ' + JSON.stringify(data));
  t.access_token = data.access_token;
  t.expires_at = Date.now() + (data.expires_in * 1000) - 30000;
  _guardarTokens(t);
  return t.access_token;
}

// ── Gmail API wrappers ────────────────────────────────────────────────
async function gmailFetch(url) {
  const token = await getAccessToken();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Gmail API error: ' + r.status + ' ' + await r.text());
  return r.json();
}

async function listarMensajesWT(maxResults = 50) {
  // q: from:noreply@wetransfer.com — sólo enviado y descargado
  const q = encodeURIComponent('from:noreply@wetransfer.com newer_than:30d');
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`;
  const data = await gmailFetch(url);
  return data.messages || [];
}

async function obtenerMensaje(id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  return gmailFetch(url);
}

function _headerValor(payload, nombre) {
  const headers = (payload && payload.headers) || [];
  const h = headers.find(x => x.name.toLowerCase() === nombre.toLowerCase());
  return h ? h.value : '';
}

function _decodeBase64Url(s) {
  try {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b, 'base64').toString('utf8');
  } catch { return ''; }
}

function _extraerCuerpo(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data) return _decodeBase64Url(payload.body.data);
  const partes = payload.parts || [];
  for (const p of partes) {
    if (p.mimeType === 'text/plain' || p.mimeType === 'text/html') {
      if (p.body && p.body.data) return _decodeBase64Url(p.body.data);
    }
    if (p.parts) {
      const r = _extraerCuerpo(p);
      if (r) return r;
    }
  }
  return '';
}

// ── Parser de subject + nombre de archivo ────────────────────────────
//
// Subjects conocidos:
//   "ARCHIVO.pdf enviado correctamente a destinatario@gmail.com"
//   "destinatario@gmail.com descargó ARCHIVO.pdf"
//
function parsearSubject(subject) {
  if (!subject) return null;
  // Enviado
  let m = subject.match(/^(.+?)\s+enviado correctamente a\s+(.+?)$/i);
  if (m) return { tipo: 'enviado', archivo: m[1].trim(), destinatario: m[2].trim() };
  // Descargado
  m = subject.match(/^(.+?)\s+descargó\s+(.+?)$/i);
  if (m) return { tipo: 'descargado', destinatario: m[1].trim(), archivo: m[2].trim() };
  return null;
}

// ── Parser de nombre de archivo ──────────────────────────────────────
//
// Ej: "IMPERMEABLE NACHOS FC CHAQUETAS_540.pdf"
//   → tela: impermeable, base: "NACHOS FC CHAQUETAS", m2: 540, tipoPrenda: chaquetas
//
// Ej: "URGENTE brasil espartano_096.pdf"
//   → prioridad: urgente, base: "brasil espartano", m2: 96
//
// Ej: "camerun negro faltante_068.pdf"
//   → tipo: arreglo, base: "camerun negro", m2: 68
//
function parsearArchivo(nombreArchivo) {
  if (!nombreArchivo) return null;
  let nombre = nombreArchivo.replace(/\.pdf$/i, '').trim();

  const datos = {
    nombreOriginal: nombreArchivo,
    nombreLimpio: nombre,
    tipo: 'original',     // original | arreglo | adicional | muestra
    prioridad: 'normal',  // normal | urgente
    tela: null,            // impermeable | texturizada | etc
    m2: null,
    base: nombre,          // nombre sin metadatos
  };

  // Extraer m² del sufijo _NUM al final
  const m2Match = nombre.match(/_(\d[\d,]*)$/);
  if (m2Match) {
    datos.m2 = parseInt(m2Match[1].replace(/,/g, ''), 10);
    nombre = nombre.slice(0, m2Match.index).trim();
  }

  // Detectar prioridad y limpiar
  if (/\burgente\b/i.test(nombre)) {
    datos.prioridad = 'urgente';
    nombre = nombre.replace(/\b(urgente hoy|urgente)\b/gi, '').trim();
  }

  // Detectar tipo arreglo/adicional
  const PALABRAS_ARREGLO = ['arreglo', 'arreglos', 'faltante', 'faltantes'];
  const PALABRAS_ADICIONAL = ['adicional', 'adicionales'];
  const PALABRAS_MUESTRA = ['muestra', 'muestras'];
  for (const p of PALABRAS_ARREGLO) {
    if (new RegExp(`\\b${p}\\b`, 'i').test(nombre)) {
      datos.tipo = 'arreglo';
      nombre = nombre.replace(new RegExp(`\\b${p}\\b`, 'gi'), '').trim();
    }
  }
  for (const p of PALABRAS_ADICIONAL) {
    if (new RegExp(`\\b${p}\\b`, 'i').test(nombre)) {
      datos.tipo = 'adicional';
      nombre = nombre.replace(new RegExp(`\\b${p}\\b`, 'gi'), '').trim();
    }
  }
  for (const p of PALABRAS_MUESTRA) {
    if (new RegExp(`\\b${p}\\b`, 'i').test(nombre)) {
      datos.tipo = 'muestra';
      nombre = nombre.replace(new RegExp(`\\b${p}\\b`, 'gi'), '').trim();
    }
  }

  // Detectar tela
  const TELAS = ['impermeable', 'texturizada', 'rib', 'polialgodon', 'algodon', 'dryfit'];
  for (const t of TELAS) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(nombre)) {
      datos.tela = t;
      nombre = nombre.replace(new RegExp(`\\b${t}\\b`, 'gi'), '').trim();
    }
  }

  // Limpiar artefactos: prefijos numéricos sueltos al inicio "1 ", "3 "
  nombre = nombre.replace(/^\d+\s+/, '').trim();
  // Múltiples espacios
  nombre = nombre.replace(/\s{2,}/g, ' ');

  datos.base = nombre;
  return datos;
}

// ── Extraer link we.tl del cuerpo ────────────────────────────────────
function extraerLinkWT(cuerpo) {
  if (!cuerpo) return null;
  const m = cuerpo.match(/https?:\/\/we\.tl\/[a-zA-Z0-9\-]+/);
  return m ? m[0] : null;
}

// ── Matching pedido por nombre base ──────────────────────────────────
function _normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchPedido(base, pedidos) {
  const baseNorm = _normalizar(base);
  if (!baseNorm) return null;
  // 1) Match exacto por equipo
  let mejor = null;
  let mejorScore = 0;
  for (const p of pedidos) {
    if (!p.equipo) continue;
    if (p.estado === 'enviado-final' || p.estado === 'archivado') continue;
    const eq = _normalizar(p.equipo);
    if (!eq) continue;
    // Score: cuántas palabras del archivo aparecen en el equipo (y vice-versa)
    const palabrasFile = new Set(baseNorm.split(' ').filter(w => w.length >= 3));
    const palabrasEquipo = new Set(eq.split(' ').filter(w => w.length >= 3));
    let coincidencias = 0;
    for (const w of palabrasFile) if (palabrasEquipo.has(w)) coincidencias++;
    // Score = % de palabras del file que coinciden
    const score = palabrasFile.size > 0 ? coincidencias / palabrasFile.size : 0;
    // Si el archivo tiene 2+ palabras, exigir al menos 2 coincidencias (no solo 1 palabra suelta como "negro")
    const minCoincidencias = palabrasFile.size >= 2 ? 2 : 1;
    if (score > mejorScore && score >= 0.6 && coincidencias >= minCoincidencias) {
      mejorScore = score;
      mejor = p;
    }
  }
  return mejor ? { pedido: mejor, score: mejorScore } : null;
}

// ── Procesar UN mensaje y devolver lo que aprendimos ─────────────────
async function procesarMensaje(id) {
  const msg = await obtenerMensaje(id);
  const subject = _headerValor(msg.payload, 'Subject');
  const fechaInternal = parseInt(msg.internalDate, 10);
  const parsedSubject = parsearSubject(subject);
  if (!parsedSubject) return null;
  const parsedFile = parsearArchivo(parsedSubject.archivo);
  if (!parsedFile) return null;
  const cuerpo = _extraerCuerpo(msg.payload);
  const linkWT = parsedSubject.tipo === 'enviado' ? extraerLinkWT(cuerpo) : null;
  return {
    id,
    fecha: new Date(fechaInternal).toISOString(),
    subject,
    accion: parsedSubject.tipo,              // 'enviado' | 'descargado'
    destinatario: parsedSubject.destinatario,
    archivo: parsedFile,
    linkWT,
  };
}

// ── API pública: sincronizar correos WT con la BD de pedidos ─────────
// Recibe pedidos en memoria, devuelve SOLO actualizaciones realmente nuevas.
// Dedup robusto: persiste TODOS los IDs ya procesados (cap 1500 entradas).
async function sincronizarConPedidos(pedidos) {
  const state = _leerState();
  const procesadosSet = new Set(state.procesados || state.ultimoIds || []);

  const ids = (await listarMensajesWT(50)).map(m => m.id);
  const nuevos = ids.filter(id => !procesadosSet.has(id));
  const procesados = [];
  for (const id of nuevos) {
    try {
      const info = await procesarMensaje(id);
      if (info) procesados.push(info);
      // Marcamos como procesado incluso si parsearSubject devolvió null
      // (así no reintentamos correos no-WT en cada tick).
      procesadosSet.add(id);
    } catch (e) {
      console.error('[gmail-wt] error procesando', id, e.message);
    }
  }
  procesados.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const updates = [];
  const huerfanos = [];
  for (const m of procesados) {
    const match = matchPedido(m.archivo.base, pedidos);
    if (!match) {
      huerfanos.push(m);
      continue;
    }
    const p = match.pedido;
    const wt = p.wetransfer || { archivos: [] };
    const existente = wt.archivos.find(a => a.nombreOriginal === m.archivo.nombreOriginal);
    let cambio = false;
    if (!existente) {
      wt.archivos.push({
        ...m.archivo,
        fechaEnvio: m.accion === 'enviado' ? m.fecha : null,
        fechaDescarga: m.accion === 'descargado' ? m.fecha : null,
        destinatario: m.destinatario,
        linkWT: m.linkWT,
      });
      cambio = true;
    } else {
      if (m.accion === 'enviado') {
        if (!existente.fechaEnvio) { existente.fechaEnvio = m.fecha; cambio = true; }
        if (m.linkWT && existente.linkWT !== m.linkWT) { existente.linkWT = m.linkWT; cambio = true; }
      }
      if (m.accion === 'descargado') {
        if (!existente.fechaDescarga) { existente.fechaDescarga = m.fecha; cambio = true; }
      }
    }
    if (cambio) {
      wt.ultimaActualizacion = new Date().toISOString();
      updates.push({
        pedidoId: p.id,
        wetransfer: wt,
        accion: m.accion,
        archivo: m.archivo,
        msgId: m.id,
      });
    }
  }

  // Cap del Set a 1500 IDs más recientes para que no crezca infinito
  const procesadosArr = Array.from(procesadosSet);
  const procesadosFinal = procesadosArr.slice(-1500);
  _guardarState({ ultimoTs: Date.now(), procesados: procesadosFinal });

  return { updates, huerfanos, total: procesados.length };
}

module.exports = {
  estaConectado,
  getAuthUrl,
  intercambiarCodigo,
  parsearSubject,
  parsearArchivo,
  matchPedido,
  sincronizarConPedidos,
  // Exports para testing/debug
  _leerTokens,
  _leerState,
  _guardarState,
};
