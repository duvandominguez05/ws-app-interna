// ═══════════════════════════════════════════════════════════════════
// grupo-trabajo-familia-watcher.js — Watcher del grupo "Trabajo en
// familia" (JID 573506974711-1612841042@g.us)
//
// Lee mensajes humanos (NO del bot) y detecta avances del flujo:
//   "almany fc cortado"   → estado=corte
//   "almany fc en costura" → estado=costura
//   "almany fc listo"      → estado=listo
//   "almany fc entregado"  → estado=enviado-final
//
// Gemini parsea texto+foto → { nombre_equipo, estado_detectado }
// El sistema busca el pedido por nombre y avanza el estado.
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const GRUPO_TRABAJO_JID = process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us';
const STATE_FILE = path.join(__dirname, 'data', 'grupo_trabajo_state.json');

const EVO_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
const EVO_KEY = process.env.EVOLUTION_API_KEY || process.env.WA_NOTIF_APIKEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
const EVO_INSTANCE = process.env.WA_NOTIF_INSTANCE || 'ws-duvan';

// Patrones de mensajes del propio bot — IGNORAR para no procesarse a si mismo
const PATRONES_BOT = [
  '💰 VENTA CONFIRMADA',
  '📊 RESUMEN',
  '📊 CIERRE',
  '🎉 Venta',
  '🎨 Pedido en',
  '⚠️ Pago detectado',
  '💸 Pago detectado',
  '📋 PENDIENTE',
  '⏰ Alerta',
  '🚨 Atasco',
  '📦 Calandra',
  '🧪 PRUEBA REAL',
  '✅ NOMBRE IDENTIFICADO',
];

function leerState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ultimoTs: 0, procesados: {} }; }
}
function guardarState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function esMensajeDelBot(texto) {
  if (!texto) return false;
  return PATRONES_BOT.some(p => texto.includes(p));
}

