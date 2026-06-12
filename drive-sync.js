// ═══════════════════════════════════════════════════════════════════
// drive-sync.js — Integración Google Drive con la app
//
// Lee carpetas:
//   corel    → archivos .cdr (diseños fuente)
//   PDF RIP  → archivos .pdf (listos para enviar a calandra)
//
// Matchea por nombre con pedidos y guarda links + metadata.
// Reutiliza el OAuth de gmail-wt.js.
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const gmailWT = require('./gmail-wt');

// IDs hardcoded por ahora (override via env si querés).
// Confirmados en Drive con MCP.
const FOLDER_COREL         = process.env.DRIVE_FOLDER_COREL         || '11rC8sAn5-DB-bZU7QOFGaEEzHPyW896C';
const FOLDER_PDFRIP        = process.env.DRIVE_FOLDER_PDFRIP        || '1qaEI69DxqwDCE_Ce4UKHAQjCVcdgx_qy';
const FOLDER_FACTURAS      = process.env.DRIVE_FOLDER_FACTURAS      || '1a_a6MyT_pRqlHi81s03NJSwm8t_roHEn';
const FOLDER_COTIZACIONES  = process.env.DRIVE_FOLDER_COTIZACIONES  || '1AYe_y0NDqI4FtmftHlcbgvtSzlBrVxxz';

const STATE_FILE = path.join(__dirname, 'data', 'drive_sync_state.json');

function _leerState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ultimoTs: 0 }; }
}
function _guardarState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Drive API wrapper ────────────────────────────────────────────────
async function driveFetch(url) {
  const tokens = gmailWT._leerTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('Drive no está conectado (falta OAuth)');
  // Refrescar via gmail-wt — comparten el token
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (r.status === 401) {
    // El token venció, refrescamos
    const { google } = await _refrescarToken();
    const r2 = await fetch(url, { headers: { Authorization: `Bearer ${google}` } });
    if (!r2.ok) throw new Error('Drive API error tras refresh: ' + r2.status + ' ' + await r2.text());
    return r2.json();
  }
  if (!r.ok) throw new Error('Drive API error: ' + r.status + ' ' + await r.text());
  return r.json();
}

async function _refrescarToken() {
  // Llamar al refresh via gmail-wt para sincronizar el access_token actualizado
  // (gmail-wt exporta su lógica vía _leerTokens, pero el refresh es interno)
  // Truco: invocar una operación que dispare refresh
  const tokens = gmailWT._leerTokens();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Refresh falló: ' + JSON.stringify(data));
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in * 1000) - 30000;
  fs.writeFileSync(path.join(__dirname, 'data', 'gmail_tokens.json'), JSON.stringify(tokens, null, 2));
  return { google: data.access_token };
}

// ── Listar archivos en una carpeta ──────────────────────────────────
async function listarArchivos(folderId, pageSize = 100) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,size,createdTime,modifiedTime,owners(emailAddress,displayName),webViewLink,thumbnailLink),nextPageToken');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=${pageSize}&fields=${fields}&orderBy=modifiedTime desc`;
  const data = await driveFetch(url);
  return data.files || [];
}

// ── Matching nombre archivo ↔ pedido ─────────────────────────────────
// Usa el mismo parser de gmail-wt.js para consistencia
function matchPedidoPorNombre(nombreArchivo, pedidos) {
  const parsed = gmailWT.parsearArchivo(nombreArchivo);
  if (!parsed || !parsed.base) return null;
  return gmailWT.matchPedido(parsed.base, pedidos);
}

// ── Detectar el diseñador por el owner del archivo en Drive ──────────
// Mapea email del owner del .cdr al diseñador en la app.
const OWNER_EMAIL_TO_DISENADOR = {
  // Mapeo conocido — ampliar con env DRIVE_OWNERS si hace falta
  'duvandominguez05@gmail.com': 'Camilo', // mientras configuran Oscar
  // 'oscar@ws.com': 'Oscar',
  // 'wendy@ws.com': 'Wendy',
};

function detectarDisenadorDeArchivo(archivo) {
  const owners = archivo.owners || [];
  for (const o of owners) {
    const d = OWNER_EMAIL_TO_DISENADOR[o.emailAddress];
    if (d) return d;
  }
  return null;
}

