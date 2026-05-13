const http = require('http');
const fs   = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;
const db   = require('./db');

// ── Configuración de Seguridad ───────────────────────────────────
const API_KEY = process.env.API_KEY || 'ws-textil-2026';

const PORT = process.env.PORT || 3000;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

function crearVentaInterna(tipo, vendedora, telefono, waMsgId, equipo) {
  const tipoNorm = tipo.toLowerCase();
  const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
  const vendedoraNorm = vendedora.toLowerCase();
  if (!VENDEDORAS_VALIDAS.includes(vendedoraNorm))
    return { ok: false, error: `Vendedora no reconocida: ${vendedora}` };

  const pedidos = leerPedidos();
  
  // Control de Duplicados por waMsgId
  if (waMsgId && pedidos.some(p => p.waMsgId === waMsgId)) {
    console.log(`[api] Pedido duplicado ignorado: waMsgId=${waMsgId}`);
    const existnte = pedidos.find(p => p.waMsgId === waMsgId);
    return { ok: true, id: existnte.id, tipo: tipoNorm, vendedora: existnte.vendedora, telefono, duplicado: true };
  }

  // Control de Duplicados por teléfono+mes — normaliza quitando TODO no-dígito
  // (espacios, +, guiones, etc) y permite match aunque venga con o sin 57.
  const mesActual = new Date().toLocaleDateString('es-CO').slice(-7);
  function normTel(t) {
    const d = String(t || '').replace(/\D/g, '');
    return d.startsWith('57') ? d.slice(2) : d;
  }
  const telLimpio = normTel(telefono);
  const dupTel = pedidos.find(p => {
    const pTel = normTel(p.telefono);
    const pMes = (p.creadoEn || '').slice(-7);
    return pTel === telLimpio && pMes === mesActual && p.tipoBandeja === tipoNorm;
  });
  if (dupTel) {
    console.log(`[api] Duplicado por teléfono+mes ignorado: ${telLimpio}`);
    return { ok: true, id: dupTel.id, tipo: tipoNorm, vendedora: dupTel.vendedora, telefono, duplicado: true };
  }

  const nextId  = leerNextId();

  const nuevo = {
    id:          nextId,
    equipo:      equipo ? String(equipo).trim() : '',
    telefono:    String(telefono).trim(),
    vendedora:   vendedora.charAt(0).toUpperCase() + vendedora.slice(1).toLowerCase(),
    tipoBandeja: tipoNorm,
    estado:      tipoNorm === 'pedido' ? 'hacer-diseno' : 'bandeja',
    creadoEn:    new Date().toLocaleDateString('es-CO'),
    ultimoMovimiento: new Date().toISOString(),
    items:       [],
    fechaEntrega: '',
    notas:       '',
    arreglo:     null,
    origenBot:   true,
    waMsgId:     waMsgId || null,
  };

  pedidos.push(nuevo);
  guardarPedidos(pedidos, nextId + 1);
  console.log(`[api] Nueva ${tipoNorm} #${nextId} — ${vendedora} — ${telefono} (${waMsgId || 'manual'})`);
  return { ok: true, id: nextId, tipo: tipoNorm, vendedora: nuevo.vendedora, telefono };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function leerPedidos() { return db.leerPedidos(); }
function leerNextId() { return db.leerNextId(); }

// Manda mensaje a Telegram. No bloquea — si falla, solo loguea.
async function notificarTelegram(texto) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' }),
    });
    if (!r.ok) console.error('[telegram] respuesta:', r.status);
  } catch (e) { console.error('[telegram error]', e.message); }
}

// Manda mensaje personal por Telegram a Duvan (lector del tablero, recordatorios).
// Usa TELEGRAM_CHAT_ID_DUVAN si existe; fallback al grupo Producción.
async function notificarTelegramDuvan(texto) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID_DUVAN || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' }),
    });
    if (!r.ok) console.error('[telegram-duvan] respuesta:', r.status);
  } catch (e) { console.error('[telegram-duvan error]', e.message); }
}

// Manda mensaje al grupo de WhatsApp "Trabajo en familia" vía Evolution.
async function notificarWhatsappTrabajoFamilia(texto) {
  try {
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const apiKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const instance = process.env.EVOLUTION_INSTANCE || 'ws-ventas';
    const groupJid = process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us';
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: groupJid, text: texto }),
    });
    if (!r.ok) console.error('[wa-grupo] respuesta:', r.status);
  } catch (e) { console.error('[wa-grupo error]', e.message); }
}

// Manda mensaje al WA personal de una vendedora vía la instancia de ventas.
// vendedora: 'Betty' | 'Ney' | 'Wendy' | 'Paola' (case-insensitive)
async function notificarWAVendedora(vendedora, texto) {
  try {
    const numerosWA = {
      // Cada vendedora recibe el resumen en su propio WA personal.
      // Si el número no está mapeado, no se manda nada.
      'betty': process.env.WA_BETTY || '573506974711',
      'ney':   process.env.WA_NEY   || '573016639430',
      'wendy': process.env.WA_WENDY || '573118287892',
      'paola': process.env.WA_PAOLA || '573026027865',
    };
    const numero = numerosWA[String(vendedora).toLowerCase()];
    if (!numero) { console.log(`[wa-vendedora] sin número para ${vendedora}`); return; }

    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const apiKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    // Usamos la instancia de ventas (Betty) como remitente del recordatorio interno.
    const instance = process.env.EVOLUTION_INSTANCE || 'ws-ventas';
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: numero, text: texto }),
    });
    if (!r.ok) console.error(`[wa-vendedora ${vendedora}] respuesta:`, r.status);
  } catch (e) { console.error('[wa-vendedora error]', e.message); }
}

// ── DETECTOR DE COMPROBANTES DE PAGO con Gemini Flash ──
// Cuando el cliente manda una imagen, la pasamos a Gemini para que decida si es comprobante.
// Si lo es, guardamos un registro para el resumen de las 8 PM.
async function analizarImagenConGemini(base64Img, mimeType) {
  global._geminiUltimoError = null;
  global._geminiUltimaRespuesta = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { console.log('[gemini] sin API key, saltando'); global._geminiUltimoError = 'no api key'; return null; }

    const prompt = `Analizá esta imagen de WhatsApp en Colombia. Responde SOLO con JSON válido (sin markdown, sin texto extra).

Si es captura/foto de un COMPROBANTE de pago de Bancolombia, Nequi, Daviplata, BBVA, Davivienda, Banco de Bogotá, Caja Social, AV Villas, PSE, transferencia bancaria, recibo de consignación, etc:
{"esComprobante": true, "banco": "Nombre del banco/app", "monto": numero_sin_puntos_ni_pesos, "fecha": "YYYY-MM-DD o null si no se ve", "confianza": "alta|media|baja"}

Si NO es comprobante (es foto de uniforme, logo, persona, paisaje, captura de chat, screenshot de redes, etc):
{"esComprobante": false}

Respuesta:`;

    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64Img } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[gemini] HTTP', r.status, errText.slice(0, 200));
      global._geminiUltimoError = `HTTP ${r.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    global._geminiUltimaRespuesta = texto.slice(0, 500);
    // Limpiar respuesta: a veces viene con ```json ... ```
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      return JSON.parse(limpio);
    } catch (e) {
      console.error('[gemini] respuesta no parseable:', limpio.slice(0, 200));
      global._geminiUltimoError = `parse error: ${limpio.slice(0, 300)}`;
      return null;
    }
  } catch (e) {
    console.error('[gemini error]', e.message);
    global._geminiUltimoError = `exception: ${e.message}`;
    return null;
  }
}

// Lee una foto del tablero físico de producción de W&S.
// El tablero tiene 4 columnas: APROBADOS, VENTAS, ENVIADOS, HACER DISEÑOS.
// Devuelve JSON estructurado con las entradas de cada columna.
async function analizarTableroConGemini(base64Img, mimeType) {
  global._tableroUltimoError = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { global._tableroUltimoError = 'no api key'; return null; }

    const prompt = `Esta es una foto de un tablero blanco con escritura a mano de la empresa W&S Enterprise (uniformes deportivos, Colombia).
El tablero tiene 4 columnas con los títulos:
- APROBADOS (arriba izquierda)
- VENTAS (arriba derecha)
- ENVIADOS (abajo izquierda)
- HACER DISEÑOS (abajo derecha)

Cada columna tiene una lista de pedidos. Cada pedido puede ser:
- Solo un nombre de equipo o cliente (ej: "Friens", "Casa Sport", "Niupy")
- Un teléfono + nombre/equipo (ej: "3132210432 - Cristo", "311 8884276 - Niupi FC")
- Combinación de cliente y descripción (ej: "Dago Chaquetas", "Fabian - Chaqueta")

Devolveme SOLO un JSON con esta estructura, sin markdown, sin texto extra:
{
  "aprobados": [{"texto": "...", "telefono": "..." o null, "equipo": "..."}],
  "ventas": [...],
  "enviados": [...],
  "hacerDisenos": [...]
}

- En "telefono" pon SOLO los 10 dígitos sin espacios ni guiones (ej: "3132210432"). null si no hay teléfono.
- En "equipo" pon el nombre del equipo/cliente limpio (sin el teléfono).
- En "texto" pon la línea completa tal cual aparece en el tablero.
- Si una entrada es ambigua o ilegible, igual inclúyela con tu mejor lectura.

Respuesta:`;

    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64Img } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      global._tableroUltimoError = `HTTP ${r.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      return JSON.parse(limpio);
    } catch (e) {
      global._tableroUltimoError = `parse error: ${limpio.slice(0, 300)}`;
      return null;
    }
  } catch (e) {
    global._tableroUltimoError = `exception: ${e.message}`;
    return null;
  }
}

// Aplica la estructura leída del tablero a los pedidos:
// - Si el equipo ya existe en la app, mueve estado a la columna correcta
// - Si NO existe, crea pedido nuevo con vendedora "Sin asignar" para revisión
// Devuelve { creados: [...], movidos: [...], yaCorrectos: [...] }
function aplicarTableroAPedidos(estructura) {
  const COLUMNA_A_ESTADO = {
    aprobados: 'confirmado',
    ventas: 'hacer-diseno',
    enviados: 'enviado-final',
    hacerDisenos: 'bandeja',
  };
  const pedidos = leerPedidos();
  const ahora = new Date().toISOString();
  const creados = [], movidos = [], yaCorrectos = [];
  const idsTocados = new Set(); // IDs de pedidos que aparecieron en la foto
  let nextId = leerNextId();

  function nombresParecen(a, b) {
    const na = nombreLimpio(a), nb = nombreLimpio(b);
    if (!na || !nb) return false;
    return na === nb || na.includes(nb) || nb.includes(na);
  }

  for (const [columna, estadoApp] of Object.entries(COLUMNA_A_ESTADO)) {
    const items = Array.isArray(estructura[columna]) ? estructura[columna] : [];
    for (const it of items) {
      const equipo = String(it.equipo || it.texto || '').trim();
      if (!equipo) continue;
      const tel = String(it.telefono || '').replace(/\D/g, '');
      // Buscar pedido existente: prioridad teléfono, luego nombre
      let pd = null;
      if (tel && tel.length >= 8) {
        pd = pedidos.find(p => String(p.telefono || '').replace(/\D/g, '') === tel);
      }
      if (!pd) pd = pedidos.find(p => nombresParecen(p.equipo, equipo));
      if (pd) {
        idsTocados.add(pd.id);
        if (pd.estado !== estadoApp) {
          const estadoAnterior = pd.estado;
          pd.estado = estadoApp;
          pd.ultimoMovimiento = ahora;
          movidos.push({ id: pd.id, equipo: pd.equipo, de: estadoAnterior, a: estadoApp });
        } else {
          yaCorrectos.push({ id: pd.id, equipo: pd.equipo });
        }
      } else {
        // Crear nuevo
        const nuevo = {
          id: nextId,
          equipo,
          telefono: tel || '',
          vendedora: 'Sin asignar',
          disenadorAsignado: null,
          tipoBandeja: 'venta',
          estado: estadoApp,
          creadoEn: ahora,
          ultimoMovimiento: ahora,
          items: [],
          fechaEntrega: null,
          notas: 'Creado desde foto del tablero (' + ahora.slice(0, 10) + ')',
          arreglo: false,
          archivosAlias: [],
          pdfDriveListo: false,
          wtListo: false,
          origenTablero: true,
        };
        pedidos.push(nuevo);
        idsTocados.add(nuevo.id);
        creados.push({ id: nuevo.id, equipo, columna });
        nextId++;
      }
    }
  }

  // Pedidos activos que NO están en la foto → candidatos a archivar
  // Solo considerar pedidos con movimiento en los últimos 60 días (ignorar zombies viejos)
  const hace60Dias = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const noEnTablero = pedidos
    .filter(p => !idsTocados.has(p.id))
    .filter(p => {
      const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
      return t >= hace60Dias;
    })
    .map(p => ({
      id: p.id,
      equipo: p.equipo || '',
      telefono: p.telefono || '',
      vendedora: p.vendedora || '',
      disenadorAsignado: p.disenadorAsignado || '',
      estado: p.estado,
      ultimoMovimiento: p.ultimoMovimiento || null,
    }));

  guardarPedidos(pedidos, nextId);
  global._huerfanosCache = null;
  return { creados, movidos, yaCorrectos, noEnTablero };
}

// Descarga la imagen base64 desde Evolution API.
async function descargarImagenEvolution(instance, messageKey) {
  try {
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const apiKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const r = await fetch(`${url}/chat/getBase64FromMediaMessage/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ message: { key: messageKey } }),
    });
    if (!r.ok) {
      console.error('[descargar-img] HTTP', r.status);
      return null;
    }
    const data = await r.json();
    return { base64: data.base64, mimeType: data.mimetype || 'image/jpeg' };
  } catch (e) {
    console.error('[descargar-img error]', e.message);
    return null;
  }
}

// Guarda un comprobante detectado en SQLite
function guardarComprobanteDetectado(registro) {
  db.upsertComprobante(registro);
}


// Etiqueta una conversación de Chatwoot por contactId con la etiqueta dada.
// Crea la etiqueta si no existe, busca la conversación abierta del contacto y le añade la etiqueta.
async function etiquetarChatwootContacto(contactoId, etiqueta) {
  try {
    const url = process.env.CHATWOOT_URL;
    const accountId = process.env.CHATWOOT_ACCOUNT_ID;
    const apiKey = process.env.CHATWOOT_API_KEY;
    if (!url || !accountId || !apiKey || !contactoId) return;
    // Buscar conversaciones del contacto
    const r = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/${contactoId}/conversations`, {
      headers: { 'api_access_token': apiKey },
    });
    if (!r.ok) return;
    const data = await r.json();
    const convs = data.payload || [];
    if (!convs.length) return;
    // Tomar la conversación más reciente
    const conv = convs[0];
    // Añadir etiqueta a esa conversación
    const r2 = await fetch(`${url}/api/v1/accounts/${accountId}/conversations/${conv.id}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': apiKey },
      body: JSON.stringify({ labels: [etiqueta] }),
    });
    if (r2.ok) console.log(`[chatwoot] etiqueta "${etiqueta}" añadida a conversación #${conv.id} (contacto ${contactoId})`);
    else console.error('[chatwoot] etiquetar falló:', r2.status);
  } catch (e) { console.error('[etiquetarChatwootContacto error]', e.message); }
}

// Busca contacto en Chatwoot por teléfono. Devuelve { name, id } o null.
async function buscarContactoChatwoot(telefono) {
  try {
    const url = process.env.CHATWOOT_URL;
    const accountId = process.env.CHATWOOT_ACCOUNT_ID;
    const apiKey = process.env.CHATWOOT_API_KEY;
    if (!url || !accountId || !apiKey) return null;
    const r = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(telefono)}`, {
      headers: { 'api_access_token': apiKey },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.payload && data.payload.length > 0) {
      const c = data.payload[0];
      return { name: c.name || null, id: c.id };
    }
    return null;
  } catch (e) {
    console.error('[buscarContactoChatwoot error]', e.message);
    return null;
  }
}

// Consulta Evolution para obtener el nombre del contacto desde su JID.
// Devuelve el nombre limpio o null si no encuentra.
async function obtenerNombreContactoEvolution(remoteJid) {
  try {
    const url = (process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app');
    const apiKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const instance = process.env.EVOLUTION_INSTANCE || 'ws-ventas';
    const r = await fetch(`${url}/chat/findContacts/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ where: { remoteJid } }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      const c = data[0];
      return (c.pushName && c.pushName.trim()) || null;
    }
    return null;
  } catch (e) {
    console.error('[obtenerNombreContactoEvolution error]', e.message);
    return null;
  }
}

