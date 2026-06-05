// ═══════════════════════════════════════════════════════════════════
// catalogo-fotos-watcher.js — Watcher de la carpeta Drive "CATALOGO"
//
// Recursivo: entra a CATALOGO + todas las subcarpetas (sin importar
// como organicen). Por cada JPG/PNG nuevo:
//   1. Descarga y calcula SHA256
//   2. Busca match en documentos_salientes_wa (foto que la vendedora
//      le envio a algun cliente)
//   3. Si match → identifica cliente y vendedora
//   4. Saca nombre del equipo del filename
//   5. Amarra al pedido activo del cliente con: equipo + foto Drive
//
// Reutiliza el OAuth de gmail-wt.js (mismo token de Drive).
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gmailWT = require('./gmail-wt');

const FOLDER_CATALOGO = process.env.DRIVE_FOLDER_CATALOGO || '18KQclpuL1Jbg-ED5iJQP-sAm2HGR6-e5';
const STATE_FILE = path.join(__dirname, 'data', 'catalogo_watcher_state.json');

function _leerState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { procesados: {} }; }
}
function _guardarState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Drive API wrapper (reusa OAuth de gmail-wt) ─────────────────────
async function driveFetch(url) {
  const tokens = gmailWT._leerTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('Drive no conectado (OAuth)');
  let r = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (r.status === 401) {
    // Refresh token
    const rr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data = await rr.json();
    if (!rr.ok) throw new Error('Refresh fallo: ' + JSON.stringify(data));
    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + (data.expires_in * 1000) - 30000;
    fs.writeFileSync(path.join(__dirname, 'data', 'gmail_tokens.json'), JSON.stringify(tokens, null, 2));
    r = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  }
  if (!r.ok) throw new Error('Drive API: ' + r.status + ' ' + (await r.text().catch(()=>'')));
  return r.json();
}

