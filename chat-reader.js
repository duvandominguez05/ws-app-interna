// ═══════════════════════════════════════════════════════════════════
// chat-reader.js — Lector de chats vendedora ↔ cliente con Gemini
//
// Para cada pedido sin nombre real (equipoVieneDeBot=true), lee los
// mensajes recientes del chat de la vendedora con el cliente y le
// pide a Gemini que extraiga el nombre del equipo.
//
// La vendedora pregunta "¿Cómo se llama tu equipo?" y el cliente
// responde — Gemini lee la respuesta y llena el pedido automatico.
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'data', 'chat_reader_state.json');

const EVO_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
const EVO_KEY = process.env.EVOLUTION_API_KEY || process.env.WA_NOTIF_APIKEY || '5DC08B336216-404C-BE94-A95B4A9A0528';

const VENDEDORA_A_INSTANCIA = {
  'Betty':    'ws-ventas',
  'Ney':      'ws-ney',
  'Wendy':    'ws wendy',
  'Paola':    'ws-paola',
  'Graciela': 'ws-ventas', // Graciela tambien usa ws-ventas
  'Camilo':   'ws-duvan',
};

function leerState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ultimaLectura: {} }; }
}
function guardarState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Cache de findChats por instancia (TTL 5 min) ──────────────────
// WhatsApp ahora usa @lid (LinkedID). Evolution guarda el chat con
// remoteJid en formato @lid y el telefono real en lastMessage.key.remoteJidAlt.
// Hay que resolver el @lid antes de pedir mensajes.
const _chatsCache = new Map(); // instance -> { ts, map: { tel -> remoteJid } }
const CHATS_TTL_MS = 5 * 60 * 1000;

async function _cargarMapaChats(instance) {
  const ahora = Date.now();
  const cached = _chatsCache.get(instance);
  if (cached && (ahora - cached.ts) < CHATS_TTL_MS) return cached.map;
  const r = await fetch(`${EVO_URL}/chat/findChats/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
    body: JSON.stringify({ where: {} }),
  });
  if (!r.ok) return new Map();
  const chats = await r.json();
  const arr = Array.isArray(chats) ? chats : (chats?.records || []);
  const map = new Map(); // tel -> remoteJid (@lid o @s.whatsapp.net)
  for (const c of arr) {
    const rj = c?.remoteJid;
    if (!rj) continue;
    // Tel directo en remoteJid (chats viejos @s.whatsapp.net)
    const m1 = String(rj).match(/^(\d{8,15})@s\.whatsapp\.net$/);
    if (m1) { map.set(m1[1], rj); continue; }
    // Tel en lastMessage.remoteJidAlt (chats nuevos @lid)
    const alt = c?.lastMessage?.key?.remoteJidAlt;
    const m2 = String(alt || '').match(/^(\d{8,15})@s\.whatsapp\.net$/);
    if (m2) map.set(m2[1], rj);
  }
  _chatsCache.set(instance, { ts: ahora, map });
  return map;
}

// ── Listar mensajes de UN chat 1:1 con cliente ─────────────────────
async function listarMensajesChat(instance, telefonoCliente, limit = 40) {
  const tel = String(telefonoCliente).replace(/\D/g, '');
  // 1) Resolver remoteJid real (puede ser @lid)
  let remoteJid = `${tel}@s.whatsapp.net`;
  try {
    const mapa = await _cargarMapaChats(instance);
    if (mapa.has(tel)) remoteJid = mapa.get(tel);
  } catch (e) { /* fallback al @s.whatsapp.net */ }
  // 2) Pedir mensajes
  const r = await fetch(`${EVO_URL}/chat/findMessages/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
    body: JSON.stringify({ where: { key: { remoteJid } }, limit }),
  });
  if (!r.ok) {
    throw new Error(`Evolution chat/findMessages ${instance}: ${r.status}`);
  }
  const data = await r.json();
  const all = data.messages?.records || (Array.isArray(data) ? data : []);
  all.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
  return all;
}

// ── Extraer texto util de un mensaje (sync, sin audio) ────────────
function extraerTextoMensaje(m) {
  const msg = m.message || {};
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  return '';
}

