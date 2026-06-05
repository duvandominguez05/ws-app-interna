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
const crypto = require('crypto');

const GRUPO_VENTAS_JID = '120363405287390514@g.us';
const STATE_FILE = path.join(__dirname, 'data', 'grupo_ventas_state.json');
const VENTANA_LISTADO_MS = 10 * 60 * 1000; // 10 min para agrupar listado

// Contacto Lidermeyer (reporta arreglos en el grupo, NO ventas nuevas)
const TELEFONO_ARREGLOS = process.env.TELEFONO_ARREGLOS_GRUPO_VENTAS || '573107601285';

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

  const tieneImagen = !!imageBase64;
  const prompt = `Analiza estos mensajes del grupo WhatsApp "Ventas Ney, Wendy y Paola" de una empresa colombiana de uniformes deportivos (W&S).

CONTEXTO: las vendedoras suben FOTO del diseno aprobado por el cliente (camiseta/uniforme con escudo, logo y texto del equipo) + caption corto. Despues mandan listado de jugadores uno por mensaje.

${tieneImagen ? `INSTRUCCION CRITICA: TIENES UNA IMAGEN DEL DISENO. **OBSERVA CON ATENCION** el escudo, logo, texto, letras impresas en la camiseta. El NOMBRE DEL EQUIPO casi siempre aparece en la camiseta como texto del escudo o logo (ej "ALMANY FC", "INVICTOS DE FE", "AMERICA DE CALI"). LEE ese texto y devuelvelo en nombre_equipo. Si la imagen tiene multiples paneles (frente y espalda), revisa ambos.` : 'NO HAY IMAGEN — solo extrae del texto.'}

CAPTION DE LA FOTO PRINCIPAL:
"${caption || '(sin caption)'}"

MENSAJES DE TEXTO ASOCIADOS (listado de jugadores, fecha, etc):
"""
${listadoTexto || '(sin texto)'}
"""

EXTRAE este JSON exacto (sin markdown, solo JSON valido):
{
  "esPedidoUniforme": boolean,         // false si es chat informal/meme/no relacionado
  "nombre_equipo": string | null,      // PRIORIDAD 1: leer del escudo/logo de la imagen. PRIORIDAD 2: del caption (ej "almany fc"). null si imposible.
  "fecha_entrega": string | null,      // formato YYYY-MM-DD si se infiere (asume ano actual ${new Date().getFullYear()})
  "fecha_entrega_texto": string | null, // texto original (ej "6 de junio", "para hoy")
  "num_uniformes": number | null,      // cantidad de prendas (ej 24)
  "tipo_prenda": string | null,        // "camisetas", "chaquetas", "uniformes" (camiseta+pantaloneta+medias), "conjuntos", etc
  "lista_jugadores": [                 // listado parseado si hay
    {"nombre": "...", "talla": "...", "numero": "..."}
  ],
  "confianza": "alta" | "media" | "baja",
  "fuente_nombre_equipo": "imagen-escudo" | "imagen-texto" | "caption" | "ninguno", // de donde sacaste el nombre
  "notas": string | null               // cualquier info extra util
}

REGLAS:
- Si imagen muestra escudo "ALMANY FC" → nombre_equipo="Almany FC", fuente_nombre_equipo="imagen-escudo", confianza alta
- Si caption tiene "almany fc para el 6 de junio" → nombre_equipo="almany fc", fuente_nombre_equipo="caption"
- Si caption tiene "24 uniformes para el 6 de junio" Y la imagen tiene escudo → usa escudo de la imagen
- Si caption es texto generico (ej "Nico/ #9/ Talla 8" — eso es un JUGADOR) y la imagen tiene escudo → usa imagen
- Lista jugadores: cada entrada con "Nombre: X / Talla: Y / Numero: Z" o variaciones
- Si NO es un pedido (chat, meme, info random) → esPedidoUniforme: false

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

// ── ¿El pedido es candidato para amarre del watcher? ──
// Reemplazable si:
//   - equipo es vacio/generico, O
//   - equipoVieneDeBot=true (el bot puso pushName del cliente, no nombre real)
// NO reemplazable si:
//   - ya tiene equipoAmarradoDeGrupo=true (otro amarre previo)
function pedidoEsAmarrable(p) {
  if (p.equipoAmarradoDeGrupo) return false;
  if (equipoEsGenericoOVacio(p.equipo)) return true;
  if (p.equipoVieneDeBot) return true; // pushName del cliente, no nombre real
  return false;
}

// ── Encontrar pedido del sender (vendedora) al cual amarrar ──────
// Estrategia: pedido con estado confirmado/hacer-diseno/bandeja
// mas reciente que NO tenga aun nombre real (solo placeholder).
function encontrarPedidoParaAmarrar(pedidos, vendedora) {
  const ESTADOS_CANDIDATOS = new Set(['bandeja', 'hacer-diseno', 'confirmado']);
  const candidatos = pedidos.filter(p => {
    if (!ESTADOS_CANDIDATOS.has(p.estado)) return false;
    // Para '_empresa' (mensaje generico fromMe sin vendedora identificable):
    // NO amarrar automaticamente — alto riesgo de pisar el pedido equivocado.
    // Solo amarrar si la vendedora es identificable.
    if (vendedora === '_empresa') return false;
    if (vendedora && p.vendedora !== vendedora) return false;
    return pedidoEsAmarrable(p);
  });
  // Politica conservadora: solo amarrar si hay UN solo candidato
  // (si hay 2+, esperar hash match o mas data — evita pisar pedidos)
  if (candidatos.length === 1) return candidatos[0];
  return null;
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

// ── SHA256 de una imagen base64 ────────────────────────────────────
function hashearBase64(base64) {
  try {
    const buf = Buffer.from(base64, 'base64');
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

// ── Identificar cliente por HASH ───────────────────────────────────
// Cruza el SHA256 de la foto del grupo con documentos_salientes_wa
// para encontrar el cliente al que la vendedora le envio LA MISMA foto.
function identificarClientePorHash(db, hash) {
  if (!hash || !db?.leerDocumentosSalientesPorHash) return null;
  const matches = db.leerDocumentosSalientesPorHash(hash) || [];
  if (!matches.length) return null;
  const m = matches[0]; // mas reciente (la query ya ordena DESC)
  return {
    telefono: m.cliente_telefono,
    vendedora: m.vendedora,
    docSalienteId: m.id,
    fechaCaptura: m.fecha_captura,
  };
}

// ── Encontrar pedido activo de un cliente (por telefono) ───────────
function encontrarPedidoActivoCliente(pedidos, telefonoCliente) {
  const ESTADOS_CANDIDATOS = new Set([
    'bandeja', 'hacer-diseno', 'confirmado',
    'enviado-calandra', 'llego-impresion', 'corte', 'costura'
  ]);
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

// ── Detectar si el sender es contacto de arreglos (Lider Meyer / Lidemeyer) ──
function senderEsArreglos(participantJid, pushName) {
  const tel = String(participantJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
  if (tel && tel === TELEFONO_ARREGLOS) return true;
  const n = String(pushName || '').toLowerCase();
  // Variantes ortograficas comunes
  if (n.includes('lidermeyer')) return true;
  if (n.includes('lidemeyer')) return true; // observado en logs sin la R
  if (n.includes('lider meyer')) return true;
  if (n.includes('lidermeyer')) return true;
  return false;
}

// ── Construir reporte de UN grupo de mensajes (con hash matching) ──
// Compartido entre analizarMensajesGrupo (prueba) y procesarYAmarrar (real).
// Devuelve null si el grupo no tiene contenido util.
async function _construirReporteGrupo(g, { db, pedidos, conImagen }) {
  const fotos = g.mensajes.filter(m => extraerContenido(m).tipo === 'imagen');
  const textos = g.mensajes
    .map(m => extraerContenido(m))
    .filter(c => c.tipo === 'texto')
    .map(c => c.texto)
    .join('\n');
  const fotoPrincipal = fotos[0] || null;
  const captionPrincipal = fotoPrincipal ? (extraerContenido(fotoPrincipal).caption || '') : '';

  if (!fotos.length && !textos.trim()) return null;

  // Descargar foto principal + calcular hash
  let imageBase64 = null, mimeType = null, fotoHash = null;
  if (conImagen && fotoPrincipal) {
    const img = await descargarImagenEvolution(fotoPrincipal.key);
    if (img) {
      imageBase64 = img.base64;
      mimeType = img.mimeType;
      fotoHash = hashearBase64(img.base64);
    }
  }

  // ── 1. Identificar cliente por HASH (prioritario) ──
  // Si la misma foto fue enviada a un cliente por WA, ya sabemos el dueño.
  let clientePorHash = null;
  if (fotoHash && db) {
    clientePorHash = identificarClientePorHash(db, fotoHash);
  }

  // ── 2. Identificar sender (vendedora que postea) ──
  const participantJid = g.mensajes[0]?.key?.participant || g.mensajes[0]?.participant || '';
  const esArreglo = senderEsArreglos(participantJid, g.pushName);
  const vendedora = identificarSender({ pushName: g.pushName, fromMe: g.fromMe });

  // ── 3. Llamar Gemini para extraer nombre/fecha/lista ──
  const parseo = await parsearGrupoConGemini({
    caption: captionPrincipal,
    listadoTexto: textos,
    imageBase64,
    mimeType,
  });

  // ── 4. Decidir pedido candidato ──
  // Prioridad: 1) cliente por hash 2) sender vendedora con pedido generico
  let pedidoCandidato = null;
  let metodoIdentificacion = null;
  if (clientePorHash && pedidos.length) {
    pedidoCandidato = encontrarPedidoActivoCliente(pedidos, clientePorHash.telefono);
    if (pedidoCandidato) metodoIdentificacion = 'hash-foto';
  }
  if (!pedidoCandidato && vendedora && pedidos.length) {
    pedidoCandidato = encontrarPedidoParaAmarrar(pedidos, vendedora);
    if (pedidoCandidato) metodoIdentificacion = 'sender-vendedora';
  }

  let accion;
  if (esArreglo) {
    accion = 'ARREGLO detectado (sender Lidermeyer) — NO crea/amarra pedido';
  } else if (pedidoCandidato && parseo?.nombre_equipo) {
    accion = `AMARRARIA pedido #${pedidoCandidato.id} (${pedidoCandidato.vendedora}) con equipo="${parseo.nombre_equipo}" (metodo: ${metodoIdentificacion})`;
  } else if (clientePorHash && !pedidoCandidato) {
    accion = `Cliente identificado por hash (${clientePorHash.telefono}) pero sin pedido activo`;
  } else if (parseo?.nombre_equipo) {
    accion = 'SIN PEDIDO para amarrar (' + (vendedora || 'sender no mapeado') + ')';
  } else {
    accion = 'NO se pudo extraer nombre del equipo';
  }

  return {
    sender: g.pushName + (g.fromMe ? ' [FROM ME]' : ''),
    vendedoraDetectada: vendedora,
    esArreglo,
    desde: new Date(g.primerTs).toISOString(),
    hasta: new Date(g.ultimoTs).toISOString(),
    numFotos: fotos.length,
    conFotoAnalizada: !!imageBase64,
    fotoHash: fotoHash ? fotoHash.slice(0, 16) + '...' : null,
    clientePorHash,
    metodoIdentificacion,
    captionPrincipal: captionPrincipal.slice(0, 100),
    textoListado: textos.slice(0, 200),
    parseo,
    pedidoCandidato: pedidoCandidato
      ? { id: pedidoCandidato.id, vendedora: pedidoCandidato.vendedora, telefono: pedidoCandidato.telefono, estado: pedidoCandidato.estado, equipoActual: pedidoCandidato.equipo || '(sin nombre)' }
      : null,
    accion,
    // metadata interna para procesarYAmarrar
    _interno: { pedidoCandidato, parseo, clientePorHash, esArreglo, vendedora, fotoHash, ultimoTs: g.ultimoTs, primerTs: g.primerTs, fotoPrincipalKey: fotoPrincipal?.key },
  };
}