// ── Listar mensajes del grupo via Evolution ─────────────────────────
async function listarMensajesGrupo(limit = 60) {
  const requestLimit = Math.max(200, limit * 4);
  const r = await fetch(`${EVO_URL}/chat/findMessages/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
    body: JSON.stringify({ where: { key: { remoteJid: GRUPO_TRABAJO_JID } }, limit: requestLimit }),
  });
  if (!r.ok) throw new Error(`Evolution chat/findMessages: ${r.status}`);
  const data = await r.json();
  const all = data.messages?.records || (Array.isArray(data) ? data : []);
  all.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
  return all.slice(0, limit);
}

// ── Extraer texto util de un mensaje ───────────────────────────────
function extraerTexto(m) {
  const msg = m.message || {};
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  return '';
}

// ── Mapeo estado_detectado → estado del pedido ──────────────────────
const MAPA_ESTADOS = {
  'corte':         'corte',
  'cortado':       'corte',
  'corte-listo':   'corte',
  'costura':       'costura',
  'en-costura':    'costura',
  'cosiendo':      'costura',
  'costura-listo': 'listo',
  'listo':         'listo',
  'terminado':     'listo',
  'ready':         'listo',
  'entregado':     'enviado-final',
  'enviado':       'enviado-final',
  'entregadocliente': 'enviado-final',
  'recibido':      'enviado-final',
  'enviado-final': 'enviado-final',
  'calandra-llego': 'llego-impresion',
  'impresion-llego': 'llego-impresion',
};

function normalizarEstado(estadoDetectado) {
  if (!estadoDetectado) return null;
  const norm = String(estadoDetectado).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z\-]/g, '');
  return MAPA_ESTADOS[norm] || null;
}

// Orden de avance del flujo — solo permitimos ADELANTAR estado, no retroceder
const ORDEN_ESTADOS = {
  'bandeja':         0,
  'hacer-diseno':    1,
  'confirmado':      2,
  'enviado-calandra': 3,
  'llego-impresion': 4,
  'corte':           5,
  'costura':         6,
  'calidad':        7,
  'listo':          8,
  'enviado-final':   9,
};

function puedeAvanzar(estadoActual, estadoNuevo) {
  const a = ORDEN_ESTADOS[estadoActual];
  const n = ORDEN_ESTADOS[estadoNuevo];
  if (n === undefined || a === undefined) return false;
  return n > a;
}

// ── Parsear mensaje con Gemini ──────────────────────────────────────
async function parsearMensajeConGemini({ texto, imageBase64 = null, mimeType = null }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: 'no GEMINI_API_KEY' };
  if (!texto && !imageBase64) return { error: 'sin contenido' };

  const prompt = `Analiza este mensaje del grupo WhatsApp "Trabajo en familia" de W&S (empresa colombiana uniformes deportivos).

CONTEXTO: en este grupo el jefe (Camilo) y operarios mandan avances de produccion. Ejemplos tipicos:
- "almany fc cortado"
- "real awaliba listo para entregar"
- "carlos lopez ya esta en costura"
- "[foto del paquete] entregado a la cliente"
- "calandra trajo lo de jardin"

MENSAJE:
"${texto || '(sin texto, solo imagen)'}"

EXTRAE este JSON exacto (sin markdown):
{
  "es_avance_pedido": boolean,           // false si es chat, broma, no relacionado
  "nombre_equipo": string | null,         // ej "Almany FC", "Real Awaliba"
  "estado_detectado": string | null,      // valores: cortado, en-costura, listo, entregado, calandra-llego
  "fuente_texto": string,                 // frase exacta de donde lo sacaste (max 100 chars)
  "confianza": "alta" | "media" | "baja",
  "razon_si_baja": string | null
}

REGLAS:
- "cortado", "ya corté", "corte hecho" → estado_detectado: "cortado"
- "en costura", "cosiendo", "costureros ya tienen" → "en-costura"
- "listo", "terminado", "ready", "lo termine" → "listo"
- "entregado", "ya se entrego", "lo despache" → "entregado"
- "calandra trajo", "ya llego de calandra", "recibi de calandra" → "calandra-llego"
- Si NO hay nombre del equipo claro → confianza: baja
- Si solo es texto generico tipo "buenos dias" → es_avance_pedido: false

Respuesta:`;

  const modelo = process.env.GEMINI_MODEL_TRABAJO || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
  const parts = [{ text: prompt }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } });
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
  };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return { error: `Gemini HTTP ${r.status}` };
    const data = await r.json();
    const t = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = t.replace(/```json\s*|\s*```/g, '').trim();
    try { return JSON.parse(limpio); }
    catch { return { error: 'parse-error', raw: limpio.slice(0, 300) }; }
  } catch (e) {
    return { error: 'exception: ' + e.message };
  }
}

// ── Buscar pedido por nombre del equipo (fuzzy) ─────────────────────
function buscarPedidoPorNombre(pedidos, nombreEquipo) {
  if (!nombreEquipo) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const objetivo = norm(nombreEquipo);
  if (!objetivo || objetivo.length < 3) return null;

  // Solo pedidos activos (no enviado-final, no archivados)
  const activos = pedidos.filter(p => p.estado && p.estado !== 'enviado-final' && p.estado !== 'archivado');

  // 1. Match exacto
  let match = activos.find(p => norm(p.equipo) === objetivo);
  if (match) return match;

  // 2. Match: objetivo contenido en equipo (o viceversa)
  match = activos.find(p => {
    const pn = norm(p.equipo);
    return pn && (pn.includes(objetivo) || objetivo.includes(pn));
  });
  if (match) return match;

  return null;
}

// ── Iterar y reportar (modo prueba) ─────────────────────────────────
async function analizarMensajesTrabajo({ db, limit = 50, diasAtras = 3 } = {}) {
  if (!EVO_KEY) return { error: 'sin EVOLUTION_API_KEY' };
  const msgs = await listarMensajesGrupo(limit);
  if (!msgs.length) return { error: 'sin mensajes', total: 0 };

  const delGrupo = msgs.filter(m => (m.key?.remoteJid || '') === GRUPO_TRABAJO_JID);
  const cutoffTs = Date.now() - (diasAtras * 24 * 60 * 60 * 1000);
  const recientes = delGrupo.filter(m => ((m.messageTimestamp || 0) * 1000) >= cutoffTs);

  const pedidos = db ? db.leerPedidos() : [];
  const reporte = [];

  for (const m of recientes) {
    const texto = extraerTexto(m);
    if (esMensajeDelBot(texto)) {
      reporte.push({ ts: new Date((m.messageTimestamp||0)*1000).toISOString(), accion: 'IGNORADO-bot', preview: texto.slice(0, 80) });
      continue;
    }
    if (!texto || texto.trim().length < 3) continue;

    const gemini = await parsearMensajeConGemini({ texto });
    const estadoNuevo = normalizarEstado(gemini?.estado_detectado);
    const pedido = pedidos.length && gemini?.nombre_equipo ? buscarPedidoPorNombre(pedidos, gemini.nombre_equipo) : null;

    let accion = 'SIN-ACCION';
    if (gemini?.error) accion = 'GEMINI-ERROR';
    else if (!gemini?.es_avance_pedido) accion = 'NO-ES-AVANCE';
    else if (!gemini?.nombre_equipo) accion = 'SIN-NOMBRE-EQUIPO';
    else if (!estadoNuevo) accion = 'ESTADO-NO-RECONOCIDO';
    else if (!pedido) accion = 'NO-MATCH-PEDIDO';
    else if (!puedeAvanzar(pedido.estado, estadoNuevo)) accion = `NO-AVANZA (${pedido.estado} → ${estadoNuevo})`;
    else if (gemini.confianza === 'baja') accion = 'CONFIANZA-BAJA';
    else accion = `AVANZARIA #${pedido.id} ${pedido.estado} → ${estadoNuevo}`;

    reporte.push({
      ts: new Date((m.messageTimestamp||0)*1000).toISOString(),
      pushName: m.pushName,
      fromMe: m.key?.fromMe || false,
      texto: texto.slice(0, 120),
      gemini,
      estadoNuevo,
      pedidoMatch: pedido ? { id: pedido.id, equipo: pedido.equipo, estado: pedido.estado, vendedora: pedido.vendedora } : null,
      accion,
    });
  }

  return {
    grupoJid: GRUPO_TRABAJO_JID,
    total: delGrupo.length,
    enVentana: recientes.length,
    procesables: reporte.length,
    avanzarian: reporte.filter(r => r.accion.startsWith('AVANZARIA')).length,
    detalle: reporte,
  };
}

