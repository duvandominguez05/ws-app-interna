// ═══════════════════════════════════════════════════════════════════
// grupo-ventas-watcher.js — Watcher del grupo WhatsApp
// "Ventas Ney, Wendy y Paola" (JID 120363405287390514@g.us)
//
// Lee mensajes nuevos cada 2 min (cron). Por cada FOTO con caption +
// los textos siguientes del mismo sender en ventana de 10 min:
//   - Gemini parsea: nombre_equipo, fecha_entrega, num_uniformes,
//     tipo_prenda, lista_jugadores
//   - Asocia al pedido `confirmado` mas reciente del sender (vendedora)
//   - Guarda foto referencia + nombre + fecha + items en el pedido
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const GRUPO_VENTAS_JID = '120363405287390514@g.us';
const STATE_FILE = path.join(__dirname, 'data', 'grupo_ventas_state.json');
const VENTANA_LISTADO_MS = 10 * 60 * 1000; // 10 min para agrupar listado

const EVO_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
// Prioridad: EVOLUTION_API_KEY (la que lee grupos) > WA_NOTIF_APIKEY (la que envia) > hardcoded fallback
const EVO_KEY = process.env.EVOLUTION_API_KEY || process.env.WA_NOTIF_APIKEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
const EVO_INSTANCE = process.env.WA_INSTANCE_VENTAS_GRUPO || 'ws-ventas';

function leerState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ultimoTs: 0, amarrados: {} }; }
}
function guardarState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Mapeo pushName → vendedora ────────────────────────────────────
// Si no se identifica, devuelve null (cae a "sin amarrar")
// NOTA: para fromMe usar identificarSender({pushName, fromMe}) en su lugar
function pushNameAVendedora(pushName) {
  if (!pushName) return null;
  const n = String(pushName).toLowerCase();
  if (n.includes('paola')) return 'Paola';
  if (n.includes('wendy')) return 'Wendy';
  if (n.includes('ney'))   return 'Ney';
  if (n.includes('betty')) return 'Betty';
  if (n.includes('graciela')) return 'Graciela';
  if (n.includes('camilo'))   return 'Camilo';
  // Cuenta empresarial generica → jefe/admin
  if (n.includes('w.y.s') || n.includes('wys') || n.includes('uniformes deportivos')) return '_empresa';
  return null;
}

// Identificacion segura del sender. Si fromMe=true → siempre _empresa
// (mensaje enviado desde nuestro WA, sin importar pushName).
function identificarSender({ pushName, fromMe }) {
  if (fromMe) return '_empresa';
  return pushNameAVendedora(pushName);
}