// ── Descargar AUDIO base64 desde Evolution ─────────────────────────
async function descargarAudioEvolution(instance, messageKey) {
  try {
    const r = await fetch(`${EVO_URL}/chat/getBase64FromMediaMessage/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body: JSON.stringify({ message: { key: messageKey } }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return { base64: data.base64, mimeType: data.mimetype || 'audio/ogg' };
  } catch { return null; }
}

// ── Transcribir audio con Gemini ───────────────────────────────────
async function transcribirAudioConGemini(base64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: 'no GEMINI_API_KEY' };
  const modelo = process.env.GEMINI_MODEL_AUDIO || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
  const prompt = `Transcribe este audio al espanol (colombiano). Devuelve SOLO el texto transcrito, sin comentarios, sin traducciones, sin agregar nada. Si el audio tiene multiples hablantes, separalos con "—". Si esta vacio o no entiendes, responde literalmente "(audio no transcribible)".`;
  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: base64 } }
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
  };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return { error: `Gemini audio HTTP ${r.status}` };
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { transcripcion: texto.trim() };
  } catch (e) {
    return { error: 'exception: ' + e.message };
  }
}

// ── Construir transcript legible (con audios transcritos via Gemini) ──
// Mensajes audio se transcriben on-demand. Cache evita re-transcribir.
async function construirTranscript(mensajes, opciones = {}) {
  const { instance, maxMensajes = 30, cache = {}, maxAudiosPorChat = 8 } = opciones;
  const ordenados = [...mensajes].sort((a, b) => (a.messageTimestamp||0) - (b.messageTimestamp||0));
  const ultimos = ordenados.slice(-maxMensajes);
  const lineas = [];
  let audiosTranscritos = 0;
  for (const m of ultimos) {
    const msg = m.message || {};
    const quien = m.key?.fromMe ? 'Vendedora' : 'Cliente';
    const msgId = m.key?.id;

    // 1. Texto directo
    let texto = extraerTextoMensaje(m);

    // 2. Audio (transcribir si no esta en cache y tenemos instance)
    if (!texto && msg.audioMessage && instance) {
      if (cache[msgId]) {
        texto = `[audio]: ${cache[msgId]}`;
      } else if (audiosTranscritos < maxAudiosPorChat) {
        const audio = await descargarAudioEvolution(instance, m.key);
        if (audio?.base64) {
          const tr = await transcribirAudioConGemini(audio.base64, audio.mimeType);
          if (tr.transcripcion && tr.transcripcion !== '(audio no transcribible)') {
            cache[msgId] = tr.transcripcion;
            texto = `[audio]: ${tr.transcripcion}`;
            audiosTranscritos++;
          }
        }
      }
    }

    if (texto && texto.trim()) {
      lineas.push(`${quien}: ${texto.trim().slice(0, 400)}`);
    }
  }
  return { transcript: lineas.join('\n'), audiosTranscritos };
}

// ── Llamar Gemini para extraer nombre del equipo ───────────────────
async function extraerNombreConGemini({ transcript, vendedora, telefonoCliente }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: 'no GEMINI_API_KEY' };
  if (!transcript || transcript.length < 10) return { confianza: 'baja', razon: 'transcript muy corto' };

  const prompt = `Analiza esta conversacion entre la vendedora "${vendedora}" y el cliente (telefono ${telefonoCliente}) de una empresa colombiana de uniformes deportivos (W&S).

OBJETIVO: extraer el NOMBRE DEL EQUIPO para el cual el cliente quiere uniformes.

CONVERSACION:
"""
${transcript}
"""

Busca menciones tipo:
- "es para [NOMBRE]"
- "mi equipo se llama [NOMBRE]"
- "uniformes para [NOMBRE]"
- "el equipo es [NOMBRE]"
- "se llama [NOMBRE]"
- "ALMANY FC", "REAL MADRID", "CLUB X"
- O cuando la vendedora pregunta "como se llama tu equipo" y el cliente responde

Tambien extrae si puedes:
- Cantidad de uniformes
- Tipo de prenda (camisetas, pantalonetas, conjuntos)
- Color
- Fecha entrega

Responde SOLO con este JSON (sin markdown):
{
  "nombre_equipo": string | null,
  "fuente_texto": string,        // la frase exacta de donde lo sacaste (max 100 chars)
  "es_quien_lo_dijo": "cliente" | "vendedora" | null,
  "confianza": "alta" | "media" | "baja",
  "cantidad_uniformes": number | null,
  "tipo_prenda": string | null,
  "color": string | null,
  "fecha_entrega_texto": string | null,
  "razon_si_baja": string | null   // si confianza baja, por que
}

REGLAS:
- Si el CLIENTE confirma el nombre → confianza alta
- Si solo la vendedora lo dice (sin confirmacion cliente) → confianza media
- Si no hay mencion clara → nombre_equipo: null, confianza: baja
- No inventes. Si dudas, devuelve null.`;

  const modelo = process.env.GEMINI_MODEL_CHATS || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `Gemini HTTP ${r.status}` };
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try { return JSON.parse(limpio); }
    catch { return { error: 'parse-error', raw: limpio.slice(0, 300) }; }
  } catch (e) {
    return { error: 'exception: ' + e.message };
  }
}

// ── ANALIZAR (modo prueba — NO modifica pedidos) ───────────────────
async function analizarChatsPedidosSinNombre({ db, limitePedidos = 20, soloId = null, limitMensajes = 40, maxAudiosPorChat = 8 } = {}) {
  if (!db || !db.leerPedidos) return { error: 'db requerido' };

  const pedidos = db.leerPedidos();
  // Filtrar pedidos sin nombre real (equipoVieneDeBot=true) y no amarrados
  let elegibles = pedidos.filter(p => {
    if (p.equipoAmarradoDeGrupo) return false;
    if (p.nombreDiseno) return false;
    if (!p.equipoVieneDeBot && p.equipo && !/^cliente\s+\+?\d/i.test(p.equipo)) return false;
    if (!p.telefono) return false;
    if (!p.vendedora) return false;
    return !['enviado-final', 'archivado', 'cancelado', 'entregado'].includes(p.estado);
  });
  if (soloId) elegibles = elegibles.filter(p => p.id === parseInt(soloId, 10));
  elegibles = elegibles.slice(0, limitePedidos);

  // Cache de transcripciones persistente en state
  const state = leerState();
  state.transcripcionesCache = state.transcripcionesCache || {};

  const reporte = [];
  for (const p of elegibles) {
    const instance = VENDEDORA_A_INSTANCIA[p.vendedora];
    if (!instance) {
      reporte.push({ id: p.id, vendedora: p.vendedora, error: 'instancia no mapeada' });
      continue;
    }
    let mensajes;
    try {
      mensajes = await listarMensajesChat(instance, p.telefono, limitMensajes);
    } catch (e) {
      reporte.push({ id: p.id, vendedora: p.vendedora, telefono: p.telefono, error: e.message });
      continue;
    }
    const r = await construirTranscript(mensajes, {
      instance,
      cache: state.transcripcionesCache,
      maxAudiosPorChat,
    });
    const transcript = r.transcript;
    if (!transcript) {
      reporte.push({ id: p.id, vendedora: p.vendedora, telefono: p.telefono, numMensajes: mensajes.length, audiosTranscritos: r.audiosTranscritos, error: 'sin texto util ni audios' });
      continue;
    }
    const gemini = await extraerNombreConGemini({
      transcript,
      vendedora: p.vendedora,
      telefonoCliente: p.telefono,
    });
    reporte.push({
      id: p.id,
      vendedora: p.vendedora,
      telefono: p.telefono,
      equipoActual: p.equipo,
      numMensajes: mensajes.length,
      audiosTranscritos: r.audiosTranscritos,
      transcriptPreview: transcript.slice(0, 500),
      gemini,
    });
  }

  // Guardar cache de transcripciones (evita re-transcribir el mismo audio)
  guardarState(state);

  return { totalElegibles: elegibles.length, detalle: reporte };
}

// ── PROCESAR Y AMARRAR (modifica pedidos) — para cron/endpoint ─────
async function procesarYAmarrarChats({ db, notificarWAVendedora = null, notificarJefe = null, limitePedidos = 20, soloId = null } = {}) {
  if (!db || !db.leerPedidos || !db.upsertPedido) return { error: 'db requerido' };

  const r = await analizarChatsPedidosSinNombre({ db, limitePedidos, soloId });
  if (!r.detalle) return r;

  const state = leerState();
  state.ultimaLectura = state.ultimaLectura || {};

  const resultados = { procesados: 0, amarrados: 0, sinNombre: 0, errores: 0, ambiguos: 0, detalle: [] };

  for (const item of r.detalle) {
    resultados.procesados++;
    if (item.error) { resultados.errores++; resultados.detalle.push({ id: item.id, accion: 'ERROR', error: item.error }); continue; }
    const g = item.gemini;
    if (!g || g.error) { resultados.errores++; resultados.detalle.push({ id: item.id, accion: 'GEMINI-ERROR', error: g?.error }); continue; }

    if (!g.nombre_equipo) {
      resultados.sinNombre++;
      resultados.detalle.push({ id: item.id, accion: 'SIN-NOMBRE-EN-CHAT', razon: g.razon_si_baja || g.confianza });
      continue;
    }
    if (g.confianza === 'baja') {
      resultados.ambiguos++;
      resultados.detalle.push({ id: item.id, accion: 'CONFIANZA-BAJA', nombre: g.nombre_equipo, razon: g.razon_si_baja });
      continue;
    }

    // Aplicar amarre
    const fresco = db.leerPedidos().find(x => x.id === item.id);
    if (!fresco) continue;
    const p = fresco;
    if (p.equipoAmarradoDeGrupo) {
      resultados.detalle.push({ id: p.id, accion: 'YA-AMARRADO', equipo: p.equipo });
      continue;
    }

    const nombreNuevo = String(g.nombre_equipo).trim();
    p.nombreDiseno = nombreNuevo;
    const equipoEsPlaceholder = p.equipoVieneDeBot || !p.equipo || /^cliente\s+\+?\d/i.test(p.equipo);
    if (equipoEsPlaceholder) {
      p.equipo = nombreNuevo;
      p.equipoVieneDeBot = false;
    }
    p.equipoAmarradoDeGrupo = true;
    p.amarradoDeGrupoFuente = 'chat-cliente';
    p.amarradoDeGrupoIso = new Date().toISOString();
    if (g.cantidad_uniformes) p.numUniformes = g.cantidad_uniformes;
    if (g.tipo_prenda) p.tipoPrenda = g.tipo_prenda;
    if (g.color) p.color = g.color;
    if (g.fecha_entrega_texto && !p.fechaEntrega) p.fechaEntregaTexto = g.fecha_entrega_texto;
    if (p.estado === 'bandeja' || p.estado === 'hacer-diseno') p.estado = 'confirmado';
    p.ultimoMovimiento = new Date().toISOString();

    try {
      db.upsertPedido(p);
    } catch (e) {
      resultados.errores++;
      resultados.detalle.push({ id: p.id, accion: 'ERROR-GUARDAR', error: e.message });
      continue;
    }

    resultados.amarrados++;
    resultados.detalle.push({
      id: p.id, accion: 'AMARRADO',
      equipo: nombreNuevo, vendedora: p.vendedora, telefono: p.telefono,
      fuente: g.fuente_texto, confianza: g.confianza,
    });

    // WA a la vendedora confirmando + instrucciones para el flujo
    if (typeof notificarWAVendedora === 'function') {
      try {
        const msg =
          `✅ *NOMBRE IDENTIFICADO*\n\n` +
          `📋 Pedido #${p.id}\n` +
          `📞 Cliente: ${p.telefono}\n` +
          `🏷️ Equipo: *${nombreNuevo}*\n` +
          `📌 Fuente: chat con el cliente (Gemini lo leyó)\n\n` +
          `👉 *A partir de ahora cuando trabajes este pedido:*\n` +
          `• Guarda el .cdr en Drive corel con nombre *${nombreNuevo}*\n` +
          `• PDF rip con nombre *${nombreNuevo}*\n` +
          `• WeTransfer a calandra mencionando *${nombreNuevo}*\n` +
          `→ Yo conecto todo el flujo solo.\n\n` +
          `❓ Si está mal, responde: *no ${p.id} [nombre correcto]*`;
        await notificarWAVendedora(p.vendedora, msg);
      } catch (e) { console.error('[chat-reader notif vend]', e.message); }
    }
  }

  guardarState(state);
  return resultados;
}

module.exports = {
  VENDEDORA_A_INSTANCIA,
  listarMensajesChat,
  extraerTextoMensaje,
  construirTranscript,
  extraerNombreConGemini,
  analizarChatsPedidosSinNombre,
  procesarYAmarrarChats,
  leerState,
  guardarState,
};