// ── Analizar mensajes (SIN amarrar nada) — para endpoint prueba ──
// Filtra a los ultimos N dias, descarga foto principal, pasa a Gemini.
async function analizarMensajesGrupo({ db = null, limit = 50, pedidos = [], diasAtras = 7, conImagen = true } = {}) {
  if (!EVO_KEY) return { error: 'sin EVOLUTION_API_KEY' };
  const msgs = await listarMensajesGrupo(limit);
  if (!msgs.length) return { error: 'sin mensajes', total: 0 };

  const delGrupo = msgs.filter(m => (m.key?.remoteJid || '') === GRUPO_VENTAS_JID);
  const cutoffTs = Date.now() - (diasAtras * 24 * 60 * 60 * 1000);
  const recientes = delGrupo.filter(m => ((m.messageTimestamp || 0) * 1000) >= cutoffTs);
  const grupos = agruparPorSenderYVentana(recientes);

  const reporte = [];
  for (const g of grupos) {
    const r = await _construirReporteGrupo(g, { db, pedidos, conImagen });
    if (r) {
      // No exponer metadata interna en la respuesta del endpoint
      const { _interno, ...publico } = r;
      reporte.push(publico);
    }
  }

  return {
    grupoJid: GRUPO_VENTAS_JID,
    diasAtrasFiltro: diasAtras,
    totalMensajes: delGrupo.length,
    mensajesEnVentana: recientes.length,
    gruposDetectados: reporte.length,
    matchesPorHash: reporte.filter(r => r.metodoIdentificacion === 'hash-foto').length,
    arreglosDetectados: reporte.filter(r => r.esArreglo).length,
    detalle: reporte,
  };
}