// ── Procesar carpeta corel (.cdr) ───────────────────────────────────
// Asocia archivo .cdr a pedido y opcionalmente auto-asigna diseñador.
async function procesarCorel(pedidos) {
  const archivos = await listarArchivos(FOLDER_COREL, 100);
  const cdrs = archivos.filter(a => /\.cdr$/i.test(a.name) && !/^Copia_de_seguridad_/i.test(a.name));
  const updates = [];
  const huerfanos = [];
  for (const a of cdrs) {
    const match = matchPedidoPorNombre(a.name, pedidos);
    if (!match) {
      huerfanos.push({ tipo: 'corel', archivo: a.name, fileId: a.id, link: a.webViewLink });
      continue;
    }
    const p = match.pedido;
    // Auto-asignar diseñador si no tiene
    const disenadorAuto = detectarDisenadorDeArchivo(a);
    updates.push({
      pedidoId: p.id,
      tipo: 'corel',
      file: {
        id: a.id,
        nombre: a.name,
        link: a.webViewLink,
        modificado: a.modifiedTime,
        tamano: a.size ? parseInt(a.size, 10) : 0,
        owner: a.owners && a.owners[0] ? a.owners[0].emailAddress : null,
      },
      disenadorSugerido: !p.disenadorAsignado ? disenadorAuto : null,
    });
  }
  return { updates, huerfanos, total: cdrs.length };
}

// ── Procesar carpeta PDF RIP (.pdf) ─────────────────────────────────
async function procesarPdfRip(pedidos) {
  const archivos = await listarArchivos(FOLDER_PDFRIP, 100);
  const pdfs = archivos.filter(a => /\.pdf$/i.test(a.name));
  const updates = [];
  const huerfanos = [];
  for (const a of pdfs) {
    const match = matchPedidoPorNombre(a.name, pedidos);
    if (!match) {
      huerfanos.push({ tipo: 'pdf-rip', archivo: a.name, fileId: a.id, link: a.webViewLink });
      continue;
    }
    const p = match.pedido;
    const parsed = gmailWT.parsearArchivo(a.name);
    updates.push({
      pedidoId: p.id,
      tipo: 'pdf-rip',
      file: {
        id: a.id,
        nombre: a.name,
        link: a.webViewLink,
        modificado: a.modifiedTime,
        tamano: a.size ? parseInt(a.size, 10) : 0,
        thumbnail: a.thumbnailLink || null,
      },
      meta: parsed, // m², tela, tipo, etc
    });
  }
  return { updates, huerfanos, total: pdfs.length };
}

// ── API pública: sincronizar Drive con pedidos ──────────────────────
async function sincronizarConPedidos(pedidos) {
  const corel = await procesarCorel(pedidos);
  const pdfRip = await procesarPdfRip(pedidos);

  // Combinar updates por pedidoId
  const porPedido = new Map();
  for (const u of corel.updates) {
    if (!porPedido.has(u.pedidoId)) porPedido.set(u.pedidoId, { pedidoId: u.pedidoId });
    porPedido.get(u.pedidoId).corel = u.file;
    if (u.disenadorSugerido) porPedido.get(u.pedidoId).disenadorSugerido = u.disenadorSugerido;
  }
  for (const u of pdfRip.updates) {
    if (!porPedido.has(u.pedidoId)) porPedido.set(u.pedidoId, { pedidoId: u.pedidoId });
    porPedido.get(u.pedidoId).pdfRip = u.file;
    if (u.meta) porPedido.get(u.pedidoId).meta = u.meta;
  }

  _guardarState({ ultimoTs: Date.now() });

  return {
    updates: Array.from(porPedido.values()),
    huerfanos: [...corel.huerfanos, ...pdfRip.huerfanos],
    totales: { corel: corel.total, pdfRip: pdfRip.total },
  };
}

// ── Subir archivo a Drive (multipart upload) ─────────────────────
// Body: { titulo, mimeType, contentBase64, parentId }
// Devuelve: { id, viewLink, downloadLink }
async function subirArchivo({ titulo, mimeType, contentBase64, parentId }) {
  const tokens = gmailWT._leerTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('Drive no conectado');
  let token = tokens.access_token;

  const metadata = {
    name: titulo,
    parents: parentId ? [parentId] : undefined,
  };
  const boundary = '-------ws-textil-' + Date.now();
  const delim = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;
  const body =
    delim +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delim +
    `Content-Type: ${mimeType}\r\n` +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    contentBase64 +
    closeDelim;

  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink';
  let r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (r.status === 401) {
    const refreshed = await _refrescarToken();
    token = refreshed.google;
    r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
  }
  if (!r.ok) throw new Error('Drive upload fallo: ' + r.status + ' ' + await r.text());
  const data = await r.json();
  return {
    id: data.id,
    viewLink: `https://drive.google.com/file/d/${data.id}/view`,
    downloadLink: `https://drive.google.com/uc?export=download&id=${data.id}`,
  };
}