// ── Procesar y APLICAR avances (modifica pedidos) ───────────────────
async function procesarYAvanzar({ db, notificarWAVendedora = null, notificarJefe = null, notificarTrabajoFamilia = null, diasAtras = 1 } = {}) {
  if (!EVO_KEY) return { error: 'sin EVOLUTION_API_KEY' };
  if (!db || !db.leerPedidos || !db.upsertPedido) return { error: 'db requerido' };

  const state = leerState();
  const cutoffStateTs = state.ultimoTs || 0;
  const cutoffDiasTs = Date.now() - (diasAtras * 24 * 60 * 60 * 1000);
  const cutoffTs = Math.max(cutoffStateTs, cutoffDiasTs);

  const msgs = await listarMensajesGrupo(100);
  const delGrupo = msgs.filter(m => (m.key?.remoteJid || '') === GRUPO_TRABAJO_JID);
  const nuevos = delGrupo.filter(m => ((m.messageTimestamp || 0) * 1000) > cutoffTs);
  if (!nuevos.length) return { procesados: 0, avanzados: 0, cutoff: cutoffTs };

  const pedidos = db.leerPedidos();
  const resultados = { procesados: 0, avanzados: 0, ignorados: 0, sinMatch: 0, errores: 0, detalle: [] };
  let maxTsVisto = cutoffTs;

  for (const m of nuevos) {
    const ts = (m.messageTimestamp || 0) * 1000;
    maxTsVisto = Math.max(maxTsVisto, ts);
    const texto = extraerTexto(m);
    if (esMensajeDelBot(texto)) { resultados.ignorados++; continue; }
    if (!texto || texto.trim().length < 3) { resultados.ignorados++; continue; }

    resultados.procesados++;
    const gemini = await parsearMensajeConGemini({ texto });
    if (gemini?.error) { resultados.errores++; continue; }
    if (!gemini?.es_avance_pedido) { resultados.ignorados++; continue; }
    if (gemini.confianza === 'baja') { resultados.ignorados++; continue; }
    const estadoNuevo = normalizarEstado(gemini.estado_detectado);
    if (!estadoNuevo || !gemini.nombre_equipo) { resultados.ignorados++; continue; }

    const candidato = buscarPedidoPorNombre(pedidos, gemini.nombre_equipo);
    if (!candidato) { resultados.sinMatch++; resultados.detalle.push({ texto: texto.slice(0,80), nombreDetectado: gemini.nombre_equipo, estadoNuevo, accion: 'SIN-MATCH' }); continue; }

    // Releer pedido fresco
    const fresco = db.leerPedidos().find(p => p.id === candidato.id);
    if (!fresco) continue;
    const p = fresco;
    if (!puedeAvanzar(p.estado, estadoNuevo)) {
      resultados.detalle.push({ pedidoId: p.id, equipo: p.equipo, estadoActual: p.estado, estadoNuevo, accion: 'NO-AVANZA' });
      continue;
    }

    // Aplicar avance
    const estadoAntes = p.estado;
    p.estado = estadoNuevo;
    p.ultimoMovimiento = new Date().toISOString();
    p.avanceDeTrabajoFamilia = { de: estadoAntes, a: estadoNuevo, fuente: gemini.fuente_texto, ts: new Date(ts).toISOString() };

    try {
      db.upsertPedido(p);
    } catch (e) {
      resultados.errores++;
      resultados.detalle.push({ pedidoId: p.id, accion: 'ERROR-GUARDAR', error: e.message });
      continue;
    }
    resultados.avanzados++;
    resultados.detalle.push({ pedidoId: p.id, equipo: p.equipo, de: estadoAntes, a: estadoNuevo, accion: 'AVANZADO' });

    // Notificar a la vendedora del pedido
    if (typeof notificarWAVendedora === 'function' && p.vendedora) {
      try {
        await notificarWAVendedora(p.vendedora,
          `📦 *Avance pedido #${p.id}* (${p.equipo})\n` +
          `${estadoAntes} → *${estadoNuevo}*\n` +
          `📌 Detectado en grupo Trabajo en familia: "${gemini.fuente_texto}"`
        );
      } catch (e) { console.error('[trabajo notif vend]', e.message); }
    }
  }

  state.ultimoTs = maxTsVisto;
  guardarState(state);
  return { ...resultados, cutoff: maxTsVisto };
}

module.exports = {
  GRUPO_TRABAJO_JID,
  PATRONES_BOT,
  listarMensajesGrupo,
  extraerTexto,
  esMensajeDelBot,
  normalizarEstado,
  puedeAvanzar,
  parsearMensajeConGemini,
  buscarPedidoPorNombre,
  analizarMensajesTrabajo,
  procesarYAvanzar,
  leerState,
  guardarState,
};
