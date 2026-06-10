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
  'https://www.googleapis.com/auth/drive.file',
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

  // Extraer LARGO del sufijo _NUM al final.
  // CONVENCION DE LOS DISENADORES: el numero esta en CENTIMETROS.
  // Para obtener METROS LINEALES hay que dividir por 100 (esto se hace al
  // mostrar en cron domingo y dashboard, no aqui — para no romper datos viejos).
  // Ejemplos:
  //   _60      -> 60 cm  = 0.60 m
  //   _317     -> 317 cm = 3.17 m
  //   _1.000   -> 1000 cm = 10.00 m (punto separador de miles)
  //   _1,342   -> 1342 cm = 13.42 m (coma separador de miles)
  // Aceptamos ambos separadores. Guardamos como cm; el campo se llama m2 por
  // compatibilidad pero su unidad real es CENTIMETROS de largo de tela.
  const m2Match = nombre.match(/_(\d[\d,.]*)$/);
  if (m2Match) {
    const raw = m2Match[1].replace(/[,.]/g, '');
    const cm = parseInt(raw, 10);
    datos.m2 = isNaN(cm) ? null : cm;
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
const _STOPWORDS_GW = new Set([
  'fc', 'cf', 'sas', 'sa', 'club', 'team', 'equipo', 'fb', 'fut',
  'copia', 'copy', 'final', 'finall', 'def', 'definitivo',
  'nuevo', 'new', 'corregido', 'editado', 'modificado',
  'recuperada', 'recuperado', 'backup', 'respaldo',
  'v', 'ver', 'version',
]);

function _normalizar(s) {
  let t = String(s || '');
  // Sacar prefijos basura
  t = t.replace(/^(recuperada?[_ -]|copia[_ -]de[_ -]?|copy[_ -]of[_ -]?|backup[_ -]of[_ -]?|resp[_ -]?)/i, '');
  // Sacar sufijo v2, (1), v3 al final
  t = t.replace(/\s*[\(\[]?v?\d+(\.\d+)?\s*m?[\)\]]?\s*$/i, '');
  return t
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin tildes
    .replace(/[^a-z0-9\s]/g, ' ')          // saca emojis, simbolos, basura UTF-8 rota
    .replace(/\s+/g, ' ')
    .trim();
}

function _palabrasRicas(s) {
  return new Set(
    _normalizar(s).split(' ')
      .filter(w => w.length >= 3 && !_STOPWORDS_GW.has(w) && !/^\d+$/.test(w))
  );
}

function matchPedido(base, pedidos) {
  const baseNorm = _normalizar(base);
  if (!baseNorm) return null;
  const palabrasFile = _palabrasRicas(base);

  // ESTADOS NO ELEGIBLES
  const noEleg = new Set(['enviado-final','archivado','entregado','cancelado']);

  let mejor = null;
  let mejorScore = 0;

  for (const p of pedidos) {
    if (noEleg.has(p.estado)) continue;
    if (!p.equipo && !p.cliente) continue;

    // 0) Alias guardado = match fuerte
    if (Array.isArray(p.archivosAlias) && p.archivosAlias.length) {
      for (const al of p.archivosAlias) {
        if (_normalizar(al) === baseNorm) return { pedido: p, score: 1 };
      }
    }

    // 1) Match contra equipo
    const palEq = _palabrasRicas(p.equipo || '');
    let comunesEq = 0;
    for (const w of palabrasFile) if (palEq.has(w)) comunesEq++;
    const minPal = Math.max(1, Math.min(palabrasFile.size, palEq.size));
    const scoreEq = minPal ? comunesEq / minPal : 0;

    // 2) Match contra cliente (a veces el archivo se llama como el cliente)
    const palCl = _palabrasRicas(p.cliente || '');
    let comunesCl = 0;
    for (const w of palabrasFile) if (palCl.has(w)) comunesCl++;
    const minPalCl = Math.max(1, Math.min(palabrasFile.size, palCl.size));
    const scoreCl = minPalCl ? comunesCl / minPalCl : 0;

    // Tomamos el mayor de los 2
    const score = Math.max(scoreEq, scoreCl);
    const comunes = Math.max(comunesEq, comunesCl);

    // Umbral: 50% Y al menos 1 palabra rica coincidente
    if (score > mejorScore && score >= 0.5 && comunes >= 1) {
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

  // Persistir huérfanos para que el dashboard de Calandra pueda mostrarlos
  // y permitir vincularlos manualmente más tarde.
  const huerfanosAnteriores = (state.huerfanos || []).filter(h => {
    // Eliminar los que ya tienen msgId en procesadosFinal (deduplicar)
    return h && h.msgId;
  });
  // Mergeo: nuevos huérfanos primero, sin duplicar msgId
  const huerfanosMap = new Map();
  for (const h of huerfanos) {
    huerfanosMap.set(h.id, {
      msgId: h.id,
      fecha: h.fecha,
      accion: h.accion,
      destinatario: h.destinatario,
      archivo: h.archivo,
      linkWT: h.linkWT,
      vinculadoPedidoId: null,
    });
  }
  for (const h of huerfanosAnteriores) {
    if (!huerfanosMap.has(h.msgId) && !h.vinculadoPedidoId) huerfanosMap.set(h.msgId, h);
  }
  const huerfanosFinal = Array.from(huerfanosMap.values()).slice(0, 300);

  _guardarState({
    ultimoTs: Date.now(),
    procesados: procesadosFinal,
    huerfanos: huerfanosFinal,
  });

  return { updates, huerfanos, total: procesados.length };
}

// ── Lectura/manipulación de huérfanos ────────────────────────────
function leerHuerfanos() {
  const state = _leerState();
  return (state.huerfanos || []).filter(h => !h.vinculadoPedidoId);
}

function vincularHuerfano(msgId, pedidoId, pedidos) {
  // Vincula manualmente un huérfano a un pedido específico.
  // Devuelve la actualización para que el llamador la aplique al pedido.
  const state = _leerState();
  const huerfanos = state.huerfanos || [];
  const idx = huerfanos.findIndex(h => h.msgId === msgId);
  if (idx === -1) throw new Error('Huérfano no encontrado: ' + msgId);
  const h = huerfanos[idx];
  const p = pedidos.find(x => x.id === parseInt(pedidoId, 10));
  if (!p) throw new Error('Pedido no encontrado: ' + pedidoId);

  const wt = p.wetransfer || { archivos: [] };
  const existente = wt.archivos.find(a => a.nombreOriginal === h.archivo.nombreOriginal);
  if (!existente) {
    wt.archivos.push({
      ...h.archivo,
      fechaEnvio: h.accion === 'enviado' ? h.fecha : null,
      fechaDescarga: h.accion === 'descargado' ? h.fecha : null,
      destinatario: h.destinatario,
      linkWT: h.linkWT,
    });
  } else {
    if (h.accion === 'enviado') {
      existente.fechaEnvio = existente.fechaEnvio || h.fecha;
      if (h.linkWT) existente.linkWT = h.linkWT;
    }
    if (h.accion === 'descargado') {
      existente.fechaDescarga = existente.fechaDescarga || h.fecha;
    }
  }
  wt.ultimaActualizacion = new Date().toISOString();

  // Marcar el huérfano como vinculado (no eliminar, para auditoría)
  huerfanos[idx] = { ...h, vinculadoPedidoId: p.id, vinculadoFecha: new Date().toISOString() };
  _guardarState({ ...state, huerfanos });

  return { wetransfer: wt, pedido: p };
}

module.exports = {
  estaConectado,
  getAuthUrl,
  intercambiarCodigo,
  parsearSubject,
  parsearArchivo,
  matchPedido,
  sincronizarConPedidos,
  leerHuerfanos,
  vincularHuerfano,
  // Exports para testing/debug
  _leerTokens,
  _leerState,
  _guardarState,
};