// ── Hacer un archivo público (cualquiera con el link puede verlo) ──
async function hacerArchivoPublico(fileId) {
  const tokens = gmailWT._leerTokens();
  let token = tokens.access_token;
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`;
  let r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (r.status === 401) {
    const refreshed = await _refrescarToken();
    token = refreshed.google;
    r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  }
  if (!r.ok) throw new Error('Permiso público falló: ' + r.status + ' ' + await r.text());
  return await r.json();
}

// ── Descargar el THUMBNAIL de un archivo Drive (PDF, imagen, etc) ──────
// Drive genera automáticamente miniaturas. Devolvemos la imagen en base64.
// Para PDFs grandes esto evita descargar el archivo entero.
// thumbnailLink viene en la metadata; si no la tenés, podemos generarla.
async function descargarThumbnailBase64(fileId, sizePx = 1000) {
  const tokens = gmailWT._leerTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('Drive sin OAuth');

  // Helper para hacer fetch refrescando token si hace falta
  const fetchConRefresh = async (url, isBinary) => {
    let tok = gmailWT._leerTokens().access_token;
    let r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 401) {
      const { google } = await _refrescarToken();
      r = await fetch(url, { headers: { Authorization: `Bearer ${google}` } });
    }
    return r;
  };

  // 1) Intentar URL directa de thumbnail (funciona para casi todo)
  const directUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w${sizePx}`;
  let dlR = await fetchConRefresh(directUrl);
  if (dlR.ok) {
    const ct = dlR.headers.get('content-type') || '';
    // Verificar que es realmente una imagen (no HTML de error)
    if (ct.startsWith('image/')) {
      const buf = await dlR.arrayBuffer();
      return { base64: Buffer.from(buf).toString('base64'), mime: ct, name: null, sourceSize: null };
    }
  }

  // 2) Fallback: metadata + thumbnailLink
  const metaR = await fetchConRefresh(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,thumbnailLink,mimeType,size`);
  let meta = {};
  try { meta = await metaR.json(); } catch {}
  if (meta.thumbnailLink) {
    const thumbUrl = meta.thumbnailLink.replace(/=s\d+/, `=s${sizePx}`);
    const r2 = await fetchConRefresh(thumbUrl);
    if (r2.ok) {
      const ct2 = r2.headers.get('content-type') || 'image/jpeg';
      if (ct2.startsWith('image/')) {
        const buf = await r2.arrayBuffer();
        return { base64: Buffer.from(buf).toString('base64'), mime: ct2, name: meta.name, sourceSize: meta.size };
      }
    }
  }

  return { base64: null, mime: null, size: 0, name: meta.name || null, error: 'sin thumbnail disponible' };
}

// ── Descargar contenido de un archivo de Drive como base64 ─────────────
// Devuelve { base64, mime, size, name }
async function descargarArchivoBase64(fileId) {
  const tokens = gmailWT._leerTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('Drive sin OAuth');
  // metadata para mime y nombre
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`;
  const metaR = await fetch(metaUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  let meta;
  if (metaR.status === 401) {
    const { google } = await _refrescarToken();
    const r2 = await fetch(metaUrl, { headers: { Authorization: `Bearer ${google}` } });
    meta = await r2.json();
  } else {
    meta = await metaR.json();
  }
  // descarga
  const dlUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const tokenActual = gmailWT._leerTokens().access_token;
  const dlR = await fetch(dlUrl, { headers: { Authorization: `Bearer ${tokenActual}` } });
  if (dlR.status === 401) {
    const { google } = await _refrescarToken();
    const r2 = await fetch(dlUrl, { headers: { Authorization: `Bearer ${google}` } });
    if (!r2.ok) throw new Error('download fail: ' + r2.status);
    const buf = await r2.arrayBuffer();
    return { base64: Buffer.from(buf).toString('base64'), mime: meta.mimeType, size: meta.size, name: meta.name };
  }
  if (!dlR.ok) throw new Error('download fail: ' + dlR.status);
  const buf = await dlR.arrayBuffer();
  return { base64: Buffer.from(buf).toString('base64'), mime: meta.mimeType, size: meta.size, name: meta.name };
}

module.exports = {
  sincronizarConPedidos,
  listarArchivos,
  procesarCorel,
  procesarPdfRip,
  subirArchivo,
  hacerArchivoPublico,
  descargarArchivoBase64,
  descargarThumbnailBase64,
  FOLDER_COREL,
  FOLDER_PDFRIP,
  FOLDER_FACTURAS,
  FOLDER_COTIZACIONES,
};