// Resuelve el mejor nombre y devuelve también contactId de Chatwoot si existe.
async function resolverCliente(remoteJid, telefono, pushNameFallback) {
  const cw = await buscarContactoChatwoot(telefono);
  if (cw) {
    const name = (cw.name && cw.name.trim()) || null;
    if (name) return { nombre: name, contactoChatwoot: cw.id };
  }
  const ev = await obtenerNombreContactoEvolution(remoteJid);
  if (ev) return { nombre: ev, contactoChatwoot: cw?.id || null };
  if (pushNameFallback && !/uniformes|wys|w&s/i.test(pushNameFallback)) {
    return { nombre: pushNameFallback, contactoChatwoot: cw?.id || null };
  }
  return { nombre: `Cliente +57 ${telefono.slice(-10)}`, contactoChatwoot: cw?.id || null };
}

function guardarPedidos(pedidos, nextId) { db.guardarPedidos(pedidos, nextId); }

// Tombstones: IDs de pedidos archivados (en Notion) para evitar que el cliente los reviva.
// Se mantienen los últimos 30 días.
const TOMBSTONES_FILE = path.join(__dirname, 'data', 'pedidos-archivados-tombstones.json');
function leerTombstones() {
  try {
    if (!fs.existsSync(TOMBSTONES_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(TOMBSTONES_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function guardarTombstones(arr) {
  try {
    fs.mkdirSync(path.dirname(TOMBSTONES_FILE), { recursive: true });
    fs.writeFileSync(TOMBSTONES_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { console.error('[tombstones]', e.message); }
}
function agregarTombstone(pedidoId) {
  const lista = leerTombstones();
  const hace30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const filtrado = lista.filter(t => t.ts >= hace30);
  if (!filtrado.find(t => t.id === pedidoId)) {
    filtrado.push({ id: pedidoId, ts: Date.now() });
    guardarTombstones(filtrado);
  }
}
function idsArchivados() {
  return new Set(leerTombstones().map(t => t.id));
}

// Limpia pedidos.json de cualquier ID que esté en tombstones.
// Esto se ejecuta antes de servir /api/pedidos y al guardar nuevos pedidos.
function purgarArchivados(pedidos) {
  const archivados = idsArchivados();
  if (!archivados.size) return pedidos;
  return pedidos.filter(p => !archivados.has(p.id));
}

// ─────────────────────────────────────────────────────────────
// NOTION — Archivar pedidos entregados (enviado-final)
// El pedido se sube a Notion y luego se borra del servidor.
// Notion queda como histórico, Railway sigue ligero.
// ─────────────────────────────────────────────────────────────
async function archivarPedidoEnNotion(pedido) {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ARCHIVO_PEDIDOS;
  if (!token || !dbId) {
    console.log('[notion] sin token o db_id, saltando archivo');
    return { ok: false, motivo: 'no configurado' };
  }
  try {
    // Las opciones del select de vendedora en Notion: "Betty", "ney", "wendy", "paola"
    const venRaw = String(pedido.vendedora || '').toLowerCase();
    const VEN_MAP = { 'betty': 'Betty', 'ney': 'ney', 'wendy': 'wendy', 'paola': 'paola' };
    const vendedoraNotion = VEN_MAP[venRaw] || null;

    // Formatear items / prendas
    let itemsTxt = '';
    if (Array.isArray(pedido.items) && pedido.items.length) {
      itemsTxt = pedido.items.map(i => {
        if (typeof i === 'string') return i;
        if (i && typeof i === 'object') return [i.prenda, i.tela, i.cantidad].filter(Boolean).join(' ');
        return '';
      }).filter(Boolean).join(', ').slice(0, 1900);
    }

    // Fecha creado: pedido.creadoEn puede venir como "d/m/yyyy" o ISO
    function aIsoDate(f) {
      if (!f) return null;
      const m = String(f).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
      const t = new Date(f);
      return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
    }
    const fechaCreadoISO = aIsoDate(pedido.creadoEn);
    const fechaEntregadoISO = aIsoDate(pedido.ultimoMovimiento) || new Date().toISOString().slice(0, 10);

    // Teléfono como número (Notion lo tiene como number)
    const telNum = parseInt(String(pedido.telefono || '').replace(/\D/g, '')) || null;

    const props = {
      'Equipo': { title: [{ text: { content: String(pedido.equipo || 'Sin equipo').slice(0, 1900) } }] },
      'Estado': { select: { name: 'Entregado' } },
      'Fecha entregado': { date: { start: fechaEntregadoISO } },
      'ID original': { number: pedido.id || null },
    };
    if (pedido.cliente) props['Cliente'] = { rich_text: [{ text: { content: String(pedido.cliente).slice(0, 1900) } }] };
    if (vendedoraNotion) props['Vendedora'] = { select: { name: vendedoraNotion } };
    if (telNum) props['Telefono'] = { number: telNum };
    if (fechaCreadoISO) props['Fecha creado'] = { date: { start: fechaCreadoISO } };
    if (itemsTxt) props['Items / Prendas'] = { rich_text: [{ text: { content: itemsTxt } }] };
    if (pedido.total) props['Total'] = { number: Number(pedido.total) };

    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: props,
      }),
    });
    if (!r.ok) {
      const errTxt = await r.text();
      console.error('[notion archivar] HTTP', r.status, errTxt.slice(0, 400));
      return { ok: false, motivo: `HTTP ${r.status}`, detalle: errTxt.slice(0, 400) };
    }
    const data = await r.json();
    console.log(`[notion archivar] pedido #${pedido.id} archivado en Notion (page=${data.id})`);
    return { ok: true, notionPageId: data.id };
  } catch (e) {
    console.error('[notion archivar error]', e.message);
    return { ok: false, motivo: 'exception', detalle: e.message };
  }
}

// Archiva un pedido por ID: lo sube a Notion y lo borra del servidor.
// Devuelve { ok, notionPageId } o { ok:false, motivo }.
async function archivarYBorrarPedido(pedidoId) {
  const pedidos = leerPedidos();
  const idx = pedidos.findIndex(p => p.id === pedidoId);
  if (idx === -1) return { ok: false, motivo: 'pedido no encontrado' };
  const pedido = pedidos[idx];
  const resp = await archivarPedidoEnNotion(pedido);
  if (!resp.ok) return resp;
  // Borrar del servidor
  pedidos.splice(idx, 1);
  guardarPedidos(pedidos, leerNextId());
  // Tombstone: que el cliente no lo reviva
  agregarTombstone(pedidoId);
  return { ok: true, notionPageId: resp.notionPageId, pedidoId };
}

const ESTADOS_VALIDOS = [
  'bandeja','hacer-diseno','confirmado','enviado-calandra',
  'llego-impresion','corte','calidad','costura','en-satelite','listo','enviado-final'
];

// ── Matching de nombres de archivo a equipos ───────────────────
// "Camilo 1.pdf" → "camilo"  |  "Galaktiturkos 1.50m.pdf" → "galaktiturkos"
function nombreLimpio(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[\s_-]+\d+(\.\d+)?\s*m?$/i, '') // sufijo "1", "2", "1.50m" al final
    .replace(/[\s_-]+\d+(\.\d+)?\s*m?[\s_-]+/gi, ' ') // mismo en medio
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function nombresCoinciden(equipoPedido, archivo) {
  const a = nombreLimpio(equipoPedido);
  const b = nombreLimpio(archivo);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// Devuelve un score 0-1 de qué tan parecidos son dos nombres (overlap de palabras).
// Útil como fallback cuando nombresCoinciden() falla pero hay similitud parcial.
function scoreSimilitud(equipoPedido, archivo) {
  const a = nombreLimpio(equipoPedido);
  const b = nombreLimpio(archivo);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.95;
  const palabrasA = new Set(a.split(' ').filter(w => w.length >= 3));
  const palabrasB = b.split(' ').filter(w => w.length >= 3);
  if (!palabrasA.size || !palabrasB.length) return 0;
  const matches = palabrasB.filter(w => palabrasA.has(w)).length;
  return matches / Math.max(palabrasA.size, palabrasB.length);
}

// Busca un pedido cuyo equipo, cliente o alias coincida con el archivo.
// pedido.archivosAlias es un array de nombres limpios aprendidos por vinculaciones manuales.
function buscarPedidoPorArchivo(pedidos, archivo, equipoHint) {
  const ref = equipoHint || archivo;
  const refLimpio = nombreLimpio(ref);
  if (!refLimpio) return null;
  // 1) Coincidencia con alias guardado (más fuerte: aprendido manualmente)
  let pd = pedidos.find(p => {
    if (['enviado-calandra','llego-impresion','calidad','costura','listo','enviado-final'].includes(p.estado)) return false;
    const aliases = Array.isArray(p.archivosAlias) ? p.archivosAlias : [];
    return aliases.some(a => a === refLimpio || a.includes(refLimpio) || refLimpio.includes(a));
  });
  if (pd) return pd;
  // 2) Coincidencia con equipo
  pd = pedidos.find(p => {
    if (['enviado-calandra','llego-impresion','calidad','costura','listo','enviado-final'].includes(p.estado)) return false;
    return nombresCoinciden(p.equipo, ref);
  });
  if (pd) return pd;
  // 3) Coincidencia con cliente (a veces el archivo se llama como el cliente, no como el equipo)
  pd = pedidos.find(p => {
    if (['enviado-calandra','llego-impresion','calidad','costura','listo','enviado-final'].includes(p.estado)) return false;
    return p.cliente && nombresCoinciden(p.cliente, ref);
  });
  return pd || null;
}

// Mapeo de instancia Evolution → vendedora.
// La instancia que envía el evento determina quién hizo la venta.
// Las vendedoras-diseñadoras (Ney/Wendy/Paola) son su propia diseñadora;
// solo Betty selecciona diseñador con dropdown en la app.
// Nota: aceptamos variantes con espacio o guión porque algunas instancias
// quedaron creadas con espacio en Evolution (ej: "ws wendy" en vez de "ws-wendy").
const INSTANCIA_A_VENDEDORA = {
  'ws-ventas': 'Betty',
  'ws-ney':    'Ney',
  'ws-wendy':  'Wendy',
  'ws wendy':  'Wendy',
  'ws-paola':  'Paola',
  'ws paola':  'Paola',
};
const VENDEDORAS_DISENADORAS = new Set(['Ney', 'Wendy', 'Paola']);

function vendedoraDeInstancia(instance) {
  if (!instance) return 'Betty';
  // Normalizar: minúsculas + reemplazar espacios/guiones bajos por guión
  const norm = String(instance).toLowerCase().replace(/[\s_]+/g, '-');
  return INSTANCIA_A_VENDEDORA[instance] || INSTANCIA_A_VENDEDORA[norm] || 'Betty';
}

// Avanza un pedido de 'confirmado' → 'enviado-calandra' SOLO cuando
// tenga ambas señales: PDF en Drive Y correo WeTransfer.
function evaluarPasoCalandra(pedido) {
  if (!pedido) return false;
  if (pedido.estado !== 'confirmado') return false;
  if (!pedido.pdfDriveListo) return false;
  if (!pedido.wtListo) return false;
  pedido.estado = 'enviado-calandra';
  pedido.ultimoMovimiento = new Date().toISOString();
  console.log(`[auto-avance] #${pedido.id} confirmado → enviado-calandra (PDF+WT listos)`);
  return true;
}

http.createServer((req, res) => {

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /api/pedidos — lista todos los pedidos (purgando archivados) ──
  if (req.method === 'GET' && req.url === '/api/pedidos') {
    const peds = purgarArchivados(leerPedidos());
    const tomb = leerTombstones();
    return json(res, 200, { pedidos: peds, nextId: leerNextId(), archivados: tomb.map(t => t.id) });
  }

  // ── DELETE /api/pedidos/:id — borra un pedido del servidor ──
  if (req.method === 'DELETE' && req.url.startsWith('/api/pedidos/') && !req.url.includes('limpiar-basura')) {
    const id = parseInt(req.url.split('/')[3]);
    const pedidos = leerPedidos();
    const nuevos = pedidos.filter(p => p.id !== id);
    if (nuevos.length === pedidos.length) return json(res, 404, { error: 'Pedido no encontrado' });
    guardarPedidos(nuevos);
    console.log(`[api] Pedido #${id} eliminado`);
    return json(res, 200, { ok: true });
  }

  // ── POST /api/pedidos/limpiar-basura — borra pedidos sin teléfono Y sin vendedora ──
  // Útil para limpiar el spam del lector de tablero foto cuando Gemini equivoca.
  if (req.method === 'POST' && req.url === '/api/pedidos/limpiar-basura') {
    try {
      const pedidos = leerPedidos();
      const esBasura = (p) => {
        const sinTel = !p.telefono || String(p.telefono).replace(/\D/g, '').length < 7;
        const sinVen = !p.vendedora || p.vendedora === 'Sin asignar' || p.vendedora === '';
        // No borramos enviado-final (ya entregados) ni los que tengan stickerVenta
        if (p.estado === 'enviado-final') return false;
        if (p.stickerVenta) return false;
        return sinTel && sinVen;
      };
      const basura = pedidos.filter(esBasura);
      const limpios = pedidos.filter(p => !esBasura(p));
      guardarPedidos(limpios);
      console.log(`[limpiar-basura] eliminados ${basura.length} pedidos sin tel+sin vendedora`);
      return json(res, 200, {
        ok: true,
        eliminados: basura.length,
        ids: basura.map(p => p.id),
        total_antes: pedidos.length,
        total_despues: limpios.length,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/reporte-stickers-faltantes ──
  // Revisa los comprobantes recibidos en las últimas 24h por cada vendedora.
  // Si tiene comprobantes (venta-nueva o cliente-recurrente) SIN sticker enviado,
  // le manda un WA personalizado. A las que están al día no las molesta.
  // Llamar con cron desde n8n al final del día (ej. 7 PM).
  if (req.method === 'POST' && req.url === '/api/reporte-stickers-faltantes') {
    (async () => {
      try {
        const VENDEDORAS = [
          { nombre: 'Betty',  telefono: process.env.WA_BETTY  || '' },
          { nombre: 'Ney',    telefono: process.env.WA_NEY    || '' },
          { nombre: 'Wendy',  telefono: process.env.WA_WENDY  || '' },
          { nombre: 'Paola',  telefono: process.env.WA_PAOLA  || '' },
        ];
        const hace24h = Date.now() - 24 * 60 * 60 * 1000;
        const comprobantes = db.leerComprobantes();

        // Pre-calcular: telefonos de clientes con pedido ACTIVO en producción
        // (si ya tienen pedido en curso, un nuevo comprobante es el saldo final, NO venta nueva)
        const pedidosActivos = leerPedidos();
        const ESTADOS_EN_CURSO = new Set(['hacer-diseno','confirmado','enviado-calandra','llego-impresion','calidad','costura','listo']);
        const telsEnCurso = new Set(
          pedidosActivos
            .filter(p => ESTADOS_EN_CURSO.has(p.estado))
            .map(p => String(p.telefono || '').replace(/\D/g, ''))
            .filter(Boolean)
        );

        const resumen = [];
        for (const v of VENDEDORAS) {
          const propios = comprobantes.filter(c => {
            const ts = c.ts ? new Date(c.ts).getTime() : 0;
            if (ts < hace24h) return false;
            if (c.vendedora !== v.nombre) return false;
            // SOLO cuenta como "venta nueva que necesita sticker":
            //  - Gemini la clasificó como venta-nueva
            //  - Y el cliente NO tiene pedido activo en producción (sino sería saldo final)
            if (c.clasificacion !== 'venta-nueva') return false;
            const telCli = String(c.telefono || '').replace(/\D/g, '');
            if (telCli && telsEnCurso.has(telCli)) return false; // saldo final, no sticker
            return true;
          });
          const sinSticker = propios.filter(c => !c.stickerEnviado);
          resumen.push({ vendedora: v.nombre, total: propios.length, sinSticker: sinSticker.length, clientes: sinSticker.map(c => ({ cliente: c.cliente || '?', monto: c.monto || 0 })) });

          // Avisar solo si tiene gap Y tenemos su teléfono configurado
          if (sinSticker.length > 0 && v.telefono) {
            const lista = sinSticker.slice(0, 5).map(c => {
              const monto = c.monto ? '$' + Number(c.monto).toLocaleString('es-CO') : 's/m';
              return '• ' + (c.cliente || 'cliente') + ' (' + monto + ')';
            }).join('\n');
            const extras = sinSticker.length > 5 ? '\n... y ' + (sinSticker.length - 5) + ' más' : '';
            const msg =
              '👋 Hola ' + v.nombre + '!\n\n' +
              '📊 *Resumen del día:*\n' +
              'Hoy recibiste *' + propios.length + '* comprobante(s) de pago — pero *' +
              sinSticker.length + '* no tienen el sticker de venta confirmada.\n\n' +
              '*Comprobantes sin sticker:*\n' + lista + extras + '\n\n' +
              '💰 Mañana temprano por favor envía el sticker *VENTA CONFIRMADA* al chat de cada uno.\n\n' +
              '⚠️ Si no usas el sticker, la venta NO aparece en la app y el diseñador no se entera.';
            try {
              const url = `${process.env.EVOLUTION_API_URL || 'https://evolution-api-production-19cd.up.railway.app'}/message/sendText/ws-duvan`;
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY || '' },
                body: JSON.stringify({ number: v.telefono, text: msg }),
              });
            } catch (e) {
              console.error('[reporte-stickers] error enviando a ' + v.nombre, e.message);
            }
          }
        }

        // Reporte resumen a Duvan por Telegram
        const conGap = resumen.filter(r => r.sinSticker > 0);
        if (conGap.length > 0) {
          const totalGap = conGap.reduce((s, r) => s + r.sinSticker, 0);
          let msgTG = '📊 *Reporte stickers faltantes (24h)*\n\n';
          msgTG += `❌ *${totalGap}* comprobante(s) sin sticker\n\n`;
          conGap.forEach(r => {
            msgTG += `*${r.vendedora}:* ${r.sinSticker}/${r.total} sin sticker\n`;
          });
          notificarTelegramDuvan(msgTG).catch(()=>{});
        }

        return json(res, 200, { ok: true, resumen });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/pedidos — app sincroniza su estado al servidor ─
  if (req.method === 'POST' && req.url === '/api/pedidos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { pedidos: incoming, nextId, eliminados: eliminadosCliente } = JSON.parse(body);
        if (!Array.isArray(incoming)) return json(res, 400, { error: 'pedidos debe ser array' });
        const eliminadosSet = new Set(Array.isArray(eliminadosCliente) ? eliminadosCliente : []);

        // Bloquear pedidos archivados (tombstones) — el cliente puede mandarlos por cache vieja
        const archivadosSet = idsArchivados();
        const incomingFiltrado = incoming.filter(p => !archivadosSet.has(p.id));
        const rechazados = incoming.length - incomingFiltrado.length;
        if (rechazados > 0) console.log(`[POST /api/pedidos] rechazados ${rechazados} pedidos archivados`);

        // Merge: preservar campos del servidor que el cliente puede no tener
        const existing = leerPedidos();
        const mapaExisting = new Map(existing.map(p => [p.id, p]));
        const merged = incomingFiltrado.map(p => {
          const e = mapaExisting.get(p.id);
          if (!e) return p;

          const tIn = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
          const tEx = e.ultimoMovimiento ? new Date(e.ultimoMovimiento).getTime() : 0;

          // Si el servidor tiene datos más recientes, rechazar la actualización del cliente para este pedido
          if (tEx > tIn) {
            return e;
          }

          // Si el cliente tiene datos más recientes o iguales, aceptar los del cliente pero
          // PRESERVAR campos que solo el servidor genera (sticker, fechaVenta, etc).
          // Sin esto, el POST del cliente borra esos campos y la venta deja de estar marcada.
          return {
            ...p,
            equipo: p.equipo || e.equipo || '',
            notaWebhook: p.notaWebhook || e.notaWebhook,
            ultimaActWebhook: p.ultimaActWebhook || e.ultimaActWebhook,
            // Campos generados por el server (sticker handler, webhook, etc):
            stickerVenta: p.stickerVenta || e.stickerVenta,
            fechaVenta: p.fechaVenta || e.fechaVenta,
            contactoChatwoot: p.contactoChatwoot || e.contactoChatwoot,
            disenadorAsignado: p.disenadorAsignado || e.disenadorAsignado,
            waMsgId: p.waMsgId || e.waMsgId,
          };
        });
        // Preservar pedidos del servidor que el cliente no tiene (creados por bot en otro momento)
        // pero NO reagregar los que el cliente eliminó explícitamente NI los archivados
        const incomingIds = new Set(incomingFiltrado.map(p => p.id));
        existing.forEach(e => { if (!incomingIds.has(e.id) && !eliminadosSet.has(e.id) && !archivadosSet.has(e.id)) merged.push(e); });
        merged.sort((a, b) => a.id - b.id);

        guardarPedidos(merged, nextId);
        return json(res, 200, { ok: true, total: merged.length });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/wa-status — estado simulado ────────────────────
  if (req.method === 'GET' && req.url === '/api/wa-status') {
    return json(res, 200, { ok: true, status: 'modo-local-habilitado' });
  }

  // ── POST /api/venta — bot local crea cotización/pedido ─────
  if (req.method === 'POST' && req.url === '/api/venta') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, vendedora, telefono, waMsgId, equipo, key } = JSON.parse(body);

        // Validación de API Key
        if (key !== API_KEY) return json(res, 401, { error: 'Contraseña de API inválida' });

        if (!tipo || !vendedora || !telefono)
          return json(res, 400, { error: 'Faltan campos: tipo, vendedora, telefono' });

        const tipoNorm = tipo.toLowerCase();
        if (!['cotizar', 'pedido'].includes(tipoNorm))
          return json(res, 400, { error: 'tipo debe ser cotizar o pedido' });

        const result = crearVentaInterna(tipo, vendedora, String(telefono).replace(/\s/g, ''), waMsgId, equipo);
        return json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/webhook/chatwoot — Auto-creación de ventas por etiqueta ──
  if (req.method === 'POST' && req.url === '/api/webhook/chatwoot') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        
        // Extraer etiquetas de Chatwoot o de Evolution plano
        let labels = [];
        if (Array.isArray(payload.labels)) labels = payload.labels;
        else if (payload.conversation && Array.isArray(payload.conversation.labels)) labels = payload.conversation.labels;
        else if (payload.tags) labels = Array.isArray(payload.tags) ? payload.tags : [payload.tags];
        
        // Extraer telefono
        let telefono = '';
        let nombreCliente = '';
        if (payload.meta && payload.meta.sender) {
          telefono = payload.meta.sender.phone_number || '';
          nombreCliente = payload.meta.sender.name || '';
        } else if (payload.contact) {
          telefono = payload.contact.phone_number || payload.contact.phone || payload.contact.id || '';
          nombreCliente = payload.contact.name || '';
        }
        
        telefono = telefono.replace(/\D/g, ''); // Solo números (quita el +)

        let accionRealizada = false;
        let resultadoApi = null;

        if (labels.length > 0 && telefono) {
          const vendedoras = ['Betty', 'Graciela', 'Ney', 'Wendy', 'Paola'];
          
          for (let etiqueta of labels) {
            let etiqUpper = etiqueta.toUpperCase();
            
            // Si la etiqueta indica Cotización
            if (etiqUpper.includes('COTIZACI') || etiqUpper.includes('COTIZAR')) {
               const vendedora = vendedoras.find(v => etiqUpper.includes(v.toUpperCase())) || 'Betty';
               resultadoApi = crearVentaInterna('cotizar', vendedora, telefono, null, nombreCliente);
               accionRealizada = true;
               break;
            }
            
            // Si la etiqueta indica Pedido Confirmado (Abono)
            if (etiqUpper.includes('CONFIRMADO') || etiqUpper.includes('ABONO') || etiqUpper.includes('PEDIDO')) {
               const vendedora = vendedoras.find(v => etiqUpper.includes(v.toUpperCase())) || 'Betty';
               
               // Buscar si ya existía como cotización para no duplicar sino avanzar
               const pedidos = leerPedidos();
               const pd = pedidos.find(p => p.telefono.replace(/\D/g, '') === telefono && p.tipoBandeja === 'cotizar');
               
               if (pd) {
                 // Convertir cotización en pedido
                 pd.tipoBandeja = 'pedido';
                 pd.estado = 'confirmado'; // O diseño, según prefiera el dashboard
                 pd.ultimoMovimiento = new Date().toISOString();
                 const nextId = leerNextId();
                 guardarPedidos(pedidos, nextId);
                 
                 console.log(`[webhook] Cotización #${pd.id} avanzada a Pedido Confirmado por etiqueta`);
                 resultadoApi = { ok: true, id: pd.id, accion: 'avanzado' };
               } else {
                 // Es nuevo
                 resultadoApi = crearVentaInterna('pedido', vendedora, telefono, null, nombreCliente);
               }
               accionRealizada = true;
               break;
            }
          }
        }

        return json(res, 200, { ok: true, webhook_recibido: true, accionRealizada, resultadoApi });
      } catch (e) {
        console.error('[webhook error]', e);
        // Responder 200 igual para que chatwoot no reintente locamente en caso de json no esperado
        return json(res, 200, { ok: true, aviso: 'Parse error en webhook' });
      }
    });
    return;
  }

  // ── POST /api/pedidos/:id/archivar — archiva 1 pedido en Notion y lo borra del server ──
  if (req.method === 'POST' && /^\/api\/pedidos\/\d+\/archivar$/.test(req.url)) {
    const m = req.url.match(/^\/api\/pedidos\/(\d+)\/archivar$/);
    const pedidoId = parseInt(m[1]);
    (async () => {
      const r = await archivarYBorrarPedido(pedidoId);
      if (r.ok) return json(res, 200, r);
      return json(res, 500, r);
    })();
    return;
  }

  // ── POST /api/pedidos/purgar-enviado-final — BORRA enviado-final SIN archivar (asume ya archivados antes) ──
  if (req.method === 'POST' && req.url === '/api/pedidos/purgar-enviado-final') {
    try {
      const pedidos = leerPedidos();
      const aBorrar = pedidos.filter(p => p.estado === 'enviado-final');
      const restantes = pedidos.filter(p => p.estado !== 'enviado-final');
      aBorrar.forEach(p => agregarTombstone(p.id));
      guardarPedidos(restantes, leerNextId());
      console.log(`[purgar] borrados ${aBorrar.length} pedidos enviado-final + tombstones agregados`);
      return json(res, 200, { ok: true, borrados: aBorrar.length, restantes: restantes.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/pedidos/archivar-bulk — archiva TODOS los enviado-final ──
  // Body opcional: { soloMasViejosQue: dias } para filtrar
  if (req.method === 'POST' && req.url === '/api/pedidos/archivar-bulk') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      (async () => {
        try {
          let dias = null;
          if (body) { try { dias = JSON.parse(body).soloMasViejosQue || null; } catch {} }
          const pedidos = leerPedidos();
          const limite = dias ? (Date.now() - dias * 86400000) : null;
          const candidatos = pedidos.filter(p => {
            if (p.estado !== 'enviado-final') return false;
            if (!limite) return true;
            const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
            return t < limite;
          });
          const resultado = { total: candidatos.length, archivados: [], fallidos: [] };
          for (const p of candidatos) {
            const r = await archivarYBorrarPedido(p.id);
            if (r.ok) resultado.archivados.push({ id: p.id, equipo: p.equipo, notionPageId: r.notionPageId });
            else resultado.fallidos.push({ id: p.id, equipo: p.equipo, motivo: r.motivo, detalle: r.detalle });
          }
          return json(res, 200, { ok: true, ...resultado });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      })();
    });
    return;
  }

  // ── GET /api/health-reacciones — confirma que el código de reacciones está vivo ──
  if (req.method === 'GET' && req.url === '/api/health-reacciones') {
    return json(res, 200, { ok: true, version: 'sprint-5-notion-archivo', activas: process.env.REACCIONES_ACTIVAS === 'true', chatwoot: !!process.env.CHATWOOT_API_KEY, telegram: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID, telegram_chat_duvan: !!process.env.TELEGRAM_CHAT_ID_DUVAN, wa_grupo: process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us', sticker_hashes_configurados: (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620').split(',').filter(Boolean).length, evolution_api_key: !!process.env.EVOLUTION_API_KEY, gemini_api_key: !!process.env.GEMINI_API_KEY, notion_token: !!process.env.NOTION_TOKEN, notion_db: !!process.env.NOTION_DB_ARCHIVO_PEDIDOS });
  }

  // ── GET /api/test-detector-comprobante?instance=ws%20wendy&jid=573124858901@s.whatsapp.net&id=XXX ──
  // Ejecuta el flujo completo manualmente para diagnosticar
  if (req.method === 'GET' && req.url.startsWith('/api/test-detector-comprobante')) {
    const u = new URL(req.url, 'http://localhost');
    const instance = u.searchParams.get('instance');
    const remoteJid = u.searchParams.get('jid');
    const id = u.searchParams.get('id');
    if (!instance || !remoteJid || !id) return json(res, 400, { error: 'faltan params: instance, jid, id' });
    (async () => {
      const log = [];
      try {
        log.push(`instance=${instance}, jid=${remoteJid}, id=${id}`);
        log.push(`EVOLUTION_API_KEY presente: ${!!process.env.EVOLUTION_API_KEY}, preview: ${(process.env.EVOLUTION_API_KEY||'').slice(0,6)}`);
        log.push(`GEMINI_API_KEY presente: ${!!process.env.GEMINI_API_KEY}`);
        const img = await descargarImagenEvolution(instance, { remoteJid, fromMe: false, id });
        if (!img || !img.base64) {
          log.push('descargarImagenEvolution devolvió null');
          return json(res, 200, { ok: false, log });
        }
        log.push(`imagen descargada: ${img.base64.length} chars base64, mime=${img.mimeType}`);
        const analisis = await analizarImagenConGemini(img.base64, img.mimeType);
        log.push(`analisis: ${JSON.stringify(analisis)}`);
        log.push(`gemini ultimo error: ${global._geminiUltimoError || 'ninguno'}`);
        log.push(`gemini ultima respuesta: ${global._geminiUltimaRespuesta || 'ninguna'}`);
        return json(res, 200, { ok: true, log, analisis });
      } catch (e) {
        log.push(`ERROR: ${e.message}`);
        return json(res, 500, { error: e.message, log });
      }
    })();
    return;
  }

  // ── GET /api/telegram-updates — diagnóstico: lista chat_ids recientes del bot ──
  if (req.method === 'GET' && req.url === '/api/telegram-updates') {
    (async () => {
      try {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return json(res, 400, { error: 'no token' });
        const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
        const data = await r.json();
        const chats = {};
        for (const u of (data.result || [])) {
          const m = u.message || u.edited_message || u.channel_post;
          if (!m || !m.chat) continue;
          chats[m.chat.id] = {
            chat_id: m.chat.id,
            type: m.chat.type,
            title: m.chat.title || null,
            firstName: m.chat.first_name || null,
            lastName: m.chat.last_name || null,
            username: m.chat.username || null,
            ultimoMensaje: m.text || m.caption || '(sin texto)',
            fecha: new Date((m.date || 0) * 1000).toISOString(),
          };
        }
        return json(res, 200, { ok: true, chats: Object.values(chats), totalRaw: (data.result || []).length });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/tablero/foto — recibe foto del tablero físico, la procesa con Gemini ──
  // Body JSON: { base64: "...", mimeType: "image/jpeg" }
  // Aplica los cambios a pedidos y manda resumen por Telegram a Duvan.
  if (req.method === 'POST' && req.url === '/api/tablero/foto') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { base64, mimeType } = JSON.parse(body);
        if (!base64) return json(res, 400, { error: 'falta base64' });
        const estructura = await analizarTableroConGemini(base64, mimeType || 'image/jpeg');
        if (!estructura) {
          return json(res, 500, { error: 'gemini fallo', detalle: global._tableroUltimoError });
        }
        const resultado = aplicarTableroAPedidos(estructura);
        // Construir mensaje para Telegram
        const total = (estructura.aprobados||[]).length + (estructura.ventas||[]).length + (estructura.enviados||[]).length + (estructura.hacerDisenos||[]).length;
        let msg = `📋 *Tablero leído* (${total} entradas)\n\n`;
        msg += `✅ Ya estaban en la app: ${resultado.yaCorrectos.length}\n`;
        msg += `🔄 Movidos a su columna: ${resultado.movidos.length}\n`;
        msg += `🆕 Pedidos nuevos creados: ${resultado.creados.length}\n`;
        if (resultado.movidos.length) {
          msg += `\n*Movidos:*\n`;
          resultado.movidos.slice(0, 10).forEach(m => { msg += `• #${m.id} ${m.equipo}: ${m.de} → ${m.a}\n`; });
          if (resultado.movidos.length > 10) msg += `...y ${resultado.movidos.length - 10} más\n`;
        }
        if (resultado.creados.length) {
          msg += `\n*Nuevos (revisar vendedora):*\n`;
          resultado.creados.slice(0, 10).forEach(c => { msg += `• #${c.id} ${c.equipo} (${c.columna})\n`; });
          if (resultado.creados.length > 10) msg += `...y ${resultado.creados.length - 10} más\n`;
        }
        notificarTelegramDuvan(msg).catch(() => {});
        return json(res, 200, { ok: true, estructura, resultado, total });
      } catch (e) {
        console.error('[tablero] error', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/evolution-webhook — Webhook principal para Evolution API ──
  if (req.method === 'POST' && req.url.startsWith('/api/evolution-webhook')) {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body);
        // Marca de versión para diagnóstico
        if (!global._reaccionesLoaded) { console.log('[boot] sprint-1 reacciones cargado'); global._reaccionesLoaded = true; }
        
        // 1. Guardar log crudo para debug (en SQLite)
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // Formato YYYY-MM-DD
        db.insertEvolutionEvent(hoy, payload);

        // 2. Seguridad Básica: Validar Token (por query ?token=... o header apikey)
        const urlParams = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
        const token = urlParams.get('token') || req.headers['apikey'];
        const SECRETO = 'ws_secret_2026'; // ¡Cámbialo si prefieres otro!
        
        // Si no coincide el secreto, solo logueamos pero rechazamos la acción
        if (token !== SECRETO) {
           console.log(`[evolution-webhook] Intento rechazado por token inválido: ${token}`);
           return json(res, 401, { error: 'Token inválido' });
        }

        let accionRealizada = false;
        let resultadoApi = null;

        // 3. Procesar el Evento de Evolution
        const eventType = payload.event;
        const eventData = payload.data || payload;

        // LÓGICA DE ETIQUETAS (LABELS)
        // Buscamos cuando se añade una etiqueta
        if (eventType === 'labels.association' || eventType === 'presence.update' || eventData?.action === 'add') {
            
            // Adaptamos según cómo venga la estructura (lo confirmaremos con los logs)
            const action = eventData.action; 
            const labelName = eventData.label?.name || eventData.labelName || '';
            const remoteJid = eventData.chat?.id || eventData.remoteJid || eventData.number || '';
            const pushName = eventData.chat?.contact?.pushName || eventData.pushName || 'Cliente WA';

            // Detectar la etiqueta objetivo "En proceso"
            if (action === 'add' && labelName.includes('En proceso')) {
                 const telefono = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, ''); // Limpiar a solo números
                 const vendedora = 'Betty'; // Asignación automática a Betty

                 // Deduplicación: no crear si ya hay un pedido "confirmado" de este número hoy/este mes
                 const pedidos = leerPedidos();
                 const mesActual = new Date().toLocaleDateString('es-CO').slice(-7);
                 const pdExistente = pedidos.find(p => p.telefono.replace(/\D/g, '') === telefono && (p.creadoEn || '').slice(-7) === mesActual && p.estado === 'confirmado');
                 
                 if (!pdExistente && telefono.length > 5) {
                     resultadoApi = crearVentaInterna('pedido', vendedora, telefono, null, pushName);
                     
                     if (resultadoApi.ok) {
                         // Forzamos el estado a 'confirmado' para asegurar que salte a producción
                         const pedidosPost = leerPedidos();
                         const nuevoPd = pedidosPost.find(p => p.id === resultadoApi.id);
                         if (nuevoPd) {
                             nuevoPd.estado = 'confirmado';
                             nuevoPd.ultimoMovimiento = new Date().toISOString();
                             guardarPedidos(pedidosPost, leerNextId());
                         }
                     }
                     accionRealizada = true;
                     console.log(`[evolution-webhook] Etiqueta 'En proceso' detectada. Pedido #${resultadoApi.id || 'N/A'} creado para ${telefono}`);
                 } else if (pdExistente) {
                     console.log(`[evolution-webhook] Etiqueta ignorada, el pedido para ${telefono} ya existe en estado confirmado.`);
                 }
            }
        }

        // ─────────────────────────────────────────────────────────────
        // LÓGICA DE REACCIONES — Sprint 1 Cero Clics
        // 🟡 = cotización (crea pedido en bandeja, tipo cotizar)
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType === 'reactionMessage') {
          try {
            const reaccion = eventData.message?.reactionMessage || {};
            const emoji = reaccion.text || '';
            const senderJid = payload.sender || ''; // ej: 573506974711@s.whatsapp.net
            const remoteJid = eventData.key?.remoteJid || ''; // chat donde se reaccionó
            const pushName = eventData.pushName || '';
            // Vendedora derivada de la instancia Evolution (ws-ventas → Betty, ws-ney → Ney, etc.)
            const vendedora = vendedoraDeInstancia(payload.instance);

            // Solo procesar si la reacción la hizo el dueño del WhatsApp Business (Betty/Ney/Wendy/Paola).
            // Evolution a veces no rellena payload.sender en chats 1-a-1, así que también aceptamos key.fromMe=true
            // que es la señal autoritativa de Baileys de "este mensaje/reacción salió desde mi propio WA".
            const numeroPropio = (process.env.WS_PROPIO_NUMERO || '573506974711');
            const senderNumero = senderJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            const fromMe = eventData.key?.fromMe === true;
            const esDeNuestroWA = fromMe || senderNumero === numeroPropio;

            // Mapeo de emoji → acción
            const MAPA_REACCIONES = {
              '🟡': { accion: 'cotizar', tipoBandeja: 'cotizar', estadoFinal: 'bandeja' },
              '🎨': { accion: 'diseno-confirmado', tipoBandeja: 'pedido', estadoFinal: 'confirmado', requierePedidoEnHacerDiseno: true },
              // === Cierre de flujo de taller ===
              '📦': { accion: 'llego-impresion', avancePedido: { de: 'enviado-calandra', a: 'llego-impresion' } },
              '🪡': { accion: 'costura-lista', avancePedido: { de: 'llego-impresion', a: 'listo' } },
              '🧵': { accion: 'costura-lista', avancePedido: { de: 'llego-impresion', a: 'listo' } },
              '✅': { accion: 'entregado', avancePedido: { de: 'listo', a: 'enviado-final' } },
            };
            const config = MAPA_REACCIONES[emoji];

            if (config && esDeNuestroWA) {
              const telefonoCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
              const { nombre: nombreCliente, contactoChatwoot } = await resolverCliente(remoteJid, telefonoCliente, pushName);

              console.log(`[reaccion] ${emoji} — cliente:${telefonoCliente} nombre:"${nombreCliente}" cw:${contactoChatwoot||'-'}`);

              const REACCIONES_ACTIVAS = process.env.REACCIONES_ACTIVAS === 'true';
              const fechaCorta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric' });
              const telBonito = telefonoCliente.startsWith('57') ? `+${telefonoCliente.slice(0,2)} ${telefonoCliente.slice(2,5)} ${telefonoCliente.slice(5,8)} ${telefonoCliente.slice(8)}` : telefonoCliente;

              if (!REACCIONES_ACTIVAS) {
                console.log(`[reaccion] MODO LOG ONLY — ${config.accion} para ${telefonoCliente}`);
                resultadoApi = { ok: true, modo: 'log-only', emoji, telefono: telefonoCliente, nombreCliente };
              } else if (telefonoCliente.length > 5) {
                const pedidos = leerPedidos();

                // === 🎨 DISEÑO CONFIRMADO: avanzar pedido existente en hacer-diseno → confirmado ===
                if (config.requierePedidoEnHacerDiseno) {
                  const pedidoEnDiseno = pedidos.find(p => {
                    const pTel = String(p.telefono || '').replace(/\D/g, '');
                    return pTel === telefonoCliente && p.estado === 'hacer-diseno';
                  });
                  if (!pedidoEnDiseno) {
                    console.log(`[reaccion] 🎨 ignorada — no hay pedido en hacer-diseno para ${telefonoCliente}`);
                    resultadoApi = { ok: true, sinPedido: true, motivo: 'no hay pedido en hacer-diseno' };
                  } else {
                    pedidoEnDiseno.estado = 'confirmado';
                    pedidoEnDiseno.ultimoMovimiento = new Date().toISOString();
                    pedidoEnDiseno.disenoEnviado = true;
                    pedidoEnDiseno.fechaDisenoEnviado = new Date().toISOString();
                    if (contactoChatwoot && !pedidoEnDiseno.contactoChatwoot) pedidoEnDiseno.contactoChatwoot = contactoChatwoot;
                    guardarPedidos(pedidos, leerNextId());
                    accionRealizada = true;
                    console.log(`[reaccion] 🎨 → pedido #${pedidoEnDiseno.id} avanzó hacer-diseno → confirmado (${nombreCliente})`);
                    resultadoApi = { ok: true, accion: 'avanzado', id: pedidoEnDiseno.id, estadoAnterior: 'hacer-diseno', estadoNuevo: 'confirmado' };

                    // Notificar
                    const msgTG =
                      `🎨 *Diseño enviado al cliente* #${pedidoEnDiseno.id}\n\n` +
                      `👤 *Cliente:* ${nombreCliente}\n` +
                      `📞 ${telBonito}\n` +
                      `📅 ${fechaCorta}\n\n` +
                      `✅ Pedido pasa a *Confirmado*`;
                    notificarTelegram(msgTG).catch(()=>{});

                    const msgWA =
                      `🎨 Diseño enviado al cliente  #${pedidoEnDiseno.id}\n\n` +
                      `👤 Cliente: ${nombreCliente}\n` +
                      `📞 ${telBonito}\n` +
                      `📅 ${fechaCorta}\n\n` +
                      `✅ Pedido pasa a Confirmado`;
                    notificarWhatsappTrabajoFamilia(msgWA).catch(()=>{});

                    if (contactoChatwoot) {
                      etiquetarChatwootContacto(contactoChatwoot, 'confirmado').catch(()=>{});
                    }
                  }
                }
                // === 🟡 COTIZACIÓN: crear pedido nuevo en bandeja ===
                else {
                  const haceUnaHora = Date.now() - (60 * 60 * 1000);
                  const pdReciente = pedidos.find(p => {
                    const pTel = String(p.telefono || '').replace(/\D/g, '');
                    if (pTel !== telefonoCliente) return false;
                    const ultMov = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
                    return ultMov > haceUnaHora;
                  });
                  if (pdReciente) {
                    console.log(`[reaccion] ${emoji} ignorada — pedido reciente #${pdReciente.id} (<1h)`);
                    resultadoApi = { ok: true, duplicado: true, idExistente: pdReciente.id };
                  } else {
                    resultadoApi = crearVentaInterna(config.tipoBandeja, vendedora, telefonoCliente, null, nombreCliente);
                    if (resultadoApi.ok) {
                      const pp = leerPedidos();
                      const nuevoPd = pp.find(p => p.id === resultadoApi.id);
                      if (nuevoPd) {
                        nuevoPd.estado = config.estadoFinal;
                        nuevoPd.tipoBandeja = config.tipoBandeja;
                        nuevoPd.ultimoMovimiento = new Date().toISOString();
                        nuevoPd.emojiTrigger = emoji;
                        if (contactoChatwoot) nuevoPd.contactoChatwoot = contactoChatwoot;
                        guardarPedidos(pp, leerNextId());
                      }
                      accionRealizada = true;
                      console.log(`[reaccion] ${emoji} → cotización #${resultadoApi.id} creada (vendedora=${vendedora}, ${nombreCliente})`);

                      const msgTG =
                        `🟡 *Cotización nueva — DISEÑAR* #${resultadoApi.id}\n\n` +
                        `👤 *Cliente:* ${nombreCliente}\n` +
                        `📞 ${telBonito}\n` +
                        `🛍️ *Vendedora:* ${vendedora}\n` +
                        `📅 ${fechaCorta}\n\n` +
                        `⚠️ Hay que hacer diseño para este cliente\n` +
                        `👉 Revisar la conversación`;
                      notificarTelegram(msgTG).catch(()=>{});

                      const msgWA =
                        `🟡 Cotización nueva — DISEÑAR  #${resultadoApi.id}\n\n` +
                        `👤 Cliente: ${nombreCliente}\n` +
                        `📞 ${telBonito}\n` +
                        `🛍️ Vendedora: ${vendedora}\n` +
                        `📅 ${fechaCorta}\n\n` +
                        `⚠️ Hay que hacer diseño para este cliente\n` +
                        `👉 Revisar la conversación`;
                      notificarWhatsappTrabajoFamilia(msgWA).catch(()=>{});

                      if (contactoChatwoot) {
                        etiquetarChatwootContacto(contactoChatwoot, 'cotizacion').catch(()=>{});
                      }
                    }
                  }
                }
              }
            } else if (config && !esDeNuestroWA) {
              console.log(`[reaccion] ${emoji} ignorada — no vino de nuestro WA (sender=${senderJid} fromMe=${fromMe})`);
            }
          } catch (errReact) {
            console.error('[reaccion error]', errReact);
          }
        }

        // ─────────────────────────────────────────────────────────────
        // LÓGICA DE STICKERS — Sprint 1B
        // Sticker VENTA CONFIRMADA → avanza cotización a 'confirmado',
        // o crea pedido nuevo si no había cotización previa.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType === 'stickerMessage') {
          try {
            const sticker = eventData.message?.stickerMessage || {};
            const stickerHash = sticker.fileSha256 ? Buffer.from(Object.values(sticker.fileSha256)).toString('hex') : '';
            const senderJid = payload.sender || '';
            const remoteJid = eventData.key?.remoteJid || '';
            const fromMe = eventData.key?.fromMe;
            const pushName = eventData.pushName || '';
            // Vendedora derivada de la instancia que envió el evento
            const vendedora = vendedoraDeInstancia(payload.instance);

            // Mapa de stickers conocidos → acción
            const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620').split(',').map(s => s.trim()).filter(Boolean);

            const numeroPropio = (process.env.WS_PROPIO_NUMERO || '573506974711');
            const senderNumero = senderJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            // fromMe es la señal autoritativa de Baileys: el sticker salió desde nuestro WA.
            // payload.sender puede venir vacío en chats 1-a-1, así que no podemos depender solo de eso.
            const esDeNuestroWA = fromMe === true || senderNumero === numeroPropio;

            const esStickerVenta = STICKERS_VENTA.includes(stickerHash);

            if (esStickerVenta && esDeNuestroWA) {
              // Sticker mandado DESDE el WA de ventas hacia un cliente
              const telefonoCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
              const { nombre: nombreCliente, contactoChatwoot } = await resolverCliente(remoteJid, telefonoCliente, pushName);

              console.log(`[sticker-venta] hash detectado — cliente:${telefonoCliente} nombre:"${nombreCliente}"`);

              const REACCIONES_ACTIVAS = process.env.REACCIONES_ACTIVAS === 'true';
              if (!REACCIONES_ACTIVAS) {
                console.log('[sticker-venta] MODO LOG ONLY — REACCIONES_ACTIVAS=false');
                resultadoApi = { ok: true, modo: 'log-only', accion: 'venta-confirmada', telefono: telefonoCliente, nombreCliente };
              } else if (telefonoCliente.length > 5) {
                const pedidos = leerPedidos();
                // Buscar cotización existente del cliente (estado=bandeja, tipoBandeja=cotizar)
                const cotizacion = pedidos.find(p => {
                  const pTel = String(p.telefono || '').replace(/\D/g, '');
                  return pTel === telefonoCliente && p.estado === 'bandeja' && (p.tipoBandeja || 'cotizar') === 'cotizar';
                });

                if (cotizacion) {
                  // AVANZAR cotización existente: pasa a Pedidos Confirmados con estado "hacer-diseno"
                  cotizacion.tipoBandeja = 'pedido';
                  cotizacion.estado = 'hacer-diseno';
                  cotizacion.ultimoMovimiento = new Date().toISOString();
                  cotizacion.stickerVenta = stickerHash;
                  cotizacion.fechaVenta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
                  // Auto-asignar diseñador si la vendedora también diseña (Ney/Wendy/Paola)
                  if (VENDEDORAS_DISENADORAS.has(vendedora) && !cotizacion.disenadorAsignado) {
                    cotizacion.disenadorAsignado = vendedora;
                  }
                  guardarPedidos(pedidos, leerNextId());
                  console.log(`[sticker-venta] cotización #${cotizacion.id} → hacer-diseno (vendedora=${vendedora}, dis=${cotizacion.disenadorAsignado||'-'}) (${nombreCliente})`);
                  resultadoApi = { ok: true, accion: 'avanzado', id: cotizacion.id };
                  accionRealizada = true;
                } else {
                  // No hay cotización previa — crear pedido directo en confirmado
                  // Dedupe: evitar duplicar si ya hay pedido confirmado del mismo cliente en última hora
                  const haceUnaHora = Date.now() - (60 * 60 * 1000);
                  const pdReciente = pedidos.find(p => {
                    const pTel = String(p.telefono || '').replace(/\D/g, '');
                    if (pTel !== telefonoCliente) return false;
                    if (p.estado !== 'confirmado') return false;
                    const ultMov = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
                    return ultMov > haceUnaHora;
                  });
                  if (pdReciente) {
                    console.log(`[sticker-venta] ignorado — pedido #${pdReciente.id} reciente del mismo cliente`);
                    resultadoApi = { ok: true, duplicado: true, idExistente: pdReciente.id };
                  } else {
                    resultadoApi = crearVentaInterna('pedido', vendedora, telefonoCliente, null, nombreCliente);
                    if (resultadoApi.ok) {
                      const pp = leerPedidos();
                      const nuevoPd = pp.find(p => p.id === resultadoApi.id);
                      if (nuevoPd) {
                        // Si ya existía pedido del mismo cliente este mes (creado manual), avanza ese.
                        // Si era pedido nuevo, lo deja en hacer-diseno.
                        nuevoPd.estado = 'hacer-diseno';
                        nuevoPd.tipoBandeja = 'pedido';
                        nuevoPd.ultimoMovimiento = new Date().toISOString();
                        nuevoPd.stickerVenta = stickerHash;
                        nuevoPd.fechaVenta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
                        if (contactoChatwoot) nuevoPd.contactoChatwoot = contactoChatwoot;
                        // Auto-asignar diseñador si la vendedora también diseña (solo si no tenia)
                        if (VENDEDORAS_DISENADORAS.has(vendedora) && !nuevoPd.disenadorAsignado) {
                          nuevoPd.disenadorAsignado = vendedora;
                        }
                        guardarPedidos(pp, leerNextId());
                      }
                      accionRealizada = true;
                      const kind = resultadoApi.duplicado ? 'ACTUALIZADO (ya existía manual)' : 'NUEVO';
                      console.log(`[sticker-venta] pedido ${kind} #${resultadoApi.id} (vendedora=${vendedora}, ${nombreCliente})`);
                    } else {
                      console.error(`[sticker-venta] FALLO crearVentaInterna: ${resultadoApi.error || 'error desconocido'}`);
                    }
                  }
                }

                // Notificaciones (solo si hubo acción real, no si fue duplicado)
                if (accionRealizada && resultadoApi?.id) {
                  const fechaCorta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric' });
                  const telBonito = telefonoCliente.startsWith('57') ? `+${telefonoCliente.slice(0,2)} ${telefonoCliente.slice(2,5)} ${telefonoCliente.slice(5,8)} ${telefonoCliente.slice(8)}` : telefonoCliente;
                  const tipoMsg = (resultadoApi.accion === 'avanzado') ? 'Cotización CONFIRMADA' : 'Venta nueva (sin cotización previa)';

                  // Si la vendedora se auto-asignó como diseñadora, lo mostramos en el mensaje
                  const lineaDis = VENDEDORAS_DISENADORAS.has(vendedora)
                    ? `\n🎨 *Diseñadora:* ${vendedora}` : '';

                  const msgTG =
                    `💰 *VENTA CONFIRMADA* #${resultadoApi.id}\n\n` +
                    `${tipoMsg === 'Cotización CONFIRMADA' ? '✅ El cliente ya pagó' : '✅ Cliente pagó directo'}\n\n` +
                    `👤 *Cliente:* ${nombreCliente}\n` +
                    `📞 ${telBonito}\n` +
                    `🛍️ *Vendedora:* ${vendedora}${lineaDis}\n` +
                    `📅 ${fechaCorta}\n\n` +
                    `🎨 Pedido en *Hacer diseño* — diseñador a trabajar`;
                  notificarTelegram(msgTG).catch(()=>{});

                  const lineaDisWA = VENDEDORAS_DISENADORAS.has(vendedora)
                    ? `\n🎨 Diseñadora: ${vendedora}` : '';
                  const msgWA =
                    `💰 VENTA CONFIRMADA  #${resultadoApi.id}\n\n` +
                    `✅ ${tipoMsg === 'Cotización CONFIRMADA' ? 'El cliente ya pagó' : 'Cliente pagó directo'}\n\n` +
                    `👤 Cliente: ${nombreCliente}\n` +
                    `📞 ${telBonito}\n` +
                    `🛍️ Vendedora: ${vendedora}${lineaDisWA}\n` +
                    `📅 ${fechaCorta}\n\n` +
                    `🎨 Pedido en Hacer diseño — diseñador a trabajar`;
                  notificarWhatsappTrabajoFamilia(msgWA).catch(()=>{});

                  // Cambiar etiqueta Chatwoot: cotizacion → venta-confirmada
                  if (contactoChatwoot) {
                    etiquetarChatwootContacto(contactoChatwoot, 'venta-confirmada').catch(()=>{});
                  }

                  // Marcar como stickerEnviado=true los comprobantes recientes (≤48h) del mismo cliente
                  // Así el reporte de "stickers faltantes" no avisa de ventas ya confirmadas.
                  try {
                    const compList = db.leerComprobantes();
                    const hace48h = Date.now() - 48 * 60 * 60 * 1000;
                    let marcados = 0;
                    compList.forEach(c => {
                      const cTel = String(c.telefono || '').replace(/\D/g, '');
                      const cTs = c.ts ? new Date(c.ts).getTime() : 0;
                      if (cTel === telefonoCliente && cTs > hace48h && !c.stickerEnviado) {
                        c.stickerEnviado = true;
                        marcados++;
                      }
                    });
                    if (marcados > 0) {
                      db.guardarComprobantes(compList);
                      console.log(`[sticker-venta] marcados ${marcados} comprobantes con stickerEnviado=true (cliente ${telefonoCliente})`);
                    }
                  } catch (eMarcar) { console.error('[marcar-comprobantes]', eMarcar); }
                }
              }
            } else if (esStickerVenta && !esDeNuestroWA) {
              console.log('[sticker-venta] ignorado — no vino del WA propio');
            } else if (stickerHash) {
              console.log(`[sticker] otro sticker recibido (hash:${stickerHash.slice(0,16)}...) — sin acción mapeada`);
            }
          } catch (errSticker) {
            console.error('[sticker error]', errSticker);
          }
        }

        // ─────────────────────────────────────────────────────────────
        // DETECTOR DE COMPROBANTES — imagen entrante del cliente → Gemini Flash
        // Solo procesa imagenes que el CLIENTE manda (fromMe=false), nunca las nuestras.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType === 'imageMessage') {
          try {
            const fromMe = eventData.key?.fromMe === true;
            const remoteJid = eventData.key?.remoteJid || '';
            const esGrupo = remoteJid.endsWith('@g.us');
            // Solo imagenes entrantes del cliente en chat 1-a-1
            if (!fromMe && !esGrupo && remoteJid && process.env.GEMINI_API_KEY) {
              const vendedora = vendedoraDeInstancia(payload.instance);
              const telefonoCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
              const pushName = eventData.pushName || '';

              // Procesar en background (no bloquear webhook)
              (async () => {
                try {
                  const img = await descargarImagenEvolution(payload.instance, eventData.key);
                  if (!img || !img.base64) {
                    console.log(`[comprobante] no se pudo descargar imagen de ${telefonoCliente}`);
                    return;
                  }
                  const analisis = await analizarImagenConGemini(img.base64, img.mimeType);
                  if (!analisis) return;

                  if (analisis.esComprobante) {
                    const { nombre: nombreCliente } = await resolverCliente(remoteJid, telefonoCliente, pushName);
                    const registro = {
                      ts: new Date().toISOString(),
                      vendedora,
                      cliente: nombreCliente,
                      telefono: telefonoCliente,
                      banco: analisis.banco || 'desconocido',
                      monto: analisis.monto || null,
                      fecha: analisis.fecha || null,
                      confianza: analisis.confianza || 'media',
                      messageId: eventData.key?.id || null,
                      remoteJid,
                      stickerEnviado: false, // se actualiza si despues llega el sticker
                    };
                    guardarComprobanteDetectado(registro);
                    console.log(`[comprobante] DETECTADO ${vendedora} ← ${nombreCliente} ${analisis.banco} $${analisis.monto||'?'} (confianza=${analisis.confianza})`);
                  } else {
                    console.log(`[comprobante] NO es comprobante (${vendedora} ← ${telefonoCliente})`);
                  }
                } catch (e) {
                  console.error('[comprobante async error]', e.message);
                }
              })();
            }
          } catch (errImg) {
            console.error('[imagen error]', errImg);
          }
        }

        return json(res, 200, { ok: true, webhook_recibido: true, accionRealizada, resultadoApi });
      } catch (e) {
        console.error('[evolution webhook error]', e);
        return json(res, 200, { ok: true, aviso: 'Parse error en webhook' });
      }
    });
    return;
  }

  // ── GET /api/evolution-logs — lista fechas disponibles ──
  if (req.method === 'GET' && req.url === '/api/evolution-logs') {
    try {
      const rows = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC').all();
      const archivos = rows.map(r => ({ archivo: r.fecha + '.log', fecha: r.fecha }));
      return json(res, 200, { archivos });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/evolution-logs/:fecha — devuelve eventos del día ──
  if (req.method === 'GET' && req.url.startsWith('/api/evolution-logs/')) {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const fecha = urlObj.pathname.split('/')[3];
      const last = parseInt(urlObj.searchParams.get('last')) || 50;
      const filtro = (urlObj.searchParams.get('filter') || '').toLowerCase();

      const allEvents = db.leerEvolutionEvents(fecha);
      if (!allEvents.length) {
        return json(res, 404, { error: `No hay log para ${fecha}`, sugerencia: 'GET /api/evolution-logs para ver fechas disponibles' });
      }

      let filtrados = filtro ? allEvents.filter(e => JSON.stringify(e).toLowerCase().includes(filtro)) : allEvents;
      const total = filtrados.length;
      filtrados = filtrados.slice(-last);

      const eventos = filtrados.map(payload => ({ payload }));
      return json(res, 200, { fecha, total_en_archivo: allEvents.length, total_filtrado: total, mostrando: eventos.length, eventos });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }


  // ── GET /api/diag-webhooks — revisa qué webhook tiene cada instancia configurado ──
  if (req.method === 'GET' && req.url === '/api/diag-webhooks') {
    (async () => {
      try {
        const INSTANCIAS = ['ws-ventas', 'ws-ney', 'ws-wendy', 'ws wendy', 'ws-paola', 'ws-duvan'];
        const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-19cd.up.railway.app';
        const KEY = process.env.EVOLUTION_API_KEY || '';
        const WEBHOOK_ESPERADO = `${req.headers.host ? 'https://' + req.headers.host : 'https://ws-app-interna-production.up.railway.app'}/api/evolution-webhook?token=ws_secret_2026`;
        const out = [];
        for (const inst of INSTANCIAS) {
          try {
            const r = await fetch(`${EVO}/webhook/find/${encodeURIComponent(inst)}`, { headers: { apikey: KEY } });
            const data = r.ok ? await r.json() : null;
            const url = data?.url || data?.webhook?.url || '(sin webhook)';
            const enabled = data?.enabled !== false;
            const events = data?.events || data?.webhook?.events || [];
            out.push({ instancia: inst, status: r.status, url, enabled, events_count: Array.isArray(events) ? events.length : 0, url_correcta: url === WEBHOOK_ESPERADO });
          } catch (e) {
            out.push({ instancia: inst, error: e.message });
          }
        }
        return json(res, 200, { webhook_esperado: WEBHOOK_ESPERADO, instancias: out });
      } catch (e) { return json(res, 500, { error: e.message }); }
    })();
    return;
  }

  // ── POST /api/setup-webhook/:instancia — configura el webhook de una instancia ──
  if (req.method === 'POST' && req.url.startsWith('/api/setup-webhook/')) {
    (async () => {
      try {
        const inst = decodeURIComponent(req.url.split('/').pop());
        const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-19cd.up.railway.app';
        const KEY = process.env.EVOLUTION_API_KEY || '';
        const WEBHOOK_URL = `${req.headers.host ? 'https://' + req.headers.host : 'https://ws-app-interna-production.up.railway.app'}/api/evolution-webhook?token=ws_secret_2026`;
        const body = {
          webhook: {
            url: WEBHOOK_URL,
            enabled: true,
            webhookByEvents: false,
            webhookBase64: false,
            events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONTACTS_UPSERT', 'CHATS_UPSERT', 'SEND_MESSAGE'],
          },
        };
        const r = await fetch(`${EVO}/webhook/set/${encodeURIComponent(inst)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: KEY },
          body: JSON.stringify(body),
        });
        const data = await r.text();
        return json(res, 200, { ok: r.ok, status: r.status, instancia: inst, webhook_url: WEBHOOK_URL, respuesta: data.slice(0, 500) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    })();
    return;
  }

  // ── POST /api/marcar-stickers-retroactivo ──
  // Reprocesa stickers de últimos 7 días: crea/marca pedido + DISPARA notificaciones
  // (Telegram a Duvan + WA grupo Trabajo en familia + Chatwoot). Hace exactamente
  // lo mismo que el handler en vivo, para arreglar stickers que llegaron pero el
  // handler falló (timeout, Chatwoot caído, etc).
  if (req.method === 'POST' && req.url === '/api/marcar-stickers-retroactivo') {
    (async () => {
      try {
        const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 7').all().map(r => r.fecha);
        const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620').split(',').map(s => s.trim());
        function normTel(t) {
          const d = String(t || '').replace(/\D/g, '');
          return d.startsWith('57') ? d.slice(2) : d;
        }
        const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
        const procesados = [];
        const skippedYaHecho = [];
        const errores = [];

        // Junta TODOS los stickers válidos de los últimos 7 días
        const candidatos = [];
        for (const fecha of fechas) {
          const events = db.leerEvolutionEvents(fecha);
          for (const payload of events) {
            const ed = payload.data || payload;
            if (ed?.messageType !== 'stickerMessage') continue;
            if (ed.key?.fromMe !== true) continue;
            const stk = ed.message?.stickerMessage || {};
            const hash = stk.fileSha256 ? Buffer.from(Object.values(stk.fileSha256)).toString('hex') : '';
            if (!STICKERS_VENTA.includes(hash)) continue;
            const remoteJid = ed.key?.remoteJid || '';
            const telCli = normTel(remoteJid.replace('@s.whatsapp.net', ''));
            if (!telCli) continue;
            const vendedora = vendedoraDeInstancia(payload.instance);
            if (!VENDEDORAS_VALIDAS.includes(vendedora.toLowerCase())) continue;
            candidatos.push({ fecha, hash, telCli, remoteJid, vendedora, instance: payload.instance, ts: ed.messageTimestamp || 0 });
          }
        }

        for (const c of candidatos) {
          try {
            // Skip si ya hay pedido del cliente con el mismo sticker (ya procesado antes)
            const pedidosActual = leerPedidos();
            const yaHecho = pedidosActual.find(p => normTel(p.telefono) === c.telCli && p.stickerVenta === c.hash);
            if (yaHecho) {
              skippedYaHecho.push({ id: yaHecho.id, telCli: c.telCli, vendedora: c.vendedora });
              continue;
            }

            // Resolver nombre del cliente
            let nombreCliente = '';
            let contactoChatwoot = null;
            try {
              const r = await resolverCliente(c.remoteJid, c.telCli, '');
              nombreCliente = r.nombre;
              contactoChatwoot = r.contactoChatwoot;
            } catch (e) { nombreCliente = `Cliente +57 ${c.telCli}`; }

            // Buscar pedido existente del cliente este mes (sin sticker)
            const mesActual = new Date().toLocaleDateString('es-CO').slice(-7);
            const pdExistente = pedidosActual.find(p => {
              if (p.estado === 'enviado-final') return false;
              if (normTel(p.telefono) !== c.telCli) return false;
              const pMes = (p.creadoEn || '').slice(-7);
              return pMes === mesActual;
            });

            let pdProcesado;
            if (pdExistente) {
              // Actualizar pedido existente
              pdExistente.estado = pdExistente.estado === 'bandeja' ? 'hacer-diseno' : pdExistente.estado;
              pdExistente.tipoBandeja = 'pedido';
              pdExistente.ultimoMovimiento = new Date().toISOString();
              pdExistente.stickerVenta = c.hash;
              pdExistente.fechaVenta = pdExistente.fechaVenta || new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
              if (contactoChatwoot) pdExistente.contactoChatwoot = contactoChatwoot;
              if (VENDEDORAS_DISENADORAS.has(c.vendedora) && !pdExistente.disenadorAsignado) {
                pdExistente.disenadorAsignado = c.vendedora;
              }
              if (!pdExistente.equipo && nombreCliente) pdExistente.equipo = nombreCliente;
              pdProcesado = pdExistente;
              guardarPedidos(pedidosActual, leerNextId());
            } else {
              // Crear pedido nuevo
              const resCrear = crearVentaInterna('pedido', c.vendedora, c.telCli, null, nombreCliente);
              if (!resCrear.ok) { errores.push({ telCli: c.telCli, error: resCrear.error }); continue; }
              const pp = leerPedidos();
              const nuevo = pp.find(p => p.id === resCrear.id);
              if (nuevo) {
                nuevo.estado = 'hacer-diseno';
                nuevo.tipoBandeja = 'pedido';
                nuevo.ultimoMovimiento = new Date().toISOString();
                nuevo.stickerVenta = c.hash;
                nuevo.fechaVenta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
                if (contactoChatwoot) nuevo.contactoChatwoot = contactoChatwoot;
                if (VENDEDORAS_DISENADORAS.has(c.vendedora)) nuevo.disenadorAsignado = c.vendedora;
                guardarPedidos(pp, leerNextId());
                pdProcesado = nuevo;
              }
            }

            if (!pdProcesado) continue;

            // ── DISPARAR NOTIFICACIONES (igual que el handler en vivo) ──
            const fechaCorta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric' });
            const telBonito = c.telCli.startsWith('57') ? `+${c.telCli.slice(0,2)} ${c.telCli.slice(2,5)} ${c.telCli.slice(5,8)} ${c.telCli.slice(8)}` : c.telCli;
            const lineaDis = VENDEDORAS_DISENADORAS.has(c.vendedora) ? `\n🎨 *Diseñadora:* ${c.vendedora}` : '';

            const msgTG =
              `💰 *VENTA CONFIRMADA* #${pdProcesado.id}\n\n` +
              `${pdExistente ? '✅ El cliente ya pagó' : '✅ Cliente pagó directo'}\n\n` +
              `👤 *Cliente:* ${nombreCliente}\n` +
              `📞 ${telBonito}\n` +
              `🛍️ *Vendedora:* ${c.vendedora}${lineaDis}\n` +
              `📅 ${fechaCorta}\n\n` +
              `🎨 Pedido en *Hacer diseño* — diseñador a trabajar`;
            notificarTelegram(msgTG).catch(()=>{});

            const lineaDisWA = VENDEDORAS_DISENADORAS.has(c.vendedora) ? `\n🎨 Diseñadora: ${c.vendedora}` : '';
            const msgWA =
              `💰 VENTA CONFIRMADA  #${pdProcesado.id}\n\n` +
              `✅ ${pdExistente ? 'El cliente ya pagó' : 'Cliente pagó directo'}\n\n` +
              `👤 Cliente: ${nombreCliente}\n` +
              `📞 ${telBonito}\n` +
              `🛍️ Vendedora: ${c.vendedora}${lineaDisWA}\n` +
              `📅 ${fechaCorta}\n\n` +
              `🎨 Pedido en Hacer diseño — diseñador a trabajar`;
            notificarWhatsappTrabajoFamilia(msgWA).catch(()=>{});

            if (contactoChatwoot) {
              etiquetarChatwootContacto(contactoChatwoot, 'venta-confirmada').catch(()=>{});
            }

            procesados.push({ id: pdProcesado.id, vendedora: c.vendedora, cliente: nombreCliente, telefono: c.telCli, nuevo: !pdExistente });
          } catch (eItem) {
            errores.push({ telCli: c.telCli, error: eItem.message });
          }
        }

        return json(res, 200, { ok: true, total_candidatos: candidatos.length, procesados, ya_procesados_antes: skippedYaHecho, errores });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── GET /api/diag-stickers — últimos stickers recibidos (para verificar hashes) ──
  if (req.method === 'GET' && req.url.startsWith('/api/diag-stickers')) {
    try {
      const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 7').all().map(r => r.fecha);
      const stickers = [];
      for (const fecha of fechas) {
        const events = db.leerEvolutionEvents(fecha);
        for (const payload of events) {
          const ed = payload.data || payload;
          if (ed?.messageType !== 'stickerMessage') continue;
          const stk = ed.message?.stickerMessage || {};
          const hash = stk.fileSha256 ? Buffer.from(Object.values(stk.fileSha256)).toString('hex') : '';
          const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620').split(',').map(s => s.trim());
          stickers.push({
            fecha,
            instance: payload.instance || '?',
            fromMe: ed.key?.fromMe,
            remoteJid: ed.key?.remoteJid || '',
            hash: hash || '(sin hash)',
            coincide: STICKERS_VENTA.includes(hash),
          });
        }
      }
      stickers.sort((a, b) => b.fecha.localeCompare(a.fecha));
      const hashesConfig = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620').split(',');
      return json(res, 200, { total: stickers.length, hashesConfigurados: hashesConfig, stickers: stickers.slice(0, 50) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/calandra — n8n registra envío de PDF a calandra ─
  // Body: { equipo, alto, ancho?, archivo?, diseñador? }
  // alto en cm, ancho en metros (opcional, default 1.50)
  if (req.method === 'POST' && req.url === '/api/calandra') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { equipo, alto, ancho, archivo, disenador, fechaDrive, semana: semanaBody, createdTime, modifiedTime, driveIndex } = JSON.parse(body);
        if (!equipo || !alto)
          return json(res, 400, { error: 'Faltan campos: equipo, alto' });

        let altoCm  = parseFloat(alto);
        if (isNaN(altoCm) || altoCm < 0) altoCm = 0;

        const metros  = parseFloat((altoCm / 100).toFixed(3));
        let registros = db.leerCalandra();

        // Usar fecha real del PDF si viene, si no usar hoy en Colombia
        const fechaReal = fechaDrive || new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });

        // Calcular semana como el lunes de esa semana (igual que el frontend getSemanaKey)
        function getSemanaKey(fechaStr) {
          const [d, m, y] = fechaStr.split('/');
          const date = new Date(+y, +m - 1, +d);
          date.setHours(0, 0, 0, 0);
          date.setDate(date.getDate() - date.getDay() + 1); // lunes
          return date.toLocaleDateString('es-CO');
        }
        const semana = semanaBody || getSemanaKey(fechaReal);

        // ID único aunque lleguen múltiples en el mismo ms
        const idBase = Date.now();
        const idUnico = registros.length > 0
          ? Math.max(idBase, ...registros.map(r => r.id + 1))
          : idBase;

        const registro = {
          id:          idUnico,
          equipo:      String(equipo).trim(),
          alto:        altoCm,
          metros,
          semana,
          fecha:       fechaReal,
          archivo:     archivo || '',
          disenador:   disenador || '',
          origen:      'drive',
          createdTime: createdTime || null,
          modifiedTime: modifiedTime || null,
          driveIndex:  driveIndex !== undefined ? driveIndex : null,
        };

        // Evitar duplicados por nombre de archivo, pero actualizar driveIndex si ya existe
        const existeIdx = registros.findIndex(r => r.archivo === registro.archivo);
        const yaExiste = existeIdx !== -1;
        if (!yaExiste) {
          registros.push(registro);
        } else if (driveIndex !== undefined && driveIndex !== null) {
          registros[existeIdx].driveIndex = driveIndex;
        }
        db.guardarCalandraArray(registros);

        // PDF en Drive detectado: marca el pedido como "PDF listo" y, si ya hay WT, avanza a enviado-calandra.
        // Acepta múltiples archivos del mismo equipo (Camilo 1.pdf, Camilo 2.pdf, ...).
        let pedidoAutmovido = null;
        if (equipo || archivo) {
           const pedidos = leerPedidos();
           const pd = buscarPedidoPorArchivo(pedidos, archivo, equipo);

           if (pd) {
               if (!pd.pdfDriveListo) {
                   pd.pdfDriveListo = true;
                   pd.fechaPdfDrive = new Date().toISOString();
                   pd.ultimoMovimiento = new Date().toISOString();
                   console.log(`[drive-pdf] #${pd.id} marcado pdfDriveListo (archivo=${archivo})`);
               }
               if (disenador && !pd.disenador) pd.disenador = disenador;
               // Si WT ya llegó antes, avanzar
               if (evaluarPasoCalandra(pd)) pedidoAutmovido = pd.id;
               const nId = leerNextId();
               guardarPedidos(pedidos, nId);
           }
        }

        console.log(`[calandra] ${yaExiste ? 'actualizado driveIndex' : 'registrado'}: ${equipo} — ${altoCm}cm = ${metros}m | ${archivo || ''}`);
        return json(res, 200, { ok: true, metros, equipo, semana, id: registro.id, duplicado: yaExiste, automovimiento: pedidoAutmovido });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── DELETE /api/calandra/reset — limpia todos los registros ──
  if (req.method === 'DELETE' && req.url === '/api/calandra/reset') {
    db.resetCalandra();
    console.log('[calandra] reset completo');
    return json(res, 200, { ok: true, mensaje: 'Calandra limpiada' });
  }

  // ── DELETE /api/calandra/:id — borra un registro ────────────
  if (req.method === 'DELETE' && req.url.startsWith('/api/calandra/')) {
    const id = req.url.split('/')[3];
    const registros = db.leerCalandra();
    const antes = registros.length;
    const nuevos = registros.filter(r => String(r.id) !== String(id));
    db.guardarCalandraArray(nuevos);
    console.log(`[calandra] borrado id=${id}, quedaron ${nuevos.length}/${antes}`);
    return json(res, 200, { ok: true, borrado: antes !== nuevos.length });
  }

  // ── GET /api/drive-pdfs — todos los PDFs de Drive ordenados por fecha real ──
  if (req.method === 'GET' && req.url === '/api/drive-pdfs') {
    let registros = db.leerCalandra();
    let enviados = new Set();
    try {
      const wt = db.leerPendientesWt();
      const pendientes = (wt.pendientes || []).map(p => p.nombre.toLowerCase());
      registros.forEach(r => {
        const nombre = (r.archivo || '').toLowerCase();
        if (!pendientes.includes(nombre)) enviados.add(nombre);
      });
    } catch {}
    // Ordenar del más nuevo al más viejo por createdTime de Drive (fecha real de subida)
    registros.sort((a, b) => {
      const ta = a.createdTime ? new Date(a.createdTime).getTime() : a.id;
      const tb = b.createdTime ? new Date(b.createdTime).getTime() : b.id;
      return tb - ta;
    });
    const result = registros.map(r => ({
      ...r,
      enviado: enviados.has((r.archivo || '').toLowerCase())
    }));
    return json(res, 200, { pdfs: result });
  }

  // ── GET /api/calandra — devuelve todos los registros ────────
  if (req.method === 'GET' && req.url === '/api/calandra') {
    let registros = db.leerCalandra();
    registros.sort((a, b) => b.id - a.id);
    return json(res, 200, { registros });
  }

  // ── POST /api/wetransfer — registra envío o descarga ────────
  // Body: { tipo: 'enviado'|'descargado', archivo, equipo? }
  if (req.method === 'POST' && req.url === '/api/wetransfer') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, archivo, equipo, gmailId } = JSON.parse(body);
        if (!tipo || !archivo)
          return json(res, 400, { error: 'Faltan campos: tipo, archivo' });
        if (!['enviado', 'descargado'].includes(tipo))
          return json(res, 400, { error: 'tipo debe ser enviado o descargado' });

        const registros = db.leerWetransfer();

        // Evitar duplicados por gmailId
        if (gmailId && registros.some(r => r.gmailId === gmailId))
          return json(res, 200, { ok: true, duplicado: true, gmailId });

        const registro = {
          id:      Date.now(),
          tipo,
          archivo: String(archivo).trim(),
          equipo:  equipo ? String(equipo).trim() : '',
          gmailId: gmailId || null,
          fecha:   new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }),
          hora:    new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }),
          ts:      new Date().toISOString(),
        };

        db.insertWetransfer(registro);

        // Correo WeTransfer detectado: marca el pedido como "WT listo" y, si ya hay PDF, avanza a enviado-calandra.
        let pedidoAutmovido = null;
        if ((tipo === 'enviado' || tipo === 'descargado') && (equipo || archivo)) {
           const pedidos = leerPedidos();
           const pd = buscarPedidoPorArchivo(pedidos, archivo, equipo);

           if (pd) {
               if (!pd.wtListo) {
                   pd.wtListo = true;
                   pd.fechaWt = new Date().toISOString();
                   pd.ultimoMovimiento = new Date().toISOString();
                   console.log(`[wetransfer] #${pd.id} marcado wtListo (archivo=${archivo})`);
               }
               if (evaluarPasoCalandra(pd)) pedidoAutmovido = pd.id;
               const nId = leerNextId();
               guardarPedidos(pedidos, nId);
           }
        }

        console.log(`[wetransfer] ${tipo} — ${archivo} ${equipo ? `(${equipo})` : ''}`);
        return json(res, 200, { ok: true, id: registro.id, tipo, archivo, automovimiento: pedidoAutmovido });

      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/comprobantes-detectados — lista de comprobantes detectados por Gemini ──
  // Query params:
  //   ?desde=hace18h | hace24h | hace7d | YYYY-MM-DD  (default: todos)
  //   ?soloNoProcesados=true   (default: false; n8n usa esto para evitar duplicar avisos)
  //   ?soloSinSticker=true     (default: false; filtra los que aún no tienen pedido movido)
  if (req.method === 'GET' && req.url.startsWith('/api/comprobantes-detectados')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const desde = u.searchParams.get('desde');
      const soloNoProc = u.searchParams.get('soloNoProcesados') === 'true';
      const soloSinSticker = u.searchParams.get('soloSinSticker') === 'true';

      let lista = db.leerComprobantes();

      // Filtro por fecha
      if (desde) {
        let limite = null;
        if (desde.startsWith('hace')) {
          const m = desde.match(/^hace(\d+)([hd])$/);
          if (m) {
            const n = parseInt(m[1]);
            const ms = m[2] === 'h' ? n*60*60*1000 : n*24*60*60*1000;
            limite = Date.now() - ms;
          }
        } else {
          const t = new Date(desde).getTime();
          if (!isNaN(t)) limite = t;
        }
        if (limite) lista = lista.filter(r => new Date(r.ts).getTime() >= limite);
      }

      if (soloNoProc) lista = lista.filter(r => !r.procesado);

      if (soloSinSticker) {
        const pedidosCur = leerPedidos();
        const limite18h = Date.now() - 18*60*60*1000;
        lista = lista.filter(r => {
          const tel = String(r.telefono).replace(/\D/g, '');
          const yaMarcado = pedidosCur.some(p => {
            const pTel = String(p.telefono || '').replace(/\D/g, '');
            if (pTel !== tel) return false;
            if (p.estado === 'bandeja') return false;
            const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
            return t >= limite18h;
          });
          return !yaMarcado;
        });
      }

      lista.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

      // Clasificar cada comprobante cruzando teléfono contra pedidos activos
      // Normaliza ambos lados a 10 dígitos (quita prefijo 57 si existe)
      const pedidosCur = leerPedidos();
      const ESTADOS_ABONO = ['hacer-diseno', 'confirmado', 'listo', 'enviado-calandra', 'llego-impresion'];
      const norm10 = (t) => {
        const d = String(t || '').replace(/\D/g, '');
        return d.startsWith('57') && d.length === 12 ? d.slice(2) : d;
      };
      lista = lista.map(r => {
        const telDet = norm10(r.telefono);
        if (!telDet || telDet.length < 8) return { ...r, clasificacion: 'venta-nueva', pedidoMatch: null };
        const matches = pedidosCur.filter(p => norm10(p.telefono) === telDet);
        const enProceso = matches.find(p => ESTADOS_ABONO.includes(p.estado));
        if (enProceso) {
          return { ...r, clasificacion: 'abono', pedidoMatch: { id: enProceso.id, equipo: enProceso.equipo, estado: enProceso.estado } };
        }
        const cerrado = matches.find(p => p.estado === 'enviado-final');
        if (cerrado) {
          return { ...r, clasificacion: 'cliente-recurrente', pedidoMatch: { id: cerrado.id, equipo: cerrado.equipo, estado: 'enviado-final' } };
        }
        return { ...r, clasificacion: 'venta-nueva', pedidoMatch: null };
      });

      return json(res, 200, { items: lista, total: lista.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/comprobantes-detectados/marcar-procesados ──
  // Body: { messageIds: ['id1','id2',...] }
  // n8n llama esto después de mandar el resumen para no avisar 2 veces los mismos.
  if (req.method === 'POST' && req.url === '/api/comprobantes-detectados/marcar-procesados') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { messageIds } = JSON.parse(body);
        if (!Array.isArray(messageIds)) return json(res, 400, { error: 'messageIds debe ser array' });
        let lista = db.leerComprobantes();
        const idsSet = new Set(messageIds);
        let count = 0;
        lista.forEach(r => {
          if (idsSet.has(r.messageId)) {
            r.procesado = true;
            r.fechaProcesado = new Date().toISOString();
            count++;
          }
        });
        db.guardarComprobantes(lista);
        return json(res, 200, { ok: true, marcados: count });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/comprobantes-detectados/forzar-resumen — dispara el resumen ahora (debug) ──
  if (req.method === 'POST' && req.url === '/api/comprobantes-detectados/forzar-resumen') {
    enviarResumenComprobantes()
      .then(() => json(res, 200, { ok: true, msg: 'Resumen disparado, revisar logs' }))
      .catch(e => json(res, 500, { error: e.message }));
    return;
  }

  // ── GET /api/wetransfer — devuelve todos los registros ──────
  if (req.method === 'GET' && req.url === '/api/wetransfer') {
    return json(res, 200, { registros: db.leerWetransfer() });
  }

  // ── GET /api/pdfs-huerfanos — archivos Drive/WT recientes sin pedido asociado ──
  // Optimizado para no crashear con cientos de registros: cache 60s + ventana 7d + tope 50.
  if (req.method === 'GET' && req.url === '/api/pdfs-huerfanos') {
    // Cache simple: si tenemos respuesta de hace <60s, devolverla.
    const ahoraMs = Date.now();
    if (global._huerfanosCache && (ahoraMs - global._huerfanosCacheTs) < 60000) {
      return json(res, 200, global._huerfanosCache);
    }

    try {
      let calandra = db.leerCalandra();
      let wt = db.leerWetransfer();
      let ignorados = db.leerIgnorados();

      const ignDrive = new Set((ignorados.drive || []).map(String));
      const ignWt    = new Set((ignorados.wt    || []).map(String));

      // Ventana 7 días
      const haceSiete = ahoraMs - 7 * 24 * 60 * 60 * 1000;

      // Pre-filtrar por fecha + ignorados ANTES de cargar pedidos (más liviano).
      // Helper: parse fecha tolerante (acepta ISO o "d/m/aaaa" o null).
      function parseFecha(r) {
        if (r.modifiedTime) { const t = new Date(r.modifiedTime).getTime(); if (!isNaN(t)) return t; }
        if (r.createdTime)  { const t = new Date(r.createdTime).getTime();  if (!isNaN(t)) return t; }
        if (r.fecha) {
          // Intenta "d/m/aaaa" colombiano
          const m = String(r.fecha).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (m) {
            const [_, d, mo, y] = m;
            const t = new Date(parseInt(y), parseInt(mo)-1, parseInt(d)).getTime();
            if (!isNaN(t)) return t;
          }
          // Intenta ISO
          const t = new Date(r.fecha).getTime();
          if (!isNaN(t)) return t;
        }
        return null;
      }
      const driveRecientes = calandra.filter(r => {
        if (ignDrive.has(String(r.id))) return false;
        const t = parseFecha(r);
        return t !== null && t >= haceSiete;
      });
      const wtRecientes = wt.filter(r => {
        if (ignWt.has(String(r.id))) return false;
        if (!r.ts) return false;
        return new Date(r.ts).getTime() >= haceSiete;
      });

      // Si no hay nada reciente, respuesta rápida (sin tocar pedidos)
      if (driveRecientes.length === 0 && wtRecientes.length === 0) {
        const empty = { items: [], total: 0 };
        global._huerfanosCache = empty;
        global._huerfanosCacheTs = ahoraMs;
        return json(res, 200, empty);
      }

      // Cargar pedidos solo si hay candidatos
      const pedidosCur = leerPedidos();
      const ESTADOS_CERRADOS = new Set(['enviado-calandra','llego-impresion','calidad','costura','listo','enviado-final']);
      const pedidosActivos = pedidosCur.filter(p => !ESTADOS_CERRADOS.has(p.estado));

      // Build de claves planas (Set de strings) para lookup O(1) aprox
      const claves = new Set();
      pedidosActivos.forEach(p => {
        if (Array.isArray(p.archivosAlias)) p.archivosAlias.forEach(a => { if (a) claves.add(a); });
        const eq = nombreLimpio(p.equipo);
        if (eq) claves.add(eq);
        const cl = nombreLimpio(p.cliente);
        if (cl) claves.add(cl);
      });

      function tieneMatch(archivo, equipoHint) {
        const ref = nombreLimpio(equipoHint || archivo);
        if (!ref) return false;
        if (claves.has(ref)) return true;
        // Búsqueda parcial solo si es necesario
        for (const k of claves) {
          if (k.length < 3) continue; // evitar matches falsos por strings cortos
          if (k.includes(ref) || ref.includes(k)) return true;
        }
        return false;
      }

      // Devuelve top 3 pedidos con mejor scoreSimilitud (>=0.4) como sugerencias
      function sugerenciasPara(archivo, equipo) {
        const ref = equipo || archivo;
        return pedidosActivos
          .map(p => ({ p, score: Math.max(scoreSimilitud(p.equipo, ref), scoreSimilitud(p.cliente, ref)) }))
          .filter(x => x.score >= 0.4)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(x => ({ id: x.p.id, equipo: x.p.equipo || '', vendedora: x.p.vendedora || '', estado: x.p.estado, score: Math.round(x.score * 100) }));
      }

      const items = [];
      for (const r of driveRecientes) {
        if (items.length >= 50) break;
        if (!tieneMatch(r.archivo, r.equipo)) {
          const t = parseFecha(r);
          items.push({
            tipo: 'drive',
            id: r.id,
            archivo: r.archivo || '',
            equipo: r.equipo || '',
            ts: t ? new Date(t).toISOString() : null,
            sugerencias: sugerenciasPara(r.archivo, r.equipo),
          });
        }
      }
      for (const r of wtRecientes) {
        if (items.length >= 50) break;
        if (!tieneMatch(r.archivo, r.equipo)) {
          items.push({
            tipo: 'wt',
            id: r.id,
            archivo: r.archivo || '',
            equipo: r.equipo || '',
            ts: r.ts,
            sugerencias: sugerenciasPara(r.archivo, r.equipo),
          });
        }
      }

      items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      const resp = { items, total: items.length };
      global._huerfanosCache = resp;
      global._huerfanosCacheTs = ahoraMs;
      return json(res, 200, resp);
    } catch (e) {
      console.error('[huerfanos]', e.message);
      return json(res, 500, { error: 'fallo procesando huérfanos', items: [], total: 0 });
    }
  }

  // ── POST /api/pdfs-huerfanos/vincular ──
  // Body: { tipo: 'drive'|'wt', idItem, archivo, pedidoId }
  // Marca el flag correcto en el pedido + guarda alias para futuros matches automáticos.
  if (req.method === 'POST' && req.url === '/api/pdfs-huerfanos/vincular') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, archivo, pedidoId } = JSON.parse(body);
        if (!tipo || !pedidoId) return json(res, 400, { error: 'tipo y pedidoId requeridos' });
        const pedidos = leerPedidos();
        const pd = pedidos.find(p => p.id === parseInt(pedidoId));
        if (!pd) return json(res, 404, { error: 'pedido no encontrado' });

        // Guardar alias del archivo limpio (para que próximos archivos parecidos hagan match auto)
        const alias = nombreLimpio(archivo);
        if (alias) {
          if (!Array.isArray(pd.archivosAlias)) pd.archivosAlias = [];
          if (!pd.archivosAlias.includes(alias)) pd.archivosAlias.push(alias);
        }

        // Marcar flag según tipo
        if (tipo === 'drive') {
          if (!pd.pdfDriveListo) {
            pd.pdfDriveListo = true;
            pd.fechaPdfDrive = new Date().toISOString();
          }
        } else if (tipo === 'wt') {
          if (!pd.wtListo) {
            pd.wtListo = true;
            pd.fechaWt = new Date().toISOString();
          }
        }
        pd.ultimoMovimiento = new Date().toISOString();

        // Si ahora ambos están listos, avanzar
        const avanzo = evaluarPasoCalandra(pd);
        guardarPedidos(pedidos, leerNextId());
        global._huerfanosCache = null; // invalidar cache
        console.log(`[huerfano] vinculado ${tipo} archivo="${archivo}" → pedido #${pd.id} (alias="${alias}", avanzo=${avanzo})`);
        return json(res, 200, { ok: true, pedidoId: pd.id, alias, avanzo });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido: ' + e.message });
      }
    });
    return;
  }

  // ── POST /api/pdfs-huerfanos/crear-pedido ──
  // Body: { tipo: 'drive'|'wt', idItem, archivo, equipo, vendedora, telefono }
  // Crea un pedido nuevo directamente en estado 'enviado-calandra' (porque ya hay PDF)
  // y vincula el archivo huérfano. Útil para diseños que se hicieron sin pasar por la app.
  if (req.method === 'POST' && req.url === '/api/pdfs-huerfanos/crear-pedido') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, idItem, archivo, equipo, vendedora, telefono } = JSON.parse(body);
        if (!tipo || !equipo) return json(res, 400, { error: 'tipo y equipo requeridos' });
        const pedidos = leerPedidos();
        const nextId = leerNextId();
        const ahora = new Date().toISOString();
        const alias = nombreLimpio(archivo);
        const ven = vendedora || 'Sin asignar';
        const esVendDis = VENDEDORAS_DISENADORAS.has(ven);
        const nuevo = {
          id: nextId,
          equipo: String(equipo).trim(),
          telefono: String(telefono || '').replace(/\D/g, '') || '',
          vendedora: ven,
          disenadorAsignado: esVendDis ? ven : null,
          tipoBandeja: 'venta',
          estado: 'enviado-calandra',
          creadoEn: ahora,
          ultimoMovimiento: ahora,
          items: [],
          fechaEntrega: null,
          notas: 'Pedido creado desde PDF huérfano (' + (tipo === 'wt' ? 'WeTransfer' : 'Drive') + ')',
          arreglo: false,
          archivosAlias: alias ? [alias] : [],
          pdfDriveListo: tipo === 'drive',
          fechaPdfDrive: tipo === 'drive' ? ahora : null,
          wtListo: tipo === 'wt',
          fechaWt: tipo === 'wt' ? ahora : null,
        };
        pedidos.push(nuevo);
        guardarPedidos(pedidos, nextId + 1);
        global._huerfanosCache = null;
        console.log(`[huerfano] CREADO pedido #${nuevo.id} desde archivo="${archivo}" (vendedora=${ven})`);
        return json(res, 200, { ok: true, pedidoId: nuevo.id, equipo: nuevo.equipo });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido: ' + e.message });
      }
    });
    return;
  }

  // ── POST /api/pdfs-huerfanos/ignorar ──
  if (req.method === 'POST' && req.url === '/api/pdfs-huerfanos/ignorar') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, idItem } = JSON.parse(body);
        if (!tipo || !idItem) return json(res, 400, { error: 'tipo e idItem requeridos' });
        db.insertIgnorado(tipo, idItem);
        global._huerfanosCache = null; // invalidar cache
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/docs/nums — devuelve nextCot, nextFac e historial ──
  if (req.method === 'GET' && req.url === '/api/docs/nums') {
    const nums = db.leerDocsNums();
    const historial = db.leerDocsHistorial();
    return json(res, 200, { ...nums, historial });
  }

  // ── POST /api/docs/nums — guarda nextCot, nextFac e historial ──
  if (req.method === 'POST' && req.url === '/api/docs/nums') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { nextCot, nextFac, historial } = JSON.parse(body);
        db.guardarDocsNums({ nextCot, nextFac });
        // Merge historial: combinar con lo existente, sin duplicados por id
        if (Array.isArray(historial) && historial.length > 0) {
          const existente = db.leerDocsHistorial();
          const todos = [...historial, ...existente];
          const vistos = new Set();
          const merged = todos.filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; });
          merged.sort((a, b) => b.id - a.id);
          db.guardarDocsHistorial(merged.slice(0, 100));
        }
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── POST /api/pendientes-wt — n8n registra PDFs sin enviar ──
  // Body: { pendientes: [{nombre, fecha}], semana }
  if (req.method === 'POST' && req.url === '/api/pendientes-wt') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { pendientes, semana } = JSON.parse(body);
        if (!Array.isArray(pendientes)) return json(res, 400, { error: 'pendientes debe ser array' });
        const registro = {
          ts: new Date().toISOString(),
          semana: semana || '',
          pendientes,
        };
        db.guardarPendientesWt(registro);
        console.log(`[pendientes-wt] ${pendientes.length} pendientes registrados`);
        return json(res, 200, { ok: true, total: pendientes.length });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/pendientes-wt — devuelve último reporte ────────
  if (req.method === 'GET' && req.url === '/api/pendientes-wt') {
    return json(res, 200, db.leerPendientesWt());
  }

  // ── GET /api/arreglos ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/arreglos') {
    return json(res, 200, { arreglos: db.leerArreglos() });
  }

  // ── POST /api/arreglos — reemplaza lista completa ────────────
  if (req.method === 'POST' && req.url === '/api/arreglos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { arreglos } = JSON.parse(body);
        if (!Array.isArray(arreglos)) return json(res, 400, { error: 'arreglos debe ser array' });
        db.guardarArreglos(arreglos);
        return json(res, 200, { ok: true, total: arreglos.length });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── GET /api/satelites ───────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/satelites') {
    return json(res, 200, { movimientos: db.leerSatelites() });
  }

  // ── POST /api/satelites — reemplaza lista completa ──────────
  if (req.method === 'POST' && req.url === '/api/satelites') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { movimientos } = JSON.parse(body);
        if (!Array.isArray(movimientos)) return json(res, 400, { error: 'movimientos debe ser array' });
        db.guardarSatelites(movimientos);
        return json(res, 200, { ok: true, total: movimientos.length });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── GET /api/wa-status — el bot corre local, no en Railway ──
  if (req.method === 'GET' && req.url === '/api/wa-status') {
    return json(res, 200, { ok: true, status: 'bot-local' });
  }

  // ── Notificaciones compartidas (campana) ───────────────────────
  // Todos los dispositivos ven las mismas notificaciones
  const leerNotifs = () => db.leerNotifs();
  const guardarNotifs = arr => db.guardarNotifs(arr);

  if (req.method === 'GET' && req.url === '/api/notificaciones') {
    return json(res, 200, { notificaciones: leerNotifs() });
  }
  if (req.method === 'POST' && req.url === '/api/notificaciones') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const arr = JSON.parse(body);
        const lista = Array.isArray(arr) ? arr : (arr.notificaciones || []);
        guardarNotifs(lista.slice(-200)); // máximo 200 para no inflar
        return json(res, 200, { ok: true, total: lista.length });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── Configuración compartida (ancho calandra, mes, etc.) ───────
  const leerConfig = () => db.leerConfig();
  const guardarConfig = obj => db.guardarConfig(obj);

  if (req.method === 'GET' && req.url === '/api/config') {
    return json(res, 200, leerConfig());
  }
  if (req.method === 'POST' && req.url === '/api/config') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const cambios = JSON.parse(body);
        const actual = leerConfig();
        guardarConfig({ ...actual, ...cambios });
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── /api/sync-todo — devuelve todo el estado en una sola llamada ──
  // Optimización para móviles: 1 request en vez de 7
  if (req.method === 'GET' && req.url === '/api/sync-todo') {
    try {
      const pedidosData = leerPedidos();
      const nextId = leerNextId();
      const arreglos = db.leerArreglos();
      const satelites = db.leerSatelites();
      const calandra = db.leerCalandra();
      const docsNums = db.leerDocsNums();
      const docs = { ...docsNums, historial: db.leerDocsHistorial() };
      return json(res, 200, {
        ok: true,
        ts: Date.now(),
        pedidos: pedidosData,
        nextId,
        arreglos,
        satelites,
        calandra,
        docs,
        notificaciones: leerNotifs(),
        config: leerConfig(),
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── Archivos estáticos ──────────────────────────────────────
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  
  if (req.url !== '/' && !fs.existsSync(filePath)) {
    const publicPath = path.join(__dirname, 'public', req.url);
    if (fs.existsSync(publicPath)) filePath = publicPath;
  }
  
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`W&S App corriendo en puerto ${PORT}`);
  limpiezaAutomatica(); // al arrancar
});

// ── Limpieza automática cada 30 días ────────────────────────────
// Borra registros más antiguos de 30 días, dejando mínimo los 6 más recientes
function limpiezaAutomatica() {
  // ── Limpieza Desactivada a petición del usuario para preservar historial perpetuo ──
  return;
  
  const LIMITE_MS  = 30 * 24 * 60 * 60 * 1000; // 30 días en ms
  const MIN_ITEMS  = 6;
  const ahora      = Date.now();
  const CLEAN_FILE = path.join(__dirname, 'data', 'ultimaLimpieza.json');

  // Solo ejecutar si pasaron al menos 24h desde la última limpieza
  try {
    if (fs.existsSync(CLEAN_FILE)) {
      const { ts } = JSON.parse(fs.readFileSync(CLEAN_FILE, 'utf8'));
      if (ahora - ts < 24 * 60 * 60 * 1000) return;
    }
  } catch {}

  const archivos = [
    { file: path.join(__dirname, 'data', 'pedidos.json'),        campo: 'id' },
    { file: path.join(__dirname, 'data', 'arreglos.json'),       campo: 'id' },
    { file: path.join(__dirname, 'data', 'satelites.json'),      campo: 'id' },
    { file: path.join(__dirname, 'data', 'docsHistorial.json'),  campo: 'id' },
    { file: path.join(__dirname, 'data', 'wetransfer.json'),     campo: 'id' },
    { file: path.join(__dirname, 'data', 'calandra.json'),       campo: 'id' },
  ];

  for (const { file, campo } of archivos) {
    try {
      if (!fs.existsSync(file)) continue;
      let lista = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(lista) || lista.length <= MIN_ITEMS) continue;

      // El campo 'id' es timestamp en ms para todos los registros
      const recientes = lista.filter(x => (ahora - (x[campo] || 0)) < LIMITE_MS);
      // Si quedan menos de MIN_ITEMS, tomar los MIN_ITEMS más nuevos
      const resultado = recientes.length >= MIN_ITEMS
        ? recientes
        : lista.sort((a, b) => (b[campo] || 0) - (a[campo] || 0)).slice(0, MIN_ITEMS);

      if (resultado.length < lista.length) {
        fs.writeFileSync(file, JSON.stringify(resultado, null, 2));
        console.log(`[limpieza] ${path.basename(file)}: ${lista.length} → ${resultado.length} registros`);
      }
    } catch (e) {
      console.error(`[limpieza] Error en ${file}: ${e.message}`);
    }
  }

  fs.mkdirSync(path.dirname(CLEAN_FILE), { recursive: true });
  fs.writeFileSync(CLEAN_FILE, JSON.stringify({ ts: ahora }));
  console.log('[limpieza] Completada');
}