async function driveFetchBinary(url) {
  const tokens = gmailWT._leerTokens();
  let r = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (r.status === 401) {
    // Trigger refresh via driveFetch (compartiendo lógica)
    await driveFetch('https://www.googleapis.com/drive/v3/files?pageSize=1');
    const fresh = gmailWT._leerTokens();
    r = await fetch(url, { headers: { Authorization: `Bearer ${fresh.access_token}` } });
  }
  if (!r.ok) throw new Error('Drive download: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ── Listar archivos de una carpeta (filtros JPG/PNG opcional) ───────
async function listarArchivosCarpeta(folderId, soloImagenes = true) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (soloImagenes) {
    q += ` and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')`;
  }
  const qEnc = encodeURIComponent(q);
  const fields = encodeURIComponent('files(id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,parents),nextPageToken');
  let url = `https://www.googleapis.com/drive/v3/files?q=${qEnc}&pageSize=200&fields=${fields}&orderBy=modifiedTime desc`;
  const result = [];
  let pageToken = null;
  do {
    const u = pageToken ? `${url}&pageToken=${pageToken}` : url;
    const data = await driveFetch(u);
    for (const f of (data.files || [])) result.push(f);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return result;
}

// ── Recursivo: lista TODAS las imagenes bajo CATALOGO (cualquier subcarpeta) ──
async function listarTodasImagenesRecursivo(folderId, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  const items = await listarArchivosCarpeta(folderId, true);
  const imagenes = [];
  for (const it of items) {
    if (it.mimeType === 'application/vnd.google-apps.folder') {
      const subs = await listarTodasImagenesRecursivo(it.id, depth + 1, maxDepth);
      imagenes.push(...subs);
    } else if (/^image\//.test(it.mimeType || '')) {
      imagenes.push(it);
    }
  }
  return imagenes;
}

// ── Descargar imagen y calcular SHA256 ──────────────────────────────
async function descargarYHashear(fileId) {
  const buf = await driveFetchBinary(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { hash, bytes: buf.length };
}

// ── Extraer nombre del equipo del filename ──────────────────────────
// "almany fc chaqueta.jpg" → "almany fc chaqueta"
// "ARGENTINA AZUL OSCURO.jpg" → "Argentina Azul Oscuro"
// "real awaliba fc.jpg" → "real awaliba fc"
function nombreEquipoDeFilename(filename) {
  if (!filename) return null;
  // Quitar extension
  const sinExt = filename.replace(/\.[a-z0-9]+$/i, '').trim();
  // Capitalizar palabras pequenas (opcional, dejar como vino tambien funciona)
  return sinExt;
}

// ── Encontrar pedido activo del cliente para amarrar ────────────────
function encontrarPedidoActivoCliente(pedidos, telefonoCliente) {
  const ESTADOS_CANDIDATOS = new Set(['bandeja', 'hacer-diseno', 'confirmado', 'enviado-calandra', 'llego-impresion', 'corte', 'costura']);
  function normTel(t) {
    const d = String(t || '').replace(/\D/g, '');
    return d.startsWith('57') ? d.slice(2) : d;
  }
  const telN = normTel(telefonoCliente);
  const candidatos = pedidos.filter(p => {
    if (!p.telefono) return false;
    if (!ESTADOS_CANDIDATOS.has(p.estado)) return false;
    return normTel(p.telefono) === telN;
  });
  candidatos.sort((a, b) => {
    const ta = new Date(a.ultimoMovimiento || 0).getTime();
    const tb = new Date(b.ultimoMovimiento || 0).getTime();
    return tb - ta;
  });
  return candidatos[0] || null;
}

// ── ANALIZAR (SIN amarrar nada) — para endpoint de prueba ───────────
async function analizarCatalogo({ db, pedidos = [], diasAtras = 14, soloHashMatching = true }) {
  if (!gmailWT.estaConectado()) return { error: 'Drive no conectado (gmail-wt)' };

  const todas = await listarTodasImagenesRecursivo(FOLDER_CATALOGO);
  if (!todas.length) return { error: 'sin imagenes en CATALOGO', total: 0 };

  const cutoffTs = Date.now() - (diasAtras * 24 * 60 * 60 * 1000);
  const recientes = todas.filter(f => new Date(f.modifiedTime).getTime() >= cutoffTs);

  const state = _leerState();
  const reporte = [];
  let descargasHechas = 0;

  for (const f of recientes) {
    const yaProcesado = state.procesados[f.id];
    let hash = yaProcesado?.hash || null;

    // Solo descargamos si no tenemos el hash y necesitamos cruzarlo
    if (!hash) {
      try {
        const dh = await descargarYHashear(f.id);
        hash = dh.hash;
        descargasHechas++;
      } catch (e) {
        reporte.push({ file: f.name, error: 'descarga: ' + e.message });
        continue;
      }
    }

    // Buscar match en docs salientes (vendedora → cliente)
    const matches = db.leerDocumentosSalientesPorHash(hash) || [];
    const equipoNombre = nombreEquipoDeFilename(f.name);

    let pedidoCandidato = null, clienteDetectado = null, vendedoraDetectada = null;
    if (matches.length > 0) {
      // Tomamos el match mas reciente (suele ser uno solo)
      const m = matches[0];
      clienteDetectado = m.cliente_telefono;
      vendedoraDetectada = m.vendedora;
      if (pedidos.length) {
        pedidoCandidato = encontrarPedidoActivoCliente(pedidos, clienteDetectado);
      }
    }

    reporte.push({
      file: f.name,
      fileId: f.id,
      modificado: f.modifiedTime,
      sizeKB: f.size ? Math.round(parseInt(f.size, 10) / 1024) : null,
      driveLink: `https://drive.google.com/file/d/${f.id}/view`,
      hash: hash ? hash.slice(0, 16) + '...' : null,
      equipoExtraido: equipoNombre,
      hashMatches: matches.length,
      clienteDetectado,
      vendedoraDetectada,
      pedidoCandidato: pedidoCandidato ? {
        id: pedidoCandidato.id,
        vendedora: pedidoCandidato.vendedora,
        estado: pedidoCandidato.estado,
        equipoActual: pedidoCandidato.equipo || '(sin nombre)',
      } : null,
      accion: pedidoCandidato && equipoNombre
        ? `AMARRARIA pedido #${pedidoCandidato.id} (${pedidoCandidato.vendedora}) con equipo="${equipoNombre}"`
        : matches.length > 0
          ? `Cliente detectado (${clienteDetectado}) pero sin pedido activo`
          : 'Sin match — esta foto NO fue enviada por WA a un cliente registrado',
    });

    state.procesados[f.id] = { hash, ts: Date.now() };
  }

  _guardarState(state);

  return {
    folder: FOLDER_CATALOGO,
    diasAtrasFiltro: diasAtras,
    totalImagenesCatalogo: todas.length,
    imagenesRecientes: recientes.length,
    descargasHechas,
    matchesEncontrados: reporte.filter(r => r.hashMatches > 0).length,
    detalle: reporte,
  };
}

// ── PROCESAR Y AMARRAR (SI modifica pedidos) — para cron real ──────
// Recorre fotos del CATALOGO, calcula hash, busca match en docs salientes
// y MODIFICA el pedido del cliente con el nombre del archivo.
//
// Cutoff temporal: usa state.activadoEnTs para NO procesar archivos
// modificados antes de la activacion del cron (historico).
async function procesarYAmarrar({ db, notificarWAVendedora = null, conImagen = true } = {}) {
  if (!db || !db.leerPedidos || !db.upsertPedido) {
    return { error: 'faltan db.leerPedidos/db.upsertPedido' };
  }
  if (!gmailWT.estaConectado()) {
    return { error: 'Drive no conectado (gmail-wt)' };
  }

  const state = _leerState();
  // Activado al primer arranque: no procesar nada anterior
  if (!state.activadoEnTs) {
    state.activadoEnTs = Date.now();
    _guardarState(state);
    return { procesados: 0, amarrados: 0, mensaje: 'cron activado, no procesa historico', cutoff: state.activadoEnTs };
  }

  // Listar todas las imagenes recursivamente
  let todas;
  try {
    todas = await listarTodasImagenesRecursivo(FOLDER_CATALOGO);
  } catch (e) {
    return { error: 'listar Drive: ' + e.message };
  }
  if (!todas.length) return { procesados: 0, amarrados: 0, sinMatch: 0 };

  // Filtrar: solo archivos MODIFICADOS despues de la activacion + no procesados ya
  const cutoffTs = state.activadoEnTs;
  const candidatos = todas.filter(f => {
    const mt = new Date(f.modifiedTime || 0).getTime();
    if (mt < cutoffTs) return false;
    if (state.procesados && state.procesados[f.id]) return false;
    return true;
  });

  if (!candidatos.length) {
    return { procesados: 0, amarrados: 0, sinMatch: 0, cutoff: cutoffTs };
  }

  const pedidos = db.leerPedidos();
  const resultados = { procesados: 0, amarrados: 0, sinMatch: 0, sinHashMatch: 0, detalle: [] };

  for (const f of candidatos) {
    resultados.procesados++;
    // Descargar y hashear
    let hash;
    try {
      const dh = await descargarYHashear(f.id);
      hash = dh.hash;
    } catch (e) {
      resultados.detalle.push({ file: f.name, error: 'descarga: ' + e.message });
      continue;
    }

    // Marcar como procesado (aunque no haya match)
    state.procesados = state.procesados || {};
    state.procesados[f.id] = { hash, ts: Date.now(), name: f.name };

    // Buscar match en docs salientes
    const matches = db.leerDocumentosSalientesPorHash(hash) || [];
    if (!matches.length) {
      resultados.sinHashMatch++;
      resultados.detalle.push({ file: f.name, accion: 'SIN-HASH-MATCH' });
      continue;
    }

    // Tomar match mas reciente
    const m = matches[0];
    const telefonoCliente = m.cliente_telefono;

    // Buscar pedido activo del cliente
    const pedidoCandidato = encontrarPedidoActivoCliente(pedidos, telefonoCliente);
    if (!pedidoCandidato) {
      resultados.sinMatch++;
      resultados.detalle.push({ file: f.name, accion: 'SIN-PEDIDO-ACTIVO', cliente: telefonoCliente });
      continue;
    }

    // Releer pedido fresco
    const fresco = db.leerPedidos().find(p => p.id === pedidoCandidato.id);
    if (!fresco) continue;
    const p = fresco;

    // Solo reemplazar si: equipoVieneDeBot o generico/vacio Y no amarrado previo del grupo
    const equipoActual = String(p.equipo || '').trim();
    const equipoNuevo = nombreEquipoDeFilename(f.name);
    if (!equipoNuevo) continue;
    const esReemplazable = (p.equipoVieneDeBot === true) || !equipoActual ||
                           /^cliente\s+\+?\d/i.test(equipoActual);
    if (!esReemplazable && !p.equipoAmarradoDeGrupo) {
      // Tiene nombre real ya — no pisar
      resultados.detalle.push({ file: f.name, accion: 'SIN-MATCH', razon: 'pedido ya tiene nombre real', pedidoId: p.id });
      continue;
    }

    // Aplicar amarre
    p.equipo = equipoNuevo;
    p.equipoAmarradoDeGrupo = true;
    p.amarradoDeGrupoFuente = 'catalogo-hash';
    p.amarradoDeGrupoIso = new Date().toISOString();
    p.catalogoFotoId = f.id;
    p.catalogoFotoLink = `https://drive.google.com/file/d/${f.id}/view`;
    if (p.estado === 'bandeja' || p.estado === 'hacer-diseno') {
      p.estado = 'confirmado';
    }
    p.ultimoMovimiento = new Date().toISOString();

    try {
      db.upsertPedido(p);
    } catch (e) {
      resultados.detalle.push({ file: f.name, accion: 'ERROR', error: e.message });
      continue;
    }
    resultados.amarrados++;
    resultados.detalle.push({
      file: f.name, accion: 'AMARRADO', pedidoId: p.id,
      equipo: equipoNuevo, vendedora: p.vendedora, cliente: telefonoCliente,
    });

    // Notificar a la vendedora con instrucciones de flujo
    if (typeof notificarWAVendedora === 'function' && p.vendedora) {
      try {
        const msg =
          `✅ *NOMBRE IDENTIFICADO*\n\n` +
          `📋 Pedido #${p.id}\n` +
          `📞 Cliente: ${telefonoCliente}\n` +
          `🏷️ Equipo: *${equipoNuevo}*\n` +
          `📌 Fuente: foto en Drive CATALOGO (hash match)\n\n` +
          `👉 *A partir de ahora cuando trabajes este pedido:*\n` +
          `• Guarda el .cdr en Drive corel con nombre *${equipoNuevo}*\n` +
          `• PDF rip con nombre *${equipoNuevo}*\n` +
          `• WeTransfer a calandra mencionando *${equipoNuevo}*\n` +
          `→ Yo conecto todo el flujo solo.\n\n` +
          `❓ Si está mal, responde: *no ${p.id} [nombre correcto]*`;
        await notificarWAVendedora(p.vendedora, msg);
      } catch (e) { console.error('[catalogo notif err]', e.message); }
    }
  }

  _guardarState(state);
  return { ...resultados, cutoff: cutoffTs };
}

module.exports = {
  FOLDER_CATALOGO,
  listarTodasImagenesRecursivo,
  descargarYHashear,
  nombreEquipoDeFilename,
  encontrarPedidoActivoCliente,
  analizarCatalogo,
  procesarYAmarrar,
};