// ── PROCESAR Y AMARRAR (SI modifica pedidos) — para cron real ──────
// Recorre grupos de mensajes recientes, usa hash matching + Gemini, y
// MODIFICA pedidos UNO A UNO con db.upsertPedido (no pisa pedidos nuevos).
// Mantiene state.ultimoTs para cutoff temporal.
async function procesarYAmarrar({ db, notificarWAVendedora = null, registrarArreglo = null, diasAtras = 2, conImagen = true } = {}) {
  if (!EVO_KEY) return { error: 'sin EVOLUTION_API_KEY' };
  if (!db || !db.leerPedidos || !db.upsertPedido) {
    return { error: 'faltan db.leerPedidos/db.upsertPedido' };
  }

  const state = leerState();
  const cutoffStateTs = state.ultimoTs || 0;
  const cutoffDiasTs = Date.now() - (diasAtras * 24 * 60 * 60 * 1000);
  // El cutoff efectivo es el MAYOR entre los dos (no reprocesar historico ni lo ya visto)
  const cutoffTs = Math.max(cutoffStateTs, cutoffDiasTs);

  const msgs = await listarMensajesGrupo(100);
  const delGrupo = msgs.filter(m => (m.key?.remoteJid || '') === GRUPO_VENTAS_JID);
  const nuevos = delGrupo.filter(m => ((m.messageTimestamp || 0) * 1000) > cutoffTs);

  if (!nuevos.length) {
    return { procesados: 0, amarrados: 0, arreglos: 0, sinMatch: 0, cutoffTs };
  }

  const grupos = agruparPorSenderYVentana(nuevos);
  const pedidos = db.leerPedidos();

  const resultados = { procesados: 0, amarrados: 0, arreglos: 0, sinMatch: 0, detalle: [] };
  let maxTsVisto = cutoffTs;

  for (const g of grupos) {
    maxTsVisto = Math.max(maxTsVisto, g.ultimoTs);
    const r = await _construirReporteGrupo(g, { db, pedidos, conImagen });
    if (!r) continue;
    resultados.procesados++;

    const { pedidoCandidato, parseo, esArreglo } = r._interno;

    // ── Caso 1: arreglo (Lidermeyer) ──
    if (esArreglo) {
      resultados.arreglos++;
      try {
        if (typeof registrarArreglo === 'function') {
          await registrarArreglo({
            nombreEquipo: parseo?.nombre_equipo || null,
            descripcion: r.captionPrincipal || r.textoListado || '',
            fuente: 'grupo-ventas',
            fechaIso: new Date(g.ultimoTs).toISOString(),
          });
        }
      } catch (e) { console.error('[grupo-ventas registrarArreglo err]', e.message); }
      resultados.detalle.push({ accion: 'ARREGLO', nombre: parseo?.nombre_equipo, desde: g.pushName });
      continue;
    }

    // ── Caso 2: identificado pedido → amarrar nombre/fecha/jugadores ──
    if (pedidoCandidato && parseo?.nombre_equipo && parseo?.esPedidoUniforme !== false) {
      // Releer pedido fresco (otro cron pudo haberlo modificado entre lecturas)
      const fresco = db.leerPedidos().find(p => p.id === pedidoCandidato.id);
      if (!fresco) {
        resultados.detalle.push({ accion: 'SIN-MATCH', razon: 'pedido borrado entre lecturas', pedidoId: pedidoCandidato.id });
        continue;
      }
      const p = fresco;

      const nombreNuevo = String(parseo.nombre_equipo).trim();
      if (nombreNuevo) p.equipo = nombreNuevo;
      if (parseo.fecha_entrega) p.fechaEntrega = parseo.fecha_entrega;
      if (parseo.num_uniformes) p.numUniformes = parseo.num_uniformes;
      if (parseo.tipo_prenda) p.tipoPrenda = parseo.tipo_prenda;
      if (Array.isArray(parseo.lista_jugadores) && parseo.lista_jugadores.length) {
        p.listaJugadores = parseo.lista_jugadores;
      }
      // Marca de amarre + avance a confirmado (cliente aprobo implicito: la posteo al grupo)
      p.equipoAmarradoDeGrupo = true;
      p.amarradoDeGrupoFuente = r.metodoIdentificacion; // 'hash-foto' o 'sender-vendedora'
      p.amarradoDeGrupoIso = new Date(g.ultimoTs).toISOString();
      if (p.estado === 'bandeja' || p.estado === 'hacer-diseno') {
        p.estado = 'confirmado';
      }
      p.ultimoMovimiento = new Date().toISOString();

      try {
        db.upsertPedido(p);
      } catch (e) {
        console.error('[grupo-ventas upsertPedido err]', e.message);
        resultados.detalle.push({ accion: 'ERROR', pedidoId: p.id, error: e.message });
        continue;
      }
      resultados.amarrados++;
      resultados.detalle.push({
        accion: 'AMARRADO', pedidoId: p.id, equipo: nombreNuevo,
        metodo: r.metodoIdentificacion, vendedora: p.vendedora,
      });

      // Notificar a la vendedora
      try {
        if (typeof notificarWAVendedora === 'function') {
          const fechaTxt = parseo.fecha_entrega ? ` para el ${parseo.fecha_entrega}` : '';
          await notificarWAVendedora(p.vendedora,
            `📋 tu pedido #${p.id} quedo nombrado como *${nombreNuevo}*${fechaTxt}`,
            { tipo: 'amarre-grupo', pedidoId: p.id }
          );
        }
      } catch (e) { console.error('[grupo-ventas notif vendedora err]', e.message); }

    } else {
      resultados.sinMatch++;
      resultados.detalle.push({
        accion: 'SIN-MATCH',
        razon: r.accion,
        nombreDetectado: parseo?.nombre_equipo || null,
      });
    }
  }

  // Avanzar cutoff (siempre, aunque no haya amarrados)
  state.ultimoTs = maxTsVisto;
  guardarState(state);

  return { ...resultados, cutoffTs: maxTsVisto };
}

module.exports = {
  GRUPO_VENTAS_JID,
  TELEFONO_ARREGLOS,
  listarMensajesGrupo,
  agruparPorSenderYVentana,
  extraerContenido,
  pushNameAVendedora,
  identificarSender,
  senderEsArreglos,
  parsearGrupoConGemini,
  encontrarPedidoParaAmarrar,
  encontrarPedidoActivoCliente,
  equipoEsGenericoOVacio,
  pedidoEsAmarrable,
  hashearBase64,
  identificarClientePorHash,
  analizarMensajesGrupo,
  procesarYAmarrar,
  descargarImagenEvolution,
  leerState,
  guardarState,
};