// Repetir cada 24 horas mientras el servidor esté corriendo
setInterval(limpiezaAutomatica, 24 * 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// CRON RESUMEN DE COMPROBANTES — 8 PM hora Bogotá
// Lee comprobantes detectados en las últimas 18h, agrupa por vendedora,
// manda WA a cada una con su lista. Vos recibís copia consolidada por TG.
// ─────────────────────────────────────────────────────────────
function _formatearMontoCOP(n) {
  if (typeof n !== 'number' || isNaN(n)) return '?';
  return '$' + n.toLocaleString('es-CO');
}

function _huelaPMBogota() {
  // Calcula si AHORA es la hora 20 (8 PM) en zona Bogotá (UTC-5).
  const ahoraUtc = new Date();
  const horaBogota = (ahoraUtc.getUTCHours() - 5 + 24) % 24;
  return horaBogota;
}

async function enviarResumenComprobantes() {
  try {
    const lista = db.leerComprobantes();
    if (!lista.length) return;

    // Filtrar últimas 18h (cubre el día de trabajo de las vendedoras)
    const limite = Date.now() - 18 * 60 * 60 * 1000;
    const recientes = lista.filter(r => new Date(r.ts).getTime() >= limite);
    if (!recientes.length) {
      console.log('[resumen-8pm] sin comprobantes en las últimas 18h');
      return;
    }

    // Cargar pedidos para detectar cuáles ya se marcaron con sticker
    const pedidosCur = leerPedidos();
    function yaMarcadoConSticker(telefono) {
      const tel = String(telefono).replace(/\D/g, '');
      // Hay pedido reciente del cliente ya en estado avanzado (no bandeja)?
      return pedidosCur.some(p => {
        const pTel = String(p.telefono || '').replace(/\D/g, '');
        if (pTel !== tel) return false;
        if (p.estado === 'bandeja') return false; // todavía cotización
        const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
        return t >= limite; // pedido movido en las últimas 18h = ya se marcó
      });
    }

    // Filtrar los que aún no se marcaron
    const sinMarcar = recientes.filter(r => !yaMarcadoConSticker(r.telefono));
    if (!sinMarcar.length) {
      console.log(`[resumen-8pm] ${recientes.length} detectados, todos ya marcados — silencio`);
      return;
    }

    // Agrupar por vendedora
    const porVendedora = {};
    sinMarcar.forEach(r => {
      const v = r.vendedora || 'Betty';
      if (!porVendedora[v]) porVendedora[v] = [];
      porVendedora[v].push(r);
    });

    // Mandar WA a cada vendedora con sus pendientes
    for (const [vendedora, items] of Object.entries(porVendedora)) {
      const lineas = items.map((r, i) => {
        const hora = new Date(r.ts).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
        const monto = r.monto ? _formatearMontoCOP(r.monto) : '?';
        return `${i+1}. *${r.cliente}* (${hora}) — ${r.banco} ${monto}`;
      }).join('\n');
      const texto = `🔔 *Recordatorio de cierre de día*\n\nDetecté ${items.length} comprobante${items.length>1?'s':''} de pago en tu WhatsApp que aún NO marcaste con el sticker 💰:\n\n${lineas}\n\n👉 Si fueron ventas reales, mandá el sticker para que entren a la app.\nSi alguna no era venta, ignorá ese.`;
      try { await notificarWAVendedora(vendedora, texto); } catch (e) { console.error('[resumen-8pm wa]', e.message); }
      console.log(`[resumen-8pm] enviado a ${vendedora}: ${items.length} comprobante(s)`);
    }

    // Resumen consolidado a Duvan por Telegram
    const totalPorV = Object.entries(porVendedora).map(([v, l]) => `• *${v}*: ${l.length}`).join('\n');
    const totalDetectados = recientes.length;
    const totalSinMarcar = sinMarcar.length;
    const tgText = `📊 *Resumen 8 PM — Comprobantes detectados*\n\nHoy se detectaron *${totalDetectados}* comprobantes en los WA de las vendedoras.\n*${totalSinMarcar}* están sin marcar:\n\n${totalPorV}\n\nLas vendedoras ya recibieron su recordatorio.`;
    try { await notificarTelegram(tgText); } catch {}
  } catch (e) {
    console.error('[resumen-8pm error]', e.message);
  }
}

// CRON 8PM DESACTIVADO — el resumen se hace ahora desde n8n consultando
// /api/comprobantes-detectados. La función enviarResumenComprobantes()
// queda disponible solo para POST /api/comprobantes-detectados/forzar-resumen
// (modo debug manual).
