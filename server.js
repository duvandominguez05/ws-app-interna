const http = require('http');
const fs   = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;
const db   = require('./db');
const { PERSONAS, getPersona, manifestParaPersona } = require('./personas');
const gmailWT = require('./gmail-wt');
const driveSync = require('./drive-sync');

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
  graciela:   process.env.WA_GRACIELA || null,
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
  'llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final'
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
    if (['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final'].includes(p.estado)) return false;
    const aliases = Array.isArray(p.archivosAlias) ? p.archivosAlias : [];
    return aliases.some(a => a === refLimpio || a.includes(refLimpio) || refLimpio.includes(a));
  });
  if (pd) return pd;
  // 2) Coincidencia con equipo
  pd = pedidos.find(p => {
    if (['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final'].includes(p.estado)) return false;
    return nombresCoinciden(p.equipo, ref);
  });
  if (pd) return pd;
  // 3) Coincidencia con cliente (a veces el archivo se llama como el cliente, no como el equipo)
  pd = pedidos.find(p => {
    if (['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final'].includes(p.estado)) return false;
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

http.createServer(async (req, res) => {

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

        // ─── DETECCIÓN DE CAMBIOS para disparar notificaciones WA ───
        // (antes de guardar) Identificar:
        //   1) Diseñador recién asignado (existing.disenadorAsignado vacío → nuevo tiene valor)
        //   2) Estado avanzó a 'listo' (avisar a la vendedora)
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

        return json(res, 200, { ok: true, total: merged.length });
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
      const STICKER_VENTA_HASH = process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620';
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
      const STICKER_VENTA_HASH = process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620';
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

  // ── GET /api/admin/test-lote-costurera/:slug — crea lote demo para probar UX ──
  // Inserta un lote ficticio. NO impacta producción real. Para borrar usar
  // /api/admin/test-lote-borrar?id=XX
  if (req.method === 'GET' && req.url.startsWith('/api/admin/test-lote-costurera/')) {
    try {
      const slug = req.url.split('/')[4].split('?')[0];
      const costu = PERSONAS.find(p => p.slug === slug && p.roles.includes('costura'));
      if (!costu) return json(res, 404, { error: 'costurera no encontrada' });
      const id = db.crearMovimientoCostura({
        pedido_id: null,
        costurera_slug: slug,
        costurera_nombre: costu.nombre,
        equipo: 'PRUEBA — Colegio Demo',
        prenda: 'Camiseta + pantaloneta',
        cantidad_enviada: 24,
        enviado_por: 'test-admin',
        observaciones: 'Lote de PRUEBA. Esto es solo para ver como se ve la app de '+costu.nombre+'. Cuando termines, borralo con el endpoint /api/admin/test-lote-borrar?id='+'<el id que sale aqui>',
      });
      return json(res, 200, {
        ok: true,
        movimiento_id: id,
        vistaCosturera: `/c/${slug}`,
        borrarUrl: `/api/admin/test-lote-borrar?id=${id}`,
      });
    } catch (e) { return json(res, 500, { error: e.message }); }
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
                        // Si quedo pagado completo Y tiene total → avisar a vendedora
                        if (resVinc.pagadoCompleto) {
                          try {
                            const msgPagado = `✅ *Cliente pagó 100%*\n\n` +
                              `Pedido #${resVinc.pedidoId} — ${nombreCliente}\n` +
                              `Total abonado: $${Number(resVinc.abonado).toLocaleString('es-CO')}\n\n` +
                              `Cuando esté listo, ya se puede despachar.`;
                            await notificarWAVendedora(vendedora, msgPagado);
                          } catch (eAvi) { console.error('[pago avisar]', eAvi.message); }
                        }
                      } else {
                        console.log(`[pago] no vinculado: ${resVinc.motivo}`);
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
                      const msg = `💸 *Pago detectado* ${montoTxt}${bancoTxt}\n\n` +
                        `👤 ${nombreCliente || telefonoCliente}\n` +
                        `📱 ${telefonoCliente}\n` +
                        pedidoTxt +
                        `\n📊 *TU DIA HASTA AHORA:*\n` +
                        `✅ ${r.conSticker} con sticker\n` +
                        `⚠️ ${r.sinSticker} SIN sticker (este incluido)\n` +
                        `💰 Detectado: ${totalDiaTxt}\n\n` +
                        `👉 *Pasa el sticker 💰 al chat del cliente* para oficializar esta venta y subir tu contador.`;
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
              const esComando = /^(ver|lista|list|\d+\s+(si|no|sí)\b)/i.test(t);
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

  if (req.method === 'GET' && req.url === '/produccion') {
    return fs.readFile(path.join(__dirname, 'public', 'produccion.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

        // Notif WA a la costurera (si tiene numero configurado)
        const link = `${process.env.APP_BASE_URL || 'https://ws-app-interna-production.up.railway.app'}/c/${costurera_slug}`;
        const msg = `🧵 *Nuevo lote para ti*\n\n` +
          (equipo ? `👕 Equipo: ${equipo}\n` : '') +
          (prenda ? `🪡 Prenda: ${prenda}\n` : '') +
          `📊 Cantidad: ${cantidad}\n` +
          (observaciones ? `📝 Nota: ${observaciones}\n` : '') +
          `\n👉 Ver tus lotes pendientes: ${link}`;
        notificarWAPersona(costu.nombre, msg).catch(()=>{});

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

  // ── GET /c/:slug — mini-app para la costurera (vista personal de sus lotes) ──
  if (req.method === 'GET' && req.url.startsWith('/c/')) {
    const slug = req.url.split('/')[2].split('?')[0];
    const costu = PERSONAS.find(p => p.slug === slug && p.roles.includes('costura'));
    if (!costu) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<h1>Costurera no encontrada</h1>');
    }
    return fs.readFile(path.join(__dirname, 'public', 'costurera.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  // ── GET /api/c/:slug/lotes — lotes pendientes + entregados hoy para una costurera ──
  if (req.method === 'GET' && req.url.startsWith('/api/c/') && req.url.endsWith('/lotes')) {
    const slug = req.url.split('/')[3];
    const costu = PERSONAS.find(p => p.slug === slug && p.roles.includes('costura'));
    if (!costu) return json(res, 404, { error: 'costurera no encontrada' });
    const pendientes = db.leerMovimientosCostureraPendientes(slug);
    // Calcular cuantos entregó hoy (confirmados con fecha en hoy/Bogota)
    let entregadosHoy = 0;
    try {
      const recientes = db.leerMovimientosCostureraPorSlug(slug, 100);
      const hoyBog = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
      entregadosHoy = recientes.filter(m => {
        if (m.confirmado_costurera != 1) return false;
        const f = m.confirmado_fecha || m.fecha_recibido || null;
        if (!f) return false;
        try {
          return new Date(f).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }) === hoyBog;
        } catch { return false; }
      }).length;
    } catch (e) { console.warn('[lotes-hoy]', e.message); }
    return json(res, 200, {
      costurera: { slug, nombre: costu.nombre, color: costu.color || '#10b981' },
      pendientes,
      entregadosHoy,
    });
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
      let pedidosHoy = new Set(), pedidosSemana = new Set(), pedidosMes = new Set(), pedidosAnio = new Set();
      const enviadosRecientes = [];
      for (const p of pedidos) {
        if (!p.wetransfer || !p.wetransfer.archivos) continue;
        for (const a of p.wetransfer.archivos) {
          if (!a.fechaEnvio) continue;
          const fStr = a.fechaEnvio.slice(0, 10);
          const m2 = a.m2 || 0;
          if (fStr >= inicioAnioStr) { m2Anio += m2; pedidosAnio.add(p.id); }
          if (fStr >= inicioMesStr) { m2Mes += m2; pedidosMes.add(p.id); }
          if (fStr >= inicioSemanaStr) { m2Semana += m2; pedidosSemana.add(p.id); }
          if (fStr === hoyStr) { m2Hoy += m2; pedidosHoy.add(p.id); }
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
      // Ordenar recientes por fecha desc
      enviadosRecientes.sort((a, b) => (b.fechaEnvio || '').localeCompare(a.fechaEnvio || ''));

      // Huérfanos
      const huerfanos = gmailWT.leerHuerfanos ? gmailWT.leerHuerfanos() : [];

      return json(res, 200, {
        stats: {
          hoy:    { m2: m2Hoy,    pedidos: pedidosHoy.size },
          semana: { m2: m2Semana, pedidos: pedidosSemana.size },
          mes:    { m2: m2Mes,    pedidos: pedidosMes.size },
          anio:   { m2: m2Anio,   pedidos: pedidosAnio.size },
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

    // Mandar WA a cada vendedora con sus pendientes + cuadre del día completo
    for (const [vendedora, items] of Object.entries(porVendedora)) {
      const lineas = items.map((r, i) => {
        const hora = new Date(r.ts).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
        const monto = r.monto ? _formatearMontoCOP(r.monto) : '?';
        return `${i+1}. *${r.cliente}* (${hora}) — ${r.banco} ${monto}`;
      }).join('\n');
      const dia = resumenDiaVendedora(vendedora);
      const texto = `📊 *${vendedora.toUpperCase()} — Cierre del día*\n\n` +
        `🎯 *Ventas confirmadas con sticker:* ${dia.conSticker}\n` +
        `💰 *Total detectado hoy:* ${_formatearMontoCOP(dia.totalMonto)}\n\n` +
        `⚠️ *${items.length} pago${items.length>1?'s':''} SIN sticker:*\n${lineas}\n\n` +
        `👉 Si fueron ventas reales, mandá el sticker para que entren a la app.\n` +
        `Si alguna no era venta, ignorá ese.`;
      try { await notificarWAVendedora(vendedora, texto); } catch (e) { console.error('[resumen-8pm wa]', e.message); }
      console.log(`[resumen-8pm] enviado a ${vendedora}: ${items.length} sin sticker / ${dia.conSticker} con sticker`);
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
// Tick cada 60 segundos
setInterval(cron8pmTick, 60 * 1000);
// Tick inicial 30s después de arrancar (por si el server arranca a las 8 PM)
setTimeout(cron8pmTick, 30 * 1000);
console.log('[cron-8pm] activado — disparará a las 8 PM Bogotá');

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
setInterval(cron7pmTick, 60 * 1000);
setTimeout(cron7pmTick, 45 * 1000);
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

  return {
    hoyBogota,
    ventasSemana: { count: ventasSemana.length, monto: ventasTotalMonto, porVendedora: ventasPorVend },
    facturasSemana: { count: facturasSemana.length, monto: facturasMonto },
    docsWAPendientes: { count: docsWAPendientes.length, porVendedora: docsPorVend },
    pedidos: { activos: activos.length, porEstado, atrasados: atrasados.length, atrasadosDetalle: atrasados.slice(0, 5).map(p => ({ id: p.id, cliente: p.cliente || p.equipo || 'Sin nombre', fechaEntrega: p.fechaEntrega, estado: p.estado })) },
    comprobantesSinSticker: sinSticker,
  };
}

function construirMensajeResumenSemanal(r) {
  const fmt = (n) => _formatearMontoCOP ? _formatearMontoCOP(n) : `$${(n||0).toLocaleString('es-CO')}`;
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

  return `📊 *RESUMEN SEMANAL — Domingo ${r.hoyBogota}*

💰 *VENTAS DETECTADAS (7 días)*
Total: *${r.ventasSemana.count}* ventas — *${fmt(r.ventasSemana.monto)}*
${lineasVentas}

📄 *FACTURAS EMITIDAS EN APP (7 días)*
${r.facturasSemana.count} facturas — ${fmt(r.facturasSemana.monto)}

📥 *DOCUMENTOS WA SIN REVISAR* (${r.docsWAPendientes.count} total)
${lineasDocs}
${r.docsWAPendientes.count > 0 ? '\n👉 Revisá: https://ws-app-interna-production.up.railway.app/api/admin/docs-wa?solo=pendientes' : ''}

⚠️ *COMPROBANTES SIN STICKER esta semana*: ${r.comprobantesSinSticker}
${r.comprobantesSinSticker > 0 ? '_(vendedoras olvidaron poner sticker → revisar)_' : '_(todas las vendedoras marcaron sus ventas ✓)_'}

🚨 *PEDIDOS ATRASADOS HOY*: ${r.pedidos.atrasados}
${lineasAtrasados || '_(ninguno)_'}

📋 *TABLERO ACTIVO (${r.pedidos.activos} pedidos)*
${lineasEstado || '_(vacío)_'}

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
setInterval(cronAlertasCalandraTick, 60 * 60 * 1000); // cada hora
setTimeout(cronAlertasCalandraTick, 90 * 1000); // primer tick 90s tras arrancar
console.log('[cron-alertas-cal] activado — chequea calandra +24h cada hora 8AM-7PM');

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
setInterval(cronAlertasCosturaEntregaTick, 60 * 60 * 1000); // cada hora
setTimeout(cronAlertasCosturaEntregaTick, 120 * 1000);
console.log('[cron-alertas-costu-entrega] activado — chequea costureras +48h sin entregar fisicamente');

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
  if (!gmailWT.estaConectado()) return; // mismo OAuth
  _driveSyncEnCurso = true;
  try {
    const pedidos = db.leerPedidos();
    const resultado = await driveSync.sincronizarConPedidos(pedidos);
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
// Cada 15 minutos
setInterval(cronRecordatorioStickerTick, 15 * 60 * 1000);
// Tick inicial 2 min después de arrancar
setTimeout(cronRecordatorioStickerTick, 2 * 60 * 1000);
console.log('[cron-90min] activado — recordatorios sticker cada 15 min');

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
setInterval(cronCostureras7DiasTick, 6 * 60 * 60 * 1000);
setTimeout(cronCostureras7DiasTick, 3 * 60 * 1000);
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
setInterval(cronCuadreCostuTick, 30 * 60 * 1000);
setTimeout(cronCuadreCostuTick, 60 * 1000);
console.log('[cuadre-cost] activado — cuadre semanal domingo 8 PM Bogota');

// ═══════════════════════════════════════════════════════════════════
// ENDPOINT MANUAL: forzar backup ahora (admin)
// ═══════════════════════════════════════════════════════════════════
// se registra dentro del handler de rutas, no acá
