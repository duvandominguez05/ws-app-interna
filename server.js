const http = require('http');
const fs   = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { Pool: PgPool } = require('pg'); // para leer DB de Evolution (campo JSON labels)
if (!global.crypto) global.crypto = webcrypto;
const db   = require('./db');
const { PERSONAS, getPersona, manifestParaPersona } = require('./personas');
const gmailWT = require('./gmail-wt');
const driveSync = require('./drive-sync');
const grupoVentasWatcher = require('./grupo-ventas-watcher');
const catalogoFotosWatcher = require('./catalogo-fotos-watcher');
const chatReader = require('./chat-reader');
const grupoTrabajoFamiliaWatcher = require('./grupo-trabajo-familia-watcher');
const v2 = require('./v2-server');
v2.initV2();
const disenos = require('./disenos');
disenos.init(db);

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

  // El bot guarda el pushName/nombre del contacto en `equipo` mientras
  // espera que llegue el nombre REAL del equipo (de la foto del grupo
  // Ventas N/W/P, del archivo .cdr, etc). Marcamos equipoVieneDeBot=true
  // para que el watcher pueda reemplazarlo cuando aparezca el nombre real.
  const equipoLimpio = equipo ? String(equipo).trim() : '';
  const vendedoraCap = vendedora.charAt(0).toUpperCase() + vendedora.slice(1).toLowerCase();
  // Auto-asignar diseñador al crear pedido directo, sin esperar el segundo paso.
  // (la vendedora-disenadora se asigna a si misma; el resto a Oscar)
  const disenadorAuto = tipoNorm === 'pedido'
    ? (VENDEDORAS_DISENADORAS && VENDEDORAS_DISENADORAS.has(vendedoraCap) ? vendedoraCap : DISENADOR_FULL_TIME_DEFAULT)
    : null;
  const nuevo = {
    id:          nextId,
    equipo:      equipoLimpio,
    pushNameCliente: equipoLimpio, // guardar para referencia
    equipoVieneDeBot: true,        // bandera para que el watcher sobreescriba
    telefono:    String(telefono).trim(),
    vendedora:   vendedoraCap,
    disenadorAsignado: disenadorAuto,
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ws-Persona');
}

// Lee de los headers la persona que está usando la app (slug).
// Devuelve un objeto persona del roster o null si no se reconoce.
function leerPersonaRequest(req) {
  const slug = req.headers['x-ws-persona'];
  return getPersona(slug);
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function leerPedidos() { return db.leerPedidos(); }
function leerNextId() { return db.leerNextId(); }

// Mapping pollMsgId -> pedidoId para asociar votos de aprobacion
const POLLS_MAPPING_FILE = path.join(__dirname, 'data', 'polls-aprobacion.json');
function leerPollsMapping() {
  try { return JSON.parse(fs.readFileSync(POLLS_MAPPING_FILE, 'utf8')); }
  catch { return []; }
}
function guardarPollsMapping(arr) {
  try { fs.mkdirSync(path.dirname(POLLS_MAPPING_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(POLLS_MAPPING_FILE, JSON.stringify(arr, null, 2));
}

// Cola de aprobaciones pendientes: cuando la vendedora manda imagen, se
// guarda aqui y el cron verifica 5 min despues si realmente conviene mandar
// la encuesta (filtros anti-falso-positivo basados en chats reales W&S).
const PENDING_APPROVALS_FILE = path.join(__dirname, 'data', 'pending-approvals.json');
function leerPendingApprovals() {
  try { return JSON.parse(fs.readFileSync(PENDING_APPROVALS_FILE, 'utf8')); }
  catch { return []; }
}
function guardarPendingApprovals(arr) {
  try { fs.mkdirSync(path.dirname(PENDING_APPROVALS_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(PENDING_APPROVALS_FILE, JSON.stringify(arr, null, 2));
}

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

// Manda mensaje al grupo W&S Admin de Telegram (reportes ejecutivos al duenio).
// Usa TELEGRAM_CHAT_ID_ADMIN si existe; fallback a Duvan personal.
async function notificarTelegramAdmin(texto) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID_ADMIN
      || process.env.TELEGRAM_CHAT_ID_DUVAN
      || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error('[telegram-admin] respuesta:', r.status, errBody.slice(0, 200));
    }
  } catch (e) { console.error('[telegram-admin error]', e.message); }
}

// ── Dedupe de notificaciones WA ──────────────────────────────────
// Evita repetir el mismo WA si ya se mando hoy.
// State file en data/wa_notif_dedupe.json
const _waNotifDedupeFile = path.join(__dirname, 'data', 'wa_notif_dedupe.json');
function _leerDedupeWA() {
  try { return JSON.parse(fs.readFileSync(_waNotifDedupeFile, 'utf8')); }
  catch { return {}; }
}
function _guardarDedupeWA(d) {
  try { fs.mkdirSync(path.dirname(_waNotifDedupeFile), { recursive: true }); } catch {}
  fs.writeFileSync(_waNotifDedupeFile, JSON.stringify(d, null, 2));
}
// key: tipo:pedidoId | tipo:custom — dia: YYYY-MM-DD (Bogota)
// Devuelve true si NO se ha enviado hoy (puede enviar), false si ya se envio.
function waPuedeEnviar(key) {
  if (!key) return true;
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
  const d = _leerDedupeWA();
  if (d[key] === hoy) return false;
  // Limpieza basica: quitar entries de dias pasados (max 200 entries)
  const entries = Object.entries(d);
  if (entries.length > 300) {
    const filt = entries.filter(([k, v]) => v === hoy);
    const nuevo = Object.fromEntries(filt);
    nuevo[key] = hoy;
    _guardarDedupeWA(nuevo);
  } else {
    d[key] = hoy;
    _guardarDedupeWA(d);
  }
  return true;
}

// Manda mensaje al grupo de WhatsApp "Trabajo en familia" vía Evolution.
// Usa ws-duvan por default (la de Betty/ws-ventas esta en revision).
async function notificarWhatsappTrabajoFamilia(texto) {
  try {
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const instance = process.env.WA_NOTIF_INSTANCE || 'ws-duvan';
    const apiKey = process.env.WA_NOTIF_APIKEY || process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const groupJid = process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us';
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: groupJid, text: texto }),
    });
    if (!r.ok) {
      const body = await r.text().catch(()=>'');
      console.error('[wa-grupo] respuesta:', r.status, body.slice(0,200));
    }
  } catch (e) { console.error('[wa-grupo error]', e.message); }
}

// ── Notificar al JEFE (Camilo) + Graciela individual (no al grupo) ──
// Helper unificado para avisos importantes. Acepta dedupeKey opcional
// para evitar repetir el mismo aviso (key:pedidoId:dia).
async function notificarJefes(texto, opciones = {}) {
  const { dedupeKey = null, soloJefe = false, forzar = false } = opciones;
  // CAMILO 2026-06-29: env var JEFE_SILENCIO=1 silencia TODOS los notificarJefes
  // (spam de crones). El resumen semanal usa responderJefe que sigue activo.
  // Para emergencias forzar:true bypasea el silencio.
  if (process.env.JEFE_SILENCIO === '1' && !forzar) {
    console.log('[notif-jefes] silenciado por JEFE_SILENCIO=1 (texto:', String(texto).slice(0,60), ')');
    return;
  }
  if (dedupeKey && typeof waPuedeEnviar === 'function' && !waPuedeEnviar(dedupeKey)) {
    return; // ya se envio hoy
  }
  try { await notificarWAPersona('camilo', texto); } catch (e) { console.error('[notif-jefes camilo]', e.message); }
  if (!soloJefe) {
    try { await notificarWAPersona('graciela', texto); } catch (e) { console.error('[notif-jefes graciela]', e.message); }
  }
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
    // Las notificaciones administrativas salen desde el WA de Camilo (ws-duvan) — el jefe.
    // Si esa instancia no está configurada, fallback a ws-ventas (Betty).
    // CRITICO para Betty: si remitente == destinatario, WA se manda a sí mismo y no se ve.
    const instance = process.env.WA_NOTIF_INSTANCE || 'ws-ventas';
    const apiKey = process.env.WA_NOTIF_APIKEY || process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: numero, text: texto }),
    });
    if (!r.ok) console.error(`[wa-vendedora ${vendedora}] respuesta:`, r.status);
  } catch (e) { console.error('[wa-vendedora error]', e.message); }
}

// Manda mensaje WA al teléfono personal de CUALQUIER persona del roster.
// Usa env vars WA_<NOMBRE> con fallback a hardcoded por slug.
// Devuelve true si se envió, false si no hay número configurado.
const WA_NUMS_PERSONA = {
  // Hardcoded — sobrescribibles con env WA_<SLUG_UPPER>
  betty:      '573506974711',
  ney:        '573016639430',
  wendy:      '573118287892',
  paola:      '573026027865',
  camilo:     '573124858901',
  duvan:      process.env.WA_DUVAN || '573124858901', // owner (mismo numero que Camilo)
  oscar:      process.env.WA_OSCAR || null,
  graciela:   process.env.WA_GRACIELA || '573232287390',
  lidermeyer: process.env.WA_LIDERMEYER || null,
  marcela:    process.env.WA_MARCELA || null,
  cristina:   process.env.WA_CRISTINA || null,
  wilson:     process.env.WA_WILSON || null,
  yamile:     process.env.WA_YAMILE || null,
  nicol:      process.env.WA_NICOL || null,
};
function _numeroPersona(slugOrNombre) {
  if (!slugOrNombre) return null;
  const k = String(slugOrNombre).toLowerCase().split(' ')[0]; // toma primer nombre
  // 1. Override via env WA_<SLUG_UPPER>
  const envKey = 'WA_' + k.toUpperCase();
  if (process.env[envKey]) return process.env[envKey];
  // 2. Hardcoded
  return WA_NUMS_PERSONA[k] || null;
}
// Construye el mensaje de onboarding personalizado por rol.
function _buildOnboardingMsg(persona, link, rolesTxt) {
  const rol = (persona.roles && persona.roles[0]) || '';
  let acciones = '';
  if (persona.roles.includes('ventas')) {
    acciones += '✅ Cuando recibas un pago, la app te avisa automático y sube el pedido al tablero\n';
    acciones += '✅ Pon el sticker venta 💰 en el chat del cliente para oficializar la venta\n';
    acciones += '✅ Genera cotizaciones y facturas directo desde la app y mándalas al cliente por WA con 1 click\n';
  }
  if (persona.roles.includes('diseno')) {
    acciones += '✅ Ves los pedidos que te asignaron y los archivos en Drive\n';
    acciones += '✅ Cuando termines, marca "Listo" desde Mi Día\n';
  }
  if (persona.roles.includes('produccion') || persona.roles.includes('corte')) {
    acciones += '✅ Ves los pedidos que llegan de calandra para corte/costura\n';
    acciones += '✅ Reporta arreglos cuando algo viene con fallo\n';
  }
  if (persona.roles.includes('costura')) {
    acciones += '✅ Ves SOLO los pedidos que te asignaron\n';
    acciones += '✅ Cuando termines uno, súbele foto y marca "Listo"\n';
  }
  if (persona.roles.includes('admin')) {
    acciones += '✅ Tablero completo + Torre de Control con KPIs\n';
    acciones += '✅ Calandra + Facturas + Productividad del equipo\n';
  }
  return `👋 *Hola ${persona.nombre}*, bienvenido a la app de W&S Textil.\n\n` +
    `Tu rol: *${rolesTxt}*\n\n` +
    `*Abre tu link personal:*\n${link}\n\n` +
    `*Para instalarla en tu celular* (1 minuto):\n` +
    `1️⃣ Abre el link arriba\n` +
    `2️⃣ Toca el menú del navegador (⋮ arriba a la derecha)\n` +
    `3️⃣ Elige "Instalar app" o "Añadir a pantalla de inicio"\n` +
    `4️⃣ Listo, queda un ícono con tu nombre\n\n` +
    `*Qué puedes hacer:*\n${acciones}\n` +
    `Si tienes dudas, escríbele a Duvan 💜`;
}

async function notificarWAPersona(slugOrNombre, texto) {
  try {
    const numero = _numeroPersona(slugOrNombre);
    if (!numero) { console.log(`[wa-persona] sin número para ${slugOrNombre}`); return false; }
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    // Camilo notifica desde su WA (ws-duvan). Token propio de ws-duvan via WA_NOTIF_APIKEY.
    const instance = process.env.WA_NOTIF_INSTANCE || 'ws-duvan';
    const apiKey = process.env.WA_NOTIF_APIKEY || process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: numero, text: texto }),
    });
    if (!r.ok) console.error(`[wa-persona ${slugOrNombre}] respuesta:`, r.status);
    return r.ok;
  } catch (e) { console.error('[wa-persona error]', e.message); return false; }
}

// Manda un DOCUMENTO (PDF u otro) vía WhatsApp Evolution.
// telefono: 57XXXXXXXXXX (sin +, sin espacios) — se normaliza
// mediaUrl: URL pública del archivo (ej: link público de Drive)
// fileName: nombre que verá el cliente
// caption: texto que acompaña el documento
// instance: instancia Evolution a usar (default ws-duvan)
async function enviarWADocumento({ telefono, mediaUrl, fileName, caption, instance, mimetype }) {
  try {
    const tel = String(telefono || '').replace(/\D/g, '');
    if (!tel) throw new Error('telefono inválido');
    const numero = tel.startsWith('57') ? tel : '57' + tel;
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const apiKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const inst = instance || process.env.WA_NOTIF_INSTANCE || 'ws-duvan';
    const r = await fetch(`${url}/message/sendMedia/${inst}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({
        number: numero,
        mediatype: 'document',
        mimetype: mimetype || 'application/pdf',
        media: mediaUrl,
        fileName: fileName || 'documento.pdf',
        caption: caption || '',
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(()=>'');
      throw new Error(`Evolution sendMedia respondió ${r.status}: ${body.slice(0,300)}`);
    }
    return await r.json().catch(()=>({ ok: true }));
  } catch (e) {
    console.error('[wa-doc error]', e.message);
    throw e;
  }
}

// Mapeo de vendedora → instancia Evolution que usa para mandar
const INSTANCIA_POR_VENDEDORA = {
  'betty':    'ws-ventas',
  'paola':    'ws-paola',
  'ney':      'ws-ney',
  'wendy':    'ws wendy',
  'graciela': 'ws-duvan',
  'camilo':   'ws-duvan',
};
function instanciaParaVendedora(vendedora) {
  return INSTANCIA_POR_VENDEDORA[String(vendedora || '').toLowerCase()] || 'ws-duvan';
}

// ── DETECTOR DE COMPROBANTES DE PAGO con Gemini Flash ──
// Cuando el cliente manda una imagen, la pasamos a Gemini para que decida si es comprobante.
// Si lo es, guardamos un registro para el resumen de las 8 PM.
function resumenRolesOperativos() {
  const pedidos = leerPedidos();
  const activos = pedidos.filter(p => p.estado !== 'enviado-final');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const diasEntrega = p => {
    if (!p.fechaEntrega) return null;
    const d = new Date(p.fechaEntrega + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    return Math.round((d - hoy) / 86400000);
  };
  const horasSinMovimiento = p => {
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    return t ? (Date.now() - t) / 3600000 : 999;
  };
  const vencidos = activos.filter(p => {
    const d = diasEntrega(p);
    return d !== null && d < 0;
  });
  const hoyEntrega = activos.filter(p => diasEntrega(p) === 0);
  const sinDisenador = activos.filter(p => p.estado !== 'bandeja' && !p.disenadorAsignado);
  const sinMovimiento = activos.filter(p => horasSinMovimiento(p) >= 48);
  return {
    total: activos.length,
    ventas: {
      link: 'https://ws-app-interna-production.up.railway.app/#/ventas',
      cotizaciones: pedidos.filter(p => p.tipoBandeja === 'cotizar' && p.estado === 'bandeja').length,
      pedidosActivos: pedidos.filter(p => p.tipoBandeja === 'pedido' && p.estado !== 'enviado-final').length,
    },
    diseno: {
      link: 'https://ws-app-interna-production.up.railway.app/#/diseno',
      sinAsignar: pedidos.filter(p => p.estado === 'hacer-diseno' && !p.disenadorAsignado).length,
      enDiseno: pedidos.filter(p => p.estado === 'hacer-diseno' && p.disenadorAsignado).length,
      paraCalandra: pedidos.filter(p => p.estado === 'confirmado').length,
    },
    produccion: {
      link: 'https://ws-app-interna-production.up.railway.app/produccion.html',
      trabajo: pedidos.filter(p => ['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo'].includes(p.estado)).length,
      vencidos: vencidos.length,
      hoy: hoyEntrega.length,
      sinMovimiento: sinMovimiento.length,
    },
    costura: {
      link: 'https://ws-app-interna-production.up.railway.app/#/satelites',
      paraCostura: pedidos.filter(p => (p.estado === 'corte' || p.estado === 'costura') && !p.satelite).length,
      trabajando: pedidos.filter(p => p.estado === 'en-satelite' || (p.estado === 'costura' && p.satelite)).length,
      revision: pedidos.filter(p => p.estado === 'calidad').length,
      satelites: db.leerSatelites().length,
    },
    admin: {
      link: 'https://ws-app-interna-production.up.railway.app',
      vencidos: vencidos.length,
      hoy: hoyEntrega.length,
      sinDisenador: sinDisenador.length,
      sinMovimiento: sinMovimiento.length,
    }
  };
}

function textoRecordatorioRoles(resumen) {
  return [
    '📲 *W&S Textil — revisar app interna*',
    '',
    `*Admin:* ${resumen.admin.vencidos} vencidos · ${resumen.admin.hoy} entregas hoy · ${resumen.admin.sinDisenador} sin diseñador`,
    resumen.admin.link,
    '',
    `*Ventas:* ${resumen.ventas.cotizaciones} cotizaciones · ${resumen.ventas.pedidosActivos} pedidos activos`,
    resumen.ventas.link,
    '',
    `*Diseño:* ${resumen.diseno.sinAsignar} sin asignar · ${resumen.diseno.enDiseno} en diseño · ${resumen.diseno.paraCalandra} para calandra`,
    resumen.diseno.link,
    '',
    `*Producción:* ${resumen.produccion.trabajo} en trabajo · ${resumen.produccion.hoy} para hoy · ${resumen.produccion.vencidos} vencidos`,
    resumen.produccion.link,
    '',
    `*Costura:* ${resumen.costura.paraCostura} por asignar · ${resumen.costura.trabajando} en manos de costura · ${resumen.costura.revision} en revision`,
    resumen.costura.link,
    '',
    'Instalen el link como app en la pantalla principal del celular.'
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// Valida que el destinatario del comprobante sea W&S Textil.
// Cliente puede mandar comprobantes de pagos a OTROS (proveedores,
// envios, etc) — esos NO son ventas para nosotros.
// ─────────────────────────────────────────────────────────────
const WS_BENEFICIARIOS = (process.env.WS_BENEFICIARIOS ||
  // Default: nombres tipicos que aparecen en comprobantes de W&S
  'Duvan Camilo Dominguez,Camilo Dominguez,W&S,WyS,W & S,WS Textil,W&S Textil,W&S Enterprise,Uniformes Deportivos WyS,Deportivos Wys'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Lista de proveedores conocidos que NO son W&S
const PROVEEDORES_EXCLUIDOS = (process.env.PROVEEDORES_EXCLUIDOS ||
  'TNT,Servientrega,Coordinadora,Interrapidisimo,Inter Rapidisimo,Envia,Saferbo,Domesa,Dispapeles,Calandra'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function _normNombre(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar tildes
    .replace(/[^a-z0-9\s&]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function validarBeneficiarioWS(destinatarioNombre) {
  if (!destinatarioNombre) {
    return { esParaWS: false, motivo: 'destinatario no detectado por Gemini' };
  }
  const norm = _normNombre(destinatarioNombre);

  // 1. Match contra W&S
  for (const ben of WS_BENEFICIARIOS) {
    const benNorm = _normNombre(ben);
    if (norm.includes(benNorm) || benNorm.includes(norm)) {
      return { esParaWS: true, match: ben };
    }
  }

  // 2. Match contra proveedores excluidos (descarte rapido)
  for (const prov of PROVEEDORES_EXCLUIDOS) {
    const provNorm = _normNombre(prov);
    if (norm.includes(provNorm)) {
      return { esParaWS: false, motivo: `es proveedor conocido: ${prov}` };
    }
  }

  // 3. No coincide ni con W&S ni con proveedor — descartar por seguridad
  return { esParaWS: false, motivo: `destinatario desconocido: "${destinatarioNombre}"` };
}

// ═════════════════════════════════════════════════════════════════
// GEMINI — analizar el FLUJO de la conversacion entre vendedora y
// cliente para detectar el estado real del diseno.
//
// LOGICA REAL DEL FLUJO:
// El cliente NUNCA dice "aprobado" explicitamente. El patron es:
//   Vendedora manda imagen → Cliente pide cambios → Vendedora rehace
//   → ... iteraciones ... → Cliente NO pide mas cambios = APROBADO
//
// Por eso analizamos las imagenes y la AUSENCIA de pedidos de cambio
// despues de la ultima imagen, NO buscamos palabras "aprobado".
// ═════════════════════════════════════════════════════════════════
async function analizarChatAprobacionConGemini(conversacionTexto, nombreEquipo) {
  global._geminiUltimoError = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { global._geminiUltimoError = 'no api key'; return null; }
    const prompt = `Analiza el FLUJO de una conversacion entre una vendedora de uniformes deportivos y su cliente en Colombia.\n` +
      `Pedido: "${nombreEquipo || 'sin nombre'}"\n\n` +
      `Conversacion (mensaje mas reciente al final, [IMG] = imagen):\n${conversacionTexto}\n\n` +
      `══════════════════════════════════════════════════════════\n` +
      `IMPORTANTE: El cliente RARAMENTE dice "aprobado" o "perfecto" explicitamente.\n` +
      `El patron normal es:\n` +
      `  Vendedora manda imagen del diseno → Cliente pide cambios\n` +
      `  Vendedora hace cambios y manda nueva imagen → Cliente pide mas cambios\n` +
      `  ... iteraciones ...\n` +
      `  Cliente NO pide mas cambios despues de la ultima imagen = APROBADO\n` +
      `  Cliente dice "no, asi queda bien" / "ya esta" / "no mas" / silencio = APROBADO\n` +
      `══════════════════════════════════════════════════════════\n\n` +
      `Para clasificar, primero encuentra LA ULTIMA IMAGEN que mando la VENDEDORA al cliente.\n` +
      `Despues analiza los mensajes del CLIENTE posteriores a esa imagen:\n\n` +
      `- "aprobado": despues de la ultima imagen de la vendedora, el cliente:\n` +
      `   * NO pidio mas cambios, O\n` +
      `   * dijo "asi queda bien" / "ya esta" / "vamos asi" / "perfecto" / "ok" / "dale" / "listo" / "vale" / "gracias", O\n` +
      `   * dijo "no" cuando se le pregunto si queria mas cambios, O\n` +
      `   * dio info logistica (talla, fecha entrega, jugadores) sin pedir cambios al diseno, O\n` +
      `   * agradecio recibir las prendas / dijo "quedaron lindas" / "muchas gracias" → ESTO ES ENTREGADO YA\n\n` +
      `- "cambios": despues de la ultima imagen de la vendedora, el cliente pidio modificacion clara al diseno.\n` +
      `   Ej: "cambia el escudo", "ponle otro color", "me gusta mas el anterior", "muy oscuro", "agrega/quita Y", "este no", "modifica X".\n\n` +
      `- "esperando-respuesta": la vendedora mando la ultima imagen pero el cliente NO ha respondido (ultimo mensaje es de la vendedora).\n\n` +
      `- "entregado": el cliente ya recibio las prendas y agradecio. Ej: "muchas gracias", "quedaron bien las tallas", "ya las recibi", "todo bien con el envio". Esto significa que el pedido YA ESTA TERMINADO.\n\n` +
      `- "sin-imagen": la vendedora todavia no mando ninguna imagen de diseno en la conversacion.\n\n` +
      `- "no-detectado": el chat no parece sobre aprobacion de diseno (es consulta inicial, precios, etc).\n\n` +
      `Responde SOLO JSON valido (sin markdown):\n` +
      `{"estado": "aprobado" | "cambios" | "esperando-respuesta" | "entregado" | "sin-imagen" | "no-detectado",\n` +
      ` "confianza": "alta" | "media" | "baja",\n` +
      ` "cita": "frase exacta del cliente que lo sustenta o vacio si no aplica",\n` +
      ` "razonamiento": "una linea explicando el flujo detectado"}\n\n` +
      `Respuesta:`;
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[gemini-chat] HTTP', r.status, errText.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try { return JSON.parse(limpio); }
    catch { return null; }
  } catch (e) {
    console.error('[gemini-chat error]', e.message);
    return null;
  }
}

async function analizarImagenConGemini(base64Img, mimeType) {
  global._geminiUltimoError = null;
  global._geminiUltimaRespuesta = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { console.log('[gemini] sin API key, saltando'); global._geminiUltimoError = 'no api key'; return null; }

    const prompt = `Analizá esta imagen de WhatsApp en Colombia. Responde SOLO con JSON válido (sin markdown, sin texto extra).

Si es captura/foto de un COMPROBANTE de pago de Bancolombia, Nequi, Daviplata, BBVA, Davivienda, Banco de Bogotá, Caja Social, AV Villas, PSE, transferencia bancaria, recibo de consignación, etc, extraé estos datos:

{"esComprobante": true,
 "banco": "Nombre del banco/app emisor",
 "monto": numero_sin_puntos_ni_pesos,
 "fecha": "YYYY-MM-DD o null si no se ve",
 "destinatario_nombre": "Nombre EXACTO de la persona/empresa que RECIBE el dinero (beneficiario), tal como aparece. null si no se ve",
 "destinatario_cuenta": "Numero de cuenta/celular destino si aparece, null si no",
 "remitente_nombre": "Nombre de quien ENVIA el dinero, null si no se ve",
 "confianza": "alta|media|baja"}

IMPORTANTE:
- "destinatario_nombre" es CRITICO — extraelo siempre que sea visible (suele aparecer como "Para:", "A nombre de:", "Beneficiario:", "Destino:", o como el nombre principal del recibo cuando es de Bancolombia/Nequi)
- NO confundas el banco emisor con el destinatario. El banco es donde se hace el pago, el destinatario es quien recibe el dinero.
- Si NO ves el destinatario claro, deja "destinatario_nombre": null y baja la confianza.

Si NO es comprobante (es foto de uniforme, logo, persona, paisaje, captura de chat, screenshot de redes, lista de jugadores, etc):
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

// ─────────────────────────────────────────────────────────────────
// Descarga un attachment de Chatwoot (imagen o audio) y devuelve {base64, mime}.
// dataUrl viene del payload de Chatwoot (ej: https://app.chatwoot.com/rails/active_storage/...).
// Si falla devuelve null.
async function descargarAttachmentChatwootBase64(dataUrl, timeoutMs = 15000) {
  try {
    if (!dataUrl) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const apiKey = process.env.CHATWOOT_API_KEY;
    // En Chatwoot self-hosted, data_url a veces requiere autenticacion. Probamos con header.
    const r = await fetch(dataUrl, {
      headers: apiKey ? { 'api_access_token': apiKey } : {},
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) {
      console.error('[chatwoot-att]', 'HTTP', r.status, dataUrl.slice(0, 80));
      return null;
    }
    const mime = r.headers.get('content-type') || 'application/octet-stream';
    const buf = await r.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    // Tamano en KB para logs
    const kb = Math.round(base64.length / 1024);
    return { base64, mime, kb };
  } catch (e) {
    console.error('[chatwoot-att]', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Analiza una conversacion COMPLETA (texto + imagenes + audios) con Gemini multimodal.
// mensajes: [{ quien: 'cliente'|'vendedora', texto, fecha, attachments: [{base64,mime,kind}] }]
// Devuelve {estado, confianza, resumen, pedidosDetectados, ultimaImagen, cita}.
async function analizarChatMultimediaConGemini(mensajes, nombreEquipo) {
  global._geminiUltimoError = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { global._geminiUltimoError = 'no api key'; return null; }
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

    const preamble = `Sos un analista de W&S Enterprise (uniformes deportivos, Colombia).\n` +
      `Te paso una conversacion entera entre la VENDEDORA (W&S) y un CLIENTE sobre el pedido: "${nombreEquipo || 'sin nombre'}".\n` +
      `La conversacion incluye TEXTOS, IMAGENES y AUDIOS en orden cronologico (mas viejo primero).\n\n` +
      `IMPORTANTE — patron de aprobacion REAL:\n` +
      `  El cliente NUNCA dice "aprobado" explicitamente. Vendedora manda imagen → cliente pide cambios → vendedora corrige → repite.\n` +
      `  Cuando el cliente DEJA de pedir cambios despues de la ultima imagen, o pide MAS pedidos / da tallas / da fecha → ESO es la aprobacion.\n` +
      `  Tambien escucha los AUDIOS — ahi el cliente suele dar tallas, direccion, cambios, o decir "asi queda".\n` +
      `  Mira las IMAGENES — pueden ser: diseno mostrado por la vendedora, comprobante de pago, lista de jugadores escrita a mano, foto del producto terminado.\n\n` +
      `Tareas:\n` +
      `1) Resume en 3-5 lineas que pasa en este chat (texto + audios + imagenes).\n` +
      `2) Detecta cuantos PEDIDOS distintos hay en esta conversacion (pedido original + adiciones / nuevos).\n` +
      `3) Determina el estado REAL del PEDIDO ACTUAL: "${nombreEquipo || 'sin nombre'}".\n\n` +
      `IMPORTANTE — ENTREGADO en W&S:\n` +
      `  Cliente raramente dice "ya me llego". La entrega se cierra cuando vendedora muestra DATOS DEL ENVIO (conductor/placa/InDrive/RappiPay/foto del paquete) + cliente acusa recibo de los datos ("listo", "gracias", "dale"). Eso es ENTREGADO.\n\n` +
      `Estados posibles:\n` +
      `  - "aprobado-listo-calandra": diseno aprobado, listo para pasar a produccion (calandra/costura).\n` +
      `  - "en-correcciones": cliente pidio cambios y vendedora no ha respondido con nueva imagen.\n` +
      `  - "esperando-respuesta-cliente": vendedora mando la ultima imagen y cliente no respondio aun.\n` +
      `  - "listo-para-entregar": produccion terminada pero AUN NO HAY DATOS DE ENVIO en el chat.\n` +
      `  - "entregado": ya hay datos del envio (conductor/placa/foto) + cliente acuso recibo. ESTO ES ENTREGADO aunque no diga "ya me llego".\n` +
      `  - "sin-imagen-aun": no se ha mandado ningun diseno aun (chat inicial).\n` +
      `  - "no-aplica": no es chat de aprobacion de diseno.\n\n` +
      `Responde SOLO JSON valido (sin markdown):\n` +
      `{"resumen": "texto corto del chat",\n` +
      ` "pedidosDetectados": numero,\n` +
      ` "estadoReal": "aprobado-listo-calandra"|"en-correcciones"|"esperando-respuesta-cliente"|"listo-para-entregar"|"entregado"|"sin-imagen-aun"|"no-aplica",\n` +
      ` "confianza": "alta"|"media"|"baja",\n` +
      ` "cita": "frase exacta del cliente (o transcripcion de audio) que sustenta el estado",\n` +
      ` "audiosResumen": "que dicen los audios brevemente",\n` +
      ` "imagenesResumen": "que se ve en las imagenes (disenos, comprobantes, listas, prendas)"}\n\n` +
      `═══════════════════════════════════════════════════════════════\n` +
      `CONVERSACION:\n`;

    const parts = [{ text: preamble }];
    let idxMsg = 0;
    let imagenesUsadas = 0, audiosUsados = 0;
    const MAX_IMG = 10, MAX_AUDIO = 8;
    for (const m of mensajes) {
      idxMsg++;
      const cabecera = `\n[msg ${idxMsg} | ${m.quien} | ${m.fecha || ''}]${m.texto ? ' ' + m.texto.slice(0, 500) : ''}`;
      parts.push({ text: cabecera });
      for (const a of (m.attachments || [])) {
        if (!a || !a.base64 || !a.mime) continue;
        const isImg = a.mime.startsWith('image/');
        const isAud = a.mime.startsWith('audio/');
        if (isImg && imagenesUsadas < MAX_IMG) {
          parts.push({ text: `[IMG adjunta de ${m.quien}]:` });
          parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
          imagenesUsadas++;
        } else if (isAud && audiosUsados < MAX_AUDIO) {
          parts.push({ text: `[AUDIO adjunto de ${m.quien}, transcribe y considera el contenido]:` });
          parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
          audiosUsados++;
        }
      }
    }
    parts.push({ text: `\n═══════════════════════════════════════════════════════════════\nResponde JSON:` });

    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[gemini-multi] HTTP', r.status, errText.slice(0, 200));
      global._geminiUltimoError = `HTTP ${r.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      const parsed = JSON.parse(limpio);
      parsed._meta = { imagenesUsadas, audiosUsados, mensajesAnalizados: idxMsg };
      return parsed;
    } catch {
      global._geminiUltimoError = `parse error: ${limpio.slice(0, 300)}`;
      return { _raw: limpio.slice(0, 1000), _meta: { imagenesUsadas, audiosUsados } };
    }
  } catch (e) {
    console.error('[gemini-multi error]', e.message);
    global._geminiUltimoError = `exception: ${e.message}`;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// VEREDICTO FINAL con Claude Sonnet — separa pedidos mezclados y razona
// mejor que Gemini en chats complejos.
// Recibe: mensajesEnriquecidos (con base64), datosPedido, analisisGemini
// Devuelve: {estadoVeredicto, confianza, razonamiento, pedidoActualResumen, hayPedidoAdicional, ...}
// ─────────────────────────────────────────────────────────────────
// DETECCION DE VENTA CONFIRMADA — usado cuando llega evento de etiqueta WA
// Usa Gemini Flash (multimedia, super barato). Camilo recargo saldo 2026-06-29.
// Devuelve { hayVenta: bool, confianza, evidencia, monto, fechaPago, razon }
// ─────────────────────────────────────────────────────────────────
async function iaDetectarVentaEnChat(mensajes, contexto = {}) {
  const { telefono = '', vendedora = '', etiquetaTrigger = '' } = contexto;
  global._geminiUltimoError = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { global._geminiUltimoError = 'no api key Gemini'; return null; }
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

    const preamble = `Sos analista de W&S Enterprise (uniformes deportivos sublimados, Bogota Colombia).\n` +
      `Vendedora: ${vendedora || '?'}. Cliente tel: ${telefono || '?'}.\n` +
      (etiquetaTrigger ? `La vendedora etiqueto este chat como "${etiquetaTrigger}" hace poco. Usa eso como pista pero NO como prueba unica.\n` : '') +
      `\nTu tarea: determinar SI ESTE CHAT REPRESENTA UN PEDIDO/VENTA CONFIRMADA (no necesariamente RECIENTE).\n\n` +
      `EVIDENCIA POSITIVA DE VENTA (cualquiera basta):\n` +
      `  a) Cliente envio COMPROBANTE de pago en imagen (transferencia, Nequi, Bancolombia, Daviplata, recibo bancario), o\n` +
      `  b) Cliente declaro PAGO: "ya te transferi", "ya consigne", "ya pague", "ya quedo el abono", "te envie el comprobante", o\n` +
      `  c) Seguimiento post-pago: vendedora muestra DISENO/MOCKUP del pedido del cliente, hay lista de jugadores con tallas, datos de envio/conductor, foto del producto terminado, fecha de entrega acordada, o\n` +
      `  d) Cliente y vendedora hablan de DETALLES de produccion (escudo, numeros, colores, fecha de entrega) — eso prueba que ya hay pedido.\n\n` +
      `IMPORTANTE — INTERPRETACION TEMPORAL:\n` +
      `  - El chat puede tener semanas. El pago puede estar al inicio, NO al final. Mira TODO el chat, no solo lo reciente.\n` +
      `  - Aunque los ultimos msgs sean seguimiento o entrega, ESO ES UN PEDIDO CONFIRMADO.\n` +
      `  - El cliente raramente repite "ya te pague" en mensajes recientes — sola ves fue al inicio.\n\n` +
      `NO ES VENTA:\n` +
      `  - "te voy a transferir", "ahora te pago" sin que despues haya seguimiento de produccion → futuro, no venta.\n` +
      `  - Solo COTIZACIONES, dudas, conversaciones iniciales sin diseno ni pago.\n` +
      `  - Chat de SALUDO sin contexto de pedido.\n` +
      `  - Pago a otro proveedor mencionado de pasada.\n\n` +
      `Si hay multiples pedidos en el chat, asume que SI hay venta (al menos UNO confirmado).\n\n` +
      `Responde SOLO JSON valido (sin markdown):\n` +
      `{"hayVenta": true|false,\n` +
      ` "confianza": "alta"|"media"|"baja",\n` +
      ` "evidencia": "frase exacta o descripcion del comprobante visto",\n` +
      ` "monto": "monto detectado o null",\n` +
      ` "fechaPago": "fecha del pago o null",\n` +
      ` "razon": "explicacion en una linea"}\n\n` +
      `═══════════════════════════════════════════════════════════════\n` +
      `CONVERSACION:\n`;

    // Gemini Flash: maneja texto + imagenes + audios nativos
    const parts = [{ text: preamble }];
    let idxMsg = 0;
    let imagenesUsadas = 0, audiosUsados = 0;
    const MAX_IMG = 8, MAX_AUDIO = 4;
    for (const m of mensajes) {
      idxMsg++;
      const cabecera = `\n[msg ${idxMsg} | ${m.quien} | ${m.fecha || ''}]${m.texto ? ' ' + m.texto.slice(0, 400) : ''}`;
      parts.push({ text: cabecera });
      for (const a of (m.attachments || [])) {
        if (!a || !a.base64 || !a.mime) continue;
        const isImg = a.mime.startsWith('image/');
        const isAud = a.mime.startsWith('audio/');
        if (isImg && imagenesUsadas < MAX_IMG) {
          parts.push({ text: `[IMG de ${m.quien}]:` });
          parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
          imagenesUsadas++;
        } else if (isAud && audiosUsados < MAX_AUDIO) {
          parts.push({ text: `[AUDIO de ${m.quien}]:` });
          parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
          audiosUsados++;
        }
      }
    }
    parts.push({ text: `\n═══════════════════════════════════════════════════════════════\nResponde SOLO el JSON pedido, sin markdown:` });

    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[gemini-venta] HTTP', r.status, errText.slice(0, 200));
      global._geminiUltimoError = `HTTP ${r.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      const parsed = JSON.parse(limpio);
      parsed._meta = { imagenesUsadas, audiosUsados, mensajesAnalizados: idxMsg, modelo };
      return parsed;
    } catch {
      global._geminiUltimoError = `parse error: ${limpio.slice(0, 300)}`;
      return { hayVenta: false, confianza: 'baja', razon: 'parse error', _raw: limpio.slice(0, 500) };
    }
  } catch (e) {
    console.error('[gemini-venta error]', e.message);
    global._geminiUltimoError = `exception: ${e.message}`;
    return null;
  }
}

async function analizarChatConClaude(mensajesEnriquecidos, datosPedido, analisisGemini) {
  global._claudeUltimoError = null;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { global._claudeUltimoError = 'no api key'; return null; }
    const modelo = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

    const preambleTexto = `Sos analista senior de W&S Enterprise (uniformes deportivos, Colombia).\n` +
      `Tu trabajo: determinar el estado REAL del PEDIDO ESPECIFICO que te indico, sin confundirte con otros pedidos del mismo chat.\n\n` +
      `═══ PEDIDO A EVALUAR ═══\n` +
      `ID interno: ${datosPedido.id}\n` +
      `Equipo/Nombre: "${datosPedido.equipo}"\n` +
      `Vendedora: ${datosPedido.vendedora}\n` +
      `Estado actual en la app: ${datosPedido.estado}\n` +
      `Abonado registrado: $${datosPedido.abonado || 0}\n\n` +
      `═══ ANALISIS PREVIO DE GEMINI (puede tener errores, vos validas) ═══\n` +
      `Resumen: ${analisisGemini?.resumen || 'sin resumen'}\n` +
      `Pedidos detectados: ${analisisGemini?.pedidosDetectados || '?'}\n` +
      `Estado sugerido: ${analisisGemini?.estadoReal || '?'}\n` +
      `Confianza: ${analisisGemini?.confianza || '?'}\n` +
      `Audios resumen: ${analisisGemini?.audiosResumen || 'sin audios'}\n` +
      `Imagenes resumen: ${analisisGemini?.imagenesResumen || 'sin imagenes'}\n\n` +
      `═══ REGLAS CLAVE (W&S) ═══\n` +
      `1. El cliente NUNCA dice "aprobado" explicito. Aprobacion = dejar de pedir cambios + dar tallas/listado/abono / decir "perfecto" / pedir mas cosas / preguntar por envio.\n` +
      `2. En el mismo chat pueden haber VARIOS pedidos (original + adiciones + nuevos). NO mezcles estados entre ellos.\n` +
      `3. Pedido ORIGINAL: el que ya esta en la app con el nombre "${datosPedido.equipo}". Es el que tenes que evaluar.\n` +
      `4. Adicion a pedido: agregar 1-2 prendas al mismo pedido (ej: "agrega a Bryan talla M"). NO es pedido nuevo.\n` +
      `5. Pedido NUEVO: listado completo de varias prendas + abono separado. Si lo detectas, marcalo aparte.\n` +
      `6. Si vendedora dice "listo para enviar" / "ya esta hecho" / "lo recoges manana" → produccion ya termino.\n` +
      `7. ENTREGADO en W&S = vendedora muestra DATOS DEL ENVIO (conductor/placa/foto InDrive/RappiPay) + cliente ACUSA RECIBO de los datos (ej: "listo", "gracias", "dale") + hay PAGO. EL CLIENTE RARAMENTE DICE "ya me llego" — la entrega se da por hecha cuando hay despacho + acuse. NO esperes confirmacion explicita de recepcion fisica.\n` +
      `8. "listo-para-entregar" solo aplica si la vendedora dice que esta listo PERO aun no despacho con conductor/empresa de envio.\n\n` +
      `═══ ESTADOS POSIBLES PARA EL PEDIDO ACTUAL ═══\n` +
      `- "diseno-pendiente": vendedora aun no ha mostrado diseno\n` +
      `- "esperando-respuesta-cliente": vendedora mando diseno pero cliente no respondio aun\n` +
      `- "en-correcciones": cliente pidio cambios al diseno y vendedora no respondio con nueva imagen\n` +
      `- "aprobado-pendiente-produccion": diseno aprobado, falta hacer calandra/costura\n` +
      `- "produccion-en-curso": esta en calandra o costura\n` +
      `- "listo-para-entregar": produccion terminada, falta entrega fisica\n` +
      `- "entregado": cliente recibio\n` +
      `- "no-aplica": chat no trata del pedido (ej: solo consulta general)\n\n` +
      `═══ TU TAREA ═══\n` +
      `Lee el chat completo (texto + imagenes). Responde SOLO JSON valido:\n` +
      `{\n` +
      `  "estadoVeredicto": "uno de los estados de arriba",\n` +
      `  "confianza": "alta"|"media"|"baja",\n` +
      `  "razonamiento": "2-3 lineas explicando como llegaste al estado, citando frases del chat",\n` +
      `  "citaClave": "frase exacta del cliente o vendedora que lo sustenta",\n` +
      `  "geminiEstuvoMal": true|false,\n` +
      `  "comentarioGemini": "si estuvo mal, en que se equivoco — vacio si bien",\n` +
      `  "hayPedidoAdicional": true|false,\n` +
      `  "pedidoAdicionalResumen": "si hay otro pedido en el chat, describelo brevemente — vacio si no",\n` +
      `  "abonoNuevoDetectado": numero_o_0,\n` +
      `  "accionRecomendada": "que deberia hacer la app (ej: mover a listo-para-entregar, crear pedido nuevo de 11 camisas, etc)"\n` +
      `}\n\n` +
      `═══════════════════════════════════════════════════════════════\n` +
      `CHAT (mas viejo arriba):\n`;

    const content = [{ type: 'text', text: preambleTexto }];
    let imgsUsadas = 0;
    const MAX_IMG_CLAUDE = 8;
    let idxMsg = 0;
    for (const m of mensajesEnriquecidos) {
      idxMsg++;
      let cabecera = `\n[msg ${idxMsg} | ${m.quien} | ${m.fecha || ''}]`;
      if (m.texto) cabecera += ` ${m.texto.slice(0, 500)}`;
      // Si hay audio, agregar el resumen de gemini como pista (Claude no acepta audio nativo)
      const audios = (m.attachments || []).filter(a => a.kind === 'audio');
      if (audios.length > 0) {
        cabecera += ` [AUDIO de ${m.quien} — ver "audiosResumen" arriba para contenido]`;
      }
      content.push({ type: 'text', text: cabecera });
      for (const a of (m.attachments || [])) {
        if (a.kind === 'image' && imgsUsadas < MAX_IMG_CLAUDE && a.base64) {
          // Claude vision: mime types image/jpeg, image/png, image/gif, image/webp
          const mt = (a.mime || 'image/jpeg').toLowerCase();
          if (mt.startsWith('image/')) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: mt, data: a.base64 }
            });
            imgsUsadas++;
          }
        }
      }
    }
    content.push({ type: 'text', text: `\n═══════════════════════════════════════════════════════════════\nResponde SOLO JSON valido (sin markdown):` });

    const body = {
      model: modelo,
      max_tokens: 1500,
      messages: [{ role: 'user', content }],
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!r.ok) {
      const errText = await r.text();
      console.error('[claude] HTTP', r.status, errText.slice(0, 300));
      global._claudeUltimoError = `HTTP ${r.status}: ${errText.slice(0, 300)}`;
      return null;
    }
    const data = await r.json();
    const texto = data?.content?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      const parsed = JSON.parse(limpio);
      parsed._meta = {
        modelo,
        imagenesUsadas: imgsUsadas,
        mensajesAnalizados: idxMsg,
        usage: data.usage || null,
      };
      return parsed;
    } catch {
      global._claudeUltimoError = `parse error: ${limpio.slice(0, 300)}`;
      return { _raw: limpio.slice(0, 2000), _meta: { modelo, imagenesUsadas: imgsUsadas } };
    }
  } catch (e) {
    console.error('[claude error]', e.message);
    global._claudeUltimoError = `exception: ${e.message}`;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// COMPARACION VISUAL: ¿es el mismo diseño la imagen aprobada por el
// cliente en Chatwoot vs los PDFs RIP en Drive?
// Si SI → el pedido ya esta en produccion (alguien hizo el rip).
// Si NO → el cliente aprobo pero todavia no se ripeo.
//
// Recibe: { imagenChatBase64, imagenChatMime, pdfsCandidatos: [{base64,mime,nombre}] }
// Devuelve: { coincide, confianza, razonamiento, pdfElegido, todosScores: [...] }
async function compararDisenosConGemini(imgChat, pdfsCandidatos, nombreEquipo) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    if (!imgChat || !imgChat.base64) return { coincide: false, error: 'sin imagen chat' };
    if (!pdfsCandidatos || pdfsCandidatos.length === 0) return { coincide: false, error: 'sin pdfs en Drive' };

    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

    const preamble = `Sos analista visual de W&S Enterprise. Te paso varias imagenes:\n` +
      `1) IMAGEN del diseno que la vendedora le envio al cliente para aprobacion (de Chatwoot).\n` +
      `2) THUMBNAILS (vista previa) de archivos PDF RIP que estan en Drive (carpeta PDF_RIP, listos para imprimir).\n\n` +
      `Pedido a evaluar: "${nombreEquipo || 'sin nombre'}".\n\n` +
      `Tu tarea: para CADA thumbnail, decime si visualmente es el MISMO diseno que la imagen aprobada del chat.\n` +
      `Compara: colores, escudo/logo, tipografia, distribucion, frase/texto, numeros, prenda.\n` +
      `Los thumbnails de PDF a veces muestran la prenda plana extendida (vista impresion) — la imagen del chat suele ser un render 3D del uniforme puesto. Aun asi tenes que reconocer si es el MISMO diseno.\n` +
      `Si hay match al menos en 70% de elementos clave → coincide.\n\n` +
      `Responde SOLO JSON (sin markdown):\n` +
      `{\n` +
      `  "coincide": true|false,\n` +
      `  "confianza": "alta"|"media"|"baja",\n` +
      `  "pdfElegido": "nombre del pdf que coincide o vacio",\n` +
      `  "razonamiento": "1-2 lineas explicando elementos compartidos",\n` +
      `  "scoresPorPdf": [{"nombre": "...", "coincide": true|false, "porQue": "..."}]\n` +
      `}\n\n` +
      `═══════════════════════════════════════════════════════════════\n` +
      `IMAGEN APROBADA POR CLIENTE (Chatwoot):\n`;

    const parts = [{ text: preamble }];
    parts.push({ inline_data: { mime_type: imgChat.mime || 'image/jpeg', data: imgChat.base64 } });
    parts.push({ text: `\n═══════════════════════════════════════════════════════════════\nTHUMBNAILS de PDFs RIP en Drive:\n` });
    let idxPdf = 0;
    for (const pdf of pdfsCandidatos.slice(0, 4)) {
      idxPdf++;
      parts.push({ text: `\n[Thumbnail ${idxPdf}] nombre del PDF: "${pdf.nombre}"` });
      parts.push({ inline_data: { mime_type: pdf.mime || 'image/jpeg', data: pdf.base64 } });
    }
    parts.push({ text: `\n═══════════════════════════════════════════════════════════════\nResponde JSON:` });

    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[gemini-comparar] HTTP', r.status, errText.slice(0, 200));
      return { coincide: false, error: `HTTP ${r.status}: ${errText.slice(0, 200)}` };
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      const parsed = JSON.parse(limpio);
      parsed._meta = { pdfsComparados: idxPdf };
      return parsed;
    } catch {
      return { coincide: false, _raw: limpio.slice(0, 1000), error: 'parse error' };
    }
  } catch (e) {
    console.error('[gemini-comparar error]', e.message);
    return { coincide: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────
// MATCH /costura: compara FRENTE + ESPALDA del corte real (fotos tomadas
// por Camilo) contra varios pedidos candidatos del ERP. Devuelve ranking.
// fotosCorte: [{base64, mime, vista: "frente"|"espalda"}]
// candidatos: [{ pedido_id, equipo, vendedora, base64, mime, fuente }]
async function matchFotosCorteConPedidos(fotosCorte, candidatos) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { error: 'sin GEMINI_API_KEY' };
    if (!fotosCorte || fotosCorte.length === 0) return { error: 'sin fotos del corte' };
    if (!candidatos || candidatos.length === 0) return { error: 'sin candidatos del ERP', matches: [] };

    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

    const cand = candidatos.slice(0, 4); // max 4 para no quemar tokens

    const nFotos = fotosCorte.length;
    const descFotos = nFotos === 1
      ? `Camilo (gerente) saco UNA foto de un corte/prenda fisica que va a costura.`
      : `Camilo (gerente) saco ${nFotos} fotos (${fotosCorte.map(f => (f.vista||'').toUpperCase()).filter(Boolean).join(', ') || 'distintas vistas'}) de un corte/prenda fisica que va a costura.`;
    const preamble = `Sos analista visual de W&S Enterprise (fabrica de uniformes deportivos sublimados, Colombia).\n\n` +
      `${descFotos}\n\n` +
      `Te paso esa(s) foto(s) primero, y despues te paso ${cand.length} imagenes de DISEÑOS de pedidos diferentes del ERP.\n` +
      `Esas imagenes pueden ser: render 3D del uniforme, foto del PDF RIP de impresion, o foto que el cliente aprobo en WhatsApp.\n\n` +
      `Tu tarea: determinar a CUAL de los ${cand.length} pedidos pertenece el corte fisico.\n` +
      `Compara: colores, escudo/logo, tipografia, distribucion del diseno, frase/texto, numeros, prenda.\n` +
      `IGNORA: el angulo de la foto, arrugas, sombras, calidad. El corte fisico puede verse "feo" pero el diseño es el mismo.\n\n` +
      `Responde SOLO JSON (sin markdown):\n` +
      `{\n` +
      `  "mejorMatch": <numero del pedido 1..${cand.length}> o null si ninguno,\n` +
      `  "confianza": "alta"|"media"|"baja"|"ninguna",\n` +
      `  "razonamiento": "1 linea explicando elementos compartidos",\n` +
      `  "scores": [\n` +
      cand.map((c, i) => `    {"n": ${i+1}, "pedido_id": ${c.pedido_id}, "equipo": "${c.equipo || ''}", "coincide": true|false, "confianza": "alta"|"media"|"baja", "porQue": "..."}`).join(',\n') + `\n` +
      `  ]\n` +
      `}\n\n` +
      `═══════════════════════════════════════════════════════════════\n` +
      `FOTOS DEL CORTE FISICO (sacadas por Camilo):\n`;

    const parts = [{ text: preamble }];
    for (const f of fotosCorte) {
      parts.push({ text: `\n[${(f.vista || '').toUpperCase()}]` });
      parts.push({ inline_data: { mime_type: f.mime || 'image/jpeg', data: f.base64 } });
    }
    parts.push({ text: `\n═══════════════════════════════════════════════════════════════\nDISEÑOS DE PEDIDOS CANDIDATOS DEL ERP:\n` });
    cand.forEach((c, i) => {
      parts.push({ text: `\n[Pedido ${i+1}] equipo: "${c.equipo || 'sin nombre'}" — vendedora: "${c.vendedora || ''}"` });
      parts.push({ inline_data: { mime_type: c.mime || 'image/jpeg', data: c.base64 } });
    });
    parts.push({ text: `\n═══════════════════════════════════════════════════════════════\nResponde JSON:` });

    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[gemini-match-costura] HTTP', r.status, errText.slice(0, 200));
      return { error: `HTTP ${r.status}: ${errText.slice(0, 200)}`, matches: [] };
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try {
      const parsed = JSON.parse(limpio);
      // Enriquecer scores con datos del candidato
      const matches = (parsed.scores || []).map(s => {
        const cn = cand[s.n - 1] || {};
        return {
          pedido_id: cn.pedido_id,
          equipo: cn.equipo,
          vendedora: cn.vendedora,
          coincide: !!s.coincide,
          confianza: s.confianza || 'baja',
          porQue: s.porQue || '',
        };
      });
      return {
        ok: true,
        mejorMatch: parsed.mejorMatch ? cand[parsed.mejorMatch - 1] : null,
        confianzaGlobal: parsed.confianza || 'ninguna',
        razonamiento: parsed.razonamiento || '',
        matches,
        candidatosEvaluados: cand.length,
      };
    } catch {
      return { error: 'parse error', _raw: limpio.slice(0, 1000), matches: [] };
    }
  } catch (e) {
    console.error('[match-costura error]', e.message);
    return { error: e.message, matches: [] };
  }
}

// ─────────────────────────────────────────────────────────────────
// Extrae lista de jugadores de una imagen (foto del chat con tabla).
// Soporta fotos de papel escrito a mano, Excel, capturas de pantalla.
// Devuelve: { jugadores: [{ talla, nombre, numero, prendas: {...} }], errores: [...] }
async function extraerListaJugadoresConGemini(imgBase64, imgMime) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const prompt = `Esta imagen es un listado de jugadores para un pedido de uniformes deportivos en W&S Enterprise (Colombia).\n` +
      `Puede ser una foto de una tabla escrita a mano, Excel, captura de WhatsApp, o lista digital.\n\n` +
      `Extrae CADA fila como un jugador con:\n` +
      `- talla (numero o letra: 8, 10, 12, S, M, L, XL, etc)\n` +
      `- nombre (el nombre a estampar en la espalda)\n` +
      `- numero (el numero a estampar, si lo hay)\n\n` +
      `Si ves puntos/marcas de colores al lado de cada fila, anotalos en "marcasDetectadas" (NO los uses como datos del jugador).\n\n` +
      `Responde SOLO JSON valido (sin markdown):\n` +
      `{\n` +
      `  "esLista": true|false,  // false si la imagen no es un listado de jugadores\n` +
      `  "encabezado": "titulo de la lista si lo hay (ej: 'Ahijado Lider', 'Transicion')",\n` +
      `  "totalJugadores": numero,\n` +
      `  "jugadores": [\n` +
      `    {"talla": "8", "nombre": "Santiago C", "numero": "1"},\n` +
      `    {"talla": "8", "nombre": "Thomas", "numero": ""}\n` +
      `  ],\n` +
      `  "marcasDetectadas": "descripcion breve de las marcas/colores si hay, ej: 'puntos verdes y azules al lado'",\n` +
      `  "confianza": "alta"|"media"|"baja"\n` +
      `}\n\nRespuesta:`;
    const body = {
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: imgMime || 'image/jpeg', data: imgBase64 } },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[extraer-lista] HTTP', r.status, errText.slice(0,200));
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try { return JSON.parse(limpio); }
    catch { return { _raw: limpio.slice(0, 500) }; }
  } catch (e) {
    console.error('[extraer-lista error]', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Clasifica una imagen como: diseno-uniforme | comprobante-pago | lista-tallas | otro
// Usado para descartar comprobantes/listas antes de extraer texto del diseno.
async function clasificarImagenConGemini(imgBase64, imgMime) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const prompt = `Clasifica esta imagen en una de estas categorias:\n` +
      `- "diseno-uniforme": render o mockup de uniforme deportivo (camisa, chaqueta, pantaloneta, conjunto). Suele ser una imagen 3D del producto.\n` +
      `- "comprobante-pago": captura de DaviPlata, Nequi, Bancolombia, transferencia, recibo de pago, "Venta confirmada", "Transaccion exitosa".\n` +
      `- "lista-tallas": foto de papel o captura con nombres y tallas escritas (a mano o digital).\n` +
      `- "foto-prenda-real": foto real de la prenda fisica (no render).\n` +
      `- "otro": cualquier otra cosa.\n\n` +
      `Responde SOLO JSON: {"tipo": "uno de los anteriores", "confianza": "alta"|"media"|"baja"}`;
    const body = {
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: imgMime || 'image/jpeg', data: imgBase64 } },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try { return JSON.parse(limpio); } catch { return null; }
  } catch (e) {
    console.error('[clasificar-img]', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Extrae el TEXTO VISIBLE en una imagen de diseño (lema del equipo,
// nombre del club, frase principal). Sirve para buscar PDFs en Drive
// porque el nombre del pedido en la app a veces NO coincide con el
// texto que sale en el diseño impreso.
// Ej: pedido "wigo" pero el diseño dice "POR UN BELLO SAN MARTIN" →
// buscar PDFs con "por un bello san martin" en el nombre.
async function extraerTextoDeDisenoConGemini(imgBase64, imgMime) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const prompt = `Esta imagen es el diseno de un uniforme deportivo (camisa/chaqueta/pantaloneta) de W&S Enterprise.\n\n` +
      `Extrae el TEXTO PRINCIPAL visible en el diseno (nombre del club, lema, frase, ciudad, sponsor — NO el logo de W&S ni placeholders como NOMBRE/10).\n` +
      `Tambien identifica colores principales del uniforme y tipo de prenda.\n\n` +
      `Responde SOLO JSON valido (sin markdown):\n` +
      `{\n` +
      `  "textoPrincipal": "frase exacta que aparece en el diseno (ej: 'POR UN BELLO SAN MARTIN')",\n` +
      `  "textoSecundario": "otro texto si lo hay",\n` +
      `  "palabrasClaveBusqueda": ["palabra1", "palabra2", "palabra3"],  // palabras que servirian para buscar el PDF en Drive (sin stopwords como POR, UN, DE)\n` +
      `  "colores": ["color1", "color2"],\n` +
      `  "tipoPrenda": "camisa-futbol|baloncesto|chaqueta|pantaloneta|conjunto|otro",\n` +
      `  "hayEscudo": true|false\n` +
      `}\n\nRespuesta:`;
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: imgMime || 'image/jpeg', data: imgBase64 } },
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[extraer-texto] HTTP', r.status, errText.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const limpio = texto.replace(/```json\s*|\s*```/g, '').trim();
    try { return JSON.parse(limpio); }
    catch { return { _raw: limpio.slice(0, 500) }; }
  } catch (e) {
    console.error('[extraer-texto error]', e.message);
    return null;
  }
}



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

// ═════════════════════════════════════════════════════════════════
// HELPERS DE PAGO 50/50 — campos abonado/pagos[]/total/pagadoCompleto
// Trabajan sobre el JSON del pedido (la tabla pedidos guarda data TEXT).
// Diseño conservador: si total no esta definido, NO se bloquea nada.
// La visibilidad de campos financieros la filtra _filtrarPedidoSegunRol.
// ═════════════════════════════════════════════════════════════════
function _inicializarPagosPedido(p) {
  if (!Array.isArray(p.pagos)) p.pagos = [];
  if (typeof p.abonado !== 'number') p.abonado = 0;
  if (typeof p.total !== 'number') p.total = p.total ?? null;
}

// Recalcula abonado desde pagos[] (fuente de verdad) y pagadoCompleto.
function _recalcularEstadoPago(p) {
  _inicializarPagosPedido(p);
  p.abonado = (p.pagos || []).reduce((s, x) => s + (Number(x.monto) || 0), 0);
  p.saldoPendiente = (typeof p.total === 'number' && p.total > 0)
    ? Math.max(0, p.total - p.abonado)
    : null;
  p.pagadoCompleto = (typeof p.total === 'number' && p.total > 0)
    ? (p.abonado >= p.total)
    : false;
  return p;
}

// Anade un pago al pedido. Dedup por comprobante_id si viene.
// Devuelve true si se anadio (false si era duplicado).
function _anadirPagoAPedido(p, pago) {
  _inicializarPagosPedido(p);
  if (pago.comprobante_id) {
    const yaExiste = p.pagos.some(x => x.comprobante_id === pago.comprobante_id);
    if (yaExiste) return false;
  }
  p.pagos.push({
    monto: Number(pago.monto) || 0,
    fecha: pago.fecha || new Date().toISOString(),
    banco: pago.banco || null,
    origen: pago.origen || 'manual',
    comprobante_id: pago.comprobante_id || null,
    nota: pago.nota || null,
  });
  _recalcularEstadoPago(p);
  // Log al historial del pedido
  p.historial = p.historial || [];
  p.historial.push({
    fecha: new Date().toISOString(),
    por: pago.origen === 'comprobante' ? 'comprobante-bot' : 'manual',
    accion: 'agregar-pago',
    nota: `Pago $${(Number(pago.monto)||0).toLocaleString('es-CO')}${pago.banco ? ' ('+pago.banco+')' : ''}`,
  });
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// PRIMER PAGO PENDIENTE — Detector que crea pedidos AUTO cuando llega
// un comprobante de un cliente que NO tiene pedido activo.
// La vendedora puede responder con "equipo NOMBRE" para crear el pedido.
// ═══════════════════════════════════════════════════════════════════
const PRIMER_PAGOS_FILE = path.join(__dirname, 'data', 'primer-pagos-pendientes.json');

// ═══════════════════════════════════════════════════════════════════
// ALERTAS NOTIFICADAS — anti-spam para JARVIS
// JARVIS hace polling cada 30 min. Para NO repetir la misma alerta,
// cada vez que avisa a Camilo marca el alert_id como "visto" en este
// JSON. TTL 7 dias (despues se borra solo).
// ═══════════════════════════════════════════════════════════════════
const ALERTAS_NOTIFICADAS_FILE = path.join(__dirname, 'data', 'alertas-notificadas.json');
function _leerAlertasNotificadas() {
  try {
    const arr = JSON.parse(fs.readFileSync(ALERTAS_NOTIFICADAS_FILE, 'utf8'));
    const ahora = Date.now();
    const limite = 7 * 24 * 60 * 60 * 1000;
    return arr.filter(a => (ahora - new Date(a.notificadoEn).getTime()) < limite);
  } catch { return []; }
}
function _guardarAlertasNotificadas(arr) {
  fs.mkdirSync(path.dirname(ALERTAS_NOTIFICADAS_FILE), { recursive: true });
  fs.writeFileSync(ALERTAS_NOTIFICADAS_FILE, JSON.stringify(arr, null, 2));
}
function alertaYaNotificada(alertId) {
  return _leerAlertasNotificadas().some(a => a.alert_id === alertId);
}
function marcarAlertasNotificadas(alertIds) {
  if (!Array.isArray(alertIds) || alertIds.length === 0) return 0;
  const existentes = _leerAlertasNotificadas();
  const ahora = new Date().toISOString();
  const nuevas = alertIds
    .filter(id => !existentes.some(a => a.alert_id === id))
    .map(id => ({ alert_id: id, notificadoEn: ahora }));
  if (nuevas.length === 0) return 0;
  _guardarAlertasNotificadas([...existentes, ...nuevas]);
  return nuevas.length;
}

// Computa las 4 categorias de alertas NO notificadas todavia (TTL 7 dias).
// Usado por el endpoint /api/asistente/alertas-pendientes Y por el cron interno cronAlertasJefe.
// Si autoMarcar=true, marca todas las devueltas como notificadas (no se repiten).
// Devuelve { ok, total_nuevas, timestamp, mensaje_wa, marcadas_auto, categorias, nota_jarvis }
function _computarAlertas(autoMarcar) {
  const ahora = Date.now();
  const peds = leerPedidos();

  const consignaciones = _leerPrimerPagos()
    .filter(p => p.estado === 'esperando-equipo')
    .filter(p => {
      const horas = (ahora - new Date(p.creadoEn).getTime()) / 36e5;
      return horas >= 12 && horas < 48;
    })
    .map(p => ({
      alert_id: `consignacion:${p.id}`,
      categoria: 'consignaciones',
      urgencia: 'media',
      monto: p.monto,
      banco: p.banco,
      vendedora: p.vendedora,
      cliente_telefono: p.telefono,
      cliente_nombre: p.nombreCliente,
      horas_pendiente: Math.round((ahora - new Date(p.creadoEn).getTime()) / 36e5),
      accion_sugerida: `POST /api/asistente/consignaciones/${p.id}/crear-pedido o /ignorar`,
    }))
    .filter(a => !alertaYaNotificada(a.alert_id));

  const movs = (typeof db !== 'undefined' && db.leerMovimientosCosturaPendientes) ? (db.leerMovimientosCosturaPendientes() || []) : [];
  const costuraAtascada = movs
    .map(m => {
      const fe = m.fecha_envio ? new Date(m.fecha_envio).getTime() : null;
      const dias = fe ? Math.floor((ahora - fe) / 86400000) : null;
      return { m, dias };
    })
    .filter(x => x.dias !== null && x.dias >= 7)
    .map(x => ({
      alert_id: `costura:${x.m.id || `${x.m.pedido_id}:${x.m.costurera_slug}`}`,
      categoria: 'costura_atascada',
      urgencia: x.dias >= 14 ? 'alta' : 'media',
      pedido_id: x.m.pedido_id,
      equipo: x.m.equipo,
      costurera: x.m.costurera_nombre,
      prenda: x.m.prenda,
      cantidad: x.m.cantidad_enviada,
      dias_en_costura: x.dias,
    }))
    .filter(a => !alertaYaNotificada(a.alert_id));

  const ESTADOS_ACTIVOS_VISIBLES = ['hacer-diseno', 'aprobado', 'enviado-calandra', 'calandra', 'llego-impresion', 'corte', 'tela-recibida'];
  const pedidosParados = peds
    .filter(p => ESTADOS_ACTIVOS_VISIBLES.includes(p.estado))
    .map(p => {
      const ultimo = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : null;
      const dias = ultimo ? Math.floor((ahora - ultimo) / 86400000) : null;
      return { p, dias };
    })
    .filter(x => x.dias !== null && x.dias >= 5)
    .sort((a, b) => b.dias - a.dias)
    .slice(0, 15)
    .map(x => ({
      alert_id: `pedido_parado:${x.p.id}:${x.dias}`,
      categoria: 'pedidos_parados',
      urgencia: x.dias >= 10 ? 'alta' : 'media',
      pedido_id: x.p.id,
      equipo: x.p.equipo,
      vendedora: x.p.vendedora,
      estado: x.p.estado,
      dias_sin_movimiento: x.dias,
    }))
    .filter(a => !alertaYaNotificada(a.alert_id));

  const disenosSinAsignar = peds
    .filter(p => p.estado === 'hacer-diseno' && !p.disenadorAsignado)
    .map(p => {
      const venta = p.fechaVenta ? new Date(p.fechaVenta).getTime() : null;
      const horas = venta ? (ahora - venta) / 36e5 : null;
      return { p, horas };
    })
    .filter(x => x.horas !== null && x.horas >= 24)
    .sort((a, b) => b.horas - a.horas)
    .slice(0, 10)
    .map(x => ({
      alert_id: `diseno_sin_asignar:${x.p.id}`,
      categoria: 'disenos_sin_asignar',
      urgencia: x.horas >= 48 ? 'alta' : 'media',
      pedido_id: x.p.id,
      equipo: x.p.equipo,
      vendedora: x.p.vendedora,
      horas_pendiente: Math.round(x.horas),
    }))
    .filter(a => !alertaYaNotificada(a.alert_id));

  const total_nuevas = consignaciones.length + costuraAtascada.length + pedidosParados.length + disenosSinAsignar.length;

  let mensaje_wa = '';
  if (total_nuevas > 0) {
    const lineas = [`Camilo, ${total_nuevas} cosas para revisar:`];
    if (consignaciones.length) lineas.push(`- ${consignaciones.length} consignacion(es) huerfana(s)`);
    if (costuraAtascada.length) lineas.push(`- ${costuraAtascada.length} pedido(s) atascado(s) en costura`);
    if (pedidosParados.length) lineas.push(`- ${pedidosParados.length} pedido(s) parado(s)`);
    if (disenosSinAsignar.length) lineas.push(`- ${disenosSinAsignar.length} diseno(s) sin asignar`);
    mensaje_wa = lineas.join('\n');
  }

  if (autoMarcar && total_nuevas > 0) {
    const todosIds = [
      ...consignaciones.map(a => a.alert_id),
      ...costuraAtascada.map(a => a.alert_id),
      ...pedidosParados.map(a => a.alert_id),
      ...disenosSinAsignar.map(a => a.alert_id),
    ];
    marcarAlertasNotificadas(todosIds);
  }

  return {
    ok: true,
    total_nuevas,
    timestamp: new Date().toISOString(),
    mensaje_wa,
    marcadas_auto: !!(autoMarcar && total_nuevas > 0),
    categorias: {
      consignaciones,
      costura_atascada: costuraAtascada,
      pedidos_parados: pedidosParados,
      disenos_sin_asignar: disenosSinAsignar,
    },
    nota_jarvis: total_nuevas > 0
      ? `Hay ${total_nuevas} alertas. El campo mensaje_wa ya esta formateado, mandalo TAL CUAL al WA de Camilo.`
      : 'mensaje_wa vacio. NO mandes nada. Devolve "ok" y termina.',
  };
}

function _leerPrimerPagos() {
  try { return JSON.parse(fs.readFileSync(PRIMER_PAGOS_FILE, 'utf8')); }
  catch { return []; }
}
function _guardarPrimerPagos(arr) {
  fs.mkdirSync(path.dirname(PRIMER_PAGOS_FILE), { recursive: true });
  fs.writeFileSync(PRIMER_PAGOS_FILE, JSON.stringify(arr, null, 2));
}

// Guarda un primer pago "huerfano" esperando que la vendedora le ponga nombre.
// Limpia primer-pagos viejos (>48h) y duplicados (mismo telefono+monto en <2h).
function guardarPrimerPagoPendiente({ telefono, vendedora, monto, banco, fecha, nombreCliente, comprobante_id }) {
  if (!telefono || !monto || !vendedora) return null;
  let pagos = _leerPrimerPagos();
  const ahora = Date.now();
  // Limpiar viejos (>48h)
  pagos = pagos.filter(p => (ahora - new Date(p.creadoEn).getTime()) < 48 * 60 * 60 * 1000);
  // No duplicar (mismo tel+monto en <2h)
  const tel = String(telefono).replace(/\D/g, '');
  const dup = pagos.find(p =>
    String(p.telefono).replace(/\D/g, '') === tel
    && Math.abs(p.monto - monto) < monto * 0.05
    && (ahora - new Date(p.creadoEn).getTime()) < 2 * 60 * 60 * 1000
  );
  if (dup) return dup;
  const nuevo = {
    id: 'pp_' + ahora.toString(36) + Math.random().toString(36).slice(2, 6),
    telefono: tel,
    vendedora,
    monto,
    banco: banco || null,
    fecha: fecha || new Date().toISOString(),
    nombreCliente: nombreCliente || null,
    comprobante_id: comprobante_id || null,
    creadoEn: new Date().toISOString(),
    estado: 'esperando-equipo',
  };
  pagos.push(nuevo);
  _guardarPrimerPagos(pagos);
  return nuevo;
}

// Devuelve el primer-pago-pendiente mas reciente de una vendedora que sigue
// esperando respuesta de equipo. Si hay varios, devuelve el ultimo.
function primerPagoPendienteParaVendedora(vendedora) {
  const pagos = _leerPrimerPagos();
  const ahora = Date.now();
  const pendientes = pagos
    .filter(p => p.vendedora === vendedora && p.estado === 'esperando-equipo')
    .filter(p => (ahora - new Date(p.creadoEn).getTime()) < 48 * 60 * 60 * 1000)
    .sort((a, b) => new Date(b.creadoEn).getTime() - new Date(a.creadoEn).getTime());
  return pendientes[0] || null;
}

function marcarPrimerPagoAtendido(id, pedidoCreadoId) {
  const pagos = _leerPrimerPagos();
  const idx = pagos.findIndex(p => p.id === id);
  if (idx < 0) return false;
  pagos[idx].estado = 'atendido';
  pagos[idx].pedidoCreadoId = pedidoCreadoId;
  pagos[idx].atendidoEn = new Date().toISOString();
  _guardarPrimerPagos(pagos);
  return true;
}

// Crea un pedido nuevo a partir de un primer-pago pendiente + nombre del equipo
// que respondio la vendedora. Suma el monto al abonado del pedido recien creado.
function crearPedidoDesdePrimerPago(pendiente, nombreEquipo) {
  if (!pendiente || !nombreEquipo) return null;
  const pedidos = leerPedidos();
  const nextId = leerNextId();
  const ahora = new Date().toISOString();
  const pedidoNuevo = {
    id: nextId,
    equipo: nombreEquipo.trim(),
    telefono: pendiente.telefono,
    vendedora: pendiente.vendedora,
    tipoBandeja: 'pedido',
    estado: 'hacer-diseno',
    creadoEn: new Date().toLocaleDateString('es-CO'),
    fechaVenta: ahora,
    items: [],
    fechaEntrega: '',
    notas: `Creado automaticamente por primer pago de $${pendiente.monto} ${pendiente.banco || ''}`,
    arreglo: null,
    origenBot: false,
    origenComprobante: true,
    pushNameCliente: pendiente.nombreCliente,
    abonado: 0, // se llena por _anadirPagoAPedido
    pagos: [],
    ultimoMovimiento: ahora,
    historial: [{
      fecha: ahora,
      por: 'primer-pago-auto',
      accion: 'crear-pedido',
      nota: `Pedido nacido de comprobante sin pedido. Vendedora ${pendiente.vendedora} respondio "equipo ${nombreEquipo}".`,
    }],
  };
  pedidos.push(pedidoNuevo);
  // Asignar disenadora segun vendedora
  if (typeof asignarDisenadora === 'function') {
    try { pedidoNuevo.disenadorAsignado = asignarDisenadora(pedidoNuevo.vendedora); } catch {}
  }
  // Sumar el pago al abonado
  _anadirPagoAPedido(pedidoNuevo, {
    monto: pendiente.monto,
    banco: pendiente.banco,
    fecha: pendiente.fecha,
    comprobante_id: pendiente.comprobante_id,
    origen: 'comprobante',
  });
  guardarPedidos(pedidos, nextId + 1);
  marcarPrimerPagoAtendido(pendiente.id, pedidoNuevo.id);
  return pedidoNuevo;
}

// Intenta vincular comprobante recien detectado a pedido(s) y sumar al abonado.
// Si pedidoId es conocido → directo. Si no, busca por telefono entre activos.
function vincularComprobanteAPedido({ pedidoId, telefono, monto, banco, fecha, comprobante_id }) {
  if (!monto) return { vinculado: false, motivo: 'sin-monto' };
  const pedidos = leerPedidos();
  let pedido = null;
  if (pedidoId) {
    pedido = pedidos.find(x => x.id === pedidoId);
  }
  if (!pedido && telefono) {
    const tel = String(telefono).replace(/\D/g, '');
    // Buscar pedido activo (no enviado-final) con mismo telefono, mas reciente
    const candidatos = pedidos.filter(x => {
      if (!x.telefono) return false;
      if (x.estado === 'enviado-final') return false;
      return String(x.telefono).replace(/\D/g, '') === tel;
    }).sort((a, b) => {
      const ta = new Date(a.ultimoMovimiento || a.fecha || 0).getTime();
      const tb = new Date(b.ultimoMovimiento || b.fecha || 0).getTime();
      return tb - ta;
    });
    pedido = candidatos[0] || null;
  }
  if (!pedido) return { vinculado: false, motivo: 'sin-pedido' };
  const agregado = _anadirPagoAPedido(pedido, {
    monto, banco, fecha,
    comprobante_id,
    origen: 'comprobante',
  });
  if (!agregado) return { vinculado: false, motivo: 'duplicado', pedidoId: pedido.id };
  db.guardarPedidos(pedidos);
  return {
    vinculado: true,
    pedidoId: pedido.id,
    abonado: pedido.abonado,
    total: pedido.total,
    saldoPendiente: pedido.saldoPendiente,
    pagadoCompleto: pedido.pagadoCompleto,
  };
}

// Detecta si el comprobante recien llegado podria ser un PAGO DUPLICADO
// (cliente mando el mismo pantallazo dos veces o se equivoco).
// Mira pagos del pedido en las ultimas 24h con monto similar (+/- 10%)
// y mismo banco. Si encuentra, devuelve { sospechoso: true, otro }.
function esPagoDuplicadoSospechoso(pedido, monto, banco) {
  if (!pedido || !Array.isArray(pedido.pagos) || !monto) return { sospechoso: false };
  const ahora = Date.now();
  const _24H = 24 * 60 * 60 * 1000;
  const margen = monto * 0.1;
  const mismoBanco = (b1, b2) => {
    if (!b1 || !b2) return true;
    return String(b1).toLowerCase().includes(String(b2).toLowerCase().slice(0, 4))
        || String(b2).toLowerCase().includes(String(b1).toLowerCase().slice(0, 4));
  };
  for (const pago of pedido.pagos) {
    const ts = new Date(pago.fecha || 0).getTime();
    if (!ts || isNaN(ts)) continue;
    if ((ahora - ts) > _24H) continue;
    if (Math.abs((pago.monto || 0) - monto) > margen) continue;
    if (!mismoBanco(pago.banco, banco)) continue;
    return { sospechoso: true, otro: pago };
  }
  return { sospechoso: false };
}

// Devuelve resumen del cliente para contexto en WA notificaciones.
// Cuenta pedidos del ult ano, totales, ultima compra.
function obtenerContextoCliente(telefono, pedidoActualId) {
  if (!telefono) return null;
  const norm = (t) => {
    const d = String(t || '').replace(/\D/g, '');
    return d.startsWith('57') ? d.slice(2) : d;
  };
  const telN = norm(telefono);
  const todos = leerPedidos();
  const _1ANO = 365 * 24 * 60 * 60 * 1000;
  const ahora = Date.now();
  const delCliente = todos.filter(p => {
    if (!p.telefono) return false;
    if (norm(p.telefono) !== telN) return false;
    if (p.id === pedidoActualId) return false;
    const ts = new Date(p.ultimoMovimiento || 0).getTime();
    return ts && (ahora - ts) <= _1ANO;
  });
  if (delCliente.length === 0) return { repetido: false };
  const cerrados = delCliente.filter(p => p.estado === 'enviado-final' || p.estado === 'archivado');
  const activos = delCliente.filter(p => p.estado !== 'enviado-final' && p.estado !== 'archivado' && p.estado !== 'cancelado');
  const totalAbonado = delCliente.reduce((s, p) => s + (Number(p.abonado) || 0), 0);
  delCliente.sort((a, b) => {
    const ta = new Date(a.ultimoMovimiento || 0).getTime();
    const tb = new Date(b.ultimoMovimiento || 0).getTime();
    return tb - ta;
  });
  return {
    repetido: true,
    total: delCliente.length,
    cerrados: cerrados.length,
    activos: activos.length,
    totalAbonadoAno: totalAbonado,
    ultimoPedido: delCliente[0] ? { id: delCliente[0].id, equipo: delCliente[0].equipo, estado: delCliente[0].estado } : null,
  };
}

// Si una factura tiene pedido_id y total, sincroniza pedido.total con factura.total.
function syncTotalDesdeFactura(factura) {
  if (!factura || !factura.pedido_id || !factura.total) return;
  const pedidos = leerPedidos();
  const p = pedidos.find(x => x.id === factura.pedido_id);
  if (!p) return;
  _inicializarPagosPedido(p);
  // Solo seteamos si el pedido no tenia total (no pisar valor manual del admin)
  if (p.total == null || p.total === 0) {
    p.total = Number(factura.total) || null;
    _recalcularEstadoPago(p);
    p.historial = p.historial || [];
    p.historial.push({
      fecha: new Date().toISOString(),
      por: 'factura-link',
      accion: 'set-total',
      nota: `Total $${(p.total||0).toLocaleString('es-CO')} tomado de factura #${factura.numero}`,
    });
    db.guardarPedidos(pedidos);
  }
}

// ═════════════════════════════════════════════════════════════════
// CAPTURA DOCUMENTOS SALIENTES DE VENDEDORAS (facturas hechas manual)
// Las 4 vendedoras (Betty, Ney, Wendy, Paola) mandan PDFs/imagenes de
// facturas a sus clientes. Este listener intercepta esos mensajes,
// sube el archivo a Drive y guarda metadata en BD para revision.
// ═════════════════════════════════════════════════════════════════
async function capturarDocumentoSalienteVendedora({ instance, vendedora, messageKey, message, messageType, telefonoCliente, pushName }) {
  try {
    if (db.leerDocumentoSalienteWAporId) {
      // Evitar duplicados por message_id (UNIQUE en tabla)
    }
    // Descargar el medio via Evolution
    const media = await descargarImagenEvolution(instance, messageKey);
    if (!media || !media.base64) {
      console.log(`[doc-saliente] no se pudo descargar ${vendedora}→${telefonoCliente}`);
      return null;
    }

    // Determinar extension/nombre original
    let fileNameOriginal = '';
    let ext = '';
    let mimeType = media.mimeType || 'application/octet-stream';
    if (messageType === 'documentMessage' || messageType === 'documentWithCaptionMessage') {
      const doc = message?.documentMessage
        || message?.documentWithCaptionMessage?.message?.documentMessage
        || {};
      fileNameOriginal = doc.fileName || '';
      mimeType = doc.mimetype || mimeType;
      ext = (fileNameOriginal.split('.').pop() || '').toLowerCase();
      if (!ext && mimeType.includes('pdf')) ext = 'pdf';
      if (!ext) ext = mimeType.split('/').pop() || 'bin';
    } else if (messageType === 'imageMessage') {
      ext = (mimeType.split('/').pop() || 'jpg').toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
    }

    // Filtro: solo PDF e imagenes (descartar videos, audios, etc)
    const tiposAceptados = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
    if (!tiposAceptados.includes(ext)) {
      console.log(`[doc-saliente] tipo no aceptado: ${ext} (${vendedora}→${telefonoCliente})`);
      return null;
    }

    // Calcular bytes aproximados desde base64
    const bytes = Math.floor((media.base64.length * 3) / 4);
    // Filtro: descartar archivos sospechosamente pequeños (<5KB suele ser ruido)
    if (bytes < 5000) {
      console.log(`[doc-saliente] muy pequeño ${bytes}b — descartado (${vendedora}→${telefonoCliente})`);
      return null;
    }

    // SHA256 del archivo — para cruzar con fotos en Drive CATALOGO y amarrar pedido al cliente
    let fileHash = null;
    try {
      const crypto = require('crypto');
      const buf = Buffer.from(media.base64, 'base64');
      fileHash = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (eH) { console.error('[doc-saliente hash err]', eH.message); }

    // Subir a Drive (carpeta FACTURAS, prefijo WA- para distinguir)
    const fecha = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }).replace(/\//g, '-');
    const tituloLimpio = (fileNameOriginal || `${vendedora}-${telefonoCliente}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const tituloArchivo = `WA-${vendedora}-${fecha}-${telefonoCliente}-${tituloLimpio}.${ext}`;

    let subida = null;
    try {
      subida = await driveSync.subirArchivo({
        titulo: tituloArchivo,
        mimeType,
        contentBase64: media.base64,
        parentId: driveSync.FOLDER_FACTURAS,
      });
      try { await driveSync.hacerArchivoPublico(subida.id); } catch (e) {}
    } catch (e) {
      console.error('[doc-saliente upload Drive err]', e.message);
      // Aún sin Drive, guardamos metadata para no perder el evento
    }

    // Guardar metadata
    const insertResult = db.insertDocumentoSalienteWA({
      message_id: messageKey?.id || null,
      instance,
      vendedora,
      cliente_telefono: telefonoCliente,
      cliente_push_name: pushName || null,
      file_name_original: fileNameOriginal || null,
      tipo_mime: mimeType,
      drive_file_id: subida?.id || null,
      drive_link: subida?.viewLink || null,
      bytes,
      es_factura: null,
      gemini_analizado: 0,
      revisado: 0,
      fecha_captura: new Date().toISOString(),
      file_hash: fileHash,
    });

    console.log(`[doc-saliente] CAPTURADO ${vendedora}→${telefonoCliente} ${ext.toUpperCase()} ${bytes}b → ${subida?.viewLink || 'sin Drive'}`);
    return { id: insertResult?.lastInsertRowid, drive: subida };
  } catch (e) {
    console.error('[doc-saliente capturar err]', e.message);
    return null;
  }
}

// Resumen del dia de una vendedora — cuenta ventas con/sin sticker + total $.
// Usado en los WA inmediato/90min para motivar con ranking.
function resumenDiaVendedora(vendedora) {
  try {
    const todos = db.leerComprobantes();
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    const _norm = (s) => String(s || '').trim().toLowerCase();
    const v = _norm(vendedora);
    const propios = todos.filter(c => {
      if (_norm(c.vendedora) !== v) return false;
      const cFecha = c.ts ? new Date(c.ts).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }) : '';
      return cFecha === hoyBogota;
    });
    const conSticker = propios.filter(c => c.stickerEnviado).length;
    const sinSticker = propios.filter(c => !c.stickerEnviado).length;
    const totalMonto = propios.reduce((s, c) => s + (Number(c.monto) || 0), 0);
    return { total: propios.length, conSticker, sinSticker, totalMonto };
  } catch (e) {
    return { total: 0, conSticker: 0, sinSticker: 0, totalMonto: 0 };
  }
}

function _formatearMontoCOP(n) {
  if (n === 0 || n === '0') return '$0';
  if (!n || isNaN(n)) return '$?';
  return '$' + Number(n).toLocaleString('es-CO');
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
// TIMEOUT de 4 segundos: si Chatwoot tarda más, devuelve null y NO bloquea
// el webhook (que causaba que el sticker handler nunca terminara).
async function buscarContactoChatwoot(telefono) {
  try {
    const url = process.env.CHATWOOT_URL;
    const accountId = process.env.CHATWOOT_ACCOUNT_ID;
    const apiKey = process.env.CHATWOOT_API_KEY;
    if (!url || !accountId || !apiKey) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(telefono)}`, {
      headers: { 'api_access_token': apiKey },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return null;
    const data = await r.json();
    if (data.payload && data.payload.length > 0) {
      const c = data.payload[0];
      return { name: c.name || null, id: c.id };
    }
    return null;
  } catch (e) {
    if (e.name === 'AbortError') console.warn('[chatwoot-search] timeout (>4s), siguiendo sin datos');
    else console.error('[buscarContactoChatwoot error]', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// BOT CONVERSACIONAL DE VENTAS POR CONFIRMAR (resumen WA + respuestas)
// ─────────────────────────────────────────────────────────────────
// Snapshot diario que el jefe revisa por WA: lista numerada de comprobantes
// que fueron descartados por la validacion (destinatario raro, etc) pero
// podrian ser ventas reales. Camilo responde "1 si betty" / "2 no" / "ver".
// ═════════════════════════════════════════════════════════════════

const TELEFONO_JEFE = (process.env.WA_DUVAN || process.env.WA_CAMILO || '573124858901').replace(/\D/g, '');

// Lee los ultimos N mensajes de una conversacion de Chatwoot.
// Devuelve array de { sender_type, content, created_at } ordenado del mas viejo al mas nuevo.
async function listarMensajesChatwoot(conversationId, limit = 25) {
  try {
    const url = process.env.CHATWOOT_URL;
    const accountId = process.env.CHATWOOT_ACCOUNT_ID;
    const apiKey = process.env.CHATWOOT_API_KEY;
    if (!url || !accountId || !apiKey || !conversationId) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`${url}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      headers: { 'api_access_token': apiKey },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return [];
    const data = await r.json();
    const payload = data.payload || data || [];
    // Chatwoot devuelve los mensajes en orden cronologico (viejos primero)
    return payload.slice(-limit).map(m => ({
      sender_type: m.sender_type || (m.message_type === 0 ? 'Contact' : 'User'),
      content: m.content || '',
      created_at: m.created_at,
      message_type: m.message_type,
      attachments: (m.attachments || []).map(a => ({
        file_type: a.file_type,
        data_url: a.data_url,
        thumb_url: a.thumb_url,
      })),
    }))
    // Mantener mensajes con contenido O con attachments (imagenes)
    .filter(m => (m.content && m.content.trim()) || (m.attachments && m.attachments.length > 0));
  } catch (e) {
    console.error('[chatwoot-msg]', e.message);
    return [];
  }
}

// Para un telefono, busca la conversacion mas reciente de Chatwoot y devuelve {convId, messages}
async function obtenerChatwootChatPorTelefono(telefono, limitMensajes = 25) {
  try {
    const contacto = await buscarContactoChatwoot(telefono);
    if (!contacto?.id) return null;
    const url = process.env.CHATWOOT_URL;
    const accountId = process.env.CHATWOOT_ACCOUNT_ID;
    const apiKey = process.env.CHATWOOT_API_KEY;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, {
      headers: { 'api_access_token': apiKey },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return null;
    const data = await r.json();
    const conv = (data.payload || [])[0];
    if (!conv?.id) return null;
    const messages = await listarMensajesChatwoot(conv.id, limitMensajes);
    return { convId: conv.id, messages, contactoId: contacto.id };
  } catch (e) {
    console.error('[chatwoot-chat]', e.message);
    return null;
  }
}

// Devuelve URL al chat de Chatwoot del cliente, o null si no se puede construir.
async function obtenerChatwootConvUrl(telefono) {
  try {
    const url = process.env.CHATWOOT_URL;
    const accountId = process.env.CHATWOOT_ACCOUNT_ID;
    const apiKey = process.env.CHATWOOT_API_KEY;
    if (!url || !accountId || !apiKey) return null;
    const contacto = await buscarContactoChatwoot(telefono);
    if (!contacto?.id) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, {
      headers: { 'api_access_token': apiKey },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return null;
    const data = await r.json();
    const conv = (data.payload || [])[0];
    if (!conv?.id) return null;
    return `${url}/app/accounts/${accountId}/conversations/${conv.id}`;
  } catch (e) { return null; }
}

// Devuelve lista de candidatos para subir como venta.
// Tipo 1: comprobantes Gemini detectados pero descartados (destinatario raro)
// Tipo 2: comprobantes con pedidoAutoCreado pero pedido fue borrado
function detectarCandidatosVentas() {
  const comps = db.leerComprobantes();
  const pedidosActuales = leerPedidos();
  const idsPedidos = new Set(pedidosActuales.map(p => p.id));
  const ahora = Date.now();
  const hace48h = ahora - (48 * 60 * 60 * 1000);
  const candidatos = [];
  const dedupTelefono = new Set();

  for (const c of comps) {
    const ts = c.ts ? new Date(c.ts).getTime() : 0;
    if (ts < hace48h) continue; // solo ultimas 48h
    if (!c.messageId) continue;
    // Ya decidido manualmente
    const decision = db.leerDecisionVenta(c.messageId);
    if (decision) continue;

    let tipo = null;
    let motivo = null;

    if (c.descartado === true) {
      tipo = 'comprobante-descartado';
      motivo = c.motivoDescarte || 'destinatario fuera de W&S';
    } else if (c.pedidoAutoCreado && !idsPedidos.has(c.pedidoAutoCreado)) {
      tipo = 'pedido-perdido';
      motivo = `pedido #${c.pedidoAutoCreado} fue borrado`;
    } else {
      continue;
    }

    // Dedup por telefono para no listar 5 comprobantes del mismo cliente
    const telKey = String(c.telefono || '').replace(/\D/g, '');
    if (telKey && dedupTelefono.has(telKey)) continue;
    if (telKey) dedupTelefono.add(telKey);

    candidatos.push({
      messageId: c.messageId,
      tipo,
      motivo,
      telefono: c.telefono,
      cliente: c.cliente || c.pushName || 'Sin nombre',
      vendedoraSugerida: c.vendedora,
      monto: c.monto,
      banco: c.banco,
      destinatario: c.destinatario,
      ts: c.ts,
      pedidoOriginal: c.pedidoAutoCreado,
    });
  }
  // Ordenar por ts desc (mas recientes primero)
  candidatos.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return candidatos.slice(0, 15); // max 15 candidatos por mensaje
}

// Genera un snapshot, lo guarda en config y devuelve el snapshot.
function generarSnapshotVentas() {
  const candidatos = detectarCandidatosVentas();
  const snapshot = {
    id: 'snap-' + Date.now(),
    fechaGenerado: new Date().toISOString(),
    candidatos: candidatos.map((c, i) => ({ numero: i + 1, ...c })),
  };
  db.guardarConfig({ ventas_snapshot_actual: snapshot });
  return snapshot;
}

// Construye el mensaje WA con la lista numerada
// Cada candidato lleva LINKS DIRECTOS — 1 click procesa la decisión sin escribir nada
async function construirMensajeSnapshot(snapshot) {
  if (!snapshot.candidatos.length) {
    return `✅ *W&S — Sin ventas por confirmar*\n\nNo hay candidatos para revisar.\n\nMañana 7 PM te aviso de nuevo.`;
  }
  const fechaCorta = new Date().toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short' });
  const baseUrl = process.env.PUBLIC_URL || 'https://ws-app-interna-production.up.railway.app';
  let txt = `🔔 *W&S — Ventas por confirmar* (${fechaCorta})\n\n`;
  txt += `${snapshot.candidatos.length} candidato${snapshot.candidatos.length > 1 ? 's' : ''} de las últimas 48h.\n`;
  txt += `Toca los botones para confirmar/descartar:\n\n`;

  // Construir chatwoot URLs en paralelo
  const urls = await Promise.all(snapshot.candidatos.map(c => obtenerChatwootConvUrl(c.telefono).catch(() => null)));

  for (let i = 0; i < snapshot.candidatos.length; i++) {
    const c = snapshot.candidatos[i];
    const tkn = `${snapshot.id}-${c.numero}`;
    const vendCap = c.vendedoraSugerida
      ? c.vendedoraSugerida.charAt(0).toUpperCase() + c.vendedoraSugerida.slice(1).toLowerCase()
      : null;
    txt += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
    txt += `*${c.numero}️⃣ ${c.cliente}*\n`;
    txt += `📞 ${c.telefono || 'sin tel'}`;
    if (c.monto) txt += ` · 💰 $${Number(c.monto).toLocaleString('es-CO')}`;
    if (c.banco && c.banco !== 'desconocido') txt += ` ${c.banco}`;
    txt += '\n';
    if (vendCap) txt += `🛍️ Vendedora: *${vendCap}* (línea del chat)\n`;
    if (urls[i]) txt += `🔗 Ver chat: ${urls[i]}\n`;
    txt += '\n';
    txt += `✅ SÍ fue venta de ${vendCap || 'la línea detectada'}:\n`;
    txt += `   ${baseUrl}/v/${tkn}?si=1\n`;
    txt += `❌ NO fue venta:\n`;
    txt += `   ${baseUrl}/v/${tkn}?no=1\n\n`;
  }
  txt += `━━━━━━━━━━━━━━━━━━━━━━━\nUn solo click y se procesa.\n\n_Si la vendedora detectada es incorrecta, podés cambiarla:_\n_${baseUrl}/v/<numero>?v=ney_`;
  return txt;
}

async function enviarSnapshotWA(snapshot) {
  const texto = await construirMensajeSnapshot(snapshot);
  try {
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const instance = process.env.WA_NOTIF_INSTANCE || 'ws-duvan';
    const apiKey = process.env.WA_NOTIF_APIKEY || process.env.EVOLUTION_API_KEY || '3506974711';
    const r = await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: TELEFONO_JEFE, text: texto }),
    });
    if (!r.ok) console.error('[snapshot-wa] status', r.status);
    return r.ok;
  } catch (e) { console.error('[snapshot-wa err]', e.message); return false; }
}

async function responderJefe(texto) {
  try {
    const url = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const instance = process.env.WA_NOTIF_INSTANCE || 'ws-duvan';
    const apiKey = process.env.WA_NOTIF_APIKEY || process.env.EVOLUTION_API_KEY || '3506974711';
    await fetch(`${url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: TELEFONO_JEFE, text: texto }),
    });
  } catch (e) { console.error('[responder-jefe err]', e.message); }
}

// Parsea respuesta del jefe. Formatos validos:
//   "ver" → muestra lista de nuevo
//   "<n> si"           → crea pedido con vendedora sugerida
//   "<n> si <vend>"    → crea pedido con vendedora elegida
//   "<n> si <vend> <monto>" → crea pedido con vendedora y monto corregido
//   "<n> no"           → descartar (no es venta)
// Devuelve { ok, mensajeRespuesta }
// Procesa "equipo NOMBRE" sin numero, cuando viene de vendedora respondiendo
// a la pregunta automatica de PRIMER PAGO. Crea el pedido, vincula el
// comprobante, y avisa por WA al jefe + a la vendedora.
async function procesarRespuestaPrimerPago(texto, instancia) {
  const m = String(texto).trim().match(/^(?:equipo|nombre|eq)\s+(.+)$/i);
  if (!m) return { ok: false, motivo: 'sin-match' };
  const nombreEquipo = m[1].trim();
  if (!nombreEquipo || nombreEquipo.length < 2) {
    return { ok: false, motivo: 'nombre-muy-corto' };
  }
  const vendedora = INSTANCIA_A_VENDEDORA[instancia] || INSTANCIA_A_VENDEDORA[String(instancia).toLowerCase().replace(/[\s_]+/g, '-')];
  if (!vendedora) return { ok: false, motivo: 'instancia-desconocida' };

  // Buscar primer-pago-pendiente mas reciente de esta vendedora
  const pendiente = primerPagoPendienteParaVendedora(vendedora);
  if (!pendiente) {
    // No hay primer-pago pendiente — quizas se le paso el tiempo (>48h) o no llego comprobante
    try {
      await notificarWAVendedora(vendedora, `❓ Recibi "equipo ${nombreEquipo}" pero no tengo ningun pago pendiente esperando nombre.\n\nSi quieres corregir el nombre de un pedido existente usa: *equipo NUMERO_PEDIDO ${nombreEquipo}*`);
    } catch {}
    return { ok: false, motivo: 'sin-primer-pago-pendiente' };
  }

  // Crear el pedido
  let pedidoNuevo;
  try {
    pedidoNuevo = crearPedidoDesdePrimerPago(pendiente, nombreEquipo);
  } catch (e) {
    console.error('[primer-pago] error creando pedido:', e.message);
    try {
      await notificarWAVendedora(vendedora, `⚠️ Error creando pedido: ${e.message}\n\nAvisale a Camilo.`);
    } catch {}
    return { ok: false, motivo: 'error-crear', error: e.message };
  }

  console.log(`[primer-pago] pedido #${pedidoNuevo.id} CREADO de comprobante (vend=${vendedora} cliente=${pendiente.nombreCliente||pendiente.telefono} monto=${pendiente.monto})`);

  // Avisar a la vendedora con OK
  try {
    const montoFmt = _formatearMontoCOP(pendiente.monto);
    const msgVend = `✅ *Pedido creado* (#${pedidoNuevo.id})\n\n` +
      `Equipo: *${nombreEquipo}*\n` +
      `Cliente: ${pendiente.nombreCliente || pendiente.telefono}\n` +
      `Abono inicial: ${montoFmt} ✅\n\n` +
      `📋 Ya quedo en bandeja de Oscar/disenadora.\n` +
      `📌 Falta: poner el TOTAL en el pedido (factura) para que cuando complete el pago lo detecte solo.`;
    await notificarWAVendedora(vendedora, msgVend);
  } catch (e) { console.error('[primer-pago wa-vend]', e.message); }

  // Avisar a Camilo
  try {
    const montoFmt = _formatearMontoCOP(pendiente.monto);
    const msgJefe = `🆕 *Pedido nacio por primer pago*\n\n` +
      `Pedido: *${nombreEquipo}* (#${pedidoNuevo.id})\n` +
      `Vendedora: ${vendedora}\n` +
      `Cliente: ${pendiente.nombreCliente || pendiente.telefono}\n` +
      `Abono inicial: ${montoFmt}\n` +
      `Banco: ${pendiente.banco || 'desconocido'}`;
    await notificarWAPersona('camilo', msgJefe);
  } catch (e) { console.error('[primer-pago wa-jefe]', e.message); }

  return { ok: true, pedidoId: pedidoNuevo.id };
}

async function procesarRespuestaJefe(texto) {
  const norm = String(texto || '').trim().toLowerCase();
  if (!norm) return { ok: false };

  // "ver" → mostrar snapshot actual (o uno nuevo si no hay)
  if (norm === 'ver' || norm === 'lista' || norm === 'list') {
    let snap = db.leerConfig().ventas_snapshot_actual;
    if (!snap || !snap.candidatos?.length) snap = generarSnapshotVentas();
    await responderJefe(await construirMensajeSnapshot(snap));
    return { ok: true };
  }

  // ── Corregir nombre del equipo: "equipo 10 HE RED RIBBON SQUAD FC"
  //    o aliases: "nombre 10 ...", "eq 10 ..."
  // Reescribe pedido[id].equipo, deja equipoVieneDeBot=false para que el
  // watcher no lo vuelva a sobreescribir, y dispara re-evaluacion de WT/PDF
  // (por si los archivos llegaron con ese nombre y no se habian amarrado).
  const mEq = (texto || '').trim().match(/^(?:equipo|nombre|eq)\s+(\d+)\s+(.+)$/i);
  if (mEq) {
    const idEq = parseInt(mEq[1], 10);
    const nuevoNombre = mEq[2].trim();
    if (!nuevoNombre) {
      await responderJefe(`⚠️ Escribi: *equipo ${idEq} NOMBRE DEL EQUIPO*`);
      return { ok: true };
    }
    const peds = leerPedidos();
    const pp = peds.find(x => x.id === idEq);
    if (!pp) {
      await responderJefe(`⚠️ No existe pedido #${idEq}.`);
      return { ok: true };
    }
    const equipoAntes = pp.equipo || '(vacio)';
    pp.equipo = nuevoNombre;
    pp.equipoVieneDeBot = false; // no volver a sobreescribir
    pp.ultimoMovimiento = new Date().toISOString();
    pp.notas = (pp.notas || '') + ` [nombre corregido por jefe: "${equipoAntes}" -> "${nuevoNombre}"]`;
    guardarPedidos(peds, leerNextId());
    console.log(`[jefe-cmd] pedido #${idEq} renombrado: "${equipoAntes}" -> "${nuevoNombre}"`);
    await responderJefe(`✏️ *Pedido #${idEq}* renombrado:\n_${equipoAntes}_ → *${nuevoNombre}*\n\nVoy a revisar si tiene archivos esperando con este nombre…`);
    // Re-evaluar amarres (WT/PDF/CATALOGO) por nombre.
    try {
      if (typeof revisarAmarresPorNombre === 'function') {
        const res = await revisarAmarresPorNombre(idEq);
        if (res?.cambios) {
          await responderJefe(`✅ #${idEq} avanzo con archivos amarrados: ${res.cambios}`);
        }
      }
    } catch (eRe) { console.error('[jefe-cmd reamarre]', eRe.message); }
    return { ok: true };
  }

  // Patron: "<n> si|no [vendedora] [monto]"
  const m = norm.match(/^(\d+)\s+(si|no|sí)(\s+([a-záéíóúñ]+))?(\s+(\d[\d.]*[k]?))?/i);
  if (!m) return { ok: false };

  const numero = parseInt(m[1], 10);
  const accion = (m[2] === 'si' || m[2] === 'sí') ? 'si' : 'no';
  const vendedoraTxt = m[4] || null;
  let montoTxt = m[6] || null;

  // Convertir monto (acepta "250k", "250000", "250.000")
  let montoCorregido = null;
  if (montoTxt) {
    montoTxt = montoTxt.replace(/\./g, '');
    if (montoTxt.endsWith('k')) montoCorregido = parseInt(montoTxt.slice(0, -1), 10) * 1000;
    else montoCorregido = parseInt(montoTxt, 10);
    if (isNaN(montoCorregido)) montoCorregido = null;
  }

  const snap = db.leerConfig().ventas_snapshot_actual;
  if (!snap || !snap.candidatos?.length) {
    await responderJefe('⚠️ No hay snapshot activo. Escribí *ver* para generar uno nuevo.');
    return { ok: true };
  }
  const cand = snap.candidatos.find(c => c.numero === numero);
  if (!cand) {
    await responderJefe(`⚠️ No existe el candidato #${numero} en la lista actual. Escribí *ver* para ver la lista actual.`);
    return { ok: true };
  }

  // Ya decidido?
  const yaDec = db.leerDecisionVenta(cand.messageId);
  if (yaDec) {
    await responderJefe(`ℹ️ El #${numero} (${cand.cliente}) ya fue procesado: *${yaDec.decision}*${yaDec.pedido_id ? ' (pedido #' + yaDec.pedido_id + ')' : ''}.`);
    return { ok: true };
  }

  if (accion === 'no') {
    db.guardarDecisionVenta({ candidatoKey: cand.messageId, decision: 'no' });
    await responderJefe(`❌ *#${numero} descartado* — ${cand.cliente} no se va a subir como venta.\n\n_${faltantesPendientes(snap)}_`);
    return { ok: true };
  }

  // accion === 'si' → crear pedido
  const vendedora = (vendedoraTxt || cand.vendedoraSugerida || '').trim();
  if (!vendedora) {
    await responderJefe(`⚠️ Falta vendedora. Escribí: *${numero} si <nombre vendedora>* (betty, ney, wendy, paola, graciela).`);
    return { ok: true };
  }
  const vendNorm = vendedora.toLowerCase();
  const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
  if (!VENDEDORAS_VALIDAS.includes(vendNorm)) {
    await responderJefe(`⚠️ Vendedora "${vendedora}" no reconocida. Usa: betty, ney, wendy, paola o graciela.`);
    return { ok: true };
  }

  const montoFinal = montoCorregido || cand.monto || 0;
  const resCrear = crearVentaInterna('pedido', vendNorm, cand.telefono || '', 'manual-' + cand.messageId, cand.cliente || `Cliente +57 ${cand.telefono || '?'}`);
  if (!resCrear.ok) {
    await responderJefe(`❌ Error creando pedido: ${resCrear.error}`);
    return { ok: true };
  }
  // Anotar metadatos
  if (resCrear.id && !resCrear.duplicado) {
    const pps = leerPedidos();
    const pp = pps.find(x => x.id === resCrear.id);
    if (pp) {
      pp.origenComprobante = true;
      pp.montoComprobante = montoFinal;
      pp.bancoComprobante = cand.banco || null;
      pp.notas = (pp.notas || '') + ` [subido manual desde panel WA por jefe]`;
      guardarPedidos(pps, leerNextId());
    }
  }
  db.guardarDecisionVenta({
    candidatoKey: cand.messageId,
    decision: 'si',
    pedidoId: resCrear.id,
    vendedora: vendNorm,
    monto: montoFinal,
  });

  const dup = resCrear.duplicado ? ' (ya existía como duplicado, no recreado)' : '';
  const montoTxt2 = montoFinal ? `\n💰 $${montoFinal.toLocaleString('es-CO')}` : '';
  await responderJefe(`✅ *Pedido #${resCrear.id} creado*${dup}\n👤 ${cand.cliente}\n📞 ${cand.telefono}\n🛍️ Vendedora: ${vendNorm}${montoTxt2}\n\n_${faltantesPendientes(snap)}_`);
  return { ok: true };
}

function faltantesPendientes(snap) {
  if (!snap?.candidatos) return '';
  const pendientes = snap.candidatos.filter(c => !db.leerDecisionVenta(c.messageId));
  if (!pendientes.length) return 'Todos los candidatos del snapshot ya fueron procesados ✓';
  return `Quedan ${pendientes.length} por confirmar.`;
}

// Helpers para el endpoint /v/:token — devuelve HTML simple con feedback visual
function _htmlOk(res, titulo, mensajeHtml) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} - W&S</title><style>body{font-family:system-ui,sans-serif;background:#0a0b0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:linear-gradient(135deg,rgba(34,197,94,0.15),rgba(22,163,74,0.05));border:1px solid rgba(34,197,94,0.4);border-radius:18px;padding:32px;max-width:420px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,0.5)}h1{font-size:1.8rem;margin:0 0 16px;letter-spacing:-0.02em}p{font-size:1rem;line-height:1.5;color:rgba(255,255,255,0.85)}.close{margin-top:24px;padding:10px 20px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#fff;text-decoration:none;display:inline-block;font-weight:600}</style></head><body><div class="card"><h1>${titulo}</h1><p>${mensajeHtml}</p><a class="close" href="javascript:window.close()">Cerrar</a></div></body></html>`);
}
function _htmlError(res, mensaje) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error - W&S</title><style>body{font-family:system-ui,sans-serif;background:#0a0b0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:linear-gradient(135deg,rgba(239,68,68,0.15),rgba(220,38,38,0.05));border:1px solid rgba(239,68,68,0.4);border-radius:18px;padding:32px;max-width:420px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,0.5)}h1{font-size:1.5rem;margin:0 0 12px}p{color:rgba(255,255,255,0.85);line-height:1.5}.close{margin-top:24px;padding:10px 20px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#fff;text-decoration:none;display:inline-block;font-weight:600}</style></head><body><div class="card"><h1>⚠️ ${mensaje.split('.')[0]}</h1><p>${mensaje}</p><a class="close" href="javascript:window.close()">Cerrar</a></div></body></html>`);
}

// Consulta Evolution para obtener el nombre del contacto desde su JID.
// Devuelve el nombre limpio o null si no encuentra.
async function obtenerNombreContactoEvolution(remoteJid) {
  try {
    const url = (process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app');
    const apiKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
    const instance = process.env.EVOLUTION_INSTANCE || 'ws-ventas';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/chat/findContacts/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ where: { remoteJid } }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
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

// ── TELEFONOS DESCARTADOS ─────────────────────────────────────────────
// Cuando se borra un pedido, su telefono se agrega a esta lista para que
// el sticker-handler y el reprocesador-historico NO recreen el pedido
// automaticamente. Camilo confirma esto el 2026-06-01 tras notar que
// pedidos borrados volvian a aparecer porque el cron reprocesaba el
// sticker historico y creaba un pedido nuevo.
//
// La lista expira a los 60 dias (asumiendo que si el cliente vuelve a
// comprar despues, ya es otra venta y conviene crearle un pedido fresco).
// Se puede limpiar manualmente via POST /api/admin/quitar-telefono-descartado.
const TEL_DESCARTADOS_FILE = path.join(__dirname, 'data', 'telefonos-descartados.json');
function leerTelefonosDescartados() {
  try {
    if (!fs.existsSync(TEL_DESCARTADOS_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(TEL_DESCARTADOS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function guardarTelefonosDescartados(arr) {
  try {
    fs.mkdirSync(path.dirname(TEL_DESCARTADOS_FILE), { recursive: true });
    fs.writeFileSync(TEL_DESCARTADOS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { console.error('[tel-descartados]', e.message); }
}
function normTel(t) {
  const s = String(t || '').replace(/\D/g, '');
  return s.length >= 10 ? s.slice(-10) : s;
}
function agregarTelefonoDescartado(tel, motivo) {
  const norm = normTel(tel);
  if (!norm || norm.length < 8) return;
  const lista = leerTelefonosDescartados();
  const hace60d = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const filtrada = lista.filter(t => t.ts >= hace60d);
  if (!filtrada.find(t => t.tel === norm)) {
    filtrada.push({ tel: norm, motivo: motivo || 'borrado manual', ts: Date.now() });
    guardarTelefonosDescartados(filtrada);
  }
}
function esTelefonoDescartado(tel) {
  const norm = normTel(tel);
  if (!norm) return false;
  // Bloqueo PERMANENTE primero (proveedores confirmados por Camilo 27-may-2026
  // mas los del env var TELEFONOS_PROVEEDORES en Railway). Estos NUNCA expiran.
  if (PROVEEDORES_PERMANENTES.has(norm)) return true;
  // Bloqueo temporal (60 dias) por pedidos borrados
  const lista = leerTelefonosDescartados();
  const hace60d = Date.now() - 60 * 24 * 60 * 60 * 1000;
  return lista.some(t => t.tel === norm && t.ts >= hace60d);
}

// PROVEEDORES_PERMANENTES — lista hardcodeada de telefonos que NO son clientes.
// Camilo los confirmo el 27-may-2026: maquila / calandra / satelites / tela.
// Adicional al env var TELEFONOS_PROVEEDORES en Railway (que se concatena).
// Estos numeros NUNCA crean pedido, NUNCA por sticker, NUNCA por comprobante,
// NUNCA por reprocesador. Sin TTL.
const PROVEEDORES_HARDCODED = [
  '573118761960',
  '573118146068',
  '573106259863',
  '573225919823',
  '573162674879',
];
const PROVEEDORES_PERMANENTES = new Set([
  ...PROVEEDORES_HARDCODED.map(t => normTel(t)),
  ...(process.env.TELEFONOS_PROVEEDORES || '')
    .split(',').map(s => normTel(s.trim())).filter(Boolean),
]);

// ─────────────────────────────────────────────────────────────
// NOTION — Archivar pedidos entregados (enviado-final)
// El pedido se sube a Notion y luego se borra del servidor.
// Notion queda como histórico, Railway sigue ligero.
// ─────────────────────────────────────────────────────────────
// ID de la DB "🏆 HISTORIAL DE VENTAS — W&S Enterprise" creada en Notion (2026-05-29).
// Hardcoded como fuente de verdad — la env var en Railway apuntaba a una DB vieja
// (WS-Historico-Pedidos-Template.csv) con esquema incompatible. Para cambiar de DB
// editar este valor (no usar env var por confusion historica).
const NOTION_DB_DEFAULT = '9a40c001-02a7-457f-8010-842a1bcb2eee';

async function archivarPedidoEnNotion(pedido, tokenOverride) {
  const token = tokenOverride || process.env.NOTION_TOKEN;
  const dbId = NOTION_DB_DEFAULT;
  if (!token) {
    console.log('[notion] sin token, saltando archivo');
    return { ok: false, motivo: 'sin NOTION_TOKEN' };
  }
  try {
    // Mapeo a las opciones EXACTAS del select en Notion (todas con Capitalize)
    const VEN_MAP = { 'betty': 'Betty', 'ney': 'Ney', 'wendy': 'Wendy', 'paola': 'Paola', 'graciela': 'Graciela' };
    const vendedoraNotion = VEN_MAP[String(pedido.vendedora || '').toLowerCase()] || null;
    const DIS_MAP = { 'camilo': 'Camilo', 'oscar': 'Oscar', 'ney': 'Ney', 'wendy': 'Wendy', 'paola': 'Paola' };
    const disenadorNotion = DIS_MAP[String(pedido.disenadorAsignado || '').toLowerCase()] || (pedido.disenadorAsignado ? 'Sin asignar' : null);

    // Origen — derivado de las marcas del pedido
    let origenNotion = 'Manual';
    if (pedido.origenFacturaHuerfana) origenNotion = 'Huérfano';
    else if (pedido.origenComprobante) origenNotion = 'Comprobante';
    else if (pedido.origenHuerfano) origenNotion = 'Huérfano';
    else if (pedido.stickerVenta || pedido.origenBot) origenNotion = 'Sticker';

    // Prendas — extraer de items
    const PRENDAS_OPCIONES = new Set(['Camiseta', 'Pantaloneta', 'Pantalón', 'Peto', 'Medias', 'Buzo', 'Chaqueta', 'Sudadera', 'Polo', 'Uniforme completo']);
    const prendasDetectadas = new Set();
    if (Array.isArray(pedido.items)) {
      for (const it of pedido.items) {
        const txt = String(typeof it === 'string' ? it : (it && it.prenda) || '').trim();
        for (const op of PRENDAS_OPCIONES) {
          if (txt.toLowerCase().includes(op.toLowerCase())) prendasDetectadas.add(op);
        }
      }
    }

    // Bancos — extraer de pagos
    const BANCOS_OPCIONES = new Set(['Bancolombia', 'Nequi', 'Daviplata', 'Davivienda', 'Efectivo', 'Otro']);
    const bancosDetectados = new Set();
    if (Array.isArray(pedido.pagos)) {
      for (const pg of pedido.pagos) {
        const banco = String(pg.banco || '').trim();
        if (BANCOS_OPCIONES.has(banco)) bancosDetectados.add(banco);
        else if (banco) bancosDetectados.add('Otro');
      }
    }

    // Notas — items + nota original
    const itemsTxt = Array.isArray(pedido.items) && pedido.items.length
      ? pedido.items.map(i => typeof i === 'string' ? i : [i.prenda, i.tela, i.cantidad].filter(Boolean).join(' ')).filter(Boolean).join(', ')
      : '';
    const notasFinales = [pedido.notas || '', itemsTxt ? `Items: ${itemsTxt}` : ''].filter(Boolean).join(' | ').slice(0, 1900);

    // Conversión de fechas
    function aIsoDate(f) {
      if (!f) return null;
      const m = String(f).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
      const t = new Date(f);
      return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
    }
    const fechaVentaISO = aIsoDate(pedido.fechaVenta) || aIsoDate(pedido.creadoEn);
    const fechaEntregaISO = aIsoDate(pedido.ultimoMovimiento) || new Date().toISOString().slice(0, 10);

    // Teléfono como string formateado (Notion phone_number)
    const telStr = String(pedido.telefono || '').trim() || null;

    // Cliente / Equipo (title) — combinar
    const clienteEquipo = pedido.equipo || pedido.cliente || `Pedido #${pedido.id}`;

    const props = {
      'Cliente / Equipo': { title: [{ text: { content: String(clienteEquipo).slice(0, 1900) } }] },
      'Estado Final': { select: { name: 'Entregado' } },
      'Fecha de entrega': { date: { start: fechaEntregaISO } },
      'ID App': { number: pedido.id || null },
      'Origen': { select: { name: origenNotion } },
    };
    if (vendedoraNotion) props['Vendedora'] = { select: { name: vendedoraNotion } };
    if (disenadorNotion) props['Diseñador'] = { select: { name: disenadorNotion } };
    if (telStr) props['Teléfono'] = { phone_number: telStr };
    if (fechaVentaISO) props['Fecha de venta'] = { date: { start: fechaVentaISO } };
    if (pedido.total) props['Total'] = { number: Number(pedido.total) };
    if (pedido.abonado) props['Abonado'] = { number: Number(pedido.abonado) };
    if (notasFinales) props['Notas'] = { rich_text: [{ text: { content: notasFinales } }] };
    if (prendasDetectadas.size > 0) props['Prendas'] = { multi_select: [...prendasDetectadas].map(name => ({ name })) };
    if (bancosDetectados.size > 0) props['Banco'] = { multi_select: [...bancosDetectados].map(name => ({ name })) };

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
  'llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final'
];

// ── Matching de nombres de archivo a equipos ───────────────────
// "Camilo 1.pdf" → "camilo"  |  "Galaktiturkos 1.50m.pdf" → "galaktiturkos"
// Stopwords y sufijos comunes que NO deben contar en el match (versiones, copias, etc)
const _STOPWORDS_MATCH = new Set([
  'fc', 'cf', 'sas', 'club', 'team', 'equipo', 'sa', 'fb', 'fut',
  'copia', 'copy', 'final', 'finall', 'def', 'definitivo',
  'nuevo', 'new', 'corregido', 'editado', 'modificado', 'reparado',
  'recuperada', 'recuperado', 'backup', 'respaldo',
  'v', 'ver', 'version',
]);

// Normaliza un texto para match: minusculas, sin emojis, sin tildes, sin
// caracteres extranos, sin numeros sueltos, sin sufijos basura (v2, copia, etc)
function nombreLimpio(s) {
  if (!s) return '';
  let t = String(s);
  // 1. Sacar extension de archivo
  t = t.replace(/\.(pdf|cdr|psd|ai|eps|svg|jpg|jpeg|png|tiff|tif)$/i, '');
  // 2. Sacar prefijos "Recuperada_", "Copia de", "Backup ", etc
  t = t.replace(/^(recuperada?[_ -]|copia[_ -]de[_ -]?|copy[_ -]of[_ -]?|backup[_ -]of[_ -]?|resp[_ -]?)/i, '');
  // 3. Sacar sufijo "v2", "v3", "(1)", "(2)", "1.50m" al final
  t = t.replace(/\s*[\(\[]?v?\d+(\.\d+)?\s*m?[\)\]]?\s*$/i, '');
  // 4. Sacar emojis (Unicode emoji ranges) — quita los rotos tambien
  t = t.replace(/[\u{1F000}-\u{1FFFF}]/gu, ' ');
  t = t.replace(/[\u{2000}-\u{2BFF}]/gu, ' ');
  t = t.replace(/[\u{FE00}-\u{FE0F}]/gu, ' '); // variation selectors (emoji modifiers)
  t = t.replace(/[\u{200D}]/gu, ' ');           // ZWJ (joiner emojis)
  // 5. Sacar caracteres "rotos" de UTF-8 mal interpretado (Ã, Â, â½, ð, ï¿½, etc)
  t = t.replace(/[-ÿ]+/g, c => {
    // Mantener Ñ ñ y vocales con tilde (caracteres validos latino)
    if (/[ñÑáéíóúÁÉÍÓÚ¿¡]/.test(c)) return c;
    return ' ';
  });
  // 6. Quitar tildes y caracteres combinantes
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // 7. Bajar a lowercase
  t = t.toLowerCase();
  // 8. Reemplazar todo lo que no sea letra/numero por espacio
  t = t.replace(/[^a-z0-9ñ]+/g, ' ');
  // 9. Colapsar espacios y trim
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Devuelve set de palabras "ricas" (>=3 chars, no stopwords, no solo numeros)
function palabrasRicas(s) {
  const limpio = typeof s === 'string' && s.includes(' ') ? s : nombreLimpio(s);
  return new Set(
    limpio.split(' ').filter(w => w.length >= 3 && !_STOPWORDS_MATCH.has(w) && !/^\d+$/.test(w))
  );
}

// Saca telefonos de un string (cualquier secuencia de >= 7 digitos)
function extraerTelefonos(s) {
  if (!s) return [];
  return (String(s).match(/\d{7,}/g) || []).map(t => t.replace(/^57/, '')); // sin prefijo 57
}

function nombresCoinciden(equipoPedido, archivo) {
  const a = nombreLimpio(equipoPedido);
  const b = nombreLimpio(archivo);
  if (!a || !b) return false;
  // 1. Match exacto
  if (a === b) return true;
  // 2. Subcadena
  if (a.includes(b) || b.includes(a)) return true;
  // 3. Match por palabras ricas: >= 50% de palabras coinciden, minimo 2
  const palA = palabrasRicas(a);
  const palB = palabrasRicas(b);
  if (palA.size < 1 || palB.size < 1) return false;
  let comunes = 0;
  for (const w of palB) if (palA.has(w)) comunes++;
  const minSize = Math.min(palA.size, palB.size);
  if (comunes >= 2) return true;
  if (comunes >= 1 && comunes / minSize >= 0.5) return true;
  return false;
}

// Devuelve un score 0-1 de qué tan parecidos son dos nombres.
function scoreSimilitud(equipoPedido, archivo) {
  const a = nombreLimpio(equipoPedido);
  const b = nombreLimpio(archivo);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.95;
  const palA = palabrasRicas(a);
  const palB = palabrasRicas(b);
  if (!palA.size || !palB.size) return 0;
  let comunes = 0;
  for (const w of palB) if (palA.has(w)) comunes++;
  return comunes / Math.max(palA.size, palB.size);
}

// Busca un pedido cuyo equipo, cliente, alias o telefono coincida con el archivo.
// pedido.archivosAlias = nombres limpios aprendidos por vinculaciones previas.
// Argumentos extra (opcionales): telefonoHint, vendedoraHint, disenadorHint
function buscarPedidoPorArchivo(pedidos, archivo, equipoHint, opts = {}) {
  const ESTADOS_AVANZADOS = ['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final','entregado','archivado'];
  const elegibles = pedidos.filter(p => !ESTADOS_AVANZADOS.includes(p.estado));
  const ref = equipoHint || archivo;
  const refLimpio = nombreLimpio(ref);
  // 0) Si hay telefonoHint -> match directo por telefono del pedido (mas fuerte)
  if (opts.telefonoHint) {
    const telH = String(opts.telefonoHint).replace(/\D/g, '').replace(/^57/, '');
    if (telH.length >= 7) {
      const pdTel = elegibles.find(p => {
        const t = String(p.telefono || '').replace(/\D/g, '').replace(/^57/, '');
        return t && (t === telH || t.endsWith(telH) || telH.endsWith(t));
      });
      if (pdTel) return pdTel;
    }
  }
  // Si el archivo tiene un telefono adentro del nombre, tambien intentar match
  const telsArchivo = extraerTelefonos(archivo);
  for (const t of telsArchivo) {
    if (t.length < 7) continue;
    const pdTel = elegibles.find(p => {
      const pt = String(p.telefono || '').replace(/\D/g, '').replace(/^57/, '');
      return pt && (pt === t || pt.endsWith(t) || t.endsWith(pt));
    });
    if (pdTel) return pdTel;
  }
  if (!refLimpio) return null;
  // 1) Coincidencia con alias guardado (mas fuerte: aprendido manualmente)
  let pd = elegibles.find(p => {
    const aliases = Array.isArray(p.archivosAlias) ? p.archivosAlias : [];
    return aliases.some(a => a === refLimpio || a.includes(refLimpio) || refLimpio.includes(a));
  });
  if (pd) return pd;
  // 2) Coincidencia con equipo (matcher robusto: emojis, tildes, palabras parciales)
  pd = elegibles.find(p => nombresCoinciden(p.equipo, ref));
  if (pd) return pd;
  // 3) Coincidencia con cliente (a veces el archivo se llama como el cliente)
  pd = elegibles.find(p => p.cliente && nombresCoinciden(p.cliente, ref));
  if (pd) return pd;
  // 4) Filtrar por disenadora/vendedora hint y matchear por palabras parciales
  if (opts.disenadorHint || opts.vendedoraHint) {
    const dh = opts.disenadorHint;
    const vh = opts.vendedoraHint;
    const filtrados = elegibles.filter(p =>
      (dh && (p.disenadorAsignado === dh || p.disenadorReal === dh)) ||
      (vh && p.vendedora === vh)
    );
    let mejor = null;
    let mejorScore = 0.4; // umbral minimo
    for (const p of filtrados) {
      const sc = scoreSimilitud(p.equipo || p.cliente || '', ref);
      if (sc > mejorScore) { mejorScore = sc; mejor = p; }
    }
    if (mejor) return mejor;
  }
  return null;
}

// Re-evalua amarres WT/PDF para un pedido cuyo nombre fue corregido por el
// jefe. Recorre los registros de calandra (PDFs Drive) y wetransfer (correos
// WT) buscando match por el nuevo equipo; marca los flags y avanza a
// enviado-calandra si las dos senales estan listas.
async function revisarAmarresPorNombre(idPedido) {
  const peds = leerPedidos();
  const pp = peds.find(x => x.id === idPedido);
  if (!pp || !pp.equipo) return { ok: false, cambios: null };
  const cambios = [];
  // PDFs Drive
  try {
    const calandra = (typeof db.leerCalandra === 'function') ? db.leerCalandra() : [];
    for (const r of calandra) {
      if (nombresCoinciden(pp.equipo, r.equipo || r.archivo || '')) {
        if (!pp.pdfDriveListo) {
          pp.pdfDriveListo = true;
          pp.fechaPdfDrive = new Date().toISOString();
          cambios.push('PDF en Drive');
        }
        break;
      }
    }
  } catch (e) { console.error('[reamarre calandra]', e.message); }
  // WeTransfer
  try {
    const wts = (typeof db.leerWetransfer === 'function') ? db.leerWetransfer() : [];
    for (const r of wts) {
      if (nombresCoinciden(pp.equipo, r.equipo || r.archivo || '')) {
        if (!pp.wtListo) {
          pp.wtListo = true;
          pp.fechaWt = new Date().toISOString();
          cambios.push('WeTransfer');
        }
        break;
      }
    }
  } catch (e) { console.error('[reamarre wt]', e.message); }
  // Avanzar a enviado-calandra si ambas senales estan
  let avanzo = false;
  if (typeof evaluarPasoCalandra === 'function') {
    avanzo = evaluarPasoCalandra(pp);
  }
  if (cambios.length || avanzo) {
    pp.ultimoMovimiento = new Date().toISOString();
    guardarPedidos(peds, leerNextId());
  }
  return {
    ok: true,
    cambios: cambios.length ? cambios.join(', ') + (avanzo ? ' (paso a calandra)' : '') : null,
    avanzo,
  };
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
const DISENADOR_FULL_TIME_DEFAULT = 'Oscar'; // a quien le caen los pedidos de vendedoras que NO disenan

// Regla de auto-asignacion de disenador al crear/avanzar pedido:
//   - Si la vendedora tambien disena (Ney/Wendy/Paola) -> ella misma
//   - Si no (Betty, Graciela, Camilo) -> Oscar (diseñador full-time)
// Camilo decidio en la fase de adopcion lunes 2026-06-01 que Oscar recibe los
// pedidos de Betty (que es la que mas vende y no disena).
function asignarDisenadorAutomatico(vendedora) {
  if (VENDEDORAS_DISENADORAS.has(vendedora)) return vendedora;
  return DISENADOR_FULL_TIME_DEFAULT;
}

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
  // Acepta hacer-diseno o confirmado. La regla previa exigia confirmado
  // (aprobacion explicita del cliente), pero en la practica nadie pasa
  // pedidos a confirmado en la app — si PDF + WT estan listos, el cliente
  // ya aprobo de hecho (no se envia a calandra sin aprobacion).
  if (pedido.estado !== 'confirmado' && pedido.estado !== 'hacer-diseno') return false;
  if (!pedido.pdfDriveListo) return false;
  if (!pedido.wtListo) return false;
  const estadoAnterior = pedido.estado;
  pedido.estado = 'enviado-calandra';
  pedido.ultimoMovimiento = new Date().toISOString();
  console.log(`[auto-avance] #${pedido.id} ${estadoAnterior} → enviado-calandra (PDF+WT listos)`);
  return true;
}

http.createServer(async (req, res) => {

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── v2 (ERP paralelo — modulo aislado en v2-server.js) ──
  if (req.url && req.url.startsWith('/api/v2/')) {
    cors(res);
    return v2.handleV2Request(req, res);
  }

  // ── /api/disenos/* — catalogo de disenos + match automatico ──
  // POST /api/disenos/registrar-catalogo — llamado por watcher n8n con cada JPG nuevo
  if (req.method === 'POST' && req.url === '/api/disenos/registrar-catalogo') {
    cors(res);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const b = JSON.parse(body || '{}');
        const { fileId, nombre, driveDownloadUrl, sha256: sha256In, sizeBytes, modifiedTime } = b;
        if (!fileId || !nombre) return json(res, 400, { error: 'fileId y nombre requeridos' });

        let sha256 = sha256In || null;
        let phash = null;

        // Si n8n manda directamente el buffer (base64) o la URL, calculamos ambos hashes localmente
        if (b.contentBase64) {
          const buf = Buffer.from(b.contentBase64, 'base64');
          sha256 = disenos.calcularSha256(buf);
          phash = await disenos.calcularPHash(buf);
        } else if (driveDownloadUrl) {
          // n8n puede pasar una URL de descarga directa; la traemos
          try {
            const r = await fetch(driveDownloadUrl);
            if (r.ok) {
              const buf = Buffer.from(await r.arrayBuffer());
              sha256 = disenos.calcularSha256(buf);
              phash = await disenos.calcularPHash(buf);
            }
          } catch (e) { console.error('[disenos fetch drive]', e.message); }
        }

        const r = disenos.registrarCatalogo({ fileId, nombre, sha256, phash, sizeBytes, modifiedTime });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // GET /api/disenos/catalogo — lista los disenos registrados
  if (req.method === 'GET' && req.url.startsWith('/api/disenos/catalogo')) {
    cors(res);
    try {
      const u = new URL(req.url, 'http://localhost');
      const limit = parseInt(u.searchParams.get('limit') || '100', 10);
      return json(res, 200, { catalogo: disenos.listarCatalogo({ limit }), stats: disenos.statsCatalogo() });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/disenos/estado — resumen ejecutivo
  if (req.method === 'GET' && req.url === '/api/disenos/estado') {
    cors(res);
    return json(res, 200, { ok: true, ...disenos.statsCatalogo() });
  }

  // GET /api/disenos/backfill-status — estado del ultimo backfill
  if (req.method === 'GET' && req.url === '/api/disenos/backfill-status') {
    cors(res);
    return json(res, 200, global._backfillDisenosState || { estado: 'nunca corrido' });
  }

  // POST /api/disenos/backfill?maxPorPedido=10 — matchea disenos historicos EN BACKGROUND
  // Devuelve inmediato. Estado en GET /api/disenos/backfill-status.
  // Notif Telegram admin al terminar.
  if (req.method === 'POST' && req.url.startsWith('/api/disenos/backfill')) {
    cors(res);
    const evoDbUrl = process.env.EVOLUTION_DB_URL;
    if (!evoDbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const maxPorPedido = Math.min(parseInt(u.searchParams.get('maxPorPedido') || '15', 10), 30);
    const estados = (u.searchParams.get('estados') || 'confirmado,hacer-diseno,bandeja,listo,enviado-calandra,costura,entregado').split(',');

    // Si ya hay uno corriendo, no arrancar otro
    if (global._backfillDisenosState && global._backfillDisenosState.estado === 'corriendo') {
      return json(res, 200, { ok: true, mensaje: 'ya corriendo', estado: global._backfillDisenosState });
    }

    global._backfillDisenosState = { estado: 'corriendo', iniciado: new Date().toISOString(), progreso: 0, total: 0 };

    // Fire & forget — respondemos inmediato
    setImmediate(async () => {
      await _correrBackfillDisenos(evoDbUrl, maxPorPedido, estados);
    });

    return json(res, 200, { ok: true, mensaje: 'iniciado en background', consultar_en: '/api/disenos/backfill-status' });
  }

  // POST /api/disenos/refrescar-catalogo — corre el cron manual y devuelve resultado
  if (req.method === 'POST' && req.url === '/api/disenos/refrescar-catalogo') {
    cors(res);
    try {
      const archivos = await driveSync.listarCatalogoRecursivo().catch(e => ({ __error: e.message }));
      if (archivos && archivos.__error) {
        return json(res, 500, { ok: false, paso: 'listar', error: archivos.__error });
      }
      if (!archivos || !archivos.length) {
        return json(res, 200, { ok: true, mensaje: 'no hay archivos', total: 0 });
      }
      let nuevos = 0, reemplazos = 0, skips = 0, errores = [];
      for (const f of archivos) {
        try {
          const existente = db.raw.prepare(
            'SELECT id, modified_time FROM disenos_catalogo WHERE file_id = ? ORDER BY id DESC LIMIT 1'
          ).get(f.id);
          if (existente && existente.modified_time === f.modifiedTime) { skips++; continue; }
          const dl = await driveSync.descargarArchivoBase64(f.id);
          if (!dl || !dl.base64) { errores.push({ nombre: f.name, error: 'no download' }); continue; }
          const buf = Buffer.from(dl.base64, 'base64');
          const sha256 = disenos.calcularSha256(buf);
          const phash = await disenos.calcularPHash(buf);
          const r = disenos.registrarCatalogo({
            fileId: f.id, nombre: f.name, sha256, phash,
            sizeBytes: parseInt(f.size || '0', 10) || null,
            modifiedTime: f.modifiedTime,
          });
          if (r.accion === 'nuevo') nuevos++;
          else if (r.accion === 'reemplazo') reemplazos++;
          else skips++;
        } catch (e) {
          errores.push({ nombre: f.name, error: e.message });
        }
      }
      return json(res, 200, {
        ok: true,
        archivos_totales: archivos.length,
        nuevos, reemplazos, skips,
        errores_count: errores.length,
        errores_muestra: errores.slice(0, 5),
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message, stack: e.stack });
    }
  }
  if (req.method === 'GET' && (req.url === '/v2' || req.url === '/v2/')) {
    return fs.readFile(path.join(__dirname, 'public', 'v2.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  // ── GET /api/admin/pulso-webhooks — cuando fue el ultimo evento por instancia ──
  // Muestra si realmente estamos RECIBIENDO datos. Si hace horas -> roto en silencio.
  if (req.method === 'GET' && req.url === '/api/admin/pulso-webhooks') {
    try {
      const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 3').all().map(r => r.fecha);
      const porInstancia = {};
      let totalEventosHoy = 0;
      const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      for (const fecha of fechas) {
        const events = db.leerEvolutionEvents(fecha) || [];
        for (const ev of events) {
          const inst = ev.instance || ev.instanceName || ev._instance || 'desconocida';
          // Priorizamos _recv_at (hora real server) sobre date_time (Evolution puede estar desfasado)
          const ts = ev._recv_at || ev.date_time || ev.dateTime || ev.timestamp || fecha;
          if (!porInstancia[inst] || String(ts) > String(porInstancia[inst].ultimo)) {
            porInstancia[inst] = { ultimo: ts, tipo: ev.event || null };
          }
          if (fecha === hoy) totalEventosHoy++;
        }
      }
      const ahora = Date.now();
      const resumen = Object.entries(porInstancia).map(([inst, v]) => {
        const t = new Date(v.ultimo).getTime();
        const diffMin = isNaN(t) ? null : Math.round((ahora - t) / 60000);
        return { instancia: inst, ultimo_evento: v.ultimo, minutos_desde_ultimo: diffMin, tipo: v.tipo };
      }).sort((a, b) => (a.minutos_desde_ultimo || 0) - (b.minutos_desde_ultimo || 0));
      return json(res, 200, {
        ok: true,
        eventos_hoy: totalEventosHoy,
        fechas_consultadas: fechas,
        por_instancia: resumen,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/reintentar-webhooks — auto-heal soft: re-registra webhook por instancia ──
  // Cuando Evolution deja de despachar eventos aunque el webhook aparece "enabled",
  // re-hacer POST /webhook/set suele destrabar sin necesidad de restart.
  if (req.method === 'POST' && req.url === '/api/admin/reintentar-webhooks') {
    try {
      const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const KEY = process.env.EVOLUTION_API_KEY || '';
      const host = req.headers.host || 'ws-app-interna-production.up.railway.app';
      const webhookUrl = `https://${host}/api/evolution-webhook?token=ws_secret_2026`;
      const nombres = ['ws-ventas', 'ws wendy', 'ws-ney', 'ws-paola', 'ws-duvan'];
      const eventos = ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','CHATS_UPDATE','CHATS_UPSERT','LABELS_ASSOCIATION','LABELS_EDIT','MESSAGES_DELETE','CONTACTS_UPSERT'];
      const out = [];
      for (const name of nombres) {
        try {
          const body = { webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: eventos } };
          const r = await fetch(`${EVO}/webhook/set/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: KEY },
            body: JSON.stringify(body),
          });
          const j = await r.json().catch(() => null);
          out.push({ name, http: r.status, ok: r.ok, resp: j });
        } catch (e) { out.push({ name, error: e.message }); }
      }
      return json(res, 200, { ok: true, resultados: out });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/estado-webhooks — verifica que webhook este seteado por instancia ──
  if (req.method === 'GET' && req.url === '/api/admin/estado-webhooks') {
    try {
      const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const KEY = process.env.EVOLUTION_API_KEY || '';
      const nombres = ['ws-ventas', 'ws wendy', 'ws-ney', 'ws-paola', 'ws-duvan'];
      const out = [];
      for (const name of nombres) {
        try {
          const r = await fetch(`${EVO}/webhook/find/${encodeURIComponent(name)}`, { headers: { apikey: KEY } });
          const j = await r.json().catch(() => null);
          out.push({ name, http: r.status, enabled: j?.enabled ?? j?.webhook?.enabled ?? null, url: j?.url ?? j?.webhook?.url ?? null, events: j?.events ?? j?.webhook?.events ?? null });
        } catch (e) { out.push({ name, error: e.message }); }
      }
      return json(res, 200, { ok: true, webhooks: out });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/estado-instancias — chequeo rapido conexion Evolution ──
  if (req.method === 'GET' && req.url === '/api/admin/estado-instancias') {
    try {
      const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const KEY = process.env.EVOLUTION_API_KEY || '';
      const r = await fetch(`${EVO}/instance/fetchInstances`, { headers: { apikey: KEY } });
      const arr = await r.json();
      const resumen = (Array.isArray(arr) ? arr : []).map(i => ({
        name: i.name || i.instanceName || null,
        state: i.connectionStatus || i.status || i.instance?.state || null,
        profileName: i.profileName || i.ownerJid || null,
        wa_number: i.number || i.ownerJid || null,
        disconnectionReason: i.disconnectionReasonCode || null,
        disconnectedAt: i.disconnectionAt || null,
        webhook: !!(i.Webhook || i.webhookUrl),
        chatwoot: !!i.Chatwoot,
      }));
      const vivas = resumen.filter(r => r.state === 'open').length;
      const total = resumen.length;
      return json(res, 200, { ok: true, vivas, total, instancias: resumen });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/vigilancia-evolution — estado del vigilante ──
  if (req.method === 'GET' && req.url === '/api/admin/vigilancia-evolution') {
    try {
      const f = path.join(__dirname, 'data', 'vigilancia_evolution.json');
      let state = { fallos: 0, ultimoEstado: 'up' };
      try { state = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      return json(res, 200, {
        ok: true,
        vigilante: 'activo',
        evolution_url_configurado: !!process.env.EVOLUTION_API_URL || true,
        evolution_key_configurado: !!process.env.EVOLUTION_API_KEY,
        telegram_admin_configurado: !!(process.env.TELEGRAM_BOT_TOKEN && (process.env.TELEGRAM_CHAT_ID_ADMIN || process.env.TELEGRAM_CHAT_ID_DUVAN || process.env.TELEGRAM_CHAT_ID)),
        estado: state,
        minutos_sin_alertar: (state.fallos || 0) * 5,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/vigilancia-chatwoot — estado del vigilante ──
  if (req.method === 'GET' && req.url === '/api/admin/vigilancia-chatwoot') {
    try {
      const f = path.join(__dirname, 'data', 'vigilancia_chatwoot.json');
      let state = { fallos: 0, ultimoEstado: 'up' };
      try { state = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      return json(res, 200, {
        ok: true,
        vigilante: 'activo',
        chatwoot_url_configurado: !!process.env.CHATWOOT_URL,
        telegram_admin_configurado: !!(process.env.TELEGRAM_BOT_TOKEN && (process.env.TELEGRAM_CHAT_ID_ADMIN || process.env.TELEGRAM_CHAT_ID_DUVAN || process.env.TELEGRAM_CHAT_ID)),
        estado: state,
        minutos_caido: (state.fallos || 0) * 5,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }




  // ── GET /api/pedidos — lista todos los pedidos (purgando archivados) ──
  if (req.method === 'GET' && req.url === '/api/pedidos') {
    const peds = purgarArchivados(leerPedidos());
    const tomb = leerTombstones();
    return json(res, 200, { pedidos: peds, nextId: leerNextId(), archivados: tomb.map(t => t.id) });
  }

  // ── POST /api/pedidos/:id/avanzar ── avanza un pedido a un nuevo estado
  // Body: { estado: 'llego-impresion' }. Si llega a enviado-final, auto-archiva en Notion.
  if (req.method === 'POST' && req.url.match(/^\/api\/pedidos\/\d+\/avanzar$/)) {
    const id = parseInt(req.url.split('/')[3]);
    const persona = leerPersonaRequest(req);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      (async () => {
        try {
          const { estado } = JSON.parse(body || '{}');
          if (!estado) return json(res, 400, { error: 'falta estado' });
          const pedidos = leerPedidos();
          const p = pedidos.find(x => x.id === id);
          if (!p) return json(res, 404, { error: 'pedido no encontrado' });
          const estadoAnterior = p.estado;
          p.estado = estado;
          p.ultimoMovimiento = new Date().toISOString();
          if (persona) {
            p.ultimoMovimientoPor = persona.slug;
            p.historial = p.historial || [];
            p.historial.push({
              fecha: p.ultimoMovimiento,
              por: persona.slug,
              accion: 'avanzar',
              de: estadoAnterior,
              a: estado,
            });
          }
          guardarPedidos(pedidos, leerNextId());
          // Auto-archive si llegó al final
          if (estado === 'enviado-final') {
            try {
              const r = await archivarYBorrarPedido(id);
              if (r.ok) return json(res, 200, { ok: true, archivado: true, notionPageId: r.notionPageId });
            } catch (e) { console.error('[avanzar/auto-archive]', e); }
          }
          return json(res, 200, { ok: true, archivado: false, estado });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      })();
    });
    return;
  }

  // ── POST /api/pedidos/:id/registrar-entrega ──
  // Marca un pedido como entregado al cliente y registra cómo se entregó.
  // Body: {
  //   tipo: 'fabrica' | 'envio' | 'domicilio',
  //   fecha?: 'YYYY-MM-DD',          // por defecto hoy
  //   entregadoPor?: string,         // Camilo / Wendy / etc.
  //   recibidoPor?: string,          // nombre de la persona que recibio (cliente o representante)
  //   transportadora?: string,       // solo para tipo=envio
  //   numeroGuia?: string,           // solo para tipo=envio
  //   valorACobrar?: number,         // solo para tipo=envio (contra-entrega)
  //   direccion?: string,            // para tipo=domicilio
  //   nota?: string,
  // }
  if (req.method === 'POST' && req.url.match(/^\/api\/pedidos\/\d+\/registrar-entrega$/)) {
    const id = parseInt(req.url.split('/')[3]);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const TIPOS_OK = ['fabrica', 'envio', 'domicilio'];
        if (!TIPOS_OK.includes(data.tipo)) {
          return json(res, 400, { error: `tipo invalido. Usar uno de: ${TIPOS_OK.join(', ')}` });
        }
        const pedidos = leerPedidos();
        const p = pedidos.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'pedido no encontrado' });
        const estadoAnterior = p.estado;
        const ahora = new Date().toISOString();
        const fechaEntrega = data.fecha || new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
        // Datos de entrega
        p.entrega = {
          tipo: data.tipo,
          fecha: fechaEntrega,
          entregadoPor: data.entregadoPor || null,
          recibidoPor: data.recibidoPor || null,
          transportadora: data.tipo === 'envio' ? (data.transportadora || null) : null,
          numeroGuia: data.tipo === 'envio' ? (data.numeroGuia || null) : null,
          valorACobrar: data.tipo === 'envio' ? (data.valorACobrar || null) : null,
          direccion: data.tipo === 'domicilio' ? (data.direccion || null) : null,
          nota: data.nota || null,
          registradoEn: ahora,
        };
        p.estado = 'enviado-final';
        p.ultimoMovimiento = ahora;
        p.historial = p.historial || [];
        p.historial.push({
          fecha: ahora,
          por: data.entregadoPor || 'registro-entrega',
          accion: 'registrar-entrega',
          de: estadoAnterior,
          a: 'enviado-final',
          nota: `Entrega ${data.tipo}${data.fecha ? ' (' + data.fecha + ')' : ''}${data.recibidoPor ? ' a ' + data.recibidoPor : ''}${data.numeroGuia ? ' guia ' + data.numeroGuia : ''}`,
        });
        guardarPedidos(pedidos, leerNextId());
        return json(res, 200, { ok: true, pedido: { id: p.id, estado: p.estado, entrega: p.entrega } });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/pedidos/:id/foto-costura ──
  // Recibe { fotoBase64: "data:image/jpeg;base64,..." } desde la app de la
  // costurera al pulsar "Terminé". Guarda la foto en disco, registra en
  // historial con la persona del header X-Ws-Persona, y avanza el estado a
  // 'calidad' automáticamente. La foto queda referenciada en p.fotosCostura.
  if (req.method === 'POST' && req.url.match(/^\/api\/pedidos\/\d+\/foto-costura$/)) {
    const id = parseInt(req.url.split('/')[3]);
    const persona = leerPersonaRequest(req);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { fotoBase64 } = JSON.parse(body || '{}');
        if (!fotoBase64 || typeof fotoBase64 !== 'string') {
          return json(res, 400, { error: 'falta fotoBase64' });
        }
        const m = fotoBase64.match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/);
        if (!m) return json(res, 400, { error: 'fotoBase64 invalido (debe ser data URL image/*)' });
        const ext = m[2] === 'jpg' ? 'jpg' : m[2];
        const datos = Buffer.from(m[3], 'base64');
        // Límite generoso para fotos de celular (8 MB)
        if (datos.length > 8 * 1024 * 1024) {
          return json(res, 413, { error: 'foto demasiado grande (max 8 MB)' });
        }

        const pedidos = leerPedidos();
        const p = pedidos.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'pedido no encontrado' });

        // Guardar foto en disco
        const dirFotos = path.join(__dirname, 'data', 'fotos-costura');
        try { fs.mkdirSync(dirFotos, { recursive: true }); } catch (e) {}
        const ts = Date.now();
        const slug = persona ? persona.slug : 'sin-persona';
        const nombreArchivo = `${id}_${slug}_${ts}.${ext}`;
        const rutaFoto = path.join(dirFotos, nombreArchivo);
        fs.writeFileSync(rutaFoto, datos);

        // Actualizar pedido
        const estadoAnterior = p.estado;
        const sateliteAnterior = p.satelite || (persona ? persona.nombre : null);
        p.estado = 'calidad';
        delete p.satelite;
        p.ultimoMovimiento = new Date().toISOString();
        p.fotosCostura = p.fotosCostura || [];
        p.fotosCostura.push({
          archivo: nombreArchivo,
          url: `/data/fotos-costura/${nombreArchivo}`,
          por: persona ? persona.slug : null,
          satelite: sateliteAnterior,
          fecha: p.ultimoMovimiento,
        });
        if (persona) {
          p.ultimoMovimientoPor = persona.slug;
          p.historial = p.historial || [];
          p.historial.push({
            fecha: p.ultimoMovimiento,
            por: persona.slug,
            accion: 'termine-costura',
            de: estadoAnterior,
            a: 'calidad',
            foto: nombreArchivo,
          });
        }
        guardarPedidos(pedidos, leerNextId());

        console.log(`[foto-costura] #${id} terminado por ${slug} (${datos.length} bytes)`);
        return json(res, 200, {
          ok: true,
          estado: 'calidad',
          foto: { archivo: nombreArchivo, url: `/data/fotos-costura/${nombreArchivo}` },
        });
      } catch (e) {
        console.error('[foto-costura] error', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /data/fotos-costura/:archivo ── servir foto de costura ──
  if (req.method === 'GET' && req.url.startsWith('/data/fotos-costura/')) {
    const archivo = req.url.split('/').pop().split('?')[0];
    // Validar nombre (solo caracteres seguros: letras, números, guion, punto)
    if (!/^[\w.\-]+$/.test(archivo)) {
      res.writeHead(400); return res.end('nombre invalido');
    }
    const ruta = path.join(__dirname, 'data', 'fotos-costura', archivo);
    return fs.readFile(ruta, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(archivo).toLowerCase();
      const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      cors(res);
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }

  // ── DELETE /api/pedidos/:id — borra un pedido del servidor ──
  // -- PATCH /api/pedidos/:id -- actualiza campos puntuales de un pedido.
  // Usado por mini-vistas moviles para editar sin resincronizar todo el tablero.
  if (req.method === 'PATCH' && req.url.match(/^\/api\/pedidos\/\d+$/)) {
    const id = parseInt(req.url.split('/')[3]);
    const persona = leerPersonaRequest(req);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const cambios = JSON.parse(body || '{}');
        const permitidos = new Set([
          'equipo', 'telefono', 'vendedora', 'disenadorAsignado', 'fechaEntrega',
          'notas', 'estado', 'satelite', 'arreglo'
        ]);
        const pedidos = leerPedidos();
        const p = pedidos.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'pedido no encontrado' });
        const cambiosAplicados = {};
        for (const [k, v] of Object.entries(cambios)) {
          if (permitidos.has(k)) {
            cambiosAplicados[k] = { de: p[k], a: v };
            p[k] = v;
          }
        }
        p.ultimoMovimiento = new Date().toISOString();
        if (persona && Object.keys(cambiosAplicados).length) {
          p.ultimoMovimientoPor = persona.slug;
          p.historial = p.historial || [];
          p.historial.push({
            fecha: p.ultimoMovimiento,
            por: persona.slug,
            accion: 'patch',
            cambios: cambiosAplicados,
          });
        }
        guardarPedidos(pedidos, leerNextId());
        return json(res, 200, { ok: true, pedido: p });
      } catch (e) {
        return json(res, 400, { error: 'JSON invalido: ' + e.message });
      }
    });
    return;
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/pedidos/') && !req.url.includes('limpiar-basura')) {
    const id = parseInt(req.url.split('/')[3]);
    const pedidos = leerPedidos();
    const pedidoBorrado = pedidos.find(p => p.id === id);
    const nuevos = pedidos.filter(p => p.id !== id);
    if (nuevos.length === pedidos.length) return json(res, 404, { error: 'Pedido no encontrado' });
    guardarPedidos(nuevos);
    // CRITICO 1: tombstone por ID para que el cliente PWA no lo resucite al
    // sincronizar su localStorage.
    agregarTombstone(id);
    // CRITICO 2: agregar el TELEFONO a descartados (60 dias) para que el
    // reprocesador-historico de stickers y el handler en tiempo real no
    // recreen un pedido nuevo del mismo cliente. Sin esto, el cron 10PM
    // vuelve a crear el pedido al detectar el sticker viejo.
    if (pedidoBorrado && pedidoBorrado.telefono) {
      agregarTelefonoDescartado(pedidoBorrado.telefono, `pedido #${id} borrado`);
    }
    console.log(`[api] Pedido #${id} eliminado + tombstone + telefono descartado (${pedidoBorrado?.telefono || 'sin tel'})`);
    return json(res, 200, { ok: true });
  }

  // ── POST /api/admin/limpiar-pedidos-vacios?dryRun=1 — borra pedidos del bot sin info real ──
  // Pedidos creados por sticker/bot/comprobante que llevan >7 días sin nombre, sin cliente,
  // sin items y sin total quedaron "vacíos". El tablero los muestra como cards en blanco.
  // Este endpoint los purga (excluye los que tienen equipo/cliente/total/fotosCostura).
  if (req.method === 'POST' && req.url.startsWith('/api/admin/limpiar-pedidos-vacios')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const dryRun = u.searchParams.get('dryRun') === '1';
      const minDias = parseInt(u.searchParams.get('minDias') || '3', 10);
      const ahora = Date.now();
      const pedidos = leerPedidos();
      const esVacio = (p) => {
        if (p.estado === 'enviado-final') return false;
        if (p.stickerVenta) return false;
        const eq = String(p.equipo || '').trim();
        const cli = String(p.cliente || '').trim();
        const tel = String(p.telefono || '').replace(/\D/g, '');
        const total = Number(p.total || 0);
        const hayItems = Array.isArray(p.items) && p.items.length > 0;
        const hayFotos = Array.isArray(p.fotosCostura) && p.fotosCostura.length > 0;
        // Si tiene cualquier dato real, NO es vacío
        if (eq.length >= 2) return false;
        if (cli.length >= 2) return false;
        if (total > 0) return false;
        if (hayItems) return false;
        if (hayFotos) return false;
        if (p.disenadorAsignado) return false;
        // Edad mínima — no borrar pedidos del día (aún se están armando)
        const ts = new Date(p.ultimoMovimiento || p.creadoEn || 0).getTime();
        if (!ts) return false;
        const dias = (ahora - ts) / 86400000;
        if (dias < minDias) return false;
        // Solo borrar los creados por sistema (bot/comprobante/etc), nunca manuales
        const creadoPorSistema = p.origenBot || p.origenComprobante || p.origenHuerfano || p.origenFacturaHuerfana;
        return !!creadoPorSistema;
      };
      const candidatos = pedidos.filter(esVacio);
      const muestra = candidatos.slice(0, 20).map(p => ({
        id: p.id, vendedora: p.vendedora, estado: p.estado, tel: p.telefono,
        dias: Math.floor((ahora - new Date(p.ultimoMovimiento || p.creadoEn || 0).getTime()) / 86400000),
        origen: p.origenBot ? 'bot' : p.origenComprobante ? 'comprobante' : p.origenHuerfano ? 'huerfano' : p.origenFacturaHuerfana ? 'facturaHuerfana' : '?',
      }));
      if (dryRun) {
        return json(res, 200, { dryRun: true, total: candidatos.length, muestra });
      }
      const ids = candidatos.map(p => p.id);
      const limpios = pedidos.filter(p => !ids.includes(p.id));
      guardarPedidos(limpios);
      console.log(`[limpiar-pedidos-vacios] eliminados ${candidatos.length} pedidos del bot sin datos (minDias=${minDias})`);
      return json(res, 200, { ok: true, eliminados: candidatos.length, ids, total_antes: pedidos.length, total_despues: limpios.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/setup-webhooks?key=ws-textil-2026 ──
  // Configura webhook URL en TODAS las instancias Evolution conocidas.
  // Soluciona problema 3-jun-2026: solo ws-ventas tenia webhook → solo Betty
  // recibia eventos. Las demas vendedoras no procesaban nada.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/setup-webhooks')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const key = u.searchParams.get('key');
      if (key !== (process.env.RESET_KEY || 'ws-textil-2026')) {
        return json(res, 401, { error: 'key invalida' });
      }
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const evoKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
      const serverUrl = process.env.PUBLIC_URL || 'https://ws-app-interna-production.up.railway.app';
      const webhookUrl = `${serverUrl}/api/evolution-webhook?token=ws_secret_2026`;
      const instancias = ['ws-paola', 'ws-ney', 'ws-duvan', 'ws wendy', 'ws-ventas'];
      const eventos = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'CHATS_UPDATE'];
      const resultados = [];
      for (const inst of instancias) {
        try {
          const instEnc = encodeURIComponent(inst);
          const r = await fetch(`${evoUrl}/webhook/set/${instEnc}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
            body: JSON.stringify({ webhook: { url: webhookUrl, enabled: true, events: eventos, webhook_by_events: false } }),
          });
          const data = await r.json().catch(() => ({}));
          resultados.push({ instancia: inst, status: r.status, ok: r.ok, respuesta: data });
        } catch (e) {
          resultados.push({ instancia: inst, error: e.message });
        }
      }
      return json(res, 200, { ok: true, webhookUrl, resultados });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/reset-hora-cero?key=ws-textil-2026 ──
  // HORA 0: borra TODOS los pedidos, agrega tombstones (anti-resucitar),
  // limpia comprobantes detectados, limpia documentos salientes WA,
  // limpia recordatorios. NO toca calandra, NO toca facturas, NO toca
  // telefonos descartados (mantiene proveedores permanentes).
  // NO agrega los telefonos de pedidos borrados a descartados (a diferencia
  // del DELETE individual), para que el dia 0 arranque sin bloqueos.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/reset-hora-cero')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const key = u.searchParams.get('key');
      if (key !== (process.env.RESET_KEY || 'ws-textil-2026')) {
        return json(res, 401, { error: 'key invalida' });
      }
      const pedidosAntes = leerPedidos();
      const idsBorrados = pedidosAntes.map(p => p.id);
      // Agregar tombstones por ID (no por telefono)
      for (const id of idsBorrados) {
        try { agregarTombstone(id); } catch {}
      }
      // Borrar pedidos
      db.guardarPedidos([]);
      // Limpiar comprobantes detectados (BD) via SQL raw
      let compsLimpiados = 0;
      try {
        if (typeof db.raw !== 'undefined' && db.raw.prepare) {
          const r = db.raw.prepare('DELETE FROM comprobantes').run();
          compsLimpiados = r.changes || 0;
        }
      } catch (eC) { console.error('[reset-cero] comps:', eC.message); }
      // Limpiar docs salientes WA (tabla)
      let docsLimpiados = 0;
      try {
        if (typeof db.raw !== 'undefined' && db.raw.prepare) {
          const r = db.raw.prepare('DELETE FROM documentos_salientes_wa').run();
          docsLimpiados = r.changes || 0;
        }
      } catch (eD) { console.error('[reset-cero] docs:', eD.message); }
      // Limpiar recordatorios y state files
      const archivos = [
        'data/wa_notif_dedupe.json',
        'data/grupo_ventas_state.json',
        'data/catalogo_watcher_state.json',
        'data/ventas_snapshot_actual.json',
      ];
      for (const f of archivos) {
        try {
          const p = path.join(__dirname, f);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }
      console.log(`[reset-cero] HORA 0: ${idsBorrados.length} pedidos + ${compsLimpiados} comprobantes + ${docsLimpiados} docs salientes`);
      return json(res, 200, {
        ok: true,
        pedidos_borrados: idsBorrados.length,
        ids: idsBorrados,
        comprobantes_borrados: compsLimpiados,
        docs_salientes_borrados: docsLimpiados,
        tombstones_agregados: idsBorrados.length,
        nota: 'Calandra y facturas NO se tocaron. Telefonos descartados (proveedores) NO se tocaron.',
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
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
        const ESTADOS_EN_CURSO = new Set(['hacer-diseno','confirmado','enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo']);
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
        // PROTECCION: pedidos creados por el bot (origenBot, origenComprobante, origenHuerfano)
        // se preservan SIEMPRE — el cliente no puede borrarlos por cache vieja en eliminadosLocales.
        // Solo se borran si estan en archivadosSet (tombstone de Notion, decision explicita).
        const incomingIds = new Set(incomingFiltrado.map(p => p.id));
        let recuperadosDelBot = 0;
        existing.forEach(e => {
          if (incomingIds.has(e.id)) return;
          if (archivadosSet.has(e.id)) return;
          const creadoPorSistema = e.origenBot || e.origenComprobante || e.origenHuerfano || e.origenFacturaHuerfana;
          if (creadoPorSistema) {
            // Pedido creado por sistema — NO permitir que client-side eliminadosLocales lo mate
            if (eliminadosSet.has(e.id)) recuperadosDelBot++;
            merged.push(e);
          } else if (!eliminadosSet.has(e.id)) {
            // Pedido manual del cliente — respeta eliminadosLocales
            merged.push(e);
          }
        });
        if (recuperadosDelBot > 0) console.log(`[POST /api/pedidos] protegidos ${recuperadosDelBot} pedidos bot que cliente intento borrar via cache`);
        merged.sort((a, b) => a.id - b.id);

        // ─── DETECCIÓN DE CAMBIOS para disparar notificaciones WA + historial ───
        const personaReq = leerPersonaRequest(req);
        const cambiosDisenador = [];
        const cambiosListo = [];
        for (const p of merged) {
          const e = mapaExisting.get(p.id);
          if (!e) continue;
          // Diseñador asignado por primera vez
          if (!e.disenadorAsignado && p.disenadorAsignado && p.disenadorAsignado !== 'null') {
            cambiosDisenador.push({ pedido: p, disenador: p.disenadorAsignado });
          }
          // Pedido pasa a 'listo'
          if (e.estado !== 'listo' && p.estado === 'listo') {
            cambiosListo.push({ pedido: p });
          }
          // Historial server-side: registrar cualquier cambio de estado/vendedora/disenadorAsignado
          // si la entrada no la trae ya el cliente (evita duplicar)
          const hubo = [];
          if (e.estado !== p.estado) hubo.push({ campo: 'estado', de: e.estado, a: p.estado });
          if ((e.vendedora || '') !== (p.vendedora || '')) hubo.push({ campo: 'vendedora', de: e.vendedora || '', a: p.vendedora || '' });
          if ((e.disenadorAsignado || '') !== (p.disenadorAsignado || '')) hubo.push({ campo: 'disenadorAsignado', de: e.disenadorAsignado || '', a: p.disenadorAsignado || '' });
          if (hubo.length > 0) {
            p.historial = p.historial || [];
            const fecha = p.ultimoMovimiento || new Date().toISOString();
            const por = personaReq ? personaReq.slug : (p.ultimoMovimientoPor || 'desconocido');
            // Solo registrar si no hay una entrada idéntica en los últimos 3 segundos (evita duplicar
            // si el cliente ya envió historial por su lado)
            const ultimoHist = p.historial[p.historial.length - 1];
            const dupe = ultimoHist
              && Math.abs(new Date(ultimoHist.fecha || 0).getTime() - new Date(fecha).getTime()) < 3000
              && ultimoHist.por === por
              && JSON.stringify(ultimoHist.cambios || {}) === JSON.stringify(Object.fromEntries(hubo.map(h => [h.campo, { de: h.de, a: h.a }])));
            if (!dupe) {
              p.historial.push({
                fecha,
                por,
                accion: 'sync',
                cambios: Object.fromEntries(hubo.map(h => [h.campo, { de: h.de, a: h.a }])),
              });
              if (personaReq) p.ultimoMovimientoPor = personaReq.slug;
            }
          }
        }

        guardarPedidos(merged, nextId);

        // Disparar notificaciones en background (no bloquear respuesta)
        for (const c of cambiosDisenador) {
          const p = c.pedido;
          const msg = `🎨 *Nuevo pedido asignado*\n\n` +
            `Pedido #${p.id} — ${p.equipo || p.telefono || 'Sin equipo'}\n` +
            `Vendedora: ${p.vendedora || '—'}\n` +
            (p.fechaEntrega ? `Entrega: ${p.fechaEntrega}\n` : '') +
            (p.notas ? `Nota: ${p.notas}\n` : '') +
            `\nAbre tu Mi Día para verlo: https://ws-app-interna-production.up.railway.app/#/mi-dia`;
          notificarWAPersona(c.disenador, msg).catch(()=>{});
        }
        for (const c of cambiosListo) {
          const p = c.pedido;
          if (!p.vendedora) continue;
          const msg = `✅ *Pedido listo para enviar*\n\n` +
            `Pedido #${p.id} — ${p.equipo || p.telefono || 'Sin equipo'} está listo.\n` +
            `Avísale al cliente que ya puede pagar el saldo final para despachar.`;
          notificarWAPersona(p.vendedora, msg).catch(()=>{});
        }

        // Devolver la lista final mergeada para que el cliente cierre el loop:
        // si el server agregó pedidos (recuperados del bot, recién creados por sticker, etc),
        // el cliente actualiza su localStorage en lugar de quedarse con su cache vieja.
        return json(res, 200, { ok: true, total: merged.length, pedidos: merged, nextId: leerNextId() });
      } catch (e) {
        return json(res, 400, { error: 'JSON inválido' });
      }
    });
    return;
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
    return json(res, 200, { ok: true, version: 'sprint-5-notion-archivo', activas: process.env.REACCIONES_ACTIVAS === 'true', chatwoot: !!process.env.CHATWOOT_API_KEY, telegram: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID, telegram_chat_duvan: !!process.env.TELEGRAM_CHAT_ID_DUVAN, wa_grupo: process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us', sticker_hashes_configurados: (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').filter(Boolean).length, evolution_api_key: !!process.env.EVOLUTION_API_KEY, gemini_api_key: !!process.env.GEMINI_API_KEY, notion_token: !!process.env.NOTION_TOKEN, notion_db: !!process.env.NOTION_DB_ARCHIVO_PEDIDOS });
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

  // ── POST /api/admin/limpiar-tombstone — saca un pedido archivado para revivirlo ──
  // Body: { id: 219 }
  if (req.method === 'POST' && req.url === '/api/admin/limpiar-tombstone') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        if (!id) return json(res, 400, { error: 'falta id' });
        const lista = leerTombstones();
        const antes = lista.length;
        const nueva = lista.filter(t => t.id !== id);
        guardarTombstones(nueva);
        return json(res, 200, { ok: true, removed: antes - nueva.length, totalAhora: nueva.length });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /api/admin/tombstones — listar todos los archivados (debug) ──
  if (req.method === 'GET' && req.url === '/api/admin/tombstones') {
    return json(res, 200, { tombstones: leerTombstones() });
  }

  // ── TELEFONOS DESCARTADOS — admin ──
  if (req.method === 'GET' && req.url === '/api/admin/telefonos-descartados') {
    return json(res, 200, { items: leerTelefonosDescartados() });
  }
  // POST /api/admin/telefonos-descartados — body: { telefonos: ['573124858901', ...], motivo? }
  // Para agregar manualmente tels a la lista (ej. para los pedidos ya borrados antes del fix).
  if (req.method === 'POST' && req.url === '/api/admin/telefonos-descartados') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { telefonos, motivo } = JSON.parse(body || '{}');
        if (!Array.isArray(telefonos)) return json(res, 400, { error: 'telefonos debe ser un array' });
        let agregados = 0;
        for (const t of telefonos) {
          const antes = leerTelefonosDescartados().length;
          agregarTelefonoDescartado(t, motivo || 'agregado manual via admin');
          if (leerTelefonosDescartados().length > antes) agregados++;
        }
        return json(res, 200, { ok: true, agregados, total: leerTelefonosDescartados().length });
      } catch (e) { return json(res, 500, { error: e.message }); }
    });
    return;
  }
  // DELETE /api/admin/telefonos-descartados/:tel — quitar uno (si fue por error)
  if (req.method === 'DELETE' && req.url.startsWith('/api/admin/telefonos-descartados/')) {
    try {
      const tel = normTel(req.url.split('/')[4]);
      const lista = leerTelefonosDescartados();
      const nueva = lista.filter(t => t.tel !== tel);
      if (nueva.length === lista.length) return json(res, 404, { error: 'no estaba en la lista' });
      guardarTelefonosDescartados(nueva);
      return json(res, 200, { ok: true, removido: tel });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ── GET /api/admin/sticker-detectar — lista stickers enviados POR NOSOTROS hoy y ofrece hash ──
  // Cuando una vendedora envia el sticker oficial, este endpoint captura el hash.
  if (req.method === 'GET' && req.url === '/api/admin/sticker-detectar') {
    try {
      // Tomar TODOS los eventos recientes (sin filtro de fecha por si los timestamps fallan)
      const rows = db.raw.prepare('SELECT fecha, data FROM evolution_events ORDER BY id DESC LIMIT 10000').all();
      const stickersSalientes = [];
      const hashCount = {};
      const debugInfo = { totalEventos: rows.length, stickersVistos: 0, conFromMe: 0, conMessage: 0, conSha: 0, errores: 0, primerSticker: null };
      function _shaToHex(sha) {
        if (!sha) return null;
        if (typeof sha === 'string') return Buffer.from(sha, 'base64').toString('hex');
        if (typeof sha === 'object') {
          const keys = Object.keys(sha).filter(k => /^\d+$/.test(k)).sort((a,b)=>+a-+b);
          if (!keys.length) return null;
          const bytes = keys.map(k => sha[k]);
          return Buffer.from(bytes).toString('hex');
        }
        return null;
      }
      for (const row of rows) {
        try {
          const ev = JSON.parse(row.data);
          const d = ev.data || {};
          if (d.messageType !== 'stickerMessage') continue;
          debugInfo.stickersVistos++;
          if (!debugInfo.primerSticker) {
            debugInfo.primerSticker = JSON.stringify(ev).slice(0, 800);
          }
          if (d.key?.fromMe === true) debugInfo.conFromMe++;
          if (d.message?.stickerMessage) debugInfo.conMessage++;
          const sm = d.message?.stickerMessage || {};
          const hash = _shaToHex(sm.fileSha256);
          if (hash) debugInfo.conSha++;
          if (!hash) continue;
          hashCount[hash] = (hashCount[hash] || 0) + 1;
          stickersSalientes.push({
            fecha: row.fecha,
            instance: ev.instance,
            fromMe: d.key?.fromMe,
            jid: d.key?.remoteJid,
            hash: hash.slice(0, 30) + '...',
            hashCompleto: hash,
            ts: d.messageTimestamp,
          });
        } catch (e) { debugInfo.errores++; }
      }
      const STICKER_VENTA_HASH = process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995';
      // Hash mas usado entre nuestros stickers salientes (probablemente el oficial)
      const masUsado = Object.entries(hashCount).sort((a, b) => b[1] - a[1])[0] || null;
      return json(res, 200, {
        configurado: STICKER_VENTA_HASH,
        configuradoYaCoincide: masUsado && STICKER_VENTA_HASH.includes(masUsado[0]),
        hashMasUsado: masUsado ? { hash: masUsado[0], veces: masUsado[1] } : null,
        totalSalientes: stickersSalientes.length,
        recientes: stickersSalientes.slice(0, 10),
        hashesUnicos: Object.entries(hashCount).map(([h, c]) => ({ hash: h, veces: c })),
        debug: debugInfo,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/limpiar-tombstones-huerfanos — borra TODOS los tombstones de un golpe ──
  // Body opcional: { ids: [219, 226] } para borrar solo esos. Sin body borra todos.
  if (req.method === 'POST' && req.url === '/api/admin/limpiar-tombstones-huerfanos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const opts = body ? JSON.parse(body) : {};
        const idsAEliminar = Array.isArray(opts.ids) ? new Set(opts.ids) : null;
        const lista = leerTombstones();
        const antes = lista.length;
        const nueva = idsAEliminar ? lista.filter(t => !idsAEliminar.has(t.id)) : [];
        guardarTombstones(nueva);
        return json(res, 200, { ok: true, antes, ahora: nueva.length, removidos: antes - nueva.length });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /v/:token — link click para procesar decisión de venta (panel WA del jefe) ──
  // Token formato: <snapshotId>-<numero>. Query params: ?v=<vendedora> (SI) o ?no=1 (NO)
  if (req.method === 'GET' && req.url.startsWith('/v/')) {
    (async () => {
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const tokenRaw = urlObj.pathname.split('/v/')[1];
        const accionSi = urlObj.searchParams.get('si');
        const accionVend = urlObj.searchParams.get('v');
        const accionNo = urlObj.searchParams.get('no');
        const montoOverride = urlObj.searchParams.get('monto');
        const m = tokenRaw.match(/^(.+)-(\d+)$/);
        if (!m) return _htmlError(res, 'Link invalido');
        const snapId = m[1];
        const numero = parseInt(m[2], 10);

        const snap = db.leerConfig().ventas_snapshot_actual;
        if (!snap || snap.id !== snapId) return _htmlError(res, 'Snapshot expirado. Solicita un nuevo resumen escribiendo "ver" o esperando el de las 7 PM.');
        const cand = (snap.candidatos || []).find(c => c.numero === numero);
        if (!cand) return _htmlError(res, `Candidato #${numero} no encontrado.`);
        const yaDec = db.leerDecisionVenta(cand.messageId);
        if (yaDec) return _htmlOk(res, `Ya procesado`, `Este candidato (#${numero}: ${cand.cliente}) ya fue marcado como *${yaDec.decision}*${yaDec.pedido_id ? ' (pedido #' + yaDec.pedido_id + ')' : ''}.`);

        if (accionNo) {
          db.guardarDecisionVenta({ candidatoKey: cand.messageId, decision: 'no' });
          await responderJefe(`❌ #${numero} descartado — ${cand.cliente} no se sube como venta.`);
          return _htmlOk(res, '❌ Descartado', `${cand.cliente} marcado como NO venta. Ya no aparecerá en el panel.`);
        }
        // ?si=1 → usa la vendedora sugerida (automatica por linea). ?v=ney → override manual.
        const vendedoraElegida = accionVend || (accionSi ? cand.vendedoraSugerida : null);
        if (vendedoraElegida) {
          const VENDEDORAS_VALIDAS = ['betty','graciela','ney','wendy','paola'];
          const vendNorm = String(vendedoraElegida).toLowerCase();
          if (!VENDEDORAS_VALIDAS.includes(vendNorm)) return _htmlError(res, `Vendedora "${vendedoraElegida}" invalida.`);
          const montoFinal = (montoOverride ? parseInt(montoOverride.replace(/\D/g,''), 10) : null) || cand.monto || 0;
          const resCrear = crearVentaInterna('pedido', vendNorm, cand.telefono || '', 'panel-' + cand.messageId, cand.cliente || `Cliente +57 ${cand.telefono || '?'}`);
          if (!resCrear.ok) return _htmlError(res, `Error: ${resCrear.error}`);
          if (resCrear.id && !resCrear.duplicado) {
            const pps = leerPedidos();
            const pp = pps.find(x => x.id === resCrear.id);
            if (pp) {
              pp.origenComprobante = true;
              pp.montoComprobante = montoFinal;
              pp.bancoComprobante = cand.banco || null;
              pp.notas = (pp.notas || '') + ` [subido desde panel WA por jefe]`;
              guardarPedidos(pps, leerNextId());
            }
          }
          db.guardarDecisionVenta({ candidatoKey: cand.messageId, decision: 'si', pedidoId: resCrear.id, vendedora: vendNorm, monto: montoFinal });
          const montoTxt = montoFinal ? `\n💰 $${montoFinal.toLocaleString('es-CO')}` : '';
          await responderJefe(`✅ Pedido #${resCrear.id} creado\n👤 ${cand.cliente}\n📞 ${cand.telefono}\n🛍️ ${vendNorm}${montoTxt}`);
          return _htmlOk(res, '✅ Venta creada', `Pedido #${resCrear.id}<br><br>👤 ${cand.cliente}<br>📞 ${cand.telefono}<br>🛍️ Vendedora: ${vendNorm}${montoTxt.replace('\n','<br>')}`);
        }
        return _htmlError(res, 'Falta accion (?v=<vendedora> o ?no=1)');
      } catch (e) {
        return _htmlError(res, 'Error: ' + e.message);
      }
    })();
    return;
  }

  // ── POST /api/admin/disparar-snapshot-ventas — fuerza envio WA al jefe AHORA ──
  if (req.method === 'POST' && req.url === '/api/admin/disparar-snapshot-ventas') {
    (async () => {
      try {
        const snap = generarSnapshotVentas();
        const ok = await enviarSnapshotWA(snap);
        return json(res, 200, { ok, candidatos: snap.candidatos.length, snapshot: snap });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── GET /api/admin/snapshot-ventas-actual — ver snapshot actual + decisiones ──
  if (req.method === 'GET' && req.url === '/api/admin/snapshot-ventas-actual') {
    try {
      const snap = db.leerConfig().ventas_snapshot_actual || null;
      const decisiones = db.listarDecisionesVentas();
      return json(res, 200, { snapshot: snap, decisiones });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/diag-msj-jefe — ultimos mensajes de texto fromMe en ws-duvan ──
  if (req.method === 'GET' && req.url === '/api/admin/diag-msj-jefe') {
    try {
      const rows = db.raw.prepare('SELECT fecha, data FROM evolution_events ORDER BY id DESC LIMIT 200').all();
      const msjs = [];
      for (const row of rows) {
        try {
          const ev = JSON.parse(row.data);
          if (ev.instance !== 'ws-duvan') continue;
          const d = ev.data || {};
          if (d.messageType !== 'conversation' && d.messageType !== 'extendedTextMessage') continue;
          msjs.push({
            fecha: row.fecha,
            ts: ev.date_time || d.messageTimestamp,
            fromMe: d.key?.fromMe,
            remoteJid: d.key?.remoteJid,
            messageType: d.messageType,
            texto: (d.message?.conversation || d.message?.extendedTextMessage?.text || '').slice(0, 200),
          });
          if (msjs.length >= 20) break;
        } catch {}
      }
      return json(res, 200, { total: msjs.length, msjs });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/test-respuesta-jefe — simula respuesta del jefe sin pasar por WA ──
  // Body: { texto: "1 si betty" }
  if (req.method === 'POST' && req.url === '/api/admin/test-respuesta-jefe') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { texto } = JSON.parse(body || '{}');
        if (!texto) return json(res, 400, { error: 'falta texto' });
        const r = await procesarRespuestaJefe(texto);
        return json(res, 200, { procesado: r });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/admin/sticker-reprocesar-historicos?dryRun=1 ──
  // Reprocesa stickers fromMe + hash válido de los últimos 10 días que NO crearon pedido.
  // Recupera los pedidos faltantes (caso reporte de Paola).
  if (req.method === 'POST' && req.url.startsWith('/api/admin/sticker-reprocesar-historicos')) {
    (async () => {
      try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const dryRun = u.searchParams.get('dryRun') === '1';
        const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim());
        const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 10').all().map(r => r.fecha);
        const acciones = [];
        for (const fecha of fechas) {
          const events = db.leerEvolutionEvents(fecha);
          for (const ev of events) {
            const ed = ev.data || ev;
            if (ed?.messageType !== 'stickerMessage') continue;
            const stk = ed.message?.stickerMessage || {};
            const hash = stk.fileSha256 ? Buffer.from(Object.values(stk.fileSha256)).toString('hex') : '';
            if (!STICKERS_VENTA.includes(hash)) continue;
            if (ed.key?.fromMe !== true) continue;
            const remoteJid = ed.key?.remoteJid || '';
            const tel = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            if (tel.length < 6) continue;
            // Si el telefono fue descartado (pedido borrado), no recrear.
            // Esto evita el bug reportado por Camilo: borraba pedidos y volvian
            // a aparecer porque el cron reprocesaba el sticker historico.
            if (esTelefonoDescartado(tel)) {
              console.log(`[reprocesador] saltado — tel ${tel} esta en descartados`);
              continue;
            }
            const instance = ev.instance || '?';
            const vendedora = vendedoraDeInstancia(instance);
            const pushName = ed.pushName || '';
            // ¿Ya hay pedido del cliente con stickerVenta?
            const pedidosActuales = leerPedidos();
            const yaProcesado = pedidosActuales.some(p =>
              String(p.telefono || '').replace(/\D/g, '') === tel && p.stickerVenta === hash
            );
            if (yaProcesado) continue;
            // Hay pedido pero sin sticker? Marcárselo (no crear duplicado)
            const pedidoExistente = pedidosActuales.find(p =>
              String(p.telefono || '').replace(/\D/g, '') === tel
              && ['bandeja','hacer-diseno','confirmado'].includes(p.estado)
            );
            if (pedidoExistente) {
              if (dryRun) {
                acciones.push({ accion: 'marcar-sticker', tel, vendedora, fecha, pedido_id: pedidoExistente.id });
              } else {
                pedidoExistente.stickerVenta = hash;
                pedidoExistente.fechaVenta = pedidoExistente.fechaVenta || new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
                if (pedidoExistente.estado === 'bandeja') pedidoExistente.estado = 'hacer-diseno';
                if (pedidoExistente.tipoBandeja === 'cotizar') pedidoExistente.tipoBandeja = 'pedido';
                pedidoExistente.ultimoMovimiento = new Date().toISOString();
                pedidoExistente.historial = pedidoExistente.historial || [];
                pedidoExistente.historial.push({
                  fecha: new Date().toISOString(),
                  por: 'sticker-reprocesador',
                  accion: 'sticker-detectado-historico',
                  nota: `Sticker venta de ${vendedora} reprocesado desde evento del ${fecha}`,
                });
                const todos = leerPedidos();
                const idx = todos.findIndex(x => x.id === pedidoExistente.id);
                if (idx >= 0) { todos[idx] = pedidoExistente; guardarPedidos(todos, leerNextId()); }
                acciones.push({ accion: 'marcar-sticker', tel, vendedora, fecha, pedido_id: pedidoExistente.id });
              }
            } else {
              // No hay pedido — crearlo (resolverCliente filtra pushNames de la cuenta empresa)
              let nombreCliente = '';
              try {
                const resuelto = await resolverCliente(remoteJid, tel, pushName);
                nombreCliente = resuelto.nombre || '';
              } catch (eR) {
                nombreCliente = `Cliente +57 ${tel.slice(-10)}`;
              }
              if (dryRun) {
                acciones.push({ accion: 'crear-pedido', tel, vendedora, fecha, equipoResuelto: nombreCliente });
                continue;
              }
              {
                const r = crearVentaInterna('pedido', vendedora, tel, null, nombreCliente);
                if (r.ok && r.id) {
                  const todos = leerPedidos();
                  const pd = todos.find(x => x.id === r.id);
                  if (pd) {
                    pd.estado = 'hacer-diseno';
                    pd.tipoBandeja = 'pedido';
                    pd.stickerVenta = hash;
                    pd.fechaVenta = fecha;
                    pd.origenBot = true;
                    pd.notas = pd.notas || `Recuperado desde sticker historico del ${fecha}`;
                    pd.ultimoMovimiento = new Date().toISOString();
                    pd.historial = pd.historial || [];
                    pd.historial.push({
                      fecha: new Date().toISOString(),
                      por: 'sticker-reprocesador',
                      accion: 'crear-desde-sticker-historico',
                      nota: `Sticker venta de ${vendedora} del ${fecha}`,
                    });
                    guardarPedidos(todos, leerNextId());
                  }
                  acciones.push({ accion: 'crear-pedido', tel, vendedora, fecha, nuevo_pedido_id: r.id });
                } else {
                  acciones.push({ accion: 'fallo-crear', tel, vendedora, fecha, error: r.error });
                }
              }
            }
          }
        }
        return json(res, 200, { dryRun, total: acciones.length, acciones });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/admin/asignar-disenadores-pendientes ──
  // Recorre pedidos en 'hacer-diseno' SIN diseñador asignado y aplica la regla:
  //   vendedora-diseñadora (Ney/Wendy/Paola) -> ella misma
  //   resto -> Oscar (diseñador full-time)
  // Pasarle ?dryRun=1 para ver que tomaria sin escribir.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/asignar-disenadores-pendientes')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const dryRun = u.searchParams.get('dryRun') === '1';
      const pedidos = leerPedidos();
      const asignaciones = [];
      let cambios = 0;
      for (const p of pedidos) {
        if (p.estado !== 'hacer-diseno') continue;
        if (p.disenadorAsignado) continue;
        const vendedora = p.vendedora || '';
        const disenador = asignarDisenadorAutomatico(vendedora);
        asignaciones.push({ pedidoId: p.id, equipo: p.equipo, vendedora, disenadorAsignado: disenador });
        if (!dryRun) {
          p.disenadorAsignado = disenador;
          p.ultimoMovimiento = new Date().toISOString();
          p.historial = p.historial || [];
          p.historial.push({
            fecha: new Date().toISOString(),
            por: 'asignador-automatico',
            accion: 'asignar-disenador',
            nota: `Asignado a ${disenador} (vendedora=${vendedora})`,
          });
          cambios++;
        }
      }
      if (!dryRun && cambios > 0) guardarPedidos(pedidos, leerNextId());
      return json(res, 200, { dryRun, total: asignaciones.length, cambios, asignaciones });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/sticker-audit — cruza cada sticker fromMe + hash correcto con su pedido ──
  // Para diagnosticar el reporte de Paola: dice que mandó stickers el 27-28 pero no se crearon pedidos.
  // ── GET /api/admin/probar-catalogo?dias=14 ──
  // Ejecuta el watcher CATALOGO en MODO SOLO ANALISIS.
  // Recursivo por todas las subcarpetas + cruce hash con docs salientes.
  // NO modifica nada. Para verificar antes de cron real.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/probar-catalogo')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const diasAtras = parseInt(u.searchParams.get('dias') || '14', 10);
      const pedidos = leerPedidos();
      const reporte = await catalogoFotosWatcher.analizarCatalogo({ db, pedidos, diasAtras });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── GET /api/admin/probar-watcher?limit=50&dias=7&conImagen=1 ──
  // Ejecuta el watcher del grupo "Ventas Ney, Wendy y Paola" en MODO SOLO ANALISIS.
  // Incluye hash matching: cruza foto del grupo con docs_salientes_wa.
  // Devuelve reporte JSON. NO modifica ningun pedido.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/probar-watcher')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const limit = parseInt(u.searchParams.get('limit') || '50', 10);
      const diasAtras = parseInt(u.searchParams.get('dias') || '7', 10);
      const conImagen = u.searchParams.get('conImagen') !== '0';
      const pedidos = leerPedidos();
      const reporte = await grupoVentasWatcher.analizarMensajesGrupo({ db, limit, diasAtras, conImagen, pedidos });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/marcar-equipos-vienen-de-bot ──
  // Para pedidos historicos: marca equipoVieneDeBot=true cuando el equipo
  // no ha sido amarrado por el watcher ni viene de fuente confiable.
  // Permite al watcher reemplazar pushName por nombre real del equipo.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/marcar-equipos-vienen-de-bot')) {
    try {
      const peds = leerPedidos();
      let actualizados = 0;
      const detalle = [];
      for (const p of peds) {
        // Saltar si ya tiene bandera o ya fue amarrado por el watcher
        if (p.equipoVieneDeBot === true) continue;
        if (p.equipoAmarradoDeGrupo === true) continue;
        // Saltar pedidos sin equipo (nada que marcar)
        if (!p.equipo || !String(p.equipo).trim()) continue;
        // Marcar
        p.equipoVieneDeBot = true;
        p.pushNameCliente = p.pushNameCliente || p.equipo;
        p.ultimoMovimiento = new Date().toISOString();
        db.upsertPedido(p);
        actualizados++;
        detalle.push({ id: p.id, vendedora: p.vendedora, equipo: p.equipo });
      }
      return json(res, 200, { ok: true, actualizados, detalle });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/fix-disenadores-faltantes ──
  // Recorre pedidos sin disenadorAsignado y aplica asignarDisenadorAutomatico
  // (Wendy/Ney/Paola -> ellas mismas, otras -> Oscar).
  if (req.method === 'POST' && req.url.startsWith('/api/admin/fix-disenadores-faltantes')) {
    try {
      const peds = leerPedidos();
      let actualizados = 0;
      const detalle = [];
      for (const p of peds) {
        if (p.disenadorAsignado) continue;
        const disenador = asignarDisenadorAutomatico(p.vendedora);
        p.disenadorAsignado = disenador;
        p.ultimoMovimiento = new Date().toISOString();
        db.upsertPedido(p);
        actualizados++;
        detalle.push({ id: p.id, vendedora: p.vendedora, disenadorAsignado: disenador });
      }
      return json(res, 200, { ok: true, actualizados, detalle });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/probar-watcher-trabajo?dias=3 ──
  // Lee mensajes del grupo Trabajo en familia, parsea con Gemini, reporta.
  // NO modifica pedidos.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/probar-watcher-trabajo')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const diasAtras = parseInt(u.searchParams.get('dias') || '3', 10);
      const limit = parseInt(u.searchParams.get('limit') || '60', 10);
      const reporte = await grupoTrabajoFamiliaWatcher.analizarMensajesTrabajo({ db, limit, diasAtras });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/aplicar-watcher-trabajo?dias=1 ──
  // Ejecuta procesarYAvanzar real: detecta avances (cortado, listo, entregado)
  // y avanza el estado del pedido correspondiente.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/aplicar-watcher-trabajo')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const diasAtras = parseInt(u.searchParams.get('dias') || '1', 10);
      const reporte = await grupoTrabajoFamiliaWatcher.procesarYAvanzar({
        db,
        diasAtras,
        notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
      });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── GET /api/admin/probar-chats?soloId=11 ──
  // Lee chats de pedidos sin nombre real, pasa a Gemini, reporta lo que extrae.
  // NO modifica pedidos.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/probar-chats')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const soloId = u.searchParams.get('soloId') || null;
      const forzar = u.searchParams.get('forzar') === '1';
      const limitePedidos = parseInt(u.searchParams.get('limit') || '20', 10);
      const reporte = await chatReader.analizarChatsPedidosSinNombre({ db, soloId, limitePedidos, forzar });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/aplicar-chats?soloId=11 ──
  // Lee chats + extrae nombres + APLICA al pedido (modifica).
  if (req.method === 'POST' && req.url.startsWith('/api/admin/aplicar-chats')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const soloId = u.searchParams.get('soloId') || null;
      const limitePedidos = parseInt(u.searchParams.get('limit') || '20', 10);
      const reporte = await chatReader.procesarYAmarrarChats({
        db,
        soloId,
        limitePedidos,
        notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
      });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── POST /api/admin/aplicar-watcher-catalogo ──
  // Ejecuta procesarYAmarrar real del CATALOGO: hashea fotos nuevas en Drive
  // y amarra el nombre del archivo al pedido del cliente identificado por hash.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/aplicar-watcher-catalogo')) {
    try {
      const reporte = await catalogoFotosWatcher.procesarYAmarrar({
        db,
        notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
      });
      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── POST /api/admin/aplicar-watcher-ventas?dias=2 ──
  // Ejecuta procesarYAmarrar REAL: identifica pedidos por hash y amarra
  // nombre/fecha/lista jugadores. Detecta arreglos del contacto Lidermeyer.
  // Actualiza state.ultimoTs (cutoff temporal).
  // Bloqueo: si el cron esta corriendo, espera a que termine para no pisar
  // el state.ultimoTs y producir Procesados:0.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/aplicar-watcher-ventas')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const diasAtras = parseInt(u.searchParams.get('dias') || '2', 10);
      const conImagen = u.searchParams.get('conImagen') !== '0';
      const reset = u.searchParams.get('reset') === '1';
      // Espera hasta 60s a que termine el cron en curso (si lo hay)
      const inicioEspera = Date.now();
      while (_cronVentasEjecutando && (Date.now() - inicioEspera) < 60000) {
        await new Promise(r => setTimeout(r, 250));
      }
      if (_cronVentasEjecutando) {
        return json(res, 409, { error: 'cron-ventas en ejecucion, reintenta en 1 min' });
      }
      _cronVentasEjecutando = true;
      let reporte;
      try {
        reporte = await grupoVentasWatcher.procesarYAmarrar({
          db,
          diasAtras,
          conImagen,
          forzarSinState: reset, // si reset=1, ignora state.ultimoTs
          notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
          notificarJefes: typeof notificarJefes === 'function' ? notificarJefes : null,
          registrarArreglo: null,
        });
      } finally {
        _cronVentasEjecutando = false;
      }
      return json(res, 200, reporte);
    } catch (e) {
      _cronVentasEjecutando = false;
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── POST /api/admin/reparar-pedidos-huerfanos ──
  // Recorre TODOS los pedidos activos (no archivados, no finalizados):
  //   1. Asigna disenador a los que no lo tengan
  //   2. Re-amarra PDFs de calandra y correos WT por nombre del equipo,
  //      pushNameCliente, o alias guardado
  //   3. Avanza a enviado-calandra si ambas senales (PDF+WT) estan
  // Devuelve reporte detallado.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/reparar-pedidos-huerfanos')) {
    try {
      const peds = leerPedidos();
      const calandra = (typeof db.leerCalandra === 'function') ? db.leerCalandra() : [];
      const wts = (typeof db.leerWetransfer === 'function') ? db.leerWetransfer() : [];
      const ESTADOS_FINALES = new Set(['enviado-final','archivado','cancelado']);
      const ESTADOS_POST_DISENO = new Set(['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final']);

      const reporte = {
        totalPedidos: peds.length,
        disenadoresAsignados: 0,
        pdfAmarrados: 0,
        wtAmarrados: 0,
        avanzaronACalandra: 0,
        waNombrePedidos: 0,
        detalle: [],
      };
      const pedirNombre = (new URL(req.url, `http://${req.headers.host || 'localhost'}`))
        .searchParams.get('pedirNombre') === '1';

      // Acumula pedidos sin nombre por vendedora para mandar UN solo WA al final
      const pedidosSinNombrePorVend = {};

      // Indices auxiliares para match
      const refsCalandra = calandra.map(r => ({
        ref: (r.equipo || r.archivo || '').trim(),
        archivo: r.archivo || '',
      })).filter(x => x.ref);
      const refsWt = wts.map(r => ({
        ref: (r.equipo || r.archivo || '').trim(),
        archivo: r.archivo || '',
      })).filter(x => x.ref);

      for (const p of peds) {
        if (ESTADOS_FINALES.has(p.estado)) continue;
        const cambios = [];

        // 1) Disenador
        if (!p.disenadorAsignado && p.tipoBandeja === 'pedido') {
          const vendCap = (p.vendedora || '').charAt(0).toUpperCase() + (p.vendedora || '').slice(1).toLowerCase();
          const dis = VENDEDORAS_DISENADORAS.has(vendCap) ? vendCap : DISENADOR_FULL_TIME_DEFAULT;
          p.disenadorAsignado = dis;
          cambios.push(`disenador=${dis}`);
          reporte.disenadoresAsignados++;
        }

        // 2/3) Amarres archivos — solo si aun no esta en post-diseno
        if (!ESTADOS_POST_DISENO.has(p.estado)) {
          const candidatosNombre = [p.equipo, p.pushNameCliente]
            .filter(Boolean)
            .map(s => String(s).trim());

          // PDF Drive
          if (!p.pdfDriveListo) {
            for (const c of candidatosNombre) {
              const hit = refsCalandra.find(rc => nombresCoinciden(c, rc.ref));
              if (hit) {
                p.pdfDriveListo = true;
                p.fechaPdfDrive = new Date().toISOString();
                cambios.push(`pdfDrive(${hit.archivo})`);
                reporte.pdfAmarrados++;
                break;
              }
            }
          }
          // WeTransfer
          if (!p.wtListo) {
            for (const c of candidatosNombre) {
              const hit = refsWt.find(rc => nombresCoinciden(c, rc.ref));
              if (hit) {
                p.wtListo = true;
                p.fechaWt = new Date().toISOString();
                cambios.push(`wt(${hit.archivo})`);
                reporte.wtAmarrados++;
                break;
              }
            }
          }
          // Avanzar si ambos listos
          if (evaluarPasoCalandra(p)) {
            cambios.push('paso-a-calandra');
            reporte.avanzaronACalandra++;
          }
        }

        // 4) Marcar candidato a "pedir nombre" — acumulamos por vendedora
        //    y mandamos UN solo WA al final (anti-spam).
        const seguiraEsperando = p.estado === 'hacer-diseno' && !p.pdfDriveListo && !p.wtListo;
        const nombreSospechoso = (() => {
          if (!p.equipo) return true;
          if (/^cliente\s+\+?\d/i.test(p.equipo)) return true; // "Cliente +57 ..."
          if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(p.equipo)) return true; // emoji
          const palabras = p.equipo.split(/\s+/).filter(w => w.length >= 3);
          return palabras.length <= 2; // 1-2 palabras = probable pushName
        })();
        const necesitaNombre = seguiraEsperando && (p.equipoVieneDeBot === true || nombreSospechoso);
        if (pedirNombre && necesitaNombre && p.vendedora) {
          if (!pedidosSinNombrePorVend[p.vendedora]) pedidosSinNombrePorVend[p.vendedora] = [];
          pedidosSinNombrePorVend[p.vendedora].push(p);
        }

        if (cambios.length) {
          p.ultimoMovimiento = new Date().toISOString();
          reporte.detalle.push({ id: p.id, equipo: p.equipo, vendedora: p.vendedora, cambios });
        }
      }

      // ── 4-final) UN SOLO WA por vendedora con TODOS sus pedidos sin nombre.
      //    Formato igual al "Resumen del día" para que sea consistente.
      //    Dedupe diario por vendedora para evitar reenviar el mismo dia.
      if (pedirNombre) {
        const hoyISO = new Date().toISOString().slice(0, 10);
        for (const [vendedora, lista] of Object.entries(pedidosSinNombrePorVend)) {
          if (!lista.length) continue;
          const dedupeKey = `pide-nombre-resumen:${vendedora}:${hoyISO}`;
          if (typeof waPuedeEnviar === 'function' && !waPuedeEnviar(dedupeKey)) continue;
          let msg = `🏷️ *${vendedora.toUpperCase()} — Pedidos sin nombre del equipo*\n`;
          msg += `─────────────────────────────\n\n`;
          msg += `📦 *TUS PEDIDOS SIN NOMBRE:* ${lista.length}\n\n`;
          lista.forEach(p => {
            const cli = (p.equipo || p.pushNameCliente || '(sin cliente)').toString();
            const tel = p.telefono || '?';
            msg += `  ⚠️ #${p.id} ${cli}\n`;
            msg += `     📞 ${tel}\n\n`;
          });
          msg += `─────────────────────────────\n`;
          msg += `📋 *PREGUNTALE AL CLIENTE:* "¿Cómo se llama tu equipo?"\n\n`;
          msg += `Cuando sepas los nombres, respondeme acá (uno por línea):\n`;
          lista.forEach(p => { msg += `*equipo ${p.id} NOMBRE REAL*\n`; });
          try {
            await notificarWAPersona((vendedora || '').toLowerCase(), msg);
            reporte.waNombrePedidos += lista.length;
          } catch (eW) { console.error('[wa-pide-nombre-resumen]', eW.message); }
        }
      }

      if (reporte.detalle.length) {
        guardarPedidos(peds, leerNextId());
      }

      return json(res, 200, reporte);
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── POST /api/admin/revivir-instancia?name=ws-ney ──
  // Para instancias Evolution que quedan "zombi": connectionState=open
  // pero internamente con disconnectionReason device_removed. Flujo:
  //   1. Lee config actual (webhook + chatwoot)
  //   2. Borra la instancia
  //   3. Crea nueva con mismo nombre
  //   4. Restaura webhook y chatwoot
  //   5. Pide QR
  //   6. Devuelve QR base64 + pairing code
  if (req.method === 'POST' && req.url.startsWith('/api/admin/revivir-instancia')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const name = u.searchParams.get('name');
      if (!name) return json(res, 400, { error: 'falta ?name=ws-ney' });
      const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const KEY = process.env.EVOLUTION_API_KEY || '';
      const headers = { 'Content-Type': 'application/json', apikey: KEY };
      const host = req.headers.host || 'ws-app-interna-production.up.railway.app';
      const webhookUrl = `https://${host}/api/evolution-webhook?token=ws_secret_2026`;
      const pasos = [];

      // 1) Backup config
      let inst = null;
      try {
        const r = await fetch(`${EVO}/instance/fetchInstances?instanceName=${encodeURIComponent(name)}`, { headers });
        const arr = await r.json();
        inst = arr[0] || null;
        pasos.push({ paso: 'backup', ok: !!inst, profileName: inst?.profileName || null, chatwoot: !!inst?.Chatwoot });
      } catch (e) { pasos.push({ paso: 'backup', ok: false, error: e.message }); }

      // 2) Logout + Delete
      try {
        await fetch(`${EVO}/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE', headers });
      } catch (e) {}
      try {
        const r = await fetch(`${EVO}/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE', headers });
        const body = await r.text();
        pasos.push({ paso: 'delete', status: r.status, body: body.slice(0, 200) });
      } catch (e) { pasos.push({ paso: 'delete', error: e.message }); }

      // 3) Create (con webhook integrado)
      try {
        const createBody = {
          instanceName: name,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          webhook: {
            url: webhookUrl,
            byEvents: false,
            base64: false,
            events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT', 'CHATS_UPSERT'],
          },
        };
        const r = await fetch(`${EVO}/instance/create`, { method: 'POST', headers, body: JSON.stringify(createBody) });
        const data = await r.json();
        pasos.push({ paso: 'create', status: r.status, hash: !!data?.hash, qrcode: !!data?.qrcode?.base64 });
        // Si trae QR de una, ya lo devolvemos
        if (r.ok && data?.qrcode?.base64) {
          return json(res, 200, {
            ok: true,
            instancia: name,
            qrBase64: data.qrcode.base64,
            qrPairingCode: data.qrcode.pairingCode || null,
            pasos,
            webhookSeteado: webhookUrl,
            siguiente: 'Compartir QR con Ney para que escanee desde WhatsApp → Configuracion → Dispositivos vinculados',
          });
        }
      } catch (e) { pasos.push({ paso: 'create', error: e.message }); }

      // 4) Si no vino QR en create, pedirlo
      try {
        const r = await fetch(`${EVO}/instance/connect/${encodeURIComponent(name)}`, { headers });
        const data = await r.json();
        return json(res, 200, {
          ok: r.ok,
          instancia: name,
          qrBase64: data?.base64 || data?.qrcode?.base64 || null,
          qrPairingCode: data?.pairingCode || data?.qrcode?.pairingCode || null,
          rawConnect: data,
          pasos,
          webhookSeteado: webhookUrl,
        });
      } catch (e) {
        pasos.push({ paso: 'connect', error: e.message });
        return json(res, 500, { error: 'No se pudo obtener QR', pasos });
      }
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── GET /api/admin/qr/:name — HTML simple con el QR para escanear ──
  // Llama directo a Evolution /instance/connect/{name} y muestra el QR.
  // Si la instancia no existe, devuelve mensaje claro.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/qr/')) {
    try {
      const name = req.url.split('/').pop().split('?')[0];
      const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const KEY = process.env.EVOLUTION_API_KEY || '';
      let data = {};
      try {
        const r = await fetch(`${EVO}/instance/connect/${encodeURIComponent(name)}`, { headers: { apikey: KEY } });
        data = await r.json();
      } catch (e) { data = { error: e.message }; }
      // Estructura puede venir en data.qrcode.base64 o data.base64 directo
      data.qrBase64 = data?.base64 || data?.qrcode?.base64 || data?.qr?.base64 || null;
      data.qrPairingCode = data?.pairingCode || data?.qrcode?.pairingCode || null;
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const qr = data.qrBase64 || '';
      const pc = data.qrPairingCode || '';
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR ${name}</title>
<style>body{font-family:system-ui;background:#0f1117;color:#fff;text-align:center;padding:24px}
.qr{background:#fff;padding:16px;border-radius:16px;display:inline-block;max-width:340px;margin:16px}
.code{font-size:1.8em;letter-spacing:8px;color:#7c3aed;font-weight:900;margin:12px}
.btn{background:#7c3aed;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;display:inline-block;margin-top:14px}
ol{text-align:left;max-width:480px;margin:18px auto}</style></head>
<body><h2>Reconectar ${name}</h2>
${qr ? `<div class="qr"><img src="${qr.startsWith('data:')?qr:'data:image/png;base64,'+qr}" style="width:100%"/></div>` : '<p>No vino QR de Evolution. Reintenta el endpoint.</p>'}
${pc ? `<div class="code">${pc}</div><p>Pairing code (escribe este código en WhatsApp → Dispositivos vinculados → Vincular con código)</p>` : ''}
<ol><li>En el celular de Ney abrir WhatsApp</li>
<li>Ir a <b>Ajustes → Dispositivos vinculados → Vincular dispositivo</b></li>
<li>Escanear el QR o escribir el código</li>
<li>Esperar a que aparezca "conectado"</li></ol>
<a class="btn" href="javascript:location.reload()">Refrescar (regenerar QR)</a>
<pre style="text-align:left;font-size:11px;color:#666;margin-top:30px">${JSON.stringify({state:data?.instance?.state||null,error:data.error||null},null,2)}</pre>
</body></html>`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + e.message);
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // VIGILANTE W&S — endpoint /api/agente-actividad
  // Recibe snapshots cada 30s con:
  //   - programasActivos (corel, photoshop, illustrator, chrome, whatsapp)
  //   - archivosAbiertos (qué .cdr/.psd/.ai está editando)
  //   - chatsWhatsApp (qué cliente está conversando)
  //   - weTransfer.minutosAbierto (cuánto lleva en wetransfer.com)
  //   - corelActivo.tiempoActivoMin (tiempo en el mismo archivo)
  //
  // Genera AVANCES auto:
  //   - archivo Corel abierto + chat WhatsApp con teléfono → auto-vincula
  //   - WeTransfer abierto +2min → marca "WT en proceso" en pedido activo
  //   - Corel abierto +1h en mismo archivo → marca "en edición intensa"
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/agente-actividad') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const snap = JSON.parse(body || '{}');
        const { pc, programasActivos = [], archivosAbiertos = [], chatsWhatsApp = [], weTransfer = {}, corelActivo = null, ts } = snap;
        if (!pc) return json(res, 400, { error: 'falta pc' });

        const peds = leerPedidos();
        const ESTADOS_FINALES = new Set(['enviado-final','archivado','cancelado']);
        let cambios = 0;

        // ── 1. AUTO-MATCH POR CONTEXTO (archivo Corel + chat WhatsApp) ──
        if (corelActivo && corelActivo.archivo && chatsWhatsApp.length > 0) {
          const archivoSinExt = corelActivo.archivo.replace(/\.[^.]+$/, '').trim();
          for (const chat of chatsWhatsApp) {
            if (!chat.telefono) continue;
            // Pedido del cliente con ese teléfono?
            const telLimpio = chat.telefono.replace(/\D/g, '');
            const pedidoCliente = peds.find(p => {
              if (ESTADOS_FINALES.has(p.estado)) return false;
              const pTel = String(p.telefono || '').replace(/\D/g, '');
              return pTel === telLimpio || pTel.endsWith(telLimpio) || telLimpio.endsWith(pTel);
            });
            if (!pedidoCliente) continue;
            // Aprende el alias archivo→pedido
            if (!Array.isArray(pedidoCliente.archivosAlias)) pedidoCliente.archivosAlias = [];
            const aliasLimpio = nombreLimpio(archivoSinExt);
            if (aliasLimpio && !pedidoCliente.archivosAlias.includes(aliasLimpio)) {
              pedidoCliente.archivosAlias.push(aliasLimpio);
              cambios++;
            }
            // Marca disenador real + iniciado
            if (!pedidoCliente.disenoIniciado) {
              pedidoCliente.disenoIniciado = true;
              pedidoCliente.fechaDisenoIniciado = ts || new Date().toISOString();
              cambios++;
            }
            if (!pedidoCliente.disenadorReal) {
              pedidoCliente.disenadorReal = pc;
              cambios++;
            }
            // Marca activamente en edicion
            pedidoCliente.enEdicionActiva = {
              pc,
              archivo: corelActivo.archivo,
              chatActivo: chat.chat,
              tiempoActivoMin: corelActivo.tiempoActivoMin || 0,
              actualizado: new Date().toISOString(),
            };
            cambios++;
            console.log(`[actividad] auto-match #${pedidoCliente.id} (${chat.nombre||chat.telefono}) <- ${corelActivo.archivo} en PC ${pc}`);
          }
        }

        // ── 2. WeTransfer +2min abierto → marcar WT en proceso en pedidos activos del PC ──
        if (weTransfer.abierto && (weTransfer.minutosAbierto || 0) >= 2) {
          // Pedidos en hacer-diseno/confirmado del disenador (PC) que no tengan wtListo
          const pedidosWTEnProceso = peds.filter(p => {
            if (ESTADOS_FINALES.has(p.estado)) return false;
            if (p.wtListo) return false;
            if (p.disenadorReal !== pc) return false;
            return p.estado === 'hacer-diseno' || p.estado === 'confirmado';
          });
          if (pedidosWTEnProceso.length === 1) {
            const p = pedidosWTEnProceso[0];
            if (!p.wtEnProceso) {
              p.wtEnProceso = { pc, desde: ts || new Date().toISOString() };
              cambios++;
              console.log(`[actividad] WT en proceso #${p.id} (PC ${pc})`);
            }
          }
        }

        // ── 3. Persistir snapshot por PC (para dashboard "que pasa AHORA") ──
        try {
          const snapsPath = path.join(__dirname, 'data', 'pcs-vivos.json');
          let snaps = {};
          try { snaps = JSON.parse(fs.readFileSync(snapsPath, 'utf8')); } catch {}
          snaps[pc] = {
            ts: ts || new Date().toISOString(),
            recibidoEn: new Date().toISOString(),
            programasActivos,
            archivosAbiertos,
            chatsWhatsApp,
            weTransfer,
            corelActivo,
            foco: snap.foco || null,
            idleSeg: snap.idleSeg ?? null,
            enUso: snap.enUso ?? null,
            uptimeMin: snap.uptimeMin ?? null,
            usbs: snap.usbs || null,
            programasNoLaborales: snap.programasNoLaborales || [],
            tiempoHoyMin: snap.tiempoHoyMin || null,
            dia: snap.dia || null,
            hostname: snap.hostname || null,
            vigilanteVersion: snap.vigilanteVersion || null,
          };
          fs.writeFileSync(snapsPath, JSON.stringify(snaps, null, 2));
        } catch (e) {
          console.error('[actividad] no guardo pcs-vivos:', e.message);
        }

        if (cambios > 0) {
          guardarPedidos(peds, leerNextId());
        }

        return json(res, 200, { ok: true, cambios, pc });
      } catch (e) {
        console.error('[agente-actividad]', e.message);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }


  // ═══════════════════════════════════════════════════════════════════
  // DEBUG: ver el chat completo de Chatwoot de un pedido + imagenes
  // GET /api/admin/ver-chat-pedido?id=2
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.startsWith('/api/admin/ver-chat-pedido')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });
      if (!p.telefono) return json(res, 200, { pedido: { id: p.id, equipo: p.equipo, telefono: null }, error: 'pedido sin telefono' });

      const contacto = await buscarContactoChatwoot(p.telefono);
      if (!contacto?.id) {
        return json(res, 200, { pedido: { id: p.id, equipo: p.equipo, telefono: p.telefono }, error: 'no encontre contacto en chatwoot' });
      }
      const url = process.env.CHATWOOT_URL;
      const accountId = process.env.CHATWOOT_ACCOUNT_ID;
      const apiKey = process.env.CHATWOOT_API_KEY;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const rConv = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, {
        headers: { 'api_access_token': apiKey },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const dataConv = await rConv.json();
      const convs = dataConv.payload || [];
      const conv = convs[0];
      if (!conv?.id) return json(res, 200, { pedido: { id: p.id, equipo: p.equipo }, contacto: contacto.id, error: 'sin conversacion' });

      // Mensajes completos con attachments
      const rMsg = await fetch(`${url}/api/v1/accounts/${accountId}/conversations/${conv.id}/messages`, {
        headers: { 'api_access_token': apiKey },
      });
      const dataMsg = await rMsg.json();
      const mensajes = (dataMsg.payload || dataMsg || []).map(m => ({
        id: m.id,
        sender_type: m.sender_type || (m.message_type === 0 ? 'Contact' : 'Agent'),
        message_type: m.message_type, // 0=incoming (cliente), 1=outgoing (vendedora)
        content: m.content || '',
        created_at: m.created_at,
        attachments: (m.attachments || []).map(a => ({
          id: a.id,
          file_type: a.file_type,
          data_url: a.data_url,
          thumb_url: a.thumb_url,
        })),
      }));
      const conImagenes = mensajes.filter(m => m.attachments.some(a => a.file_type === 'image'));
      const conAudio = mensajes.filter(m => m.attachments.some(a => a.file_type === 'audio'));
      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, telefono: p.telefono, vendedora: p.vendedora, estado: p.estado },
        contactoId: contacto.id,
        convId: conv.id,
        chatwootUrl: `${url}/app/accounts/${accountId}/conversations/${conv.id}`,
        totalMensajes: mensajes.length,
        mensajesConImagen: conImagenes.length,
        mensajesConAudio: conAudio.length,
        mensajes: mensajes.slice(-40),
        imagenes: conImagenes.map(m => ({
          fecha: m.created_at,
          quien: m.sender_type,
          texto: m.content,
          urls: m.attachments.filter(a => a.file_type === 'image').map(a => a.data_url),
        })),
        audios: conAudio.map(m => ({
          fecha: m.created_at,
          quien: m.sender_type,
          texto: m.content,
          urls: m.attachments.filter(a => a.file_type === 'audio').map(a => a.data_url),
        })),
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ANALISIS COMPLETO con Gemini multimedia: texto + imagenes + audios
  // GET /api/admin/analizar-chat-completo?id=X&limit=30
  // Descarga TODOS los attachments de Chatwoot y los pasa a Gemini para
  // determinar el estado REAL del pedido, sin enviar ningun WA.
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.startsWith('/api/admin/analizar-chat-completo')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '40', 10), 80);
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });
      if (!p.telefono) return json(res, 200, { error: 'pedido sin telefono', pedido: { id: p.id, equipo: p.equipo } });

      const contacto = await buscarContactoChatwoot(p.telefono);
      if (!contacto?.id) return json(res, 200, { error: 'sin contacto chatwoot', pedido: { id: p.id, equipo: p.equipo, telefono: p.telefono } });
      const url = process.env.CHATWOOT_URL;
      const accountId = process.env.CHATWOOT_ACCOUNT_ID;
      const apiKey = process.env.CHATWOOT_API_KEY;
      const rConv = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, {
        headers: { 'api_access_token': apiKey },
      });
      const dataConv = await rConv.json();
      const conv = (dataConv.payload || [])[0];
      if (!conv?.id) return json(res, 200, { error: 'sin conversacion', pedido: { id: p.id, equipo: p.equipo } });
      const rMsg = await fetch(`${url}/api/v1/accounts/${accountId}/conversations/${conv.id}/messages`, {
        headers: { 'api_access_token': apiKey },
      });
      const dataMsg = await rMsg.json();
      const todosMensajes = dataMsg.payload || dataMsg || [];
      // Tomar los ultimos N
      const recientes = todosMensajes.slice(-limit);

      // Convertir a estructura {quien, texto, fecha, attachments}
      // y descargar cada attachment (max 10 img + 8 audio) a base64
      const mensajesEnriquecidos = [];
      let imgsTotal = 0, audsTotal = 0;
      const MAX_IMG_TOTAL = 10, MAX_AUDIO_TOTAL = 8;
      for (const m of recientes) {
        const quien = (m.message_type === 0) ? 'cliente' : 'vendedora';
        const fecha = m.created_at ? (new Date(m.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' })) : '';
        const adj = [];
        for (const a of (m.attachments || [])) {
          if (a.file_type === 'image' && imgsTotal < MAX_IMG_TOTAL) {
            const dl = await descargarAttachmentChatwootBase64(a.data_url);
            if (dl) { adj.push({ ...dl, kind: 'image' }); imgsTotal++; }
          } else if (a.file_type === 'audio' && audsTotal < MAX_AUDIO_TOTAL) {
            const dl = await descargarAttachmentChatwootBase64(a.data_url);
            if (dl) { adj.push({ ...dl, kind: 'audio' }); audsTotal++; }
          }
        }
        mensajesEnriquecidos.push({
          quien,
          fecha,
          texto: (m.content || '').slice(0, 600),
          attachments: adj,
        });
      }

      const analisisGemini = await analizarChatMultimediaConGemini(mensajesEnriquecidos, p.equipo);

      // ESCALADO A CLAUDE SONNET cuando:
      // - Gemini detecto >= 2 pedidos en el chat, O
      // - Gemini con confianza media/baja, O
      // - parametro ?forzar=claude en la URL
      const forzarClaude = u.searchParams.get('forzar') === 'claude';
      const pedidosDetectados = parseInt(analisisGemini?.pedidosDetectados || 0, 10);
      const confianzaGemini = (analisisGemini?.confianza || '').toLowerCase();
      const necesitaEscalado = forzarClaude
        || pedidosDetectados >= 2
        || confianzaGemini === 'media'
        || confianzaGemini === 'baja';

      let veredictoClaude = null;
      let motivoEscalado = null;
      if (necesitaEscalado && process.env.ANTHROPIC_API_KEY) {
        motivoEscalado = forzarClaude ? 'forzado por parametro'
          : pedidosDetectados >= 2 ? `multiples pedidos detectados (${pedidosDetectados})`
          : `confianza Gemini ${confianzaGemini}`;
        veredictoClaude = await analizarChatConClaude(mensajesEnriquecidos, {
          id: p.id, equipo: p.equipo, vendedora: p.vendedora, estado: p.estado, abonado: p.abonado || 0,
        }, analisisGemini);
      }

      // Resumen rapido para el usuario (sin base64 ruidoso)
      const mensajesResumen = mensajesEnriquecidos.map(m => ({
        quien: m.quien,
        fecha: m.fecha,
        texto: m.texto,
        adjuntos: m.attachments.map(a => `${a.kind}(${a.mime}, ${a.kb}KB)`),
      }));

      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, telefono: p.telefono, vendedora: p.vendedora, estado: p.estado, abonado: p.abonado || 0 },
        chatwootUrl: `${url}/app/accounts/${accountId}/conversations/${conv.id}`,
        descargadas: { imagenes: imgsTotal, audios: audsTotal, mensajesAnalizados: mensajesEnriquecidos.length },
        analisisGemini,
        escalado: { necesario: necesitaEscalado, motivo: motivoEscalado },
        veredictoClaude,
        veredictoFinal: veredictoClaude?.estadoVeredicto || analisisGemini?.estadoReal || 'desconocido',
        cronologia: mensajesResumen,
        errorGemini: global._geminiUltimoError || null,
        errorClaude: global._claudeUltimoError || null,
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/admin/verificar-detector-ventas?limit=8&dias=15
  // Toma los ULTIMOS N pedidos confirmados/activos del ERP (= ground truth:
  // sabemos que SI son ventas) y por cada uno corre iaDetectarVentaEnChat.
  // Si la IA acierta en la mayoria, el detector es confiable y se puede
  // integrar al handler de etiquetas WA.
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.startsWith('/api/admin/verificar-detector-ventas')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '8', 10), 20);
      const dias = Math.max(1, parseInt(u.searchParams.get('dias') || '15', 10));
      const limiteMs = Date.now() - dias * 86400 * 1000;

      const peds = leerPedidos();
      const ESTADOS_OK = new Set(['confirmado','aprobado','hacer-diseno','tela-recibida','calandra','corte','costura','enviado-calandra','llego-impresion']);
      const candidatos = peds
        .filter(p => ESTADOS_OK.has(p.estado))
        .filter(p => p.telefono && String(p.telefono).replace(/\D/g,'').length >= 8)
        .filter(p => p.ultimoMovimiento && new Date(p.ultimoMovimiento).getTime() >= limiteMs)
        .sort((a,b) => new Date(b.ultimoMovimiento).getTime() - new Date(a.ultimoMovimiento).getTime())
        .slice(0, limit);

      if (candidatos.length === 0) {
        return json(res, 200, { ok: true, total: 0, mensaje: 'no hay pedidos confirmados recientes para probar' });
      }

      const cwUrl = process.env.CHATWOOT_URL;
      const accountId = process.env.CHATWOOT_ACCOUNT_ID;
      const cwApiKey = process.env.CHATWOOT_API_KEY;
      const resultados = [];

      for (const p of candidatos) {
        try {
          const tel = String(p.telefono).replace(/\D/g,'');
          const contacto = await buscarContactoChatwoot(tel);
          if (!contacto?.id) {
            resultados.push({ id: p.id, equipo: p.equipo, vendedora: p.vendedora, tel, error: 'sin contacto chatwoot', acierto: null });
            continue;
          }
          const rConv = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, { headers: { 'api_access_token': cwApiKey } });
          const dataConv = await rConv.json();
          const conv = (dataConv.payload || [])[0];
          if (!conv?.id) {
            resultados.push({ id: p.id, equipo: p.equipo, vendedora: p.vendedora, tel, error: 'sin conv chatwoot', acierto: null });
            continue;
          }
          const rMsg = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations/${conv.id}/messages`, { headers: { 'api_access_token': cwApiKey } });
          const dataMsg = await rMsg.json();
          const todos = dataMsg.payload || dataMsg || [];
          const recientes = todos.slice(-60);

          const mEnr = [];
          let imgs=0, auds=0;
          for (const m of recientes) {
            const adj = [];
            for (const a of (m.attachments || [])) {
              if (a.file_type === 'image' && imgs < 8) {
                const dl = await descargarAttachmentChatwootBase64(a.data_url);
                if (dl) { adj.push({ ...dl, kind: 'image' }); imgs++; }
              } else if (a.file_type === 'audio' && auds < 3) {
                const dl = await descargarAttachmentChatwootBase64(a.data_url);
                if (dl) { adj.push({ ...dl, kind: 'audio' }); auds++; }
              }
            }
            mEnr.push({
              quien: m.message_type === 0 ? 'cliente' : 'vendedora',
              fecha: m.created_at ? new Date(m.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : '',
              texto: (m.content || '').slice(0, 400),
              attachments: adj,
            });
          }

          const ver = await iaDetectarVentaEnChat(mEnr, { telefono: tel, vendedora: p.vendedora });
          resultados.push({
            id: p.id,
            equipo: p.equipo,
            vendedora: p.vendedora,
            tel,
            estado_erp: p.estado,
            ia_dice_venta: ver?.hayVenta,
            confianza: ver?.confianza,
            evidencia: ver?.evidencia,
            razon: ver?.razon,
            acierto: ver?.hayVenta === true,
            mensajes_analizados: mEnr.length,
            imgs_audios: { imgs, auds },
            chatwoot_url: `${cwUrl}/app/accounts/${accountId}/conversations/${conv.id}`,
          });
        } catch (eRow) {
          resultados.push({ id: p.id, equipo: p.equipo, error: eRow.message, acierto: null });
        }
      }

      const aciertos = resultados.filter(r => r.acierto === true).length;
      const fallos = resultados.filter(r => r.acierto === false).length;
      const noProcesados = resultados.filter(r => r.acierto === null).length;
      const tasaAcierto = (resultados.length - noProcesados) > 0
        ? Math.round(100 * aciertos / (resultados.length - noProcesados))
        : 0;

      return json(res, 200, {
        ok: true,
        total_pedidos_probados: resultados.length,
        ground_truth: 'pedidos confirmados/activos del ERP (deberian ser TODOS ventas)',
        aciertos_ia: aciertos,
        fallos_ia: fallos,
        sin_chatwoot: noProcesados,
        tasa_acierto_porcentaje: tasaAcierto,
        nota: tasaAcierto >= 80 ? 'IA confiable, listo para integrar al handler' : (tasaAcierto >= 60 ? 'IA aceptable, revisar fallos antes de integrar' : 'IA NO confiable todavia, revisar prompt'),
        resultados,
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/admin/test-deteccion-venta?telefono=573XXX&vendedora=Wendy&etiqueta=CONSIGNADO
  // Toma los ultimos mensajes del chat (Chatwoot), descarga imagenes y audios,
  // y manda a Gemini con prompt especifico de "hay venta?".
  // No escribe nada. Devuelve veredicto + URL chatwoot para verificar manual.
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.startsWith('/api/admin/test-deteccion-venta')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const telefono = (u.searchParams.get('telefono') || '').replace(/\D/g, '');
      const vendedora = u.searchParams.get('vendedora') || '';
      const etiquetaTrigger = u.searchParams.get('etiqueta') || '';
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '30', 10), 50);
      if (!telefono || telefono.length < 8) {
        return json(res, 400, { error: 'falta telefono valido' });
      }

      const contacto = await buscarContactoChatwoot(telefono);
      if (!contacto?.id) return json(res, 200, { error: 'sin contacto chatwoot', telefono });

      const cwUrl = process.env.CHATWOOT_URL;
      const accountId = process.env.CHATWOOT_ACCOUNT_ID;
      const cwApiKey = process.env.CHATWOOT_API_KEY;
      const rConv = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, {
        headers: { 'api_access_token': cwApiKey },
      });
      const dataConv = await rConv.json();
      const conv = (dataConv.payload || [])[0];
      if (!conv?.id) return json(res, 200, { error: 'sin conversacion', telefono });
      const rMsg = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations/${conv.id}/messages`, {
        headers: { 'api_access_token': cwApiKey },
      });
      const dataMsg = await rMsg.json();
      const todosMensajes = dataMsg.payload || dataMsg || [];
      const recientes = todosMensajes.slice(-limit);

      const mensajesEnriquecidos = [];
      let imgsTotal = 0, audsTotal = 0;
      const MAX_IMG_TOTAL = 8, MAX_AUDIO_TOTAL = 4;
      for (const m of recientes) {
        const quien = (m.message_type === 0) ? 'cliente' : 'vendedora';
        const fecha = m.created_at ? (new Date(m.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' })) : '';
        const adj = [];
        for (const a of (m.attachments || [])) {
          if (a.file_type === 'image' && imgsTotal < MAX_IMG_TOTAL) {
            const dl = await descargarAttachmentChatwootBase64(a.data_url);
            if (dl) { adj.push({ ...dl, kind: 'image' }); imgsTotal++; }
          } else if (a.file_type === 'audio' && audsTotal < MAX_AUDIO_TOTAL) {
            const dl = await descargarAttachmentChatwootBase64(a.data_url);
            if (dl) { adj.push({ ...dl, kind: 'audio' }); audsTotal++; }
          }
        }
        mensajesEnriquecidos.push({
          quien, fecha, texto: (m.content || '').slice(0, 600), attachments: adj,
        });
      }

      const veredicto = await iaDetectarVentaEnChat(mensajesEnriquecidos, {
        telefono, vendedora, etiquetaTrigger,
      });

      const mensajesResumen = mensajesEnriquecidos.map(m => ({
        quien: m.quien,
        fecha: m.fecha,
        texto: m.texto,
        adjuntos: m.attachments.map(a => `${a.kind}(${a.mime}, ${a.kb}KB)`),
      }));

      return json(res, 200, {
        ok: true,
        telefono,
        vendedora,
        etiqueta_trigger: etiquetaTrigger,
        chatwoot_url: `${cwUrl}/app/accounts/${accountId}/conversations/${conv.id}`,
        mensajes_analizados: mensajesEnriquecidos.length,
        adjuntos_descargados: { imagenes: imgsTotal, audios: audsTotal },
        veredicto,
        cronologia: mensajesResumen,
        errorGemini: global._geminiUltimoError || null,
        errorClaude: global._claudeUltimoError || null,
        anthropicKeyPresente: !!process.env.ANTHROPIC_API_KEY,
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPARACION VISUAL: imagen aprobada en Chatwoot vs PDFs RIP en Drive
  // GET /api/admin/comparar-aprobacion-vs-pdf?id=X
  // Confirma DOBLE si el pedido esta realmente en produccion.
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.startsWith('/api/admin/comparar-aprobacion-vs-pdf')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });
      if (!p.telefono) return json(res, 200, { error: 'pedido sin telefono' });

      // 1) Traer ultima imagen aprobada de Chatwoot (la ultima imagen que mando la VENDEDORA al cliente)
      const contacto = await buscarContactoChatwoot(p.telefono);
      if (!contacto?.id) return json(res, 200, { error: 'sin contacto chatwoot' });
      const urlCw = process.env.CHATWOOT_URL;
      const accId = process.env.CHATWOOT_ACCOUNT_ID;
      const apiCw = process.env.CHATWOOT_API_KEY;
      const rConv = await fetch(`${urlCw}/api/v1/accounts/${accId}/contacts/${contacto.id}/conversations`, {
        headers: { 'api_access_token': apiCw },
      });
      const dataConv = await rConv.json();
      const conv = (dataConv.payload || [])[0];
      if (!conv?.id) return json(res, 200, { error: 'sin conversacion' });
      // Paginar HACIA ATRAS hasta 5 lotes (~100 mensajes) buscando imagen.
      let todosMensajes = [];
      let ultimoIdLoteAnterior = null;
      let lotesObtenidos = 0;
      for (let pag = 0; pag < 5; pag++) {
        const urlPag = ultimoIdLoteAnterior
          ? `${urlCw}/api/v1/accounts/${accId}/conversations/${conv.id}/messages?before=${ultimoIdLoteAnterior}`
          : `${urlCw}/api/v1/accounts/${accId}/conversations/${conv.id}/messages`;
        try {
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
          const rM = await fetch(urlPag, { headers: { 'api_access_token': apiCw }, signal: ctrl.signal }).finally(() => clearTimeout(t));
          if (!rM.ok) break;
          const dM = await rM.json();
          const lote = dM.payload || dM || [];
          if (lote.length === 0) break;
          lotesObtenidos++;
          todosMensajes = [...lote, ...todosMensajes];
          // Si ya hay imagen, frenar
          if (lote.some(m => (m.attachments || []).some(a => a.file_type === 'image'))) break;
          // Si la API NO soporta before, el lote sera identico y entraremos en loop — detectar:
          if (lote[0]?.id && lote[0].id === ultimoIdLoteAnterior) break;
          ultimoIdLoteAnterior = lote[0]?.id;
          if (!ultimoIdLoteAnterior) break;
        } catch (e) { console.error('[comparar pag]', e.message); break; }
      }

      // Buscar TODAS las imagenes del chat (de la vendedora primero).
      // Clasificar cada una con Gemini → solo usar la que sea DISEÑO de uniforme.
      let imgChatBase64 = null, imgChatMime = null, imgChatFecha = null, imgChatQuien = null;
      const imagenesProbadas = [];
      const todasLasImgs = [];
      // Recolectar todas las imagenes (vendedora primero, luego cliente)
      for (let i = todosMensajes.length - 1; i >= 0; i--) {
        const m = todosMensajes[i];
        const quien = m.message_type === 1 ? 'vendedora' : 'cliente';
        const imgAtt = (m.attachments || []).find(a => a.file_type === 'image');
        if (imgAtt) todasLasImgs.push({ msg: m, attachment: imgAtt, quien });
      }
      // Ordenar: vendedora primero, despues cliente. Dentro de cada grupo, de mas reciente a mas viejo.
      todasLasImgs.sort((a, b) => {
        if (a.quien !== b.quien) return a.quien === 'vendedora' ? -1 : 1;
        return (b.msg.created_at || 0) - (a.msg.created_at || 0);
      });
      // Probar cada imagen hasta encontrar un DISEÑO (max 6 intentos para no gastar mucho)
      for (const cand of todasLasImgs.slice(0, 6)) {
        const dl = await descargarAttachmentChatwootBase64(cand.attachment.data_url);
        if (!dl) continue;
        const clasif = await clasificarImagenConGemini(dl.base64, dl.mime);
        const fecha = cand.msg.created_at ? new Date(cand.msg.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : null;
        imagenesProbadas.push({ fecha, quien: cand.quien, clasificacion: clasif?.tipo, confianza: clasif?.confianza });
        if (clasif?.tipo === 'diseno-uniforme') {
          imgChatBase64 = dl.base64;
          imgChatMime = dl.mime;
          imgChatFecha = fecha;
          imgChatQuien = cand.quien;
          break;
        }
      }

      if (!imgChatBase64) {
        const fechas = todosMensajes.map(m => m.created_at).filter(Boolean);
        const minFecha = fechas.length ? new Date(Math.min(...fechas)*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null;
        const maxFecha = fechas.length ? new Date(Math.max(...fechas)*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null;
        const attsTipos = todosMensajes.flatMap(m => (m.attachments || []).map(a => a.file_type));
        return json(res, 200, {
          pedido: { id: p.id, equipo: p.equipo, vendedora: p.vendedora, estado: p.estado },
          error: 'ninguna imagen del chat es un diseño de uniforme (solo comprobantes/listas/otros)',
          debug: {
            mensajesAnalizados: todosMensajes.length,
            lotesObtenidos,
            rangoFechas: { desde: minFecha, hasta: maxFecha },
            tiposAttachments: attsTipos,
            imagenesProbadas,
          },
        });
      }

      // 2) Extraer texto/elementos del DISEÑO con Gemini Vision
      // (el nombre del pedido en la app suele NO coincidir con el texto del diseño,
      //  ej: pedido "wigo" pero diseño dice "POR UN BELLO SAN MARTIN")
      const textoDiseno = await extraerTextoDeDisenoConGemini(imgChatBase64, imgChatMime);

      // 3) Listar PDFs RIP en Drive y buscar por: TEXTO del diseño + nombre del pedido (fallback)
      let pdfsCandidatos = [];
      let busquedaDetalles = { textoDiseno, tokensBuscados: [], pdfsMatcheados: [] };
      try {
        const archivos = await driveSync.listarArchivos(driveSync.FOLDER_PDFRIP, 200);
        // SOLO PDFs de los últimos 60 días — los viejos no pueden ser de pedidos activos
        const limiteFecha = Date.now() - (60 * 24 * 60 * 60 * 1000);
        const pdfs = archivos.filter(a => {
          if (!/\.pdf$/i.test(a.name)) return false;
          if (a.modifiedTime || a.createdTime) {
            const ts = new Date(a.modifiedTime || a.createdTime).getTime();
            if (!isNaN(ts) && ts < limiteFecha) return false; // viejo, saltar
          }
          return true;
        });
        busquedaDetalles.pdfsRecienteFiltrados = pdfs.length;
        busquedaDetalles.pdfsTotalDrive = archivos.length;

        // Construir tokens de busqueda:
        // - desde textoPrincipal del diseno (PRIMARIO)
        // - desde palabrasClaveBusqueda (PRIMARIO)
        // - desde p.equipo (FALLBACK)
        const tokens = new Set();
        const STOPW = new Set(['por','el','la','los','las','un','una','de','del','y','o','en','con','para','san']);
        // Wait — "san" NO debe ser stopword si forma parte de "san martin". Lo manejamos como conjunto:
        STOPW.delete('san');
        const addTokens = (texto) => {
          if (!texto) return;
          texto.toLowerCase()
            .replace(/[^\w\sñáéíóú]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3 && !STOPW.has(t))
            .forEach(t => tokens.add(t));
        };
        if (textoDiseno) {
          addTokens(textoDiseno.textoPrincipal);
          addTokens(textoDiseno.textoSecundario);
          (textoDiseno.palabrasClaveBusqueda || []).forEach(p => addTokens(p));
        }
        addTokens(p.equipo); // fallback
        busquedaDetalles.tokensBuscados = Array.from(tokens);

        // Scorear cada PDF: cuántos tokens del diseño aparecen en el nombre
        const scoreados = pdfs.map(a => {
          const nameLow = a.name.toLowerCase();
          let score = 0;
          const tokensHit = [];
          for (const t of tokens) {
            if (nameLow.includes(t)) { score++; tokensHit.push(t); }
          }
          return { archivo: a, score, tokensHit };
        }).filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4);

        // Limitar a top 3 para velocidad
        const top = scoreados.slice(0, 3);
        busquedaDetalles.pdfsMatcheados = top.map(s => ({ nombre: s.archivo.name, score: s.score, tokensHit: s.tokensHit }));

        // Descargar los THUMBNAILS (no los PDFs completos — son muy grandes ~1GB)
        // Los thumbnails son imagenes JPG de ~50-200KB que Drive genera automatico.
        const thumbs = await Promise.all(top.map(s => driveSync.descargarThumbnailBase64(s.archivo.id, 1000).catch(e => ({ error: e.message }))));
        const sinThumbnail = [];
        for (let i = 0; i < thumbs.length; i++) {
          const th = thumbs[i]; const s = top[i];
          if (th && th.base64) {
            const kb = Math.round(th.base64.length / 1024);
            pdfsCandidatos.push({ base64: th.base64, mime: th.mime || 'image/jpeg', nombre: s.archivo.name, kb, score: s.score, esThumbnail: true });
          } else {
            sinThumbnail.push({ nombre: s.archivo.name, error: th?.error || 'sin thumb' });
          }
        }
        busquedaDetalles.sinThumbnail = sinThumbnail;
      } catch (eDrive) {
        return json(res, 200, {
          pedido: { id: p.id, equipo: p.equipo },
          imagenChatFecha: imgChatFecha,
          textoDiseno,
          error: 'no se pudo acceder a Drive: ' + eDrive.message,
        });
      }

      if (pdfsCandidatos.length === 0) {
        return json(res, 200, {
          pedido: { id: p.id, equipo: p.equipo, vendedora: p.vendedora, estado: p.estado },
          imagenChatFecha: imgChatFecha,
          textoDiseno,
          busqueda: busquedaDetalles,
          pdfsCandidatos: 0,
          veredicto: { coincide: false, razonamiento: 'no hay PDFs en Drive cuyo nombre matchee con el texto del diseño ni el nombre del pedido' },
        });
      }

      // 4) Comparar visualmente imagen Chat vs PDFs candidatos con Gemini Vision
      const veredicto = await compararDisenosConGemini(
        { base64: imgChatBase64, mime: imgChatMime },
        pdfsCandidatos,
        p.equipo,
      );

      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, vendedora: p.vendedora, estado: p.estado, abonado: p.abonado || 0 },
        imagenChatFecha: imgChatFecha,
        imagenChatQuien: imgChatQuien,
        imagenesProbadas,
        textoDiseno,
        busqueda: busquedaDetalles,
        pdfsCandidatos: pdfsCandidatos.map(x => ({ nombre: x.nombre, kb: x.kb, score: x.score })),
        veredicto,
        siCoincide: 'el pedido ya esta en produccion (PDF rip existe) — confirmar',
        siNoCoincide: 'el cliente aprobo pero todavia no se ripeo en Drive',
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ── Extraer lista de jugadores del chat del pedido ──────────────
  // GET /api/admin/extraer-lista-pedido?id=X
  // Recorre las imagenes del chat, busca tablas con jugadores y devuelve TODAS las que encontro.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/extraer-lista-pedido')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });
      if (!p.telefono) return json(res, 200, { error: 'sin telefono' });

      const contacto = await buscarContactoChatwoot(p.telefono);
      if (!contacto?.id) return json(res, 200, { error: 'sin contacto chatwoot' });
      const urlCw = process.env.CHATWOOT_URL;
      const accId = process.env.CHATWOOT_ACCOUNT_ID;
      const apiCw = process.env.CHATWOOT_API_KEY;
      const rConv = await fetch(`${urlCw}/api/v1/accounts/${accId}/contacts/${contacto.id}/conversations`, {
        headers: { 'api_access_token': apiCw },
      });
      const dataConv = await rConv.json();
      const conv = (dataConv.payload || [])[0];
      if (!conv?.id) return json(res, 200, { error: 'sin conversacion' });

      // Traer 5 paginas de mensajes (hasta 125)
      let todos = [];
      let ultimoId = null;
      for (let pag = 0; pag < 5; pag++) {
        const urlMsg = ultimoId
          ? `${urlCw}/api/v1/accounts/${accId}/conversations/${conv.id}/messages?before=${ultimoId}`
          : `${urlCw}/api/v1/accounts/${accId}/conversations/${conv.id}/messages`;
        const rMsg = await fetch(urlMsg, { headers: { 'api_access_token': apiCw } });
        const dataMsg = await rMsg.json();
        const lote = dataMsg.payload || dataMsg || [];
        if (lote.length === 0) break;
        if (lote[0]?.id === ultimoId) break; // loop guard
        todos = [...lote, ...todos];
        ultimoId = lote[0]?.id;
        if (!ultimoId) break;
      }

      // Probar TODAS las imagenes (max 10)
      const listas = [];
      const debugImagenes = [];
      let probadas = 0;
      for (const m of todos) {
        if (probadas >= 10) break;
        const imgs = (m.attachments || []).filter(a => a.file_type === 'image');
        for (const att of imgs) {
          if (probadas >= 10) break;
          probadas++;
          const dl = await descargarAttachmentChatwootBase64(att.data_url);
          if (!dl) continue;
          const fecha = m.created_at ? new Date(m.created_at*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null;
          const quien = m.message_type === 0 ? 'cliente' : 'vendedora';
          const extraccion = await extraerListaJugadoresConGemini(dl.base64, dl.mime);
          debugImagenes.push({
            fecha, quien,
            esLista: extraccion?.esLista,
            totalJugadores: extraccion?.totalJugadores,
            confianza: extraccion?.confianza,
            encabezado: extraccion?.encabezado,
          });
          if (extraccion?.esLista === true && (extraccion?.jugadores||[]).length > 0) {
            listas.push({ fecha, quien, encabezado: extraccion.encabezado, totalJugadores: extraccion.totalJugadores, jugadores: extraccion.jugadores, marcas: extraccion.marcasDetectadas, confianza: extraccion.confianza });
          }
        }
      }
      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, vendedora: p.vendedora, telefono: p.telefono },
        totalMensajes: todos.length,
        imagenesProbadas: probadas,
        listasEncontradas: listas.length,
        listas,
        debugImagenes,
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ── Setear nombreDiseno y/o listaJugadores en un pedido ──────────
  // POST /api/pedidos/:id/diseno-detectado
  // Body: { nombreDiseno?: "POR UN BELLO SAN MARTIN", listaJugadores?: [...] }
  if (req.method === 'POST' && req.url.match(/^\/api\/pedidos\/\d+\/diseno-detectado$/)) {
    const id = parseInt(req.url.split('/')[3]);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { nombreDiseno, listaJugadores } = JSON.parse(body || '{}');
        const pedidos = leerPedidos();
        const p = pedidos.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'pedido no existe' });
        const cambios = [];
        if (nombreDiseno && nombreDiseno.length > 1 && nombreDiseno !== p.nombreDiseno) {
          p.nombreDisenoAnterior = p.nombreDiseno || null;
          p.nombreDiseno = nombreDiseno;
          cambios.push('nombreDiseno');
        }
        if (Array.isArray(listaJugadores) && listaJugadores.length > 0) {
          p.listaJugadores = listaJugadores;
          p.listaJugadoresDetectadaEn = new Date().toISOString();
          cambios.push('listaJugadores');
        }
        if (cambios.length > 0) {
          p.ultimoMovimiento = new Date().toISOString();
          guardarPedidos(pedidos, leerNextId());
        }
        return json(res, 200, { ok: true, cambios, nombreDiseno: p.nombreDiseno, listaJugadores: p.listaJugadores });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/admin/crear-pedido-test — crea pedido de prueba ──
  // Body: { telefono, equipo, vendedora }
  if (req.method === 'POST' && req.url === '/api/admin/crear-pedido-test') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { telefono, equipo, vendedora } = JSON.parse(body || '{}');
        if (!telefono || !equipo || !vendedora) {
          return json(res, 400, { error: 'falta telefono, equipo o vendedora' });
        }
        const r = crearVentaInterna('pedido', vendedora, String(telefono).replace(/\s/g, ''), 'test-' + Date.now(), equipo);
        if (r.ok) {
          // Marcar como pedido de TEST en historial
          const peds = leerPedidos();
          const p = peds.find(x => x.id === r.id);
          if (p) {
            p.esTest = true;
            p.historial = p.historial || [];
            p.historial.push({
              fecha: new Date().toISOString(),
              por: 'admin-test',
              accion: 'pedido-test-creado',
              nota: 'Pedido creado para prueba del flujo de aprobacion (puede borrarse despues)',
            });
            guardarPedidos(peds, leerNextId());
          }
        }
        return json(res, 200, r);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── DELETE /api/admin/pedido-test/:id — borra pedido de prueba ──
  if (req.method === 'DELETE' && req.url.match(/^\/api\/admin\/pedido-test\/\d+$/)) {
    try {
      const id = parseInt(req.url.split('/')[4], 10);
      const peds = leerPedidos();
      const idx = peds.findIndex(p => p.id === id);
      if (idx < 0) return json(res, 404, { error: 'pedido no encontrado' });
      if (!peds[idx].esTest) return json(res, 403, { error: 'no es pedido de test, no se borra desde aqui' });
      const eliminado = peds.splice(idx, 1)[0];
      guardarPedidos(peds, leerNextId());
      return json(res, 200, { ok: true, eliminado: { id: eliminado.id, equipo: eliminado.equipo } });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/ultimos-polls — diagnostico de webhooks de polls ──
  if (req.method === 'GET' && req.url === '/api/admin/ultimos-polls') {
    return json(res, 200, { polls: global._ultimosPolls || [] });
  }

  // ── POST /api/admin/drive-subir-vigilante ──
  // Recibe { nombreCarpeta? | parentId?, archivos: [{titulo, mimeType, contentBase64, publico?}] }
  // Crea/encuentra la carpeta y sube los archivos. Devuelve los links.
  if (req.method === 'POST' && req.url === '/api/admin/drive-subir-vigilante') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => body += d);
    req.on('end', () => {
      (async () => {
        try {
          const { nombreCarpeta, parentId: parentIdProvided, archivos } = JSON.parse(body || '{}');
          if (!Array.isArray(archivos) || archivos.length === 0) {
            return json(res, 400, { error: 'falta archivos[]' });
          }
          let parentId = parentIdProvided;
          let carpetaInfo = null;
          if (!parentId && nombreCarpeta) {
            carpetaInfo = await driveSync.crearOBuscarCarpeta(nombreCarpeta);
            parentId = carpetaInfo.id;
          }
          const subidos = [];
          for (const a of archivos) {
            try {
              const sub = await driveSync.subirArchivo({
                titulo: a.titulo,
                mimeType: a.mimeType,
                contentBase64: a.contentBase64,
                parentId,
              });
              if (a.publico) {
                try { await driveSync.hacerArchivoPublico(sub.id); } catch (e) { /* ignorar */ }
              }
              subidos.push({ titulo: a.titulo, id: sub.id, viewLink: sub.viewLink, downloadLink: sub.downloadLink });
            } catch (e) {
              subidos.push({ titulo: a.titulo, error: e.message });
            }
          }
          return json(res, 200, {
            ok: true,
            carpeta: carpetaInfo ? { id: parentId, nombre: nombreCarpeta, creada: carpetaInfo.creada } : { id: parentId },
            subidos,
          });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      })();
    });
    return;
  }

  // ── POST /api/admin/sincronizar-chatwoot ──
  // Para cada pedido activo:
  //  1. Si NO tiene contactoChatwoot, busca por telefono en Chatwoot y lo vincula
  //  2. Si el `equipo` o `pushNameCliente` tiene encoding roto, lo reemplaza
  //     con el `name` correcto de Chatwoot (que esta bien guardado).
  // Heuristica encoding roto: matches secuencias UTF-8 mal decodificadas.
  if (req.method === 'POST' && req.url === '/api/admin/sincronizar-chatwoot') {
    (async () => {
      try {
        const cwUrl = process.env.CHATWOOT_URL;
        const cwToken = process.env.CHATWOOT_API_KEY;
        const cwAccount = process.env.CHATWOOT_ACCOUNT_ID || '2';
        if (!cwUrl || !cwToken) return json(res, 500, { error: 'falta CHATWOOT_URL o CHATWOOT_API_KEY' });
        const pedidos = leerPedidos();
        const reporte = { vinculados: [], renombrados: [], sinContactoCw: [], sinCambio: [] };
        const tieneEncodingRoto = (s) => {
          if (!s) return false;
          // Control chars U+0080-U+009F del Latin-1 extendido JAMAS aparecen
          // en nombres reales. Son senal inequivoca de UTF-8 mal decodificado.
          return /[\u0080-\u009F]/.test(String(s));
        };
        // Compara nombres "sin caracteres raros" para ver si son el mismo
        const nombreBase = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
        const mismoNombre = (a, b) => {
          const na = nombreBase(a), nb = nombreBase(b);
          if (!na || !nb) return false;
          return na === nb || na.startsWith(nb) || nb.startsWith(na);
        };
        for (const p of pedidos) {
          if (!p.telefono) continue;
          let touched = false;
          // 1) Buscar en Chatwoot por telefono
          let cwHit = null;
          try {
            const r = await fetch(`${cwUrl}/api/v1/accounts/${cwAccount}/contacts/search?q=${encodeURIComponent(p.telefono)}`, {
              headers: { 'api_access_token': cwToken },
            });
            if (r.ok) {
              const data = await r.json();
              cwHit = (data.payload || [])[0] || null;
            }
          } catch (e) { console.error('[sinc-cw] buscar', e.message); }
          if (!cwHit) {
            reporte.sinContactoCw.push({ id: p.id, equipo: p.equipo, tel: p.telefono });
            continue;
          }
          // 2) Vincular contactoChatwoot si falta
          if (!p.contactoChatwoot) {
            p.contactoChatwoot = cwHit.id;
            reporte.vinculados.push({ id: p.id, equipo: p.equipo, cwId: cwHit.id });
            touched = true;
          }
          // 3) Reemplazar nombre si encoding roto Y el nombre de Chatwoot "coincide"
          //    (mismo nombre limpiando caracteres). Asi no pisamos nombres reales del equipo.
          const nombreCw = (cwHit.name || '').trim();
          if (nombreCw) {
            const equipoRoto = tieneEncodingRoto(p.equipo);
            const pushRoto = tieneEncodingRoto(p.pushNameCliente);
            const coincideEquipo = equipoRoto && mismoNombre(nombreCw, p.equipo);
            const coincidePush = pushRoto && mismoNombre(nombreCw, p.pushNameCliente);
            if (coincideEquipo) {
              const antes = p.equipo;
              if (p.equipoVieneDeBot !== false) p.equipo = nombreCw;
              reporte.renombrados.push({ id: p.id, antes, despues: nombreCw, campo: 'equipo' });
              touched = true;
            }
            if (coincidePush) {
              const antes = p.pushNameCliente;
              p.pushNameCliente = nombreCw;
              if (!coincideEquipo) reporte.renombrados.push({ id: p.id, antes, despues: nombreCw, campo: 'pushNameCliente' });
              touched = true;
            }
          }
          if (touched) {
            p.ultimoMovimiento = new Date().toISOString();
          } else {
            reporte.sinCambio.push({ id: p.id });
          }
        }
        if (reporte.vinculados.length || reporte.renombrados.length) {
          guardarPedidos(pedidos, leerNextId());
        }
        return json(res, 200, { ok: true, totales: { vinculados: reporte.vinculados.length, renombrados: reporte.renombrados.length, sinContactoCw: reporte.sinContactoCw.length }, detalle: reporte });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/admin/normalizar-telefonos ──
  // Prefija "57" a telefonos colombianos de 10 digitos guardados sin codigo pais.
  // Idempotente: solo toca los que faltan el 57. Recorre activos + archivados.
  // Reporta lista de pedidos corregidos.
  if (req.method === 'POST' && req.url === '/api/admin/normalizar-telefonos') {
    try {
      const pedidos = leerPedidos();
      const archivados = (typeof leerArchivados === 'function') ? (leerArchivados() || []) : [];
      const corregidos = [];
      const fix = (lista, scope) => {
        for (const p of lista) {
          if (!p || !p.telefono) continue;
          const t = String(p.telefono).replace(/\D/g, '');
          if (t.length === 10 && /^3\d{9}$/.test(t)) {
            const nuevo = '57' + t;
            p.telefonoAnterior = p.telefono;
            p.telefono = nuevo;
            corregidos.push({ id: p.id, scope, antes: t, despues: nuevo, equipo: p.equipo });
          }
        }
      };
      fix(pedidos, 'activo');
      fix(archivados, 'archivado');
      if (corregidos.length > 0) {
        guardarPedidos(pedidos, leerNextId());
        if (typeof guardarArchivados === 'function') {
          try { guardarArchivados(archivados); } catch (e) { console.error('[normalizar-tel archivados]', e.message); }
        }
      }
      return json(res, 200, { ok: true, totalCorregidos: corregidos.length, corregidos });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── CRON SILENCIOSO: probar / ejecutar-ahora / on / off / status / saldo ───────────
  if (req.method === 'GET' && req.url === '/api/admin/cron-silencioso-probar') {
    try {
      const r = await ejecutarCronSilencioso(true);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (req.method === 'POST' && req.url === '/api/admin/cron-silencioso-on') {
    const cfg = _leerConfigCron();
    cfg.activo = true;
    cfg.ultimaModificacion = new Date().toISOString();
    _guardarConfigCron(cfg);
    return json(res, 200, { ok: true, activo: true, mensaje: 'Cron silencioso ACTIVO. Correrá a las 10 PM Bogotá cada día.' });
  }
  if (req.method === 'POST' && req.url === '/api/admin/cron-silencioso-off') {
    const cfg = _leerConfigCron();
    cfg.activo = false;
    cfg.ultimaModificacion = new Date().toISOString();
    _guardarConfigCron(cfg);
    return json(res, 200, { ok: true, activo: false, mensaje: 'Cron silencioso DESACTIVADO.' });
  }
  if (req.method === 'GET' && req.url === '/api/admin/cron-silencioso-status') {
    const cfg = _leerConfigCron();
    const gasto = _leerGasto();
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(CRON_SILENCIOSO_HISTORIAL_FILE, 'utf8')); } catch {}
    return json(res, 200, {
      activo: cfg.activo,
      ultimaModificacion: cfg.ultimaModificacion,
      gastoMesActual: _gastoMesActual(),
      gastoDiaActual: _gastoDiaActual(),
      limiteMensual: LIMITE_MES_USD,
      limiteDiario: LIMITE_DIA_USD,
      gastoTotal: gasto,
      historial: hist.slice(0, 50),
    });
  }
  if (req.method === 'GET' && req.url === '/api/admin/saldo-claude') {
    const s = await verificarSaldoClaude();
    return json(res, 200, s);
  }

  // DEBUG: listar chats recientes de una instancia Evolution
  // GET /api/admin/debug-evolution-chats?instance=ws-ney&search=314414
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-evolution-chats')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const instance = u.searchParams.get('instance') || 'ws-ventas';
      const search = u.searchParams.get('search') || '';
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const evoKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
      const r = await fetch(`${evoUrl}/chat/findChats/${instance}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
        body: JSON.stringify({}),
      });
      if (!r.ok) return json(res, 200, { error: 'HTTP '+r.status });
      const data = await r.json();
      const chats = Array.isArray(data) ? data : (data.chats || data.records || []);
      const filtrados = search ? chats.filter(c => JSON.stringify(c).includes(search)) : chats.slice(0, 20);
      return json(res, 200, {
        instance,
        totalChats: chats.length,
        coincidencias: filtrados.length,
        muestras: filtrados.slice(0, 10).map(c => ({
          id: c.id || c.remoteJid || c.key?.remoteJid,
          pushName: c.pushName,
          lastMsgTs: c.lastMessageTimestamp ? new Date(c.lastMessageTimestamp*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null,
          unreadCount: c.unreadCount,
        })),
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }


  // DEBUG: ver configuracion Chatwoot dentro de Evolution para una instancia
  // GET /api/admin/debug-evolution-chatwoot?instance=ws-ney
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-evolution-chatwoot')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const instance = u.searchParams.get('instance') || 'ws-ney';
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const evoKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
      const intentos = {};
      const endpoints = [
        `/chatwoot/find/${instance}`,
        `/chatwoot/findChatwoot/${instance}`,
        `/integrations/chatwoot/${instance}`,
        `/instance/fetchInstances?instanceName=${instance}`,
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(`${evoUrl}${ep}`, { headers: { apikey: evoKey } });
          const raw = await r.text();
          intentos[ep] = { status: r.status, sample: raw.slice(0, 500) };
        } catch (e) { intentos[ep] = { error: e.message }; }
      }
      return json(res, 200, { instance, intentos });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // DEBUG: ver configuracion de inboxes de Chatwoot
  // GET /api/admin/debug-chatwoot-inboxes
  if (req.method === 'GET' && req.url === '/api/admin/debug-chatwoot-inboxes') {
    try {
      const url = process.env.CHATWOOT_URL;
      const accountId = process.env.CHATWOOT_ACCOUNT_ID;
      const apiKey = process.env.CHATWOOT_API_KEY;
      const r = await fetch(`${url}/api/v1/accounts/${accountId}/inboxes`, {
        headers: { 'api_access_token': apiKey },
      });
      const data = await r.json();
      return json(res, 200, {
        total: (data.payload || []).length,
        inboxes: (data.payload || []).map(i => ({
          id: i.id,
          name: i.name,
          channel_type: i.channel_type,
          provider_config: i.provider_config,
          webhook_url: i.webhook_url,
          forward_url: i.forward_url,
          enable_auto_assignment: i.enable_auto_assignment,
        })),
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // DEBUG: chat detalle por substring — devuelve TODO el objeto chat
  // GET /api/admin/debug-chat-detalle?instance=ws-ney&search=3214144809
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-chat-detalle')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const instance = u.searchParams.get('instance') || 'ws-ney';
      const search = u.searchParams.get('search') || '';
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const evoKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
      const r = await fetch(`${evoUrl}/chat/findChats/${instance}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
        body: JSON.stringify({}),
      });
      if (!r.ok) return json(res, 200, { error: 'HTTP ' + r.status });
      const data = await r.json();
      const chats = Array.isArray(data) ? data : (data.chats || data.records || []);
      const filtrados = chats.filter(c => JSON.stringify(c).includes(search));
      return json(res, 200, {
        instance, search,
        total: filtrados.length,
        chats: filtrados.slice(0, 5), // Objeto completo para ver TODOS los campos
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // DEBUG: buscar mensajes con chatId interno (CUID) o por subscripcion al telefono
  // GET /api/admin/debug-evolution-mensajes-chatid?instance=ws-ney&chatId=cmpme...
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-evolution-mensajes-chatid')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const instance = u.searchParams.get('instance') || 'ws-ney';
      const chatId = u.searchParams.get('chatId') || '';
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const evoKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
      // Probar varios donde
      const intentos = [
        { where: { chatId } },
        { where: { key: { id: chatId } } },
        { where: { 'Message.key.remoteJid': chatId } },
      ];
      const out = {};
      for (const intento of intentos) {
        try {
          const r = await fetch(`${evoUrl}/chat/findMessages/${instance}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
            body: JSON.stringify({ ...intento, limit: 10 }),
          });
          const raw = await r.text();
          let data; try { data = JSON.parse(raw); } catch {}
          const recs = data?.messages?.records || data?.records || [];
          out[JSON.stringify(intento.where)] = {
            total: data?.messages?.total || recs.length,
            primeros: recs.slice(0,5).map(m => ({
              ts: m.messageTimestamp ? new Date(m.messageTimestamp*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null,
              fromMe: m.key?.fromMe,
              remoteJid: m.key?.remoteJid,
              texto: m.message?.conversation || m.message?.extendedTextMessage?.text || (m.message?.audioMessage?'[AUDIO]':'') || (m.message?.imageMessage?'[IMG]':'') || '',
            })),
          };
        } catch {}
      }
      return json(res, 200, { instance, chatId, intentos: out });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/admin/backfill-etiquetas?dias=60&modo=dry-run|ejecutar&instancia=ws-wendy
  //
  // Procesa los chats que YA estan etiquetados como "venta confirmada"
  // (anteriores al webhook LABELS_ASSOCIATION). Solo chats con actividad
  // en los ultimos N dias.
  //
  // modo=dry-run: cuenta cuantos pedidos crearia, sin escribir nada.
  // modo=ejecutar: crea los pedidos en el ERP via crearVentaInterna.
  //
  // Resuelve @lid mirando lastMessage.key.remoteJidAlt.
  // Ignora grupos (@g.us) y @lid sin resolucion.
  // Usa deduplicacion natural de crearVentaInterna (telefono+mes).
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/admin/backfill-etiquetas') {
    try {
      const qs = new URLSearchParams((req.url.split('?')[1] || ''));
      const dias = Math.max(1, parseInt(qs.get('dias') || '60', 10));
      const modo = (qs.get('modo') || 'dry-run').toLowerCase();
      const instanciaFiltro = qs.get('instancia') || null;
      if (modo !== 'dry-run' && modo !== 'ejecutar') {
        return json(res, 400, { error: 'modo debe ser dry-run o ejecutar' });
      }

      const INSTANCIAS = [
        { slug: 'ws-ventas', urlPath: 'ws-ventas',  vendedora: 'Betty', token: process.env.EVO_KEY_VENTAS || '5DC08B336216-404C-BE94-A95B4A9A0528', labelsConfirmado: ['En Proceso','PAGO EN CASA'],         labelsEntregado: ['entregado'] },
        { slug: 'ws-wendy',  urlPath: 'ws%20wendy', vendedora: 'Wendy', token: process.env.EVO_KEY_WENDY  || 'D26BB7CE0FF8-4BAC-877D-B874BCF86890', labelsConfirmado: ['CONSIGNADO'],                       labelsEntregado: ['Pedido finalizado'] },
        { slug: 'ws-ney',    urlPath: 'ws-ney',     vendedora: 'Ney',   token: process.env.EVO_KEY_NEY    || '81851853FF36-444A-A76E-6C167CF14073', labelsConfirmado: ['Pagado'],                            labelsEntregado: ['Venta'] },
        { slug: 'ws-paola',  urlPath: 'ws-paola',   vendedora: 'Paola', token: process.env.EVO_KEY_PAOLA  || 'A297362F7EC2-4BD2-8DE9-35A8ECCCF6B1', labelsConfirmado: ['Pendiente abono','Pendiente abono '], labelsEntregado: ['Entregado'] },
      ];
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const limiteMs = Date.now() - dias * 24 * 60 * 60 * 1000;
      const normTel = (t) => {
        const d = String(t || '').replace(/\D/g, '');
        return d.startsWith('57') ? d.slice(2) : d;
      };

      (async () => {
        const porInstancia = [];
        let totCreados = 0, totYaExisten = 0, totSaltados = 0, totLidSinResolver = 0;

        for (const inst of INSTANCIAS) {
          if (instanciaFiltro && instanciaFiltro !== inst.slug) continue;
          const apiKey = inst.token;
          const ejemplos = [];
          let chatsTotal = 0, recientes = 0, yaExisten = 0, creados = 0, saltados = 0, lidSinResolver = 0;

          try {
            // 1. findLabels para mapear nombre→id
            const rLab = await fetch(`${evoUrl}/label/findLabels/${inst.urlPath}`, { headers: { apikey: apiKey } });
            const labels = await rLab.json();
            if (!Array.isArray(labels)) {
              porInstancia.push({ instancia: inst.slug, error: 'no se pudo listar labels', detalle: labels });
              continue;
            }
            const idsConf = labels.filter(l => inst.labelsConfirmado.includes(l.name)).map(l => String(l.id));
            const idsEntregado = labels.filter(l => (inst.labelsEntregado || []).includes(l.name)).map(l => String(l.id));
            if (idsConf.length === 0) {
              porInstancia.push({ instancia: inst.slug, error: 'no se encontraron labels de venta confirmada', labelsBuscadas: inst.labelsConfirmado });
              continue;
            }

            // 2. findChats con etiquetas de venta confirmada
            const rChats = await fetch(`${evoUrl}/chat/findChats/${inst.urlPath}`, {
              method: 'POST',
              headers: { apikey: apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ where: { labels: idsConf } }),
            });
            const chats = await rChats.json();
            if (!Array.isArray(chats)) {
              porInstancia.push({ instancia: inst.slug, error: 'no se pudo listar chats', detalle: chats });
              continue;
            }
            chatsTotal = chats.length;

            // 2b. Listar chats YA ENTREGADOS para excluirlos (solo VIGENTES)
            const jidsEntregados = new Set();
            if (idsEntregado.length > 0) {
              try {
                const rE = await fetch(`${evoUrl}/chat/findChats/${inst.urlPath}`, {
                  method: 'POST',
                  headers: { apikey: apiKey, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ where: { labels: idsEntregado } }),
                });
                const chatsE = await rE.json();
                if (Array.isArray(chatsE)) chatsE.forEach(c => c.remoteJid && jidsEntregados.add(c.remoteJid));
              } catch {}
            }

            // 3. Filtrar: VIGENTES = (etiqueta confirmado) AND (NO etiqueta entregado) AND (actividad reciente)
            const chatsRec = chats.filter(c => {
              if (jidsEntregados.has(c.remoteJid)) return false; // ya entregado, excluir
              const ts = c.updatedAt ? new Date(c.updatedAt).getTime() : 0;
              return ts >= limiteMs;
            });
            recientes = chatsRec.length;

            // 4. Procesar cada chat
            for (const c of chatsRec) {
              const jid = c.remoteJid || '';
              if (jid.includes('@g.us')) { saltados++; continue; }

              let tel = '';
              if (jid.endsWith('@s.whatsapp.net')) {
                tel = jid.replace('@s.whatsapp.net','').replace(/\D/g,'');
              } else if (jid.endsWith('@lid')) {
                const alt = c.lastMessage?.key?.remoteJidAlt || c.remoteJidAlt;
                if (alt && String(alt).endsWith('@s.whatsapp.net')) {
                  tel = String(alt).replace('@s.whatsapp.net','').replace(/\D/g,'');
                } else {
                  lidSinResolver++;
                  continue;
                }
              } else {
                saltados++;
                continue;
              }

              if (tel.length < 8) { saltados++; continue; }
              const telLimpio = normTel(tel);

              // Verificar si ya existe pedido para este telefono
              const pedidos = leerPedidos();
              const pdExiste = pedidos.find(p => normTel(p.telefono) === telLimpio);
              if (pdExiste) {
                yaExisten++;
                if (ejemplos.length < 5) ejemplos.push({ tel, accion: 'ya_existe', pedido_id: pdExiste.id, estado: pdExiste.estado });
                continue;
              }

              if (modo === 'dry-run') {
                creados++;
                if (ejemplos.length < 5) ejemplos.push({ tel, accion: 'crearia', cliente: c.pushName || c.contact?.pushName || '' });
                continue;
              }

              // modo=ejecutar
              const pushName = c.pushName || c.contact?.pushName || 'Cliente WA (backfill)';
              const r = crearVentaInterna('pedido', inst.vendedora, tel, null, pushName);
              if (r.ok && !r.duplicado) {
                const peds2 = leerPedidos();
                const np = peds2.find(p => p.id === r.id);
                if (np) {
                  np.estado = 'confirmado';
                  np.ultimoMovimiento = new Date().toISOString();
                  np.historial = np.historial || [];
                  np.historial.push({
                    ts: new Date().toISOString(),
                    evento: `Backfill etiqueta WA ${inst.slug}`,
                    automatico: true,
                  });
                  guardarPedidos(peds2, leerNextId());
                  creados++;
                  if (ejemplos.length < 5) ejemplos.push({ tel, accion: 'creado', pedido_id: r.id });
                }
              } else if (r.duplicado) {
                yaExisten++;
              } else {
                saltados++;
              }
            }

            porInstancia.push({
              instancia: inst.slug,
              vendedora: inst.vendedora,
              etiquetas_confirmado: inst.labelsConfirmado,
              etiquetas_entregado_excluidas: inst.labelsEntregado || [],
              chats_total_confirmados: chatsTotal,
              chats_excluidos_por_entregado: jidsEntregados.size,
              chats_vigentes_recientes: recientes,
              ya_existen_en_erp: yaExisten,
              [modo === 'dry-run' ? 'crearia' : 'creados']: creados,
              saltados,
              lid_sin_resolver: lidSinResolver,
              ejemplos,
            });
            totCreados += creados;
            totYaExisten += yaExisten;
            totSaltados += saltados;
            totLidSinResolver += lidSinResolver;
          } catch (e) {
            porInstancia.push({ instancia: inst.slug, error: e.message });
          }
        }

        json(res, 200, {
          ok: true,
          modo,
          dias_filtro: dias,
          resumen_total: {
            [modo === 'dry-run' ? 'crearia' : 'creados']: totCreados,
            ya_existen: totYaExisten,
            saltados: totSaltados,
            lid_sin_resolver: totLidSinResolver,
          },
          por_instancia: porInstancia,
          nota: modo === 'dry-run'
            ? 'DRY-RUN: nada se escribio. Revisa los numeros y si pintan bien, vuelve a llamar con modo=ejecutar.'
            : 'EJECUTADO: pedidos creados en el ERP. Visibles en /pedidos.',
        });
      })().catch(e => {
        console.error('[backfill-etiquetas]', e);
        try { json(res, 500, { error: e.message, stack: e.stack }); } catch {}
      });
      return; // respuesta async
    } catch (e) {
      console.error('[backfill-etiquetas sync]', e);
      return json(res, 500, { error: e.message });
    }
  }

  // DEBUG: ver mensajes en Evolution directo (no Chatwoot)
  // GET /api/admin/debug-eventos-recientes?tipo=LABELS&limit=10
  // Lista los ultimos N eventos crudos guardados en evolution_events.
  // Util para diagnosticar si llegan eventos LABELS_EDIT / LABELS_ASSOCIATION
  // que Evolution emite cuando se etiqueta un chat manualmente en WA.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-eventos-recientes')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const tipoFiltro = (u.searchParams.get('tipo') || '').toUpperCase();
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '20', 10), 200);
      const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 3').all().map(r => r.fecha);
      const out = [];
      for (const fecha of fechas) {
        const events = db.leerEvolutionEvents(fecha);
        // events ya viene como array de payloads — recorrer en reversa (mas nuevos primero)
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i];
          // ev puede ser el payload completo o un wrapper. Tratamos ambos.
          const eventName = String(ev?.event || ev?.data?.event || '').toUpperCase();
          if (tipoFiltro && !eventName.includes(tipoFiltro)) continue;
          out.push({
            fecha,
            event: ev?.event || '',
            instance: ev?.instance || '',
            dateTime: ev?.date_time || ev?.dateTime || '',
            messageType: ev?.data?.messageType || '',
            raw: ev,
          });
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      return json(res, 200, { total: out.length, eventos: out });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /api/admin/debug-evolution-msgs?id=X&instance=ws-ney
  // Devuelve los ultimos mensajes que tiene Evolution para el telefono del pedido.
  // Sirve para comparar con Chatwoot y ver si hay mensajes que se quedaron en el camino.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-evolution-msgs')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const instance = u.searchParams.get('instance') || null;
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });
      const tel = String(p.telefono || '').replace(/\D/g, '');
      if (!tel) return json(res, 200, { error: 'sin telefono' });

      // Si no se pasa instancia, intentar todas
      const instancias = instance ? [instance] : ['ws-ventas', 'ws-ney', 'ws-wendy', 'ws-paola', 'ws-duvan'];
      const resultados = {};
      const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
      const evoKey = process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
      const remoteJid = tel + '@s.whatsapp.net';

      for (const inst of instancias) {
        try {
          // Probar 2 estilos de query (Evolution v1 vs v2)
          let r = await fetch(`${evoUrl}/chat/findMessages/${inst}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
            body: JSON.stringify({ where: { key: { remoteJid } }, limit: 30 }),
          });
          let raw = await r.text();
          let primer = raw.slice(0, 200);
          // Si vacío, probar formato v2 (chatId)
          let data;
          try { data = JSON.parse(raw); } catch { data = null; }
          let msgs0 = (data?.messages?.records || data?.records || (Array.isArray(data) ? data : []) || []);
          if (msgs0.length === 0) {
            const r2 = await fetch(`${evoUrl}/chat/findMessages/${inst}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
              body: JSON.stringify({ chatId: remoteJid, limit: 30 }),
            });
            const raw2 = await r2.text();
            try { data = JSON.parse(raw2); } catch { data = null; }
            msgs0 = (data?.messages?.records || data?.records || (Array.isArray(data) ? data : []) || []);
            primer += ' || v2: ' + raw2.slice(0, 200);
          }
          // Override la variable usada despues
          r = { ok: true, json: async () => ({ records: msgs0, _primer: primer }) };
          if (!r.ok) {
            resultados[inst] = { error: 'HTTP ' + r.status };
            continue;
          }
          const dataInst = await r.json();
          const msgs = dataInst.records || dataInst.messages?.records || (Array.isArray(dataInst) ? dataInst : []) || [];
          resultados[`${inst}_rawSample`] = dataInst._primer;
          const mensajesUtiles = msgs.slice(0, 15).map(m => ({
            ts: m.messageTimestamp ? new Date(m.messageTimestamp * 1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null,
            fromMe: m.key?.fromMe,
            texto: (m.message?.conversation
              || m.message?.extendedTextMessage?.text
              || m.message?.imageMessage?.caption
              || m.message?.audioMessage ? '[AUDIO]' : '')
              || '[sin texto]',
            tieneImagen: !!m.message?.imageMessage,
            tieneAudio: !!m.message?.audioMessage,
          }));
          resultados[inst] = { total: msgs.length, mensajes: mensajesUtiles, raw: dataInst._primer || null };
        } catch (e) {
          resultados[inst] = { error: e.message };
        }
      }

      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, telefono: tel, vendedora: p.vendedora },
        remoteJid,
        instanciasConsultadas: resultados,
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // DEBUG: listar TODAS las conversaciones de un contacto en Chatwoot
  // GET /api/admin/debug-conversaciones?id=X
  if (req.method === 'GET' && req.url.startsWith('/api/admin/debug-conversaciones')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });
      const contacto = await buscarContactoChatwoot(p.telefono);
      if (!contacto?.id) return json(res, 200, { error: 'sin contacto' });
      const url = process.env.CHATWOOT_URL;
      const accountId = process.env.CHATWOOT_ACCOUNT_ID;
      const apiKey = process.env.CHATWOOT_API_KEY;
      // Probar con status=all explícito para incluir cerradas/resueltas
      const url1 = `${url}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`;
      const url2 = `${url}/api/v1/accounts/${accountId}/conversations?q[contact_id]=${contacto.id}&status=all`;
      const r = await fetch(url1, { headers: { 'api_access_token': apiKey } });
      const data = await r.json();
      const convs = data.payload || [];

      // También probar buscar por contact_id directo con todos los status
      let convsAlt = [];
      try {
        const r2 = await fetch(url2, { headers: { 'api_access_token': apiKey } });
        if (r2.ok) {
          const d2 = await r2.json();
          convsAlt = (d2.data?.payload || d2.payload || []);
        }
      } catch {}

      // Probar tambien la inbox del contacto: mensajes mas alla del primer chat
      let inboxesDelContacto = [];
      try {
        const r3 = await fetch(`${url}/api/v1/accounts/${accountId}/contacts/${contacto.id}`, { headers: { 'api_access_token': apiKey } });
        if (r3.ok) {
          const d3 = await r3.json();
          inboxesDelContacto = d3.payload?.contact_inboxes || d3.contact_inboxes || [];
        }
      } catch {}

      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, telefono: p.telefono },
        contactoId: contacto.id,
        totalConversaciones: convs.length,
        totalConversacionesAlt: convsAlt.length,
        contactInboxes: inboxesDelContacto.map(i => ({ inbox_id: i.inbox?.id || i.inbox_id, source_id: i.source_id, channel: i.inbox?.channel_type })),
        conversaciones: convs.map(c => ({
          id: c.id,
          status: c.status,
          inbox_id: c.inbox_id,
          labels: c.labels || [],
          last_activity_at: c.last_activity_at ? new Date(c.last_activity_at*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null,
          created_at: c.created_at ? new Date(c.created_at*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null,
          assignee_id: c.meta?.assignee?.id || null,
          team_id: c.team_id,
          messages_count: c.messages_count || (c.messages||[]).length || 0,
        })),
        conversacionesAlt: convsAlt.map(c => ({
          id: c.id, status: c.status, inbox_id: c.inbox_id,
          last_activity_at: c.last_activity_at ? new Date(c.last_activity_at*1000).toLocaleString('es-CO',{timeZone:'America/Bogota'}) : null,
        })),
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }



  // ═══════════════════════════════════════════════════════════════════
  // VERIFICAR si se envio a calandra usando WeTransfer (rastreado via Gmail).
  // GET /api/admin/verificar-envio-calandra?id=X
  //
  // Flujo real W&S:
  //   1) Disenador sube PDF a WeTransfer
  //   2) WeTransfer lo envia a sublimarte.alqueria@gmail.com (calandra)
  //   3) Llega email de noreply@wetransfer.com a Camilo:
  //      - "X.pdf enviado correctamente a sublimarte.alqueria@gmail.com" → ENVIADO
  //      - "sublimarte.alqueria@gmail.com descargo X.pdf" → DESCARGADO (= en proceso)
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.startsWith('/api/admin/verificar-envio-calandra')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = parseInt(u.searchParams.get('id'), 10);
      const dias = parseInt(u.searchParams.get('dias') || '60', 10);
      const textoExtra = u.searchParams.get('texto') || '';
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });

      // Construir queries WeTransfer:
      // Buscar emails de noreply@wetransfer.com que mencionen el equipo / texto del diseno
      const equipoLimpio = (p.equipo || '').toLowerCase().replace(/[^\w\sñáéíóú]/g, ' ').trim();
      const palabras = equipoLimpio.split(/\s+/).filter(t => t.length >= 4);

      const queries = [];
      const baseFrom = 'from:noreply@wetransfer.com';
      // Gmail tokeniza "martin_852" como una palabra → no podemos pedir "san martin" + "bello" juntos.
      // Estrategia: buscar UNA palabra distintiva (la mas larga/rica) y FILTRAR despues.
      const extraerPalabrasRicas = (texto) => {
        if (!texto) return [];
        const limpio = texto.toLowerCase().replace(/[^\w\sñáéíóú]/g, ' ').trim();
        const STOPW = new Set(['por','un','una','de','del','y','o','en','con','para','el','la','los','las','san','los','las','que','del','con']);
        return [...new Set(
          limpio.split(/\s+/).filter(t => t.length >= 4 && !STOPW.has(t))
        )].sort((a,b) => b.length - a.length);
      };
      const palabrasRicasTexto = extraerPalabrasRicas(textoExtra);
      const palabrasRicasEquipo = extraerPalabrasRicas(equipoLimpio);
      // Una query por palabra rica (max 3)
      const palabrasUsadas = [...new Set([...palabrasRicasTexto, ...palabrasRicasEquipo])].slice(0, 3);
      for (const w of palabrasUsadas) {
        queries.push(`${baseFrom} ${w} newer_than:${dias}d`);
      }
      // Fallback amplio
      if (palabrasUsadas.length === 0 && equipoLimpio) {
        queries.push(`${baseFrom} ${equipoLimpio} newer_than:${dias}d`);
      }
      // Para filtrar despues necesitamos saber el texto original
      const textoCompleto = (textoExtra + ' ' + equipoLimpio).toLowerCase();

      const resultados = [];
      const vistos = new Set();
      for (const q of queries) {
        try {
          const emails = await gmailWT.buscarEmails(q, 20);
          for (const e of emails) {
            if (vistos.has(e.id)) continue;
            vistos.add(e.id);
            resultados.push({ ...e, queryUsado: q });
          }
        } catch (eEm) { console.error('[verif gmail]', eEm.message); }
      }

      // POST-FILTRO: ya filtramos por from:noreply@wetransfer.com → asume todos validos.
      // Solo confirmamos que tenga al menos 1 palabra rica del texto del diseno
      // (incluyendo palabras cortas como FUT, TB que son distintivas).
      const todasLasRicasFlex = new Set([
        ...palabrasRicasTexto,
        ...palabrasRicasEquipo,
        // Tambien incluir palabras cortas distintivas (>=3 chars, no stopwords)
        ...((textoExtra+' '+equipoLimpio).toLowerCase().replace(/[^\w\sñáéíóú]/g,' ').split(/\s+/)
          .filter(t => t.length >= 3 && !['por','un','el','la','de','del','los','las','con','para','que'].includes(t))),
      ]);
      const resultadosFiltrados = resultados.filter(e => {
        const haystack = ((e.subject || '') + ' ' + (e.snippet || '')).toLowerCase();
        for (const w of todasLasRicasFlex) {
          if (haystack.includes(w)) return true;
        }
        return false;
      });

      // Clasificar emails: enviado vs descargado vs otro
      const eventos = resultadosFiltrados.map(e => {
        const snip = (e.snippet || '').toLowerCase();
        const subj = (e.subject || '').toLowerCase();
        const full = subj + ' ' + snip;
        let tipo = 'otro';
        // Extraer destinatario del cuerpo (formato WeTransfer)
        let destinatario = null;
        const matchEnvio = full.match(/enviado correctamente a ([\w.\-+@]+)/i);
        const matchDescarga = full.match(/([\w.\-+@]+) descargo/i) || full.match(/([\w.\-+@]+) descargó/i);
        if (matchEnvio) { tipo = 'envio-confirmado'; destinatario = matchEnvio[1]; }
        else if (matchDescarga) { tipo = 'descargado'; destinatario = matchDescarga[1]; }
        else if (full.includes('caduca')) tipo = 'aviso-caducidad';
        else if (full.includes('expir')) tipo = 'aviso-caducidad';
        return { ...e, tipo, destinatario };
      });

      const enviosConfirmados = eventos.filter(e => e.tipo === 'envio-confirmado');
      const descargados = eventos.filter(e => e.tipo === 'descargado');
      const otros = eventos.filter(e => e.tipo === 'otro' || e.tipo === 'aviso-caducidad');

      // Veredicto
      let estado = 'sin-evidencia';
      let confianza = 'sin-evidencia';
      let detalle = 'no hay emails WeTransfer con el texto del equipo';
      if (descargados.length > 0) {
        estado = 'descargado-por-calandra'; // calandra YA lo bajo: esta en proceso
        confianza = 'alta';
        const dest = [...new Set(descargados.map(d => d.destinatario).filter(Boolean))];
        detalle = `Calandra (${dest.join(', ')}) ya descargo el PDF. Esta en proceso de impresion.`;
      } else if (enviosConfirmados.length > 0) {
        estado = 'enviado-a-calandra'; // ya esta camino a calandra
        confianza = 'alta';
        const dest = [...new Set(enviosConfirmados.map(d => d.destinatario).filter(Boolean))];
        detalle = `WeTransfer envio el PDF a ${dest.join(', ')}. Aun no se confirma descarga.`;
      }

      return json(res, 200, {
        pedido: { id: p.id, equipo: p.equipo, vendedora: p.vendedora, estado: p.estado },
        queries,
        totalEncontrados: resultados.length,
        eventos: {
          enviosConfirmados: enviosConfirmados.map(e => ({ subject: e.subject, date: e.date, destinatario: e.destinatario })),
          descargados: descargados.map(e => ({ subject: e.subject, date: e.date, destinatario: e.destinatario })),
          otros: otros.map(e => ({ subject: e.subject, date: e.date })),
        },
        veredicto: {
          estadoCalandra: estado,
          confianza,
          razonamiento: detalle,
          sugerencia: estado === 'descargado-por-calandra' ? 'mover a llego-impresion cuando vuelva el pedido'
                    : estado === 'enviado-a-calandra' ? 'app puede pasar a enviado-calandra'
                    : 'esperar / no hacer nada',
        },
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORZAR REPROCESO DEL GRUPO TRABAJO EN FAMILIA (historico hasta N dias)
  // POST /api/admin/forzar-grupo-trabajo?dias=7
  // Re-analiza los ultimos N dias de mensajes y avanza pedidos
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url.startsWith('/api/admin/forzar-grupo-trabajo')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const dias = parseInt(u.searchParams.get('dias') || '7', 10);
      // Resetear state.ultimoTs para que reprocese
      try {
        const s = grupoTrabajoFamiliaWatcher.leerState();
        s.ultimoTs = Date.now() - (dias * 24 * 60 * 60 * 1000);
        s.procesados = {}; // limpiar dedupe para que reprocese mensajes
        grupoTrabajoFamiliaWatcher.guardarState(s);
      } catch (eS) { console.error('[forzar-grupo state]', eS.message); }
      const r = await grupoTrabajoFamiliaWatcher.procesarYAvanzar({
        db,
        diasAtras: dias,
        notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
        notificarJefes: typeof notificarJefes === 'function' ? notificarJefes : null,
      });
      return json(res, 200, { ok: true, dias, resultado: r });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // EMERGENCY: RESTAURAR pedidos archivados por error por el cron-resolver
  // POST /api/admin/restaurar-archivados-por-cron
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/admin/restaurar-archivados-por-cron') {
    try {
      const pedidos = leerPedidos();
      let restaurados = 0;
      const lista = [];
      for (const p of pedidos) {
        if (p.estado !== 'archivado') continue;
        // Solo los archivados por mi bug del cron-resolver
        const archivadoPorCron = Array.isArray(p.historial) && p.historial.some(h => h.por === 'cron-resolver' && h.accion === 'archivar-por-inactividad');
        if (!archivadoPorCron) continue;
        // Volver a hacer-diseno
        p.estado = 'hacer-diseno';
        delete p.archivadoEn;
        delete p.archivadoMotivo;
        p.historial = p.historial || [];
        p.historial.push({
          fecha: new Date().toISOString(),
          por: 'admin-restaurar',
          accion: 'des-archivar',
          nota: 'Archivado por error del cron-resolver (bug timestamp Chatwoot), restaurado',
        });
        restaurados++;
        lista.push({ id: p.id, equipo: p.equipo, vendedora: p.vendedora });
      }
      if (restaurados > 0) guardarPedidos(pedidos, leerNextId());
      return json(res, 200, { ok: true, restaurados, lista });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORZAR RESOLVEDOR DE ATASCOS AHORA (no esperar 30 min)
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/admin/forzar-resolver-atascos') {
    try {
      try { fs.unlinkSync(RESOLVER_STATE_FILE); } catch {}
      await cronResolverAtascosTick();
      // Devolver pedidos por estado actualizado
      const pedidos = leerPedidos();
      const porEstado = {};
      for (const p of pedidos) {
        porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;
      }
      return json(res, 200, { ok: true, porEstado, mensaje: 'ver consola del servidor para detalle' });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORZAR cron de aprobacion Chatwoot AHORA (no esperar 10 min)
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/admin/forzar-cron-aprobacion') {
    try {
      // Borrar state para que reprocese todos
      try { fs.unlinkSync(APROBACION_STATE_FILE); } catch {}
      await cronDetectarAprobacionChatwootTick();
      return json(res, 200, { ok: true, mensaje: 'cron ejecutado, ver consola servidor' });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }




  // ═══════════════════════════════════════════════════════════════════
  // VIGILANTE W&S — GET para que Camilo vea que pasa AHORA en cada PC
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url === '/api/admin/que-pasa-ahora') {
    try {
      const snapsPath = path.join(__dirname, 'data', 'pcs-vivos.json');
      let snaps = {};
      try { snaps = JSON.parse(fs.readFileSync(snapsPath, 'utf8')); } catch {}
      const ahora = Date.now();
      // Anotar cada PC con "online" si snapshot < 3min
      const pcs = Object.entries(snaps).map(([pc, s]) => {
        const ageSec = Math.floor((ahora - new Date(s.recibidoEn || s.ts).getTime()) / 1000);
        return { pc, ageSec, online: ageSec < 180, ...s };
      });
      pcs.sort((a, b) => a.pc.localeCompare(b.pc));
      return json(res, 200, { pcs, generado: new Date().toISOString() });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Dashboard HTML "QUE PASA AHORA"
  if (req.method === 'GET' && req.url === '/admin/que-pasa-ahora') {
    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Que pasa AHORA - W&S</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: 'Segoe UI', sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:20px; }
h1 { color:#a78bfa; margin:0 0 20px; font-size:24px; }
.subtitle { color:#94a3b8; font-size:13px; margin-bottom:30px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(380px, 1fr)); gap:20px; }
.card { background:#1e293b; border-radius:12px; padding:20px; border-left:4px solid #475569; }
.card.online { border-left-color:#22c55e; }
.card.offline { border-left-color:#ef4444; opacity:0.6; }
.card.warn { border-left-color:#f59e0b; }
.pc-name { font-size:20px; font-weight:700; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center; }
.status { font-size:11px; padding:3px 10px; border-radius:10px; font-weight:600; }
.status.online { background:#22c55e22; color:#22c55e; }
.status.offline { background:#ef444422; color:#ef4444; }
.host { font-size:11px; color:#64748b; margin-bottom:14px; }
.row { display:flex; justify-content:space-between; margin:6px 0; font-size:13px; }
.label { color:#94a3b8; }
.val { color:#e2e8f0; font-weight:500; max-width:60%; text-align:right; word-break:break-word; }
.foco { background:#312e81; border-radius:6px; padding:8px 10px; margin:10px 0; font-size:13px; }
.foco.diseno { background:#14532d; }
.foco.no_laboral { background:#7f1d1d; }
.tag { display:inline-block; background:#374151; border-radius:6px; padding:2px 8px; font-size:11px; margin:2px 4px 2px 0; }
.tag.bad { background:#7f1d1d; color:#fca5a5; }
.tag.good { background:#14532d; color:#86efac; }
.divider { border-top:1px solid #334155; margin:14px 0 10px; }
.section-label { color:#a78bfa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin:10px 0 6px; }
.empty { color:#64748b; font-size:12px; font-style:italic; }
.bar { display:flex; height:8px; border-radius:4px; overflow:hidden; background:#0f172a; margin:6px 0; }
.bar-fill.diseno { background:#22c55e; }
.bar-fill.comunicacion { background:#3b82f6; }
.bar-fill.no_laboral { background:#ef4444; }
.bar-fill.idle { background:#475569; }
.bar-fill.otros { background:#a78bfa; }
.bar-text { font-size:10px; color:#94a3b8; margin-top:4px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; }
.refresh-btn { background:#7c3aed; color:#fff; border:0; padding:8px 18px; border-radius:8px; font-weight:600; cursor:pointer; }
.refresh-btn:hover { background:#6d28d9; }
.empty-state { text-align:center; color:#64748b; padding:60px 20px; }
.archivo { color:#fde047; font-weight:600; }
</style></head><body>
<h1>QUE PASA AHORA en cada PC</h1>
<div class="subtitle">Actualizado automaticamente cada 15 segundos. <button class="refresh-btn" onclick="cargar()">Refrescar</button> <span id="ultima"></span></div>
<div id="contenido" class="grid"></div>
<script>
function fmtTiempo(seg) {
  if (seg < 60) return seg + 's';
  if (seg < 3600) return Math.floor(seg/60) + 'm';
  return Math.floor(seg/3600) + 'h ' + Math.floor((seg%3600)/60) + 'm';
}
function fmtMin(min) {
  if (!min) return '0m';
  if (min < 60) return min + 'm';
  return Math.floor(min/60) + 'h ' + (min%60) + 'm';
}
async function cargar() {
  const r = await fetch('/api/admin/que-pasa-ahora');
  const data = await r.json();
  document.getElementById('ultima').textContent = ' Ultimo refresh: ' + new Date().toLocaleTimeString();
  const cont = document.getElementById('contenido');
  if (!data.pcs || data.pcs.length === 0) {
    cont.innerHTML = '<div class="empty-state">Ninguna PC reportando todavia. Cuando el vigilante envie su primer snapshot, aparecera aqui.</div>';
    return;
  }
  cont.innerHTML = data.pcs.map(p => renderPc(p)).join('');
}
function renderPc(p) {
  const cls = !p.online ? 'offline' : (p.programasNoLaborales && p.programasNoLaborales.length > 0 ? 'warn' : 'online');
  const t = p.tiempoHoyMin || {};
  const total = (t.diseno||0) + (t.comunicacion||0) + (t.no_laboral||0) + (t.idle||0) + (t.otros||0);
  const pct = (n) => total > 0 ? (n/total*100).toFixed(0) : 0;
  const focoCat = p.foco?.categoria || 'desconocido';
  const focoNombre = p.foco?.programa || p.foco?.proceso || 'nada';
  const archivoStr = p.corelActivo?.archivo ? '<span class="archivo">' + p.corelActivo.archivo + '</span>' : '<span class="empty">ninguno</span>';
  const chatsHtml = (p.chatsWhatsApp && p.chatsWhatsApp.length > 0)
    ? p.chatsWhatsApp.slice(0,3).map(c => '<span class="tag good">' + (c.nombre || c.chat) + (c.telefono ? ' (' + c.telefono + ')' : '') + ' <small>['+c.fuente+']</small></span>').join('')
    : '<span class="empty">ninguno</span>';
  const noLabHtml = (p.programasNoLaborales && p.programasNoLaborales.length > 0)
    ? p.programasNoLaborales.map(n => '<span class="tag bad">'+n.tipo+'</span>').join('')
    : '<span class="empty">ninguno</span>';
  const usbHtml = (p.usbs?.conectados?.length > 0)
    ? p.usbs.conectados.map(u => '<span class="tag">'+u+'</span>').join('')
    : '<span class="empty">ninguno</span>';
  return '<div class="card '+cls+'">' +
    '<div class="pc-name">' + p.pc + '<span class="status '+(p.online?'online':'offline')+'">'+(p.online?'EN VIVO':'OFFLINE')+'</span></div>' +
    '<div class="host">' + (p.hostname||'') + ' · v' + (p.vigilanteVersion||'?') + ' · hace ' + fmtTiempo(p.ageSec) + '</div>' +
    '<div class="foco '+focoCat+'">FOCO AHORA: <b>' + focoNombre + '</b> <small>('+focoCat+')</small></div>' +
    '<div class="row"><span class="label">Archivo en Corel</span><span class="val">'+archivoStr+'</span></div>' +
    '<div class="row"><span class="label">Programas abiertos</span><span class="val">'+(p.programasActivos||[]).join(', ')+'</span></div>' +
    '<div class="row"><span class="label">Idle</span><span class="val">'+(p.idleSeg ?? '?')+'s</span></div>' +
    '<div class="row"><span class="label">Uptime PC</span><span class="val">'+fmtMin(p.uptimeMin)+'</span></div>' +
    '<div class="divider"></div>' +
    '<div class="section-label">Tiempo HOY (' + fmtMin(total) + ' total)</div>' +
    '<div class="bar">' +
      '<div class="bar-fill diseno" style="width:'+pct(t.diseno||0)+'%"></div>' +
      '<div class="bar-fill comunicacion" style="width:'+pct(t.comunicacion||0)+'%"></div>' +
      '<div class="bar-fill otros" style="width:'+pct(t.otros||0)+'%"></div>' +
      '<div class="bar-fill no_laboral" style="width:'+pct(t.no_laboral||0)+'%"></div>' +
      '<div class="bar-fill idle" style="width:'+pct(t.idle||0)+'%"></div>' +
    '</div>' +
    '<div class="bar-text">' +
      '<span style="color:#22c55e">Diseno '+fmtMin(t.diseno)+'</span>' +
      '<span style="color:#3b82f6">Comunic '+fmtMin(t.comunicacion)+'</span>' +
      '<span style="color:#a78bfa">Otros '+fmtMin(t.otros)+'</span>' +
      '<span style="color:#ef4444">NoLab '+fmtMin(t.no_laboral)+'</span>' +
      '<span style="color:#64748b">Idle '+fmtMin(t.idle)+'</span>' +
    '</div>' +
    '<div class="section-label">Chats activos</div>' + chatsHtml +
    '<div class="section-label">Programas NO laborales</div>' + noLabHtml +
    '<div class="section-label">USBs conectados</div>' + usbHtml +
  '</div>';
}
cargar();
setInterval(cargar, 15000);
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // VIGILANTE W&S — endpoint que reciben los agentes locales en cada PC
  // de los disenadores. Cuando aparece archivo en corel/PDF RIP/CATALOGO,
  // el vigilante reporta aca:
  //   { pc, carpeta, archivo, evento, ts }
  // Matchea por nombre del equipo y avanza el estado del pedido.
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/agente-evento') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const { pc, carpeta, archivo, evento, ts } = data;
        if (!pc || !evento) return json(res, 400, { error: 'falta pc o evento' });

        // Heartbeat: solo log, no procesa archivo
        if (evento === 'heartbeat') {
          console.log(`[agente] heartbeat de ${pc}`);
          return json(res, 200, { ok: true, heartbeat: true });
        }

        if (!carpeta || !archivo) return json(res, 400, { error: 'falta carpeta o archivo' });

        console.log(`[agente] ${pc} ${evento} ${carpeta}/${archivo}`);

        // Matchear con pedido por nombre del archivo (sin extension)
        const nombreSinExt = archivo.replace(/\.[^.]+$/, '').trim();
        const peds = leerPedidos();
        const ESTADOS_FINALES = new Set(['enviado-final','archivado','cancelado']);
        const candidatos = peds.filter(p => {
          if (ESTADOS_FINALES.has(p.estado)) return false;
          return nombresCoinciden(p.equipo, nombreSinExt) ||
                 (p.pushNameCliente && nombresCoinciden(p.pushNameCliente, nombreSinExt)) ||
                 (Array.isArray(p.archivosAlias) && p.archivosAlias.some(a => nombresCoinciden(a, nombreSinExt)));
        });

        const carpetaNorm = String(carpeta).toLowerCase();
        const accion = { pc, archivo, carpeta: carpetaNorm, ts, candidatos: candidatos.length };

        // Detectar tipo de archivo por extension
        const extArchivo = (archivo.match(/\.([^.]+)$/i)?.[1] || '').toLowerCase();
        const esCDR = extArchivo === 'cdr';
        const esEXPORT_VISUAL = ['jpg', 'jpeg', 'png', 'pdf'].includes(extArchivo);

        // Caso 1: 1 candidato claro → vincular y avanzar
        if (candidatos.length === 1) {
          const p = candidatos[0];
          let cambio = null;
          if (carpetaNorm === 'corel') {
            // (a) Si es .cdr → arranco diseño
            if (esCDR && !p.disenoIniciado) {
              p.disenoIniciado = true;
              p.fechaDisenoIniciado = ts || new Date().toISOString();
              p.disenadorReal = pc;
              cambio = 'diseno-iniciado';
            }
            // (b) Si es JPG/PNG/PDF y YA hay disenoIniciado → es EXPORT para mostrar al cliente
            //     Marcar pedido como "diseno listo para aprobacion del cliente"
            else if (esEXPORT_VISUAL && p.disenoIniciado && !p.disenoListoParaAprobacion) {
              p.disenoListoParaAprobacion = true;
              p.fechaDisenoListo = ts || new Date().toISOString();
              p.archivoVisualExportado = archivo;
              cambio = 'diseno-listo-para-aprobacion';
              // WA a vendedora: "ya hiciste el JPG, vas a mandar al cliente?"
              try {
                const msgV = `🎨 *Diseño listo para mostrar al cliente*\n\n` +
                  `Pedido: *${p.equipo}* (#${p.id})\n` +
                  `Exportaste: ${archivo}\n\n` +
                  `📤 ¿Ya se lo mandaste al cliente para que apruebe?\n` +
                  `Cuando responda en Chatwoot, yo detecto la aprobacion y avanzo el pedido solo.`;
                notificarWAVendedora(p.vendedora, msgV).catch(()=>{});
              } catch {}
            }
            // (c) Si es JPG/PNG/PDF SIN .cdr previo → tambien marcar diseno-iniciado
            else if (esEXPORT_VISUAL && !p.disenoIniciado) {
              p.disenoIniciado = true;
              p.fechaDisenoIniciado = ts || new Date().toISOString();
              p.disenadorReal = pc;
              p.archivoVisualExportado = archivo;
              cambio = 'diseno-iniciado-via-export';
            }
          } else if (carpetaNorm === 'pdf-rip' || carpetaNorm === 'pdfrip') {
            if (!p.pdfDriveListo) {
              p.pdfDriveListo = true;
              p.fechaPdfDrive = ts || new Date().toISOString();
              cambio = 'pdf-rip-listo';
            }
            // Avanzar a confirmado si seguia en hacer-diseno
            if (p.estado === 'hacer-diseno') {
              p.estado = 'confirmado';
              p.disenadorReal = p.disenadorReal || pc;
              cambio = (cambio ? cambio + '+' : '') + 'avance-a-confirmado';
            }
          } else if (carpetaNorm === 'catalogo') {
            if (!p.enCatalogo) {
              p.enCatalogo = true;
              p.fechaCatalogo = ts || new Date().toISOString();
              cambio = 'catalogado';
            }
          }
          if (cambio) {
            p.ultimoMovimiento = new Date().toISOString();
            // Guardar alias para futuras vinculaciones por el mismo nombre
            if (!Array.isArray(p.archivosAlias)) p.archivosAlias = [];
            const aliasLimpio = nombreLimpio(nombreSinExt);
            if (aliasLimpio && !p.archivosAlias.includes(aliasLimpio)) p.archivosAlias.push(aliasLimpio);
            guardarPedidos(peds, leerNextId());
            console.log(`[agente] #${p.id} ${p.equipo} -> ${cambio} (PC ${pc})`);
            // Avanzar a enviado-calandra si ambas senales (PDF + WT) estan
            try {
              if (typeof evaluarPasoCalandra === 'function') evaluarPasoCalandra(p);
              guardarPedidos(peds, leerNextId());
            } catch {}
            // Notif al jefe (dedupe por pedido+cambio+dia)
            const dedupeKey = `agente:${p.id}:${cambio}:${new Date().toISOString().slice(0,10)}`;
            if (waPuedeEnviar(dedupeKey)) {
              const eq = p.equipo || `#${p.id}`;
              const iconos = { 'diseno-iniciado': '✏️', 'pdf-rip-listo': '📄', 'catalogado': '📸' };
              const ico = iconos[cambio.split('+')[0]] || '🎨';
              const msg = `${ico} *Avance auto #${p.id} ${eq}*\n` +
                `PC: ${pc}\nArchivo: ${archivo}\nEstado: ${cambio}`;
              notificarJefes(msg, { dedupeKey, soloJefe: true }).catch(()=>{});
            }
            accion.matcheado = true;
            accion.pedidoId = p.id;
            accion.cambio = cambio;
          } else {
            accion.matcheado = true;
            accion.pedidoId = p.id;
            accion.cambio = 'ya-marcado';
          }
        }
        // Caso 2: 0 candidatos → archivo huerfano, alerta al jefe
        else if (candidatos.length === 0) {
          const dedupeKey = `agente-huerfano:${archivo}:${pc}:${new Date().toISOString().slice(0,10)}`;
          if (waPuedeEnviar(dedupeKey)) {
            const msg = `🟡 *Archivo huerfano detectado*\n\n` +
              `PC: ${pc}\nCarpeta: ${carpeta}\nArchivo: ${archivo}\n\n` +
              `No encontre pedido con nombre parecido. ¿Renombrarlo o crear pedido?`;
            notificarJefes(msg, { dedupeKey, soloJefe: true }).catch(()=>{});
          }
          accion.matcheado = false;
          accion.razon = 'sin-candidatos';
        }
        // Caso 3: multiples candidatos → preguntar al jefe
        else {
          const dedupeKey = `agente-ambiguo:${archivo}:${pc}:${new Date().toISOString().slice(0,10)}`;
          if (waPuedeEnviar(dedupeKey)) {
            const lista = candidatos.slice(0, 5).map(c => `• #${c.id} ${c.equipo} (${c.vendedora})`).join('\n');
            const msg = `🟠 *Archivo ambiguo*\n\nPC: ${pc}\nArchivo: ${archivo}\n\n` +
              `Match con ${candidatos.length} pedidos:\n${lista}\n\n` +
              `Responde: *vincular N ${candidatos[0].id}* (donde N es el pedido correcto).`;
            notificarJefes(msg, { dedupeKey, soloJefe: true }).catch(()=>{});
          }
          accion.matcheado = false;
          accion.razon = 'ambiguo';
          accion.candidatosIds = candidatos.map(c => c.id);
        }

        return json(res, 200, { ok: true, accion });
      } catch (e) {
        console.error('[agente-evento]', e.message);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/admin/disparar-cron?cron=cazar-dis|arreglos|calandra|aprobacion|zombi ──
  // Permite forzar la ejecucion de cualquier cron del flujo automatizado
  // sin esperar el intervalo. Util para verificar que estan funcionando.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/disparar-cron')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cron = u.searchParams.get('cron');
      const mapa = {
        'cazar-dis': typeof cronCazarDisenadoresTick === 'function' ? cronCazarDisenadoresTick : null,
        'arreglos': typeof cronAuditarArreglosTick === 'function' ? cronAuditarArreglosTick : null,
        'calandra': typeof cronAlertaCalandraTick === 'function' ? cronAlertaCalandraTick : null,
        'aprobacion': typeof cronDetectarAprobacionTick === 'function' ? cronDetectarAprobacionTick : null,
        'zombi': typeof cronInstanciasZombiTick === 'function' ? cronInstanciasZombiTick : null,
      };
      if (!cron || !mapa[cron]) {
        return json(res, 400, { error: 'cron invalido', disponibles: Object.keys(mapa) });
      }
      const fn = mapa[cron];
      if (!fn) return json(res, 500, { error: `cron ${cron} no esta disponible` });
      const inicio = Date.now();
      await fn();
      return json(res, 200, { ok: true, cron, duracionMs: Date.now() - inicio });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  // ── POST /api/admin/reset-recordatorios-factura ──
  // La migracion v1 de 2026-06-02 marco TODOS los pedidos viejos con
  // recordatorioFacturaEnviado=true. Esto sileancio para siempre los
  // recordatorios de pedidos antiguos sin factura.
  // Este endpoint resetea el flag para pedidos:
  //   - Sin factura asociada
  //   - No en estados cerrados
  //   - Marcados por la migracion (recordatorioFacturaFecha = 'migracion-2026-06-02')
  // Y dispara el cron para que mande los recordatorios ahora.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/reset-recordatorios-factura')) {
    try {
      const peds = leerPedidos();
      const ESTADOS_CERRADOS = new Set(['enviado-final', 'archivado', 'cancelado']);
      const reset = [];
      for (const p of peds) {
        if (ESTADOS_CERRADOS.has(p.estado)) continue;
        if (p.recordatorioFacturaFecha !== 'migracion-2026-06-02') continue;
        // verificar si ya tiene factura
        try {
          const facts = (typeof db.leerFacturasPorPedido === 'function')
            ? (db.leerFacturasPorPedido(p.id) || [])
            : [];
          if (facts.length > 0) continue; // sigue ok, tiene factura
        } catch (e) {}
        p.recordatorioFacturaEnviado = false;
        delete p.recordatorioFacturaFecha;
        reset.push({ id: p.id, equipo: p.equipo, vendedora: p.vendedora });
      }
      if (reset.length) guardarPedidos(peds, leerNextId());
      // Disparar cron ahora para que envie los recordatorios
      let enviadoAhora = 0;
      try {
        if (typeof cronRecordatorioFacturaTick === 'function') {
          await cronRecordatorioFacturaTick();
          enviadoAhora = 1;
        }
      } catch (e) {}
      return json(res, 200, { ok: true, reseteados: reset.length, detalle: reset, cronDisparado: enviadoAhora });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack || '').slice(0, 500) });
    }
  }

  if (req.method === 'GET' && req.url.startsWith('/api/admin/sticker-audit')) {
    try {
      const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim());
      const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 10').all().map(r => r.fecha);
      const pedidos = leerPedidos();
      const tomb = idsArchivados();
      const out = [];
      for (const fecha of fechas) {
        const events = db.leerEvolutionEvents(fecha);
        for (const ev of events) {
          const ed = ev.data || ev;
          if (ed?.messageType !== 'stickerMessage') continue;
          const stk = ed.message?.stickerMessage || {};
          const hash = stk.fileSha256 ? Buffer.from(Object.values(stk.fileSha256)).toString('hex') : '';
          const fromMe = ed.key?.fromMe;
          const remoteJid = ed.key?.remoteJid || '';
          const tel = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
          if (!STICKERS_VENTA.includes(hash)) continue;
          if (fromMe !== true) continue;
          const instance = ev.instance || '?';
          const vendedora = vendedoraDeInstancia(instance);
          // Buscar pedido del cliente
          const pedidosCliente = pedidos.filter(p => String(p.telefono || '').replace(/\D/g, '') === tel);
          const tieneSticker = pedidosCliente.some(p => p.stickerVenta === hash);
          out.push({
            fecha,
            instance,
            vendedoraEsperada: vendedora,
            telefono: tel,
            pushName: ed.pushName || '',
            hayPedidoConSticker: tieneSticker,
            pedidosDelCliente: pedidosCliente.map(p => ({ id: p.id, estado: p.estado, equipo: p.equipo, ven: p.vendedora, ts: p.ultimoMovimiento, stickerVenta: p.stickerVenta })),
            archivado: pedidosCliente.some(p => tomb.has(p.id)),
            diagnostico: tieneSticker
              ? 'OK: pedido tiene stickerVenta marcado'
              : pedidosCliente.length === 0
                ? 'FALLO: NO se creo pedido para este cliente'
                : 'PARCIAL: hay pedido pero sin stickerVenta — posible race condition',
          });
        }
      }
      out.sort((a, b) => b.fecha.localeCompare(a.fecha));
      const falladosCount = out.filter(o => o.diagnostico.startsWith('FALLO')).length;
      const okCount = out.filter(o => o.diagnostico.startsWith('OK')).length;
      const parcialCount = out.filter(o => o.diagnostico.startsWith('PARCIAL')).length;
      return json(res, 200, {
        totalStickersValidos: out.length,
        ok: okCount,
        fallados: falladosCount,
        parciales: parcialCount,
        items: out,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/diag-stickers — lista stickers enviados hoy con hash y fromMe ──
  if (req.method === 'GET' && req.url === '/api/admin/diag-stickers') {
    try {
      const desde = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      // Buscar en TODOS los eventos de los ultimos 10 dias (puede haber muchos)
      const rows = db.raw.prepare('SELECT fecha, data FROM evolution_events WHERE fecha >= ? ORDER BY id DESC').all(desde);
      const stickers = [];
      const hashCount = {};
      for (const row of rows) {
        try {
          const ev = JSON.parse(row.data);
          const d = ev.data || {};
          if (d.messageType !== 'stickerMessage') continue;
          const sm = d.message?.stickerMessage || {};
          const hash = sm.fileSha256 ? Buffer.from(sm.fileSha256, 'base64').toString('hex') : null;
          hashCount[hash] = (hashCount[hash] || 0) + 1;
          if (stickers.length < 30) {
            stickers.push({
              fecha: row.fecha,
              instance: ev.instance,
              fromMe: d.key?.fromMe,
              jid: d.key?.remoteJid,
              pushName: d.pushName,
              hash: hash ? hash.slice(0, 20) + '...' : null,
              hashCompleto: hash,
            });
          }
        } catch {}
      }
      const STICKER_VENTA_HASH = process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995';
      return json(res, 200, {
        configurado: STICKER_VENTA_HASH,
        hashesUsadosHoy: hashCount,
        coincidencias: Object.entries(hashCount).filter(([h]) => STICKER_VENTA_HASH.includes(h)).length,
        stickers,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/recuperar-pedidos-comprobante — re-crea pedidos faltantes ──
  // Busca comprobantes_detectados que apuntan a un pedidoAutoCreado que ya no existe en pedidos.json
  // y los re-crea con los datos del comprobante.
  if (req.method === 'POST' && req.url === '/api/admin/recuperar-pedidos-comprobante') {
    try {
      const comps = db.leerComprobantes();
      const pedidosActuales = leerPedidos();
      const idsExistentes = new Set(pedidosActuales.map(p => p.id));
      const tomb = idsArchivados();
      const recuperados = [];
      const procesadosId = new Set();

      // Agrupar comprobantes por pedidoAutoCreado
      const compsPorPedido = new Map();
      for (const c of comps) {
        if (!c.pedidoAutoCreado) continue;
        if (idsExistentes.has(c.pedidoAutoCreado)) continue; // ya existe
        if (tomb.has(c.pedidoAutoCreado)) continue; // archivado deliberadamente
        if (!compsPorPedido.has(c.pedidoAutoCreado)) compsPorPedido.set(c.pedidoAutoCreado, []);
        compsPorPedido.get(c.pedidoAutoCreado).push(c);
      }

      const pedidosNuevos = [...pedidosActuales];
      for (const [pedidoId, lista] of compsPorPedido.entries()) {
        const ultimoComp = lista[lista.length - 1];
        const ven = ultimoComp.vendedora || '';
        const vendedoraNorm = ven ? (ven.charAt(0).toUpperCase() + ven.slice(1).toLowerCase()) : '';
        const reconstruido = {
          id: pedidoId,
          equipo: ultimoComp.cliente || 'Cliente +57 ' + (ultimoComp.telefono || '?'),
          telefono: ultimoComp.telefono || '',
          vendedora: vendedoraNorm,
          tipoBandeja: 'pedido',
          estado: 'hacer-diseno',
          creadoEn: new Date(ultimoComp.ts || Date.now()).toLocaleDateString('es-CO'),
          ultimoMovimiento: ultimoComp.ts || new Date().toISOString(),
          items: [],
          fechaEntrega: '',
          notas: 'Recuperado desde comprobantes_detectados',
          arreglo: null,
          origenComprobante: true,
          montoComprobante: ultimoComp.monto || null,
          bancoComprobante: ultimoComp.banco || null,
          confianzaComprobante: ultimoComp.confianza,
          recuperadoTs: new Date().toISOString(),
        };
        pedidosNuevos.push(reconstruido);
        recuperados.push({ id: pedidoId, cliente: reconstruido.equipo, monto: reconstruido.montoComprobante, vendedora: reconstruido.vendedora });
        procesadosId.add(pedidoId);
      }

      if (recuperados.length) {
        // Ordenar por id
        pedidosNuevos.sort((a, b) => a.id - b.id);
        guardarPedidos(pedidosNuevos, leerNextId());
      }
      return json(res, 200, { recuperados: recuperados.length, detalle: recuperados });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }


  // ── GET /api/admin/test-lote-borrar?id=XX — borra un lote de prueba ──
  if (req.method === 'GET' && req.url.startsWith('/api/admin/test-lote-borrar')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const id = parseInt(u.searchParams.get('id') || '0', 10);
      if (!id) return json(res, 400, { error: 'falta id' });
      db.raw.prepare('DELETE FROM costureras_movimientos WHERE id = ?').run(id);
      return json(res, 200, { ok: true, borrado: id });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ── POST /api/admin/recuperar-pedidos-desde-comprobantes?dryRun=1 ──
  // Para cada teléfono que tiene comprobantes pero NINGÚN pedido activo en la app,
  // crea un pedido huerfano con vendedora derivada del comprobante (Betty/Ney/etc).
  // Suma todos sus comprobantes como abonado. Esto recupera ventas reales que el
  // vendedor olvido oficializar con sticker.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/recuperar-pedidos-desde-comprobantes')) {
    (async () => {
      try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const dryRun = u.searchParams.get('dryRun') === '1';
        const comps = db.leerComprobantes();
        const pedidos = leerPedidos();
        const normTel = t => String(t || '').replace(/\D/g, '').slice(-10);
        const telsConPedido = new Set(pedidos.filter(p => p.estado !== 'enviado-final').map(p => normTel(p.telefono)));
        // Agrupar comprobantes por telefono normalizado, solo los sin pedido
        const porTel = new Map();
        for (const c of comps) {
          if (!c.monto || c.monto <= 0) continue;
          const tel = normTel(c.telefono);
          if (!tel) continue;
          if (telsConPedido.has(tel)) continue;
          if (!porTel.has(tel)) porTel.set(tel, { tel, telOriginal: String(c.telefono).replace(/\D/g, ''), comps: [], total: 0, vendedora: null, cliente: null, remoteJid: null });
          const g = porTel.get(tel);
          g.comps.push(c);
          g.total += c.monto;
          if (!g.vendedora && c.vendedora) g.vendedora = c.vendedora;
          if (!g.cliente && c.cliente) g.cliente = c.cliente;
          if (!g.remoteJid && c.remoteJid) g.remoteJid = c.remoteJid;
        }
        const acciones = [];
        for (const [tel, g] of porTel.entries()) {
          const vendedora = g.vendedora || 'Betty';
          let nombreCliente = g.cliente;
          // Si el "cliente" en comprobante es solo emoji o telefono, intentar Chatwoot
          if (!nombreCliente || /^\d+$/.test(nombreCliente) || nombreCliente.length < 2 || /^[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}]+$/u.test(nombreCliente)) {
            try {
              const resuelto = await resolverCliente(g.remoteJid || (tel + '@s.whatsapp.net'), tel, g.cliente || '');
              nombreCliente = resuelto.nombre || `Cliente +57 ${tel}`;
            } catch { nombreCliente = `Cliente +57 ${tel}`; }
          }
          if (dryRun) {
            acciones.push({ tel, vendedora, cliente: nombreCliente, total: g.total, comps: g.comps.length });
            continue;
          }
          // Crear pedido
          const r = crearVentaInterna('pedido', vendedora, g.telOriginal || tel, null, nombreCliente);
          if (!r.ok || !r.id) { acciones.push({ tel, fallo: r.error }); continue; }
          // Marcar como recuperado + sumar abonado de TODOS sus comprobantes
          const todos = leerPedidos();
          const pd = todos.find(x => x.id === r.id);
          if (pd) {
            pd.estado = 'hacer-diseno';
            pd.tipoBandeja = 'pedido';
            pd.origenComprobante = true;
            pd.notas = pd.notas || `Recuperado de ${g.comps.length} comprobante(s) sin pedido previo`;
            pd.ultimoMovimiento = new Date().toISOString();
            _inicializarPagosPedido(pd);
            for (const c of g.comps) {
              _anadirPagoAPedido(pd, {
                monto: c.monto, banco: c.banco, fecha: c.fecha,
                comprobante_id: c.id || c.messageId, origen: 'comprobante',
              });
            }
            pd.historial = pd.historial || [];
            pd.historial.push({
              fecha: new Date().toISOString(),
              por: 'admin-recuperar-comprobantes',
              accion: 'crear-desde-comprobantes',
              nota: `${g.comps.length} comprobante(s) sumados: $${g.total.toLocaleString('es-CO')}`,
            });
            guardarPedidos(todos, leerNextId());
          }
          acciones.push({ tel, vendedora, cliente: nombreCliente, total: g.total, comps: g.comps.length, pedido_id: r.id });
        }
        const totalRecuperado = acciones.reduce((s, a) => s + (a.total || 0), 0);
        return json(res, 200, {
          dryRun,
          totalClientes: porTel.size,
          totalRecuperado,
          acciones: acciones.sort((a, b) => (b.total || 0) - (a.total || 0)),
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/admin/vincular-comprobantes-huerfanos?dryRun=1 ──
  // Toma todos los comprobantes_detectados y los suma al "abonado" del pedido
  // del mismo telefono activo. Necesario para que el resumen domingo refleje
  // cartera real (sin esto, todos los abonado=0 a pesar de $7M+ en comprobantes).
  if (req.method === 'POST' && req.url.startsWith('/api/admin/vincular-comprobantes-huerfanos')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const dryRun = u.searchParams.get('dryRun') === '1';
      const comps = db.leerComprobantes();
      const acciones = [];
      let totalVinculado = 0;
      for (const c of comps) {
        if (!c.monto || c.monto <= 0) continue;
        if (!c.telefono) continue;
        // Saltar si ya fue procesado por el handler en vivo (tiene pedidoAutoCreado
        // O vimos arriba que se vinculo)
        if (c.vinculadoBulk) continue;
        if (dryRun) {
          const pedidos = leerPedidos();
          const tel = String(c.telefono).replace(/\D/g, '');
          const candidatos = pedidos.filter(x => {
            if (!x.telefono) return false;
            if (x.estado === 'enviado-final') return false;
            return String(x.telefono).replace(/\D/g, '') === tel;
          });
          if (candidatos.length === 0) {
            acciones.push({ comp_id: c.id || c.messageId, monto: c.monto, tel, motivo: 'sin-pedido-activo' });
          } else {
            acciones.push({ comp_id: c.id || c.messageId, monto: c.monto, tel, pedidoId: candidatos[0].id, dryRun: true });
            totalVinculado += c.monto;
          }
          continue;
        }
        // Vinculacion real
        const r = vincularComprobanteAPedido({
          telefono: c.telefono,
          monto: c.monto,
          banco: c.banco,
          fecha: c.fecha,
          comprobante_id: c.id || c.messageId,
        });
        if (r.vinculado) {
          totalVinculado += c.monto;
          // Marcar comprobante como ya procesado para evitar doble-conteo
          try { db.marcarComprobanteVinculado && db.marcarComprobanteVinculado(c.id || c.messageId); } catch {}
        }
        acciones.push({ comp_id: c.id || c.messageId, monto: c.monto, tel: c.telefono, ...r });
      }
      return json(res, 200, {
        dryRun,
        total: acciones.length,
        vinculados: acciones.filter(a => a.vinculado || a.dryRun).length,
        sinPedido: acciones.filter(a => !a.vinculado && !a.dryRun && (a.motivo === 'sin-pedido' || a.motivo === 'sin-pedido-activo')).length,
        duplicados: acciones.filter(a => a.motivo === 'duplicado').length,
        totalMontoVinculado: totalVinculado,
        acciones: acciones.slice(0, 50),
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/vincular-facturas-huerfanas — crea pedidos para facturas sin pedido_id ──
  // Útil para arreglar facturas históricas que se crearon sin pedido en la app.
  // Query: ?dryRun=1 para solo ver qué pasaría sin modificar nada.
  if (req.method === 'POST' && req.url.startsWith('/api/admin/vincular-facturas-huerfanas')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const dryRun = u.searchParams.get('dryRun') === '1';
      const facturas = db.leerFacturas(500, 0) || [];
      const pedidos = leerPedidos();
      const accionesPropuestas = [];
      let maxId = Math.max(0, ...pedidos.map(p => p.id || 0));
      // Helper: normaliza nombre vendedora factura ("Betty Forero") al nombre corto ("Betty")
      // que coincide con personas.js para que Mi Dia filtre correctamente.
      const normalizarVendedora = (nombre) => {
        if (!nombre) return null;
        const n = String(nombre).toLowerCase().trim();
        const vend = PERSONAS.filter(p => (p.roles || []).includes('ventas'));
        for (const p of vend) {
          const corto = p.nombre.toLowerCase();
          if (n === corto || n.includes(corto)) return p.nombre;
        }
        return nombre;
      };

      // Set de IDs de pedidos existentes para detectar facturas con pedido_id huerfano
      const pedidoIdsExistentes = new Set(pedidos.map(p => p.id));
      for (const f of facturas) {
        // Si pedido_id apunta a un pedido que NO existe, limpiar para recrearlo
        if (f.pedido_id && !pedidoIdsExistentes.has(f.pedido_id)) {
          db.raw.prepare('UPDATE facturas SET pedido_id = NULL WHERE id = ?').run(f.id);
          f.pedido_id = null;
        }
        if (f.pedido_id) continue; // ya vinculada a pedido existente
        if (f.tipo !== 'factura') continue; // ignoramos cotizaciones
        // Buscar pedido existente del mismo cliente/telefono
        const tel = String(f.cliente_telefono || '').replace(/\D/g, '');
        let pedidoExist = null;
        if (tel) {
          pedidoExist = pedidos.find(p => String(p.telefono || '').replace(/\D/g, '') === tel);
        }
        if (!pedidoExist && f.cliente_nombre) {
          // Match por nombre exacto (case-insensitive)
          const nm = String(f.cliente_nombre).toLowerCase().trim();
          pedidoExist = pedidos.find(p => String(p.cliente || '').toLowerCase().trim() === nm
            || String(p.equipo || '').toLowerCase().trim() === nm);
        }
        if (pedidoExist) {
          accionesPropuestas.push({
            accion: 'vincular',
            factura_id: f.id,
            factura_numero: f.numero,
            pedido_id: pedidoExist.id,
            cliente: f.cliente_nombre,
            total: f.total,
          });
          if (!dryRun) {
            // Actualizar factura.pedido_id (necesita helper en db) y total del pedido si no tiene
            db.raw.prepare('UPDATE facturas SET pedido_id = ? WHERE id = ?').run(pedidoExist.id, f.id);
            if ((!pedidoExist.total || pedidoExist.total === 0) && f.total) {
              pedidoExist.total = Number(f.total);
              _recalcularEstadoPago(pedidoExist);
              pedidoExist.historial = pedidoExist.historial || [];
              pedidoExist.historial.push({
                fecha: new Date().toISOString(),
                por: 'admin-vincular-huerfanas',
                accion: 'set-total',
                nota: `Total $${pedidoExist.total.toLocaleString('es-CO')} tomado de factura huérfana #${f.numero}`,
              });
            }
          }
        } else {
          // Crear pedido nuevo desde los datos de la factura
          const nuevoId = ++maxId;
          const nuevoPedido = {
            id: nuevoId,
            cliente: f.cliente_nombre || ('Cliente +57 ' + tel),
            equipo: f.cliente_nombre || ('Cliente +57 ' + tel),
            telefono: f.cliente_telefono || null,
            vendedora: normalizarVendedora(f.vendedora) || null,
            estado: 'bandeja',
            origenFacturaHuerfana: f.id,
            total: Number(f.total) || null,
            abonado: 0,
            pagos: [],
            fechaVenta: (f.fecha || f.creado_en || new Date().toISOString()).slice(0, 10),
            ultimoMovimiento: new Date().toISOString(),
            historial: [{
              fecha: new Date().toISOString(),
              por: 'admin-vincular-huerfanas',
              accion: 'crear-pedido',
              nota: `Pedido creado desde factura huérfana #${f.numero}`,
            }],
          };
          _recalcularEstadoPago(nuevoPedido);
          accionesPropuestas.push({
            accion: 'crear',
            factura_id: f.id,
            factura_numero: f.numero,
            nuevo_pedido_id: nuevoId,
            cliente: f.cliente_nombre,
            vendedora: f.vendedora,
            total: f.total,
          });
          if (!dryRun) {
            pedidos.push(nuevoPedido);
            db.raw.prepare('UPDATE facturas SET pedido_id = ? WHERE id = ?').run(nuevoId, f.id);
          }
        }
      }
      if (!dryRun && accionesPropuestas.length) {
        db.guardarPedidos(pedidos);
      }
      return json(res, 200, {
        dryRun, total: accionesPropuestas.length,
        acciones: accionesPropuestas,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/pagos-pedido/:id — estado financiero detallado de un pedido ──
  if (req.method === 'GET' && /^\/api\/admin\/pagos-pedido\/\d+/.test(req.url)) {
    try {
      const id = parseInt(req.url.match(/^\/api\/admin\/pagos-pedido\/(\d+)/)[1], 10);
      const pedidos = leerPedidos();
      const p = pedidos.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no encontrado' });
      _recalcularEstadoPago(p);
      return json(res, 200, {
        pedido: {
          id: p.id, cliente: p.cliente, equipo: p.equipo, vendedora: p.vendedora,
          telefono: p.telefono, estado: p.estado, fechaEntrega: p.fechaEntrega,
        },
        total: p.total,
        abonado: p.abonado,
        saldoPendiente: p.saldoPendiente,
        pagadoCompleto: p.pagadoCompleto,
        pagos: p.pagos || [],
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ── GET /api/admin/pagos-resumen — overview de cartera + pedidos con saldo ──
  if (req.method === 'GET' && req.url.startsWith('/api/admin/pagos-resumen')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const incluirSinTotal = u.searchParams.get('sintotal') === '1';
      const pedidos = leerPedidos();
      const conTotal = [];
      const sinTotal = [];
      let carteraViva = 0;
      let abonadoTotal = 0;
      let totalAcordadoTotal = 0;
      for (const p of pedidos) {
        if (p.estado === 'enviado-final') continue; // ya despachados no cuentan a cartera
        _recalcularEstadoPago(p);
        const row = {
          id: p.id, cliente: p.cliente, equipo: p.equipo, vendedora: p.vendedora,
          estado: p.estado, fechaEntrega: p.fechaEntrega,
          total: p.total, abonado: p.abonado, saldoPendiente: p.saldoPendiente,
          pagadoCompleto: p.pagadoCompleto,
          numPagos: (p.pagos || []).length,
        };
        if (typeof p.total === 'number' && p.total > 0) {
          conTotal.push(row);
          totalAcordadoTotal += p.total;
          abonadoTotal += p.abonado;
          if (p.saldoPendiente > 0) carteraViva += p.saldoPendiente;
        } else if (incluirSinTotal) {
          sinTotal.push(row);
        }
      }
      // Top 5 saldos mayores
      const topSaldos = conTotal
        .filter(r => r.saldoPendiente > 0)
        .sort((a, b) => b.saldoPendiente - a.saldoPendiente)
        .slice(0, 10);
      return json(res, 200, {
        resumen: {
          carteraViva,
          abonadoTotal,
          totalAcordadoTotal,
          pedidosConTotal: conTotal.length,
          pedidosPagados: conTotal.filter(r => r.pagadoCompleto).length,
          pedidosConSaldo: conTotal.filter(r => r.saldoPendiente > 0).length,
          pedidosSinTotal: sinTotal.length,
        },
        topSaldos,
        sinTotal: incluirSinTotal ? sinTotal : undefined,
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ── POST /api/admin/pagos-pedido/:id/agregar — registrar pago manual ──
  // Body: { monto, banco?, nota?, fecha? }
  if (req.method === 'POST' && /^\/api\/admin\/pagos-pedido\/\d+\/agregar/.test(req.url)) {
    const id = parseInt(req.url.match(/^\/api\/admin\/pagos-pedido\/(\d+)/)[1], 10);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (!data.monto) return json(res, 400, { error: 'monto requerido' });
        const pedidos = leerPedidos();
        const p = pedidos.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'pedido no encontrado' });
        const ok = _anadirPagoAPedido(p, {
          monto: data.monto,
          banco: data.banco || 'manual',
          fecha: data.fecha || new Date().toISOString(),
          nota: data.nota || null,
          origen: 'manual',
        });
        if (!ok) return json(res, 200, { ok: false, motivo: 'duplicado' });
        db.guardarPedidos(pedidos);
        return json(res, 200, {
          ok: true,
          abonado: p.abonado,
          saldoPendiente: p.saldoPendiente,
          pagadoCompleto: p.pagadoCompleto,
        });
      } catch (e) { return json(res, 500, { error: e.message }); }
    });
    return;
  }

  // ── POST /api/admin/pagos-pedido/:id/total — setear/editar total esperado ──
  // Body: { total }   (admin puede definir el precio acordado cuando no hay factura)
  if (req.method === 'POST' && /^\/api\/admin\/pagos-pedido\/\d+\/total/.test(req.url)) {
    const id = parseInt(req.url.match(/^\/api\/admin\/pagos-pedido\/(\d+)/)[1], 10);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const pedidos = leerPedidos();
        const p = pedidos.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'pedido no encontrado' });
        const totalNuevo = data.total === null ? null : (Number(data.total) || null);
        p.total = totalNuevo;
        _recalcularEstadoPago(p);
        p.historial = p.historial || [];
        p.historial.push({
          fecha: new Date().toISOString(),
          por: 'admin',
          accion: 'set-total',
          nota: `Total ${totalNuevo ? '$' + totalNuevo.toLocaleString('es-CO') : 'borrado'}`,
        });
        db.guardarPedidos(pedidos);
        return json(res, 200, {
          ok: true,
          total: p.total,
          abonado: p.abonado,
          saldoPendiente: p.saldoPendiente,
          pagadoCompleto: p.pagadoCompleto,
        });
      } catch (e) { return json(res, 500, { error: e.message }); }
    });
    return;
  }

  // ── GET /api/admin/alertas-calandra — preview/dispara alertas calandra +24h ──
  // Query: ?enviar=1 (envía); sin enviar solo muestra los candidatos detectados.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/alertas-calandra')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const enviar = u.searchParams.get('enviar') === '1';
      const candidatos = detectarPedidosCalandraSinDescargar();
      let resultado = { enviados: 0, candidatos };
      if (enviar) {
        resultado = await enviarAlertasCalandraSinDescargar();
      }
      return json(res, 200, resultado);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/resumen-semanal — dispara el resumen del domingo manualmente ──
  // Util para probar sin esperar al domingo o regenerar el reporte.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/resumen-semanal')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const enviar = u.searchParams.get('enviar') === '1';
      const data = await generarResumenSemanalAdmin();
      const texto = construirMensajeResumenSemanal(data);
      let enviadoWA = false, enviadoTG = false;
      if (enviar) {
        await responderJefe(texto);
        enviadoWA = true;
        try { await notificarTelegramAdmin(texto); enviadoTG = true; } catch (e) {}
      }
      return json(res, 200, { data, texto, enviadoWA, enviadoTG });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/docs-wa — lista documentos salientes capturados ──
  // Query: ?desde=ISO|semana|hoy   ?solo=pendientes
  if (req.method === 'GET' && req.url.startsWith('/api/admin/docs-wa')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const desde = u.searchParams.get('desde') || 'semana';
      const solo = u.searchParams.get('solo') || '';
      let docs;
      if (solo === 'pendientes') {
        docs = db.leerDocumentosSalientesWANoRevisados();
      } else {
        let desdeIso;
        if (desde === 'hoy') {
          desdeIso = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
        } else if (desde === 'semana') {
          const d = new Date(); d.setDate(d.getDate() - 7);
          desdeIso = d.toISOString();
        } else {
          desdeIso = desde;
        }
        docs = db.leerDocumentosSalientesWASemana(desdeIso);
      }
      // Agrupar por vendedora
      const porVendedora = {};
      for (const d of docs) {
        if (!porVendedora[d.vendedora]) porVendedora[d.vendedora] = [];
        porVendedora[d.vendedora].push({
          id: d.id, cliente: d.cliente_telefono, push: d.cliente_push_name,
          mime: d.tipo_mime, bytes: d.bytes, drive: d.drive_link,
          revisado: !!d.revisado, esFactura: d.es_factura,
          gemini: !!d.gemini_analizado, fecha: d.fecha_captura,
        });
      }
      return json(res, 200, { total: docs.length, porVendedora });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/diag-drive-fact — diagnostico subida a Drive ──
  if (req.method === 'GET' && req.url === '/api/admin/diag-drive-fact') {
    try {
      const facturas = db.leerFacturas(200, 0);
      const sinDrive = facturas.filter(f => !f.drive_file_id);
      const conDrive = facturas.filter(f => f.drive_file_id);
      // Probar subida con PDF dummy
      let testUpload = null;
      try {
        const minimalPdf = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000051 00000 n\n0000000095 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n140\n%%EOF', 'utf8').toString('base64');
        const subida = await driveSync.subirArchivo({
          titulo: `TEST-DIAG-${Date.now()}.pdf`,
          mimeType: 'application/pdf',
          contentBase64: minimalPdf,
          parentId: driveSync.FOLDER_FACTURAS,
        });
        testUpload = { ok: true, ...subida };
      } catch (e) {
        testUpload = { ok: false, error: e.message };
      }
      return json(res, 200, {
        totalFacturas: facturas.length,
        sinDrive: sinDrive.length,
        conDrive: conDrive.length,
        carpetaFacturas: driveSync.FOLDER_FACTURAS,
        carpetaCotizaciones: driveSync.FOLDER_COTIZACIONES,
        testUpload,
        primeras3SinDrive: sinDrive.slice(0, 3).map(f => ({ id: f.id, numero: f.numero, tipo: f.tipo, fecha: f.fecha, cliente: f.cliente_nombre })),
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/diag-notion — info de configuracion actual de Notion ──
  if (req.method === 'GET' && req.url === '/api/admin/diag-notion') {
    try {
      const dbEnv = process.env.NOTION_DB_ARCHIVO_PEDIDOS || null;
      const dbUsada = NOTION_DB_DEFAULT; // forzado al ID nuevo, env var ignorada
      // Verificar que la DB es accesible
      let info = null;
      let error = null;
      if (process.env.NOTION_TOKEN) {
        try {
          const r = await fetch('https://api.notion.com/v1/databases/' + dbUsada, {
            headers: {
              'Authorization': 'Bearer ' + process.env.NOTION_TOKEN,
              'Notion-Version': '2022-06-28',
            },
          });
          const data = await r.json();
          if (r.ok) {
            info = {
              title: (data.title || []).map(t => t.plain_text || '').join(''),
              props: Object.keys(data.properties || {}),
            };
          } else {
            error = data.message || ('HTTP ' + r.status);
          }
        } catch (e) { error = e.message; }
      }
      return json(res, 200, {
        envSet: !!dbEnv,
        envValue: dbEnv ? (dbEnv.slice(0, 8) + '...' + dbEnv.slice(-4)) : null,
        defaultHardcoded: NOTION_DB_DEFAULT,
        dbEnUso: dbUsada,
        tokenConfigurado: !!process.env.NOTION_TOKEN,
        info, error,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/migrar-pedidos-a-notion?dryRun=1&estados=todos|cerrados ──
  // Sube pedidos existentes a la DB de Notion (histórico). Útil para poblar la DB
  // de una vez con los pedidos que ya cerraron o están en curso, sin esperar al
  // ciclo natural de archivar.
  // estados=cerrados → solo los enviado-final/listo (default)
  // estados=todos → TODOS los activos (riesgo de duplicado si alguno ya estaba)
  // estados=conpagos → solo los que tienen abonado > 0 (recomendado para historico)
  if (req.method === 'POST' && req.url.startsWith('/api/admin/migrar-pedidos-a-notion')) {
    (async () => {
      try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const dryRun = u.searchParams.get('dryRun') === '1';
        const estadosParam = u.searchParams.get('estados') || 'conpagos';
        const idsParam = u.searchParams.get('ids');
        const pedidos = leerPedidos();
        let candidatos;
        if (idsParam) {
          const setIds = new Set(idsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean));
          candidatos = pedidos.filter(p => setIds.has(p.id));
        } else if (estadosParam === 'cerrados') {
          candidatos = pedidos.filter(p => ['enviado-final', 'listo'].includes(p.estado));
        } else if (estadosParam === 'todos') {
          candidatos = pedidos.slice();
        } else { // conpagos (default)
          candidatos = pedidos.filter(p => (p.abonado || 0) > 0);
        }
        if (dryRun) {
          return json(res, 200, {
            dryRun: true,
            total: candidatos.length,
            preview: candidatos.slice(0, 30).map(p => ({
              id: p.id, vendedora: p.vendedora, estado: p.estado, equipo: p.equipo,
              telefono: p.telefono, total: p.total, abonado: p.abonado,
            })),
          });
        }
        // Permite override del token (útil cuando Railway tiene token viejo sin acceso
        // a la DB nueva). Pasar via query ?token=ntn_... (URL-encoded)
        const tokenOverride = u.searchParams.get('token') || null;
        const acciones = [];
        for (const p of candidatos) {
          const r = await archivarPedidoEnNotion(p, tokenOverride);
          if (r.ok) {
            acciones.push({ id: p.id, equipo: p.equipo, ok: true, notionPageId: r.notionPageId });
          } else {
            acciones.push({ id: p.id, equipo: p.equipo, ok: false, motivo: r.motivo, detalle: r.detalle });
          }
        }
        return json(res, 200, {
          total: candidatos.length,
          ok: acciones.filter(a => a.ok).length,
          fallos: acciones.filter(a => !a.ok).length,
          acciones,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/admin/resubir-facturas-sin-drive ──
  // Toma todas las facturas con drive_file_id=null y sube un .txt resumen a Drive.
  // Esto es backup para facturas viejas que se crearon antes de tener Drive conectado.
  // El PDF original no se conserva, pero queda registro accesible.
  if (req.method === 'POST' && req.url === '/api/admin/resubir-facturas-sin-drive') {
    (async () => {
      try {
        const facturas = db.leerFacturas(500, 0);
        const sinDrive = facturas.filter(f => !f.drive_file_id);
        const acciones = [];
        for (const f of sinDrive) {
          try {
            const items = Array.isArray(f.items) ? f.items : (typeof f.items === 'string' ? JSON.parse(f.items || '[]') : []);
            const fmt = n => '$' + (Number(n)||0).toLocaleString('es-CO');
            const lineas = [
              `═══════════════════════════════════════════`,
              `  ${(f.tipo === 'cotizacion' ? 'COTIZACIÓN' : 'FACTURA').toUpperCase()} #${f.numero}`,
              `═══════════════════════════════════════════`,
              ``,
              `Fecha:      ${f.fecha || '-'}`,
              `Cliente:    ${f.cliente_nombre || '-'}`,
              `Teléfono:   ${f.cliente_telefono || '-'}`,
              `NIT:        ${f.cliente_nit || '-'}`,
              `Correo:     ${f.cliente_correo || '-'}`,
              `Vendedora:  ${f.vendedora || '-'}`,
              ``,
              `─── ITEMS ───`,
            ];
            items.forEach((it, idx) => {
              lineas.push(`${idx+1}. ${it.descripcion || it.concepto || '-'}`);
              lineas.push(`   Cant: ${it.cantidad || 1}  |  Vr.Unit: ${fmt(it.precio || it.valor || 0)}  |  Subtotal: ${fmt((it.cantidad || 1) * (it.precio || it.valor || 0))}`);
            });
            lineas.push(``);
            lineas.push(`─── TOTALES ───`);
            lineas.push(`Subtotal:   ${fmt(f.subtotal)}`);
            lineas.push(`Abono:      ${fmt(f.abono)}`);
            lineas.push(`TOTAL:      ${fmt(f.total)}`);
            if (f.notas) {
              lineas.push(``);
              lineas.push(`Notas: ${f.notas}`);
            }
            lineas.push(``);
            lineas.push(`─── RECONSTRUCCIÓN ───`);
            lineas.push(`Este archivo se generó como backup tardío en Drive.`);
            lineas.push(`El PDF original no existe. Para regenerarlo, abrir la factura en la app y exportar de nuevo.`);
            lineas.push(`Factura ID interna: ${f.id}`);
            lineas.push(`Creada: ${f.creado_en || '-'}`);
            const contenido = lineas.join('\n');
            const buff = Buffer.from(contenido, 'utf8');
            const parentId = f.tipo === 'cotizacion' ? driveSync.FOLDER_COTIZACIONES : driveSync.FOLDER_FACTURAS;
            const titulo = `${f.tipo === 'cotizacion' ? 'COTIZACION' : 'FACTURA'} ${f.numero}${f.cliente_nombre ? ' - ' + f.cliente_nombre : ''}.txt`;
            const subida = await driveSync.subirArchivo({
              titulo,
              mimeType: 'text/plain; charset=utf-8',
              contentBase64: buff.toString('base64'),
              parentId,
            });
            try { await driveSync.hacerArchivoPublico(subida.id); } catch (eP) { console.warn('[resubir] no público:', eP.message); }
            db.setFacturaDrive(f.id, subida.id, subida.viewLink);
            acciones.push({ factura_id: f.id, numero: f.numero, ok: true, drive_id: subida.id, link: subida.viewLink });
          } catch (eF) {
            acciones.push({ factura_id: f.id, numero: f.numero, ok: false, error: eF.message });
          }
        }
        return json(res, 200, {
          total: sinDrive.length,
          exitosas: acciones.filter(a => a.ok).length,
          fallidas: acciones.filter(a => !a.ok).length,
          acciones,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── GET /api/admin/diag-eventos — diagnostico: cuantos eventos hay por tipo/fecha ──
  if (req.method === 'GET' && req.url === '/api/admin/diag-eventos') {
    try {
      const total = db.raw.prepare('SELECT COUNT(*) as n FROM evolution_events').get().n;
      const porFecha = db.raw.prepare('SELECT fecha, COUNT(*) as n FROM evolution_events GROUP BY fecha ORDER BY fecha DESC LIMIT 30').all();
      const ultimos = db.raw.prepare('SELECT fecha, data FROM evolution_events ORDER BY id DESC LIMIT 20').all();
      const tipos = {};
      let conImagen = 0;
      let imagenesEntrantes = 0;
      const muestraImg = [];
      const allRows = db.raw.prepare('SELECT fecha, data FROM evolution_events ORDER BY id DESC LIMIT 5000').all();
      for (const r of allRows) {
        try {
          const ev = JSON.parse(r.data);
          const d = ev.data || ev.payload?.data || {};
          const t = d.messageType || ev.event || 'desconocido';
          tipos[t] = (tipos[t] || 0) + 1;
          if (d.messageType === 'imageMessage') {
            conImagen++;
            if (d.key?.fromMe === false) {
              imagenesEntrantes++;
              if (muestraImg.length < 5) muestraImg.push({ fecha: r.fecha, instance: ev.instance, jid: d.key?.remoteJid, id: d.key?.id, pushName: d.pushName });
            }
          }
        } catch {}
      }
      return json(res, 200, { totalEventos: total, porFecha, tiposEn500Recientes: tipos, conImagenEn500: conImagen, imagenesEntrantesEn500: imagenesEntrantes, muestraImg, ultimoEvento: ultimos[0] ? { fecha: ultimos[0].fecha, sample: ultimos[0].data.slice(0, 300) } : null });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/test/reprocesar-imagen — reprocesa un mensaje de Evolution con el flujo COMPLETO ──
  // Body: { instance, jid, id, vendedora?, simularPedido?, simularWA? }
  // Toma una imagen ya recibida via Evolution → Gemini → si comprobante: crear pedido + WA
  if (req.method === 'POST' && req.url === '/api/test/reprocesar-imagen') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      const log = [];
      try {
        const data = JSON.parse(body);
        const { instance, jid, id, vendedora: vendOverride, simularPedido, simularWA } = data;
        if (!instance || !jid || !id) return json(res, 400, { error: 'faltan params instance/jid/id' });
        const vendedora = vendOverride || vendedoraDeInstancia(instance);

        log.push(`[1/5] Descargando imagen desde Evolution...`);
        const inicio = Date.now();
        const img = await descargarImagenEvolution(instance, { remoteJid: jid, fromMe: false, id });
        if (!img || !img.base64) {
          log.push(`[1/5] FALLO: no se pudo descargar`);
          return json(res, 500, { ok: false, error: 'descarga fallo', log });
        }
        log.push(`[1/5] OK — ${(img.base64.length/1024).toFixed(1)} KB base64`);

        log.push(`[2/5] Analizando con Gemini...`);
        const tIni = Date.now();
        const analisis = await analizarImagenConGemini(img.base64, img.mimeType);
        log.push(`[2/5] ${Date.now()-tIni}ms — ${JSON.stringify(analisis)}`);

        if (!analisis?.esComprobante) {
          return json(res, 200, { ok: true, analisis, pedidoCreado: null, waEnviado: false, log });
        }

        // Validacion de beneficiario
        const validacion = validarBeneficiarioWS(analisis.destinatario_nombre);
        log.push(`[2.4] Beneficiario: "${analisis.destinatario_nombre}" → ${validacion.esParaWS ? 'ES W&S ✅' : 'NO ES W&S ❌ ' + validacion.motivo}`);
        if (!validacion.esParaWS) {
          return json(res, 200, { ok: true, analisis, descartado: true, motivo: validacion.motivo, pedidoCreado: null, waEnviado: false, log });
        }

        const telefonoCliente = jid.replace('@s.whatsapp.net', '').replace('@g.us', '').split('-')[0];
        const { nombre: nombreCliente } = await resolverCliente(jid, telefonoCliente, '');
        log.push(`[2.5] Cliente resuelto: ${nombreCliente}`);

        let pedidoCreado = null;
        if (simularPedido !== false && analisis.confianza !== 'baja') {
          log.push(`[3/5] Creando pedido en bandeja para ${vendedora}...`);
          const resCrear = crearVentaInterna('pedido', vendedora, telefonoCliente, 'test-' + id, nombreCliente);
          if (resCrear.ok && !resCrear.duplicado) {
            pedidoCreado = resCrear.id;
            const pps = leerPedidos();
            const pp = pps.find(x => x.id === pedidoCreado);
            if (pp) {
              pp.origenComprobante = true;
              pp.montoComprobante = analisis.monto;
              pp.bancoComprobante = analisis.banco;
              pp.testMode = true;
              guardarPedidos(pps, leerNextId());
            }
            log.push(`[3/5] OK — pedido #${pedidoCreado}`);
          } else {
            log.push(`[3/5] ${resCrear.duplicado ? 'DUPLICADO existente: #' + resCrear.id : 'FALLO: ' + resCrear.error}`);
            pedidoCreado = resCrear.id || null;
          }
        }

        log.push(`[4/5] Guardando comprobante...`);
        guardarComprobanteDetectado({
          messageId: id,
          vendedora,
          telefono: telefonoCliente,
          cliente: nombreCliente,
          monto: analisis.monto,
          banco: analisis.banco,
          confianza: analisis.confianza,
          ts: new Date().toISOString(),
          pedidoAutoCreado: pedidoCreado,
          stickerEnviado: false,
          testMode: true,
        });

        let waEnviado = false;
        if (simularWA !== false) {
          log.push(`[5/5] Mandando WA a ${vendedora} desde ws-duvan...`);
          try {
            const montoTxt = analisis.monto ? `$${Number(analisis.monto).toLocaleString('es-CO')}` : 'monto no detectado';
            const bancoTxt = analisis.banco && analisis.banco !== 'desconocido' ? ` por ${analisis.banco}` : '';
            const pedidoTxt = pedidoCreado ? `📋 Pedido #${pedidoCreado} creado en bandeja\n` : '';
            const rDia = resumenDiaVendedora(vendedora);
            const msg = `🧪 *PRUEBA REAL — Pago detectado* ${montoTxt}${bancoTxt}\n\n` +
              `👤 ${nombreCliente}\n` +
              `📱 ${telefonoCliente}\n` +
              pedidoTxt +
              `\n📊 *TU DIA HASTA AHORA:*\n` +
              `✅ ${rDia.conSticker} con sticker\n` +
              `⚠️ ${rDia.sinSticker} SIN sticker (este incluido)\n` +
              `💰 Detectado: ${_formatearMontoCOP(rDia.totalMonto)}\n\n` +
              `👉 *Pasa el sticker 💰 al chat del cliente* para oficializar.\n\n` +
              `_Este es un TEST con un comprobante REAL del ${analisis.fecha || 'pasado'}. Ignora si ya lo procesaste antes._`;
            await notificarWAVendedora(vendedora, msg);
            waEnviado = true;
            log.push(`[5/5] OK — WA enviado a ${vendedora}`);
          } catch (e) {
            log.push(`[5/5] FALLO WA: ${e.message}`);
          }
        }

        return json(res, 200, { ok: true, analisis, vendedora, cliente: nombreCliente, telefono: telefonoCliente, pedidoCreado, waEnviado, tiempo_ms: Date.now()-inicio, log });
      } catch (e) {
        log.push(`ERROR: ${e.message}`);
        return json(res, 500, { error: e.message, log });
      }
    });
    return;
  }

  // ── GET /api/test/imagenes-recientes?dias=7 — lista todas las imagenes entrantes ──
  // Recorre los evolution_events buscando messageType=imageMessage con fromMe=false.
  // Devuelve datos para identificar cada una.
  if (req.method === 'GET' && req.url.startsWith('/api/test/imagenes-recientes')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const dias = parseInt(u.searchParams.get('dias') || '7', 10);
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
      const rows = db.raw.prepare('SELECT fecha, data FROM evolution_events WHERE fecha >= ? ORDER BY fecha DESC, id DESC').all(desde);
      const imgs = [];
      for (const row of rows) {
        try {
          const ev = JSON.parse(row.data);
          const d = ev.data || ev.payload?.data || {};
          if (d.messageType !== 'imageMessage') continue;
          const k = d.key || {};
          if (k.fromMe === true) continue; // solo entrantes
          const im = d.message?.imageMessage || {};
          imgs.push({
            fecha: row.fecha,
            ts: ev.date_time || d.messageTimestamp,
            instance: ev.instance || ev.payload?.instance,
            pushName: d.pushName || '',
            telefono: (k.remoteJid || '').replace('@s.whatsapp.net', '').replace('@g.us', ''),
            remoteJid: k.remoteJid,
            id: k.id,
            caption: (im.caption || '').slice(0, 100),
          });
        } catch {}
      }
      return json(res, 200, { total: imgs.length, dias, imagenes: imgs.slice(0, 200) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/admin/reprocesar-historico — procesa comprobantes historicos en lote ──
  // Body: { dias?: 14, max?: 20, dryRun?: false, simularWA?: false }
  // 1) Lista imagenes entrantes 1:1 (no @g.us), dedupe por messageId
  // 2) Excluye ids ya procesados (estan en comprobantes_detectados)
  // 3) Para cada uno: descarga → Gemini → valida beneficiario → crea pedido si aplica
  // 4) Devuelve resumen detallado
  if (req.method === 'POST' && req.url === '/api/admin/reprocesar-historico') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const opts = body ? JSON.parse(body) : {};
        const dias = parseInt(opts.dias || 14, 10);
        const max = parseInt(opts.max || 20, 10);
        const dryRun = opts.dryRun === true;
        const simularWA = opts.simularWA !== false; // por defecto NO mandar WA en historico
        const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
        const rows = db.raw.prepare('SELECT fecha, data FROM evolution_events WHERE fecha >= ? ORDER BY fecha ASC, id ASC').all(desde);

        // 1. Recopilar imagenes entrantes 1:1 unicas
        const yaProcesados = new Set();
        try {
          for (const c of db.leerComprobantes()) {
            if (c.messageId) yaProcesados.add(c.messageId);
          }
        } catch {}

        const candidatos = new Map(); // key: messageId, val: {instance, jid, id, fecha, pushName}
        for (const row of rows) {
          try {
            const ev = JSON.parse(row.data);
            const d = ev.data || {};
            if (d.messageType !== 'imageMessage') continue;
            const k = d.key || {};
            if (k.fromMe === true) continue;
            const jid = k.remoteJid || '';
            if (jid.includes('@g.us')) continue; // solo 1:1
            if (!k.id) continue;
            if (yaProcesados.has(k.id)) continue;
            if (candidatos.has(k.id)) continue;
            candidatos.set(k.id, {
              instance: ev.instance,
              jid,
              id: k.id,
              fecha: row.fecha,
              pushName: d.pushName || '',
              telefono: jid.replace('@s.whatsapp.net', '').replace('@g.us', '').split('-')[0],
            });
          } catch {}
        }

        const lista = Array.from(candidatos.values()).slice(0, max);
        const total = candidatos.size;

        if (dryRun) {
          return json(res, 200, { dryRun: true, total, procesariamos: lista.length, muestra: lista.slice(0, 20), yaProcesadosCount: yaProcesados.size });
        }

        const resultados = { total, procesados: 0, comprobantes: 0, pedidosCreados: 0, descartados: 0, errores: 0, descartesPorMotivo: {}, detalle: [] };

        for (const c of lista) {
          const item = { instance: c.instance, telefono: c.telefono, fecha: c.fecha, id: c.id.slice(0, 12) };
          try {
            const vendedora = vendedoraDeInstancia(c.instance);
            const img = await descargarImagenEvolution(c.instance, { remoteJid: c.jid, fromMe: false, id: c.id });
            if (!img || !img.base64) {
              item.error = 'descarga fallo';
              resultados.errores++;
              resultados.detalle.push(item);
              continue;
            }
            const analisis = await analizarImagenConGemini(img.base64, img.mimeType);
            resultados.procesados++;
            if (!analisis?.esComprobante) {
              item.resultado = 'no es comprobante';
              resultados.detalle.push(item);
              continue;
            }
            resultados.comprobantes++;
            item.banco = analisis.banco;
            item.monto = analisis.monto;
            item.destinatario = analisis.destinatario_nombre;

            const validacion = validarBeneficiarioWS(analisis.destinatario_nombre);
            if (!validacion.esParaWS) {
              item.resultado = 'descartado: ' + validacion.motivo;
              resultados.descartados++;
              const motCorto = (validacion.motivo || '').split(':')[0].trim() || 'desconocido';
              resultados.descartesPorMotivo[motCorto] = (resultados.descartesPorMotivo[motCorto] || 0) + 1;
              // Guardar comprobante descartado para no reprocesarlo
              guardarComprobanteDetectado({
                messageId: c.id, vendedora, telefono: c.telefono, cliente: c.pushName,
                monto: analisis.monto, banco: analisis.banco, confianza: analisis.confianza,
                ts: new Date().toISOString(), descartado: true, motivoDescarte: validacion.motivo,
              });
              resultados.detalle.push(item);
              continue;
            }

            const { nombre: nombreCliente } = await resolverCliente(c.jid, c.telefono, c.pushName || '');
            let pedidoCreado = null;
            if (analisis.confianza !== 'baja') {
              const resCrear = crearVentaInterna('pedido', vendedora, c.telefono, 'hist-' + c.id, nombreCliente);
              if (resCrear.ok && !resCrear.duplicado) {
                pedidoCreado = resCrear.id;
                const pps = leerPedidos();
                const pp = pps.find(x => x.id === pedidoCreado);
                if (pp) {
                  pp.origenComprobante = true;
                  pp.montoComprobante = analisis.monto;
                  pp.bancoComprobante = analisis.banco;
                  pp.fechaComprobante = analisis.fecha || c.fecha;
                  guardarPedidos(pps, leerNextId());
                }
                resultados.pedidosCreados++;
              } else if (resCrear.duplicado) {
                pedidoCreado = resCrear.id;
              }
            }
            guardarComprobanteDetectado({
              messageId: c.id, vendedora, telefono: c.telefono, cliente: nombreCliente,
              monto: analisis.monto, banco: analisis.banco, confianza: analisis.confianza,
              ts: new Date().toISOString(), pedidoAutoCreado: pedidoCreado, stickerEnviado: false,
            });
            item.cliente = nombreCliente;
            item.pedidoCreado = pedidoCreado;
            item.resultado = pedidoCreado ? `pedido #${pedidoCreado} creado` : 'comprobante guardado';
          } catch (e) {
            item.error = e.message;
            resultados.errores++;
          }
          resultados.detalle.push(item);
        }

        resultados.restantes = total - lista.length;
        return json(res, 200, resultados);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/test/comprobante — prueba end-to-end con imagen real ──
  // Body: { imageUrl: "https://...", vendedora: "Betty", telefonoCliente: "573...", nombreCliente?: "Maria",
  //         simularPedido?: bool, simularWA?: bool }
  // Ejecuta: descargar → Gemini → si es comprobante crear pedido y mandar WA a vendedora.
  // Devuelve trazabilidad completa de cada paso.
  if (req.method === 'POST' && req.url === '/api/test/comprobante') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      const log = [];
      try {
        const data = JSON.parse(body);
        const { imageUrl, vendedora, telefonoCliente, nombreCliente, simularPedido, simularWA } = data;
        if (!imageUrl) return json(res, 400, { error: 'falta imageUrl' });
        if (!vendedora) return json(res, 400, { error: 'falta vendedora' });
        if (!telefonoCliente) return json(res, 400, { error: 'falta telefonoCliente' });

        log.push(`[1/5] Descargando imagen: ${imageUrl}`);
        const inicio = Date.now();
        const r1 = await fetch(imageUrl);
        if (!r1.ok) return json(res, 400, { error: 'no se pudo descargar imagen', status: r1.status, log });
        const buffer = Buffer.from(await r1.arrayBuffer());
        const base64 = buffer.toString('base64');
        const mimeType = r1.headers.get('content-type') || 'image/jpeg';
        log.push(`[1/5] OK — ${(buffer.length/1024).toFixed(1)} KB, mime=${mimeType}, ${Date.now()-inicio}ms`);

        log.push(`[2/5] Analizando con Gemini...`);
        const tIni = Date.now();
        const analisis = await analizarImagenConGemini(base64, mimeType);
        log.push(`[2/5] Gemini respondio en ${Date.now()-tIni}ms`);
        log.push(`     esComprobante: ${analisis?.esComprobante}`);
        log.push(`     banco: ${analisis?.banco}, monto: ${analisis?.monto}, confianza: ${analisis?.confianza}`);
        log.push(`     ultimoError: ${global._geminiUltimoError || 'ninguno'}`);

        if (!analisis?.esComprobante) {
          log.push(`[3/5] NO es comprobante — flujo termina aqui`);
          return json(res, 200, { ok: true, analisis, log, pedidoCreado: null, waEnviado: false });
        }

        let pedidoCreado = null;
        if (simularPedido !== false && analisis.confianza !== 'baja') {
          log.push(`[3/5] Creando pedido para ${vendedora}...`);
          const resCrear = crearVentaInterna('pedido', vendedora, telefonoCliente, 'test-' + Date.now(), nombreCliente || `Cliente +57 ${telefonoCliente}`);
          if (resCrear.ok && !resCrear.duplicado) {
            pedidoCreado = resCrear.id;
            const pps = leerPedidos();
            const pp = pps.find(x => x.id === pedidoCreado);
            if (pp) {
              pp.origenComprobante = true;
              pp.montoComprobante = analisis.monto;
              pp.bancoComprobante = analisis.banco;
              pp.testMode = true;
              guardarPedidos(pps, leerNextId());
            }
            log.push(`[3/5] OK — pedido #${pedidoCreado} creado`);
          } else {
            log.push(`[3/5] FALLO — ${resCrear.error || 'duplicado'}`);
          }
        } else {
          log.push(`[3/5] SKIP creacion pedido (simularPedido=false o confianza baja)`);
        }

        log.push(`[4/5] Guardando comprobante en DB...`);
        const registro = {
          messageId: 'test-' + Date.now(),
          vendedora,
          telefono: telefonoCliente,
          cliente: nombreCliente || `Cliente +57 ${telefonoCliente}`,
          monto: analisis.monto,
          banco: analisis.banco,
          confianza: analisis.confianza,
          ts: new Date().toISOString(),
          pedidoAutoCreado: pedidoCreado,
          stickerEnviado: false,
          testMode: true,
        };
        guardarComprobanteDetectado(registro);
        log.push(`[4/5] OK`);

        let waEnviado = false;
        if (simularWA !== false) {
          log.push(`[5/5] Mandando WA a ${vendedora} desde ws-duvan...`);
          try {
            const montoTxt = analisis.monto ? `$${Number(analisis.monto).toLocaleString('es-CO')}` : 'monto no detectado';
            const bancoTxt = analisis.banco && analisis.banco !== 'desconocido' ? ` por ${analisis.banco}` : '';
            const pedidoTxt = pedidoCreado ? `📋 Pedido #${pedidoCreado} creado en bandeja\n` : '';
            const rDia = resumenDiaVendedora(vendedora);
            const totalDiaTxt = rDia.totalMonto > 0 ? _formatearMontoCOP(rDia.totalMonto) : '$0';
            const msg = `🧪 *PRUEBA REAL — Pago detectado* ${montoTxt}${bancoTxt}\n\n` +
              `👤 ${nombreCliente || telefonoCliente}\n` +
              `📱 ${telefonoCliente}\n` +
              pedidoTxt +
              `\n📊 *TU DIA HASTA AHORA:*\n` +
              `✅ ${rDia.conSticker} con sticker\n` +
              `⚠️ ${rDia.sinSticker} SIN sticker (este incluido)\n` +
              `💰 Detectado: ${totalDiaTxt}\n\n` +
              `👉 *Pasa el sticker 💰 al chat del cliente* para oficializar.\n\n` +
              `_(Este es un TEST — ignora si no era una venta real)_`;
            await notificarWAVendedora(vendedora, msg);
            waEnviado = true;
            log.push(`[5/5] OK — WA enviado a ${vendedora}`);
          } catch (e) {
            log.push(`[5/5] FALLO WA: ${e.message}`);
          }
        } else {
          log.push(`[5/5] SKIP envio WA (simularWA=false)`);
        }

        return json(res, 200, {
          ok: true,
          analisis,
          pedidoCreado,
          waEnviado,
          tiempo_total_ms: Date.now() - inicio,
          log,
        });
      } catch (e) {
        log.push(`ERROR: ${e.message}`);
        return json(res, 500, { error: e.message, log });
      }
    });
    return;
  }

  // ── GET /api/test/gemini — diagnóstico: verifica que la API key de Gemini funcione ──
  if (req.method === 'GET' && req.url.startsWith('/api/test/gemini')) {
    (async () => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return json(res, 400, { ok: false, error: 'GEMINI_API_KEY no configurada' });
      const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const inicio = Date.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Responde SOLO con la palabra OK, nada mas.' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } },
          }),
        });
        const latencia = Date.now() - inicio;
        const data = await r.json();
        if (!r.ok) {
          return json(res, 200, {
            ok: false,
            status: r.status,
            modelo,
            error: data?.error?.message || JSON.stringify(data).slice(0, 300),
            latencia_ms: latencia,
            key_prefix: apiKey.slice(0, 8) + '...',
          });
        }
        const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return json(res, 200, {
          ok: true,
          modelo,
          respuesta: texto.trim(),
          latencia_ms: latencia,
          tokens_in: data?.usageMetadata?.promptTokenCount,
          tokens_out: data?.usageMetadata?.candidatesTokenCount,
          key_prefix: apiKey.slice(0, 8) + '...',
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message, latencia_ms: Date.now() - inicio });
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
        // Inyectamos _recv_at con la hora del server (Evolution manda date_time con
        // reloj propio que puede estar desfasado — no confiar en el para vigilancia).
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // Formato YYYY-MM-DD
        payload._recv_at = new Date().toISOString();
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

        // ═══════════════════════════════════════════════════════════════
        // LABELS WA (listas de WhatsApp) — mapeo etiqueta → estado ERP
        // Cada vendedora tiene su set de etiquetas; el ERP las reconoce y
        // avanza el pedido sin que nadie toque la app.
        // Evento: labels.association con action 'add' (al poner etiqueta).
        // 'remove' se ignora — el pedido no retrocede.
        // ═══════════════════════════════════════════════════════════════
        if (eventType === 'labels.association') {
          try {
            const instance = (payload.instance || '').toLowerCase();
            const action = eventData.association?.type || eventData.type || eventData.action || '';
            if (action !== 'add') {
              // Solo procesamos cuando AGREGAN etiqueta. Quitarla no retrocede el pedido.
              return json(res, 200, { ok: true, ignorado: 'action no es add', action });
            }

            const labelName = String(eventData.label?.name || eventData.labelName || eventData.name || '').trim();
            const BASURA = new Set(['Transferencia de la IA', 'Favoritos', 'No ledos', 'Grupos', 'Respondidos por la IA', '.', '']);
            if (BASURA.has(labelName) || labelName === '') {
              return json(res, 200, { ok: true, ignorado: 'etiqueta basura', labelName });
            }

            // Mapeo etiqueta → estado ERP, por instancia.
            // CONFIRMADO por Camilo 2026-06-22: cada vendedora usa SOLO la de
            // venta confirmada de forma confiable. Las de avance casi nunca se
            // usan, asi que el avance posterior se detecta por OTROS triggers
            // (PDFs Drive, WeTransfer Gmail, etc).
            // SOLO las etiquetas que Camilo CONFIRMO explicito (29-jun-2026).
            // Match case-insensitive (mas abajo) tolera mayus/minus/espacios.
            // NO agregar otras etiquetas aunque parezcan obvias — Camilo
            // tiene que decir que SI ("pago en casa" y "pedido en tela" se
            // inventaron y se sacaron 29-jun).
            const ETIQUETAS_POR_INSTANCIA = {
              'ws-ventas': {
                'En Proceso':              'confirmado',
                'en tela y en costura':    'costura',
                'hecho':                   'listo',
                'entregado':               'entregado',
              },
              'ws wendy': {
                'CONSIGNADO':            'confirmado',
                'Pedido finalizado':     'entregado',
              },
              'ws-wendy': { // por si llega sin espacio
                'CONSIGNADO':            'confirmado',
                'Pedido finalizado':     'entregado',
              },
              'ws-ney': {
                'Pagado':                'confirmado',
                'Venta':                 'entregado',
              },
              'ws-paola': {
                'Pedido en proceso':     'confirmado', // CORRECCION: era 'Pendiente abono' (mal)
                'Entregado':             'entregado',
              },
            };
            const VENDEDORA_POR_INSTANCIA = {
              'ws-ventas': 'Betty',
              'ws wendy':  'Wendy',
              'ws-wendy':  'Wendy',
              'ws-ney':    'Ney',
              'ws-paola':  'Paola',
            };

            const mapeo = ETIQUETAS_POR_INSTANCIA[instance];
            if (!mapeo) {
              return json(res, 200, { ok: true, ignorado: 'instancia desconocida', instance });
            }
            // Match case-insensitive (tolera "En tela" / "en tela" / "EN TELA")
            const labelLower = String(labelName || '').toLowerCase().trim();
            const mapeoLower = {};
            for (const [k, v] of Object.entries(mapeo)) {
              mapeoLower[k.toLowerCase().trim()] = v;
            }
            const estadoNuevo = mapeoLower[labelLower];
            if (!estadoNuevo) {
              console.log(`[labels-wa] ${instance}/"${labelName}" sin mapeo — ignorado`);
              return json(res, 200, { ok: true, ignorado: 'etiqueta sin mapeo', labelName });
            }

            const remoteJid = eventData.chatId || eventData.chat?.id || eventData.remoteJid || eventData.number || '';
            // Ignorar SOLO grupos. Los @lid son clientes individuales con JID moderno (WA migro chats).
            if (remoteJid.includes('@g.us')) {
              return json(res, 200, { ok: true, ignorado: 'grupo', remoteJid });
            }
            // Resolver @lid -> tel real via Postgres (remoteJidAlt del ultimo mensaje).
            // Fix 2026-07-05: antes se ignoraba @lid entero, se perdian todas las
            // etiquetas de chats modernos (ej. Alcides 573219756891 vs 233488028536934@lid).
            let telefono = '';
            if (remoteJid.includes('@lid')) {
              const dbUrl = process.env.EVOLUTION_DB_URL;
              if (!dbUrl) {
                return json(res, 200, { ok: true, ignorado: '@lid sin EVOLUTION_DB_URL', remoteJid });
              }
              const pool = new PgPool({ connectionString: dbUrl, max: 1, ssl: { rejectUnauthorized: false } });
              try {
                const r = await pool.query(
                  `SELECT key->>'remoteJidAlt' AS tel FROM "Message"
                   WHERE key->>'remoteJid' = $1 AND key->>'remoteJidAlt' LIKE '%@s.whatsapp.net'
                   ORDER BY "messageTimestamp" DESC LIMIT 1`,
                  [remoteJid]
                );
                const alt = r.rows[0]?.tel || '';
                telefono = String(alt).replace('@s.whatsapp.net', '').replace(/\D/g, '');
              } finally { await pool.end(); }
              if (!telefono) {
                return json(res, 200, { ok: true, ignorado: '@lid sin remoteJidAlt en Postgres', remoteJid });
              }
              console.log(`[labels-wa] resuelto @lid ${remoteJid} -> tel ${telefono}`);
            } else {
              telefono = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            }
            if (telefono.length < 7) {
              return json(res, 200, { ok: true, ignorado: 'telefono invalido', telefono });
            }

            const vendedora = VENDEDORA_POR_INSTANCIA[instance] || 'Betty';
            const pedidos = leerPedidos();
            const normTel = (t) => {
              const d = String(t || '').replace(/\D/g, '');
              return d.startsWith('57') ? d.slice(2) : d;
            };
            const telLimpio = normTel(telefono);

            // Buscar pedido ACTIVO (no entregado/archivado/cancelado) de este telefono
            const ESTADOS_INACTIVOS = new Set(['entregado', 'archivado', 'cancelado', 'descartado']);
            const pdActivo = pedidos.find(p =>
              normTel(p.telefono) === telLimpio &&
              !ESTADOS_INACTIVOS.has(p.estado || '')
            );

            if (pdActivo) {
              if (pdActivo.estado === estadoNuevo) {
                console.log(`[labels-wa] ${instance}/"${labelName}": pedido #${pdActivo.id} ya en ${estadoNuevo}`);
                return json(res, 200, { ok: true, sin_cambio: true, pedido_id: pdActivo.id });
              }
              const estadoPrev = pdActivo.estado;
              pdActivo.estado = estadoNuevo;
              pdActivo.ultimoMovimiento = new Date().toISOString();
              pdActivo.historial = pdActivo.historial || [];
              pdActivo.historial.push({
                ts: new Date().toISOString(),
                evento: `Etiqueta WA "${labelName}" (${instance}) → ${estadoNuevo}`,
                automatico: true,
              });
              guardarPedidos(pedidos, leerNextId());
              console.log(`[labels-wa] ${instance}/"${labelName}": pedido #${pdActivo.id} ${estadoPrev}→${estadoNuevo}`);
              // Auto-cerrar movimientos de costura abiertos si el pedido pasa
              // a estado final. Evita que aparezcan eternamente en /costura.
              const ESTADOS_FINALES = new Set(['entregado', 'enviado-final', 'archivado', 'cancelado']);
              if (ESTADOS_FINALES.has(estadoNuevo)) {
                try {
                  const cerrados = db.cerrarMovimientosAbiertosPorPedido(pdActivo.id, {
                    motivo: `auto: etiqueta WA "${labelName}" -> ${estadoNuevo}`,
                  });
                  if (cerrados > 0) console.log(`[labels-wa] auto-cerrados ${cerrados} mov(s) de #${pdActivo.id}`);
                } catch (e) { console.error('[auto-cerrar mov]', e.message); }
              }
              return json(res, 200, { ok: true, accion: 'avanzar', pedido_id: pdActivo.id, estadoPrev, estadoNuevo });
            }

            if (estadoNuevo === 'confirmado') {
              // No hay pedido + etiqueta de venta confirmada → crear nuevo
              const pushName = eventData.pushName || eventData.chat?.contact?.pushName || 'Cliente WA';
              const r = crearVentaInterna('pedido', vendedora, telefono, null, pushName);
              if (r.ok && !r.duplicado) {
                const peds2 = leerPedidos();
                const np = peds2.find(p => p.id === r.id);
                if (np) {
                  np.estado = 'confirmado';
                  np.nombreEsTentativo = true; // marca: nombre se rellena async via diseño
                  np.ultimoMovimiento = new Date().toISOString();
                  np.historial = np.historial || [];
                  np.historial.push({
                    ts: new Date().toISOString(),
                    evento: `Pedido creado por etiqueta WA "${labelName}" (${instance})`,
                    automatico: true,
                  });
                  guardarPedidos(peds2, leerNextId());
                }
                console.log(`[labels-wa] ${instance}/"${labelName}": pedido #${r.id} CREADO (${vendedora}, ${telefono})`);

                return json(res, 200, { ok: true, accion: 'crear', pedido_id: r.id, vendedora, telefono });
              }
              return json(res, 200, { ok: true, accion: 'crear-skip', resultado: r });
            }

            console.log(`[labels-wa] ${instance}/"${labelName}": sin pedido activo para ${telefono} y etiqueta no crea venta — ignorado`);
            return json(res, 200, { ok: true, ignorado: 'sin pedido activo y etiqueta no crea venta' });
          } catch (e) {
            console.error('[labels-wa error]', e.message, e.stack);
            return json(res, 500, { error: e.message });
          }
        }

        // ─────────────────────────────────────────────────────────────
        // CAPTURADOR DE POLLS — para diagnosticar formato del webhook
        // Guarda en memoria los ultimos 50 eventos relacionados con polls
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType && /poll/i.test(eventData.messageType)) {
          if (!global._ultimosPolls) global._ultimosPolls = [];
          global._ultimosPolls.unshift({
            ts: new Date().toISOString(),
            eventType,
            messageType: eventData.messageType,
            fromMe: eventData.key?.fromMe,
            remoteJid: eventData.key?.remoteJid,
            messageId: eventData.key?.id,
            pushName: eventData.pushName,
            message: eventData.message,
            payloadCompleto: payload,
          });
          if (global._ultimosPolls.length > 50) global._ultimosPolls.pop();
          console.log(`[poll-captura] ${eventData.messageType} de ${eventData.key?.remoteJid}`);
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
              '✂️': { accion: 'corte-listo', avancePedido: { de: 'llego-impresion', a: 'corte' } },
              '🪡': { accion: 'costura-lista', avancePedido: { de: 'costura', a: 'calidad' } },
              '🧵': { accion: 'costura-lista', avancePedido: { de: 'en-satelite', a: 'calidad' } },
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
            const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim()).filter(Boolean);

            const numeroPropio = (process.env.WS_PROPIO_NUMERO || '573506974711');
            const senderNumero = senderJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            // fromMe es la señal autoritativa de Baileys: el sticker salió desde nuestro WA.
            // payload.sender puede venir vacío en chats 1-a-1, así que no podemos depender solo de eso.
            const esDeNuestroWA = fromMe === true || senderNumero === numeroPropio;

            const esStickerVenta = STICKERS_VENTA.includes(stickerHash);

            if (esStickerVenta && esDeNuestroWA && esTelefonoDescartado(remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, ''))) {
              // Telefono fue borrado a proposito (lista de descartados). No procesar.
              const telDescartado = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
              console.log(`[sticker-venta] IGNORADO — tel ${telDescartado} esta en descartados`);
              resultadoApi = { ok: true, ignorado: 'tel-descartado', telefono: telDescartado };
            } else if (esStickerVenta && esDeNuestroWA) {
              // Sticker mandado DESDE el WA de ventas hacia un cliente
              const telefonoCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
              const { nombre: nombreCliente, contactoChatwoot } = await resolverCliente(remoteJid, telefonoCliente, pushName);

              console.log(`[sticker-venta] hash detectado — cliente:${telefonoCliente} nombre:"${nombreCliente}"`);

              // El sticker venta SIEMPRE crea pedido (era el flag REACCIONES_ACTIVAS, pero
              // ese flag era para emojis de reaccion 🟡🎨, no para el sticker venta oficial).
              if (telefonoCliente.length > 5) {
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
                  // Auto-asignar diseñador (vendedora-diseñadora se asigna a si misma;
                  // si no disena, va a Oscar).
                  if (!cotizacion.disenadorAsignado) {
                    cotizacion.disenadorAsignado = asignarDisenadorAutomatico(vendedora);
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
                        // Auto-asignar diseñador (vendedora-diseñadora -> ella; resto -> Oscar)
                        if (!nuevoPd.disenadorAsignado) {
                          nuevoPd.disenadorAsignado = asignarDisenadorAutomatico(vendedora);
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
                    ? `\n🎨 Diseñadora: ${vendedora}`
                    : `\n🎨 Diseñador: ${asignarDisenadorAutomatico(vendedora)}`;
                  const msgWA =
                    `💰 VENTA CONFIRMADA  #${resultadoApi.id}\n\n` +
                    `✅ ${tipoMsg === 'Cotización CONFIRMADA' ? 'El cliente ya pagó' : 'Cliente pagó directo'}\n\n` +
                    `👤 Cliente: ${nombreCliente}\n` +
                    `📞 ${telBonito}\n` +
                    `🛍️ Vendedora: ${vendedora}${lineaDisWA}\n` +
                    `📅 ${fechaCorta}\n\n` +
                    `🎨 Pedido en Hacer diseño — diseñador a trabajar\n` +
                    `📝 PENDIENTE: factura #${resultadoApi.id} (${vendedora})`;
                  notificarWhatsappTrabajoFamilia(msgWA).catch(()=>{});

                  // WA INDIVIDUAL a la vendedora — corto
                  try {
                    const msgVendedora =
                      `🎉 Venta #${resultadoApi.id} — ${nombreCliente}\n` +
                      `👉 Pregunta al cliente el nombre del equipo + emite factura.`;
                    await notificarWAVendedora(vendedora, msgVendedora);
                  } catch (eFact) { console.error('[wa-vendedora venta-confirmada]', eFact.message); }

                  // WA INDIVIDUAL al jefe + Graciela — venta nueva (con dedupe)
                  try {
                    const disenadorTxt = VENDEDORAS_DISENADORAS.has(vendedora)
                      ? vendedora : asignarDisenadorAutomatico(vendedora);
                    const msgJefe =
                      `🎯 *Venta NUEVA #${resultadoApi.id}*\n\n` +
                      `👤 ${nombreCliente}\n` +
                      `📞 ${telBonito}\n` +
                      `🛍️ Vendedora: ${vendedora}\n` +
                      `🎨 Diseñador: ${disenadorTxt}\n` +
                      `📅 ${fechaCorta}\n\n` +
                      `⏳ Esperando: nombre del equipo + factura`;
                    await notificarJefes(msgJefe, { dedupeKey: `venta-nueva-jefe:${resultadoApi.id}` });
                  } catch (eJ) { console.error('[venta-nueva notif jefes]', eJ.message); }

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
        // DETECTOR DE DISEÑO ENVIADO POR LA VENDEDORA (fromMe=true)
        // NUEVO FLUJO (basado en analisis de chats reales W&S):
        //  1. Encola en pending-approvals.json con verificarEn = now+5min
        //  2. Filtros instantaneos: pedido activo, no duplicado, no burst
        //  3. Cron 'verificar-aprobaciones-pendientes' ejecuta filtros pesados
        //     (Claude lee ventana, audios transcritos, keywords negativas)
        //     y decide si mandar la encuesta o cancelar.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType === 'imageMessage') {
          try {
            const fromMe = eventData.key?.fromMe === true;
            const remoteJid = eventData.key?.remoteJid || '';
            const esGrupo = remoteJid.endsWith('@g.us');
            if (fromMe && !esGrupo && remoteJid && process.env.GEMINI_API_KEY) {
              const vendedora = vendedoraDeInstancia(payload.instance);
              (async () => {
                try {
                  // Resolver telefono (manejar @lid)
                  let telCliente = '';
                  if (remoteJid.endsWith('@lid')) {
                    try {
                      const evoUrlR = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
                      const evoKeyR = process.env.EVOLUTION_API_KEY || '3506974711';
                      const rChats = await fetch(`${evoUrlR}/chat/findChats/${encodeURIComponent(payload.instance)}`, {
                        method: 'POST',
                        headers: { apikey: evoKeyR, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ where: {} }),
                      });
                      if (rChats.ok) {
                        const chats = await rChats.json();
                        const c = (Array.isArray(chats) ? chats : []).find(x => x?.remoteJid === remoteJid);
                        const alt = c?.lastMessage?.key?.remoteJidAlt;
                        if (alt) telCliente = String(alt).replace('@s.whatsapp.net', '').replace(/\D/g, '');
                      }
                    } catch (eLid) { console.error('[diseno-aprobacion lid]', eLid.message); }
                  } else {
                    telCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                  }
                  if (telCliente.length < 8) return;
                  // 1. Pedido activo del cliente
                  const peds = leerPedidos();
                  const ESTADOS_DISENO = ['hacer-diseno', 'bandeja'];
                  const pedido = peds.find(p => String(p.telefono || '').replace(/\D/g, '') === telCliente && ESTADOS_DISENO.includes(p.estado));
                  if (!pedido) return;
                  // 2. Skip mayorista / catalogo (memoria: clientes_catalogo)
                  const eqLower = String(pedido.equipo || '').toLowerCase();
                  if (eqLower.includes('mayorista') || eqLower.includes('catalogo') || eqLower.includes('catálogo')) {
                    console.log(`[diseno-aprobacion] skip mayorista/catalogo: #${pedido.id} ${pedido.equipo}`);
                    return;
                  }
                  // 3. Anti-duplicado encuesta ya mandada en 24h
                  const mapping = leerPollsMapping();
                  const hace24h = Date.now() - 24 * 60 * 60 * 1000;
                  const yaMandado = mapping.find(m => m.pedidoId === pedido.id && new Date(m.ts).getTime() > hace24h);
                  if (yaMandado) {
                    console.log(`[diseno-aprobacion] pedido #${pedido.id} ya tiene poll activo, no encolo otra`);
                    return;
                  }
                  // 4. Encolar en pending-approvals (cron verifica 5 min despues)
                  const pendings = leerPendingApprovals();
                  // Si ya hay un pending del mismo pedido sin procesar -> es burst
                  // El cron lo manejara mirando count: si hay 2+ pendings en 10 min = opciones, cancelar.
                  const ahora = Date.now();
                  const tsMsg = eventData.messageTimestamp ? eventData.messageTimestamp * 1000 : ahora;
                  pendings.push({
                    pedidoId: pedido.id,
                    telCliente,
                    vendedora,
                    instance: payload.instance,
                    imageMsgKey: eventData.key,
                    imageTs: new Date(tsMsg).toISOString(),
                    verificarEn: new Date(ahora + 45 * 1000).toISOString(), // 45 seg: rapido para no perder la ventana
                    estado: 'esperando',
                    creadoEn: new Date(ahora).toISOString(),
                  });
                  // Cleanup: dejar maximo 200, descartar entradas viejas (>24h)
                  const limpiados = pendings.filter(p => (ahora - new Date(p.creadoEn).getTime()) < 24 * 60 * 60 * 1000);
                  if (limpiados.length > 200) limpiados.splice(0, limpiados.length - 200);
                  guardarPendingApprovals(limpiados);
                  console.log(`[diseno-aprobacion] encolado pedido #${pedido.id} (${vendedora}) -> verificar en 5 min`);
                } catch (eAprob) {
                  console.error('[diseno-aprobacion]', eAprob.message);
                }
              })();
            }
          } catch (eOuter) {
            console.error('[diseno-aprobacion outer]', eOuter.message);
          }
        }

        // ─────────────────────────────────────────────────────────────
        // DETECTOR DE VOTO DEL CLIENTE EN POLL DE APROBACION
        // Cuando llega pollUpdateMessage, buscamos el poll en el mapping
        // y aplicamos la accion al pedido.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType === 'pollUpdateMessage') {
          try {
            const pollMsg = eventData.message?.pollUpdateMessage;
            const pollMsgId = pollMsg?.pollCreationMessageKey?.id;
            const opciones = pollMsg?.vote?.selectedOptions || [];
            const voto = opciones[0] || '';
            if (pollMsgId && voto) {
              const mapping = leerPollsMapping();
              const reg = mapping.find(m => m.pollMsgId === pollMsgId);
              if (reg) {
                const peds = leerPedidos();
                const p = peds.find(x => x.id === reg.pedidoId);
                if (p) {
                  const ahora = new Date().toISOString();
                  p.historial = p.historial || [];
                  if (/aprueb/i.test(voto)) {
                    const estadoAnt = p.estado;
                    if (['hacer-diseno', 'bandeja'].includes(p.estado)) p.estado = 'confirmado';
                    p.fechaAprobacionCliente = ahora;
                    p.aprobacionCliente = { accion: 'aprobar', respondioEn: ahora, viaPoll: true, pollMsgId };
                    p.historial.push({
                      fecha: ahora,
                      por: 'cliente-poll',
                      accion: 'aprobacion-cliente',
                      de: estadoAnt,
                      a: p.estado,
                      nota: `Cliente APROBO el diseno via encuesta WA. Opcion: "${voto}"`,
                    });
                    guardarPedidos(peds, leerNextId());
                    console.log(`[voto-poll] #${p.id} APROBADO por cliente (${reg.vendedora})`);
                    // Notif suave a la vendedora
                    if (typeof notificarWAVendedora === 'function') {
                      const nm = p.nombreDiseno || p.equipo || `Pedido #${p.id}`;
                      notificarWAVendedora(reg.vendedora, `✅ ${nm}: cliente APROBO el diseno por la encuesta. Pedido a confirmado.`).catch(()=>{});
                    }
                  } else if (/cambiar|cambio/i.test(voto)) {
                    p.aprobacionCliente = { accion: 'cambiar', respondioEn: ahora, viaPoll: true, pollMsgId };
                    p.historial.push({
                      fecha: ahora,
                      por: 'cliente-poll',
                      accion: 'cliente-pide-cambio',
                      nota: `Cliente quiere cambios. Opcion: "${voto}"`,
                    });
                    guardarPedidos(peds, leerNextId());
                    console.log(`[voto-poll] #${p.id} cliente quiere cambios (${reg.vendedora})`);
                    if (typeof notificarWAVendedora === 'function') {
                      const nm = p.nombreDiseno || p.equipo || `Pedido #${p.id}`;
                      notificarWAVendedora(reg.vendedora, `✏️ ${nm}: cliente quiere CAMBIOS en el diseno. Contactalo para saber que ajustar.`).catch(()=>{});
                    }
                  }
                }
              } else {
                console.log(`[voto-poll] poll ${pollMsgId} sin mapping (no es de aprobacion W&S)`);
              }
            }
          } catch (eVoto) {
            console.error('[voto-poll]', eVoto.message);
          }
        }

        // ─────────────────────────────────────────────────────────────
        // DETECTOR CATALOGO — imagen SALIENTE de vendedora → match con Drive
        // Cuando el disenador manda un JPG al cliente, lo emparejamos con
        // el archivo del CATALOGO (registrado previamente por el watcher n8n).
        // NO crea pedidos — solo NOMBRA los que ya existen y registra envio.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' && eventData?.messageType === 'imageMessage') {
          try {
            const fromMe = eventData.key?.fromMe === true;
            const remoteJid = eventData.key?.remoteJid || '';
            const esGrupo = remoteJid.endsWith('@g.us');
            const waMsgId = eventData.key?.id || null;
            if (fromMe && !esGrupo && remoteJid && waMsgId && !disenos.envioYaProcesado(waMsgId)) {
              const vendedora = vendedoraDeInstancia(payload.instance);
              const instance = payload.instance;
              // Fire and forget: no bloqueamos el ack del webhook
              (async () => {
                try {
                  // 1. Resolver telefono cliente (soporta @lid)
                  let telCliente = '';
                  if (remoteJid.endsWith('@lid')) {
                    const dbUrl = process.env.EVOLUTION_DB_URL;
                    if (dbUrl) {
                      const pool = new PgPool({ connectionString: dbUrl, max: 1, ssl: { rejectUnauthorized: false } });
                      try {
                        const r = await pool.query(
                          `SELECT key->>'remoteJidAlt' AS tel FROM "Message"
                           WHERE key->>'remoteJid' = $1 AND key->>'remoteJidAlt' LIKE '%@s.whatsapp.net'
                           ORDER BY "messageTimestamp" DESC LIMIT 1`,
                          [remoteJid]
                        );
                        const alt = r.rows[0]?.tel || '';
                        telCliente = String(alt).replace('@s.whatsapp.net', '').replace(/\D/g, '');
                      } finally { await pool.end(); }
                    }
                  } else {
                    telCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                  }
                  if (!telCliente || telCliente.length < 8) return;

                  // 2. Descargar imagen via Evolution
                  const media = await descargarImagenEvolution(instance, eventData.key);
                  if (!media || !media.base64) {
                    console.log(`[disenos] no pudo descargar imagen ${waMsgId}`);
                    return;
                  }
                  const buf = Buffer.from(media.base64, 'base64');

                  // 3. Hash
                  const sha256 = disenos.calcularSha256(buf);
                  const phash = await disenos.calcularPHash(buf);

                  // 4. Match contra catalogo
                  const match = disenos.buscarMatch({ sha256, phash });

                  if (!match) {
                    // No match: probable meme/otra imagen. Solo log, no ensuciar admin.
                    console.log(`[disenos] imagen saliente sin match. tel=${telCliente} vendedora=${vendedora || instance}`);
                    return;
                  }

                  // 5. Pedido activo del cliente
                  const pedidosArr = leerPedidos();
                  const pedido = disenos.buscarPedidoActivoPorTel(pedidosArr, telCliente);
                  const tsEnvio = new Date().toISOString();
                  const nombreDiseno = String(match.catalogo.nombre || '').replace(/\.(jpe?g|png|webp)$/i, '');

                  if (!pedido) {
                    // Aviso: se envio diseno sin pedido creado
                    disenos.registrarEnvio({
                      disenoCatalogoId: match.catalogo.id,
                      pedidoId: null,
                      telefonoCliente: telCliente,
                      instanciaVendedora: instance,
                      waMsgId, metodo: match.metodo, confianza: match.confianza, tsEnvio,
                    });
                    try {
                      await notificarTelegramAdmin(
                        `⚠️ *Diseno detectado SIN pedido en la app*\n\n` +
                        `Vendedora ${vendedora || instance} envio *${match.catalogo.nombre}* al cliente ${telCliente}, ` +
                        `pero no hay pedido activo con ese numero.\n\n` +
                        `Si es venta real: la vendedora debe mandar el sticker para crear el pedido.`
                      );
                    } catch {}
                    return;
                  }

                  // Skip mayorista / catalogo (clientes que no requieren aprobacion diseno)
                  const eqLower = String(pedido.equipo || '').toLowerCase();
                  if (eqLower.includes('mayorista') || eqLower.includes('catalogo') || eqLower.includes('catálogo')) {
                    console.log(`[disenos] pedido #${pedido.id} skip mayorista/catalogo`);
                    disenos.registrarEnvio({
                      disenoCatalogoId: match.catalogo.id, pedidoId: pedido.id,
                      telefonoCliente: telCliente, instanciaVendedora: instance,
                      waMsgId, metodo: match.metodo, confianza: match.confianza, tsEnvio,
                    });
                    return;
                  }

                  // 6. Nombrar el pedido si aun no tiene nombre real
                  const antes = pedido.equipo || '';
                  const yaTeniaNombreReal = antes && !/^cliente\s+[\+\d]/i.test(antes);
                  if (!yaTeniaNombreReal) {
                    pedido.equipo = nombreDiseno;
                  }
                  pedido.ultimoMovimiento = tsEnvio;
                  pedido.fotoDiseno = pedido.fotoDiseno || match.catalogo.nombre;
                  guardarPedidos(pedidosArr);

                  // 7. Registrar envio
                  disenos.registrarEnvio({
                    disenoCatalogoId: match.catalogo.id, pedidoId: pedido.id,
                    telefonoCliente: telCliente, instanciaVendedora: instance,
                    waMsgId, metodo: match.metodo, confianza: match.confianza, tsEnvio,
                  });

                  // 8. Notif verde
                  try {
                    await notificarTelegramAdmin(
                      `✅ *Diseno vinculado a pedido*\n\n` +
                      `📋 Pedido #${pedido.id} · ${pedido.equipo}\n` +
                      `📞 Cliente: ${telCliente}\n` +
                      `👤 Vendedora: ${vendedora || instance}\n` +
                      `🎨 Archivo: ${match.catalogo.nombre}\n` +
                      `🔍 Match: ${match.metodo} (${(match.confianza * 100).toFixed(0)}%)` +
                      (yaTeniaNombreReal ? `\n📝 Ya tenia nombre "${antes}", no se cambio.` : `\n📝 Pedido nombrado: "${nombreDiseno}"`)
                    );
                  } catch {}
                } catch (e) {
                  console.error('[disenos hook async error]', e.message);
                }
              })();
            }
          } catch (e) {
            console.error('[disenos hook outer error]', e.message);
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

              // ── FILTRO 0: telefonos de proveedores conocidos — saltar SIN llamar a Gemini ──
              const TELEFONOS_PROVEEDORES = (process.env.TELEFONOS_PROVEEDORES || '')
                .split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean);
              if (TELEFONOS_PROVEEDORES.includes(telefonoCliente)) {
                console.log(`[comprobante] DESCARTADO — ${telefonoCliente} es proveedor conocido (lista TELEFONOS_PROVEEDORES)`);
                return json(res, 200, { ok: true, webhook_recibido: true, accionRealizada, resultadoApi, descartadoPorProveedor: true });
              }

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
                    // ── FILTRO 1: Validar destinatario sea W&S ──
                    // Solo procesar si el pago va dirigido a alguien de W&S.
                    // Si el destinatario es otro (proveedor, particular ajeno) → ignorar.
                    const validacion = validarBeneficiarioWS(analisis.destinatario_nombre);
                    if (!validacion.esParaWS) {
                      console.log(`[comprobante] DESCARTADO — destinatario "${analisis.destinatario_nombre}" no es W&S (motivo: ${validacion.motivo})`);
                      return;
                    }

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
                      destinatario: analisis.destinatario_nombre || null,
                      remitente: analisis.remitente_nombre || null,
                      messageId: eventData.key?.id || null,
                      remoteJid,
                      stickerEnviado: false,
                      pedidoAutoCreado: null,
                    };

                    // ─── AUTO-CREAR PEDIDO en bandeja al instante ───
                    // Para que las ventas NUNCA se pierdan, incluso si la vendedora
                    // olvida usar el sticker. El sticker oficializa la venta
                    // (avisa al grupo familia + Chatwoot).
                    let pedidoCreado = null;
                    try {
                      // Solo crear si hay confianza media o alta (evitar falsos positivos)
                      if (analisis.confianza !== 'baja') {
                        const equipoTentativo = nombreCliente || `Cliente ${telefonoCliente}`;
                        const resCrear = crearVentaInterna(
                          'pedido',
                          vendedora,
                          telefonoCliente,
                          eventData.key?.id || null,
                          equipoTentativo
                        );
                        if (resCrear.ok && !resCrear.duplicado) {
                          pedidoCreado = resCrear.id;
                          registro.pedidoAutoCreado = resCrear.id;
                          // Anotar que vino por comprobante (no sticker)
                          const pedidos = leerPedidos();
                          const p = pedidos.find(x => x.id === resCrear.id);
                          if (p) {
                            p.origenComprobante = true;
                            p.montoComprobante = analisis.monto || null;
                            p.bancoComprobante = analisis.banco || null;
                            p.confianzaComprobante = analisis.confianza;
                            p.historial = p.historial || [];
                            p.historial.push({
                              fecha: new Date().toISOString(),
                              por: 'comprobante-bot',
                              accion: 'crear-pedido',
                              nota: `Auto-creado por comprobante detectado ($${analisis.monto||'?'} ${analisis.banco})`,
                            });
                            db.guardarPedidos(pedidos);
                          }
                          console.log(`[comprobante] PEDIDO #${resCrear.id} auto-creado por comprobante (${vendedora} ← ${nombreCliente})`);
                        } else if (resCrear.duplicado) {
                          registro.pedidoAutoCreado = resCrear.id;
                          console.log(`[comprobante] Pedido ya existía: #${resCrear.id}`);
                        }
                      }
                    } catch (eCrear) {
                      console.error('[comprobante auto-crear pedido]', eCrear.message);
                    }

                    guardarComprobanteDetectado(registro);
                    console.log(`[comprobante] DETECTADO ${vendedora} ← ${nombreCliente} ${analisis.banco} $${analisis.monto||'?'} (confianza=${analisis.confianza})`);

                    // ─── PAGO 50/50: vincular comprobante al pedido y sumar al abonado ───
                    try {
                      const resVinc = vincularComprobanteAPedido({
                        pedidoId: pedidoCreado || null,
                        telefono: telefonoCliente,
                        monto: analisis.monto,
                        banco: analisis.banco,
                        fecha: new Date().toISOString(),
                        comprobante_id: registro.cid || (eventData.key && eventData.key.id),
                      });
                      if (resVinc.vinculado) {
                        console.log(`[pago] $${analisis.monto} vinculado a pedido #${resVinc.pedidoId} (abonado=$${resVinc.abonado}${resVinc.total?'/$'+resVinc.total:''})`);

                        // Buscar el pedido para sacar el nombre del equipo
                        const _pedVinc = db.leerPedidos().find(x => x.id === resVinc.pedidoId);
                        const equipoTxt = (_pedVinc && (_pedVinc.equipo || _pedVinc.cliente)) || `Pedido #${resVinc.pedidoId}`;
                        const abonadoFmt = _formatearMontoCOP(resVinc.abonado);
                        const totalFmt = resVinc.total ? _formatearMontoCOP(resVinc.total) : null;
                        const saldoFmt = (resVinc.saldoPendiente != null) ? _formatearMontoCOP(resVinc.saldoPendiente) : null;
                        const montoFmt = _formatearMontoCOP(analisis.monto);

                        // Anti-duplicado por monto similar quitado 3-jun-2026:
                        // Camilo aclaro que cada comprobante es un pago valido (no duplicado).
                        // Lo importante es ASIGNAR al pedido correcto cuando hay 2+ pedidos activos
                        // del mismo cliente. Esa logica se agregara cuando llegue ese caso real.

                        // CONTEXTO CLIENTE: si es repetido, agregar historico al WA
                        const _ctxCli = obtenerContextoCliente(telefonoCliente, resVinc.pedidoId);
                        const _contextoLineas = (_ctxCli && _ctxCli.repetido)
                          ? `\n📌 Cliente repetido: ${_ctxCli.total} pedido(s) previos (${_formatearMontoCOP(_ctxCli.totalAbonadoAno)} acumulado año)`
                          : '';

                        if (resVinc.pagadoCompleto) {
                          // ─── CASO C: SALDO TOTAL DETECTADO ───
                          // 3 WAs (cliente + vendedora + jefe&graciela individuales) + grupo Trabajo en familia

                          // 1. WA al CLIENTE (gracias) — usa instancia ws-ventas
                          try {
                            const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
                            const evoKey = process.env.WA_NOTIF_APIKEY || process.env.EVOLUTION_API_KEY || '5DC08B336216-404C-BE94-A95B4A9A0528';
                            const evoInst = process.env.WA_INSTANCE_CLIENTE || 'ws-ventas';
                            const msgCli = `¡Gracias por completar tu pago! ✅\n\n` +
                              `Tu pedido sigue en producción y te avisamos en cuanto esté listo para entrega.\n\n` +
                              `_W&S Uniformes Deportivos_`;
                            await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', 'apikey': evoKey },
                              body: JSON.stringify({ number: telefonoCliente, text: msgCli }),
                            });
                          } catch (eC) { console.error('[pago wa-cliente]', eC.message); }

                          // 2. WA a la vendedora — DEDUPE por pedidoId
                          if (waPuedeEnviar(`pago-completo-vend:${resVinc.pedidoId}`)) {
                            try {
                              const msgVend = `💰 *PAGO COMPLETO* ✅\n\n` +
                                `${nombreCliente} terminó de pagar.\n` +
                                `Pedido: *${equipoTxt}*\n` +
                                `Total cobrado: ${abonadoFmt}${_contextoLineas}\n\n` +
                                `👉 Confírmale el envío al cliente.`;
                              await notificarWAVendedora(vendedora, msgVend);
                            } catch (eV) { console.error('[pago wa-vend]', eV.message); }
                          }

                          // 3. WA individual a Camilo + Graciela — DEDUPE por pedidoId
                          if (waPuedeEnviar(`pago-completo-jefe:${resVinc.pedidoId}`)) try {
                            const msgJefe = `💰 *PAGO COMPLETO*\n\n` +
                              `Cliente: ${nombreCliente}${_contextoLineas}\n` +
                              `Pedido: *${equipoTxt}* (#${resVinc.pedidoId}) — ${vendedora}\n` +
                              `Total: ${abonadoFmt} ✅\n\n` +
                              `Listo para despachar cuando esté terminado.`;
                            await notificarWAPersona('camilo', msgJefe);
                            await notificarWAPersona('graciela', msgJefe);
                          } catch (eJ) { console.error('[pago wa-jefe]', eJ.message); }

                          // 4. Grupo "Trabajo en familia" — DEDUPE por pedidoId
                          if (waPuedeEnviar(`pago-completo-grupo:${resVinc.pedidoId}`)) try {
                            const msgGrupo = `💰 *PAGO COMPLETO* — VENTA #${resVinc.pedidoId}\n` +
                              `${nombreCliente} — *${equipoTxt}* (${vendedora})\n` +
                              `📞 ${telefonoCliente}\n` +
                              `Total: ${abonadoFmt} ✅`;
                            await notificarWhatsappTrabajoFamilia(msgGrupo);
                          } catch (eG) { console.error('[pago wa-grupo]', eG.message); }

                        } else {
                          // ─── CASO B: ABONO PARCIAL ───
                          // WA balance individual a Camilo + Graciela (NO al grupo, opcion 2 mixta)
                          // DEDUPE por pedidoId+monto para evitar mismo balance repetido en el dia
                          const _dedupeKeyB = `abono:${resVinc.pedidoId}:${Math.round((analisis.monto || 0) / 1000)}`;
                          if (waPuedeEnviar(_dedupeKeyB)) try {
                            const balLines = [
                              `💵 *Abono detectado*`,
                              ``,
                              `${nombreCliente} pagó ${montoFmt}`,
                              `Pedido: *${equipoTxt}* (#${resVinc.pedidoId}) — ${vendedora}`,
                              ``,
                              `📊 Pagado: ${abonadoFmt}` + (totalFmt ? ` / ${totalFmt}` : ''),
                            ];
                            if (saldoFmt) balLines.push(`📌 Falta: ${saldoFmt}`);
                            else if (!totalFmt) balLines.push(`📌 _(sin total — falta poner total en la factura)_`);
                            if (_contextoLineas) balLines.push(_contextoLineas.trim());
                            const msgBalance = balLines.join('\n');
                            await notificarWAPersona('camilo', msgBalance);
                            await notificarWAPersona('graciela', msgBalance);
                          } catch (eB) { console.error('[pago wa-balance-jefe]', eB.message); }
                        }
                      } else {
                        console.log(`[pago] no vinculado: ${resVinc.motivo}`);

                        // ─── CASO A: pago sin pedido activo (motivo = sin-pedido) ───
                        // Guardar como "primer pago pendiente" + WA a vendedora con OPCIONES:
                        //   Opcion 1: responder "equipo NOMBRE_DEL_EQUIPO" → crea pedido auto
                        //   Opcion 2: mandar el sticker como siempre (flujo viejo)
                        if (resVinc.motivo === 'sin-pedido' && analisis.monto) {
                          try {
                            const pendienteCreado = guardarPrimerPagoPendiente({
                              telefono: telefonoCliente,
                              vendedora,
                              monto: analisis.monto,
                              banco: analisis.banco,
                              fecha: new Date().toISOString(),
                              nombreCliente: nombreCliente || null,
                              comprobante_id: registro.cid || (eventData.key && eventData.key.id),
                            });
                            const montoSinPedFmt = _formatearMontoCOP(analisis.monto);
                            const msgSinPed = `💸 *Pago detectado SIN pedido*\n\n` +
                              `${nombreCliente || telefonoCliente} pagó ${montoSinPedFmt}\n` +
                              `📱 ${telefonoCliente}\n\n` +
                              `*¿Cómo registrar este pedido?*\n` +
                              `━━━━━━━━━━━━━━━━━━━━\n` +
                              `🆕 *Opcion automatica (mas rapida):*\n` +
                              `Responde con el texto:\n` +
                              `*equipo NOMBRE_DEL_EQUIPO*\n` +
                              `(Ej: "equipo Leones FC")\n` +
                              `Yo creo el pedido y vinculo este pago automatico.\n\n` +
                              `📌 *O sino:*\n` +
                              `Mándale el sticker 💰 al cliente como siempre.`;
                            await notificarWAVendedora(vendedora, msgSinPed);
                            if (pendienteCreado) {
                              console.log(`[primer-pago] pendiente guardado id=${pendienteCreado.id} vend=${vendedora} tel=${telefonoCliente} monto=${analisis.monto}`);
                            }
                          } catch (eSP) { console.error('[pago wa-sin-pedido]', eSP.message); }
                        }
                      }
                    } catch (ePago) {
                      console.error('[pago vincular err]', ePago.message);
                    }

                    // ─── WA INMEDIATO a la vendedora con CONTADOR DEL DIA ───
                    try {
                      const montoTxt = analisis.monto ? `$${Number(analisis.monto).toLocaleString('es-CO')}` : 'monto no detectado';
                      const bancoTxt = analisis.banco && analisis.banco !== 'desconocido' ? ` por ${analisis.banco}` : '';
                      const pedidoTxt = pedidoCreado ? `📋 Pedido #${pedidoCreado} creado en bandeja\n` : '';
                      // Resumen del dia para motivar (este pago YA está contado en sinSticker)
                      const r = resumenDiaVendedora(vendedora);
                      const totalDiaTxt = r.totalMonto > 0 ? _formatearMontoCOP(r.totalMonto) : '$0';
                      const msg = `💸 Pago ${montoTxt}${bancoTxt} — ${nombreCliente || telefonoCliente}\n` +
                        pedidoTxt +
                        `👉 Pasa el sticker 💰 al chat de ${telefonoCliente} para oficializar.`;
                      await notificarWAVendedora(vendedora, msg);
                    } catch (eWa) {
                      console.error('[comprobante wa vendedora]', eWa.message);
                    }
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

        // ─────────────────────────────────────────────────────────────
        // LISTENER DOCUMENTOS SALIENTES DE VENDEDORAS — captura facturas WA
        // Las 4 instancias (ws-ventas, ws-ney, ws wendy, ws-paola) mandan PDFs/imagenes
        // a clientes. Las interceptamos para no perder ninguna factura manual.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' &&
            (eventData?.messageType === 'documentMessage' ||
             eventData?.messageType === 'documentWithCaptionMessage' ||
             eventData?.messageType === 'imageMessage')) {
          try {
            const fromMe = eventData.key?.fromMe === true;
            const instance = payload.instance;
            const vendedoraDoc = INSTANCIA_A_VENDEDORA[instance]
              || INSTANCIA_A_VENDEDORA[String(instance).toLowerCase().replace(/[\s_]+/g, '-')];
            const remoteJid = eventData.key?.remoteJid || '';
            const esGrupo = remoteJid.endsWith('@g.us');
            // Solo: saliente + instancia de vendedora + chat 1-a-1 + remoteJid valido
            if (fromMe && vendedoraDoc && !esGrupo && remoteJid) {
              const telefonoCliente = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
              const pushName = eventData.pushName || '';
              // Saltar proveedores conocidos (ya no nos sirven sus docs)
              const TELEFONOS_PROVEEDORES_DOC = (process.env.TELEFONOS_PROVEEDORES || '')
                .split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean);
              if (!TELEFONOS_PROVEEDORES_DOC.includes(telefonoCliente)) {
                // Procesar en background
                (async () => {
                  try {
                    await capturarDocumentoSalienteVendedora({
                      instance,
                      vendedora: vendedoraDoc,
                      messageKey: eventData.key,
                      message: eventData.message,
                      messageType: eventData.messageType,
                      telefonoCliente,
                      pushName,
                    });
                  } catch (eDoc) {
                    console.error('[doc-saliente async err]', eDoc.message);
                  }
                })();
              }
            }
          } catch (errDocSal) {
            console.error('[doc-saliente listener err]', errDocSal);
          }
        }

        // ─────────────────────────────────────────────────────────────
        // LISTENER COMANDO DEL JEFE — mensajes de texto que Camilo se envia a si mismo
        // en el chat de ws-duvan (Note to self). Patron: "1 si betty", "2 no", "ver".
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' &&
            payload.instance === (process.env.WA_NOTIF_INSTANCE || 'ws-duvan') &&
            (eventData?.messageType === 'conversation' || eventData?.messageType === 'extendedTextMessage')) {
          try {
            const fromMe = eventData.key?.fromMe === true;
            const senderJid = eventData.key?.remoteJid || '';
            const senderNum = senderJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            const jefeNum = (process.env.WA_DUVAN || process.env.WA_CAMILO || '573124858901').replace(/\D/g, '');
            // Acepta: (1) jefe escribiendose a si mismo en ws-duvan, o (2) jefe escribiendo desde otra linea
            const esJefe = fromMe && senderNum === jefeNum;
            if (esJefe) {
              const texto = eventData.message?.conversation
                || eventData.message?.extendedTextMessage?.text
                || '';
              // Solo procesar si parece comando del panel
              const t = texto.trim().toLowerCase();
              const esComando = /^(ver|lista|list|\d+\s+(si|no|sí)\b|(equipo|nombre|eq)\s+\d+\s+\S)/i.test(t);
              if (esComando) {
                (async () => {
                  try { await procesarRespuestaJefe(texto); }
                  catch (e) { console.error('[jefe-cmd err]', e.message); }
                })();
              }
            }
          } catch (errCmd) {
            console.error('[jefe-listener err]', errCmd);
          }
        }

        // ─────────────────────────────────────────────────────────────
        // LISTENER COMANDO 'equipo N NOMBRE' DESDE CUALQUIER VENDEDORA
        // Cuando la vendedora le escribe al jefe (a su numero) desde su
        // propia instancia (ws-wendy, ws-ney, ws-paola, ws-ventas), si el
        // texto es "equipo 12 LEONES FC" lo procesamos igual que si lo
        // mandara el jefe. Asi cualquier vendedora corrige el nombre del
        // pedido sin esperar que Camilo lo haga.
        // ─────────────────────────────────────────────────────────────
        if (eventType === 'messages.upsert' &&
            (eventData?.messageType === 'conversation' || eventData?.messageType === 'extendedTextMessage')) {
          try {
            const instanciasVend = new Set(['ws-ventas','ws-wendy','ws wendy','ws-ney','ws-paola','ws paola']);
            const inst = payload.instance || '';
            const fromMe = eventData.key?.fromMe === true;
            const dstJid = eventData.key?.remoteJid || '';
            const dstNum = dstJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            const jefeNum = (process.env.WA_DUVAN || process.env.WA_CAMILO || '573124858901').replace(/\D/g, '');
            const esVendAlJefe = fromMe && instanciasVend.has(inst) && dstNum === jefeNum;
            if (esVendAlJefe) {
              const texto = (eventData.message?.conversation
                || eventData.message?.extendedTextMessage?.text
                || '').trim();
              // CASO A: "equipo 12 NOMBRE" → correccion normal (delegamos al jefe)
              if (/^(equipo|nombre|eq)\s+\d+\s+\S/i.test(texto)) {
                (async () => {
                  try { await procesarRespuestaJefe(texto); }
                  catch (e) { console.error('[vend-cmd equipo err]', e.message); }
                })();
              }
              // CASO B: "equipo NOMBRE" (SIN numero) → PRIMER PAGO de cliente nuevo
              else if (/^(equipo|nombre|eq)\s+[A-Za-zÑñÁÉÍÓÚáéíóú0-9]/i.test(texto)) {
                (async () => {
                  try { await procesarRespuestaPrimerPago(texto, inst); }
                  catch (e) { console.error('[vend-cmd primer-pago err]', e.message); }
                })();
              }
            }
          } catch (errCmdV) {
            console.error('[vend-equipo-listener err]', errCmdV);
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


  // ── GET /api/test-wa-grupo?instance=ws-duvan&text=hola ──
  // Prueba mandar un mensaje al grupo familia desde la instancia indicada
  // y devuelve el resultado completo de Evolution (para diagnosticar).
  if (req.method === 'GET' && req.url.startsWith('/api/test-wa-grupo')) {
    (async () => {
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const instance = urlObj.searchParams.get('instance') || process.env.WA_NOTIF_INSTANCE || 'ws-duvan';
        const text = urlObj.searchParams.get('text') || '🧪 Prueba desde la app W&S';
        const groupJid = process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us';
        const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
        const KEY = process.env.EVOLUTION_API_KEY || '';
        const r = await fetch(`${EVO}/message/sendText/${encodeURIComponent(instance)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: KEY },
          body: JSON.stringify({ number: groupJid, text }),
        });
        const body = await r.text();
        return json(res, 200, { ok: r.ok, status: r.status, instance, groupJid, respuesta: body.slice(0, 800) });
      } catch (e) { return json(res, 500, { error: e.message }); }
    })();
    return;
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
  if (req.method === 'POST' && req.url.startsWith('/api/marcar-stickers-retroactivo')) {
    (async () => {
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const force = urlObj.searchParams.get('force') === 'true';
        const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 7').all().map(r => r.fecha);
        const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim());
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
            // Con ?force=true igual reenvia notificaciones de los pedidos ya marcados.
            const pedidosActual = leerPedidos();
            const yaHecho = pedidosActual.find(p => normTel(p.telefono) === c.telCli && p.stickerVenta === c.hash);
            if (yaHecho && !force) {
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
          const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim());
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
      const hashesConfig = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',');
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
      const ESTADOS_CERRADOS = new Set(['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final']);
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

  // ── POST /api/arreglos/agregar — añade UN arreglo (para mini-app produccion) ─
  if (req.method === 'POST' && req.url === '/api/arreglos/agregar') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { equipo, faltante, disenador, pedidoId } = JSON.parse(body);
        if (!equipo || !faltante) return json(res, 400, { error: 'Faltan equipo o faltante' });
        const actuales = db.leerArreglos();
        const nuevo = {
          id: Date.now(),
          equipo: String(equipo).trim(),
          faltante: String(faltante).trim(),
          disenador: disenador || 'Sin asignar',
          pedidoId: pedidoId || null,
          enviado: false,
          resuelto: false,
          fecha: new Date().toLocaleDateString('es-CO'),
          origen: 'mini-app-produccion',
        };
        actuales.unshift(nuevo);
        db.guardarArreglos(actuales);
        // Notificar a Telegram para que el dueño se entere
        const tel = '⚠️ *ARREGLO NUEVO desde Producción*\n\n' +
          `👕 *Equipo:* ${nuevo.equipo}\n` +
          `📝 *Falta:* ${nuevo.faltante}\n` +
          `🎨 *Asignado a:* ${nuevo.disenador}` +
          (pedidoId ? `\n📦 *Pedido:* #${pedidoId}` : '');
        notificarTelegramDuvan(tel).catch(()=>{});

        // ─── NOTIF WA al diseñador asignado ───
        if (nuevo.disenador && nuevo.disenador !== 'Sin asignar') {
          const link = pedidoId
            ? `https://ws-app-interna-production.up.railway.app/#/mi-dia`
            : `https://ws-app-interna-production.up.railway.app/`;
          const msgWA = `🔧 *Nuevo arreglo asignado a ti*\n\n` +
            `👕 Equipo: ${nuevo.equipo}\n` +
            `📝 Falta: ${nuevo.faltante}\n` +
            (pedidoId ? `📦 Pedido: #${pedidoId}\n` : '') +
            `\nPor favor re-envía el archivo corregido a calandra por WeTransfer.\n` +
            `Cuando lo mandes, marca como "Re-enviado" en tu app.\n\n` +
            `🔗 ${link}`;
          notificarWAPersona(nuevo.disenador, msgWA).catch(()=>{});
        }

        return json(res, 200, { ok: true, id: nuevo.id });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    return;
  }

  // ── POST /api/arreglos — reemplaza lista completa ────────────
  // Si llegan arreglos NUEVOS (id no existia en BD), notifica al disenador.
  if (req.method === 'POST' && req.url === '/api/arreglos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { arreglos } = JSON.parse(body);
        if (!Array.isArray(arreglos)) return json(res, 400, { error: 'arreglos debe ser array' });
        // Detectar nuevos arreglos (id no estaba en DB)
        const previos = db.leerArreglos();
        const idsPrev = new Set(previos.map(a => a.id));
        const nuevos = arreglos.filter(a => a && a.id && !idsPrev.has(a.id));
        db.guardarArreglos(arreglos);
        // Notificar fuera del response (no bloquear cliente)
        if (nuevos.length) {
          (async () => {
            for (const n of nuevos) {
              try {
                const tel = '⚠️ *ARREGLO NUEVO*\n\n' +
                  `👕 *Equipo:* ${n.equipo || 'Sin equipo'}\n` +
                  `📝 *Falta:* ${n.faltante || 'Sin detalle'}\n` +
                  `🎨 *Asignado a:* ${n.disenador || 'Sin asignar'}` +
                  (n.pedidoId ? `\n📦 *Pedido:* #${n.pedidoId}` : '');
                notificarTelegramDuvan(tel).catch(()=>{});
                if (n.disenador && n.disenador !== 'Sin asignar') {
                  const link = 'https://ws-app-interna-production.up.railway.app/#/mi-dia';
                  const msgWA = `🔧 *Nuevo arreglo asignado a ti*\n\n` +
                    `👕 Equipo: ${n.equipo || 'Sin equipo'}\n` +
                    `📝 Falta: ${n.faltante || 'Sin detalle'}\n` +
                    (n.pedidoId ? `📦 Pedido: #${n.pedidoId}\n` : '') +
                    `\nReenvía el archivo corregido a calandra por WeTransfer.\n` +
                    `Cuando lo mandes, marca como "Re-enviado" en tu app.\n\n` +
                    `🔗 ${link}`;
                  await notificarWAPersona(n.disenador, msgWA);
                }
              } catch (e) { console.error('[arreglo-nuevo notif]', e.message); }
            }
          })();
        }
        return json(res, 200, { ok: true, total: arreglos.length, nuevosDetectados: nuevos.length });
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

  // ── Alias para vistas simplificadas (sin extensión) ──
  if (req.method === 'GET' && req.url.startsWith('/api/recordatorios/roles')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const resumen = resumenRolesOperativos();
      const texto = textoRecordatorioRoles(resumen);
      const enviar = u.searchParams.get('send') === '1';
      if (enviar) {
        notificarWhatsappTrabajoFamilia(texto).catch(e => console.error('[recordatorios roles wa]', e.message));
        notificarTelegramDuvan(texto).catch(e => console.error('[recordatorios roles tg]', e.message));
      }
      return json(res, 200, { ok: true, enviado: enviar, resumen, texto });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }


  // ── GET /costura — mini-app de Camilo para gestion de costureras ──
  if (req.method === 'GET' && (req.url === '/costura' || req.url === '/costura/')) {
    return fs.readFile(path.join(__dirname, 'public', 'costura.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  // ── PWA mini-app costura: manifest + iconos ──
  // Sirve los assets necesarios para que /costura sea instalable en el celular
  // con su propio icono (carrete de hilo, fondo rosa/morado).
  if (req.method === 'GET' && req.url === '/manifest-costura.json') {
    return fs.readFile(path.join(__dirname, 'public', 'manifest-costura.json'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(data);
    });
  }
  if (req.method === 'GET' && (req.url === '/icon-costura-192.png' || req.url === '/icon-costura-512.png')) {
    const fname = req.url.slice(1);
    return fs.readFile(path.join(__dirname, 'public', fname), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }
  if (req.method === 'GET' && req.url === '/icon-costura.svg') {
    return fs.readFile(path.join(__dirname, 'public', 'icon-costura.svg'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }

  // ── GET /api/personas — roster completo (slug, nombre, roles, color, vistaInicial) ──
  if (req.method === 'GET' && req.url === '/api/personas') {
    return json(res, 200, { personas: PERSONAS });
  }

  // ═══════════════════════════════════════════════════════════════════
  // COSTUREsRAS — registro envio/recepcion de lotes
  // ═══════════════════════════════════════════════════════════════════
  // Roster de costureras (filtradas de PERSONAS por rol 'costura')
  // y sus links personales /c/<slug>.

  // ── GET /api/costureras — listado de costureras activas ──
  if (req.method === 'GET' && req.url === '/api/costureras') {
    const costureras = PERSONAS.filter(p => p.roles.includes('costura'))
      .map(p => ({ slug: p.slug, nombre: p.nombre, link: `/c/${p.slug}` }));
    return json(res, 200, { costureras });
  }

  // ═══════════════════════════════════════════════════════════════════
  // MINI-APP COSTURA DE CAMILO — Dashboard
  // GET /api/costura/dashboard
  // Devuelve:
  //  - costureras: con resumen (pedidos activos, valor estimado semana)
  //  - paraEnviar: pedidos en estados (enviado-calandra, llego-impresion, corte)
  //  - enCostura: pedidos asignados a costureras (con movimiento abierto)
  //  - pagoSemana: lista de pagos sugeridos por costurera (semana actual)
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url === '/api/costura/dashboard') {
    try {
      const peds = leerPedidos();
      const tarifas = Object.fromEntries(
        (db.listarTarifasCostura() || []).map(t => [t.tipo, t.valor])
      );
      const costureraSlugs = PERSONAS.filter(p => p.roles.includes('costura'));

      // Pedidos por estado relevante (incluye los del flujo Lidermeyer)
      const ESTADOS_PARA_ENVIAR = ['enviado-calandra', 'llego-impresion', 'corte', 'tela-recibida'];
      const ESTADOS_EN_COSTURA = ['costura', 'en-satelite', 'en-costura'];

      const paraEnviar = peds.filter(p =>
        ESTADOS_PARA_ENVIAR.includes(p.estado) &&
        !['enviado-final', 'archivado', 'cancelado'].includes(p.estado)
      ).map(p => ({
        id: p.id,
        equipo: p.equipo || `Pedido #${p.id}`,
        vendedora: p.vendedora || '',
        numUniformes: p.numUniformes || null,
        estado: p.estado,
        fechaVenta: p.fechaVenta || '',
        ultimoMov: p.ultimoMovimiento || '',
        thumbnail: (db.getFotoPedido(p.id)?.url) || (p.drive?.pdfRip?.thumbnail) || null,
        tieneDatos: !!(p.numUniformes > 0 || (p.prendas && p.prendas.length) || p.total > 0 || p.abonado > 0),
      }));

      // Movimientos abiertos (sin recepcion)
      const movsAbiertos = db.leerMovimientosCosturaPendientes() || [];
      const movsPorPedido = new Map();
      movsAbiertos.forEach(m => {
        if (!movsPorPedido.has(m.pedido_id)) movsPorPedido.set(m.pedido_id, []);
        movsPorPedido.get(m.pedido_id).push(m);
      });

      // Tiempo promedio historico por costurera (90 dias de movs cerrados).
      // Lo usamos para alerta adaptativa en enCostura y stats en resumenCostureras.
      const tiempoPromedioMap = {};
      for (const p of costureraSlugs) {
        try {
          const historicos = db.leerMovimientosCostureraPorSlug(p.slug, 100) || [];
          const limite = Date.now() - 90 * 86400 * 1000;
          const cerrados = historicos.filter(m =>
            m.fecha_recepcion && m.fecha_envio &&
            new Date(m.fecha_envio).getTime() >= limite
          );
          if (cerrados.length > 0) {
            const dias = cerrados.map(m =>
              (new Date(m.fecha_recepcion).getTime() - new Date(m.fecha_envio).getTime()) / 86400000
            );
            tiempoPromedioMap[p.slug] = dias.reduce((a,b) => a+b, 0) / dias.length;
          }
        } catch {}
      }

      // Defensa: excluir pedidos en estado final aunque tengan movs abiertos.
      // Si la etiqueta WA "entregado" llegó, el pedido ya no está en costura
      // (aunque por un bug viejo haya quedado un mov sin cerrar).
      const ESTADOS_FINALES_COSTURA = new Set(['entregado', 'enviado-final', 'archivado', 'cancelado', 'listo']);
      const enCostura = peds.filter(p =>
        !ESTADOS_FINALES_COSTURA.has(p.estado || '') &&
        (ESTADOS_EN_COSTURA.includes(p.estado) || movsPorPedido.has(p.id))
      ).map(p => {
        const movs = movsPorPedido.get(p.id) || [];
        const slug = movs[0]?.costurera_slug || null;
        const costuNombre = movs[0]?.costurera_nombre || null;
        const fechaEnvio = movs[0]?.fecha_envio || null;
        const diasEnCostura = fechaEnvio
          ? Math.floor((Date.now() - new Date(fechaEnvio).getTime()) / (24*60*60*1000))
          : null;
        // Alerta adaptativa: compara contra promedio historico de la costurera
        // Si no hay data historica, fallback a 7 dias fijo.
        const promedio = slug ? tiempoPromedioMap[slug] : null;
        const umbral = promedio ? Math.max(promedio * 1.5, 5) : 7;
        const alertaAtipico = diasEnCostura !== null && diasEnCostura > umbral;
        // Piezas: agrupar movimientos abiertos por prenda
        const piezasMap = {};
        movs.forEach(m => {
          const tipo = (m.prenda || 'pieza').toLowerCase();
          if (!piezasMap[tipo]) piezasMap[tipo] = 0;
          piezasMap[tipo] += Number(m.cantidad_envio || 0);
        });
        const piezas = Object.entries(piezasMap).map(([prenda, cantidad]) => ({ prenda, cantidad }));
        const totalPiezas = piezas.reduce((a, b) => a + (b.cantidad || 0), 0);
        return {
          id: p.id,
          equipo: p.equipo || `Pedido #${p.id}`,
          vendedora: p.vendedora || '',
          costureraSlug: slug,
          costureraNombre: costuNombre,
          fechaEnvio,
          diasEnCostura,
          tiempoPromedioCostu: promedio ? Math.round(promedio * 10) / 10 : null,
          umbralAlerta: Math.round(umbral * 10) / 10,
          piezas,
          totalPiezas,
          estado: p.estado,
          sinErp: !!p.sin_erp,
          origen: p.origen || null,
          thumbnail: (db.getFotoPedido(p.id)?.url) || (p.drive?.pdfRip?.thumbnail) || null,
          alerta: alertaAtipico,
        };
      });

      // Resumen por costurera (semana actual)
      const ahora = new Date();
      const dia = ahora.getDay(); // 0=Dom, 1=Lun
      const diasDesdeLunes = (dia === 0 ? 6 : dia - 1);
      const inicioSemana = new Date(ahora);
      inicioSemana.setHours(0,0,0,0);
      inicioSemana.setDate(ahora.getDate() - diasDesdeLunes);
      const finSemana = new Date(inicioSemana);
      finSemana.setDate(inicioSemana.getDate() + 7);
      const movsSemana = db.leerMovimientosCosturaSemana(
        inicioSemana.toISOString(), finSemana.toISOString()
      ) || [];

      const resumenCostureras = costureraSlugs.map(p => {
        const movs = movsSemana.filter(m => m.costurera_slug === p.slug);
        // Cuenta PEDIDOS unicos abiertos (no movimientos), porque un pedido
        // puede tener N movimientos (uno por tipo de prenda).
        const pedidosAbiertos = new Set(
          movsAbiertos.filter(m => m.costurera_slug === p.slug).map(m => m.pedido_id)
        );
        const activos = pedidosAbiertos.size;
        // Valor estimado: cantidad recibida * tarifa del tipo
        let valorSemana = 0;
        movs.forEach(m => {
          if (m.fecha_recepcion && m.cantidad_recibida > 0) {
            const tarifa = tarifas[(m.prenda || '').toLowerCase()] || 0;
            valorSemana += tarifa * m.cantidad_recibida;
          }
        });
        const promedio = tiempoPromedioMap[p.slug];
        return {
          slug: p.slug,
          nombre: p.nombre,
          emoji: p.emoji || '🪡',
          color: p.color || '#888',
          pedidosActivos: activos,
          valorSemanaEstimado: valorSemana,
          tiempoPromedioDias: promedio ? Math.round(promedio * 10) / 10 : null,
          alerta: activos > 3,
        };
      });

      // Pago sugerido semana (movimientos recibidos no pagados)
      const semanaKey = inicioSemana.toISOString().slice(0,10);
      const pagosSemana = costureraSlugs.map(p => {
        const movsRecibidos = movsSemana.filter(m =>
          m.costurera_slug === p.slug && m.fecha_recepcion
        );
        let monto = 0;
        movsRecibidos.forEach(m => {
          const tarifa = tarifas[(m.prenda || '').toLowerCase()] || 0;
          monto += tarifa * (m.cantidad_recibida || 0);
        });
        return { slug: p.slug, nombre: p.nombre, monto, count: movsRecibidos.length };
      }).filter(x => x.monto > 0);

      return json(res, 200, {
        ok: true,
        semanaInicio: semanaKey,
        costureras: resumenCostureras,
        paraEnviar,
        enCostura,
        pagosSemana,
        tarifasConfiguradas: Object.keys(tarifas).length,
      });
    } catch (e) {
      console.error('[costura dashboard]', e);
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/leer-chat-completo?tel=X&limite=500 ──────────────
  // Lee TODA la conversacion de un telefono combinando @s.whatsapp.net + @lid.
  // Ordena por timestamp ascendente. Sin limite por defecto (500 mensajes).
  // Usado para diagnosticar pedidos que no llegaron al ERP.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/leer-chat-completo')) {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const tel = (u.searchParams.get('tel') || '').replace(/\D/g, '');
    const limite = Math.min(parseInt(u.searchParams.get('limite') || '500'), 2000);
    if (!tel || tel.length < 7) return json(res, 400, { error: 'tel requerido (min 7 digitos)' });
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
      const telFull = tel.startsWith('57') ? tel : '57' + tel;
      const wapp = `${telFull}@s.whatsapp.net`;
      const jids = [wapp];
      const lidRes = await pool.query(
        `SELECT DISTINCT m.key->>'remoteJid' AS "remoteJid"
         FROM "Message" m
         WHERE m.key->>'remoteJidAlt' = $1 AND m.key->>'remoteJid' LIKE '%@lid'`,
        [wapp]
      );
      for (const r of lidRes.rows) jids.push(r.remoteJid);
      const inst = await pool.query(`SELECT id, name FROM "Instance"`);
      const instById = {}; for (const r of inst.rows) instById[r.id] = r.name;
      const jidsSql = jids.map((_, i) => `$${i+1}`).join(',');
      const msgs = await pool.query(
        `SELECT "instanceId", "messageTimestamp", "pushName", key, message
         FROM "Message"
         WHERE key->>'remoteJid' IN (${jidsSql})
         ORDER BY "messageTimestamp" ASC
         LIMIT ${limite}`,
        jids
      );
      const mensajes = msgs.rows.map(m => {
        const ts = m.messageTimestamp ? new Date(m.messageTimestamp * 1000).toISOString() : null;
        const fromMe = !!m.key?.fromMe;
        const msg = m.message || {};
        let tipo = 'texto', texto = msg.conversation || msg.extendedTextMessage?.text || '';
        let media = null;
        if (!texto) {
          if (msg.imageMessage) { tipo = 'imagen'; texto = msg.imageMessage.caption || ''; media = { mime: msg.imageMessage.mimetype, hash: msg.imageMessage.fileSha256 }; }
          else if (msg.audioMessage) { tipo = 'audio'; texto = '[AUDIO ' + (msg.audioMessage.seconds || '?') + 's]'; }
          else if (msg.stickerMessage) { tipo = 'sticker'; texto = '[STICKER]'; }
          else if (msg.documentMessage) { tipo = 'doc'; texto = '[DOC: ' + (msg.documentMessage.fileName || '?') + ']'; }
          else if (msg.orderMessage) { tipo = 'pedido-catalogo'; texto = '[PEDIDO CATALOGO]'; }
          else if (msg.videoMessage) { tipo = 'video'; texto = '[VIDEO ' + (msg.videoMessage.seconds || '?') + 's]'; }
          else if (msg.locationMessage) { tipo = 'ubicacion'; texto = '[UBICACION]'; }
          else if (msg.contactMessage) { tipo = 'contacto'; texto = '[CONTACTO]'; }
          else { tipo = 'otro'; texto = '[' + Object.keys(msg).join(',') + ']'; }
        }
        return { ts, fromMe, quien: fromMe ? 'vendedora' : 'cliente', instancia: instById[m.instanceId], pushName: m.pushName, tipo, texto: (texto || '').slice(0, 800), media };
      });
      return json(res, 200, {
        ok: true, tel: telFull, jids, total: mensajes.length,
        primeraFecha: mensajes[0]?.ts, ultimaFecha: mensajes[mensajes.length - 1]?.ts,
        mensajes,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    } finally { if (pool) { try { await pool.end(); } catch {} } }
  }



  // ── GET /api/admin/sticker-crudo?tel=X ──────────────────────────────
  // Devuelve el JSON COMPLETO del sticker mas reciente del chat.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/sticker-crudo')) {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const tel = (u.searchParams.get('tel') || '').replace(/\D/g, '');
    if (!tel) return json(res, 400, { error: 'tel requerido' });
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
      const telFull = tel.startsWith('57') ? tel : '57' + tel;
      const wapp = `${telFull}@s.whatsapp.net`;
      // Buscar el @lid de este tel
      const lidRes = await pool.query(
        `SELECT DISTINCT m.key->>'remoteJid' AS "remoteJid"
         FROM "Message" m
         WHERE m.key->>'remoteJidAlt' = $1 AND m.key->>'remoteJid' LIKE '%@lid' LIMIT 1`,
        [wapp]
      );
      const jids = [wapp];
      for (const r of lidRes.rows) jids.push(r.remoteJid);
      const jidsSql = jids.map((_, i) => `$${i+1}`).join(',');
      const msgs = await pool.query(
        `SELECT "messageTimestamp", key, message FROM "Message"
         WHERE key->>'remoteJid' IN (${jidsSql}) AND "messageType" = 'stickerMessage'
         ORDER BY "messageTimestamp" DESC LIMIT 3`,
        jids
      );
      return json(res, 200, { ok: true, tel: telFull, jids, stickers: msgs.rows });
    } catch (e) {
      return json(res, 500, { error: e.message });
    } finally { if (pool) { try { await pool.end(); } catch {} } }
  }

  // ── GET /api/admin/buscar-sticker?tel=X ─────────────────────────────
  // Busca stickers en el chat de un telefono (en @s.whatsapp.net y en @lid).
  // Detecta si son sticker de venta comparando con STICKER_VENTA_HASHES.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/buscar-sticker')) {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const tel = (u.searchParams.get('tel') || '').replace(/\D/g, '');
    if (!tel) return json(res, 400, { error: 'tel requerido' });
    const STK_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim());
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
      const telFull = tel.startsWith('57') ? tel : '57' + tel;
      const wapp = `${telFull}@s.whatsapp.net`;
      // 1) Todos los JIDs del chat (directo + @lid)
      const jids = [wapp];
      const lidRes = await pool.query(
        `SELECT DISTINCT m.key->>'remoteJid' AS "remoteJid"
         FROM "Message" m
         WHERE m.key->>'remoteJidAlt' = $1 AND m.key->>'remoteJid' LIKE '%@lid'`,
        [wapp]
      );
      for (const r of lidRes.rows) jids.push(r.remoteJid);
      // 2) Buscar TODOS los stickers en esos JIDs
      const inst = await pool.query(`SELECT id, name FROM "Instance"`);
      const instById = {}; for (const r of inst.rows) instById[r.id] = r.name;
      const stickers = [];
      for (const jid of jids) {
        const msgs = await pool.query(
          `SELECT "instanceId", "messageTimestamp", key, message
           FROM "Message"
           WHERE key->>'remoteJid' = $1 AND "messageType" = 'stickerMessage'
           ORDER BY "messageTimestamp" DESC`,
          [jid]
        );
        for (const m of msgs.rows) {
          const stk = m.message?.stickerMessage || {};
          let hash = '';
          if (stk.fileSha256) {
            try {
              const buf = Buffer.from(stk.fileSha256.data || Object.values(stk.fileSha256));
              hash = buf.toString('hex');
            } catch {}
          }
          const ts = m.messageTimestamp ? new Date(m.messageTimestamp * 1000).toISOString() : '?';
          stickers.push({
            jid,
            instancia: instById[m.instanceId] || '?',
            fecha: ts,
            fromMe: m.key?.fromMe,
            hash,
            esStickerVenta: STK_VENTA.includes(hash),
          });
        }
      }
      // 3) Contar mensajes totales en cada JID
      const conteo = {};
      for (const jid of jids) {
        const c = await pool.query(
          `SELECT COUNT(*) AS n FROM "Message" WHERE key->>'remoteJid' = $1`,
          [jid]
        );
        conteo[jid] = parseInt(c.rows[0].n);
      }
      return json(res, 200, {
        ok: true, tel: telFull,
        jidsEncontrados: jids,
        mensajesPorJid: conteo,
        totalStickers: stickers.length,
        stickersVentaConfirmados: stickers.filter(s => s.esStickerVenta).length,
        stickers,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    } finally { if (pool) { try { await pool.end(); } catch {} } }
  }

  // ── GET /api/admin/diagnostico-pedidos ─────────────────────────────
  // Cruza los pedidos del ERP con las etiquetas WA de cada telefono.
  // Devuelve:
  //  - Pedidos ERP con su estado ACTUAL y su estado REAL segun etiqueta WA
  //  - Pedidos WA activos que NO estan en el ERP
  //  - Resumen ejecutivo por vendedora
  if (req.method === 'GET' && req.url === '/api/admin/diagnostico-pedidos') {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });

      // Mapeo etiqueta -> estado ERP (mismo que sync)
      const MAPEO = {
        'ws-ventas': { 'en proceso': 'confirmado', 'en tela y en costura': 'costura', 'hecho': 'listo', 'entregado': 'entregado' },
        'ws wendy':  { 'consignado': 'confirmado', 'pedido finalizado': 'entregado' },
        'ws-wendy':  { 'consignado': 'confirmado', 'pedido finalizado': 'entregado' },
        'ws-ney':    { 'pagado': 'confirmado', 'venta': 'entregado' },
        'ws-paola':  { 'pedido en proceso': 'confirmado', 'entregado': 'entregado' },
      };
      const inst = await pool.query(`SELECT id, name FROM "Instance"`);
      const instById = {}, instByName = {};
      for (const r of inst.rows) { instById[r.id] = r.name; instByName[r.name] = r.id; }

      // Precargar labels por instancia
      const labelCache = {};
      for (const iid of Object.keys(instById)) {
        const lr = await pool.query(`SELECT "labelId", name FROM "Label" WHERE "instanceId" = $1`, [iid]);
        labelCache[iid] = {};
        for (const r of lr.rows) labelCache[iid][String(r.labelId)] = String(r.name || '').toLowerCase().trim();
      }

      const normTel = t => { const d = String(t || '').replace(/\D/g, ''); return d.startsWith('57') ? d.slice(2) : d; };

      // Funcion para buscar labels de un telefono en Evolution
      async function labelsPorTel(tel) {
        const telFull = tel.startsWith('57') ? tel : '57' + tel;
        const wapp = `${telFull}@s.whatsapp.net`;
        // 1) chat @s.whatsapp.net directo
        let chats = (await pool.query(
          `SELECT "instanceId", labels FROM "Chat" WHERE "remoteJid" = $1`, [wapp]
        )).rows;
        // 2) chat @lid via remoteJidAlt
        const lidC = (await pool.query(
          `SELECT DISTINCT m."instanceId", m.key->>'remoteJid' AS "remoteJid"
           FROM "Message" m
           WHERE m.key->>'remoteJidAlt' = $1 AND m.key->>'remoteJid' LIKE '%@lid'`,
          [wapp]
        )).rows;
        for (const lc of lidC) {
          const c = (await pool.query(
            `SELECT "instanceId", labels FROM "Chat" WHERE "remoteJid" = $1 AND "instanceId" = $2`,
            [lc.remoteJid, lc.instanceId]
          )).rows;
          chats.push(...c);
        }
        const out = [];
        for (const ch of chats) {
          let raw = ch.labels;
          if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
          const arr = Array.isArray(raw) ? raw : [];
          const names = [];
          const cache = labelCache[ch.instanceId] || {};
          for (const l of arr) {
            if (l && typeof l === 'object' && l.name) names.push(String(l.name).toLowerCase().trim());
            else if (l) {
              const k = String(l);
              names.push(cache[k] || k.toLowerCase().trim());
            }
          }
          out.push({ instancia: (instById[ch.instanceId] || '').toLowerCase(), labels: names });
        }
        return out;
      }

      const peds = leerPedidos();
      const pedidosERP = [];
      for (const p of peds) {
        const tel = String(p.telefono || '').replace(/\D/g, '');
        if (!tel) { pedidosERP.push({ ...pedResumen(p), waLabels: [], estadoWA: null }); continue; }
        const chats = await labelsPorTel(tel);
        // Determinar estado sugerido por WA
        let estadoWA = null, labelWA = null, instanciaWA = null;
        for (const ch of chats) {
          const mapeo = MAPEO[ch.instancia];
          if (!mapeo) continue;
          for (const ln of ch.labels) {
            if (mapeo[ln]) { estadoWA = mapeo[ln]; labelWA = ln; instanciaWA = ch.instancia; break; }
          }
          if (estadoWA) break;
        }
        pedidosERP.push({
          id: p.id,
          equipo: p.equipo || '?',
          vendedora: p.vendedora || '?',
          telefono: p.telefono || '',
          estadoERP: p.estado,
          estadoWA,
          labelWA,
          instanciaWA,
          discrepancia: estadoWA && estadoWA !== p.estado,
        });
      }
      function pedResumen(p) {
        return { id: p.id, equipo: p.equipo, vendedora: p.vendedora, telefono: p.telefono, estadoERP: p.estado };
      }

      return json(res, 200, {
        ok: true,
        totalPedidosERP: peds.length,
        pedidosERP,
        resumen: {
          totalERP: peds.length,
          conDiscrepancia: pedidosERP.filter(x => x.discrepancia).length,
          entregadosSegunWA: pedidosERP.filter(x => x.estadoWA === 'entregado' && x.estadoERP !== 'entregado' && x.estadoERP !== 'enviado-final').length,
          sinLabelWA: pedidosERP.filter(x => !x.estadoWA).length,
        },
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: (e.stack||'').slice(0,500) });
    } finally { if (pool) { try { await pool.end(); } catch {} } }
  }

  // ── POST /api/admin/revertir-sync-etiquetas ────────────────────────
  // Borra TODOS los pedidos importados con origen=sync-etiquetas-wa
  // (deja el estado original del ERP intacto).
  if (req.method === 'POST' && req.url === '/api/admin/revertir-sync-etiquetas') {
    try {
      const todos = leerPedidos();
      const aBorrar = todos.filter(p => p.origen === 'sync-etiquetas-wa').map(p => p.id);
      const restantes = todos.filter(p => p.origen !== 'sync-etiquetas-wa');
      guardarPedidos(restantes, leerNextId());
      return json(res, 200, { ok: true, borrados: aBorrar.length, ids: aBorrar });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/admin/auditar-imports?n=10 ─────────────────────────────
  // Toma N pedidos importados por sync-etiquetas-wa al azar y muestra
  // sus chats para verificar que son ventas reales.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/auditar-imports')) {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const n = Math.min(parseInt(u.searchParams.get('n') || '10'), 20);
    const filtroEstado = u.searchParams.get('estado'); // opcional: entregado/confirmado/costura/listo
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
      const peds = leerPedidos().filter(p =>
        p.origen === 'sync-etiquetas-wa' &&
        (!filtroEstado || p.estado === filtroEstado) &&
        p.telefono
      );
      // Muestra aleatoria
      const shuffled = [...peds].sort(() => Math.random() - 0.5).slice(0, n);
      const inst = await pool.query(`SELECT id, name FROM "Instance"`);
      const instById = {};
      for (const r of inst.rows) instById[r.id] = r.name;
      const resultados = [];
      for (const p of shuffled) {
        const tel = String(p.telefono || '').replace(/\D/g, '');
        if (!tel) continue;
        const telFull = tel.startsWith('57') ? tel : '57' + tel;
        // Buscar chat
        const wapp = `${telFull}@s.whatsapp.net`;
        let chats = (await pool.query(`SELECT "instanceId", "remoteJid" FROM "Chat" WHERE "remoteJid" = $1`, [wapp])).rows;
        if (chats.length === 0) {
          const lidC = (await pool.query(
            `SELECT DISTINCT m."instanceId", m.key->>'remoteJid' AS "remoteJid"
             FROM "Message" m WHERE m.key->>'remoteJidAlt' = $1 AND m.key->>'remoteJid' LIKE '%@lid' LIMIT 1`, [wapp])).rows;
          chats.push(...lidC);
        }
        const chat = chats[0];
        if (!chat) { resultados.push({ id: p.id, tel: telFull, estado: p.estado, indicadores: 'chat no encontrado', totalMsgs: 0, ultimos: [] }); continue; }
        // Total mensajes
        const cnt = await pool.query(
          `SELECT COUNT(*) AS n FROM "Message" WHERE "instanceId" = $1 AND key->>'remoteJid' = $2`,
          [chat.instanceId, chat.remoteJid]
        );
        // Ultimos 6 mensajes
        const msgs = await pool.query(
          `SELECT "messageTimestamp", key, message FROM "Message"
           WHERE "instanceId" = $1 AND key->>'remoteJid' = $2
           ORDER BY "messageTimestamp" DESC LIMIT 6`,
          [chat.instanceId, chat.remoteJid]
        );
        const ultimos = msgs.rows.reverse().map(m => {
          const ts = m.messageTimestamp ? new Date(m.messageTimestamp * 1000).toISOString().slice(5,16).replace('T',' ') : '?';
          const fromMe = m.key?.fromMe;
          const msg = m.message || {};
          let txt = msg.conversation || msg.extendedTextMessage?.text || '';
          if (!txt) {
            if (msg.imageMessage) txt = '[IMG'+(msg.imageMessage.caption ? ':'+msg.imageMessage.caption : '')+']';
            else if (msg.audioMessage) txt = '[AUDIO]';
            else if (msg.stickerMessage) txt = '[STICKER]';
            else if (msg.documentMessage) txt = '[DOC]';
            else if (msg.orderMessage) txt = '[PEDIDO CATALOGO]';
            else if (msg.videoMessage) txt = '[VIDEO]';
            else if (msg.locationMessage) txt = '[UBICACION]';
            else txt = '['+Object.keys(msg).join(',').slice(0,30)+']';
          }
          return `${ts} | ${fromMe?'Vend':'Clnt'} | ${(txt||'').slice(0,120)}`;
        });
        // Indicadores heuristicos de venta
        const allText = ultimos.join(' ').toLowerCase();
        const indicadores = [];
        if (/nequi|daviplata|bancolomb|transfe|abono|consigna|pago|comprobante/.test(allText)) indicadores.push('mencion pago');
        if (/tarj|cuen|listo|entrega|domicil|direcc/.test(allText)) indicadores.push('log entrega');
        if (parseInt(cnt.rows[0].n) < 3) indicadores.push('POCOS MENSAJES!');
        resultados.push({
          id: p.id,
          equipo: p.equipo,
          tel: telFull,
          estado: p.estado,
          vendedora: p.vendedora,
          instancia: instById[chat.instanceId] || '?',
          totalMsgs: parseInt(cnt.rows[0].n),
          indicadores: indicadores.join(', ') || 'sin indicadores claros',
          ultimos,
        });
      }
      return json(res, 200, { ok: true, muestra: resultados.length, resultados });
    } catch (e) {
      return json(res, 500, { error: e.message });
    } finally { if (pool) { try { await pool.end(); } catch {} } }
  }

  // ── GET /api/admin/verificar-chat?tel=573003270280 ──────────────────
  // Muestra el chat completo (labels + ultimos mensajes) del telefono dado.
  // Sirve para verificar si un pedido detectado por sync-etiquetas-wa es
  // realmente una venta o un falso positivo.
  if (req.method === 'GET' && req.url.startsWith('/api/admin/verificar-chat')) {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const tel = (u.searchParams.get('tel') || '').replace(/\D/g, '');
    if (!tel || tel.length < 7) return json(res, 400, { error: 'tel requerido' });
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
      const telFull = tel.startsWith('57') ? tel : '57' + tel;
      // Buscar chat: puede estar en @s.whatsapp.net directo o en @lid con remoteJidAlt
      const wappJid = `${telFull}@s.whatsapp.net`;
      const inst = await pool.query(`SELECT id, name FROM "Instance"`);
      const instName = {};
      for (const r of inst.rows) instName[r.id] = r.name;

      // Primero @s.whatsapp.net directo
      let chats = await pool.query(
        `SELECT c."remoteJid", c.labels, c."instanceId" FROM "Chat" c
         WHERE c."remoteJid" = $1`,
        [wappJid]
      );
      // Si no encuentra, buscar via Message.remoteJidAlt
      if (chats.rows.length === 0) {
        const lidChats = await pool.query(
          `SELECT DISTINCT m."instanceId", m.key->>'remoteJid' AS "remoteJid"
           FROM "Message" m
           WHERE m.key->>'remoteJidAlt' = $1
             AND m.key->>'remoteJid' LIKE '%@lid'`,
          [wappJid]
        );
        for (const lidRow of lidChats.rows) {
          const c = await pool.query(
            `SELECT "remoteJid", labels, "instanceId" FROM "Chat"
             WHERE "remoteJid" = $1 AND "instanceId" = $2`,
            [lidRow.remoteJid, lidRow.instanceId]
          );
          chats.rows.push(...c.rows);
        }
      }

      const resultados = [];
      for (const chat of chats.rows) {
        const instanciaNombre = instName[chat.instanceId] || chat.instanceId;
        // Resolver nombres de labels
        let labelsRaw = chat.labels;
        if (typeof labelsRaw === 'string') { try { labelsRaw = JSON.parse(labelsRaw); } catch { labelsRaw = []; } }
        const labelsArr = Array.isArray(labelsRaw) ? labelsRaw : [];
        const labelIds = labelsArr.map(l => (l && typeof l === 'object') ? String(l.id || l.labelId || '') : String(l));
        const labRes = labelIds.length > 0 ? await pool.query(
          `SELECT "labelId", name FROM "Label" WHERE "instanceId" = $1 AND "labelId" = ANY($2)`,
          [chat.instanceId, labelIds]
        ) : { rows: [] };
        const labels = labRes.rows.map(r => r.name);
        // Ultimos 30 mensajes
        const msgs = await pool.query(
          `SELECT "messageTimestamp", "pushName", key, message
           FROM "Message"
           WHERE "instanceId" = $1 AND key->>'remoteJid' = $2
           ORDER BY "messageTimestamp" DESC
           LIMIT 30`,
          [chat.instanceId, chat.remoteJid]
        );
        const mensajes = msgs.rows.reverse().map(m => {
          const ts = m.messageTimestamp ? new Date(m.messageTimestamp * 1000).toISOString().slice(5,16).replace('T',' ') : '?';
          const fromMe = m.key?.fromMe;
          const msg = m.message || {};
          let txt = msg.conversation || msg.extendedTextMessage?.text || '';
          if (!txt) {
            if (msg.imageMessage) txt = '[IMG' + (msg.imageMessage.caption ? ': '+msg.imageMessage.caption : '') + ']';
            else if (msg.audioMessage) txt = '[AUDIO]';
            else if (msg.videoMessage) txt = '[VIDEO]';
            else if (msg.stickerMessage) txt = '[STICKER]';
            else if (msg.documentMessage) txt = '[DOC: '+(msg.documentMessage.fileName||'?')+']';
            else if (msg.orderMessage) txt = '[PEDIDO CATALOGO]';
            else if (msg.locationMessage) txt = '[UBICACION]';
            else txt = '[' + Object.keys(msg).join(',') + ']';
          }
          return { fecha: ts, quien: fromMe ? 'Vendedora' : 'Cliente', texto: (txt||'').slice(0,200) };
        });
        resultados.push({ instancia: instanciaNombre, chatJid: chat.remoteJid, labels, totalMensajes: msgs.rows.length, mensajes });
      }
      return json(res, 200, { ok: true, tel: telFull, encontrados: resultados.length, chats: resultados });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack.slice(0,500) });
    } finally { if (pool) { try { await pool.end(); } catch {} } }
  }

  // ── GET /api/admin/debug-evolution-schema — diagnostico del schema ──
  // Para entender como Evolution resuelve @lid -> telefono real.
  if (req.method === 'GET' && req.url === '/api/admin/debug-evolution-schema') {
    const dbUrl = process.env.EVOLUTION_DB_URL;
    if (!dbUrl) return json(res, 500, { error: 'falta EVOLUTION_DB_URL' });
    let pool = null;
    try {
      pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
      // 1) columnas de la tabla Contact
      const contactCols = await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'Contact' ORDER BY ordinal_position
      `);
      // 2) muestra de un contacto con @lid
      const lidSample = await pool.query(`
        SELECT * FROM "Contact" WHERE "remoteJid" LIKE '%@lid' LIMIT 3
      `);
      // 3) muestra de un mensaje con remoteJidAlt (donde WA guarda el tel real)
      const msgSample = await pool.query(`
        SELECT key FROM "Message"
        WHERE key::text LIKE '%remoteJidAlt%' AND key::text LIKE '%@lid%'
        LIMIT 3
      `);
      // 4) muestra de un chat con @lid y sus labels
      const chatSample = await pool.query(`
        SELECT "remoteJid", labels FROM "Chat"
        WHERE "remoteJid" LIKE '%@lid' AND labels IS NOT NULL
          AND labels::text NOT IN ('null','[]','""')
        LIMIT 5
      `);
      return json(res, 200, {
        ok: true,
        contactColumnas: contactCols.rows,
        lidSample: lidSample.rows,
        msgSampleKeys: msgSample.rows.map(r => r.key),
        chatLidConLabels: chatSample.rows,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    } finally {
      if (pool) { try { await pool.end(); } catch {} }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // POST /api/admin/sync-etiquetas-wa
  // Lee la DB Postgres de Evolution directo (necesita EVOLUTION_DB_URL).
  // Bypasea el bug de Evolution v2.3.7 donde findChats ignora filtro labels.
  // Para cada chat con label mapeada, crea pedido en ERP si no existe o
  // actualiza el estado del existente.
  // Body (opcional): { soloPreview: true } -> reporta sin escribir
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/admin/sync-etiquetas-wa') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024*1024) req.destroy(); });
    req.on('end', async () => {
      const dbUrl = process.env.EVOLUTION_DB_URL;
      if (!dbUrl) {
        return json(res, 500, { error: 'falta EVOLUTION_DB_URL en env vars' });
      }
      const data = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
      const soloPreview = !!data.soloPreview;

      // Mapeo etiqueta WA (por instancia y nombre normalizado) -> estado ERP
      // Coincide con ETIQUETAS_POR_INSTANCIA del handler labels.association.
      const MAPEO = {
        'ws-ventas': { 'en proceso': 'confirmado', 'en tela y en costura': 'costura', 'hecho': 'listo', 'entregado': 'entregado' },
        'ws wendy':  { 'consignado': 'confirmado', 'pedido finalizado': 'entregado' },
        'ws-wendy':  { 'consignado': 'confirmado', 'pedido finalizado': 'entregado' },
        'ws-ney':    { 'pagado': 'confirmado', 'venta': 'entregado' },
        'ws-paola':  { 'pedido en proceso': 'confirmado', 'entregado': 'entregado' },
      };
      const VENDEDORA = { 'ws-ventas':'Betty', 'ws wendy':'Wendy', 'ws-wendy':'Wendy', 'ws-ney':'Ney', 'ws-paola':'Paola' };
      const ESTADOS_INACTIVOS = new Set(['entregado', 'archivado', 'cancelado', 'descartado', 'enviado-final']);

      let pool = null;
      try {
        pool = new PgPool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
        // 1) Leer instancias para obtener instanceId por nombre
        const instRes = await pool.query(`SELECT id, name FROM "Instance"`);
        const instById = {};
        const instByName = {};
        for (const r of instRes.rows) { instById[r.id] = r.name; instByName[r.name] = r.id; }

        // 2) Leer TODOS los chats que tengan campo labels NO vacio.
        //    El campo es JSONB; los chats sin labels lo tienen null o '[]'.
        const chatRes = await pool.query(`
          SELECT "instanceId", "remoteJid", labels
          FROM "Chat"
          WHERE labels IS NOT NULL
            AND labels::text NOT IN ('null', '[]', '""')
        `);

        const reporte = {
          ts: new Date().toISOString(),
          soloPreview,
          totalChatsConLabels: chatRes.rows.length,
          porInstancia: {},
          creados: [],
          actualizados: [],
          ignorados: { sinMapeo: 0, jidNoIndiv: 0, telInvalido: 0 },
          etiquetasSinMapear: {}, // debug: qué etiquetas no mapeamos (para ver si falta alguna)
        };
        // Cache de nombres de labels por instancia (evita queries repetidas)
        const labelNameCache = {}; // labelNameCache[instanceId][labelId] = name

        const pedidos = leerPedidos();
        const normTel = t => { const d = String(t || '').replace(/\D/g, ''); return d.startsWith('57') ? d.slice(2) : d; };
        const ahora = new Date().toISOString();

        // Precargar TODAS las labels por instancia (una query por instancia)
        // asi resolvemos IDs a nombres sin queries repetidas por chat.
        for (const iid of Object.keys(instById)) {
          const labRes = await pool.query(
            `SELECT "labelId", name FROM "Label" WHERE "instanceId" = $1`,
            [iid]
          );
          labelNameCache[iid] = {};
          for (const r of labRes.rows) labelNameCache[iid][String(r.labelId)] = String(r.name || '').toLowerCase().trim();
        }

        for (const row of chatRes.rows) {
          const instName = (instById[row.instanceId] || '').toLowerCase();
          if (!instName) continue;
          const mapeo = MAPEO[instName];
          if (!mapeo) continue;

          // El campo labels puede venir como:
          //  - array de strings (IDs de label): ["15","67",...]
          //  - array de objetos con id/name: [{id, name}, ...]
          //  - array de strings con nombre: ["En Proceso", ...]
          let labelsRaw = row.labels;
          if (typeof labelsRaw === 'string') {
            try { labelsRaw = JSON.parse(labelsRaw); } catch { labelsRaw = []; }
          }
          const labelsArr = Array.isArray(labelsRaw) ? labelsRaw : [];
          const cache = labelNameCache[row.instanceId] || {};
          const labelNames = [];
          for (const l of labelsArr) {
            if (l && typeof l === 'object' && l.name) {
              labelNames.push(String(l.name).toLowerCase().trim());
            } else if (l) {
              const key = String(l);
              // 1) intentar como id en el cache
              if (cache[key]) labelNames.push(cache[key]);
              // 2) sino usar directo como nombre
              else labelNames.push(key.toLowerCase().trim());
            }
          }
          // Buscar la PRIMERA label que mapee a un estado
          let estadoNuevo = null, labelMatch = null;
          for (const lname of labelNames) {
            if (mapeo[lname]) { estadoNuevo = mapeo[lname]; labelMatch = lname; break; }
          }
          if (!estadoNuevo) {
            reporte.ignorados.sinMapeo++;
            // Guardar debug de qué etiquetas aparecen sin mapear
            for (const lname of labelNames) {
              if (!reporte.etiquetasSinMapear[lname]) reporte.etiquetasSinMapear[lname] = 0;
              reporte.etiquetasSinMapear[lname]++;
            }
            continue;
          }

          // Validar JID — @lid es el nuevo formato WA, TIENE cliente valido
          const jid = row.remoteJid || '';
          if (jid.includes('@g.us')) { reporte.ignorados.jidNoIndiv++; continue; }
          // Para @lid: el tel real vive en Message.key.remoteJidAlt.
          // Cualquier mensaje del chat tiene ese campo con el @s.whatsapp.net real.
          let telRaw = '';
          if (jid.includes('@lid')) {
            const mRes = await pool.query(
              `SELECT key->>'remoteJidAlt' AS tel FROM "Message"
               WHERE "instanceId" = $1
                 AND key->>'remoteJid' = $2
                 AND key->>'remoteJidAlt' LIKE '%@s.whatsapp.net'
               LIMIT 1`,
              [row.instanceId, jid]
            ).catch(() => ({ rows: [] }));
            if (mRes.rows.length > 0 && mRes.rows[0].tel) {
              telRaw = mRes.rows[0].tel.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            }
          } else {
            telRaw = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
          }
          if (telRaw.length < 7 || telRaw.length > 12) { reporte.ignorados.telInvalido++; continue; }
          const telN = normTel(telRaw);

          // Acumular en reporte por instancia
          if (!reporte.porInstancia[instName]) reporte.porInstancia[instName] = {};
          if (!reporte.porInstancia[instName][labelMatch]) reporte.porInstancia[instName][labelMatch] = 0;
          reporte.porInstancia[instName][labelMatch]++;

          // Buscar pedido activo
          const pdActivo = pedidos.find(p => normTel(p.telefono) === telN && !ESTADOS_INACTIVOS.has(p.estado || ''));
          if (pdActivo) {
            if (pdActivo.estado !== estadoNuevo) {
              if (!soloPreview) {
                const estadoPrev = pdActivo.estado;
                pdActivo.estado = estadoNuevo;
                pdActivo.ultimoMovimiento = ahora;
                pdActivo.historial = pdActivo.historial || [];
                pdActivo.historial.push({
                  ts: ahora,
                  evento: `Sync etiquetas WA: "${labelMatch}" (${instName}) → ${estadoNuevo}`,
                  automatico: true,
                });
              }
              reporte.actualizados.push({ id: pdActivo.id, equipo: pdActivo.equipo, de: pdActivo.estado, a: estadoNuevo, instancia: instName });
            }
          } else {
            // No hay pedido activo: crear uno nuevo en el estado correspondiente
            if (!soloPreview) {
              const vendedora = VENDEDORA[instName] || '';
              const nuevoId = db.leerNextId();
              const nuevo = {
                id: nuevoId,
                tipo: 'pedido',
                equipo: `Pedido importado #${nuevoId}`,
                telefono: telRaw,
                vendedora,
                estado: estadoNuevo,
                nombreEsTentativo: true,
                origen: 'sync-etiquetas-wa',
                fechaVenta: '',
                ultimoMovimiento: ahora,
                historial: [{
                  ts: ahora,
                  evento: `Importado de etiqueta WA "${labelMatch}" (${instName})`,
                  automatico: true,
                }],
              };
              db.upsertPedido(nuevo);
            }
            reporte.creados.push({ tel: telRaw, instancia: instName, estado: estadoNuevo, label: labelMatch });
          }
        }

        return json(res, 200, { ok: true, ...reporte });
      } catch (e) {
        console.error('[sync-etiquetas-wa]', e);
        return json(res, 500, { error: e.message });
      } finally {
        if (pool) { try { await pool.end(); } catch {} }
      }
    });
    return;
  }

  // ── POST /api/costura/cerrar-atascado ──────────────────────────────
  // Marca un pedido como `entregado` y cierra sus movimientos abiertos.
  // Body: { pedido_id, motivo? }
  // Util cuando Camilo ve un pedido pegado en /costura que ya entregó pero
  // nadie marcó. Esto reemplaza tener que tocar la DB a mano.
  if (req.method === 'POST' && req.url === '/api/costura/cerrar-atascado') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024*1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const pedido_id = parseInt(data.pedido_id, 10);
        if (!pedido_id) return json(res, 400, { error: 'pedido_id requerido' });
        const motivo = (data.motivo || 'cerrado manual desde /costura').slice(0, 200);
        const todos = leerPedidos();
        const idx = todos.findIndex(x => x.id === pedido_id);
        if (idx < 0) return json(res, 404, { error: 'pedido no existe' });
        const ped = todos[idx];
        const estadoPrev = ped.estado;
        ped.estado = 'entregado';
        ped.ultimoMovimiento = new Date().toISOString();
        ped.historial = ped.historial || [];
        ped.historial.push({
          fecha: new Date().toISOString(),
          por: 'app-costura',
          accion: 'cerrar-atascado',
          de: estadoPrev,
          a: 'entregado',
          nota: motivo,
        });
        guardarPedidos(todos, leerNextId());
        const movsCerrados = db.cerrarMovimientosAbiertosPorPedido(pedido_id, { motivo });
        return json(res, 200, { ok: true, pedido_id, estadoPrev, movsCerrados });
      } catch (e) {
        console.error('[cerrar-atascado]', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /api/costura/buscar-pedido?q=texto — autocompletar nombre de equipo ──
  // Devuelve hasta 5 pedidos ACTIVOS cuyo equipo/cliente/vendedora matchea el texto.
  // Usado por la app /costura cuando Camilo o Graciela escriben el nombre del equipo.
  if (req.method === 'GET' && req.url.startsWith('/api/costura/buscar-pedido')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      if (!q || q.length < 2) return json(res, 200, { ok: true, pedidos: [] });
      const tokens = q.split(/\s+/).filter(Boolean);
      // Excluir cerrados (entregado-final, archivado, cancelado, descartado)
      const ESTADOS_INACTIVOS = new Set(['enviado-final', 'archivado', 'cancelado', 'descartado']);
      const peds = leerPedidos().filter(p => !ESTADOS_INACTIVOS.has(p.estado || ''));
      const matches = peds
        .map(p => {
          const haystack = [p.equipo, p.telefono, p.pushNameCliente, p.nombreCliente, p.vendedora]
            .filter(Boolean).join(' ').toLowerCase();
          let score = 0;
          for (const t of tokens) {
            if (haystack.includes(t)) score++;
          }
          // Bonus si el equipo empieza con el texto (match mas fuerte)
          if (p.equipo && p.equipo.toLowerCase().startsWith(q)) score += 2;
          return { p, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(x => ({
          id: x.p.id,
          equipo: x.p.equipo || `Pedido #${x.p.id}`,
          vendedora: x.p.vendedora || '',
          estado: x.p.estado,
          telefono: x.p.telefono || '',
          thumbnail: (db.getFotoPedido(x.p.id)?.url) || (x.p.drive?.pdfRip?.thumbnail) || null,
        }));
      return json(res, 200, { ok: true, total: matches.length, pedidos: matches });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/costura/tarifas — listado de tarifas configuradas ──
  if (req.method === 'GET' && req.url === '/api/costura/tarifas') {
    try {
      return json(res, 200, { tarifas: db.listarTarifasCostura() || [] });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/costura/tarifas — configurar tarifas ──
  // Body: { tipo: 'camiseta', valor: 4500 }  ó  { tarifas: [{tipo,valor},...] }
  if (req.method === 'POST' && req.url === '/api/costura/tarifas') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (Array.isArray(data.tarifas)) {
          data.tarifas.forEach(t => db.setTarifaCostura(t.tipo, t.valor));
        } else if (data.tipo) {
          db.setTarifaCostura(data.tipo, data.valor);
        } else {
          return json(res, 400, { error: 'falta tipo+valor o tarifas[]' });
        }
        return json(res, 200, { ok: true, tarifas: db.listarTarifasCostura() });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // MINI-APP COSTURA — Endpoints de detalle / acciones
  // ═══════════════════════════════════════════════════════════════════

  // ── GET /api/costura/pedido/:id — ficha completa del pedido ──
  if (req.method === 'GET' && req.url.match(/^\/api\/costura\/pedido\/\d+$/)) {
    try {
      const id = parseInt(req.url.split('/').pop(), 10);
      const peds = leerPedidos();
      const p = peds.find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });

      // Movimientos de costura asociados
      const movs = (db.leerMovimientosCosturaPendientes() || [])
        .filter(m => m.pedido_id === id);
      const movsTodos = db.raw.prepare(
        'SELECT * FROM costureras_movimientos WHERE pedido_id = ? ORDER BY fecha_envio DESC'
      ).all(id);

      // Foto: 1) override manual, 2) thumbnail Drive, 3) null (placeholder en UI)
      const fotoManual = db.getFotoPedido(id);
      const foto = fotoManual?.url
        || p.drive?.pdfRip?.thumbnail
        || null;

      // Tarifas para calcular costo costura sugerido
      const tarifas = Object.fromEntries(
        (db.listarTarifasCostura() || []).map(t => [t.tipo, t.valor])
      );

      // Composición: si el pedido no tiene desglose explicito, derivar del campo numUniformes
      // como una sola fila "camiseta" (default editable en UI)
      const composicion = Array.isArray(p.prendas) && p.prendas.length
        ? p.prendas
        : (p.numUniformes ? [{ tipo: p.tipoPrenda || 'camiseta', cantidad: p.numUniformes }] : []);

      return json(res, 200, {
        ok: true,
        pedido: {
          id: p.id,
          equipo: p.equipo || `Pedido #${p.id}`,
          vendedora: p.vendedora || '',
          cliente: p.pushNameCliente || '',
          telefono: p.telefono || '',
          fechaVenta: p.fechaVenta || '',
          estado: p.estado,
          numUniformes: p.numUniformes || null,
          tipoPrenda: p.tipoPrenda || '',
          color: p.color || '',
          fechaEntregaTexto: p.fechaEntregaTexto || '',
          notas: p.notas || '',
          total: p.total || 0,
          abonado: p.abonado || 0,
          saldoPendiente: p.saldoPendiente || 0,
          composicion,
          foto,
          drive: p.drive || null,
          historial: (p.historial || []).slice(-10),
        },
        movimientosCostura: movsTodos,
        tarifas,
      });
    } catch (e) {
      console.error('[costura pedido]', e);
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/costura/asignar — asignar pedido a costurera ──
  // Body: { pedido_id, costurera_slug, prendas: [{tipo, cantidad}], notas }
  // - Crea UN movimiento por cada tipo de prenda (para tracking granular)
  // - Avanza pedido a 'en-costura'
  if (req.method === 'POST' && req.url === '/api/costura/asignar') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const { pedido_id, costurera_slug, prendas, notas } = data;
        if (!pedido_id || !costurera_slug || !Array.isArray(prendas) || !prendas.length) {
          return json(res, 400, { error: 'falta pedido_id, costurera_slug o prendas[]' });
        }
        const costu = PERSONAS.find(p => p.slug === costurera_slug && p.roles.includes('costura'));
        if (!costu) return json(res, 400, { error: 'costurera no encontrada' });

        const peds = leerPedidos();
        const idx = peds.findIndex(x => x.id === pedido_id);
        if (idx < 0) return json(res, 404, { error: 'pedido no existe' });
        const p = peds[idx];

        // Crear UN movimiento por cada tipo de prenda
        const tarifas = Object.fromEntries(
          (db.listarTarifasCostura() || []).map(t => [t.tipo, t.valor])
        );
        const movIds = [];
        let totalPrendas = 0;
        let valorTotal = 0;
        for (const pr of prendas) {
          const tipo = String(pr.tipo || '').toLowerCase();
          const cantidad = parseInt(pr.cantidad, 10) || 0;
          if (!tipo || cantidad <= 0) continue;
          const mid = db.crearMovimientoCostura({
            pedido_id,
            costurera_slug,
            costurera_nombre: costu.nombre,
            equipo: p.equipo || '',
            prenda: tipo,
            cantidad_enviada: cantidad,
            enviado_por: 'Camilo',
            observaciones: notas || null,
          });
          movIds.push(mid);
          totalPrendas += cantidad;
          valorTotal += (tarifas[tipo] || 0) * cantidad;
        }

        // Avanzar pedido a 'en-costura' y guardar referencia de costurera
        const estadoAnterior = p.estado;
        p.estado = 'en-costura';
        p.satelite = costu.nombre;
        p.ultimoMovimiento = new Date().toISOString();
        p.costuraResumen = {
          costureraSlug: costurera_slug,
          costureraNombre: costu.nombre,
          totalPrendas,
          valorAPagar: valorTotal,
          fechaAsignacion: new Date().toISOString(),
          movIds,
        };
        p.historial = p.historial || [];
        p.historial.push({
          fecha: new Date().toISOString(),
          por: 'Camilo',
          accion: 'asignar-costurera',
          de: estadoAnterior,
          a: 'en-costura',
          nota: `${costu.nombre}: ${totalPrendas} prendas, $${valorTotal.toLocaleString('es-CO')}`,
        });
        peds[idx] = p;
        db.guardarPedidos(peds);

        return json(res, 200, {
          ok: true,
          movIds,
          totalPrendas,
          valorAPagar: valorTotal,
          costurera: costu.nombre,
        });
      } catch (e) {
        console.error('[costura asignar]', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/costura/devolver — marcar devolucion ──
  // Body: { pedido_id, devoluciones: [{movimiento_id, cantidad_recibida}], notas }
  // - Si todas las prendas devueltas == enviadas: avanza pedido a 'listo'
  // - Si faltan: registra faltante (el flujo de arreglo automatico se mantiene)
  if (req.method === 'POST' && req.url === '/api/costura/devolver') {
    let body = '';
    req.on('data', d => {
      body += d;
      if (body.length > 20 * 1024 * 1024) req.destroy(); // 20MB max (foto opcional)
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const { pedido_id, devoluciones, notas, fotoLoteBase64, fotoLoteMime } = data;
        if (!pedido_id || !Array.isArray(devoluciones) || !devoluciones.length) {
          return json(res, 400, { error: 'falta pedido_id o devoluciones[]' });
        }

        const peds = leerPedidos();
        const idx = peds.findIndex(x => x.id === pedido_id);
        if (idx < 0) return json(res, 404, { error: 'pedido no existe' });
        const p = peds[idx];

        let totalEnviado = 0;
        let totalRecibido = 0;
        let totalFaltante = 0;

        for (const dev of devoluciones) {
          const mov = db.leerMovimientoCostura(dev.movimiento_id);
          if (!mov || mov.pedido_id !== pedido_id) continue;
          const recibida = parseInt(dev.cantidad_recibida, 10) || 0;
          const faltante = Math.max(0, mov.cantidad_enviada - recibida);
          db.recibirMovimientoCostura(dev.movimiento_id, {
            cantidad_recibida: recibida,
            faltante,
            recibido_por: 'Camilo',
            observaciones: notas || null,
          });
          totalEnviado += mov.cantidad_enviada;
          totalRecibido += recibida;
          totalFaltante += faltante;
        }

        // Guardar foto del lote terminado (proof visual) si vino
        let fotoLoteGuardada = false;
        if (fotoLoteBase64 && fotoLoteMime) {
          try {
            const fotoDataUrl = `data:${fotoLoteMime};base64,${fotoLoteBase64}`;
            // Reusa la cache de fotos por pedido (sobreescribe la del corte si habia,
            // pero para el lote terminado es lo que importa visualmente al final).
            db.setFotoPedido(pedido_id, fotoDataUrl, 'lote-terminado-devolver');
            fotoLoteGuardada = true;
          } catch (eFoto) {
            console.error('[devolver foto]', eFoto.message);
          }
        }

        // Avanzar estado del pedido
        const estadoAnterior = p.estado;
        if (totalFaltante === 0) {
          p.estado = 'listo';
        } else {
          p.estado = 'costura-parcial';
        }
        p.ultimoMovimiento = new Date().toISOString();
        p.historial = p.historial || [];
        p.historial.push({
          fecha: new Date().toISOString(),
          por: 'Camilo',
          accion: 'marcar-devuelto-costura',
          de: estadoAnterior,
          a: p.estado,
          nota: `Recibido ${totalRecibido}/${totalEnviado}${totalFaltante > 0 ? ` (faltan ${totalFaltante})` : ''}${fotoLoteGuardada ? ' [foto lote guardada]' : ''}`,
        });
        peds[idx] = p;
        db.guardarPedidos(peds);

        return json(res, 200, {
          ok: true,
          totalEnviado,
          totalRecibido,
          totalFaltante,
          nuevoEstado: p.estado,
          fotoLoteGuardada,
        });
      } catch (e) {
        console.error('[costura devolver]', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/costura/pagar — marcar pago semanal a una costurera ──
  // Body: { costurera_slug, semana?, monto, metodo?, referencia? }
  if (req.method === 'POST' && req.url === '/api/costura/pagar') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const { costurera_slug, monto, metodo, referencia } = data;
        if (!costurera_slug || !monto) return json(res, 400, { error: 'falta costurera_slug o monto' });
        const ahora = new Date();
        const dia = ahora.getDay();
        const diasDesdeLunes = (dia === 0 ? 6 : dia - 1);
        const inicio = new Date(ahora);
        inicio.setHours(0,0,0,0);
        inicio.setDate(ahora.getDate() - diasDesdeLunes);
        const semana = data.semana || inicio.toISOString().slice(0,10);

        const pagoId = db.registrarPagoCostura({
          costurera_slug,
          semana,
          monto: parseInt(monto, 10) || 0,
          metodo: metodo || 'Nequi',
          referencia: referencia || null,
        });
        return json(res, 200, { ok: true, pagoId, semana });
      } catch (e) {
        console.error('[costura pagar]', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // POST /api/costura/match-foto — Camilo sube frente+espalda del corte,
  // Gemini Vision compara contra pedidos del ERP en estados relevantes.
  // Body: { frenteBase64, frenteMime, espaldaBase64, espaldaMime }
  // Devuelve: { ok, matches: [...], mejorMatch, confianzaGlobal, razonamiento, candidatosEvaluados }
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/costura/match-foto') {
    let body = '';
    req.on('data', d => {
      body += d;
      if (body.length > 20 * 1024 * 1024) { // 20MB max
        req.destroy();
      }
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        // Acepta 3 formatos:
        //   a) { fotoBase64, fotoMime }                          ← 1-shot (preferido nuevo)
        //   b) { fotos: [{ base64, mime, vista? }, ...] }        ← lista
        //   c) { frenteBase64, frenteMime, espaldaBase64, espaldaMime } ← legacy frente+espalda
        const { frenteBase64, frenteMime, espaldaBase64, espaldaMime, fotoBase64, fotoMime, fotos } = data;
        const fotosCorte = [];
        if (Array.isArray(fotos) && fotos.length > 0) {
          for (const f of fotos) {
            if (f?.base64) fotosCorte.push({ base64: f.base64, mime: f.mime || 'image/jpeg', vista: f.vista || 'foto' });
          }
        } else if (fotoBase64) {
          fotosCorte.push({ base64: fotoBase64, mime: fotoMime || 'image/jpeg', vista: 'foto' });
        } else {
          if (frenteBase64) fotosCorte.push({ base64: frenteBase64, mime: frenteMime || 'image/jpeg', vista: 'frente' });
          if (espaldaBase64) fotosCorte.push({ base64: espaldaBase64, mime: espaldaMime || 'image/jpeg', vista: 'espalda' });
        }
        if (fotosCorte.length === 0) {
          return json(res, 400, { error: 'falta al menos 1 foto (fotoBase64 o fotos[] o frenteBase64/espaldaBase64)' });
        }

        // 1) Recolectar candidatos: pedidos en estados relevantes con foto disponible
        const ESTADOS_CANDIDATOS = ['aprobado', 'enviado-calandra', 'calandra', 'llego-impresion', 'corte', 'tela-recibida'];
        const peds = leerPedidos()
          .filter(p => ESTADOS_CANDIDATOS.includes(p.estado))
          .sort((a, b) => {
            const ta = new Date(a.ultimoMovimiento || a.fechaCreacion || 0).getTime();
            const tb = new Date(b.ultimoMovimiento || b.fechaCreacion || 0).getTime();
            return tb - ta;
          });

        const candidatos = [];
        for (const p of peds) {
          if (candidatos.length >= 4) break; // max 4 para Gemini
          // Prioridad: 1) foto manual cacheada, 2) thumbnail PDF RIP, 3) skip
          const fotoCache = db.getFotoPedido(p.id);
          let imgBase64 = null, imgMime = null, fuente = null;

          if (fotoCache?.url && fotoCache.url.startsWith('data:')) {
            // Data URL base64
            const m = fotoCache.url.match(/^data:([^;]+);base64,(.+)$/);
            if (m) { imgMime = m[1]; imgBase64 = m[2]; fuente = 'cache-manual'; }
          } else if (p.drive?.pdfRip?.fileId) {
            // Descargar thumbnail desde Drive
            try {
              const th = await driveSync.descargarThumbnailBase64(p.drive.pdfRip.fileId, 800);
              if (th?.base64) { imgBase64 = th.base64; imgMime = th.mime || 'image/jpeg'; fuente = 'drive-pdf-rip'; }
            } catch {}
          }
          if (!imgBase64) continue;

          candidatos.push({
            pedido_id: p.id,
            equipo: p.equipo || `Pedido #${p.id}`,
            vendedora: p.vendedora || '',
            estado: p.estado,
            base64: imgBase64,
            mime: imgMime,
            fuente,
          });
        }

        // 2) Llamar a Gemini
        const resultado = await matchFotosCorteConPedidos(fotosCorte, candidatos);

        // 3) Devolver
        return json(res, 200, {
          ok: true,
          totalCandidatosEvaluables: candidatos.length,
          totalPedidosEnEstados: peds.length,
          ...resultado,
        });
      } catch (e) {
        console.error('[match-foto error]', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // POST /api/costura/registrar-envio — registra envio a costura (con o sin pedido del ERP)
  // Body: {
  //   pedido_id: <id si matcheo con ERP, null si es fantasma>,
  //   costurera_slug, prendas: [{tipo,cantidad}],
  //   frenteBase64, frenteMime, espaldaBase64, espaldaMime,
  //   equipo: <nombre si es fantasma>,
  // }
  // Si pedido_id es null → crea pedido fantasma con flag sin_erp=true
  // Si pedido_id existe → usa flujo normal
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/api/costura/registrar-envio') {
    let body = '';
    req.on('data', d => {
      body += d;
      if (body.length > 20 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { costurera_slug, prendas, frenteBase64, frenteMime, espaldaBase64, espaldaMime, fotoBase64, fotoMime, fotos } = data;
        if (!costurera_slug) return json(res, 400, { error: 'falta costurera_slug' });
        if (!prendas || !Array.isArray(prendas) || prendas.length === 0) {
          return json(res, 400, { error: 'faltan prendas' });
        }
        // Foto OPCIONAL desde 29-jun-2026. Camilo: "el enfoque ya no es tomar una
        // foto sino registrar normalmente como si fuera en un cuaderno". La foto
        // queda como prueba visual opcional, no como entrada obligatoria.
        let fotoPrincipalBase64 = null, fotoPrincipalMime = null;
        if (Array.isArray(fotos) && fotos.length > 0 && fotos[0]?.base64) {
          fotoPrincipalBase64 = fotos[0].base64;
          fotoPrincipalMime = fotos[0].mime || 'image/jpeg';
        } else if (fotoBase64) {
          fotoPrincipalBase64 = fotoBase64;
          fotoPrincipalMime = fotoMime || 'image/jpeg';
        } else if (frenteBase64) {
          fotoPrincipalBase64 = frenteBase64;
          fotoPrincipalMime = frenteMime || 'image/jpeg';
        }
        // SIN foto tambien se acepta — solo se omite el setFotoPedido
        const costu = PERSONAS.find(x => x.slug === costurera_slug && x.roles.includes('costura'));
        if (!costu) return json(res, 400, { error: 'costurera no encontrada' });

        let pedido_id = data.pedido_id || null;
        let pedido = null;

        // Caso A: ya hay match con ERP → usar pedido existente
        if (pedido_id) {
          const todos = leerPedidos();
          const idx = todos.findIndex(x => x.id === pedido_id);
          if (idx < 0) return json(res, 404, { error: 'pedido del ERP no existe' });
          pedido = todos[idx];
          pedido.estado = 'costura';
          pedido.ultimoMovimiento = new Date().toISOString();
          pedido.historial = pedido.historial || [];
          pedido.historial.push({
            fecha: new Date().toISOString(),
            por: 'app-costura',
            accion: 'enviar-costura-match-foto',
            nota: `Match por foto → ${costu.nombre}`,
          });
          todos[idx] = pedido;
          db.guardarPedidos(todos);
        } else {
          // Caso B: pedido fantasma — crear nuevo en ERP con flag sin_erp
          const nuevoId = db.leerNextId();
          pedido = {
            id: nuevoId,
            tipo: 'pedido',
            equipo: data.equipo || `Sin nombre #${nuevoId}`,
            vendedora: data.vendedora || '',
            estado: 'costura',
            sin_erp: true, // FLAG IMPORTANTE: pedido creado desde /costura sin sticker
            origen: 'foto-costura',
            fechaVenta: new Date().toISOString(),
            ultimoMovimiento: new Date().toISOString(),
            numUniformes: prendas.reduce((s, p) => s + (parseInt(p.cantidad, 10) || 0), 0),
            historial: [{
              fecha: new Date().toISOString(),
              por: 'app-costura',
              accion: 'crear-fantasma',
              nota: `Pedido fantasma creado desde /costura (sin match en ERP)`,
            }],
          };
          db.upsertPedido(pedido);
          pedido_id = nuevoId;
        }

        // Guardar foto principal del lote como referencia (si la mandaron)
        if (fotoPrincipalBase64) {
          const fotoUrl = `data:${fotoPrincipalMime};base64,${fotoPrincipalBase64}`;
          try { db.setFotoPedido(pedido_id, fotoUrl, 'lote-costura'); } catch (e) { console.error('[setFotoPedido]', e); }
        }

        // Crear movimientos de costura (uno por tipo de prenda)
        const movimientos = [];
        for (const pr of prendas) {
          const cant = parseInt(pr.cantidad, 10) || 0;
          if (cant <= 0) continue;
          const movId = db.crearMovimientoCostura({
            pedido_id,
            costurera_slug,
            costurera_nombre: costu.nombre,
            equipo: pedido.equipo,
            prenda: pr.tipo,
            cantidad_enviada: cant,
            observaciones: pedido.sin_erp ? 'sin ERP (creado desde foto)' : 'match foto',
            enviado_por: 'app-costura',
          });
          movimientos.push({ id: movId, prenda: pr.tipo, cantidad: cant });
        }

        return json(res, 200, {
          ok: true,
          pedido_id,
          equipo: pedido.equipo,
          sin_erp: !!pedido.sin_erp,
          movimientos,
        });
      } catch (e) {
        console.error('[registrar-envio error]', e);
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/costura/pedido/:id/foto — subir foto manual del pedido ──
  // Body: { url } (URL ya subida en otro lado, o data URL base64)
  if (req.method === 'POST' && req.url.match(/^\/api\/costura\/pedido\/\d+\/foto$/)) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const id = parseInt(req.url.split('/')[4], 10);
        const data = JSON.parse(body || '{}');
        if (!data.url) return json(res, 400, { error: 'falta url' });
        db.setFotoPedido(id, data.url, data.fuente || 'manual');
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // /api/asistente/* — endpoints REST para el asistente personal de Camilo
  // (OpenClaw self-hosted, conectado al WA dedicado 573214503950)
  //
  // Auth: header X-API-KEY = API_KEY del proceso (env API_KEY)
  // Estilo: respuestas cortas y ejecutivas (el bot las usa para responder al WA)
  // ═══════════════════════════════════════════════════════════════════
  function authAsistente(req, res) {
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  // ── GET /api/asistente/consignaciones-huerfanas
  // Lista comprobantes detectados que NO tienen pedido en ERP (esperan que vendedora
  // o Camilo digan a que equipo van). TTL 48h.
  if (req.method === 'GET' && req.url === '/api/asistente/consignaciones-huerfanas') {
    if (!authAsistente(req, res)) return;
    try {
      const pagos = _leerPrimerPagos()
        .filter(p => p.estado === 'esperando-equipo')
        .filter(p => (Date.now() - new Date(p.creadoEn).getTime()) < 48 * 60 * 60 * 1000)
        .sort((a, b) => new Date(b.creadoEn).getTime() - new Date(a.creadoEn).getTime());

      return json(res, 200, {
        ok: true,
        total: pagos.length,
        consignaciones: pagos.map(p => ({
          id: p.id,
          monto: p.monto,
          banco: p.banco,
          vendedora: p.vendedora,
          cliente_telefono: p.telefono,
          cliente_nombre: p.nombreCliente,
          fecha: p.fecha,
          horas_pendiente: Math.round((Date.now() - new Date(p.creadoEn).getTime()) / 36e5),
        })),
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/asistente/consignaciones/:id/crear-pedido
  // Body: { nombre_equipo }
  // Crea el pedido a partir del primer-pago huerfano. Suma el monto al abonado.
  if (req.method === 'POST' && req.url.match(/^\/api\/asistente\/consignaciones\/[^/]+\/crear-pedido$/)) {
    if (!authAsistente(req, res)) return;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const id = req.url.split('/')[4];
        const { nombre_equipo } = JSON.parse(body || '{}');
        if (!nombre_equipo || !nombre_equipo.trim()) {
          return json(res, 400, { error: 'falta nombre_equipo' });
        }
        const pagos = _leerPrimerPagos();
        const pendiente = pagos.find(p => p.id === id);
        if (!pendiente) return json(res, 404, { error: 'consignacion no existe o ya atendida' });
        if (pendiente.estado !== 'esperando-equipo') {
          return json(res, 409, { error: `estado actual: ${pendiente.estado}` });
        }
        const pedidoNuevo = crearPedidoDesdePrimerPago(pendiente, nombre_equipo.trim());
        if (!pedidoNuevo) return json(res, 500, { error: 'no se pudo crear pedido' });

        return json(res, 200, {
          ok: true,
          pedido_id: pedidoNuevo.id,
          equipo: pedidoNuevo.equipo,
          vendedora: pedidoNuevo.vendedora,
          abonado: pedidoNuevo.abonado,
          mensaje: `Pedido #${pedidoNuevo.id} ${pedidoNuevo.equipo} creado. Abonado: $${pedidoNuevo.abonado}.`,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/asistente/consignaciones/:id/ignorar
  // Marca una consignacion como descartada (no era de uniforme).
  if (req.method === 'POST' && req.url.match(/^\/api\/asistente\/consignaciones\/[^/]+\/ignorar$/)) {
    if (!authAsistente(req, res)) return;
    try {
      const id = req.url.split('/')[4];
      const pagos = _leerPrimerPagos();
      const idx = pagos.findIndex(p => p.id === id);
      if (idx < 0) return json(res, 404, { error: 'consignacion no existe' });
      pagos[idx].estado = 'ignorado';
      pagos[idx].ignoradoEn = new Date().toISOString();
      _guardarPrimerPagos(pagos);
      return json(res, 200, { ok: true, mensaje: 'consignacion descartada' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/asistente/pedido/buscar?q=texto
  // Busca pedidos por nombre de equipo, telefono o cliente. Devuelve maximo 5.
  if (req.method === 'GET' && req.url.startsWith('/api/asistente/pedido/buscar')) {
    if (!authAsistente(req, res)) return;
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      if (!q || q.length < 2) return json(res, 400, { error: 'q debe tener al menos 2 caracteres' });
      const tokens = q.split(/\s+/).filter(Boolean);
      const peds = leerPedidos();
      const matches = peds
        .map(p => {
          const haystack = [p.equipo, p.telefono, p.pushNameCliente, p.nombreCliente, p.vendedora]
            .filter(Boolean).join(' ').toLowerCase();
          let score = 0;
          for (const t of tokens) {
            if (haystack.includes(t)) score++;
          }
          return { p, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(x => ({
          id: x.p.id,
          equipo: x.p.equipo,
          vendedora: x.p.vendedora,
          estado: x.p.estado,
          telefono: x.p.telefono,
          fechaVenta: x.p.fechaVenta,
          numUniformes: x.p.numUniformes || null,
          total: x.p.total || null,
          abonado: x.p.abonado || 0,
        }));
      return json(res, 200, { ok: true, total: matches.length, pedidos: matches });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/asistente/pedido/:id/resumen
  // Resumen ejecutivo de un pedido para responder al WA.
  if (req.method === 'GET' && req.url.match(/^\/api\/asistente\/pedido\/\d+\/resumen$/)) {
    if (!authAsistente(req, res)) return;
    try {
      const id = parseInt(req.url.split('/')[4], 10);
      const p = leerPedidos().find(x => x.id === id);
      if (!p) return json(res, 404, { error: 'pedido no existe' });

      const ahora = Date.now();
      const ultimoMov = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : null;
      const diasSinMov = ultimoMov ? Math.floor((ahora - ultimoMov) / 86400000) : null;
      const ultimas3 = (p.historial || []).slice(-3).map(h => ({
        fecha: h.fecha, accion: h.accion, nota: h.nota, por: h.por,
      }));

      return json(res, 200, {
        ok: true,
        pedido: {
          id: p.id,
          equipo: p.equipo,
          vendedora: p.vendedora,
          estado: p.estado,
          satelite: p.satelite || null,
          numUniformes: p.numUniformes || null,
          total: p.total || null,
          abonado: p.abonado || 0,
          saldo: (p.total || 0) - (p.abonado || 0),
          fechaVenta: p.fechaVenta,
          fechaEntrega: p.fechaEntrega || null,
          ultimoMovimiento: p.ultimoMovimiento,
          diasSinMovimiento: diasSinMov,
          ultimas3Acciones: ultimas3,
          sinErp: !!p.sin_erp,
        },
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/asistente/pedidos-atascados
  // Pedidos sin movimiento por mas de N dias (default 5). Para detectar problemas.
  if (req.method === 'GET' && req.url.startsWith('/api/asistente/pedidos-atascados')) {
    if (!authAsistente(req, res)) return;
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const diasMin = parseInt(u.searchParams.get('dias') || '5', 10);
      const ahora = Date.now();
      const peds = leerPedidos();
      const atascados = peds
        .filter(p => !['enviado-final', 'entregado', 'archivado', 'cancelado'].includes(p.estado))
        .map(p => {
          const ultimoMov = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : null;
          const dias = ultimoMov ? Math.floor((ahora - ultimoMov) / 86400000) : null;
          return { p, dias };
        })
        .filter(x => x.dias !== null && x.dias >= diasMin)
        .sort((a, b) => b.dias - a.dias)
        .slice(0, 30)
        .map(x => ({
          id: x.p.id,
          equipo: x.p.equipo,
          vendedora: x.p.vendedora,
          estado: x.p.estado,
          dias_sin_movimiento: x.dias,
        }));
      return json(res, 200, { ok: true, total: atascados.length, dias_minimo: diasMin, pedidos: atascados });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/asistente/costura/atascados?dias=7
  // Pedidos enviados a costura hace >= N dias sin devolucion.
  if (req.method === 'GET' && req.url.startsWith('/api/asistente/costura/atascados')) {
    if (!authAsistente(req, res)) return;
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const diasMin = parseInt(u.searchParams.get('dias') || '7', 10);
      const ahora = Date.now();
      const movs = db.leerMovimientosCosturaPendientes() || [];
      const atascados = movs
        .map(m => {
          const fe = m.fecha_envio ? new Date(m.fecha_envio).getTime() : null;
          const dias = fe ? Math.floor((ahora - fe) / 86400000) : null;
          return { m, dias };
        })
        .filter(x => x.dias !== null && x.dias >= diasMin)
        .sort((a, b) => b.dias - a.dias)
        .slice(0, 30)
        .map(x => ({
          pedido_id: x.m.pedido_id,
          equipo: x.m.equipo,
          costurera_slug: x.m.costurera_slug,
          costurera_nombre: x.m.costurera_nombre,
          prenda: x.m.prenda,
          cantidad: x.m.cantidad_enviada,
          dias_en_costura: x.dias,
          fecha_envio: x.m.fecha_envio,
        }));
      return json(res, 200, { ok: true, total: atascados.length, dias_minimo: diasMin, movimientos: atascados });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/asistente/costura/dashboard
  // Resumen ejecutivo para responder "como van las costureras".
  if (req.method === 'GET' && req.url === '/api/asistente/costura/dashboard') {
    if (!authAsistente(req, res)) return;
    try {
      const movsAbiertos = db.leerMovimientosCosturaPendientes() || [];
      const costureraSlugs = PERSONAS.filter(p => p.roles.includes('costura'));
      const resumen = costureraSlugs.map(p => {
        const pedidosAbiertos = new Set(
          movsAbiertos.filter(m => m.costurera_slug === p.slug).map(m => m.pedido_id)
        );
        return {
          slug: p.slug,
          nombre: p.nombre,
          pedidos_activos: pedidosAbiertos.size,
        };
      });
      return json(res, 200, {
        ok: true,
        total_costureras: resumen.length,
        total_pedidos_activos: new Set(movsAbiertos.map(m => m.pedido_id)).size,
        por_costurera: resumen,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/asistente/alertas-pendientes
  // Endpoint que JARVIS pollea cada 30 min para detectar cosas urgentes.
  // Devuelve SOLO alertas NO notificadas todavia (TTL 7 dias).
  // Categorias: consignaciones huerfanas, costura atascada, pedidos parados,
  // diseños sin asignar.
  // ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/asistente/alertas-pendientes') {
    if (!authAsistente(req, res)) return;
    try {
      const qs = new URLSearchParams((req.url.split('?')[1] || ''));
      const autoMarcar = qs.get('auto_marcar') === '1';
      return json(res, 200, _computarAlertas(autoMarcar));
    } catch (e) {
      console.error('[alertas-pendientes]', e);
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/asistente/alertas/marcar-vistas
  // Body: { ids: ["consignacion:pp_xxx", "costura:...", ...] }
  // JARVIS llama esto DESPUES de avisar a Camilo para no repetir.
  if (req.method === 'POST' && req.url === '/api/asistente/alertas/marcar-vistas') {
    if (!authAsistente(req, res)) return;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const ids = Array.isArray(data.ids) ? data.ids : [];
        if (ids.length === 0) return json(res, 400, { error: 'falta ids (array)' });
        const marcadas = marcarAlertasNotificadas(ids);
        return json(res, 200, { ok: true, marcadas, total_recibidas: ids.length });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/costureras/envio — Lidermeyer registra envio a una costurera ──
  // Body: { pedido_id, costurera_slug, prenda, cantidad, observaciones, enviado_por }
  if (req.method === 'POST' && req.url === '/api/costureras/envio') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { pedido_id, costurera_slug, prenda, cantidad, observaciones, enviado_por } = data;
        if (!costurera_slug || !cantidad) return json(res, 400, { error: 'falta costurera_slug o cantidad' });
        const costu = PERSONAS.find(p => p.slug === costurera_slug && p.roles.includes('costura'));
        if (!costu) return json(res, 400, { error: 'costurera no encontrada' });

        // Buscar pedido para tomar equipo (si existe)
        let equipo = data.equipo || '';
        if (pedido_id) {
          const p = leerPedidos().find(x => x.id === pedido_id);
          if (p) {
            equipo = equipo || p.equipo || p.telefono || '';
            // Avanzar pedido a 'en-satelite' y asignar costurera
            p.estado = 'en-satelite';
            p.satelite = costu.nombre;
            p.ultimoMovimiento = new Date().toISOString();
            p.historial = p.historial || [];
            p.historial.push({
              fecha: new Date().toISOString(),
              por: enviado_por || 'app',
              accion: 'enviar-costura',
              nota: `Enviado a ${costu.nombre}: ${cantidad} ${prenda || 'prendas'}`,
            });
            const todos = leerPedidos();
            const idx = todos.findIndex(x => x.id === pedido_id);
            if (idx >= 0) { todos[idx] = p; db.guardarPedidos(todos); }
          }
        }

        const id = db.crearMovimientoCostura({
          pedido_id: pedido_id || null,
          costurera_slug,
          costurera_nombre: costu.nombre,
          equipo,
          prenda: prenda || null,
          cantidad_enviada: parseInt(cantidad, 10),
          enviado_por: enviado_por || null,
          observaciones: observaciones || null,
        });

        // NO se notifica a la costurera (regla 20-jun-2026 Camilo):
        // costureras no usan app ni reciben mensajes del bot. Todo el flujo
        // es fisico (entrega/devolucion) + registro interno por Camilo.

        return json(res, 200, { ok: true, id });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/costureras/recepcion — Lidermeyer marca recepcion del lote ──
  // Body: { movimiento_id, cantidad_recibida, faltante, observaciones, recibido_por }
  if (req.method === 'POST' && req.url === '/api/costureras/recepcion') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { movimiento_id, cantidad_recibida, faltante, observaciones, recibido_por } = data;
        if (!movimiento_id || cantidad_recibida == null) {
          return json(res, 400, { error: 'falta movimiento_id o cantidad_recibida' });
        }
        const mov = db.leerMovimientoCostura(movimiento_id);
        if (!mov) return json(res, 404, { error: 'movimiento no encontrado' });

        const faltanteNum = parseInt(faltante || 0, 10);
        const recibidaNum = parseInt(cantidad_recibida, 10);
        db.recibirMovimientoCostura(movimiento_id, {
          cantidad_recibida: recibidaNum,
          faltante: faltanteNum,
          recibido_por: recibido_por || null,
          observaciones: observaciones || null,
        });

        // Buscar pedido para datos
        let pedido = null;
        if (mov.pedido_id) {
          const todos = leerPedidos();
          const idx = todos.findIndex(x => x.id === mov.pedido_id);
          if (idx >= 0) {
            pedido = todos[idx];
            pedido.estado = 'calidad';
            pedido.ultimoMovimiento = new Date().toISOString();
            pedido.historial = pedido.historial || [];
            pedido.historial.push({
              fecha: new Date().toISOString(),
              por: recibido_por || 'app',
              accion: 'recibir-costura',
              nota: `Recibido de ${mov.costurera_nombre}: ${recibidaNum}/${mov.cantidad_enviada}` +
                    (faltanteNum > 0 ? ` (FALTAN ${faltanteNum})` : ''),
            });
            db.guardarPedidos(todos);
          }
        }

        // ─── HUECO #2: Si hay faltantes, crear arreglo automático ───
        let arregloId = null;
        if (faltanteNum > 0) {
          try {
            const actuales = db.leerArreglos();
            const nuevoArreglo = {
              id: Date.now(),
              equipo: (pedido && (pedido.equipo || pedido.cliente)) || mov.equipo || ('Pedido #' + (mov.pedido_id || '')),
              faltante: `Faltan ${faltanteNum} prenda${faltanteNum !== 1 ? 's' : ''} del lote de ${mov.costurera_nombre} (envió ${recibidaNum}/${mov.cantidad_enviada} - ${mov.prenda || 'mix'})`,
              disenador: (pedido && pedido.disenadorAsignado) || 'Sin asignar',
              pedidoId: mov.pedido_id || null,
              enviado: false,
              resuelto: false,
              fecha: new Date().toLocaleDateString('es-CO'),
              origen: 'faltante-costura',
              origenMovimiento: movimiento_id,
            };
            actuales.unshift(nuevoArreglo);
            db.guardarArreglos(actuales);
            arregloId = nuevoArreglo.id;
            // Notif al disenador
            if (nuevoArreglo.disenador && nuevoArreglo.disenador !== 'Sin asignar') {
              const msgWA = `⚠️ *Arreglo auto-creado por faltante de costura*\n\n` +
                `👕 Equipo: ${nuevoArreglo.equipo}\n` +
                `🧵 Costurera: ${mov.costurera_nombre}\n` +
                `📝 Falta: ${nuevoArreglo.faltante}\n\n` +
                `Por favor reponé las ${faltanteNum} prenda${faltanteNum !== 1 ? 's' : ''} faltante${faltanteNum !== 1 ? 's' : ''}.`;
              notificarWAPersona(nuevoArreglo.disenador, msgWA).catch(()=>{});
            }
            // Telegram a Duvan (fire-and-forget, no await porque este callback no es async)
            notificarTelegramAdmin(`⚠️ *Arreglo auto-creado* — faltantes en costura\n\n` +
              `Equipo: ${nuevoArreglo.equipo}\nCostura: ${mov.costurera_nombre}\nFaltan: ${faltanteNum}\nAsignado a: ${nuevoArreglo.disenador}`).catch(()=>{});
          } catch (eArr) { console.error('[faltante-arreglo err]', eArr.message); }
        }

        return json(res, 200, { ok: true, faltante: faltanteNum, arregloId });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/costureras/confirmar — costurera marca desde su mini-app que entrego ──
  // Body: { movimiento_id, costurera_slug }
  if (req.method === 'POST' && req.url === '/api/costureras/confirmar') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { movimiento_id, costurera_slug } = JSON.parse(body);
        if (!movimiento_id || !costurera_slug) return json(res, 400, { error: 'faltan params' });
        db.confirmarRecibidoCostura(movimiento_id, costurera_slug);
        // Avisar a Lidermeyer por WA
        const mov = db.leerMovimientoCostura(movimiento_id);
        if (mov) {
          const msg = `🧵 *${mov.costurera_nombre} marco entrega*\n\n` +
            `Lote: ${mov.equipo || '#' + mov.pedido_id}\n` +
            `Prenda: ${mov.prenda || '-'}\n` +
            `Cantidad: ${mov.cantidad_enviada}\n\n` +
            `Confirma recepcion desde tu app cuando llegue.`;
          notificarWAPersona('Lidermeyer', msg).catch(()=>{});
        }
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /api/costureras/pendientes — Lidermeyer ve lotes sin recibir ──
  if (req.method === 'GET' && req.url === '/api/costureras/pendientes') {
    try {
      const pendientes = db.leerMovimientosCosturaPendientes();
      const ahora = Date.now();
      const enriched = pendientes.map(m => {
        const ts = new Date(m.fecha_envio).getTime();
        const dias = Math.floor((ahora - ts) / 86400000);
        return { ...m, dias_en_costura: dias };
      });
      return json(res, 200, { pendientes: enriched, total: enriched.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/costureras/historial?slug=wilson&limit=50 — historial por costurera ──
  if (req.method === 'GET' && req.url.startsWith('/api/costureras/historial')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const slug = u.searchParams.get('slug');
      const limit = parseInt(u.searchParams.get('limit') || '50', 10);
      if (!slug) return json(res, 400, { error: 'falta slug' });
      const movs = db.leerMovimientosCostureraPorSlug(slug, limit);
      return json(res, 200, { movimientos: movs });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/costureras/cuadre-semanal — cuadre actual de la semana en curso ──
  if (req.method === 'GET' && req.url === '/api/costureras/cuadre-semanal') {
    try {
      const ahora = new Date();
      const desde = new Date(ahora);
      desde.setDate(desde.getDate() - 6); // ultimos 7 dias
      desde.setHours(0, 0, 0, 0);
      const movs = db.leerMovimientosCosturaSemana(desde.toISOString(), ahora.toISOString());
      const porCostu = {};
      for (const m of movs) {
        const k = m.costurera_slug;
        if (!porCostu[k]) {
          porCostu[k] = { slug: k, nombre: m.costurera_nombre, total_prendas: 0, lotes: 0, faltantes: 0, detalle: {} };
        }
        const cant = m.cantidad_recibida || 0;
        porCostu[k].total_prendas += cant;
        porCostu[k].faltantes += (m.faltante || 0);
        porCostu[k].lotes += 1;
        const prenda = m.prenda || 'sin especificar';
        porCostu[k].detalle[prenda] = (porCostu[k].detalle[prenda] || 0) + cant;
      }
      return json(res, 200, {
        desde: desde.toISOString(),
        hasta: ahora.toISOString(),
        cuadre: Object.values(porCostu),
        total_movimientos: movs.length,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }



  // ═══════════════════════════════════════════════════════════════════
  // GMAIL + WETRANSFER INTEGRATION
  // ═══════════════════════════════════════════════════════════════════

  // ── GET /api/gmail/status — ¿Gmail está conectado? ──
  if (req.method === 'GET' && req.url === '/api/gmail/status') {
    return json(res, 200, {
      conectado: gmailWT.estaConectado(),
      clientIdConfigurado: !!process.env.GOOGLE_CLIENT_ID,
      clientSecretConfigurado: !!process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://ws-app-interna-production.up.railway.app/api/gmail/callback',
    });
  }

  // ── GET /api/gmail/auth — inicia OAuth (redirect a Google) ──
  if (req.method === 'GET' && req.url === '/api/gmail/auth') {
    try {
      const url = gmailWT.getAuthUrl();
      res.writeHead(302, { Location: url });
      return res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>Error</h1><p>${e.message}</p><p>Configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Railway env vars.</p>`);
    }
  }

  // ── GET /api/gmail/callback?code=XXX — guarda refresh_token ──
  if (req.method === 'GET' && req.url.startsWith('/api/gmail/callback')) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const code = u.searchParams.get('code');
    const err  = u.searchParams.get('error');
    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>OAuth cancelado</h1><p>${err}</p>`);
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Falta code</h1>');
    }
    try {
      await gmailWT.intercambiarCodigo(code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
        <html><body style="font-family:system-ui;text-align:center;padding:40px;background:#0f1117;color:#eef5ff;">
          <h1 style="color:#34d399;">✅ Gmail conectado</h1>
          <p>El sistema ya puede leer correos de WeTransfer automáticamente.</p>
          <p><a href="/api/gmail/sync" style="color:#a78bfa;">Probar sincronización manual</a></p>
          <p><a href="/" style="color:#60a5fa;">Volver a la app</a></p>
        </body></html>
      `);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>Error</h1><pre>${e.message}</pre>`);
    }
  }

  // ── POST/GET /api/drive/sync — sincronizar archivos de Drive con pedidos ──
  if ((req.method === 'POST' || req.method === 'GET') && req.url.startsWith('/api/drive/sync')) {
    try {
      const pedidos = db.leerPedidos();
      const resultado = await driveSync.sincronizarConPedidos(pedidos);
      const aplicados = [];
      for (const u of resultado.updates) {
        const p = pedidos.find(x => x.id === u.pedidoId);
        if (!p) continue;
        p.drive = p.drive || {};
        if (u.corel) p.drive.corel = u.corel;
        if (u.pdfRip) p.drive.pdfRip = u.pdfRip;
        // Auto-asignar diseñador si no tiene y Drive lo identificó
        if (u.disenadorSugerido && !p.disenadorAsignado) {
          p.disenadorAsignado = u.disenadorSugerido;
          p.historial = p.historial || [];
          p.historial.push({
            fecha: new Date().toISOString(),
            por: 'drive-bot',
            accion: 'asignar-disenador',
            a: u.disenadorSugerido,
            nota: `Auto-asignado por owner del .cdr en Drive`,
          });
        }
        // Si el pedido está en bandeja y aparece .cdr → avanzar a hacer-diseno
        if (u.corel && p.estado === 'bandeja') {
          p.estado = 'hacer-diseno';
          p.ultimoMovimiento = new Date().toISOString();
          p.historial = p.historial || [];
          p.historial.push({
            fecha: new Date().toISOString(),
            por: 'drive-bot',
            accion: 'avanzar',
            de: 'bandeja',
            a: 'hacer-diseno',
            nota: `Auto-avanzado: archivo Corel detectado en Drive`,
          });
        }
        aplicados.push({
          id: p.id,
          equipo: p.equipo,
          corel: !!u.corel,
          pdfRip: !!u.pdfRip,
          disenador: u.disenadorSugerido || null,
        });
      }
      if (aplicados.length) db.guardarPedidos(pedidos);
      return json(res, 200, {
        ok: true,
        totales: resultado.totales,
        aplicados: aplicados.length,
        huerfanos: resultado.huerfanos.length,
        detalles: aplicados,
        huerfanosLista: resultado.huerfanos.slice(0, 20),
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FACTURAS / COTIZACIONES — nueva API profesional
  // ═══════════════════════════════════════════════════════════════════

  // ── POST /api/facturas — crear factura/cotización + opcional subir PDF a Drive ──
  // Body: { numero, tipo, cliente_nombre, cliente_telefono, cliente_nit, cliente_correo,
  //         vendedora, items, subtotal, abono, total, fecha, pedido_id, notas, pdfBase64? }
  if (req.method === 'POST' && req.url === '/api/facturas') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (!data.numero || !data.tipo) return json(res, 400, { error: 'numero y tipo son requeridos' });
        // Guardar registro
        const factura = db.crearFactura(data);
        // Si factura tiene pedido_id, sincronizar pedido.total con factura.total
        try { syncTotalDesdeFactura(factura); } catch (eSync) { console.error('[sync total]', eSync.message); }
        // Si viene PDF en base64, subir a Drive
        if (data.pdfBase64) {
          try {
            const parentId = factura.tipo === 'cotizacion'
              ? driveSync.FOLDER_COTIZACIONES
              : driveSync.FOLDER_FACTURAS;
            const tituloArchivo = `${factura.tipo === 'cotizacion' ? 'COTIZACION' : 'FACTURA'} ${factura.numero}${factura.cliente_nombre ? ' - ' + factura.cliente_nombre : ''}.pdf`;
            const subida = await driveSync.subirArchivo({
              titulo: tituloArchivo,
              mimeType: 'application/pdf',
              contentBase64: data.pdfBase64,
              parentId,
            });
            // Hacer público para que pueda enviarse por WA
            try { await driveSync.hacerArchivoPublico(subida.id); } catch (e) { console.warn('[fact] no se pudo hacer público:', e.message); }
            db.setFacturaDrive(factura.id, subida.id, subida.viewLink);
            factura.drive_file_id = subida.id;
            factura.drive_link = subida.viewLink;
            factura.drive_download = subida.downloadLink;
          } catch (e) {
            console.error('[fact upload Drive]', e.message);
            // No fallar la creación de la factura por error de Drive
            factura.driveError = e.message;
          }
        }
        return json(res, 201, { ok: true, factura });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /api/facturas?tipo=&limit=&offset= — listar ──
  if (req.method === 'GET' && req.url.startsWith('/api/facturas')) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    // /api/facturas/:id
    const m = req.url.match(/^\/api\/facturas\/(\d+)(\?|$)/);
    if (m) {
      const factura = db.leerFacturaPorId(parseInt(m[1], 10));
      if (!factura) return json(res, 404, { error: 'no encontrada' });
      return json(res, 200, { factura });
    }
    // /api/facturas/pedido/:id
    const mp = req.url.match(/^\/api\/facturas\/pedido\/(\d+)/);
    if (mp) {
      return json(res, 200, { facturas: db.leerFacturasPorPedido(parseInt(mp[1], 10)) });
    }
    // /api/facturas/cliente/:tel
    const mc = req.url.match(/^\/api\/facturas\/cliente\/(.+)/);
    if (mc) {
      return json(res, 200, { facturas: db.leerFacturasPorTelefono(decodeURIComponent(mc[1])) });
    }
    // Lista general
    const limit = parseInt(u.searchParams.get('limit') || '100', 10);
    const offset = parseInt(u.searchParams.get('offset') || '0', 10);
    const facturas = db.leerFacturas(limit, offset);
    // Stats
    const hoy = new Date().toISOString().slice(0, 10);
    const inicioMes = hoy.slice(0, 7) + '-01';
    const inicioAnio = hoy.slice(0, 4) + '-01-01';
    return json(res, 200, {
      facturas,
      stats: {
        mes: db.sumarFacturasPeriodo(inicioMes, hoy),
        anio: db.sumarFacturasPeriodo(inicioAnio, hoy),
        totalFacturas: db.contarFacturasPorTipo('factura'),
        totalCotizaciones: db.contarFacturasPorTipo('cotizacion'),
      },
    });
  }

  // ── POST /api/facturas/:id/enviar-wa — enviar PDF al cliente por WA ──
  if (req.method === 'POST' && /^\/api\/facturas\/\d+\/enviar-wa/.test(req.url)) {
    const id = parseInt(req.url.match(/^\/api\/facturas\/(\d+)/)[1], 10);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const factura = db.leerFacturaPorId(id);
        if (!factura) return json(res, 404, { error: 'no encontrada' });
        if (!factura.drive_file_id) return json(res, 400, { error: 'la factura no tiene PDF en Drive' });
        const opts = body ? JSON.parse(body) : {};
        const telefono = opts.telefono || factura.cliente_telefono;
        if (!telefono) return json(res, 400, { error: 'falta teléfono del cliente' });
        const mediaUrl = `https://drive.google.com/uc?export=download&id=${factura.drive_file_id}`;
        const fileName = `${factura.tipo === 'cotizacion' ? 'COTIZACION' : 'FACTURA'} ${factura.numero}.pdf`;
        const esCot = factura.tipo === 'cotizacion';
        const titulo = esCot ? 'cotización' : 'factura';
        const caption = opts.caption ||
          `Hola${factura.cliente_nombre ? ' ' + factura.cliente_nombre : ''}, te envío tu ${titulo} de W&S Uniformes Deportivos.\n` +
          `Total: $${(factura.total || 0).toLocaleString('es-CO')}\n` +
          (esCot ? '\nSi te interesa, con gusto avanzamos con el pedido. Gracias 🙏' : '\nGracias por tu compra 🙏');
        const instance = opts.instance || instanciaParaVendedora(factura.vendedora);
        await enviarWADocumento({ telefono, mediaUrl, fileName, caption, instance });
        db.setFacturaWaEnviada(id, telefono);
        return json(res, 200, { ok: true, telefono, instance });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── GET /api/clientes — listar / buscar ──
  if (req.method === 'GET' && req.url.startsWith('/api/clientes')) {
    const u = new URL(req.url, `http://${req.headers.host}`);
    // /api/clientes/:tel
    const m = req.url.match(/^\/api\/clientes\/([^?]+)/);
    if (m && !req.url.startsWith('/api/clientes?')) {
      const tel = decodeURIComponent(m[1]);
      const cliente = db.leerClientePorTel(tel);
      if (!cliente) return json(res, 404, { error: 'no encontrado' });
      const facturas = db.leerFacturasPorTelefono(tel);
      return json(res, 200, { cliente, facturas });
    }
    const q = u.searchParams.get('q');
    if (q) return json(res, 200, { clientes: db.buscarClientes(q) });
    const limit = parseInt(u.searchParams.get('limit') || '100', 10);
    const offset = parseInt(u.searchParams.get('offset') || '0', 10);
    return json(res, 200, { clientes: db.leerClientes(limit, offset) });
  }

  // ── GET /api/calandra/dashboard — KPIs + huérfanos + envíos recientes ──
  if (req.method === 'GET' && req.url === '/api/calandra/dashboard') {
    try {
      const pedidos = db.leerPedidos();
      // Stats: sumar m² de archivos enviados a calandra
      const ahora = new Date();
      const hoyStr = ahora.toISOString().slice(0, 10);
      const inicioSemana = new Date(ahora);
      inicioSemana.setDate(ahora.getDate() - ahora.getDay());
      const inicioSemanaStr = inicioSemana.toISOString().slice(0, 10);
      const inicioMesStr = hoyStr.slice(0, 7) + '-01';
      const inicioAnioStr = hoyStr.slice(0, 4) + '-01-01';

      let m2Hoy = 0, m2Semana = 0, m2Mes = 0, m2Anio = 0;
      let envHoy = 0, envSemana = 0, envMes = 0, envAnio = 0;
      const enviadosRecientes = [];
      // 1) Envios vinculados a pedidos
      for (const p of pedidos) {
        if (!p.wetransfer || !p.wetransfer.archivos) continue;
        for (const a of p.wetransfer.archivos) {
          if (!a.fechaEnvio) continue;
          const fStr = a.fechaEnvio.slice(0, 10);
          const m2 = a.m2 || 0;
          if (fStr >= inicioAnioStr) { m2Anio += m2; envAnio++; }
          if (fStr >= inicioMesStr)   { m2Mes += m2;  envMes++; }
          if (fStr >= inicioSemanaStr){ m2Semana += m2; envSemana++; }
          if (fStr === hoyStr)        { m2Hoy += m2; envHoy++; }
          enviadosRecientes.push({
            pedidoId: p.id,
            equipo: p.equipo,
            vendedora: p.vendedora,
            estado: p.estado,
            archivo: a.nombreOriginal,
            m2: a.m2,
            tela: a.tela,
            tipo: a.tipo,
            prioridad: a.prioridad,
            fechaEnvio: a.fechaEnvio,
            fechaDescarga: a.fechaDescarga,
            linkWT: a.linkWT,
            destinatario: a.destinatario,
          });
        }
      }
      // Huerfanos: los archivos detectados por gmail-wt sin pedido vinculado.
      // Igual los mostramos como envios y sumamos sus m2 (cliente solo quiere ver
      // todo lo que llega de calandra, sin el ID del pedido).
      const huerfanosRaw = gmailWT.leerHuerfanos ? gmailWT.leerHuerfanos() : [];
      for (const h of huerfanosRaw) {
        const arch = h.archivo || {};
        const fStr = (h.fecha || '').slice(0, 10);
        if (!fStr) continue;
        const m2 = arch.m2 || 0;
        if (h.accion === 'enviado') {
          if (fStr >= inicioAnioStr) { m2Anio += m2; envAnio++; }
          if (fStr >= inicioMesStr)   { m2Mes += m2;  envMes++; }
          if (fStr >= inicioSemanaStr){ m2Semana += m2; envSemana++; }
          if (fStr === hoyStr)        { m2Hoy += m2; envHoy++; }
        }
        enviadosRecientes.push({
          pedidoId: null,
          equipo: arch.base || arch.nombreOriginal || '(sin nombre)',
          vendedora: null,
          estado: 'sin-vincular',
          archivo: arch.nombreOriginal,
          m2: arch.m2,
          tela: arch.tela,
          tipo: arch.tipo,
          prioridad: arch.prioridad,
          fechaEnvio: h.accion === 'enviado' ? h.fecha : null,
          fechaDescarga: h.accion === 'descargado' ? h.fecha : null,
          linkWT: h.linkWT,
          destinatario: h.destinatario,
        });
      }
      // Ordenar recientes por fecha desc (usar fechaEnvio o fechaDescarga)
      enviadosRecientes.sort((a, b) => {
        const fa = a.fechaEnvio || a.fechaDescarga || '';
        const fb = b.fechaEnvio || b.fechaDescarga || '';
        return fb.localeCompare(fa);
      });

      // Mantener huerfanos para compat (UI los oculta)
      const huerfanos = huerfanosRaw;

      return json(res, 200, {
        stats: {
          hoy:    { m2: m2Hoy,    pedidos: envHoy,    envios: envHoy },
          semana: { m2: m2Semana, pedidos: envSemana, envios: envSemana },
          mes:    { m2: m2Mes,    pedidos: envMes,    envios: envMes },
          anio:   { m2: m2Anio,   pedidos: envAnio,   envios: envAnio },
        },
        enviadosRecientes: enviadosRecientes.slice(0, 100),
        huerfanos,
        totalEnvios: enviadosRecientes.length,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/onboarding/enviar-uno — enviar WA de onboarding a UNA persona ──
  // Body: { slug }  o  { slug, mensaje? }
  if (req.method === 'POST' && req.url === '/api/onboarding/enviar-uno') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { slug, mensaje } = JSON.parse(body);
        const persona = getPersona(slug);
        if (!persona) return json(res, 404, { error: 'persona no encontrada' });
        const link = `https://ws-app-interna-production.up.railway.app/app/${persona.slug}`;
        const rolesTxt = (persona.roles || []).join(', ');
        const txt = mensaje || _buildOnboardingMsg(persona, link, rolesTxt);
        const sent = await notificarWAPersona(persona.slug, txt);
        return json(res, 200, { ok: true, sent, persona: persona.slug, link });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ── POST /api/onboarding/enviar-todos — disparar a TODAS las personas con teléfono ──
  // Solo manda a las que tienen número configurado.
  if (req.method === 'POST' && req.url === '/api/onboarding/enviar-todos') {
    (async () => {
      try {
        const enviados = [];
        const sinNumero = [];
        for (const persona of PERSONAS) {
          const link = `https://ws-app-interna-production.up.railway.app/app/${persona.slug}`;
          const rolesTxt = (persona.roles || []).join(', ');
          const txt = _buildOnboardingMsg(persona, link, rolesTxt);
          const sent = await notificarWAPersona(persona.slug, txt);
          if (sent) enviados.push(persona.slug);
          else sinNumero.push(persona.slug);
        }
        return json(res, 200, { ok: true, enviados, sinNumero });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/backup/forzar — admin dispara backup manual ──
  if (req.method === 'POST' && req.url === '/api/backup/forzar') {
    (async () => {
      try {
        // Limpiar marca para forzar
        try { if (fs.existsSync(BACKUP_FILE)) fs.unlinkSync(BACKUP_FILE); } catch {}
        // Truco: hacer "como si fuera la 2 AM" llamando directo
        if (!gmailWT.estaConectado()) return json(res, 400, { error: 'Gmail/Drive no conectado' });
        const dbFile = path.join(__dirname, 'data', 'ws-textil.db');
        if (!fs.existsSync(dbFile)) return json(res, 404, { error: 'BD no encontrada' });
        const buffer = fs.readFileSync(dbFile);
        const contentBase64 = buffer.toString('base64');
        const hoyStr = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }).replace(/\//g, '-');
        const titulo = `ws-textil-backup-${hoyStr}-manual.db`;
        const subida = await driveSync.subirArchivo({
          titulo,
          mimeType: 'application/x-sqlite3',
          contentBase64,
          parentId: driveSync.FOLDER_FACTURAS,
        });
        _marcarBackupHoy({ driveId: subida.id, link: subida.viewLink, size: buffer.length, manual: true });
        return json(res, 200, { ok: true, titulo, size: buffer.length, link: subida.viewLink });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    })();
    return;
  }

  // ── POST /api/calandra/vincular-huerfano — vincular manualmente ──
  if (req.method === 'POST' && req.url === '/api/calandra/vincular-huerfano') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { msgId, pedidoId } = JSON.parse(body);
        if (!msgId || !pedidoId) return json(res, 400, { error: 'msgId y pedidoId son requeridos' });
        const pedidos = db.leerPedidos();
        const result = gmailWT.vincularHuerfano(msgId, pedidoId, pedidos);
        result.pedido.wetransfer = result.wetransfer;
        result.pedido.ultimoMovimiento = new Date().toISOString();
        result.pedido.historial = result.pedido.historial || [];
        result.pedido.historial.push({
          fecha: new Date().toISOString(),
          por: 'manual',
          accion: 'vincular-wt',
          nota: `Huérfano vinculado manualmente: ${msgId}`,
        });
        db.guardarPedidos(pedidos);
        return json(res, 200, { ok: true, pedidoId: result.pedido.id });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ── POST/GET /api/gmail/sync — disparar sincronización manual ──
  if ((req.method === 'POST' || req.method === 'GET') && req.url.startsWith('/api/gmail/sync')) {
    try {
      const pedidos = db.leerPedidos();
      const resultado = await gmailWT.sincronizarConPedidos(pedidos);
      // Aplicar updates a la BD
      const aplicados = [];
      for (const u of resultado.updates) {
        const p = pedidos.find(x => x.id === u.pedidoId);
        if (!p) continue;
        p.wetransfer = u.wetransfer;
        // Si el archivo es original y el pedido está en hacer-diseno/confirmado, avanzar a enviado-calandra
        if (u.accion === 'enviado' && u.archivo.tipo === 'original' &&
            ['hacer-diseno', 'confirmado'].includes(p.estado)) {
          p.estado = 'enviado-calandra';
          p.ultimoMovimiento = new Date().toISOString();
          p.historial = p.historial || [];
          p.historial.push({
            fecha: new Date().toISOString(),
            por: 'gmail-bot',
            accion: 'avanzar',
            de: 'hacer-diseno',
            a: 'enviado-calandra',
            nota: `Auto-detectado por WeTransfer: ${u.archivo.nombreOriginal}`,
          });
        }
        aplicados.push({ id: p.id, equipo: p.equipo, accion: u.accion, archivo: u.archivo.nombreOriginal, m2: u.archivo.m2 });
      }
      if (aplicados.length) db.guardarPedidos(pedidos);
      // Notificar huérfanos por Telegram
      if (resultado.huerfanos.length) {
        const msg = '⚠️ *WeTransfer sin match*\n\n' +
          resultado.huerfanos.slice(0, 5).map(h => `• ${h.archivo.nombreOriginal} (base: "${h.archivo.base}")`).join('\n') +
          (resultado.huerfanos.length > 5 ? `\n\n... y ${resultado.huerfanos.length - 5} más` : '');
        notificarTelegramDuvan(msg).catch(()=>{});
      }
      // Notificar matches importantes
      if (aplicados.length) {
        const msgOk = `📤 *WeTransfer auto-vinculado* (${aplicados.length})\n\n` +
          aplicados.slice(0, 10).map(a => `• #${a.id} ${a.equipo} - ${a.archivo} (${a.m2}m²)`).join('\n');
        notificarTelegramDuvan(msgOk).catch(()=>{});
      }
      return json(res, 200, {
        ok: true,
        total: resultado.total,
        aplicados: aplicados.length,
        huerfanos: resultado.huerfanos.length,
        detalles: aplicados,
      });
    } catch (e) {
      return json(res, 500, { error: e.message, stack: e.stack });
    }
  }

  // ── GET /manifest/:slug — manifest PWA personalizado por persona ──
  // Cada celular instala SU app dedicada apuntando a este manifest.
  if (req.method === 'GET' && req.url.startsWith('/manifest/')) {
    const slug = req.url.split('/')[2];
    const persona = getPersona(slug);
    if (!persona) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'persona no encontrada' }));
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    return res.end(JSON.stringify(manifestParaPersona(persona), null, 2));
  }

  // ── GET /app/:slug — página de bienvenida que setea localStorage y redirige ──
  // Es a este URL que se apuntan los links/QR personales: al abrirlo,
  // el celular ve el manifest personalizado y ofrece "Instalar app".
  if (req.method === 'GET' && req.url.startsWith('/app/')) {
    const slug = req.url.split('/')[2].split('?')[0];
    const persona = getPersona(slug);
    if (!persona) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Persona no encontrada</h1><p><a href="/#/movil">Volver al hub</a></p>');
    }
    // Personas marcadas inactive no pueden acceder a la app
    // (ej. Oscar — disenador full-time sin acceso por seguridad).
    if (persona.inactive) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Acceso no autorizado</h1><p>Esta persona no tiene acceso a la app.</p>');
    }
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>W&amp;S ${persona.nombre}</title>
<link rel="manifest" href="/manifest/${persona.slug}">
<link rel="icon" type="image/png" href="/icon.png">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="W&amp;S ${persona.nombre}">
<meta name="theme-color" content="${persona.color}">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Inter,sans-serif;background:#0f1117;color:#eef5ff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
  .card{max-width:380px;width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);border-radius:20px;padding:32px 24px;box-shadow:0 20px 60px rgba(0,0,0,0.45)}
  .emoji{font-size:64px;line-height:1;margin-bottom:10px}
  h1{font-size:1.6rem;margin-bottom:6px;color:${persona.color}}
  .sub{color:#93a4b8;font-size:0.9rem;margin-bottom:24px}
  .roles{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:22px}
  .rol{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);padding:4px 10px;border-radius:999px;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.5px;color:#cbd5e1}
  .btn{display:block;width:100%;background:${persona.color};color:#0f1117;font-weight:700;padding:14px 18px;border-radius:12px;text-decoration:none;font-size:1rem;margin-top:6px}
  .hint{margin-top:18px;font-size:0.78rem;color:#93a4b8;line-height:1.5}
  .hint strong{color:#eef5ff}
</style>
</head>
<body>
<div class="card">
  <div class="emoji">${persona.emoji}</div>
  <h1>${persona.nombre}</h1>
  <div class="sub">Tu app personal — W&amp;S Textil</div>
  <div class="roles">${persona.roles.map(r => `<span class="rol">${r}</span>`).join('')}</div>
  <a class="btn" id="ir" href="${persona.vistaInicial}">Entrar</a>
  <div class="hint">
    <strong>Para instalar en tu celular:</strong><br>
    1. Pulsa el menú del navegador (⋮).<br>
    2. Elige <em>Instalar app</em> o <em>Añadir a pantalla de inicio</em>.<br>
    3. Quedará un ícono con tu nombre.
  </div>
</div>
<script>
  try {
    localStorage.setItem('ws_persona', ${JSON.stringify(persona.slug)});
    localStorage.setItem('ws_persona_nombre', ${JSON.stringify(persona.nombre)});
  } catch (e) {}
  // Auto-entrar después de 1.5s si NO está siendo abierta como PWA standalone.
  // Si está en modo standalone (instalada), entra inmediatamente.
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) {
    window.location.replace(${JSON.stringify(persona.vistaInicial)});
  }
</script>
</body>
</html>`;
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ── Archivos estáticos ──────────────────────────────────────
  // Quitar query params (?v=xxx cache busters) antes de buscar el archivo
  const urlSinQuery = (req.url || '/').split('?')[0];
  let filePath = path.join(__dirname, urlSinQuery === '/' ? 'index.html' : urlSinQuery);

  if (urlSinQuery !== '/' && !fs.existsSync(filePath)) {
    const publicPath = path.join(__dirname, 'public', urlSinQuery);
    if (fs.existsSync(publicPath)) filePath = publicPath;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        // NO cachear el HTML para que siempre tome la version mas reciente
        // (que tiene el cache buster ?v=COMMIT actualizado para los JS/CSS)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
        res.end(d2);
      });
      return;
    }
    cors(res);
    // Cabeceras anti-cache para HTML/JS/CSS para que el browser siempre
    // pida la version mas reciente. Imagenes (.png/.jpg/.ico) si pueden
    // cachearse 1 dia porque cambian poco.
    const noCache = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json';
    const cacheHeader = noCache
      ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
      : { 'Cache-Control': 'public, max-age=86400' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain', ...cacheHeader });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`W&S App corriendo en puerto ${PORT}`);
  console.log(`[startup] API_KEY env var: ${process.env.API_KEY ? 'OK (set)' : 'MISSING (using default)'}`);
  console.log(`[startup] API_KEY first 8 chars: ${(process.env.API_KEY || 'ws-textil-2026').slice(0, 8)}...`);
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
function _huelaPMBogota() {
  // Calcula si AHORA es la hora 20 (8 PM) en zona Bogotá (UTC-5).
  const ahoraUtc = new Date();
  const horaBogota = (ahoraUtc.getUTCHours() - 5 + 24) % 24;
  return horaBogota;
}

// ── Helper: ¿el pedido tiene factura emitida hoy? ──
function pedidoTieneFactura(pedidoId) {
  try {
    const facts = db.leerFacturasPorPedido(pedidoId) || [];
    return facts.length > 0;
  } catch { return false; }
}

// ── Helper: ¿el comprobante tiene sticker en el chat del cliente? ──
// (busca pedido del mismo telefono en estado != bandeja en ventana de 18h)
function _comprobanteTieneSticker(telefono, pedidosCur, limiteTs) {
  const tel = String(telefono).replace(/\D/g, '');
  return pedidosCur.some(p => {
    const pTel = String(p.telefono || '').replace(/\D/g, '');
    if (pTel !== tel) return false;
    if (p.estado === 'bandeja') return false;
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    return t >= limiteTs;
  });
}

async function enviarResumenComprobantes() {
  try {
    const lista = db.leerComprobantes();
    const pedidosCur = leerPedidos();
    // Ventana del día de trabajo (18h)
    const limite = Date.now() - 18 * 60 * 60 * 1000;
    const recientes = lista.filter(r => new Date(r.ts).getTime() >= limite);

    // ── Comprobantes SIN sticker (agrupados por vendedora) ──
    const sinMarcar = recientes.filter(r => !_comprobanteTieneSticker(r.telefono, pedidosCur, limite));
    const compSinStickerPorVend = {};
    sinMarcar.forEach(r => {
      const v = r.vendedora || 'Betty';
      if (!compSinStickerPorVend[v]) compSinStickerPorVend[v] = [];
      compSinStickerPorVend[v].push(r);
    });

    // ── Pedidos creados hoy (agrupados por vendedora) ──
    // Cualquier pedido con ultimoMovimiento dentro de las 18h
    const pedidosHoy = pedidosCur.filter(p => {
      const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
      return t >= limite;
    });
    const pedidosPorVend = {};
    pedidosHoy.forEach(p => {
      const v = p.vendedora || 'Betty';
      if (!pedidosPorVend[v]) pedidosPorVend[v] = [];
      pedidosPorVend[v].push(p);
    });

    // ── Vendedoras: SIEMPRE incluir las 4 (Betty/Ney/Wendy/Paola)
    //    para que cada una sepa cómo cerró su día (aunque sea 0 ventas).
    //    Sigue mostrando comprobantes/pedidos cuando hay; si no, "Día sin actividad".
    const vendedorasActivas = new Set([
      'Betty', 'Ney', 'Wendy', 'Paola',
      ...Object.keys(compSinStickerPorVend),
      ...Object.keys(pedidosPorVend),
    ]);

    // ── Mandar WA RESUMEN CORTO a cada vendedora que tuvo actividad ──
    for (const vendedora of vendedorasActivas) {
      const peds = pedidosPorVend[vendedora] || [];
      const compsSin = compSinStickerPorVend[vendedora] || [];
      const dia = resumenDiaVendedora(vendedora);
      const facturasPend = peds.filter(p => !pedidoTieneFactura(p.id));

      // ANTI-SPAM: si no hubo actividad y no hay pendientes, NO mandar.
      if (peds.length === 0 && compsSin.length === 0 && facturasPend.length === 0) {
        console.log(`[resumen-8pm] SALTADO ${vendedora}: sin actividad`);
        continue;
      }

      // Resumen ULTRA CORTO — fácil de leer al final del día
      let texto = `📊 ${vendedora.toUpperCase()} — Resumen del día\n`;
      texto += `✅ ${peds.length} ventas | 💰 ${_formatearMontoCOP(dia.totalMonto)}\n`;
      if (compsSin.length) {
        texto += `⚠️ ${compsSin.length} pago(s) SIN sticker — ponlos\n`;
      }
      if (facturasPend.length) {
        texto += `🧾 ${facturasPend.length} factura(s) pendientes: #${facturasPend.map(p => p.id).join(', #')}\n`;
      }
      if (compsSin.length === 0 && facturasPend.length === 0) {
        texto += `🎉 ¡Día completo!`;
      }

      try { await notificarWAVendedora(vendedora, texto); } catch (e) { console.error('[resumen-8pm wa]', e.message); }
      console.log(`[resumen-8pm] enviado a ${vendedora}: ${peds.length} pedidos / ${compsSin.length} sin sticker`);
    }

    // ── Resumen consolidado al jefe (Camilo + Graciela + TG) ──
    const detalleAdmin = Array.from(vendedorasActivas).map(v => {
      const peds = pedidosPorVend[v] || [];
      const compsSin = compSinStickerPorVend[v] || [];
      const dia = resumenDiaVendedora(v);
      const facturasPend = peds.filter(p => !pedidoTieneFactura(p.id));
      const conFact = peds.length - facturasPend.length;
      return `💰 *${v.toUpperCase()}*\n` +
        `   • ${peds.length} ventas con sticker\n` +
        `   • ${compsSin.length} comprobantes SIN sticker\n` +
        `   • ${facturasPend.length} facturas pendientes${facturasPend.length ? ' (#' + facturasPend.map(p => p.id).join(', #') + ')' : ''}\n` +
        `   • ${conFact}/${peds.length} con factura\n` +
        `   • Total detectado: ${_formatearMontoCOP(dia.totalMonto)}`;
    }).join('\n\n');

    const totalPedidos = Object.values(pedidosPorVend).reduce((s, l) => s + l.length, 0);
    const totalSinSticker = sinMarcar.length;
    const totalConFactura = pedidosHoy.filter(p => pedidoTieneFactura(p.id)).length;
    const totalSinFactura = totalPedidos - totalConFactura;
    const totalMontoHoy = Array.from(vendedorasActivas).reduce((s, v) => s + resumenDiaVendedora(v).totalMonto, 0);

    const adminText = `📊 *RESUMEN DEL DÍA — 8 PM*\n` +
      `─────────────────────────────\n\n` +
      `${detalleAdmin}\n\n` +
      `─────────────────────────────\n` +
      `📈 *TOTAL DÍA:* ${totalPedidos} pedidos\n` +
      `   ✅ ${totalPedidos} con sticker | ⚠️ ${totalSinSticker} sin sticker\n` +
      `   ✅ ${totalConFactura} con factura | ⚠️ ${totalSinFactura} sin factura\n` +
      `💰 Total detectado: *${_formatearMontoCOP(totalMontoHoy)}*\n\n` +
      `${totalSinFactura || totalSinSticker ? '⚠️ Verifica que terminen antes de mañana 10 AM' : '🎉 Día completo, todo en orden.'}`;

    try { await responderJefe(adminText); } catch (e) { console.error('[resumen-8pm jefe]', e.message); }
    try { await notificarWAPersona('graciela', adminText); } catch (e) { console.error('[resumen-8pm graciela]', e.message); }
    try { await notificarTelegram(adminText); } catch {}
  } catch (e) {
    console.error('[resumen-8pm error]', e.message);
  }
}

// CRON 8PM REACTIVADO (2026-05-22) — chequea cada minuto si es 8 PM Bogotá
// y dispara enviarResumenComprobantes UNA sola vez al día. Manda WA personal
// a cada vendedora con sus comprobantes sin marcar + resumen a Duvan en TG.
// Guarda última fecha de envío en archivo para evitar duplicados.
const CRON_8PM_FILE = path.join(__dirname, 'data', 'cron_8pm_ultimo.json');
function _ya8pmHoy() {
  try {
    if (!fs.existsSync(CRON_8PM_FILE)) return false;
    const ultimo = JSON.parse(fs.readFileSync(CRON_8PM_FILE, 'utf8'));
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    return ultimo.fecha === hoyBogota;
  } catch { return false; }
}
function _marcar8pmHoy() {
  try {
    fs.mkdirSync(path.dirname(CRON_8PM_FILE), { recursive: true });
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    fs.writeFileSync(CRON_8PM_FILE, JSON.stringify({ fecha: hoyBogota, ts: Date.now() }));
  } catch (e) { console.error('[cron-8pm] no se pudo marcar:', e.message); }
}
async function cron8pmTick() {
  try {
    const hora = _huelaPMBogota();
    if (hora !== 20) return; // solo en la hora 20 (8 PM)
    if (_ya8pmHoy()) return; // ya se ejecutó hoy
    console.log('[cron-8pm] disparando resumen de comprobantes...');
    await enviarResumenComprobantes();
    _marcar8pmHoy();
  } catch (e) { console.error('[cron-8pm error]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cron8pmTick, 60 * 1000);
// setTimeout(cron8pmTick, 30 * 1000);
console.log('[cron-8pm] activado — disparará a las 8 PM Bogotá');

// ═══════════════════════════════════════════════════════════════════
// CRON ALERTAS JEFE — cada 30 min en horario laboral (8 AM - 8 PM Bogotá)
// Computa _computarAlertas(true). Si hay alertas nuevas, manda UN WA a Camilo
// via notificarJefes. Si no, silencio. Reemplaza al cron de OpenClaw que
// peleaba con escapes de shell de Windows.
// ═══════════════════════════════════════════════════════════════════
async function cronAlertasJefeTick() {
  try {
    const horaBogota = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }), 10);
    if (horaBogota < 8 || horaBogota >= 20) return; // solo 8 AM - 8 PM Bogota
    const r = _computarAlertas(true);
    if (!r.mensaje_wa) return; // sin alertas -> silencio
    if (typeof notificarJefes === 'function') {
      await notificarJefes(r.mensaje_wa, { soloJefe: true, dedupeKey: `alertas-jefe:${new Date().toISOString().slice(0,13)}` });
      console.log(`[cron-alertas-jefe] enviado WA con ${r.total_nuevas} alertas`);
    }
  } catch (e) { console.error('[cron-alertas-jefe error]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronAlertasJefeTick, 30 * 60 * 1000);
// setTimeout(cronAlertasJefeTick, 90 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON SILENCIOSO 10 PM Bogotá — revisa TODOS los pedidos activos y los
// avanza segun: chat (Gemini+Claude) + PDF Drive + WeTransfer.
// CERO WhatsApps a vendedoras. Solo cambia estados.
// Notifica al jefe SOLO 1 vez al día (resumen) y si saldo bajo.
//
// Endpoints control:
//   GET /api/admin/cron-silencioso-probar  → corre 1 vez sin mover
//   POST /api/admin/cron-silencioso-on     → activa
//   POST /api/admin/cron-silencioso-off    → desactiva
//   GET /api/admin/cron-silencioso-status  → estado + gasto + historial
// ═══════════════════════════════════════════════════════════════════
const CRON_SILENCIOSO_CONFIG_FILE = path.join(__dirname, 'data', 'cron_silencioso_config.json');
const CRON_SILENCIOSO_HISTORIAL_FILE = path.join(__dirname, 'data', 'cron_silencioso_historial.json');
const CRON_SILENCIOSO_GASTO_FILE = path.join(__dirname, 'data', 'cron_silencioso_gasto.json');
const CRON_SILENCIOSO_ULTIMO_FILE = path.join(__dirname, 'data', 'cron_silencioso_ultimo.json');

// Costos aprox por llamada (USD)
const COSTO_GEMINI_FLASH = 0.002; // analizar chat + clasificar img + comparar PDFs ~$0.002
const COSTO_CLAUDE_SONNET = 0.018; // ~$0.018 por chat
const LIMITE_MES_USD = parseFloat(process.env.CRON_LIMITE_MES_USD || '3.00');
const LIMITE_DIA_USD = parseFloat(process.env.CRON_LIMITE_DIA_USD || '0.30');
// Costos vs límite: 1 corrida ~$0.066 → cabe 4 corridas/día ($0.30) y 45/mes ($3)
const AVISO_PORCENTAJE = 0.8; // 80% del limite mensual → notificacion

function _leerConfigCron() {
  try { return JSON.parse(fs.readFileSync(CRON_SILENCIOSO_CONFIG_FILE, 'utf8')); }
  catch { return { activo: false, ultimaModificacion: null }; }
}
function _guardarConfigCron(cfg) {
  try { fs.mkdirSync(path.dirname(CRON_SILENCIOSO_CONFIG_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(CRON_SILENCIOSO_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function _leerGasto() {
  try { return JSON.parse(fs.readFileSync(CRON_SILENCIOSO_GASTO_FILE, 'utf8')); }
  catch { return { mes: {}, dia: {}, avisado80: false, ultimaApiError: null }; }
}
function _guardarGasto(g) {
  try { fs.mkdirSync(path.dirname(CRON_SILENCIOSO_GASTO_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(CRON_SILENCIOSO_GASTO_FILE, JSON.stringify(g, null, 2));
}
function _registrarGasto(usd) {
  const g = _leerGasto();
  const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  const mesActual = hoyBogota.slice(0, 7) || hoyBogota.split('/').slice(1).join('-');
  // Formato mes: YYYY-MM o DD/MM/YYYY → tomar mes
  const fecha = new Date();
  const mesKey = `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}`;
  g.mes[mesKey] = (g.mes[mesKey] || 0) + usd;
  g.dia[hoyBogota] = (g.dia[hoyBogota] || 0) + usd;
  _guardarGasto(g);
  return g;
}
function _gastoMesActual() {
  const g = _leerGasto();
  const fecha = new Date();
  const mesKey = `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}`;
  return g.mes[mesKey] || 0;
}
function _gastoDiaActual() {
  const g = _leerGasto();
  const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  return g.dia[hoyBogota] || 0;
}
function _agregarHistorial(entrada) {
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(CRON_SILENCIOSO_HISTORIAL_FILE, 'utf8')); } catch {}
  hist.unshift({ ts: new Date().toISOString(), ...entrada });
  hist = hist.slice(0, 500); // max 500
  try { fs.mkdirSync(path.dirname(CRON_SILENCIOSO_HISTORIAL_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(CRON_SILENCIOSO_HISTORIAL_FILE, JSON.stringify(hist, null, 2));
}
function _yaCorrioHoy() {
  try {
    if (!fs.existsSync(CRON_SILENCIOSO_ULTIMO_FILE)) return false;
    const ult = JSON.parse(fs.readFileSync(CRON_SILENCIOSO_ULTIMO_FILE, 'utf8'));
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    return ult.fecha === hoyBogota;
  } catch { return false; }
}
function _marcarCorrioHoy(resumen) {
  try {
    fs.mkdirSync(path.dirname(CRON_SILENCIOSO_ULTIMO_FILE), { recursive: true });
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    fs.writeFileSync(CRON_SILENCIOSO_ULTIMO_FILE, JSON.stringify({ fecha: hoyBogota, ts: Date.now(), resumen }));
  } catch (e) { console.error('[cron-silencioso] marcar:', e.message); }
}

// Lista de clientes catalogo / mayoristas (saltar)
const CLIENTES_CATALOGO_PATRONES = [
  /mayorista/i,
  /catalogo/i,
  /almacen/i,
];
function esClienteCatalogo(equipo) {
  return CLIENTES_CATALOGO_PATRONES.some(rx => rx.test(equipo || ''));
}

// Determina el siguiente estado dado el analisis chat + PDF + WeTransfer
function decidirSiguienteEstado(pedido, analisisChat, comparacionPdf, wetransfer) {
  // Reglas en orden:
  // 1. Si calandra descargó PDF → enviado-calandra (alta confianza)
  if (wetransfer?.estadoCalandra === 'descargado-por-calandra') {
    return { estado: 'enviado-calandra', confianza: 'alta', razon: 'WeTransfer descargado por calandra' };
  }
  if (wetransfer?.estadoCalandra === 'enviado-a-calandra') {
    return { estado: 'enviado-calandra', confianza: 'alta', razon: 'WeTransfer enviado a sublimarte' };
  }
  // 2. Si chat dice entregado (Claude/Gemini) con alta confianza
  const chatEstado = analisisChat?.veredictoClaude?.estadoVeredicto || analisisChat?.analisisGemini?.estadoReal;
  const chatConf = analisisChat?.veredictoClaude?.confianza || analisisChat?.analisisGemini?.confianza;
  if (chatEstado === 'entregado' && chatConf === 'alta') {
    return { estado: 'enviado-final', confianza: 'alta', razon: 'Chat indica entregado' };
  }
  // 3. Si PDF rip existe en Drive con match visual → confirmado
  if (comparacionPdf?.veredicto?.coincide === true && comparacionPdf?.veredicto?.confianza === 'alta') {
    return { estado: 'confirmado', confianza: 'alta', razon: `PDF rip ${comparacionPdf.veredicto.pdfElegido} match` };
  }
  // 4. Si chat dice listo-para-entregar con alta confianza
  if (chatEstado === 'listo-para-entregar' && chatConf === 'alta') {
    return { estado: 'listo', confianza: 'alta', razon: 'Chat indica produccion terminada' };
  }
  // 5. Si chat dice aprobado-listo-calandra con alta confianza + hay imagen del diseño
  if (chatEstado === 'aprobado-listo-calandra' && chatConf === 'alta' && comparacionPdf?.imagenChatQuien === 'vendedora') {
    return { estado: 'confirmado', confianza: 'alta', razon: 'Cliente aprobo diseno (vendedora envio imagen)' };
  }
  // 6. Si chat dice en-correcciones → mantener en hacer-diseno
  if (chatEstado === 'en-correcciones') {
    return { estado: pedido.estado, confianza: 'alta', razon: 'cliente pidio cambios → no mover' };
  }
  // Sin certeza
  return null;
}

async function ejecutarCronSilencioso(modoPrueba = false) {
  const resultado = {
    inicio: new Date().toISOString(),
    procesados: 0,
    saltados: 0,
    movidos: [],
    sinCambios: [],
    dudosos: [],
    errores: [],
    costoEstimado: 0,
    modoPrueba,
  };

  // Verificar frenos
  if (!modoPrueba) {
    const gastoMes = _gastoMesActual();
    const gastoDia = _gastoDiaActual();
    if (gastoMes >= LIMITE_MES_USD) {
      resultado.errores.push(`freno: gasto del mes \$${gastoMes.toFixed(2)} >= \$${LIMITE_MES_USD}`);
      return resultado;
    }
    if (gastoDia >= LIMITE_DIA_USD) {
      resultado.errores.push(`freno: gasto del dia \$${gastoDia.toFixed(2)} >= \$${LIMITE_DIA_USD}`);
      return resultado;
    }
  }

  const pedidos = leerPedidos();
  // Solo procesar pedidos ACTIVOS (no enviado-final, archivado, cancelado, bandeja)
  const ACTIVOS = ['hacer-diseno', 'confirmado', 'enviado-calandra', 'llego-impresion', 'corte', 'costura', 'en-satelite', 'calidad', 'listo'];
  const candidatos = pedidos.filter(p => ACTIVOS.includes(p.estado) && p.telefono);

  for (const p of candidatos) {
    resultado.procesados++;
    // Saltar clientes catalogo
    if (esClienteCatalogo(p.equipo)) {
      resultado.saltados++;
      resultado.sinCambios.push({ id: p.id, equipo: p.equipo, razon: 'cliente catalogo' });
      continue;
    }
    // Saltar pedidos > 30 dias sin abono (probable consulta abandonada)
    if (p.creadoEn) {
      const dias = (Date.now() - new Date(p.creadoEn).getTime()) / 86400000;
      if (dias > 30 && (p.abonado || 0) === 0) {
        resultado.saltados++;
        resultado.sinCambios.push({ id: p.id, equipo: p.equipo, razon: '>30d sin abono' });
        continue;
      }
    }

    try {
      // 1. Analizar chat
      const analisisChat = await (async () => {
        try {
          // Inline: usar helper que ya tenemos
          // Para simplificar, no usamos fetch interno — reproducimos la lógica clave aquí
          // Pero como el codigo del endpoint usa muchas funciones, vamos a llamarlo via fetch local
          const r = await fetch(`http://localhost:${PORT || process.env.PORT || 8080}/api/admin/analizar-chat-completo?id=${p.id}&limit=40`);
          if (!r.ok) return null;
          return await r.json();
        } catch (e) { return null; }
      })();
      const usoClaude = !!analisisChat?.veredictoClaude;
      resultado.costoEstimado += COSTO_GEMINI_FLASH + (usoClaude ? COSTO_CLAUDE_SONNET : 0);

      // 2. Comparar PDF (solo si chat sugiere algo)
      let comparacionPdf = null;
      const chatEstado = analisisChat?.veredictoClaude?.estadoVeredicto || analisisChat?.analisisGemini?.estadoReal;
      if (chatEstado && chatEstado !== 'en-correcciones' && chatEstado !== 'sin-imagen-aun') {
        try {
          const r = await fetch(`http://localhost:${PORT || process.env.PORT || 8080}/api/admin/comparar-aprobacion-vs-pdf?id=${p.id}`);
          if (r.ok) comparacionPdf = await r.json();
        } catch {}
        resultado.costoEstimado += COSTO_GEMINI_FLASH;
      }

      // 2b. Guardar nombreDiseno si Gemini lo extrajo (con validacion: que NO sea comprobante)
      const textoDisenoExtraido = comparacionPdf?.textoDiseno?.textoPrincipal;
      const esTextoValido = textoDisenoExtraido
        && textoDisenoExtraido.length >= 3
        && !/transacc|venta confirm|comprobante|bancolombia|nequi|daviplata/i.test(textoDisenoExtraido)
        && comparacionPdf?.imagenChatQuien === 'vendedora'; // solo si la imagen es de la vendedora (es el diseño)
      if (esTextoValido && textoDisenoExtraido !== p.nombreDiseno) {
        try {
          await fetch(`http://localhost:${PORT || process.env.PORT || 8080}/api/pedidos/${p.id}/diseno-detectado`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombreDiseno: textoDisenoExtraido }),
          });
        } catch (e) { console.error('[cron diseno-detectado]', e.message); }
      }

      // 3. Verificar WeTransfer si tenemos texto del diseño
      let wetransfer = null;
      const textoDis = comparacionPdf?.textoDiseno?.textoPrincipal;
      if (textoDis) {
        try {
          const r = await fetch(`http://localhost:${PORT || process.env.PORT || 8080}/api/admin/verificar-envio-calandra?id=${p.id}&texto=${encodeURIComponent(textoDis)}&dias=60`);
          if (r.ok) wetransfer = (await r.json()).veredicto;
        } catch {}
      }

      // 4. Decidir
      const decision = decidirSiguienteEstado(p, analisisChat, comparacionPdf, wetransfer);

      if (!decision || decision.confianza !== 'alta') {
        resultado.dudosos.push({
          id: p.id, equipo: p.equipo,
          chat: chatEstado, chatConf: analisisChat?.analisisGemini?.confianza,
          pdf: comparacionPdf?.veredicto?.coincide, wt: wetransfer?.estadoCalandra,
          razon: 'confianza no alta o sin decision',
        });
        continue;
      }
      if (decision.estado === p.estado) {
        resultado.sinCambios.push({ id: p.id, equipo: p.equipo, razon: decision.razon });
        continue;
      }

      // 5. Mover (solo si NO es modo prueba)
      if (!modoPrueba) {
        try {
          const r = await fetch(`http://localhost:${PORT || process.env.PORT || 8080}/api/pedidos/${p.id}/avanzar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: decision.estado }),
          });
          if (!r.ok) throw new Error('avanzar HTTP ' + r.status);
          _agregarHistorial({
            pedidoId: p.id, equipo: p.equipo,
            de: p.estado, a: decision.estado,
            razon: decision.razon,
            confianza: decision.confianza,
          });
        } catch (e) {
          resultado.errores.push({ id: p.id, error: e.message });
          continue;
        }
      }
      resultado.movidos.push({
        id: p.id, equipo: p.equipo,
        de: p.estado, a: decision.estado,
        razon: decision.razon,
      });

    } catch (e) {
      resultado.errores.push({ id: p.id, error: e.message });
    }
  }

  // Registrar gasto (solo si no es modo prueba)
  if (!modoPrueba && resultado.costoEstimado > 0) {
    _registrarGasto(resultado.costoEstimado);
  }
  resultado.fin = new Date().toISOString();
  resultado.gastoMesAcumulado = _gastoMesActual();
  resultado.gastoDiaActual = _gastoDiaActual();
  return resultado;
}

async function cronSilenciosoTick() {
  try {
    const cfg = _leerConfigCron();
    if (!cfg.activo) return;
    const hora = _huelaPMBogota();
    if (hora !== 22) return; // 10 PM
    if (_yaCorrioHoy()) return;
    console.log('[cron-silencioso] disparando ejecucion 10 PM...');
    const resultado = await ejecutarCronSilencioso(false);
    _marcarCorrioHoy({
      procesados: resultado.procesados,
      movidos: resultado.movidos.length,
      dudosos: resultado.dudosos.length,
      gastoEstimado: resultado.costoEstimado,
    });

    // Notificacion al jefe (1 sola, soloJefe)
    const lineas = [];
    lineas.push(`🤖 *Cron silencioso* — ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}`);
    lineas.push(`Procesados: ${resultado.procesados} | Movidos: ${resultado.movidos.length} | Dudosos: ${resultado.dudosos.length}`);
    if (resultado.movidos.length) {
      lineas.push('');
      lineas.push('*Movidos:*');
      resultado.movidos.slice(0, 10).forEach(m => lineas.push(`• #${m.id} ${m.equipo}: ${m.de} → ${m.a}`));
    }
    lineas.push('');
    lineas.push(`💰 Gasto día: \$${resultado.gastoDiaActual.toFixed(3)} | mes: \$${resultado.gastoMesAcumulado.toFixed(3)} / \$${LIMITE_MES_USD}`);

    // Aviso 80% del presupuesto mensual
    const g = _leerGasto();
    if (resultado.gastoMesAcumulado >= LIMITE_MES_USD * AVISO_PORCENTAJE && !g.avisado80) {
      lineas.push('');
      lineas.push(`⚠️ *Atención*: gasto del mes llegó al ${Math.round(AVISO_PORCENTAJE*100)}% (\$${resultado.gastoMesAcumulado.toFixed(2)}/\$${LIMITE_MES_USD}). El cron se apagará solo al pasarse del límite.`);
      g.avisado80 = true; _guardarGasto(g);
    }
    if (resultado.gastoMesAcumulado >= LIMITE_MES_USD) {
      lineas.push('');
      lineas.push(`🛑 *FRENO*: pasaste el límite mensual. Cron PAUSADO automático. Reactivar en /api/admin/cron-silencioso-on cuando quieras.`);
      cfg.activo = false; _guardarConfigCron(cfg);
    }

    try {
      if (typeof notificarJefes === 'function') {
        await notificarJefes(lineas.join('\n'), { soloJefe: true, dedupeKey: `cron-silencioso-${new Date().toLocaleDateString('es-CO',{timeZone:'America/Bogota'})}` });
      }
    } catch (eN) { console.error('[cron-silencioso notif]', eN.message); }
  } catch (e) {
    console.error('[cron-silencioso error]', e.message);
  }
}
// Tick cada minuto buscando la hora 10 PM
setInterval(cronSilenciosoTick, 60 * 1000);
console.log('[cron-silencioso] tick instalado — disparara a las 22 (10 PM) Bogota si esta activado');

// ═══════════════════════════════════════════════════════════════════
// CHECK SALDO CLAUDE — Anthropic NO da saldo via API, pero podemos:
//   1) Hacer una llamada minima (~$0.00002) y ver si responde
//   2) Si error 400 con "credit balance too low" → saldo agotado
//   3) Notificar al jefe si esta agotado
// Endpoint: GET /api/admin/saldo-claude
// ═══════════════════════════════════════════════════════════════════
async function verificarSaldoClaude() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { proveedor: 'claude', ok: false, error: 'sin API key configurada' };
  try {
    const body = {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const data = await r.json();
      return {
        proveedor: 'claude',
        ok: true,
        saldoActivo: true,
        modeloOk: data.model,
        mensaje: 'API responde. Saldo exacto solo en console.anthropic.com/settings/billing.',
        urlSaldo: 'https://console.anthropic.com/settings/billing',
      };
    }
    const errText = await r.text();
    const lowBalance = /credit balance.*too low/i.test(errText);
    return {
      proveedor: 'claude',
      ok: false,
      saldoActivo: !lowBalance,
      httpStatus: r.status,
      error: errText.slice(0, 300),
      saldoAgotado: lowBalance,
      urlSaldo: 'https://console.anthropic.com/settings/billing',
    };
  } catch (e) {
    return { proveedor: 'claude', ok: false, error: e.message };
  }
}

async function verificarSaldoGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { proveedor: 'gemini', ok: false, error: 'sin API key configurada' };
  try {
    const modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } }
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) {
      return {
        proveedor: 'gemini',
        ok: true,
        saldoActivo: true,
        modelo,
        mensaje: 'API responde. Gemini Flash tiene tier gratis (1500/dia). Si se pasa, queda en pago bajo. Cuotas en console.cloud.google.com/iam-admin/quotas.',
        urlSaldo: 'https://aistudio.google.com/apikey',
      };
    }
    const errText = await r.text();
    const cuotaExcedida = /quota.*exceeded|rate.*limit/i.test(errText);
    return {
      proveedor: 'gemini',
      ok: false,
      saldoActivo: !cuotaExcedida,
      httpStatus: r.status,
      error: errText.slice(0, 300),
      cuotaExcedida,
      urlSaldo: 'https://aistudio.google.com/apikey',
    };
  } catch (e) {
    return { proveedor: 'gemini', ok: false, error: e.message };
  }
}

// Tick cada 6 hs chequea AMBOS saldos. Notifica al jefe SOLO 1 vez por agotamiento.
async function tickSaldos() {
  try {
    const [claude, gemini] = await Promise.all([verificarSaldoClaude(), verificarSaldoGemini()]);
    const g = _leerGasto();
    const avisos = [];

    if (claude.saldoAgotado) {
      if (!g.notificadoClaudeAgotado) {
        avisos.push(`🚨 *Créditos Claude AGOTADOS*\nRecargar en ${claude.urlSaldo}\nEl cron silencioso seguirá con Gemini solo mientras tanto.`);
        g.notificadoClaudeAgotado = true;
      }
    } else if (claude.saldoActivo && g.notificadoClaudeAgotado) {
      avisos.push(`✅ Créditos Claude RECARGADOS, sistema completo activo.`);
      g.notificadoClaudeAgotado = false;
    }

    if (gemini.cuotaExcedida) {
      if (!g.notificadoGeminiAgotado) {
        avisos.push(`🚨 *Cuota Gemini EXCEDIDA*\nRevisar en ${gemini.urlSaldo}\nEl cron silencioso quedará en pausa hasta que se reponga.`);
        g.notificadoGeminiAgotado = true;
      }
    } else if (gemini.saldoActivo && g.notificadoGeminiAgotado) {
      avisos.push(`✅ Cuota Gemini DISPONIBLE de nuevo.`);
      g.notificadoGeminiAgotado = false;
    }

    if (avisos.length) {
      _guardarGasto(g);
      try {
        if (typeof notificarJefes === 'function') {
          await notificarJefes(avisos.join('\n\n'), { soloJefe: true, dedupeKey: `saldos-${new Date().toLocaleDateString('es-CO',{timeZone:'America/Bogota'})}-${avisos.length}` });
        }
      } catch {}
    }
  } catch (e) { console.error('[tick-saldos]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(tickSaldos, 6 * 60 * 60 * 1000);
// setTimeout(tickSaldos, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON 7 PM — snapshot de "Ventas por confirmar" al jefe (panel WA)
// ═══════════════════════════════════════════════════════════════════
const CRON_7PM_FILE = path.join(__dirname, 'data', 'cron_7pm_ultimo.json');
function _ya7pmHoy() {
  try {
    if (!fs.existsSync(CRON_7PM_FILE)) return false;
    const ultimo = JSON.parse(fs.readFileSync(CRON_7PM_FILE, 'utf8'));
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    return ultimo.fecha === hoyBogota;
  } catch { return false; }
}
function _marcar7pmHoy() {
  try {
    fs.mkdirSync(path.dirname(CRON_7PM_FILE), { recursive: true });
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    fs.writeFileSync(CRON_7PM_FILE, JSON.stringify({ fecha: hoyBogota, ts: Date.now() }));
  } catch (e) { console.error('[cron-7pm] no se pudo marcar:', e.message); }
}
async function cron7pmTick() {
  try {
    const hora = _huelaPMBogota();
    if (hora !== 19) return; // 7 PM
    if (_ya7pmHoy()) return;
    console.log('[cron-7pm] disparando snapshot ventas por confirmar...');
    const snap = generarSnapshotVentas();
    await enviarSnapshotWA(snap);
    _marcar7pmHoy();
  } catch (e) { console.error('[cron-7pm error]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cron7pmTick, 60 * 1000);
// setTimeout(cron7pmTick, 45 * 1000);
console.log('[cron-7pm] activado — snapshot ventas-por-confirmar 7 PM Bogotá');

// ═══════════════════════════════════════════════════════════════════
// CRON DOMINGO 7 PM — Resumen semanal para el dueño (Camilo)
// Compila: ventas semana + facturas + docs WA pendientes + atrasados
// + estado del tablero. Manda WA personal a Camilo.
// ═══════════════════════════════════════════════════════════════════
const CRON_DOM_FILE = path.join(__dirname, 'data', 'cron_dom_ultimo.json');
function _yaDomingoEstaSemana() {
  try {
    if (!fs.existsSync(CRON_DOM_FILE)) return false;
    const ultimo = JSON.parse(fs.readFileSync(CRON_DOM_FILE, 'utf8'));
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    return ultimo.fecha === hoyBogota;
  } catch { return false; }
}
function _marcarDomingoEstaSemana() {
  try {
    fs.mkdirSync(path.dirname(CRON_DOM_FILE), { recursive: true });
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    fs.writeFileSync(CRON_DOM_FILE, JSON.stringify({ fecha: hoyBogota, ts: Date.now() }));
  } catch (e) { console.error('[cron-dom] no se pudo marcar:', e.message); }
}
function _esDomingoEnBogota() {
  const ahoraUtc = new Date();
  // Bogotá = UTC-5. Construyo un Date en hora Bogotá usando offset
  const bogotaMs = ahoraUtc.getTime() - 5 * 60 * 60 * 1000;
  const bogotaDate = new Date(bogotaMs);
  return bogotaDate.getUTCDay() === 0; // 0 = domingo
}

async function generarResumenSemanalAdmin() {
  const ahora = Date.now();
  const haceSemana = ahora - 7 * 24 * 60 * 60 * 1000;
  const isoSemana = new Date(haceSemana).toISOString();
  const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });

  // 1) VENTAS de la semana (comprobantes detectados)
  const comprobantes = db.leerComprobantes();
  const ventasSemana = comprobantes.filter(c => new Date(c.ts).getTime() >= haceSemana);
  const ventasPorVend = {};
  let ventasTotalMonto = 0;
  for (const v of ventasSemana) {
    const vend = v.vendedora || 'Sin vendedora';
    if (!ventasPorVend[vend]) ventasPorVend[vend] = { n: 0, monto: 0 };
    ventasPorVend[vend].n++;
    ventasPorVend[vend].monto += (v.monto || 0);
    ventasTotalMonto += (v.monto || 0);
  }

  // 2) FACTURAS hechas en la app esta semana
  let facturasSemana = [];
  try {
    const allFact = db.leerFacturas(500, 0) || [];
    facturasSemana = allFact.filter(f => f.tipo === 'factura' && (f.creado_en || f.fecha) >= isoSemana);
  } catch {}
  const facturasMonto = facturasSemana.reduce((s, f) => s + (f.total || 0), 0);

  // 3) DOCS WA capturados pendientes revisar
  let docsWAPendientes = [];
  try { docsWAPendientes = db.leerDocumentosSalientesWANoRevisados() || []; } catch {}
  const docsPorVend = {};
  for (const d of docsWAPendientes) {
    if (!docsPorVend[d.vendedora]) docsPorVend[d.vendedora] = 0;
    docsPorVend[d.vendedora]++;
  }

  // 4) PEDIDOS — atrasados, por estado
  const pedidos = leerPedidos();
  const activos = pedidos.filter(p => p && p.estado && p.estado !== 'enviado-final');
  const porEstado = {};
  for (const p of activos) {
    porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;
  }
  // Atrasados: fechaEntrega < hoy y no esta en enviado-final
  const hoyIso = new Date().toISOString().slice(0, 10);
  const atrasados = activos.filter(p => {
    const fe = (p.fechaEntrega || '').slice(0, 10);
    return fe && fe < hoyIso;
  });

  // 5) COMPROBANTES sin sticker (los que el cron 8PM aún no logró marcar)
  let sinSticker = 0;
  const dbgPedidoMov = {};
  for (const p of pedidos) {
    if (!p.telefono) continue;
    const tel = String(p.telefono).replace(/\D/g, '');
    dbgPedidoMov[tel] = Math.max(dbgPedidoMov[tel] || 0, p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0);
  }
  for (const v of ventasSemana) {
    const tel = String(v.telefono || '').replace(/\D/g, '');
    const lastMov = dbgPedidoMov[tel] || 0;
    if (lastMov < new Date(v.ts).getTime()) sinSticker++;
  }

  // 6) CARTERA POR COBRAR — pedidos NO entregados con saldo > 0
  const carteraDetalle = pedidos
    .filter(p => p && p.estado && p.estado !== 'enviado-final')
    .map(p => ({
      id: p.id,
      cliente: p.cliente || p.equipo || 'Sin nombre',
      vendedora: p.vendedora || '-',
      total: p.total || 0,
      abonado: p.abonado || 0,
      saldo: Math.max(0, (p.total || 0) - (p.abonado || 0)),
    }))
    .filter(x => x.saldo > 0);
  const carteraTotal = carteraDetalle.reduce((s, x) => s + x.saldo, 0);
  const carteraTop = carteraDetalle.sort((a, b) => b.saldo - a.saldo).slice(0, 5);

  // 7) FLUJO ESTA SEMANA — nuevos, entregados
  // creadoEn viene en formato es-CO "D/M/YYYY" (no ISO), hay que parsear manualmente.
  const _parsearFecha = (v) => {
    if (!v) return 0;
    if (typeof v === 'string') {
      const mDmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mDmy) return new Date(parseInt(mDmy[3]), parseInt(mDmy[2]) - 1, parseInt(mDmy[1])).getTime();
    }
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  };
  const pedidosNuevos = pedidos.filter(p => _parsearFecha(p.creadoEn || p.ts || p.fechaCreacion) >= haceSemana).length;
  const pedidosEntregados = pedidos.filter(p => {
    if (p.estado !== 'enviado-final') return false;
    return _parsearFecha(p.ultimoMovimiento || p.fechaEntrega) >= haceSemana;
  }).length;

  // 8) CALANDRA — metros lineales impresos esta semana
  // Los m2 guardados estan en cm de largo de tela (convencion del parser de gmail-wt).
  // Dividimos por 100 al display para mostrar metros lineales reales.
  // Los huerfanos pueden tener dos eventos por archivo: 'enviado' y 'descargado'.
  // Solo contamos 'enviado' (la produccion real); 'descargado' es eco del mismo PDF.
  let cmSemanaCalandra = 0;
  let archivosSemanaCalandra = 0;
  for (const p of pedidos) {
    if (!p.wetransfer || !p.wetransfer.archivos) continue;
    for (const a of p.wetransfer.archivos) {
      if (!a.fechaEnvio) continue;
      if (new Date(a.fechaEnvio).getTime() < haceSemana) continue;
      cmSemanaCalandra += (a.m2 || 0);
      archivosSemanaCalandra++;
    }
  }
  try {
    const huerfanos = (typeof gmailWT !== 'undefined' && gmailWT.leerHuerfanos) ? gmailWT.leerHuerfanos() : [];
    for (const h of huerfanos) {
      if (h.accion !== 'enviado') continue; // descartar 'descargado' para no duplicar
      const f = h.fecha;
      if (!f) continue;
      if (new Date(f).getTime() < haceSemana) continue;
      cmSemanaCalandra += (h.archivo?.m2 || 0);
      archivosSemanaCalandra++;
    }
  } catch {}
  const metrosSemanaCalandra = cmSemanaCalandra / 100; // cm -> metros lineales

  // 9) ARREGLOS esta semana
  let arreglosSemana = 0;
  try {
    const allArr = db.leerArreglos() || [];
    arreglosSemana = allArr.filter(a => {
      const f = a.creado_en || a.fecha || a.ts;
      return f && new Date(f).getTime() >= haceSemana;
    }).length;
  } catch {}

  // 10) TOP VENDEDORA (la de mayor monto vendido)
  const topVendEntry = Object.entries(ventasPorVend).sort((a, b) => b[1].monto - a[1].monto)[0];
  const topVendedora = topVendEntry ? { nombre: topVendEntry[0], n: topVendEntry[1].n, monto: topVendEntry[1].monto } : null;

  return {
    hoyBogota,
    ventasSemana: { count: ventasSemana.length, monto: ventasTotalMonto, porVendedora: ventasPorVend, top: topVendedora },
    facturasSemana: { count: facturasSemana.length, monto: facturasMonto },
    docsWAPendientes: { count: docsWAPendientes.length, porVendedora: docsPorVend },
    pedidos: { activos: activos.length, porEstado, atrasados: atrasados.length, atrasadosDetalle: atrasados.slice(0, 5).map(p => ({ id: p.id, cliente: p.cliente || p.equipo || 'Sin nombre', fechaEntrega: p.fechaEntrega, estado: p.estado })) },
    comprobantesSinSticker: sinSticker,
    cartera: { totalPendiente: carteraTotal, pedidosCount: carteraDetalle.length, top: carteraTop },
    flujoSemana: { nuevos: pedidosNuevos, entregados: pedidosEntregados, arreglos: arreglosSemana },
    calandraSemana: { metros: metrosSemanaCalandra, archivos: archivosSemanaCalandra },
  };
}

function construirMensajeResumenSemanal(r) {
  const fmt = (n) => _formatearMontoCOP ? _formatearMontoCOP(n) : `$${(n||0).toLocaleString('es-CO')}`;
  const fmtMetros = (n) => `${(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 })} m`;
  const lineasVentas = Object.entries(r.ventasSemana.porVendedora)
    .sort((a,b) => b[1].monto - a[1].monto)
    .map(([v, d]) => `  • ${v}: ${d.n} (${fmt(d.monto)})`)
    .join('\n') || '  • Sin ventas detectadas';
  const lineasDocs = Object.entries(r.docsWAPendientes.porVendedora)
    .map(([v, n]) => `  • ${v}: ${n} docs`)
    .join('\n') || '  • Ninguno';
  const lineasEstado = Object.entries(r.pedidos.porEstado)
    .sort((a,b) => b[1] - a[1])
    .map(([e, n]) => `  • ${e}: ${n}`)
    .join('\n');
  const lineasAtrasados = r.pedidos.atrasadosDetalle
    .map(p => `  • #${p.id} ${p.cliente} — entrega ${p.fechaEntrega} (${p.estado})`)
    .join('\n');
  const lineasCartera = (r.cartera?.top || [])
    .map(c => `  • #${c.id} ${c.cliente} (${c.vendedora}) — ${fmt(c.saldo)}`)
    .join('\n') || '  • _(nadie debe nada)_';
  const topVendTxt = r.ventasSemana.top
    ? `🏆 ${r.ventasSemana.top.nombre} — ${fmt(r.ventasSemana.top.monto)} en ${r.ventasSemana.top.n} ventas`
    : '_(sin datos)_';

  return `📊 *RESUMEN SEMANAL — Domingo ${r.hoyBogota}*

💰 *VENTAS DETECTADAS (7 días)*
Total: *${r.ventasSemana.count}* ventas — *${fmt(r.ventasSemana.monto)}*
${lineasVentas}

${topVendTxt}

📄 *FACTURAS EMITIDAS EN APP (7 días)*
${r.facturasSemana.count} facturas — ${fmt(r.facturasSemana.monto)}

🏭 *PRODUCCIÓN CALANDRA (7 días)*
${fmtMetros(r.calandraSemana?.metros)} lineales impresos en ${r.calandraSemana?.archivos || 0} archivos enviados

🔄 *FLUJO DE PEDIDOS (7 días)*
🆕 Nuevos: ${r.flujoSemana?.nuevos || 0}
📦 Entregados: ${r.flujoSemana?.entregados || 0}
🛠️ Arreglos: ${r.flujoSemana?.arreglos || 0}

💳 *CARTERA POR COBRAR* (${r.cartera?.pedidosCount || 0} pedidos)
Total pendiente: *${fmt(r.cartera?.totalPendiente)}*
Top deudas:
${lineasCartera}

📥 *DOCUMENTOS WA SIN REVISAR* (${r.docsWAPendientes.count} total)
${lineasDocs}
${r.docsWAPendientes.count > 0 ? '\n👉 Revisá: https://ws-app-interna-production.up.railway.app/api/admin/docs-wa?solo=pendientes' : ''}

⚠️ *COMPROBANTES SIN STICKER esta semana*: ${r.comprobantesSinSticker}
${r.comprobantesSinSticker > 0 ? '_(vendedoras olvidaron poner sticker → revisar)_' : '_(todas las vendedoras marcaron sus ventas ✓)_'}

🚨 *PEDIDOS ATRASADOS HOY*: ${r.pedidos.atrasados}
${lineasAtrasados || '_(ninguno)_'}

📋 *TABLERO ACTIVO (${r.pedidos.activos} pedidos)*
${lineasEstado || '_(vacío)_'}

_Para incluir ganancia neta + compras de tela hace falta capturar esa data — pendiente Fase B._
_Buen domingo. Decisiones para mañana._`;
}

async function cronDomingoTick() {
  try {
    if (!_esDomingoEnBogota()) return;
    const hora = _huelaPMBogota();
    if (hora !== 19) return; // 7 PM Bogotá
    if (_yaDomingoEstaSemana()) return;
    console.log('[cron-dom] disparando resumen semanal admin...');
    const data = await generarResumenSemanalAdmin();
    const texto = construirMensajeResumenSemanal(data);
    // Doble canal: WA personal + grupo Telegram W&S Admin
    await responderJefe(texto);
    try { await notificarTelegramAdmin(texto); } catch (e) { console.error('[cron-dom tg]', e.message); }
    _marcarDomingoEstaSemana();
    console.log('[cron-dom] enviado WA+TG-Admin');
  } catch (e) { console.error('[cron-dom error]', e.message); }
}
setInterval(cronDomingoTick, 60 * 1000);
setTimeout(cronDomingoTick, 60 * 1000);
console.log('[cron-dom] activado — resumen semanal admin domingo 7 PM Bogotá');

// ═══════════════════════════════════════════════════════════════════
// CRON STICKER REPROCESADOR — red de seguridad diaria
// Ejecuta sticker-reprocesador todos los días a las 10 PM Bogotá.
// Recupera ventas perdidas por race conditions o el bug que afectó
// los stickers del 25-28 mayo (10 ventas perdidas).
// ═══════════════════════════════════════════════════════════════════
const CRON_STK_FILE = path.join(__dirname, 'data', 'cron_sticker_ultimo.json');
function _ultimoStickerCronDia() {
  try { return JSON.parse(fs.readFileSync(CRON_STK_FILE, 'utf8')).fecha || ''; } catch { return ''; }
}
function _marcarStickerCronHoy() {
  try {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    fs.mkdirSync(path.dirname(CRON_STK_FILE), { recursive: true });
    fs.writeFileSync(CRON_STK_FILE, JSON.stringify({ fecha: hoy }));
  } catch (e) { console.error('[cron-stk marca]', e.message); }
}
async function cronStickerReprocesar() {
  try {
    const hora = _huelaPMBogota();
    if (hora !== 22) return; // 10 PM Bogotá
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (_ultimoStickerCronDia() === hoy) return;

    const STICKERS_VENTA = (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620,363cba4bcedd7e2dbe2f73a8dcb7ef6cd4208815a606cbd99f735d52c1b0f995').split(',').map(s => s.trim());
    const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 3').all().map(r => r.fecha);
    let recuperados = 0;
    for (const fecha of fechas) {
      const events = db.leerEvolutionEvents(fecha);
      for (const ev of events) {
        const ed = ev.data || ev;
        if (ed?.messageType !== 'stickerMessage') continue;
        const stk = ed.message?.stickerMessage || {};
        const hash = stk.fileSha256 ? Buffer.from(Object.values(stk.fileSha256)).toString('hex') : '';
        if (!STICKERS_VENTA.includes(hash)) continue;
        if (ed.key?.fromMe !== true) continue;
        const remoteJid = ed.key?.remoteJid || '';
        const tel = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        if (tel.length < 6) continue;
        const pedidosActuales = leerPedidos();
        const yaProcesado = pedidosActuales.some(p =>
          String(p.telefono || '').replace(/\D/g, '') === tel && p.stickerVenta === hash
        );
        if (yaProcesado) continue;
        const instance = ev.instance || '?';
        const vendedora = vendedoraDeInstancia(instance);
        let nombre;
        try {
          const resuelto = await resolverCliente(remoteJid, tel, ed.pushName || '');
          nombre = resuelto.nombre || `Cliente +57 ${tel.slice(-10)}`;
        } catch { nombre = `Cliente +57 ${tel.slice(-10)}`; }
        const r = crearVentaInterna('pedido', vendedora, tel, null, nombre);
        if (r.ok && r.id && !r.duplicado) {
          const todos = leerPedidos();
          const pd = todos.find(x => x.id === r.id);
          if (pd) {
            pd.estado = 'hacer-diseno';
            pd.tipoBandeja = 'pedido';
            pd.stickerVenta = hash;
            pd.fechaVenta = fecha;
            pd.notas = pd.notas || `Recuperado por cron diario desde sticker del ${fecha}`;
            pd.ultimoMovimiento = new Date().toISOString();
            pd.historial = pd.historial || [];
            pd.historial.push({
              fecha: new Date().toISOString(),
              por: 'cron-sticker-reprocesador',
              accion: 'crear-desde-sticker-historico',
              nota: `Sticker venta de ${vendedora} del ${fecha} (cron)`,
            });
            guardarPedidos(todos, leerNextId());
            recuperados++;
          }
        }
      }
    }
    if (recuperados > 0) {
      const msg = `🛡️ *Red de seguridad sticker*\n\nRecuperé ${recuperados} venta${recuperados!==1?'s':''} que se había${recuperados!==1?'n':''} perdido en los últimos 3 días.`;
      try { await notificarTelegramAdmin(msg); } catch {}
      console.log(`[cron-stk] recuperados ${recuperados} pedidos perdidos`);
    } else {
      console.log('[cron-stk] OK — no hay stickers perdidos');
    }
    _marcarStickerCronHoy();
  } catch (e) { console.error('[cron-stk error]', e.message); }
}
setInterval(cronStickerReprocesar, 60 * 1000);
setTimeout(cronStickerReprocesar, 90 * 1000);
console.log('[cron-stk] activado — reprocesador sticker diario 10 PM Bogotá');

// ═══════════════════════════════════════════════════════════════════
// ALERTAS CALANDRA +24h SIN DESCARGAR
// Cuando un pedido lleva +24h en estado 'enviado-calandra' sin que
// calandra haya descargado el WT, avisa al diseñador responsable y
// al grupo W&S Admin. Una vez por pedido por día para no spamear.
// ═══════════════════════════════════════════════════════════════════
const ALERTAS_CAL_FILE = path.join(__dirname, 'data', 'alertas_calandra_enviadas.json');
function _leerAlertasCalandraEnv() {
  try { return JSON.parse(fs.readFileSync(ALERTAS_CAL_FILE, 'utf8')); }
  catch { return {}; }
}
function _guardarAlertasCalandraEnv(obj) {
  try {
    fs.mkdirSync(path.dirname(ALERTAS_CAL_FILE), { recursive: true });
    fs.writeFileSync(ALERTAS_CAL_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('[alertas-cal] guardar:', e.message); }
}

function detectarPedidosCalandraSinDescargar() {
  const pedidos = leerPedidos();
  const ahora = Date.now();
  const candidatos = [];
  for (const p of pedidos) {
    if (p.estado !== 'enviado-calandra') continue;
    const archivos = (p.wetransfer && p.wetransfer.archivos) || [];
    // Filtrar archivos originales enviados pero NO descargados
    const sinDescargar = archivos.filter(a =>
      (!a.tipo || a.tipo === 'original') && a.fechaEnvio && !a.fechaDescarga
    );
    if (!sinDescargar.length) {
      // Si NO hay archivos WT registrados aún pero ya está en enviado-calandra,
      // usar ultimoMovimiento como referencia (fallback).
      if (!archivos.length && p.ultimoMovimiento) {
        const horas = (ahora - new Date(p.ultimoMovimiento).getTime()) / 36e5;
        if (horas >= 24) {
          candidatos.push({
            id: p.id,
            cliente: p.cliente || p.equipo || 'Sin nombre',
            disenador: p.disenadorAsignado || null,
            fechaEnvio: p.ultimoMovimiento,
            horasSinDescarga: Math.round(horas),
            archivo: null,
            fuente: 'ultimoMovimiento',
          });
        }
      }
      continue;
    }
    // Tomar el archivo más viejo sin descarga
    const masViejo = sinDescargar.slice().sort((a, b) =>
      new Date(a.fechaEnvio).getTime() - new Date(b.fechaEnvio).getTime()
    )[0];
    const horas = (ahora - new Date(masViejo.fechaEnvio).getTime()) / 36e5;
    if (horas >= 24) {
      candidatos.push({
        id: p.id,
        cliente: p.cliente || p.equipo || 'Sin nombre',
        disenador: p.disenadorAsignado || null,
        fechaEnvio: masViejo.fechaEnvio,
        horasSinDescarga: Math.round(horas),
        archivo: masViejo.nombreOriginal || null,
        fuente: 'wetransfer',
      });
    }
  }
  return candidatos;
}

async function enviarAlertasCalandraSinDescargar() {
  const candidatos = detectarPedidosCalandraSinDescargar();
  if (!candidatos.length) {
    console.log('[alertas-cal] sin pedidos atrasados en calandra');
    return { enviados: 0, candidatos: [] };
  }
  const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  const enviadasPrev = _leerAlertasCalandraEnv();
  const aEnviar = candidatos.filter(c => enviadasPrev[c.id] !== hoyBogota);
  if (!aEnviar.length) {
    console.log(`[alertas-cal] ${candidatos.length} candidatos pero todos ya avisados hoy`);
    return { enviados: 0, candidatos };
  }
  // Agrupar por diseñador
  const porDis = {};
  for (const c of aEnviar) {
    const k = c.disenador || 'SIN_ASIGNAR';
    if (!porDis[k]) porDis[k] = [];
    porDis[k].push(c);
  }
  // WA personal a cada diseñador
  for (const [dis, lista] of Object.entries(porDis)) {
    if (dis === 'SIN_ASIGNAR') continue; // no notif individual sin asignar
    const lineas = lista.map(c =>
      `• *#${c.id} ${c.cliente}* — enviado hace ${c.horasSinDescarga}h${c.archivo ? ' (' + c.archivo + ')' : ''}`
    ).join('\n');
    const texto = `⚠️ *Pedidos en calandra +24h sin descargar*\n\n${lineas}\n\n👉 Si calandra no responde, contáctalos o reenvía el WT.`;
    try {
      const ok = await notificarWAPersona(dis, texto);
      if (ok) console.log(`[alertas-cal] WA enviado a ${dis} (${lista.length} pedidos)`);
    } catch (e) { console.error('[alertas-cal wa]', e.message); }
  }
  // TG al grupo W&S Admin (consolidado para visibilidad)
  const lineasAdmin = aEnviar.map(c =>
    `• *#${c.id} ${c.cliente}* (${c.disenador || 'sin asignar'}) — ${c.horasSinDescarga}h`
  ).join('\n');
  const tgTexto = `⚠️ *CALANDRA +24h SIN DESCARGAR* (${aEnviar.length} pedidos)\n\n${lineasAdmin}\n\n_Diseñadores ya recibieron WA individual._`;
  try { await notificarTelegramAdmin(tgTexto); } catch (e) { console.error('[alertas-cal tg]', e.message); }
  // Marcar como enviadas hoy
  for (const c of aEnviar) enviadasPrev[c.id] = hoyBogota;
  _guardarAlertasCalandraEnv(enviadasPrev);
  return { enviados: aEnviar.length, candidatos };
}

// Cron — corre cada hora durante horario laboral (8 AM a 7 PM Bogotá)
async function cronAlertasCalandraTick() {
  try {
    const hora = _huelaPMBogota();
    if (hora < 8 || hora >= 19) return;
    await enviarAlertasCalandraSinDescargar();
  } catch (e) { console.error('[cron-alertas-cal err]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronAlertasCalandraTick, 60 * 60 * 1000);
// setTimeout(cronAlertasCalandraTick, 90 * 1000);
console.log('[cron-alertas-cal] activado — chequea calandra +24h cada hora 8AM-7PM');

// ═══════════════════════════════════════════════════════════════════
// CRON GRUPO VENTAS N/W/P — cada 2 minutos
// Lee mensajes nuevos del grupo, identifica pedidos por hash matching
// (foto enviada al cliente == foto del grupo), amarra nombre/fecha/lista
// con Gemini. Detecta arreglos de Lidermeyer/Lidemeyer.
// Cutoff temporal: solo procesa mensajes posteriores al ultimo procesado
// (state.ultimoTs). Empieza con cutoff = arranque del servidor para NO
// procesar historico.
// ═══════════════════════════════════════════════════════════════════
let _cronVentasEjecutando = false;
async function cronGrupoVentasTick() {
  if (_cronVentasEjecutando) return; // evitar overlap
  _cronVentasEjecutando = true;
  try {
    const r = await grupoVentasWatcher.procesarYAmarrar({
      db,
      diasAtras: 1,
      conImagen: true,
      notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
      notificarJefes: typeof notificarJefes === 'function' ? notificarJefes : null,
      registrarArreglo: null, // TODO: conectar formato arreglos
    });
    if (r && (r.amarrados || r.arreglos)) {
      console.log(`[cron-ventas] amarrados=${r.amarrados || 0} arreglos=${r.arreglos || 0} sinMatch=${r.sinMatch || 0}`);
    }
  } catch (e) {
    console.error('[cron-ventas err]', e.message);
  } finally {
    _cronVentasEjecutando = false;
  }
}
// Inicializar state.ultimoTs al arranque para NO procesar historico
try {
  const s = grupoVentasWatcher.leerState();
  if (!s.ultimoTs) {
    s.ultimoTs = Date.now();
    grupoVentasWatcher.guardarState(s);
    console.log('[cron-ventas] state.ultimoTs inicializado a ahora — no procesa historico');
  }
} catch (e) { console.error('[cron-ventas state init]', e.message); }
setInterval(cronGrupoVentasTick, 2 * 60 * 1000); // cada 2 min
setTimeout(cronGrupoVentasTick, 60 * 1000); // primer tick 60s tras arrancar
console.log('[cron-ventas] activado — lee grupo Ventas N/W/P cada 2 min');

// ═══════════════════════════════════════════════════════════════════
// CRON CATALOGO — cada 10 minutos
// Lee Drive folder CATALOGO recursivo, hashea fotos nuevas y cruza con
// docs_salientes_wa para identificar al cliente. El nombre del archivo
// = nombre del pedido. Solo actua sobre fotos modificadas DESPUES de
// la activacion del cron (cutoff temporal).
// ═══════════════════════════════════════════════════════════════════
let _cronCatalogoEjecutando = false;
async function cronCatalogoTick() {
  if (_cronCatalogoEjecutando) return;
  _cronCatalogoEjecutando = true;
  try {
    const r = await catalogoFotosWatcher.procesarYAmarrar({
      db,
      notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
      notificarJefes: typeof notificarJefes === 'function' ? notificarJefes : null,
    });
    if (r && (r.amarrados || (r.procesados && r.procesados > 0))) {
      console.log(`[cron-catalogo] procesados=${r.procesados || 0} amarrados=${r.amarrados || 0} sinHashMatch=${r.sinHashMatch || 0}`);
    }
  } catch (e) {
    console.error('[cron-catalogo err]', e.message);
  } finally {
    _cronCatalogoEjecutando = false;
  }
}
setInterval(cronCatalogoTick, 10 * 60 * 1000); // cada 10 min
setTimeout(cronCatalogoTick, 120 * 1000); // primer tick 120s tras arrancar
console.log('[cron-catalogo] activado — lee Drive CATALOGO cada 10 min (cutoff al arranque)');

// ═══════════════════════════════════════════════════════════════════
// CRON VERIFICAR APROBACIONES PENDIENTES — cada 1 min
// Procesa data/pending-approvals.json. Para cada pending con verificarEn<=now:
//  1. Burst check (>1 img vendedora en 10 min = opciones)
//  2. Cliente mando imagen <5 min antes (iteracion)
//  3. Keywords negativas vendedora ±5 min ("o la otra", "asi?", "lo ideal", "gracias por su compra")
//  4. Cliente ya respondio positivo despues ("ok", "dale", "listo", "🙏")
//  5. Gemini estricto (confianza=alta + tipo=diseno-uniforme)
// Si pasa todo -> manda encuesta poll.
// ═══════════════════════════════════════════════════════════════════
const KEYWORDS_NEGATIVAS_APROBACION = [
  'o la otra', 'o esta otra', 'asi?', 'así?', 'lo ideal',
  'cual te gusta', 'cuál te gusta', 'te paso varias', 'te paso unas opciones',
  'mira cual', 'mira cuál', 'que tal queda mejor', 'qué tal queda mejor',
  'y cual hacemos', 'y cuál hacemos', 'gracias por su compra',
  'te paso opciones', 'mira esta idea', 'te pase varias',
  'mira para que veas', 'mira esta otra', 'cambios',
];
const RESPUESTAS_CLIENTE_POSITIVAS = [
  'ok', 'dale', 'listo', 'perfecto', '🙏', '👍', 'me gusta',
  'esta bien', 'está bien', 'aprobado', 'apruebo', 'va', 'chevere',
  'chévere', 'bacano', 'genial', 'excelente',
];
let _cronVerifAprobEjecutando = false;
async function cronVerificarAprobacionesPendientesTick() {
  if (_cronVerifAprobEjecutando) return;
  _cronVerifAprobEjecutando = true;
  try {
    const pendings = leerPendingApprovals();
    const ahora = Date.now();
    let cambios = false;
    for (const p of pendings) {
      if (p.estado !== 'esperando') continue;
      if (new Date(p.verificarEn).getTime() > ahora) continue;
      try {
        const peds = leerPedidos();
        const pedido = peds.find(x => x.id === p.pedidoId);
        if (!pedido) { p.estado = 'cancelado'; p.motivo = 'pedido no existe'; cambios = true; continue; }
        if (!['hacer-diseno', 'bandeja'].includes(pedido.estado)) {
          p.estado = 'cancelado'; p.motivo = `pedido ya esta en ${pedido.estado}`; cambios = true; continue;
        }
        // 1. Anti-duplicado: ya hay encuesta activa en 24h
        const mapping = leerPollsMapping();
        const hace24h = ahora - 24 * 60 * 60 * 1000;
        if (mapping.find(m => m.pedidoId === p.pedidoId && new Date(m.ts).getTime() > hace24h)) {
          p.estado = 'cancelado'; p.motivo = 'ya hay encuesta activa'; cambios = true; continue;
        }
        // 2. Burst check
        const tsImg = new Date(p.imageTs).getTime();
        const burst = pendings.filter(x =>
          x.pedidoId === p.pedidoId &&
          Math.abs(new Date(x.imageTs).getTime() - tsImg) < 10 * 60 * 1000
        );
        if (burst.length > 1) {
          burst.forEach(x => { if (x.estado === 'esperando') { x.estado = 'cancelado'; x.motivo = `burst de ${burst.length} imgs en 10 min = opciones`; } });
          cambios = true;
          console.log(`[verif-aprob] cancelando burst de ${burst.length} imgs pedido #${p.pedidoId}`);
          continue;
        }
        // 3. Leer mensajes Chatwoot
        if (!pedido.telefono) { p.estado = 'cancelado'; p.motivo = 'pedido sin tel'; cambios = true; continue; }
        const contacto = await buscarContactoChatwoot(pedido.telefono);
        if (!contacto?.id) { p.estado = 'cancelado'; p.motivo = 'sin contacto chatwoot'; cambios = true; continue; }
        const cwUrl = process.env.CHATWOOT_URL;
        const accountId = process.env.CHATWOOT_ACCOUNT_ID;
        const cwKey = process.env.CHATWOOT_API_KEY;
        const rConv = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts/${contacto.id}/conversations`, {
          headers: { 'api_access_token': cwKey },
        });
        const dataConv = await rConv.json();
        const conv = (dataConv.payload || [])[0];
        if (!conv?.id) { p.estado = 'cancelado'; p.motivo = 'sin conversacion'; cambios = true; continue; }
        const rMsg = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations/${conv.id}/messages`, {
          headers: { 'api_access_token': cwKey },
        });
        const dataMsg = await rMsg.json();
        const todos = ((dataMsg.payload || dataMsg || [])).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        const tsImgSec = Math.floor(tsImg / 1000);
        const ventanaAntes = todos.filter(m => m.created_at >= tsImgSec - 600 && m.created_at < tsImgSec);
        const ventanaDespues = todos.filter(m => m.created_at >= tsImgSec && m.created_at <= tsImgSec + 5 * 60);
        // 4. Cliente mando imagen <5 min antes
        const clienteMandoImg = ventanaAntes.some(m =>
          m.message_type === 0 &&
          (m.attachments || []).some(a => a.file_type === 'image')
        );
        if (clienteMandoImg) {
          p.estado = 'cancelado'; p.motivo = 'cliente mando img antes (iteracion)'; cambios = true; continue;
        }
        // 5. Keyword negativa vendedora ventana ±5 min
        const textosVend = [...ventanaAntes, ...ventanaDespues]
          .filter(m => m.message_type === 1 && m.content)
          .map(m => String(m.content).toLowerCase());
        let kwNegHit = null;
        for (const t of textosVend) {
          const found = KEYWORDS_NEGATIVAS_APROBACION.find(k => t.includes(k));
          if (found) { kwNegHit = found; break; }
        }
        if (kwNegHit) {
          p.estado = 'cancelado'; p.motivo = `keyword negativa: "${kwNegHit}"`; cambios = true; continue;
        }
        // 6. Cliente ya respondio positivo
        const respCliente = ventanaDespues
          .filter(m => m.message_type === 0 && m.content)
          .some(m => {
            const t = String(m.content).toLowerCase().trim().replace(/[.!¡¿?]+$/, '');
            return RESPUESTAS_CLIENTE_POSITIVAS.some(r => t === r || t.startsWith(r + ' ') || t.includes(r));
          });
        if (respCliente) {
          p.estado = 'cancelado'; p.motivo = 'cliente ya aprobo por texto'; cambios = true; continue;
        }
        // 7. Gemini estricto
        const img = await descargarImagenEvolution(p.instance, p.imageMsgKey);
        if (!img || !img.base64) { p.estado = 'cancelado'; p.motivo = 'no se pudo descargar imagen'; cambios = true; continue; }
        const clasif = await clasificarImagenConGemini(img.base64, img.mimeType);
        if (!clasif || clasif.tipo !== 'diseno-uniforme' || clasif.confianza !== 'alta') {
          p.estado = 'cancelado'; p.motivo = `Gemini: tipo=${clasif?.tipo} conf=${clasif?.confianza}`; cambios = true; continue;
        }
        // ─── MANDAR ENCUESTA ───
        const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
        const evoKey = process.env.EVOLUTION_API_KEY || '3506974711';
        const nombre = pedido.nombreDiseno || pedido.equipo || 'tu uniforme';
        const pollBody = JSON.stringify({
          number: p.telCliente,
          name: `Sobre el diseno de ${nombre}, como lo ves?`,
          selectableCount: 1,
          values: ['Apruebo el diseno', 'Quiero cambiar algo'],
        });
        const rEnv = await fetch(`${evoUrl}/message/sendPoll/${encodeURIComponent(p.instance)}`, {
          method: 'POST',
          headers: { apikey: evoKey, 'Content-Type': 'application/json' },
          body: pollBody,
        });
        if (!rEnv.ok) { p.estado = 'fallido'; p.motivo = `sendPoll ${rEnv.status}`; cambios = true; continue; }
        const pollResp = await rEnv.json();
        const pollMsgId = pollResp.key?.id;
        if (!pollMsgId) { p.estado = 'fallido'; p.motivo = 'sin msgId'; cambios = true; continue; }
        mapping.push({
          pollMsgId,
          pedidoId: pedido.id,
          telCliente: p.telCliente,
          vendedora: p.vendedora,
          instance: p.instance,
          imageMsgKey: p.imageMsgKey,
          ts: new Date(ahora).toISOString(),
        });
        if (mapping.length > 200) mapping.splice(0, mapping.length - 200);
        guardarPollsMapping(mapping);
        pedido.historial = pedido.historial || [];
        pedido.historial.push({
          fecha: new Date(ahora).toISOString(),
          por: 'auto-aprobacion-bot',
          accion: 'poll-aprobacion-enviado',
          nota: `Encuesta enviada tras filtros (5min delay). Gemini conf=${clasif.confianza}`,
        });
        guardarPedidos(peds, leerNextId());
        p.estado = 'mandado';
        p.pollMsgId = pollMsgId;
        p.mandadoEn = new Date(ahora).toISOString();
        cambios = true;
        console.log(`[verif-aprob] ENCUESTA enviada -> #${pedido.id} (${p.vendedora}) tel=${p.telCliente}`);
      } catch (eP) {
        console.error('[verif-aprob item err]', eP.message);
        p.estado = 'fallido';
        p.motivo = 'error: ' + eP.message.slice(0, 100);
        cambios = true;
      }
    }
    if (cambios) guardarPendingApprovals(pendings);
  } catch (e) {
    console.error('[verif-aprob tick err]', e.message);
  } finally {
    _cronVerifAprobEjecutando = false;
  }
}
setInterval(cronVerificarAprobacionesPendientesTick, 20 * 1000); // cada 20 seg (encuesta rapida)
setTimeout(cronVerificarAprobacionesPendientesTick, 15 * 1000); // primer tick a los 15s
console.log('[verif-aprob] activado — verifica aprobaciones pendientes cada 20 seg con filtros anti-falso-positivo');

// ═══════════════════════════════════════════════════════════════════
// CRON LECTOR DE CHATS — cada 15 min
// Por cada pedido sin nombre real (equipoVieneDeBot=true), lee los
// chats vendedora ↔ cliente, transcribe audios con Gemini y extrae
// el nombre del equipo. Aplica si confianza alta.
// ═══════════════════════════════════════════════════════════════════
let _cronChatsEjecutando = false;
async function cronChatsTick() {
  if (_cronChatsEjecutando) return;
  _cronChatsEjecutando = true;
  try {
    const r = await chatReader.procesarYAmarrarChats({
      db,
      limitePedidos: 30,
      notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
    });
    if (r && (r.amarrados || r.errores)) {
      console.log(`[cron-chats] procesados=${r.procesados || 0} amarrados=${r.amarrados || 0} sinNombre=${r.sinNombre || 0} errores=${r.errores || 0}`);
    }
  } catch (e) {
    console.error('[cron-chats err]', e.message);
  } finally {
    _cronChatsEjecutando = false;
  }
}
setInterval(cronChatsTick, 15 * 60 * 1000); // cada 15 min
setTimeout(cronChatsTick, 180 * 1000); // primer tick 180s tras arrancar
console.log('[cron-chats] activado — lee chats vendedora-cliente cada 15 min (Gemini + audios)');

// ═══════════════════════════════════════════════════════════════════
// CRON GRUPO TRABAJO EN FAMILIA — cada 5 minutos
// Lee mensajes del grupo, parsea con Gemini, detecta avances tipo
// "almany fc cortado", "real awaliba listo", etc, y avanza el estado
// del pedido. Ignora mensajes del propio bot.
// Cutoff temporal: state.ultimoTs al arranque del servidor.
// ═══════════════════════════════════════════════════════════════════
let _cronTrabajoEjecutando = false;
async function cronGrupoTrabajoTick() {
  if (_cronTrabajoEjecutando) return;
  _cronTrabajoEjecutando = true;
  try {
    const r = await grupoTrabajoFamiliaWatcher.procesarYAvanzar({
      db,
      diasAtras: 1,
      notificarWAVendedora: typeof notificarWAVendedora === 'function' ? notificarWAVendedora : null,
      notificarJefes: typeof notificarJefes === 'function' ? notificarJefes : null,
    });
    if (r && (r.avanzados || r.errores)) {
      console.log(`[cron-trabajo] procesados=${r.procesados || 0} avanzados=${r.avanzados || 0} sinMatch=${r.sinMatch || 0} ignorados=${r.ignorados || 0}`);
    }
  } catch (e) {
    console.error('[cron-trabajo err]', e.message);
  } finally {
    _cronTrabajoEjecutando = false;
  }
}
// Inicializar state.ultimoTs al arranque para NO procesar historico
try {
  const s = grupoTrabajoFamiliaWatcher.leerState();
  if (!s.ultimoTs) {
    s.ultimoTs = Date.now();
    grupoTrabajoFamiliaWatcher.guardarState(s);
    console.log('[cron-trabajo] state.ultimoTs inicializado a ahora — no procesa historico');
  }
} catch (e) { console.error('[cron-trabajo state init]', e.message); }
setInterval(cronGrupoTrabajoTick, 5 * 60 * 1000); // cada 5 min
setTimeout(cronGrupoTrabajoTick, 240 * 1000); // primer tick 240s tras arrancar
console.log('[cron-trabajo] activado — lee grupo Trabajo en familia cada 5 min');

// ═══════════════════════════════════════════════════════════════════
// ALERTAS COSTURA — costurera marcó "entregué" +48h y Lidermeyer no recibió
// Cron horario 8AM-7PM Bogotá. Avisa a Lidermeyer + admin.
// ═══════════════════════════════════════════════════════════════════
const ALERTAS_COSTU_FILE = path.join(__dirname, 'data', 'alertas_costura_entrega.json');
function _leerAlertasCostu() {
  try { return JSON.parse(fs.readFileSync(ALERTAS_COSTU_FILE, 'utf8')); } catch { return {}; }
}
function _guardarAlertasCostu(obj) {
  try { fs.mkdirSync(path.dirname(ALERTAS_COSTU_FILE), { recursive: true }); fs.writeFileSync(ALERTAS_COSTU_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

async function cronAlertasCosturaEntregaTick() {
  try {
    const hora = _huelaPMBogota();
    if (hora < 8 || hora >= 19) return;
    const pendientes = db.leerMovimientosCosturaPendientes();
    const ahora = Date.now();
    const pendientesEntrega = pendientes.filter(m => {
      if (m.confirmado_costurera != 1) return false;
      if (m.cantidad_recibida != null) return false;
      if (!m.fecha_confirmacion) return false;
      const horas = (ahora - new Date(m.fecha_confirmacion).getTime()) / 36e5;
      return horas >= 48;
    });
    if (!pendientesEntrega.length) return;
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    const enviadasPrev = _leerAlertasCostu();
    const aEnviar = pendientesEntrega.filter(m => enviadasPrev[m.id] !== hoyBogota);
    if (!aEnviar.length) return;
    // Una sola notif consolidada a Lidermeyer + grupo Admin
    const lineas = aEnviar.map(m => {
      const horas = Math.round((ahora - new Date(m.fecha_confirmacion).getTime()) / 36e5);
      return `• #${m.id} ${m.costurera_nombre}: ${m.cantidad_enviada} prendas (${m.equipo}) — marcó hace ${horas}h`;
    }).join('\n');
    const texto = `⚠️ *Lotes terminados sin recibir físicamente*\n\n${lineas}\n\n👉 Revisa si las costureras los trajeron o llamá a verificar.`;
    try { await notificarWAPersona('Lidermeyer', texto); } catch (e) {}
    try { await notificarTelegramAdmin(texto); } catch (e) {}
    for (const m of aEnviar) enviadasPrev[m.id] = hoyBogota;
    _guardarAlertasCostu(enviadasPrev);
    console.log(`[alertas-costu-entrega] notif sobre ${aEnviar.length} lotes`);
  } catch (e) { console.error('[cron-alertas-costu-entrega err]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronAlertasCosturaEntregaTick, 60 * 60 * 1000);
// setTimeout(cronAlertasCosturaEntregaTick, 120 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON DETECTAR APROBACION DEL CLIENTE EN CHATWOOT (Gemini)
// Cada 10 min, lee chats de pedidos en hacer-diseno con disenoIniciado
// y le pregunta a Gemini si el cliente aprobo el diseno o pidio cambios.
// Si aprobado con confianza alta -> avanza pedido a "confirmado" + WA.
// Si cambios -> alerta a vendedora.
// ═══════════════════════════════════════════════════════════════════
let _cronAprobacionEnCurso = false;
const APROBACION_STATE_FILE = path.join(__dirname, 'data', 'cron-aprobacion-state.json');
function _leerAprobacionState() {
  try { return JSON.parse(fs.readFileSync(APROBACION_STATE_FILE, 'utf8')); }
  catch { return { ultimoChequeoPorPedido: {} }; }
}
function _guardarAprobacionState(s) {
  fs.mkdirSync(path.dirname(APROBACION_STATE_FILE), { recursive: true });
  fs.writeFileSync(APROBACION_STATE_FILE, JSON.stringify(s, null, 2));
}

async function cronDetectarAprobacionChatwootTick() {
  if (_cronAprobacionEnCurso) return;
  if (!process.env.CHATWOOT_URL || !process.env.GEMINI_API_KEY) return;
  _cronAprobacionEnCurso = true;
  try {
    const state = _leerAprobacionState();
    const ahora = Date.now();
    const pedidos = leerPedidos();
    // Solo pedidos en hacer-diseno con SEÑAL de que ya hubo diseno (drive vinculado o archivosAlias)
    const candidatos = pedidos.filter(p => {
      if (p.estado !== 'hacer-diseno') return false;
      if (!p.telefono) return false;
      const tieneDiseno = (p.disenoIniciado === true)
        || (Array.isArray(p.archivosAlias) && p.archivosAlias.length > 0)
        || (p.drive && p.drive.corel);
      if (!tieneDiseno) return false;
      // No chequear el mismo pedido mas de 1 vez por hora (mas frecuente si esta listo para aprobacion)
      const ventanaMs = p.disenoListoParaAprobacion ? 20 * 60 * 1000 : 60 * 60 * 1000;
      const ult = state.ultimoChequeoPorPedido?.[p.id] || 0;
      return (ahora - ult) > ventanaMs;
    })
    // Priorizar los que tienen export visual (mas probable que cliente este respondiendo)
    .sort((a, b) => (b.disenoListoParaAprobacion ? 1 : 0) - (a.disenoListoParaAprobacion ? 1 : 0))
    .slice(0, 5);

    if (!candidatos.length) {
      console.log('[cron-aprobacion] sin candidatos');
      return;
    }

    let aplicados = 0;
    for (const p of candidatos) {
      try {
        const chat = await obtenerChatwootChatPorTelefono(p.telefono, 30);
        state.ultimoChequeoPorPedido = state.ultimoChequeoPorPedido || {};
        state.ultimoChequeoPorPedido[p.id] = ahora;
        if (!chat || !chat.messages?.length) continue;
        // Convertir mensajes a texto plano
        const texto = chat.messages.map(m => {
          const quien = m.sender_type === 'Contact' ? 'Cliente' : 'Vendedora';
          return `${quien}: ${m.content.slice(0, 400)}`;
        }).join('\n');
        const analisis = await analizarChatAprobacionConGemini(texto, p.equipo);
        if (!analisis) continue;
        console.log(`[cron-aprobacion] pedido #${p.id} ${p.equipo}: ${analisis.estado} (${analisis.confianza}) "${(analisis.cita||'').slice(0,80)}"`);
        if (analisis.estado === 'aprobado' && (analisis.confianza === 'alta' || analisis.confianza === 'media')) {
          // Avanzar pedido a confirmado
          p.estado = 'confirmado';
          p.fechaAprobacionCliente = new Date().toISOString();
          p.aprobacionFuente = 'gemini-chatwoot';
          p.aprobacionCita = (analisis.cita || '').slice(0, 300);
          p.ultimoMovimiento = new Date().toISOString();
          p.historial = p.historial || [];
          p.historial.push({
            fecha: new Date().toISOString(),
            por: 'gemini-chatwoot',
            accion: 'cliente-aprobo',
            nota: `Detectado por Gemini con confianza ${analisis.confianza}. Cita: "${(analisis.cita||'').slice(0,200)}"`,
          });
          aplicados++;
          // WA a vendedora
          try {
            const msgV = `✅ *Diseno aprobado por cliente*\n\n` +
              `Pedido: *${p.equipo}* (#${p.id})\n` +
              `Cliente: ${p.pushNameCliente || p.telefono}\n\n` +
              `Detecté en Chatwoot que el cliente aprobó:\n` +
              `_"${(analisis.cita||'').slice(0,180)}"_\n\n` +
              `Marqué el pedido como *confirmado*. Listo para mandar a calandra.\n\n` +
              `Si me equivoqué, escribi *equipo ${p.id} ${p.equipo}* para revertir.`;
            await notificarWAVendedora(p.vendedora, msgV);
          } catch (eW) { console.error('[cron-aprobacion wa-vend]', eW.message); }
        } else if (analisis.estado === 'cambios' && analisis.confianza === 'alta') {
          // No avanzo el pedido pero alerto si no avise antes
          if (!p.alertaCambiosClienteEnviada) {
            p.alertaCambiosClienteEnviada = new Date().toISOString();
            try {
              const msgV = `🔁 *Cliente pidio cambios en el diseno*\n\n` +
                `Pedido: *${p.equipo}* (#${p.id})\n` +
                `Cliente: ${p.pushNameCliente || p.telefono}\n\n` +
                `Detecté en Chatwoot:\n_"${(analisis.cita||'').slice(0,180)}"_`;
              await notificarWAVendedora(p.vendedora, msgV);
            } catch (eW) { console.error('[cron-aprobacion wa-camb]', eW.message); }
          }
        }
        // pequeño delay entre llamadas Gemini para evitar throttling
        await new Promise(r => setTimeout(r, 800));
      } catch (eP) {
        console.error(`[cron-aprobacion] error pedido #${p.id}:`, eP.message);
      }
    }
    if (aplicados > 0) guardarPedidos(pedidos, leerNextId());
    _guardarAprobacionState(state);
    console.log(`[cron-aprobacion] ${candidatos.length} revisados, ${aplicados} avanzaron a confirmado`);
  } catch (e) {
    console.error('[cron-aprobacion error]', e.message);
  } finally {
    _cronAprobacionEnCurso = false;
  }
}
// DESACTIVADO 11-jun-2026 - se reactiva cuando confirmemos cero spam
// setInterval(cronDetectarAprobacionChatwootTick, 10 * 60 * 1000);
// setTimeout(cronDetectarAprobacionChatwootTick, 3 * 60 * 1000);
console.log('[cron-aprobacion] DESACTIVADO temporalmente — solo via POST /api/admin/forzar-cron-aprobacion');

// ═══════════════════════════════════════════════════════════════════
// CRON ALERTA: pedidos en hacer-diseno SIN movimiento +7 dias
// 1 vez por dia (8 AM Bogota), avisa a vendedora "tu pedido X lleva
// abandonado X dias, contactá al cliente o archivalo"
// ═══════════════════════════════════════════════════════════════════
const ABANDONADOS_STATE_FILE = path.join(__dirname, 'data', 'alertas-abandonados-enviadas.json');
function _leerAbandonadosState() {
  try { return JSON.parse(fs.readFileSync(ABANDONADOS_STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function _guardarAbandonadosState(s) {
  fs.mkdirSync(path.dirname(ABANDONADOS_STATE_FILE), { recursive: true });
  fs.writeFileSync(ABANDONADOS_STATE_FILE, JSON.stringify(s, null, 2));
}

async function cronAlertaAbandonadosTick() {
  const horaBogota = new Date().toLocaleTimeString('es-CO', { hour12: false, timeZone: 'America/Bogota' });
  const hora = parseInt(horaBogota.slice(0,2), 10);
  // Solo correr entre 8 AM y 9 AM (1 vez al dia)
  if (hora !== 8) return;
  const hoy = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  const state = _leerAbandonadosState();
  if (state.fechaUltimoRun === hoy) return; // ya corrimos hoy

  try {
    const pedidos = leerPedidos();
    const ahora = Date.now();
    const _7DIAS = 7 * 24 * 60 * 60 * 1000;
    const candidatos = pedidos.filter(p => {
      if (p.estado !== 'hacer-diseno') return false;
      const ult = new Date(p.ultimoMovimiento || p.fechaVenta || 0).getTime();
      if (!ult) return false;
      return (ahora - ult) > _7DIAS;
    });

    if (candidatos.length === 0) {
      state.fechaUltimoRun = hoy;
      _guardarAbandonadosState(state);
      console.log('[cron-abandonados] sin pedidos abandonados');
      return;
    }

    // Agrupar por vendedora
    const porVend = {};
    for (const p of candidatos) {
      const v = p.vendedora || 'sin-vendedora';
      if (!porVend[v]) porVend[v] = [];
      porVend[v].push(p);
    }

    for (const [vend, peds] of Object.entries(porVend)) {
      const lineas = peds.slice(0, 10).map(p => {
        const ult = new Date(p.ultimoMovimiento || p.fechaVenta || 0);
        const dias = Math.round((ahora - ult.getTime()) / (24 * 60 * 60 * 1000));
        return `• #${p.id} ${p.equipo || p.pushNameCliente || p.telefono} (${dias}d sin mov)`;
      }).join('\n');
      const msg = `⏰ *Pedidos abandonados +7 dias*\n\n${lineas}\n\n👉 Contacta al cliente para cerrar o archivalo si ya no quieren.`;
      try {
        await notificarWAVendedora(vend, msg);
      } catch (e) { console.error(`[cron-abandonados WA-${vend}]`, e.message); }
    }
    state.fechaUltimoRun = hoy;
    state.ultimoConteo = candidatos.length;
    _guardarAbandonadosState(state);
    console.log(`[cron-abandonados] ${candidatos.length} pedidos abandonados notificados a ${Object.keys(porVend).length} vendedoras`);
  } catch (e) {
    console.error('[cron-abandonados err]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronAlertaAbandonadosTick, 60 * 60 * 1000);
// setTimeout(cronAlertaAbandonadosTick, 2 * 60 * 1000);
console.log('[cron-abandonados] activado — corre 1 vez al dia (8 AM Bogota)');

// ═══════════════════════════════════════════════════════════════════
// CRON RESOLVEDOR AUTOMATICO DE ATASCOS — corre cada 30 min
// Para cada pedido en hacer-diseno:
//   1. Lee Chatwoot del cliente
//   2. Calcula dias desde ultimo mensaje REAL
//   3. Clasifica y RESUELVE automatico:
//      - cliente aprobo → avanza pedido
//      - +14 dias sin actividad → archiva
//      - cliente pidio cambios y vendedora no respondio +24h → WA empujon
//      - pago sin diseno +3 dias → WA empujon vendedora-disenadora
// ═══════════════════════════════════════════════════════════════════
let _cronResolverEnCurso = false;
const RESOLVER_STATE_FILE = path.join(__dirname, 'data', 'cron-resolver-state.json');
function _leerResolverState() {
  try { return JSON.parse(fs.readFileSync(RESOLVER_STATE_FILE, 'utf8')); }
  catch { return { ultimaAccionPorPedido: {} }; }
}
function _guardarResolverState(s) {
  fs.mkdirSync(path.dirname(RESOLVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(RESOLVER_STATE_FILE, JSON.stringify(s, null, 2));
}

async function cronResolverAtascosTick() {
  if (_cronResolverEnCurso) return;
  if (!process.env.CHATWOOT_URL) return;
  _cronResolverEnCurso = true;
  try {
    const state = _leerResolverState();
    state.ultimaAccionPorPedido = state.ultimaAccionPorPedido || {};
    const ahora = Date.now();
    const pedidos = leerPedidos();
    const enHacerDiseno = pedidos.filter(p => p.estado === 'hacer-diseno' && p.telefono);
    let cambios = 0;
    let avanzados = 0;
    let archivados = 0;
    let empujonesVend = 0;

    for (const p of enHacerDiseno) {
      try {
        // Anti-spam: no tocar el mismo pedido mas de 1 vez cada 4h
        const ultAccion = state.ultimaAccionPorPedido[p.id] || 0;
        if ((ahora - ultAccion) < 4 * 60 * 60 * 1000) continue;

        const chat = await obtenerChatwootChatPorTelefono(p.telefono, 30);
        if (!chat || !chat.messages?.length) {
          // Sin Chatwoot → no toco (es caso manual)
          continue;
        }
        const ultimoMsg = chat.messages[chat.messages.length - 1];
        // Chatwoot devuelve created_at como timestamp UNIX EN SEGUNDOS (no ms)
        // ej. 1779904080 = 2026-06-09. Hay que multiplicar por 1000.
        let ultimoTs = ahora;
        if (ultimoMsg.created_at) {
          const raw = typeof ultimoMsg.created_at === 'number'
            ? ultimoMsg.created_at
            : (parseInt(ultimoMsg.created_at, 10) || Date.parse(ultimoMsg.created_at) / 1000);
          // Si esta en segundos (< year 2100 in ms = 4102444800000), multiplicar
          ultimoTs = raw < 1e12 ? raw * 1000 : raw;
        }
        const diasSinActividad = Math.floor((ahora - ultimoTs) / (24 * 60 * 60 * 1000));
        const ultimoFueDelCliente = ultimoMsg.sender_type === 'Contact';

        // ─── REGLA 1 DESACTIVADA: NO archivar nada automaticamente
        // (decidido 11-jun-2026: usuario no quiere archivar, quiere solucionar)
        // Si +14 dias sin actividad, solo registrar pero NO cambiar estado.

        // ─── ANALISIS FLUJO COMPLETO (sin importar si tiene disenoIniciado) ───
        // Construir texto del chat marcando imagenes con [IMG]
        const texto = chat.messages.map(m => {
          const quien = m.sender_type === 'Contact' ? 'Cliente' : 'Vendedora';
          const hayImg = (m.attachments || []).some(a => a.file_type === 'image');
          const marcaImg = hayImg ? ' [IMG]' : '';
          return `${quien}${marcaImg}: ${(m.content || '').slice(0, 400)}`;
        }).join('\n');
        const analisis = await analizarChatAprobacionConGemini(texto, p.equipo);
        if (!analisis) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        // ── ENTREGADO: cliente recibio prendas y agradecio ──
        if (analisis.estado === 'entregado' && (analisis.confianza === 'alta' || analisis.confianza === 'media')) {
          p.estado = 'enviado-final';
          p.fechaEntregaCliente = new Date().toISOString();
          p.aprobacionFuente = 'cron-resolver-flujo';
          p.aprobacionCita = (analisis.cita || '').slice(0, 300);
          p.ultimoMovimiento = new Date().toISOString();
          p.historial = p.historial || [];
          p.historial.push({
            fecha: new Date().toISOString(),
            por: 'cron-resolver-flujo',
            accion: 'entregado-detectado',
            nota: `Cliente agradecio recibir. Razonamiento: ${analisis.razonamiento || ''}. Cita: "${(analisis.cita||'').slice(0,150)}"`,
          });
          state.ultimaAccionPorPedido[p.id] = ahora;
          avanzados++;
          cambios++;
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        // ── APROBADO: cliente no pidio mas cambios despues de ultima imagen ──
        if (analisis.estado === 'aprobado' && analisis.confianza === 'alta') {
          // Solo avanzar a confirmado si pedido tiene alguna senal de diseno (imagen en chat o archivosAlias)
          const huboImagenVendedora = chat.messages.some(m =>
            m.sender_type !== 'Contact' && (m.attachments || []).some(a => a.file_type === 'image')
          );
          const tieneDiseno = p.disenoIniciado || (Array.isArray(p.archivosAlias) && p.archivosAlias.length > 0) || (p.drive && p.drive.corel) || huboImagenVendedora;
          if (tieneDiseno) {
            p.estado = 'confirmado';
            p.fechaAprobacionCliente = new Date().toISOString();
            p.aprobacionFuente = 'cron-resolver-flujo';
            p.aprobacionCita = (analisis.cita || '').slice(0, 300);
            p.ultimoMovimiento = new Date().toISOString();
            p.historial = p.historial || [];
            p.historial.push({
              fecha: new Date().toISOString(),
              por: 'cron-resolver-flujo',
              accion: 'avanzar-por-aprobacion',
              nota: `Razonamiento: ${analisis.razonamiento || ''}. Cita: "${(analisis.cita||'').slice(0,150)}"`,
            });
            state.ultimaAccionPorPedido[p.id] = ahora;
            avanzados++;
            cambios++;
          }
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        // ── CAMBIOS / ESPERANDO / SIN-IMAGEN / NO-DETECTADO: NO TOCAR ──
        // El sistema queda silencioso. Sin WA spam. La info pendiente
        // ya va en el resumen matutino consolidado existente.
        await new Promise(r => setTimeout(r, 500));
      } catch (eP) {
        console.error(`[cron-resolver #${p.id}]`, eP.message);
      }
    }

    if (cambios > 0) guardarPedidos(pedidos, leerNextId());
    _guardarResolverState(state);
    console.log(`[cron-resolver] revisados=${enHacerDiseno.length} avanzados=${avanzados} archivados=${archivados} empujones=${empujonesVend}`);
  } catch (e) {
    console.error('[cron-resolver err]', e.message);
  } finally {
    _cronResolverEnCurso = false;
  }
}
// DESACTIVADO 11-jun-2026 - causaba spam y archivado por error
// setInterval(cronResolverAtascosTick, 30 * 60 * 1000);
// setTimeout(cronResolverAtascosTick, 4 * 60 * 1000);
console.log('[cron-resolver] DESACTIVADO temporalmente — solo via POST /api/admin/forzar-resolver-atascos');

// ═══════════════════════════════════════════════════════════════════
// CRON Gmail/WeTransfer — cada 5 minutos sincroniza correos WT con pedidos
// ═══════════════════════════════════════════════════════════════════
let _wtSyncEnCurso = false;
async function cronWeTransferTick() {
  if (_wtSyncEnCurso) return;
  if (!gmailWT.estaConectado()) return; // silencioso si no está conectado
  _wtSyncEnCurso = true;
  try {
    const pedidos = db.leerPedidos();
    const resultado = await gmailWT.sincronizarConPedidos(pedidos);
    const aplicados = [];
    for (const u of resultado.updates) {
      const p = pedidos.find(x => x.id === u.pedidoId);
      if (!p) continue;
      p.wetransfer = u.wetransfer;
      if (u.accion === 'enviado' && u.archivo.tipo === 'original' &&
          ['hacer-diseno', 'confirmado'].includes(p.estado)) {
        p.estado = 'enviado-calandra';
        p.ultimoMovimiento = new Date().toISOString();
        p.historial = p.historial || [];
        p.historial.push({
          fecha: new Date().toISOString(),
          por: 'gmail-bot',
          accion: 'avanzar',
          de: p.estado === 'enviado-calandra' ? 'hacer-diseno' : p.estado,
          a: 'enviado-calandra',
          nota: `Auto-detectado por WeTransfer: ${u.archivo.nombreOriginal}`,
        });
      }
      aplicados.push({ id: p.id, equipo: p.equipo, accion: u.accion, archivo: u.archivo.nombreOriginal });

      // ─── NOTIF WA al diseñador cuando calandra DESCARGA su archivo ───
      // (la descarga es señal de que calandra ya lo recibió e iniciará impresión)
      if (u.accion === 'descargado' && p.disenadorAsignado) {
        const msg = `✅ *Calandra descargó tu archivo*\n\n` +
          `Pedido #${p.id} — ${p.equipo || p.telefono || 'Sin equipo'}\n` +
          `Archivo: ${u.archivo.nombreOriginal}\n` +
          (u.archivo.m2 ? `Metros: ${u.archivo.m2} m²\n` : '') +
          `\nCalandra ya lo recibió, debería llegar al taller en 1-2 días.`;
        notificarWAPersona(p.disenadorAsignado, msg).catch(()=>{});
      }
    }
    if (aplicados.length) {
      db.guardarPedidos(pedidos);
      const msg = `📤 *WT auto-vinculado* (${aplicados.length})\n\n` +
        aplicados.slice(0, 10).map(a => `• #${a.id} ${a.equipo}: ${a.archivo} (${a.accion})`).join('\n');
      notificarTelegramDuvan(msg).catch(()=>{});
      console.log('[cron-wt] aplicados', aplicados.length, 'updates');
    }
    if (resultado.huerfanos.length) {
      console.log('[cron-wt] huérfanos:', resultado.huerfanos.map(h => h.archivo.nombreOriginal));
    }
  } catch (e) {
    console.error('[cron-wt error]', e.message);
  } finally {
    _wtSyncEnCurso = false;
  }
}
// Cada 5 minutos
setInterval(cronWeTransferTick, 5 * 60 * 1000);
// Tick inicial 60s después de arrancar
setTimeout(cronWeTransferTick, 60 * 1000);
console.log('[cron-wt] activado — sincronizará WeTransfer cada 5 minutos');

// ═══════════════════════════════════════════════════════════════════
// CRON Drive — cada 10 min lee carpetas corel + PDF RIP y vincula a pedidos
// ═══════════════════════════════════════════════════════════════════
let _driveSyncEnCurso = false;
async function cronDriveTick() {
  if (_driveSyncEnCurso) return;
  const conectado = gmailWT.estaConectado();
  console.log(`[cron-drive] estaConectado=${conectado}`);
  if (!conectado) {
    console.log('[cron-drive] ABORT: Drive NO conectado (gmailWT.estaConectado=false)');
    return;
  }
  _driveSyncEnCurso = true;
  try {
    const pedidos = db.leerPedidos();
    const resultado = await driveSync.sincronizarConPedidos(pedidos);
    console.log(`[cron-drive] sync resultado: updates=${resultado.updates.length} huerfanos=${resultado.huerfanos.length} totalCorel=${resultado.totales?.corel} totalPdfRip=${resultado.totales?.pdfRip}`);
    if (resultado.huerfanos.length > 0) {
      console.log('[cron-drive] huerfanos (10 primeros):', resultado.huerfanos.slice(0, 10).map(h => h.archivo).join(' | '));
    }
    const aplicados = [];
    let cambios = false;
    for (const u of resultado.updates) {
      const p = pedidos.find(x => x.id === u.pedidoId);
      if (!p) continue;
      p.drive = p.drive || {};
      const corelChanged = u.corel && (!p.drive.corel || p.drive.corel.id !== u.corel.id);
      const pdfChanged = u.pdfRip && (!p.drive.pdfRip || p.drive.pdfRip.id !== u.pdfRip.id);
      if (u.corel) p.drive.corel = u.corel;
      if (u.pdfRip) p.drive.pdfRip = u.pdfRip;
      if (u.disenadorSugerido && !p.disenadorAsignado) {
        p.disenadorAsignado = u.disenadorSugerido;
        cambios = true;
      }
      if (u.corel && p.estado === 'bandeja' && corelChanged) {
        p.estado = 'hacer-diseno';
        p.ultimoMovimiento = new Date().toISOString();
        cambios = true;
        aplicados.push({ id: p.id, equipo: p.equipo, accion: 'avance-a-hacer-diseno', archivo: u.corel.nombre });
      }
      if (corelChanged || pdfChanged) cambios = true;
    }
    if (cambios) {
      db.guardarPedidos(pedidos);
      if (aplicados.length) {
        const msg = `📂 *Drive auto-vinculado* (${aplicados.length})\n\n` +
          aplicados.slice(0, 10).map(a => `• #${a.id} ${a.equipo}: ${a.archivo} → ${a.accion}`).join('\n');
        notificarTelegramDuvan(msg).catch(()=>{});
      }
      console.log('[cron-drive] aplicados', aplicados.length, 'avances de estado');
    }
  } catch (e) {
    console.error('[cron-drive error]', e.message);
  } finally {
    _driveSyncEnCurso = false;
  }
}
// Cada 10 minutos
setInterval(cronDriveTick, 10 * 60 * 1000);
// Tick inicial 90s después de arrancar (después del WT)
setTimeout(cronDriveTick, 90 * 1000);
console.log('[cron-drive] activado — sincronizará Drive cada 10 minutos');

// ═══════════════════════════════════════════════════════════════════
// CRON Recordatorio sticker — cada 15 min revisa comprobantes >90min sin sticker
// ═══════════════════════════════════════════════════════════════════
async function cronRecordatorioStickerTick() {
  try {
    const comprobantes = db.leerComprobantes();
    const ahora = Date.now();
    const NOVENTA_MIN = 90 * 60 * 1000;
    const cambios = [];
    for (const c of comprobantes) {
      if (c.stickerEnviado) continue;
      if (c.recordatorio90Enviado) continue;
      const ts = new Date(c.ts).getTime();
      if (isNaN(ts)) continue;
      if ((ahora - ts) < NOVENTA_MIN) continue;
      // Solo en horario laboral 8 AM - 8 PM Bogotá
      const horaBogota = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
      if (horaBogota < 8 || horaBogota > 19) continue;
      // Mandar recordatorio con CONTADOR DEL DIA
      try {
        const monto = c.monto ? `$${Number(c.monto).toLocaleString('es-CO')}` : '';
        const banco = c.banco && c.banco !== 'desconocido' ? c.banco : '';
        const cliente = c.cliente || c.telefono || 'cliente';
        const pedidoTxt = c.pedidoAutoCreado ? ` (pedido #${c.pedidoAutoCreado})` : '';
        const r = resumenDiaVendedora(c.vendedora);
        const msg = `⏰ *Recordatorio: falta sticker*\n\n` +
          `Hace +90 min detectamos pago ${monto} ${banco} de *${cliente}*${pedidoTxt}.\n\n` +
          `📊 *TU DIA HASTA AHORA:*\n` +
          `✅ ${r.conSticker} con sticker\n` +
          `⚠️ ${r.sinSticker} SIN sticker\n` +
          `💰 Detectado: ${_formatearMontoCOP(r.totalMonto)}\n\n` +
          `👉 Pon el sticker venta 💰 en el chat para oficializar.`;
        await notificarWAVendedora(c.vendedora, msg);
        cambios.push(c.messageId || c.ts);
        c.recordatorio90Enviado = true;
        c.recordatorio90Fecha = new Date().toISOString();
        db.upsertComprobante(c);
        console.log(`[cron-90min] recordatorio enviado a ${c.vendedora} por ${cliente}`);
      } catch (eMsg) {
        console.error('[cron-90min msg]', eMsg.message);
      }
    }
    if (cambios.length) {
      console.log(`[cron-90min] ${cambios.length} recordatorios enviados`);
    }
  } catch (e) {
    console.error('[cron-90min error]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronRecordatorioStickerTick, 15 * 60 * 1000);
// setTimeout(cronRecordatorioStickerTick, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON Recordatorio FACTURA — cada 1h chequea pedidos creados >24h
// sin factura asociada y avisa a la vendedora por WA personal.
// Solo en horario laboral 8 AM - 7 PM Bogotá. Marca flag para no
// repetir. Si pasaron +72h, ya no insiste (lo retoma el resumen 8 PM).
// ═══════════════════════════════════════════════════════════════════
// MIGRACION ARRANQUE: marca todos los pedidos EXISTENTES como recordatorio enviado
// para no spamear vendedoras con pedidos viejos (Camilo 2-jun-2026).
// Solo se ejecuta UNA vez (controlado por flag en data/config.json).
function migrarMarcarRecordatorioFacturaPedidosExistentes() {
  try {
    const cfg = db.leerConfig() || {};
    if (cfg.migracion_recordatorio_factura_v1) return;
    const pedidos = db.leerPedidos();
    let marcados = 0;
    for (const p of pedidos) {
      if (!p.recordatorioFacturaEnviado) {
        p.recordatorioFacturaEnviado = true;
        p.recordatorioFacturaFecha = 'migracion-2026-06-02';
        marcados++;
      }
    }
    if (marcados > 0) db.guardarPedidos(pedidos);
    cfg.migracion_recordatorio_factura_v1 = true;
    cfg.migracion_recordatorio_factura_v1_ts = new Date().toISOString();
    cfg.migracion_recordatorio_factura_v1_marcados = marcados;
    db.guardarConfig(cfg);
    console.log(`[migracion-factura-v1] ${marcados} pedidos marcados como recordatorio enviado (one-shot)`);
  } catch (e) {
    console.error('[migracion-factura-v1] error:', e.message);
  }
}
// Ejecutar al arrancar (después de 3s para no chocar con otros inits)
setTimeout(migrarMarcarRecordatorioFacturaPedidosExistentes, 3000);

async function cronRecordatorioFacturaTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog < 8 || horaBog > 19) return;

    const pedidos = db.leerPedidos();
    const ahora = Date.now();
    const _24H = 24 * 60 * 60 * 1000;
    const _72H = 72 * 60 * 60 * 1000;
    const ESTADOS_CERRADOS = new Set(['enviado-final', 'archivado', 'cancelado']);
    let recordatorios = 0;

    for (const p of pedidos) {
      if (p.recordatorioFacturaEnviado) continue;
      if (ESTADOS_CERRADOS.has(p.estado)) continue;
      // Fecha de creación: primero creadoEn (es-CO), sino ultimoMovimiento como fallback
      let ts = 0;
      if (p.creadoEn) {
        // creadoEn = "2/06/2026" formato es-CO
        const parts = String(p.creadoEn).split('/');
        if (parts.length === 3) {
          const dt = new Date(parseInt(parts[2],10), parseInt(parts[1],10)-1, parseInt(parts[0],10));
          ts = dt.getTime();
        }
      }
      if (!ts && p.ultimoMovimiento) ts = new Date(p.ultimoMovimiento).getTime();
      if (!ts || isNaN(ts)) continue;
      const edad = ahora - ts;
      if (edad < _24H || edad > _72H) continue;

      // ¿Ya tiene factura?
      try {
        const facts = db.leerFacturasPorPedido(p.id) || [];
        if (facts.length > 0) {
          // Si ya hay factura, marca flag y sigue
          p.recordatorioFacturaEnviado = true;
          continue;
        }
      } catch (eF) { console.error('[cron-fact] leerFacturasPorPedido', eF.message); continue; }

      // Mandar recordatorio a la vendedora (corto, 1 sola vez)
      try {
        const equipoTxt = p.equipo || p.cliente || `Pedido #${p.id}`;
        const totalTxt = p.total ? ` (${_formatearMontoCOP(p.total)})` : '';
        const msg = `🧾 Falta factura del pedido *${equipoTxt}*${totalTxt} (+24h sin emitirse).`;
        await notificarWAVendedora(p.vendedora, msg);
        p.recordatorioFacturaEnviado = true;
        p.recordatorioFacturaFecha = new Date().toISOString();
        recordatorios++;
        console.log(`[cron-fact] recordatorio enviado a ${p.vendedora} por pedido #${p.id} (${equipoTxt})`);
      } catch (eMsg) {
        console.error('[cron-fact msg]', eMsg.message);
      }
    }

    if (recordatorios > 0) {
      db.guardarPedidos(pedidos);
      console.log(`[cron-fact] ${recordatorios} recordatorios de factura enviados`);
    }
  } catch (e) {
    console.error('[cron-fact error]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronRecordatorioFacturaTick, 60 * 60 * 1000);
// setTimeout(cronRecordatorioFacturaTick, 5 * 60 * 1000);
console.log('[cron-fact] activado — recordatorios factura cada 1h');

// ═══════════════════════════════════════════════════════════════════
// CRON Resumen ATASCOS diario 10 AM Bogota
// Envia 1 mensaje agregado a Camilo + Graciela con todos los pedidos
// atascados (sin disenio +5d, sin aprobar +5d, calandra +24h, etc).
// Evita 10 alertas separadas — todo junto.
// Cutoff de fecha: solo pedidos creados desde el deploy en adelante
// (para no spamear con historial viejo).
// ═══════════════════════════════════════════════════════════════════
const CRON_ATASCOS_CUTOFF_TS = new Date('2026-06-03T18:00:00.000Z').getTime();
async function cronResumenAtascosTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog !== 10) return; // solo a las 10 AM
    // Dedupe diario
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (!waPuedeEnviar(`atascos-diario:${hoy}`)) return;

    const pedidos = db.leerPedidos();
    const ahora = Date.now();
    const _24H = 24 * 60 * 60 * 1000;
    const _5D = 5 * _24H;
    const _7D = 7 * _24H;

    const atSinDisenio = [];      // confirmado +5 dias sin .cdr
    const atSinAprobar = [];      // hacer-diseno +5 dias
    const atCalandraSinDesc = []; // enviado-calandra +24h
    const atSinEntregar = [];     // listo +7d

    for (const p of pedidos) {
      // Cutoff: solo pedidos recientes
      let tsCreacion = 0;
      if (p.creadoEn) {
        const parts = String(p.creadoEn).split('/');
        if (parts.length === 3) tsCreacion = new Date(parseInt(parts[2],10), parseInt(parts[1],10)-1, parseInt(parts[0],10)).getTime();
      }
      if (!tsCreacion && p.ultimoMovimiento) tsCreacion = new Date(p.ultimoMovimiento).getTime();
      if (tsCreacion && tsCreacion < CRON_ATASCOS_CUTOFF_TS) continue;

      const tsUlt = new Date(p.ultimoMovimiento || 0).getTime();
      const edad = ahora - tsUlt;
      const equipoTxt = p.equipo || p.cliente || `#${p.id}`;
      const ven = p.vendedora || '?';

      if (p.estado === 'hacer-diseno' && edad > _5D) atSinAprobar.push({ id: p.id, equipoTxt, ven });
      if (p.estado === 'enviado-calandra' && edad > _24H && !p.wtDescargado) atCalandraSinDesc.push({ id: p.id, equipoTxt, ven });
      if (p.estado === 'listo' && edad > _7D) atSinEntregar.push({ id: p.id, equipoTxt, ven });
    }

    const total = atSinDisenio.length + atSinAprobar.length + atCalandraSinDesc.length + atSinEntregar.length;
    if (total === 0) {
      console.log('[cron-atascos] sin atascos hoy');
      return;
    }

    const lineas = [`🚨 *ATASCOS HOY* — ${total} pedido(s) requieren atención\n`];
    if (atSinAprobar.length) {
      lineas.push(`🎨 *Sin aprobación cliente +5 días* (${atSinAprobar.length})`);
      for (const a of atSinAprobar.slice(0, 8)) lineas.push(`  • ${a.equipoTxt} (#${a.id}) — ${a.ven}`);
      if (atSinAprobar.length > 8) lineas.push(`  + ${atSinAprobar.length - 8} más…`);
      lineas.push('');
    }
    if (atCalandraSinDesc.length) {
      lineas.push(`📨 *Calandra +24h sin descargar* (${atCalandraSinDesc.length})`);
      for (const a of atCalandraSinDesc.slice(0, 8)) lineas.push(`  • ${a.equipoTxt} (#${a.id}) — ${a.ven}`);
      if (atCalandraSinDesc.length > 8) lineas.push(`  + ${atCalandraSinDesc.length - 8} más…`);
      lineas.push('');
    }
    if (atSinEntregar.length) {
      lineas.push(`📦 *Listo +7 días sin entregar* (${atSinEntregar.length})`);
      for (const a of atSinEntregar.slice(0, 8)) lineas.push(`  • ${a.equipoTxt} (#${a.id}) — ${a.ven}`);
      if (atSinEntregar.length > 8) lineas.push(`  + ${atSinEntregar.length - 8} más…`);
      lineas.push('');
    }
    const msg = lineas.join('\n');
    await notificarWAPersona('camilo', msg);
    await notificarWAPersona('graciela', msg);
    console.log(`[cron-atascos] enviado resumen con ${total} atascos`);
  } catch (e) {
    console.error('[cron-atascos error]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronResumenAtascosTick, 60 * 60 * 1000);
// setTimeout(cronResumenAtascosTick, 10 * 60 * 1000);
console.log('[cron-atascos] activado — resumen 10 AM Bogota');

// ═══════════════════════════════════════════════════════════════════
// CRON Detector de instancias ZOMBI cada 30 min
// Antecedente: ws-ney quedo "open" (mentirosa) pero desconectada desde
// el 9-mayo. Perdimos 28 dias de ventas. NUNCA MAS.
// Detecta 2 tipos de problema:
//   1. connectionStatus != 'open' (caida clara, esperando QR)
//   2. status='open' PERO sin eventos webhook hace +6h (zombi silencioso)
// Dedupe por instancia+dia para no spamear.
// ═══════════════════════════════════════════════════════════════════
const INSTANCIAS_VIGILADAS = ['ws-ventas', 'ws-ney', 'ws wendy', 'ws-paola', 'ws-duvan'];

function _ultimoEventoInstancia(instanceName) {
  // Busca en logs de hoy y ayer el ultimo evento de esa instancia
  const tz = 'America/Bogota';
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: tz });
  let maxTs = 0;
  for (const fecha of [hoy, ayer]) {
    try {
      const evs = db.leerEvolutionEvents(fecha) || [];
      for (const ev of evs) {
        const inst = ev?.instance || ev?.payload?.instance;
        if (inst !== instanceName) continue;
        const ts = ev?.data?.messageTimestamp
          ? ev.data.messageTimestamp * 1000
          : (ev?.date_time ? new Date(ev.date_time).getTime() : 0);
        if (ts > maxTs) maxTs = ts;
      }
    } catch (e) {}
  }
  return maxTs;
}

async function cronInstanciasZombiTick() {
  try {
    const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const KEY = process.env.EVOLUTION_API_KEY || '';
    if (!KEY) return;
    const host = process.env.RAILWAY_PUBLIC_DOMAIN || 'ws-app-interna-production.up.railway.app';
    const hoyISO = new Date().toISOString().slice(0, 10);
    const SEIS_HORAS = 6 * 60 * 60 * 1000;
    const ahora = Date.now();

    for (const name of INSTANCIAS_VIGILADAS) {
      try {
        const r = await fetch(`${EVO}/instance/fetchInstances?instanceName=${encodeURIComponent(name)}`, {
          headers: { apikey: KEY },
        });
        if (!r.ok) continue;
        const arr = await r.json();
        const inst = Array.isArray(arr) ? arr[0] : null;
        if (!inst) {
          // Instancia no existe
          const dedupeKey = `zombie:${name}:no-existe:${hoyISO}`;
          if (waPuedeEnviar(dedupeKey)) {
            const msg = `⚠️ *Instancia ${name} NO existe en Evolution*\n\n` +
              `Hay que crearla. Avisame para hacerlo.`;
            await notificarJefes(msg, { dedupeKey, soloJefe: true });
          }
          continue;
        }

        const status = inst.connectionStatus;
        const ultimoEv = _ultimoEventoInstancia(name);
        const sinEventosHace = ultimoEv ? (ahora - ultimoEv) : Infinity;

        // Caso 1: caida clara
        if (status !== 'open') {
          const dedupeKey = `zombie:${name}:caida:${hoyISO}`;
          if (waPuedeEnviar(dedupeKey)) {
            const msg = `🚨 *${name} DESCONECTADA*\n\n` +
              `Estado: ${status}\n` +
              `Telefono: ${inst.number || '?'} (${inst.profileName || '?'})\n` +
              `Ultima caida: ${inst.disconnectionAt || '?'}\n\n` +
              `👉 Para arreglar:\n` +
              `1. Abre https://${host}/api/admin/qr/${encodeURIComponent(name)}\n` +
              `2. La persona escanea el QR desde su WhatsApp\n` +
              `3. Esperar mensaje "conectado"`;
            await notificarJefes(msg, { dedupeKey, soloJefe: true });
            console.log(`[cron-zombi] ALERTA enviada: ${name} status=${status}`);
          }
          continue;
        }

        // Caso 2: zombi silencioso (open pero sin trafico)
        // Horario activo Bogota 7am-9pm — fuera de eso, NO alertamos por silencio
        const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
        const esHoraActiva = horaBog >= 7 && horaBog <= 21;
        if (esHoraActiva && sinEventosHace > SEIS_HORAS) {
          const dedupeKey = `zombie:${name}:silencioso:${hoyISO}`;
          if (waPuedeEnviar(dedupeKey)) {
            const horasSinEv = Math.round(sinEventosHace / (60 * 60 * 1000));
            const msg = `🟡 *${name} SOSPECHOSA (zombi silencioso)*\n\n` +
              `Evolution dice "open" pero no llegan eventos hace ${horasSinEv}h.\n` +
              `Telefono: ${inst.number || '?'} (${inst.profileName || '?'})\n\n` +
              `Posible causa: el dueño removio el dispositivo vinculado.\n\n` +
              `👉 Para diagnosticar:\n` +
              `1. Reinicia el servicio Evolution en Railway\n` +
              `2. Si despues sigue silenciosa, abre https://${host}/api/admin/qr/${encodeURIComponent(name)} y re-escanea`;
            await notificarJefes(msg, { dedupeKey, soloJefe: true });
            console.log(`[cron-zombi] ALERTA silenciosa: ${name} sinEventos=${horasSinEv}h`);
          }
        }
      } catch (eInst) {
        console.error(`[cron-zombi ${name}]`, eInst.message);
      }
    }
  } catch (e) {
    console.error('[cron-zombi]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronInstanciasZombiTick, 30 * 60 * 1000);
// setTimeout(cronInstanciasZombiTick, 3 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON #1 — CAZADOR DE DISENADORES ATRASADOS (cada 6h)
// Empuja a Oscar/Wendy/Ney/Paola que se les "pasa" hacer un diseno.
// Escalado 24h/48h/72h con WA distintos.
//   24h → WA suave al disenador
//   48h → WA mas firme + CC al jefe
//   72h → WA urgente al jefe + sugerencia reasignar
// Solo en horario activo (7am-9pm Bogota). Dedupe por pedido+nivel+dia.
// ═══════════════════════════════════════════════════════════════════
// Calcula la "edad real" del pedido en hacer-diseno: usa fechaVenta o
// creadoEn (que NO cambian con reparaciones), no ultimoMovimiento.
function _edadHacerDiseno(p) {
  let ts = 0;
  if (p.fechaVenta) {
    const d = new Date(p.fechaVenta);
    if (!isNaN(d.getTime())) ts = d.getTime();
  }
  if (!ts && p.creadoEn) {
    const parts = String(p.creadoEn).split('/');
    if (parts.length === 3) {
      const dt = new Date(parseInt(parts[2],10), parseInt(parts[1],10)-1, parseInt(parts[0],10));
      if (!isNaN(dt.getTime())) ts = dt.getTime();
    }
  }
  return ts ? (Date.now() - ts) : 0;
}

async function cronCazarDisenadoresTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog < 7 || horaBog > 21) return;

    const peds = leerPedidos();
    const _24H = 24 * 60 * 60 * 1000;
    const _48H = 48 * 60 * 60 * 1000;
    const _72H = 72 * 60 * 60 * 1000;
    const _7D = 7 * 24 * 60 * 60 * 1000;
    const hoyISO = new Date().toISOString().slice(0, 10);

    // Agrupa atrasados por disenador para mandar UN solo WA consolidado
    const porDis = {};
    let jefeUrgentes = [];

    for (const p of peds) {
      if (p.estado !== 'hacer-diseno') continue;
      if (!p.disenadorAsignado) continue;
      if (p.pdfDriveListo || p.wtListo) continue;
      const edad = _edadHacerDiseno(p);
      if (edad < _24H) continue;
      if (edad > _7D) continue; // pedidos +7 dias se manejan por archivar, no por cazador

      const nivel = edad >= _72H ? '72h' : edad >= _48H ? '48h' : '24h';
      const dis = p.disenadorAsignado;
      const dias = Math.floor(edad / (24 * 60 * 60 * 1000));
      if (!porDis[dis]) porDis[dis] = [];
      porDis[dis].push({ p, nivel, dias });
      if (nivel === '72h') jefeUrgentes.push({ p, dis, dias });
    }

    let avisados = 0;
    // Un solo WA por disenador con TODOS sus atrasados (anti-spam)
    for (const [dis, lista] of Object.entries(porDis)) {
      const dedupeKey = `cazar-dis-consolidado:${dis}:${hoyISO}`;
      if (!waPuedeEnviar(dedupeKey)) continue;
      const tiene72 = lista.some(x => x.nivel === '72h');
      const tiene48 = lista.some(x => x.nivel === '48h');
      const icono = tiene72 ? '🚨' : tiene48 ? '🔴' : '🎨';
      let msg = `${icono} Hola ${dis}, tienes *${lista.length} disenos pendientes*\n─────────────────────────────\n\n`;
      lista.sort((a,b) => b.dias - a.dias).forEach(({ p, dias }) => {
        const eq = p.equipo || p.pushNameCliente || `#${p.id}`;
        const urg = dias >= 3 ? '🚨' : dias >= 2 ? '🔴' : '⚠️';
        msg += `${urg} *#${p.id}* ${eq} — ${dias} dia${dias===1?'':'s'}\n   Vendedora: ${p.vendedora}\n\n`;
      });
      msg += `─────────────────────────────\n`;
      msg += `Por favor avisanos en que vas con cada uno:\n`;
      msg += `*1 #X* = ya empece\n*2 #X* = ya esta listo\n*3 #X* = necesito ayuda`;
      try {
        await notificarWAPersona((dis || '').toLowerCase(), msg);
        avisados++;
        console.log(`[cazar-dis] ${dis} -> ${lista.length} pedidos avisados`);
      } catch (eW) { console.error('[cazar-dis wa]', eW.message); }
    }
    // Un WA al jefe SOLO si hay urgentes 72h+
    if (jefeUrgentes.length) {
      const dedupeKeyJ = `cazar-dis-jefe:${hoyISO}`;
      if (waPuedeEnviar(dedupeKeyJ)) {
        let msg = `🚨 *URGENTE* — ${jefeUrgentes.length} disenos llevan +3 dias sin avanzar:\n─────────────────────────────\n\n`;
        jefeUrgentes.forEach(({ p, dis, dias }) => {
          const eq = p.equipo || p.pushNameCliente || `#${p.id}`;
          msg += `🚨 *#${p.id}* ${eq} — ${dis} (${dias}d) — vendedora ${p.vendedora}\n`;
        });
        msg += `\n👉 Considera reasignar o cancelar.`;
        try { await notificarJefes(msg, { dedupeKey: dedupeKeyJ, soloJefe: true }); } catch (e) {}
      }
    }
    if (avisados) console.log(`[cazar-dis] ${avisados} disenadores avisados, ${jefeUrgentes.length} urgentes al jefe`);
  } catch (e) { console.error('[cazar-dis]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronCazarDisenadoresTick, 6 * 60 * 60 * 1000);
// setTimeout(cronCazarDisenadoresTick, 8 * 60 * 1000);
console.log('[cazar-dis] activado — empuja disenadores atrasados cada 6h');

// ═══════════════════════════════════════════════════════════════════
// CRON #2 — AUDITOR DE ARREGLOS (cada 12h)
// Sigue arreglos abiertos (Lider Meyer en grupo Ventas reporta y queda
// flotando). Si lleva +24h sin "listo", WA al jefe con detalle.
// ═══════════════════════════════════════════════════════════════════
async function cronAuditarArreglosTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog < 7 || horaBog > 21) return;

    const arreglos = (typeof db.leerArreglos === 'function') ? db.leerArreglos() : [];
    if (!arreglos.length) return;
    const ahora = Date.now();
    const _24H = 24 * 60 * 60 * 1000;
    const _72H = 72 * 60 * 60 * 1000;
    const hoyISO = new Date().toISOString().slice(0, 10);

    const abiertos = arreglos.filter(a => {
      if (a.cerrado || a.estado === 'listo' || a.estado === 'entregado') return false;
      const tsCre = a.creadoEn ? new Date(a.creadoEn).getTime() : (a.ts ? new Date(a.ts).getTime() : 0);
      if (!tsCre) return false;
      return (ahora - tsCre) > _24H;
    });
    if (!abiertos.length) return;

    // Un solo WA al jefe con TODOS los abiertos
    const dedupeKey = `auditar-arreglos:${hoyISO}`;
    if (!waPuedeEnviar(dedupeKey)) return;

    let msg = `🔧 *Arreglos sin cerrar* (${abiertos.length})\n─────────────────────────────\n\n`;
    abiertos.slice(0, 15).forEach((a, i) => {
      const tsCre = a.creadoEn ? new Date(a.creadoEn).getTime() : new Date(a.ts || Date.now()).getTime();
      const dias = Math.floor((ahora - tsCre) / (24 * 60 * 60 * 1000));
      const urg = (ahora - tsCre) > _72H ? '🚨' : '⚠️';
      msg += `${urg} *${a.equipo || a.cliente || a.id || '?'}*\n`;
      msg += `   ${a.descripcion || a.detalle || '(sin descripcion)'}\n`;
      msg += `   Lleva ${dias} dia${dias===1?'':'s'} abierto\n\n`;
    });
    if (abiertos.length > 15) msg += `\n_+${abiertos.length - 15} mas..._\n`;
    msg += `\n👉 Cuando un arreglo este listo, marcalo en la app o pongan "arreglo X listo" en grupo Ventas.`;

    await notificarJefes(msg, { dedupeKey, soloJefe: true });
    console.log(`[auditar-arreglos] reporte enviado: ${abiertos.length} abiertos`);
  } catch (e) { console.error('[auditar-arreglos]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronAuditarArreglosTick, 12 * 60 * 60 * 1000);
// setTimeout(cronAuditarArreglosTick, 11 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON #3 — ALERTA CALANDRA +24H SIN DESCARGAR (cada 4h)
// Pedidos enviados a calandra (wtListo o estado enviado-calandra) que
// no avanzaron a llego-impresion en +24h: la calandra puede estar
// atrasada o algo se perdio. Alerta al jefe.
// ═══════════════════════════════════════════════════════════════════
async function cronAlertaCalandraTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog < 7 || horaBog > 21) return;

    const peds = leerPedidos();
    const ahora = Date.now();
    const _24H = 24 * 60 * 60 * 1000;
    const hoyISO = new Date().toISOString().slice(0, 10);
    const atrasados = [];

    for (const p of peds) {
      if (p.estado !== 'enviado-calandra') continue;
      const ts = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
      if (!ts) continue;
      if ((ahora - ts) < _24H) continue;
      atrasados.push({ p, horas: Math.floor((ahora - ts) / (60 * 60 * 1000)) });
    }
    if (!atrasados.length) return;

    const dedupeKey = `alerta-calandra:${hoyISO}`;
    if (!waPuedeEnviar(dedupeKey)) return;

    let msg = `🟠 *Calandra atrasada* (${atrasados.length} pedidos)\n─────────────────────────────\n\n`;
    atrasados.slice(0, 12).forEach(({ p, horas }) => {
      const eq = p.equipo || p.pushNameCliente || `#${p.id}`;
      msg += `⏱️ *#${p.id}* ${eq} — ${horas}h sin moverse\n   Vendedora: ${p.vendedora}\n\n`;
    });
    if (atrasados.length > 12) msg += `\n_+${atrasados.length - 12} mas..._\n`;
    msg += `\n👉 Revisar con calandra si llegaron los archivos o pasaron algo.`;

    await notificarJefes(msg, { dedupeKey, soloJefe: true });
    console.log(`[alerta-calandra] ${atrasados.length} pedidos atrasados reportados`);
  } catch (e) { console.error('[alerta-calandra]', e.message); }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronAlertaCalandraTick, 4 * 60 * 60 * 1000);
// setTimeout(cronAlertaCalandraTick, 9 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// CRON #4 — DETECTOR DE APROBACION DEL CLIENTE (cada 8h)
// Lee los ultimos mensajes del cliente para pedidos en hacer-diseno
// con +12h. Detecta keywords de aprobacion ("perfecto/listo/aprobado")
// o de rechazo ("cambia/no me gusta"). Si detecta aprobacion + ya hay
// algun archivo → avanza a confirmado; sin archivo → marca flag y WA
// vendedora. Si rechazo → WA vendedora para revisar con cliente.
// (Heuristica por keywords — en futuro se puede mejorar con Gemini)
// ═══════════════════════════════════════════════════════════════════
const KW_APROBACION = [
  'perfecto','aprobado','aprobada','listo asi','me encanta','me encantan',
  'me gusta','quedo bien','quedo bueno','asi esta bien','dale','ok asi',
  'queremos asi','si me gusta','si me gustan','aprobamos','asi mismo','si esta bien'
];
const KW_RECHAZO = [
  'cambia','cambien','modifica','modifiquen','arregla','no me gusta',
  'no me gustan','no asi','otra vez','de nuevo','rehacer','volverlo a',
  'el color no','el escudo no','no esta bien','cambiar'
];

async function _ultimosMsjClienteEvolution(telefonoCliente, instance, limit = 15) {
  try {
    const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const KEY = process.env.EVOLUTION_API_KEY || '';
    if (!KEY) return [];
    const r = await fetch(`${EVO}/chat/findMessages/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY },
      body: JSON.stringify({
        where: { key: { remoteJid: `${telefonoCliente}@s.whatsapp.net` } },
        limit,
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const arr = Array.isArray(data?.messages?.records) ? data.messages.records : (Array.isArray(data) ? data : []);
    return arr;
  } catch (e) { return []; }
}

function _textoMensaje(m) {
  return (m?.message?.conversation
    || m?.message?.extendedTextMessage?.text
    || m?.message?.imageMessage?.caption
    || '').toLowerCase();
}

async function cronDetectarAprobacionTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog < 7 || horaBog > 21) return;

    const peds = leerPedidos();
    const ahora = Date.now();
    const _12H = 12 * 60 * 60 * 1000;
    const hoyISO = new Date().toISOString().slice(0, 10);
    let aprobados = 0, rechazos = 0;

    for (const p of peds) {
      if (p.estado !== 'hacer-diseno') continue;
      if (p.clienteAprobo === true) continue; // ya detectado
      if (!p.telefono) continue;
      const ts = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
      if (!ts || (ahora - ts) < _12H) continue;

      const instance = instanciaParaVendedora(p.vendedora) || 'ws-ventas';
      const msjs = await _ultimosMsjClienteEvolution(String(p.telefono).replace(/\D/g, ''), instance, 15);
      // Solo mensajes DEL cliente (fromMe=false)
      const delCliente = msjs.filter(m => m?.key?.fromMe === false);
      if (!delCliente.length) continue;
      const textos = delCliente.map(_textoMensaje).filter(Boolean);
      if (!textos.length) continue;

      const todoTexto = textos.join(' | ');
      const tieneAprobacion = KW_APROBACION.some(k => todoTexto.includes(k));
      const tieneRechazo = KW_RECHAZO.some(k => todoTexto.includes(k));

      if (tieneRechazo && !tieneAprobacion) {
        const dedupeKey = `cliente-rechaza:${p.id}:${hoyISO}`;
        if (!waPuedeEnviar(dedupeKey)) continue;
        rechazos++;
        const eq = p.equipo || p.pushNameCliente || `#${p.id}`;
        const msgV = `⚠️ Cliente del *#${p.id} ${eq}* pidio cambios al diseno.\n\n` +
          `Frase detectada: _"${textos.find(t => KW_RECHAZO.some(k => t.includes(k))) || ''}"_\n\n` +
          `Por favor revisa el chat y haz los cambios.`;
        try { await notificarWAPersona((p.vendedora || '').toLowerCase(), msgV); } catch (e) {}
        console.log(`[detectar-aprobacion] RECHAZO #${p.id} (${eq})`);
        continue;
      }

      if (tieneAprobacion) {
        const dedupeKey = `cliente-aprueba:${p.id}:${hoyISO}`;
        if (!waPuedeEnviar(dedupeKey)) continue;
        p.clienteAprobo = true;
        p.fechaAprobacionCliente = new Date().toISOString();
        p.ultimoMovimiento = new Date().toISOString();
        aprobados++;
        const eq = p.equipo || p.pushNameCliente || `#${p.id}`;
        const frase = textos.find(t => KW_APROBACION.some(k => t.includes(k))) || '';
        const msgV = `✅ Cliente del *#${p.id} ${eq}* aprobo el diseno.\n\n` +
          `Frase detectada: _"${frase}"_\n\n` +
          `👉 Ya podes avanzar el pedido (guarda .cdr en Drive corel y manda WT a calandra).`;
        try { await notificarWAPersona((p.vendedora || '').toLowerCase(), msgV); } catch (e) {}
        console.log(`[detectar-aprobacion] APROBADO #${p.id} (${eq})`);
      }
    }

    if (aprobados || rechazos) {
      guardarPedidos(peds, leerNextId());
      console.log(`[detectar-aprobacion] aprobados=${aprobados} rechazos=${rechazos}`);
    }
  } catch (e) { console.error('[detectar-aprobacion]', e.message); }
}
// ── DESACTIVADO 2026-06-13 — redundante con cron silencioso (que NO manda WA)
// Antes mandaba WA a vendedora cada 8h con "cliente aprobo" / "cliente pidio cambios" → spam.
// El cron silencioso (10 PM diario) ya detecta lo mismo y mueve el estado sin notificar a vendedora.
// setInterval(cronDetectarAprobacionTick, 8 * 60 * 60 * 1000);
// setTimeout(cronDetectarAprobacionTick, 12 * 60 * 1000);
console.log('[detectar-aprobacion] DESACTIVADO — reemplazado por cron silencioso 10 PM');

// ═══════════════════════════════════════════════════════════════════
// CRON Auto-archivar pedidos abandonados
// Pedidos en bandeja/hacer-diseno +10 dias sin actividad real
// (sin pagos, sin total, sin equipo nombrado por humano) → archiva.
// Tombstone agregado para que no resuciten.
// Solo aplica a pedidos creados despues del cutoff (para no archivar viejos
// que pueden estar en revision).
// ═══════════════════════════════════════════════════════════════════
const CRON_AUTOARCHIVE_CUTOFF_TS = new Date('2026-06-03T18:00:00.000Z').getTime();
async function cronAutoArchivarTick() {
  try {
    const horaBog = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBog !== 11) return; // solo a las 11 AM (1h despues de atascos)
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (!waPuedeEnviar(`auto-archive:${hoy}`)) return;

    const pedidos = db.leerPedidos();
    const ahora = Date.now();
    const _10D = 10 * 24 * 60 * 60 * 1000;
    const archivar = [];

    for (const p of pedidos) {
      if (p.estado !== 'bandeja' && p.estado !== 'hacer-diseno') continue;
      // Tiene actividad real? Si tiene pagos, total, o equipo nombrado por humano, NO archivar
      if (p.abonado && p.abonado > 0) continue;
      if (p.total && p.total > 0) continue;
      const tieneNombreReal = p.equipo && !/^cliente\s+[\+\d]/i.test(p.equipo);
      if (tieneNombreReal) continue;

      let tsUlt = new Date(p.ultimoMovimiento || 0).getTime();
      let tsCreacion = 0;
      if (p.creadoEn) {
        const parts = String(p.creadoEn).split('/');
        if (parts.length === 3) tsCreacion = new Date(parseInt(parts[2],10), parseInt(parts[1],10)-1, parseInt(parts[0],10)).getTime();
      }
      if (tsCreacion && tsCreacion < CRON_AUTOARCHIVE_CUTOFF_TS) continue;
      if (!tsUlt && tsCreacion) tsUlt = tsCreacion;
      if (!tsUlt) continue;
      if ((ahora - tsUlt) < _10D) continue;

      archivar.push(p);
    }

    if (archivar.length === 0) {
      console.log('[cron-archive] nada que archivar');
      return;
    }

    const ids = archivar.map(p => p.id);
    // Quitar de pedidos.json
    const nuevos = pedidos.filter(p => !ids.includes(p.id));
    db.guardarPedidos(nuevos);
    // Tombstones
    for (const id of ids) {
      try { agregarTombstone(id); } catch {}
    }
    // Notif al jefe
    const lineas = [`📦 *Auto-archivé ${archivar.length} pedido(s) abandonados*\n`,
      `Sin pagos, sin total, sin nombre real, +10 días sin actividad:`,
      ...archivar.slice(0, 10).map(p => `  • #${p.id} ${p.equipo || p.telefono || '?'} (${p.vendedora || '?'})`)];
    if (archivar.length > 10) lineas.push(`  + ${archivar.length - 10} más…`);
    lineas.push(`\nSi era venta real, contáctame para recuperar.`);
    const msg = lineas.join('\n');
    try { await notificarWAPersona('camilo', msg); } catch {}
    try { await notificarWAPersona('graciela', msg); } catch {}
    console.log(`[cron-archive] archivados ${archivar.length} pedidos`);
  } catch (e) {
    console.error('[cron-archive error]', e.message);
  }
}
setInterval(cronAutoArchivarTick, 60 * 60 * 1000);
setTimeout(cronAutoArchivarTick, 15 * 60 * 1000);
console.log('[cron-archive] activado — auto-archivar abandonados 11 AM Bogota');

// ═══════════════════════════════════════════════════════════════════
// CRON Backup nocturno a Drive — cada noche 2 AM Bogotá sube BD a Drive
// ═══════════════════════════════════════════════════════════════════
const BACKUP_FILE = path.join(__dirname, 'data', 'backup_ultimo.json');
function _yaBackupHoy() {
  try {
    if (!fs.existsSync(BACKUP_FILE)) return false;
    const ultimo = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    return ultimo.fecha === hoyBogota;
  } catch { return false; }
}
function _marcarBackupHoy(info) {
  try {
    fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify({ fecha: hoyBogota, ts: Date.now(), ...info }, null, 2));
  } catch (e) { console.error('[backup] no se pudo marcar:', e.message); }
}
async function cronBackupTick() {
  try {
    const hora = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (hora !== 2) return; // solo a las 2 AM
    if (_yaBackupHoy()) return;
    if (!gmailWT.estaConectado()) return;

    console.log('[backup] disparando backup BD a Drive...');
    const dbFile = path.join(__dirname, 'data', 'ws-textil.db');
    if (!fs.existsSync(dbFile)) return;
    const buffer = fs.readFileSync(dbFile);
    const contentBase64 = buffer.toString('base64');
    const hoyStr = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }).replace(/\//g, '-');
    const titulo = `ws-textil-backup-${hoyStr}.db`;
    const subida = await driveSync.subirArchivo({
      titulo,
      mimeType: 'application/x-sqlite3',
      contentBase64,
      parentId: driveSync.FOLDER_FACTURAS, // por ahora ponemos en FACTURAS, podemos crear carpeta Backups
    });
    _marcarBackupHoy({ driveId: subida.id, link: subida.viewLink, size: buffer.length });
    const msgTG = `💾 *Backup BD diario OK*\n\nArchivo: ${titulo}\nTamaño: ${(buffer.length/1024/1024).toFixed(2)} MB\nDrive: ${subida.viewLink}`;
    notificarTelegramDuvan(msgTG).catch(()=>{});
    console.log('[backup] OK', titulo, buffer.length, 'bytes');
  } catch (e) {
    console.error('[backup error]', e.message);
    notificarTelegramDuvan(`⚠️ *Backup falló*\n\n${e.message}`).catch(()=>{});
  }
}
// Tick cada 30 min (chequea si es hora 2 AM y aún no se hizo hoy)
setInterval(cronBackupTick, 30 * 60 * 1000);
// Tick inicial 5 min después de arrancar
setTimeout(cronBackupTick, 5 * 60 * 1000);
console.log('[backup] activado — backup diario 2 AM Bogotá a Drive');

// ═══════════════════════════════════════════════════════════════════
// CRON Costureras — cada 6 horas avisa lotes con +7 dias sin recepcion
// ═══════════════════════════════════════════════════════════════════
async function cronCostureras7DiasTick() {
  try {
    const horaBogota = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    if (horaBogota < 8 || horaBogota > 19) return; // solo horario laboral
    const limite = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const atrasados = db.leerMovimientosCosturaSinAviso7Dias(limite);
    if (!atrasados.length) return;
    for (const m of atrasados) {
      const dias = Math.floor((Date.now() - new Date(m.fecha_envio).getTime()) / 86400000);
      const msg = `⏰ *Lote +${dias} dias en costura*\n\n` +
        `Costurera: ${m.costurera_nombre}\n` +
        (m.equipo ? `Equipo: ${m.equipo}\n` : '') +
        (m.prenda ? `Prenda: ${m.prenda}\n` : '') +
        `Cantidad: ${m.cantidad_enviada}\n` +
        `Enviado: ${new Date(m.fecha_envio).toLocaleDateString('es-CO')}\n\n` +
        `Confirma desde la app si ya volvio o sigue allá.`;
      try {
        await notificarWAPersona('Lidermeyer', msg);
        db.marcarAviso7DiasCostura(m.id);
        console.log(`[cron-cost-7d] aviso enviado para mov #${m.id} (${m.costurera_nombre}, ${dias}d)`);
      } catch (e) { console.error('[cron-cost-7d msg]', e.message); }
    }
  } catch (e) {
    console.error('[cron-cost-7d error]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronCostureras7DiasTick, 6 * 60 * 60 * 1000);
// setTimeout(cronCostureras7DiasTick, 3 * 60 * 1000);
console.log('[cron-cost-7d] activado — avisa lotes +7d cada 6 horas (horario laboral)');

// ═══════════════════════════════════════════════════════════════════
// CRON Cuadre Costureras — domingo 8 PM Bogota → WA a Duvan
// ═══════════════════════════════════════════════════════════════════
const CUADRE_COST_FILE = path.join(__dirname, 'data', 'cuadre_cost_ultimo.json');
function _yaCuadreCostHoy() {
  try {
    if (!fs.existsSync(CUADRE_COST_FILE)) return false;
    const ultimo = JSON.parse(fs.readFileSync(CUADRE_COST_FILE, 'utf8'));
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    return ultimo.fecha === hoyBogota;
  } catch { return false; }
}
function _marcarCuadreCostHoy() {
  try {
    fs.mkdirSync(path.dirname(CUADRE_COST_FILE), { recursive: true });
    const hoyBogota = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
    fs.writeFileSync(CUADRE_COST_FILE, JSON.stringify({ fecha: hoyBogota, ts: Date.now() }));
  } catch (e) { console.error('[cuadre-cost] no se pudo marcar:', e.message); }
}
async function cronCuadreCostuTick() {
  try {
    // Solo domingo 20h (8 PM) Bogotá
    const ahoraBog = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    if (ahoraBog.getDay() !== 0) return; // 0 = domingo
    if (ahoraBog.getHours() !== 20) return;
    if (_yaCuadreCostHoy()) return;

    const desde = new Date(ahoraBog);
    desde.setDate(desde.getDate() - 6);
    desde.setHours(0, 0, 0, 0);
    const movs = db.leerMovimientosCosturaSemana(desde.toISOString(), ahoraBog.toISOString());
    if (!movs.length) {
      _marcarCuadreCostHoy();
      console.log('[cuadre-cost] sin movimientos esta semana, silencio');
      return;
    }

    const porCostu = {};
    let totalPrendas = 0, totalFaltantes = 0;
    for (const m of movs) {
      const k = m.costurera_slug;
      if (!porCostu[k]) {
        porCostu[k] = { nombre: m.costurera_nombre, total: 0, faltantes: 0, lotes: 0, detalle: {} };
      }
      const cant = m.cantidad_recibida || 0;
      porCostu[k].total += cant;
      porCostu[k].faltantes += (m.faltante || 0);
      porCostu[k].lotes += 1;
      const prenda = m.prenda || 'sin especificar';
      porCostu[k].detalle[prenda] = (porCostu[k].detalle[prenda] || 0) + cant;
      totalPrendas += cant;
      totalFaltantes += (m.faltante || 0);
    }

    let msg = `🧵 *Cuadre costureras — semana ${ahoraBog.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}*\n\n`;
    for (const k of Object.keys(porCostu)) {
      const c = porCostu[k];
      msg += `*${c.nombre}* — ${c.total} prendas (${c.lotes} lote${c.lotes > 1 ? 's' : ''})\n`;
      for (const [prenda, cant] of Object.entries(c.detalle)) {
        msg += `  • ${prenda}: ${cant}\n`;
      }
      if (c.faltantes > 0) msg += `  ⚠️ Faltantes: ${c.faltantes}\n`;
      msg += '\n';
    }
    msg += `📊 *TOTAL prendas:* ${totalPrendas}\n`;
    if (totalFaltantes > 0) msg += `⚠️ *Total faltantes:* ${totalFaltantes}\n`;

    await notificarTelegramDuvan(msg);
    await notificarWAPersona('Duvan', msg).catch(()=>{});
    _marcarCuadreCostHoy();
    console.log('[cuadre-cost] cuadre semanal enviado');
  } catch (e) {
    console.error('[cuadre-cost error]', e.message);
  }
}
// [APAGADO 2026-06-29: spam crones eliminado por pedido de Camilo]
// setInterval(cronCuadreCostuTick, 30 * 60 * 1000);
// setTimeout(cronCuadreCostuTick, 60 * 1000);
console.log('[cuadre-cost] activado — cuadre semanal domingo 8 PM Bogota');

// ═══════════════════════════════════════════════════════════════════
// CRON Vigilancia Chatwoot — pinga cada 5 min, alerta Telegram admin
// Anti-ceguera: Chatwoot murio silencioso 15 dias sin darnos cuenta (2-jul-2026).
// Estado persistente en data/vigilancia_chatwoot.json para sobrevivir deploys.
// ═══════════════════════════════════════════════════════════════════
const VIGILANCIA_CHATWOOT_FILE = path.join(__dirname, 'data', 'vigilancia_chatwoot.json');
function _leerVigilanciaChatwoot() {
  try { return JSON.parse(fs.readFileSync(VIGILANCIA_CHATWOOT_FILE, 'utf8')); }
  catch { return { fallos: 0, ultimoEstado: 'up' }; }
}
function _guardarVigilanciaChatwoot(s) {
  try { fs.mkdirSync(path.dirname(VIGILANCIA_CHATWOOT_FILE), { recursive: true }); } catch {}
  try { fs.writeFileSync(VIGILANCIA_CHATWOOT_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function cronVigilarChatwootTick() {
  try {
    const url = process.env.CHATWOOT_URL;
    if (!url) return;

    const state = _leerVigilanciaChatwoot();

    let status = 0;
    let errorMsg = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(`${url.replace(/\/$/, '')}/api`, { signal: ctrl.signal, redirect: 'follow' })
        .finally(() => clearTimeout(timer));
      status = r.status;
    } catch (e) {
      errorMsg = e.name === 'AbortError' ? 'timeout(10s)' : (e.message || 'error red');
    }

    const vivo = (status >= 200 && status < 400) || status === 401 || status === 403;

    if (vivo) {
      if (state.ultimoEstado === 'down' && (state.fallos || 0) >= 2) {
        const min = (state.fallos || 0) * 5;
        const horaBog = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
        try {
          await notificarTelegramAdmin(`✅ *Chatwoot volvió a responder* (${horaBog})\n\nEstuvo caído ~${min} min.\nStatus actual: ${status}`);
        } catch (e) { console.error('[vig-chatwoot notif-up]', e.message); }
      }
      state.fallos = 0;
      state.ultimoEstado = 'up';
      _guardarVigilanciaChatwoot(state);
      return;
    }

    state.fallos = (state.fallos || 0) + 1;
    state.ultimoEstado = 'down';
    _guardarVigilanciaChatwoot(state);

    const n = state.fallos;
    const min = n * 5;
    const statusStr = errorMsg || String(status);

    let msg = null;
    if (n === 2) {
      msg = `⚠️ *Chatwoot no responde hace 10 min*\n\nStatus: ${statusStr}\n\nSe reintenta cada 5 min.\nSi sigue caído a los 30 min, alerta con checklist.`;
    } else if (n === 6) {
      msg = `🚨 *Chatwoot lleva 30 min caído*\n\nStatus: ${statusStr}\n\nAcciones:\n1. Entrar a Railway → proyecto Chatwoot\n2. Ver Deployments → logs del último\n3. Botón *Restart*\n\nMientras: no se ven ni se etiquetan chats.`;
    } else if (n === 24 || (n > 24 && n % 24 === 0)) {
      msg = `🔴 *URGENTE: Chatwoot lleva ${Math.round(min/60)}h caído*\n\nStatus: ${statusStr}\n\nRevisar Railway ya.\n(Este aviso se repite cada 2h hasta que vuelva.)`;
    }

    if (msg) {
      try { await notificarTelegramAdmin(msg); } catch (e) { console.error('[vig-chatwoot notif-down]', e.message); }
    }
  } catch (e) {
    console.error('[cron-vig-chatwoot error]', e.message);
  }
}
setInterval(cronVigilarChatwootTick, 5 * 60 * 1000);
setTimeout(cronVigilarChatwootTick, 30 * 1000);
console.log('[cron-vig-chatwoot] activado — pinga Chatwoot cada 5 min, alertas Telegram admin');

// ═══════════════════════════════════════════════════════════════════
// CRON Vigilancia Evolution — deteccion "roto en silencio"
// 6-jul-2026: Evolution dejo de mandar eventos 3 hs sin que nadie se
// enterara. Chequea cada 5 min: (a) API responde, (b) hay eventos < 30 min.
// Anomalia = cualquiera de las dos. Alertas escaladas a Telegram admin.
// ═══════════════════════════════════════════════════════════════════
const VIGILANCIA_EVOLUTION_FILE = path.join(__dirname, 'data', 'vigilancia_evolution.json');
function _leerVigilanciaEvolution() {
  try { return JSON.parse(fs.readFileSync(VIGILANCIA_EVOLUTION_FILE, 'utf8')); }
  catch { return { fallos: 0, ultimoEstado: 'up', ultimoAutoHealTs: 0, autoHealsHechos: 0 }; }
}

// Auto-heal soft: re-registra el webhook a cada instancia. Muchas veces
// destraba Evolution sin necesidad de restart en Railway.
async function _autoHealEvolutionWebhooks() {
  try {
    const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const KEY = process.env.EVOLUTION_API_KEY || '';
    const webhookUrl = `https://ws-app-interna-production.up.railway.app/api/evolution-webhook?token=ws_secret_2026`;
    const nombres = ['ws-ventas', 'ws wendy', 'ws-ney', 'ws-paola', 'ws-duvan'];
    const eventos = ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','CHATS_UPDATE','CHATS_UPSERT','LABELS_ASSOCIATION','LABELS_EDIT','MESSAGES_DELETE','CONTACTS_UPSERT'];
    let ok = 0;
    for (const name of nombres) {
      try {
        const body = { webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: eventos } };
        const r = await fetch(`${EVO}/webhook/set/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: KEY },
          body: JSON.stringify(body),
        });
        if (r.ok) ok++;
      } catch {}
    }
    return ok;
  } catch { return 0; }
}
function _guardarVigilanciaEvolution(s) {
  try { fs.mkdirSync(path.dirname(VIGILANCIA_EVOLUTION_FILE), { recursive: true }); } catch {}
  try { fs.writeFileSync(VIGILANCIA_EVOLUTION_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function cronVigilarEvolutionTick() {
  try {
    const EVO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0be7c.up.railway.app';
    const KEY = process.env.EVOLUTION_API_KEY || '';
    if (!EVO) return;

    const state = _leerVigilanciaEvolution();

    // (a) API responde?
    let apiVivo = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(`${EVO}/`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      apiVivo = r.status >= 200 && r.status < 500;
    } catch { apiVivo = false; }

    // (b) Ultimo evento en BD — usamos _recv_at (hora del server al guardar),
    // NO date_time del payload de Evolution (su reloj puede estar desfasado).
    let ultimoEventoTs = 0;
    try {
      const fechas = db.raw.prepare('SELECT DISTINCT fecha FROM evolution_events ORDER BY fecha DESC LIMIT 2').all().map(r => r.fecha);
      for (const fecha of fechas) {
        const events = db.leerEvolutionEvents(fecha) || [];
        for (const ev of events) {
          // Prioridad: _recv_at (server) > date_time (evolution)
          const raw = ev?._recv_at || ev?.date_time || ev?.dateTime || ev?.timestamp || 0;
          const t = new Date(raw).getTime();
          if (!isNaN(t) && t > ultimoEventoTs) ultimoEventoTs = t;
        }
        if (ultimoEventoTs) break;
      }
    } catch {}

    const ahora = Date.now();
    const minSinEventos = ultimoEventoTs ? Math.round((ahora - ultimoEventoTs) / 60000) : 999;
    const silencioLargo = minSinEventos > 30;
    const anomalia = !apiVivo || silencioLargo;

    if (!anomalia) {
      if (state.ultimoEstado === 'down' && (state.fallos || 0) >= 2) {
        try {
          await notificarTelegramAdmin(`✅ *Evolution recibiendo eventos otra vez*\n\nUltimo evento hace ${minSinEventos} min.\nAPI: up.`);
        } catch (e) { console.error('[vig-evo notif-up]', e.message); }
      }
      state.fallos = 0;
      state.ultimoEstado = 'up';
      _guardarVigilanciaEvolution(state);
      return;
    }

    state.fallos = (state.fallos || 0) + 1;
    state.ultimoEstado = 'down';

    const n = state.fallos;
    const razon = !apiVivo
      ? 'Evolution API no responde'
      : `Evolution up pero CERO eventos hace ${minSinEventos} min`;

    // AUTO-HEAL SOFT: en el fallo 2 (10 min ciegos) intenta re-registrar webhooks.
    // Solo re-intenta si pasaron > 30 min desde el ultimo auto-heal (evita loop).
    let autoHealMsg = '';
    if (n === 2 && apiVivo && (ahora - (state.ultimoAutoHealTs || 0)) > 30 * 60 * 1000) {
      const ok = await _autoHealEvolutionWebhooks();
      state.ultimoAutoHealTs = ahora;
      state.autoHealsHechos = (state.autoHealsHechos || 0) + 1;
      console.log(`[vig-evo] auto-heal ejecutado, ${ok}/5 instancias re-registradas`);
      autoHealMsg = `\n\n🔧 Auto-heal ejecutado: re-registro webhook en ${ok}/5 instancias.\nEspero 5 min y verifico. Si vuelven eventos, tema resuelto solo.`;
    }
    _guardarVigilanciaEvolution(state);

    let msg = null;
    if (n === 2) {
      msg = `⚠️ *Evolution roto en silencio*\n\n${razon}\n\nSe reintenta cada 5 min.${autoHealMsg}`;
    } else if (n === 6) {
      msg = `🚨 *Evolution ciego hace ~30 min*\n\n${razon}\n\nEl auto-heal ya intento y no arreglo.\n\nAcciones:\n1. Railway → Evolution API → Deployments → *Restart*\n2. Esperar 60 seg\n3. Verificar: /api/admin/pulso-webhooks\n\nMientras: cero deteccion de comprobantes, etiquetas, stickers.`;
    } else if (n === 24 || (n > 24 && n % 24 === 0)) {
      msg = `🔴 *URGENTE: Evolution ciego hace ${Math.round(n*5/60)}h*\n\n${razon}\n\nRestart en Railway ya.\n(Aviso repite cada 2h.)`;
    }

    if (msg) {
      try { await notificarTelegramAdmin(msg); } catch (e) { console.error('[vig-evo notif-down]', e.message); }
    }
  } catch (e) {
    console.error('[cron-vig-evolution error]', e.message);
  }
}
setInterval(cronVigilarEvolutionTick, 5 * 60 * 1000);
setTimeout(cronVigilarEvolutionTick, 45 * 1000);
console.log('[cron-vig-evolution] activado — pinga Evolution + revisa pulso webhooks cada 5 min');

// ═══════════════════════════════════════════════════════════════════
// CRON Catalogo Drive — cada 5 min explora CATALOGO recursivo, descarga
// los JPGs nuevos o reemplazados, calcula sha256+pHash y los registra
// en disenos_catalogo. Reemplaza al workflow n8n (que solo veia la raiz).
// ═══════════════════════════════════════════════════════════════════
async function cronCatalogoDriveTick() {
  try {
    const archivos = await driveSync.listarCatalogoRecursivo();
    if (!archivos.length) {
      console.log('[cron-catalogo] no hay archivos');
      return;
    }
    let nuevos = 0, reemplazos = 0, skips = 0, errores = 0;

    for (const f of archivos) {
      try {
        // Chequeo idempotente: ya tenemos este fileId con mismo modifiedTime?
        const existente = db.raw.prepare(
          'SELECT id, modified_time FROM disenos_catalogo WHERE file_id = ? ORDER BY id DESC LIMIT 1'
        ).get(f.id);
        if (existente && existente.modified_time === f.modifiedTime) {
          skips++;
          continue;
        }

        // Descargar
        const dl = await driveSync.descargarArchivoBase64(f.id);
        if (!dl || !dl.base64) { errores++; continue; }
        const buf = Buffer.from(dl.base64, 'base64');

        // Hash
        const sha256 = disenos.calcularSha256(buf);
        const phash = await disenos.calcularPHash(buf);

        // Registrar (idempotente por fileId+sha256)
        const r = disenos.registrarCatalogo({
          fileId: f.id,
          nombre: f.name,
          sha256, phash,
          sizeBytes: parseInt(f.size || '0', 10) || null,
          modifiedTime: f.modifiedTime,
        });
        if (r.accion === 'nuevo') nuevos++;
        else if (r.accion === 'reemplazo') reemplazos++;
        else skips++;
      } catch (e) {
        errores++;
        console.error(`[cron-catalogo] archivo ${f.name}:`, e.message);
      }
    }
    if (nuevos || reemplazos || errores) {
      console.log(`[cron-catalogo] archivos=${archivos.length} nuevos=${nuevos} reemplazos=${reemplazos} skips=${skips} errores=${errores}`);
    }
  } catch (e) {
    console.error('[cron-catalogo error]', e.message);
  }
}
setInterval(cronCatalogoDriveTick, 5 * 60 * 1000);
setTimeout(cronCatalogoDriveTick, 60 * 1000);
console.log('[cron-catalogo] activado — explora CATALOGO recursivo cada 5 min');

// ═══════════════════════════════════════════════════════════════════
// CRON Vigilancia Google OAuth — cada 30 min chequea que Drive/Gmail
// respondan. Si vuelve invalid_grant/401, alerta Telegram admin con link
// para re-autorizar (mismo patron que Chatwoot/Evolution).
// ═══════════════════════════════════════════════════════════════════
const VIGILANCIA_GOOGLE_FILE = path.join(__dirname, 'data', 'vigilancia_google.json');
function _leerVigilanciaGoogle() {
  try { return JSON.parse(fs.readFileSync(VIGILANCIA_GOOGLE_FILE, 'utf8')); }
  catch { return { fallos: 0, ultimoEstado: 'up' }; }
}
function _guardarVigilanciaGoogle(s) {
  try { fs.mkdirSync(path.dirname(VIGILANCIA_GOOGLE_FILE), { recursive: true }); } catch {}
  try { fs.writeFileSync(VIGILANCIA_GOOGLE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function cronVigilarGoogleTick() {
  try {
    const state = _leerVigilanciaGoogle();
    let ok = false;
    let errorMsg = null;
    try {
      // Prueba minima: listar una carpeta conocida (COREL raiz)
      const r = await driveSync.listarArchivos(driveSync.FOLDER_COREL, 1);
      ok = Array.isArray(r);
    } catch (e) {
      errorMsg = e.message || 'error desconocido';
      ok = false;
    }

    if (ok) {
      if (state.ultimoEstado === 'down' && (state.fallos || 0) >= 2) {
        const min = (state.fallos || 0) * 30;
        try {
          await notificarTelegramAdmin(`✅ *Google Drive/Gmail volvio a responder*\n\nEstuvo caido ~${min} min.\nRe-autorizacion aplicada correctamente.`);
        } catch (e) { console.error('[vig-google notif-up]', e.message); }
      }
      state.fallos = 0;
      state.ultimoEstado = 'up';
      _guardarVigilanciaGoogle(state);
      return;
    }

    state.fallos = (state.fallos || 0) + 1;
    state.ultimoEstado = 'down';
    _guardarVigilanciaGoogle(state);

    const n = state.fallos;
    const min = n * 30;
    const esInvalidGrant = /invalid_grant|revoked|expired/i.test(errorMsg || '');

    let msg = null;
    if (n === 1 || n === 4 || (n > 4 && n % 4 === 0)) {
      const razon = esInvalidGrant
        ? 'OAuth expirado o revocado (invalid_grant)'
        : `Drive API error: ${errorMsg}`;
      msg = `🚨 *Google Drive/Gmail no responde*\n\n${razon}\n\nCaido hace ~${min} min.\n\n` +
            `Accion: abrir en el navegador\n` +
            `https://ws-app-interna-production.up.railway.app/api/gmail/auth\n\n` +
            `y aceptar los permisos con la cuenta duvandominguez05@gmail.com.\n\n` +
            `Mientras: cron CATALOGO, PDF RIP y Gmail WeTransfer estan detenidos.`;
    }

    if (msg) {
      try { await notificarTelegramAdmin(msg); } catch (e) { console.error('[vig-google notif-down]', e.message); }
    }
  } catch (e) {
    console.error('[cron-vig-google error]', e.message);
  }
}
setInterval(cronVigilarGoogleTick, 30 * 60 * 1000);
setTimeout(cronVigilarGoogleTick, 90 * 1000);
console.log('[cron-vig-google] activado — chequea Drive/Gmail OAuth cada 30 min');

// ═══════════════════════════════════════════════════════════════════
// _correrBackfillDisenos — funcion async del backfill que corre en background.
// Disparada desde POST /api/disenos/backfill. Estado en global._backfillDisenosState.
// ═══════════════════════════════════════════════════════════════════
async function _correrBackfillDisenos(evoDbUrl, maxPorPedido, estados) {
  const ESTADOS_AVANZADOS = new Set(['listo', 'enviado-calandra', 'costura', 'entregado']);
  let pool = null;
  const detalle = [];
  let matcheados = 0, sinMatch = 0, avanzadosMarcados = 0;
  try {
    pool = new PgPool({ connectionString: evoDbUrl, max: 2, ssl: { rejectUnauthorized: false } });
    const inst = await pool.query(`SELECT id, name FROM "Instance"`);
    const instById = {}; for (const r of inst.rows) instById[r.id] = r.name;

    const pedidos = leerPedidos().filter(p => estados.includes(p.estado));
    global._backfillDisenosState.total = pedidos.length;

    for (const p of pedidos) {
      global._backfillDisenosState.progreso = (global._backfillDisenosState.progreso || 0) + 1;
      global._backfillDisenosState.actual = { id: p.id, equipo: p.equipo };

      const tel = String(p.telefono || '').replace(/\D/g, '');
      if (!tel || tel.length < 7) {
        detalle.push({ id: p.id, equipo: p.equipo, resultado: 'skip - sin telefono' });
        continue;
      }
      try {
        const telFull = tel.startsWith('57') ? tel : '57' + tel;
        const wapp = `${telFull}@s.whatsapp.net`;
        const jids = [wapp];
        const lidRes = await pool.query(
          `SELECT DISTINCT m.key->>'remoteJid' AS "remoteJid" FROM "Message" m
           WHERE m.key->>'remoteJidAlt' = $1 AND m.key->>'remoteJid' LIKE '%@lid'`,
          [wapp]
        );
        for (const r of lidRes.rows) jids.push(r.remoteJid);

        const jidsSql = jids.map((_, i) => `$${i+1}`).join(',');
        const msgs = await pool.query(
          `SELECT "instanceId", "messageTimestamp", key, message
           FROM "Message"
           WHERE key->>'remoteJid' IN (${jidsSql})
             AND key->>'fromMe' = 'true'
             AND "messageType" = 'imageMessage'
           ORDER BY "messageTimestamp" DESC
           LIMIT ${maxPorPedido}`,
          jids
        );

        if (!msgs.rows.length) {
          if (ESTADOS_AVANZADOS.has(p.estado)) {
            disenos.registrarEnvio({
              disenoCatalogoId: null, pedidoId: p.id,
              telefonoCliente: tel, instanciaVendedora: null,
              waMsgId: `retro-${p.id}`, metodo: 'retro-avanzado',
              confianza: 0.8, tsEnvio: new Date().toISOString(),
            });
            avanzadosMarcados++;
            detalle.push({ id: p.id, equipo: p.equipo, estado: p.estado, resultado: 'marcado retro (estado avanzado, sin imgs)' });
          } else {
            detalle.push({ id: p.id, equipo: p.equipo, estado: p.estado, resultado: 'sin imagenes salientes en Evolution' });
          }
          continue;
        }

        let matchDelPedido = null;
        for (const m of msgs.rows) {
          const waMsgId = m.key?.id;
          if (!waMsgId) continue;
          if (disenos.envioYaProcesado(waMsgId)) continue;
          const instName = instById[m.instanceId];
          if (!instName) continue;
          try {
            const media = await descargarImagenEvolution(instName, m.key);
            if (!media || !media.base64) continue;
            const buf = Buffer.from(media.base64, 'base64');
            const sha256 = disenos.calcularSha256(buf);
            const phash = await disenos.calcularPHash(buf);
            const match = disenos.buscarMatch({ sha256, phash });
            if (match) {
              disenos.registrarEnvio({
                disenoCatalogoId: match.catalogo.id, pedidoId: p.id,
                telefonoCliente: tel, instanciaVendedora: instName,
                waMsgId, metodo: match.metodo, confianza: match.confianza,
                tsEnvio: new Date(parseInt(m.messageTimestamp || Date.now()/1000) * 1000).toISOString(),
              });
              if (!matchDelPedido || match.confianza > matchDelPedido.confianza) {
                matchDelPedido = { catalogo: match.catalogo, confianza: match.confianza, metodo: match.metodo };
              }
            }
          } catch (eDl) { /* imagen borrada, skip */ }
        }

        if (matchDelPedido) {
          const pedidosNow = leerPedidos();
          const pFresh = pedidosNow.find(x => x.id === p.id);
          if (pFresh) {
            const antes = pFresh.equipo || '';
            const yaTeniaNombreReal = antes && !/^cliente\s+[\+\d]/i.test(antes);
            const nombreDiseno = String(matchDelPedido.catalogo.nombre || '').replace(/\.(jpe?g|png|webp)$/i, '');
            if (!yaTeniaNombreReal) pFresh.equipo = nombreDiseno;
            pFresh.fotoDiseno = pFresh.fotoDiseno || matchDelPedido.catalogo.nombre;
            pFresh.ultimoMovimiento = new Date().toISOString();
            guardarPedidos(pedidosNow);
            matcheados++;
            detalle.push({
              id: p.id, equipo_antes: antes, equipo_despues: pFresh.equipo,
              estado: p.estado, telefono: tel,
              archivo: matchDelPedido.catalogo.nombre,
              metodo: matchDelPedido.metodo, confianza: matchDelPedido.confianza.toFixed(2),
              resultado: 'MATCH',
            });
          }
        } else {
          if (ESTADOS_AVANZADOS.has(p.estado)) {
            disenos.registrarEnvio({
              disenoCatalogoId: null, pedidoId: p.id,
              telefonoCliente: tel, instanciaVendedora: null,
              waMsgId: `retro-${p.id}`, metodo: 'retro-avanzado',
              confianza: 0.7, tsEnvio: new Date().toISOString(),
            });
            avanzadosMarcados++;
            detalle.push({ id: p.id, equipo: p.equipo, estado: p.estado, telefono: tel, resultado: `retro (${msgs.rows.length} imgs revisadas, ninguna match)` });
          } else {
            sinMatch++;
            detalle.push({ id: p.id, equipo: p.equipo, estado: p.estado, telefono: tel, resultado: `sin match (${msgs.rows.length} imgs revisadas)` });
          }
        }
      } catch (ePed) {
        detalle.push({ id: p.id, equipo: p.equipo, error: ePed.message });
      }
    }

    global._backfillDisenosState = {
      estado: 'terminado',
      terminado: new Date().toISOString(),
      pedidos_procesados: pedidos.length,
      matcheados, sin_match: sinMatch, avanzados_marcados: avanzadosMarcados,
      detalle,
    };

    // Notif Telegram admin con resumen
    try {
      const top = detalle.filter(d => d.resultado === 'MATCH').slice(0, 8);
      let msg = `🎨 *Backfill de disenos terminado*\n\n` +
        `Pedidos procesados: ${pedidos.length}\n` +
        `Matcheados: ${matcheados}\n` +
        `Sin match: ${sinMatch}\n` +
        `Retro (avanzados sin match): ${avanzadosMarcados}\n\n`;
      if (top.length) {
        msg += `*Top matches:*\n`;
        for (const t of top) msg += `  #${t.id} → ${t.archivo} (conf ${t.confianza})\n`;
      }
      msg += `\nDetalle completo: /api/disenos/backfill-status`;
      await notificarTelegramAdmin(msg);
    } catch (e) { console.error('[backfill notif]', e.message); }

    console.log(`[backfill] terminado: matcheados=${matcheados} sinMatch=${sinMatch} retro=${avanzadosMarcados}`);
  } catch (e) {
    console.error('[backfill error]', e.message);
    global._backfillDisenosState = { estado: 'error', error: e.message, detalle };
    try { await notificarTelegramAdmin(`❌ Backfill disenos fallo: ${e.message}`); } catch {}
  } finally {
    if (pool) { try { await pool.end(); } catch {} }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ENDPOINT MANUAL: forzar backup ahora (admin)
// ═══════════════════════════════════════════════════════════════════
// se registra dentro del handler de rutas, no acá