// ── Listar mensajes del grupo via Evolution ──────────────────────
// Evolution no garantiza orden. Pedimos lote grande, ordenamos desc por ts
// y tomamos los N mas recientes.
async function listarMensajesGrupo(limit = 50) {
  // Pedir lote grande para asegurar tener los mas recientes
  const requestLimit = Math.max(200, limit * 4);
  const r = await fetch(`${EVO_URL}/chat/findMessages/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
    body: JSON.stringify({ where: { key: { remoteJid: GRUPO_VENTAS_JID } }, limit: requestLimit }),
  });
  if (!r.ok) {
    throw new Error(`Evolution chat/findMessages: ${r.status} ${await r.text().catch(()=>'')}`);
  }
  const data = await r.json();
  const all = data.messages?.records || (Array.isArray(data) ? data : []);
  // Ordenar desc por timestamp y devolver los mas recientes
  all.sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
  return all.slice(0, limit);
}

// ── Extraer texto/caption/tipo de un mensaje WhatsApp ────────────
function extraerContenido(m) {
  const msg = m.message || {};
  if (msg.conversation) return { tipo: 'texto', texto: msg.conversation };
  if (msg.extendedTextMessage?.text) return { tipo: 'texto', texto: msg.extendedTextMessage.text };
  if (msg.imageMessage) return { tipo: 'imagen', caption: msg.imageMessage.caption || '' };
  if (msg.videoMessage) return { tipo: 'video', caption: msg.videoMessage.caption || '' };
  if (msg.documentMessage) return { tipo: 'documento', nombre: msg.documentMessage.fileName || '' };
  if (msg.albumMessage) return { tipo: 'album' };
  return { tipo: 'otro' };
}

// ── Agrupar mensajes por sender + ventana de 10 min ──────────────
// Cada grupo representa probablemente UN pedido.
// Si fromMe=true, el sender es "_FROMME_" (nosotros enviando desde la instancia).
function agruparPorSenderYVentana(mensajes) {
  const ordenados = [...mensajes].sort((a, b) => (a.messageTimestamp||0) - (b.messageTimestamp||0));
  const grupos = [];
  let actual = null;
  for (const m of ordenados) {
    const ts = (m.messageTimestamp || 0) * 1000;
    const fromMe = m.key?.fromMe === true;
    const sender = fromMe ? '_FROMME_' : (m.key?.participant || m.pushName || 'desconocido');
    if (!actual || actual.sender !== sender || (ts - actual.ultimoTs) > VENTANA_LISTADO_MS) {
      actual = { sender, pushName: m.pushName || '', fromMe, primerTs: ts, ultimoTs: ts, mensajes: [] };
      grupos.push(actual);
    }
    actual.ultimoTs = ts;
    actual.mensajes.push(m);
  }
  return grupos;
}

// ── Llamar Gemini para parsear un grupo de mensajes ──────────────
// Input: caption de la primera foto + textos de listado
// Output: { nombre_equipo, fecha_entrega, num_uniformes, tipo_prenda, lista_jugadores }
async function parsearGrupoConGemini({ caption, listadoTexto, imageBase64, mimeType }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: 'no GEMINI_API_KEY' };

  const prompt = `Analiza estos mensajes del grupo WhatsApp "Ventas Ney, Wendy y Paola" de una empresa colombiana de uniformes deportivos (W&S).

CONTEXTO: las vendedoras suben foto del diseno aprobado por el cliente + caption corto (a veces solo el nombre del equipo, a veces solo la fecha o solo cantidad). Despues mandan listado de jugadores uno por mensaje.

ENTRADA:

CAPTION DE LA FOTO PRINCIPAL:
"${caption || '(sin caption)'}"

MENSAJES DE TEXTO ASOCIADOS (listado de jugadores, fecha, etc):
"""
${listadoTexto || '(sin texto)'}
"""

EXTRAE este JSON exacto (sin markdown, solo JSON valido):
{
  "esPedidoUniforme": boolean,         // false si es chat informal/meme/no relacionado
  "nombre_equipo": string | null,      // nombre del equipo o team (ej "almany fc"). null si no se puede extraer
  "fecha_entrega": string | null,      // formato YYYY-MM-DD si se infiere (asume ano actual ${new Date().getFullYear()})
  "fecha_entrega_texto": string | null, // texto original (ej "6 de junio", "para hoy")
  "num_uniformes": number | null,      // cantidad de prendas (ej 24)
  "tipo_prenda": string | null,        // "camisetas", "chaquetas", "uniformes" (camiseta+pantaloneta+medias), "conjuntos", etc
  "lista_jugadores": [                 // listado parseado si hay
    {"nombre": "...", "talla": "...", "numero": "..."}
  ],
  "confianza": "alta" | "media" | "baja",
  "notas": string | null               // cualquier info extra util
}

REGLAS:
- Si caption tiene "almany fc para el 6 de junio" → nombre_equipo="almany fc", fecha_entrega_texto="6 de junio"
- Si caption tiene "24 uniformes para el 6 de junio" → num_uniformes=24, sin nombre_equipo (confianza baja)
- Si caption tiene "para hoy 6 chaquetas" → tipo_prenda="chaquetas", num_uniformes=6, fecha_entrega_texto="hoy"
- Lista jugadores: cada entrada con "Nombre: X / Talla: Y / Numero: Z" o variaciones
- Si NO es un pedido (chat, meme, info random) → esPedidoUniforme: false, todo lo demas null

Respuesta:`;

  const modelo = process.env.GEMINI_MODEL_VENTAS || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } });
  }
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
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

// ── Es nombre de equipo "vacio" o "generico" (no nombrado por humano)? ──
// Pedidos auto-creados por sticker/comprobante tienen equipo="Cliente 31234567"
// o vacio. Esos SI son candidatos para amarrar nombre real del grupo.
function equipoEsGenericoOVacio(equipo) {
  if (!equipo) return true;
  const e = String(equipo).trim();
  if (!e) return true;
  // Patron "Cliente 3104567890" auto-creado por bot
  if (/^cliente\s+\d{7,}/i.test(e)) return true;
  if (/^cliente\s+\+\s*\d/i.test(e)) return true;
  return false;
}

// ── Encontrar pedido del sender (vendedora) al cual amarrar ──────
// Estrategia: pedido con estado confirmado/hacer-diseno/bandeja
// mas reciente que NO tenga aun nombre real (solo placeholder).
function encontrarPedidoParaAmarrar(pedidos, vendedora) {
  const ESTADOS_CANDIDATOS = new Set(['bandeja', 'hacer-diseno', 'confirmado']);
  const candidatos = pedidos.filter(p => {
    if (!ESTADOS_CANDIDATOS.has(p.estado)) return false;
    if (vendedora === '_empresa') {
      // Sin vendedora especifica: cualquiera, pero solo si equipo es generico/vacio
    } else if (vendedora && p.vendedora !== vendedora) {
      return false;
    }
    if (p.equipoAmarradoDeGrupo) return false; // ya tiene amarre previo del watcher
    if (!equipoEsGenericoOVacio(p.equipo)) return false; // ya tiene nombre real
    return true;
  });
  candidatos.sort((a, b) => {
    const ta = new Date(a.ultimoMovimiento || 0).getTime();
    const tb = new Date(b.ultimoMovimiento || 0).getTime();
    return tb - ta;
  });
  return candidatos[0] || null;
}

// ── Descargar imagen base64 desde Evolution (replicado de server.js) ──
async function descargarImagenEvolution(messageKey) {
  try {
    const r = await fetch(`${EVO_URL}/chat/getBase64FromMediaMessage/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body: JSON.stringify({ message: { key: messageKey } }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return { base64: data.base64, mimeType: data.mimetype || 'image/jpeg' };
  } catch { return null; }
}

// ── Analizar mensajes (SIN amarrar nada) — para endpoint prueba ──
// Filtra a los ultimos N dias, descarga foto principal, pasa a Gemini.
async function analizarMensajesGrupo({ limit = 50, pedidos = [], diasAtras = 7, conImagen = true } = {}) {
  if (!EVO_KEY) return { error: 'sin EVOLUTION_API_KEY' };
  const msgs = await listarMensajesGrupo(limit);
  if (!msgs.length) return { error: 'sin mensajes', total: 0 };

  // Filtrar solo del grupo (defensivo)
  const delGrupo = msgs.filter(m => (m.key?.remoteJid || '') === GRUPO_VENTAS_JID);

  // Filtrar a los ultimos N dias para no procesar historico viejo
  const cutoffTs = Date.now() - (diasAtras * 24 * 60 * 60 * 1000);
  const recientes = delGrupo.filter(m => ((m.messageTimestamp || 0) * 1000) >= cutoffTs);

  const grupos = agruparPorSenderYVentana(recientes);

  const reporte = [];
  for (const g of grupos) {
    const fotos = g.mensajes.filter(m => extraerContenido(m).tipo === 'imagen');
    const textos = g.mensajes
      .map(m => extraerContenido(m))
      .filter(c => c.tipo === 'texto')
      .map(c => c.texto)
      .join('\n');
    const fotoPrincipal = fotos[0] || null;
    const captionPrincipal = fotoPrincipal ? (extraerContenido(fotoPrincipal).caption || '') : '';

    if (!fotos.length && !textos.trim()) continue; // grupo sin contenido util

    // Descargar foto principal si hay (clave para extraer nombre del escudo)
    let imageBase64 = null, mimeType = null;
    if (conImagen && fotoPrincipal) {
      const img = await descargarImagenEvolution(fotoPrincipal.key);
      if (img) { imageBase64 = img.base64; mimeType = img.mimeType; }
    }

    const parseo = await parsearGrupoConGemini({
      caption: captionPrincipal,
      listadoTexto: textos,
      imageBase64,
      mimeType,
    });

    // Identificar sender: si fromMe → _empresa, sino pushName mapping
    const vendedora = identificarSender({ pushName: g.pushName, fromMe: g.fromMe });
    const pedidoCandidato = vendedora && pedidos.length
      ? encontrarPedidoParaAmarrar(pedidos, vendedora)
      : null;

    reporte.push({
      sender: g.pushName + (g.fromMe ? ' [FROM ME]' : ''),
      vendedoraDetectada: vendedora,
      desde: new Date(g.primerTs).toISOString(),
      hasta: new Date(g.ultimoTs).toISOString(),
      numFotos: fotos.length,
      conFotoAnalizada: !!imageBase64,
      captionPrincipal: captionPrincipal.slice(0, 100),
      textoListado: textos.slice(0, 200),
      parseo,
      pedidoCandidato: pedidoCandidato
        ? { id: pedidoCandidato.id, vendedora: pedidoCandidato.vendedora, estado: pedidoCandidato.estado, equipoActual: pedidoCandidato.equipo || '(sin nombre)' }
        : null,
      accionSiAmarra: pedidoCandidato && parseo?.nombre_equipo
        ? `AMARRARIA pedido #${pedidoCandidato.id} (${pedidoCandidato.vendedora}) con equipo="${parseo.nombre_equipo}"`
        : parseo?.nombre_equipo
          ? 'SIN PEDIDO para amarrar (' + (vendedora || 'sender no mapeado') + ')'
          : 'NO se pudo extraer nombre del equipo',
    });
  }

  return {
    grupoJid: GRUPO_VENTAS_JID,
    diasAtrasFiltro: diasAtras,
    totalMensajes: delGrupo.length,
    mensajesEnVentana: recientes.length,
    gruposDetectados: reporte.length,
    detalle: reporte,
  };
}

module.exports = {
  GRUPO_VENTAS_JID,
  listarMensajesGrupo,
  agruparPorSenderYVentana,
  extraerContenido,
  pushNameAVendedora,
  identificarSender,
  parsearGrupoConGemini,
  encontrarPedidoParaAmarrar,
  analizarMensajesGrupo,
  descargarImagenEvolution,
  leerState,
  guardarState,
};
