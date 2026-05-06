const http = require('http');
const fs   = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

// ── Configuración de Seguridad ───────────────────────────────────
const API_KEY = process.env.API_KEY || 'ws-textil-2026';

const PORT = process.env.PORT || 3000;
const DATA_FILE   = path.join(__dirname, 'data', 'pedidos.json');
const NEXTID_FILE = path.join(__dirname, 'data', 'nextId.json');

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

  // Control de Duplicados por teléfono+mes
  const mesActual = new Date().toLocaleDateString('es-CO').slice(-7);
  const telLimpio = String(telefono).replace(/\s/g, '');
  const dupTel = pedidos.find(p => {
    const pTel = String(p.telefono).replace(/\s/g, '');
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

function leerPedidos() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return []; }
}

function leerNextId() {
  try {
    if (!fs.existsSync(NEXTID_FILE)) return 1;
    return JSON.parse(fs.readFileSync(NEXTID_FILE, 'utf8')).nextId || 1;
  } catch { return 1; }
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

function guardarPedidos(pedidos, nextId) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(pedidos, null, 2));
  if (nextId) fs.writeFileSync(NEXTID_FILE, JSON.stringify({ nextId }));
}

const ESTADOS_VALIDOS = [
  'bandeja','hacer-diseno','confirmado','enviado-calandra',
  'llego-impresion','corte','calidad','costura','listo','enviado-final'
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

  // ── GET /api/pedidos — lista todos los pedidos ──────────────
  if (req.method === 'GET' && req.url === '/api/pedidos') {
    return json(res, 200, { pedidos: leerPedidos(), nextId: leerNextId() });
  }

  // ── DELETE /api/pedidos/:id — borra un pedido del servidor ──
  if (req.method === 'DELETE' && req.url.startsWith('/api/pedidos/')) {
    const id = parseInt(req.url.split('/')[3]);
    const pedidos = leerPedidos();
    const nuevos = pedidos.filter(p => p.id !== id);
    if (nuevos.length === pedidos.length) return json(res, 404, { error: 'Pedido no encontrado' });
    guardarPedidos(nuevos);
    console.log(`[api] Pedido #${id} eliminado`);
    return json(res, 200, { ok: true });
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

        // Merge: preservar campos del servidor que el cliente puede no tener
        const existing = leerPedidos();
        const mapaExisting = new Map(existing.map(p => [p.id, p]));
        const merged = incoming.map(p => {
          const e = mapaExisting.get(p.id);
          if (!e) return p;
          
          const tIn = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
          const tEx = e.ultimoMovimiento ? new Date(e.ultimoMovimiento).getTime() : 0;

          // Si el servidor tiene datos más recientes, rechazar la actualización del cliente para este pedido
          if (tEx > tIn) {
            return e;
          }

          // Si el cliente tiene datos más recientes o iguales, aceptar los del cliente pero preservar webhooks
          return {
            ...p,
            equipo: p.equipo || e.equipo || '',
            notaWebhook: p.notaWebhook || e.notaWebhook,
            ultimaActWebhook: p.ultimaActWebhook || e.ultimaActWebhook,
          };
        });
        // Preservar pedidos del servidor que el cliente no tiene (creados por bot en otro momento)
        // pero NO reagregar los que el cliente eliminó explícitamente
        const incomingIds = new Set(incoming.map(p => p.id));
        existing.forEach(e => { if (!incomingIds.has(e.id) && !eliminadosSet.has(e.id)) merged.push(e); });
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

  // ── GET /api/health-reacciones — confirma que el código de reacciones está vivo ──
  if (req.method === 'GET' && req.url === '/api/health-reacciones') {
    return json(res, 200, { ok: true, version: 'sprint-3-torre-control-pdfs-huerfanos', activas: process.env.REACCIONES_ACTIVAS === 'true', chatwoot: !!process.env.CHATWOOT_API_KEY, telegram: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID, wa_grupo: process.env.WA_GRUPO_TRABAJO || '573506974711-1612841042@g.us', sticker_hashes_configurados: (process.env.STICKER_VENTA_HASHES || '8412e3c08b27c7ebc947948502e59b304347445bf4778a89245408e51fa61620').split(',').filter(Boolean).length });
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
        
        // 1. Guardar log crudo para debug (esencial para ver cómo llegan los stickers y etiquetas)
        const EVOLUTION_LOG_DIR = path.join(__dirname, 'data', 'evolution-events');
        if (!fs.existsSync(EVOLUTION_LOG_DIR)) {
            fs.mkdirSync(EVOLUTION_LOG_DIR, { recursive: true });
        }
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // Formato YYYY-MM-DD
        const logFile = path.join(EVOLUTION_LOG_DIR, `${hoy}.log`);
        const logEntry = `[${new Date().toISOString()}] ${JSON.stringify(payload)}\n`;
        fs.appendFileSync(logFile, logEntry);

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
                        nuevoPd.estado = 'hacer-diseno';
                        nuevoPd.tipoBandeja = 'pedido';
                        nuevoPd.ultimoMovimiento = new Date().toISOString();
                        nuevoPd.stickerVenta = stickerHash;
                        nuevoPd.fechaVenta = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
                        if (contactoChatwoot) nuevoPd.contactoChatwoot = contactoChatwoot;
                        // Auto-asignar diseñador si la vendedora también diseña
                        if (VENDEDORAS_DISENADORAS.has(vendedora)) {
                          nuevoPd.disenadorAsignado = vendedora;
                        }
                        guardarPedidos(pp, leerNextId());
                      }
                      accionRealizada = true;
                      console.log(`[sticker-venta] pedido NUEVO #${resultadoApi.id} en hacer-diseno (vendedora=${vendedora}, ${nombreCliente})`);
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

        return json(res, 200, { ok: true, webhook_recibido: true, accionRealizada, resultadoApi });
      } catch (e) {
        console.error('[evolution webhook error]', e);
        return json(res, 200, { ok: true, aviso: 'Parse error en webhook' });
      }
    });
    return;
  }

  // ── GET /api/evolution-logs — lista archivos de log disponibles ──
  if (req.method === 'GET' && req.url === '/api/evolution-logs') {
    try {
      const dir = path.join(__dirname, 'data', 'evolution-events');
      if (!fs.existsSync(dir)) return json(res, 200, { archivos: [], aviso: 'Aún no hay eventos registrados' });
      const archivos = fs.readdirSync(dir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse()
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { archivo: f, tamano_kb: Math.round(stat.size / 1024 * 10) / 10, modificado: stat.mtime };
        });
      return json(res, 200, { archivos });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/evolution-logs/:fecha — devuelve eventos del día ──
  // ?last=20 para últimos N eventos, ?filter=texto para filtrar por substring
  if (req.method === 'GET' && req.url.startsWith('/api/evolution-logs/')) {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const fecha = urlObj.pathname.split('/')[3];
      const last = parseInt(urlObj.searchParams.get('last')) || 50;
      const filtro = (urlObj.searchParams.get('filter') || '').toLowerCase();

      const archivo = path.join(__dirname, 'data', 'evolution-events', `${fecha}.log`);
      if (!fs.existsSync(archivo)) {
        return json(res, 404, { error: `No hay log para ${fecha}`, sugerencia: 'GET /api/evolution-logs para ver fechas disponibles' });
      }

      const lineas = fs.readFileSync(archivo, 'utf8').split('\n').filter(l => l.trim());
      let filtradas = filtro ? lineas.filter(l => l.toLowerCase().includes(filtro)) : lineas;
      const total = filtradas.length;
      filtradas = filtradas.slice(-last);

      const eventos = filtradas.map(linea => {
        const m = linea.match(/^\[([^\]]+)\]\s+(.*)$/);
        if (!m) return { raw: linea };
        try { return { ts: m[1], payload: JSON.parse(m[2]) }; }
        catch { return { ts: m[1], raw: m[2] }; }
      });

      return json(res, 200, { fecha, total_en_archivo: lineas.length, total_filtrado: total, mostrando: eventos.length, eventos });
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
        const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');

        let registros = [];
        try {
          if (fs.existsSync(CAL_FILE))
            registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
        } catch {}

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
        fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
        fs.writeFileSync(CAL_FILE, JSON.stringify(registros, null, 2));

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
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
    fs.writeFileSync(CAL_FILE, JSON.stringify([], null, 2));
    console.log('[calandra] reset completo');
    return json(res, 200, { ok: true, mensaje: 'Calandra limpiada' });
  }

  // ── DELETE /api/calandra/:id — borra un registro ────────────
  if (req.method === 'DELETE' && req.url.startsWith('/api/calandra/')) {
    const id = req.url.split('/')[3];
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    let registros = [];
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
    const antes = registros.length;
    registros = registros.filter(r => String(r.id) !== String(id));
    fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
    fs.writeFileSync(CAL_FILE, JSON.stringify(registros, null, 2));
    console.log(`[calandra] borrado id=${id}, quedaron ${registros.length}/${antes}`);
    return json(res, 200, { ok: true, borrado: antes !== registros.length });
  }

  // ── GET /api/drive-pdfs — todos los PDFs de Drive ordenados por fecha real ──
  if (req.method === 'GET' && req.url === '/api/drive-pdfs') {
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    const WT_FILE  = path.join(__dirname, 'data', 'pendientes-wt.json');
    let registros = [];
    let enviados = new Set();
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
    try {
      if (fs.existsSync(WT_FILE)) {
        const wt = JSON.parse(fs.readFileSync(WT_FILE, 'utf8'));
        const pendientes = (wt.pendientes || []).map(p => p.nombre.toLowerCase());
        // Los que NO están en pendientes fueron enviados
        registros.forEach(r => {
          const nombre = (r.archivo || '').toLowerCase();
          if (!pendientes.includes(nombre)) enviados.add(nombre);
        });
      }
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
    const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
    let registros = [];
    try {
      if (fs.existsSync(CAL_FILE))
        registros = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    } catch {}
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

        const WT_FILE = path.join(__dirname, 'data', 'wetransfer.json');
        let registros = [];
        try {
          if (fs.existsSync(WT_FILE))
            registros = JSON.parse(fs.readFileSync(WT_FILE, 'utf8'));
        } catch {}

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

        registros.push(registro);
        fs.mkdirSync(path.dirname(WT_FILE), { recursive: true });
        fs.writeFileSync(WT_FILE, JSON.stringify(registros, null, 2));

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

  // ── GET /api/wetransfer — devuelve todos los registros ──────
  if (req.method === 'GET' && req.url === '/api/wetransfer') {
    const WT_FILE = path.join(__dirname, 'data', 'wetransfer.json');
    let registros = [];
    try {
      if (fs.existsSync(WT_FILE))
        registros = JSON.parse(fs.readFileSync(WT_FILE, 'utf8'));
    } catch {}
    return json(res, 200, { registros });
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
      const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
      const WT_FILE  = path.join(__dirname, 'data', 'wetransfer.json');
      const IGN_FILE = path.join(__dirname, 'data', 'pdfs-ignorados.json');

      let calandra = [], wt = [], ignorados = { drive: [], wt: [] };
      try { if (fs.existsSync(CAL_FILE)) calandra = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch {}
      try { if (fs.existsSync(WT_FILE)) wt = JSON.parse(fs.readFileSync(WT_FILE, 'utf8')); } catch {}
      try { if (fs.existsSync(IGN_FILE)) ignorados = JSON.parse(fs.readFileSync(IGN_FILE, 'utf8')); } catch {}

      const ignDrive = new Set((ignorados.drive || []).map(String));
      const ignWt    = new Set((ignorados.wt    || []).map(String));

      // Ventana 7 días
      const haceSiete = ahoraMs - 7 * 24 * 60 * 60 * 1000;

      // Pre-filtrar por fecha + ignorados ANTES de cargar pedidos (más liviano).
      const driveRecientes = calandra.filter(r => {
        if (ignDrive.has(String(r.id))) return false;
        const ts = r.modifiedTime || r.createdTime || (r.fecha ? new Date(r.fecha).toISOString() : null);
        if (!ts) return false;
        return new Date(ts).getTime() >= haceSiete;
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

      const items = [];
      for (const r of driveRecientes) {
        if (items.length >= 50) break;
        if (!tieneMatch(r.archivo, r.equipo)) {
          items.push({
            tipo: 'drive',
            id: r.id,
            archivo: r.archivo || '',
            equipo: r.equipo || '',
            ts: r.modifiedTime || r.createdTime || r.fecha || null,
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

  // ── POST /api/pdfs-huerfanos/ignorar ──
  if (req.method === 'POST' && req.url === '/api/pdfs-huerfanos/ignorar') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipo, idItem } = JSON.parse(body);
        if (!tipo || !idItem) return json(res, 400, { error: 'tipo e idItem requeridos' });
        const IGN_FILE = path.join(__dirname, 'data', 'pdfs-ignorados.json');
        let ignorados = { drive: [], wt: [] };
        try { if (fs.existsSync(IGN_FILE)) ignorados = JSON.parse(fs.readFileSync(IGN_FILE, 'utf8')); } catch {}
        if (tipo === 'drive') {
          if (!ignorados.drive.includes(String(idItem))) ignorados.drive.push(String(idItem));
        } else if (tipo === 'wt') {
          if (!ignorados.wt.includes(String(idItem))) ignorados.wt.push(String(idItem));
        }
        fs.mkdirSync(path.dirname(IGN_FILE), { recursive: true });
        fs.writeFileSync(IGN_FILE, JSON.stringify(ignorados, null, 2));
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
    const NUMS_FILE = path.join(__dirname, 'data', 'docsNums.json');
    const HIST_FILE = path.join(__dirname, 'data', 'docsHistorial.json');
    let nums = { nextCot: 210, nextFac: 501 };
    let historial = [];
    try { if (fs.existsSync(NUMS_FILE)) nums = JSON.parse(fs.readFileSync(NUMS_FILE, 'utf8')); } catch {}
    try { if (fs.existsSync(HIST_FILE)) historial = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
    return json(res, 200, { ...nums, historial });
  }

  // ── POST /api/docs/nums — guarda nextCot, nextFac e historial ──
  if (req.method === 'POST' && req.url === '/api/docs/nums') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { nextCot, nextFac, historial } = JSON.parse(body);
        const NUMS_FILE = path.join(__dirname, 'data', 'docsNums.json');
        const HIST_FILE = path.join(__dirname, 'data', 'docsHistorial.json');
        fs.mkdirSync(path.dirname(NUMS_FILE), { recursive: true });
        fs.writeFileSync(NUMS_FILE, JSON.stringify({ nextCot, nextFac }));
        // Merge historial: combinar con lo existente, sin duplicados por id
        if (Array.isArray(historial) && historial.length > 0) {
          let existente = [];
          try { if (fs.existsSync(HIST_FILE)) existente = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
          const todos = [...historial, ...existente];
          const vistos = new Set();
          const merged = todos.filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; });
          merged.sort((a, b) => b.id - a.id);
          fs.writeFileSync(HIST_FILE, JSON.stringify(merged.slice(0, 100), null, 2));
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
        const FILE = path.join(__dirname, 'data', 'pendientes-wt.json');
        const registro = {
          ts: new Date().toISOString(),
          semana: semana || '',
          pendientes,
        };
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(registro, null, 2));
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
    const FILE = path.join(__dirname, 'data', 'pendientes-wt.json');
    let data = { pendientes: [], ts: null };
    try { if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    return json(res, 200, data);
  }

  // ── GET /api/arreglos ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/arreglos') {
    const FILE = path.join(__dirname, 'data', 'arreglos.json');
    let data = [];
    try { if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    return json(res, 200, { arreglos: data });
  }

  // ── POST /api/arreglos — reemplaza lista completa ────────────
  if (req.method === 'POST' && req.url === '/api/arreglos') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { arreglos } = JSON.parse(body);
        if (!Array.isArray(arreglos)) return json(res, 400, { error: 'arreglos debe ser array' });
        const FILE = path.join(__dirname, 'data', 'arreglos.json');
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(arreglos, null, 2));
        return json(res, 200, { ok: true, total: arreglos.length });
      } catch { return json(res, 400, { error: 'JSON inválido' }); }
    });
    return;
  }

  // ── GET /api/satelites ───────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/satelites') {
    const FILE = path.join(__dirname, 'data', 'satelites.json');
    let data = [];
    try { if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    return json(res, 200, { movimientos: data });
  }

  // ── POST /api/satelites — reemplaza lista completa ──────────
  if (req.method === 'POST' && req.url === '/api/satelites') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { movimientos } = JSON.parse(body);
        if (!Array.isArray(movimientos)) return json(res, 400, { error: 'movimientos debe ser array' });
        const FILE = path.join(__dirname, 'data', 'satelites.json');
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(movimientos, null, 2));
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
  const NOTIFS_FILE = path.join(__dirname, 'data', 'notificaciones.json');
  const leerNotifs = () => { try { return JSON.parse(fs.readFileSync(NOTIFS_FILE, 'utf8')); } catch { return []; } };
  const guardarNotifs = arr => { fs.mkdirSync(path.dirname(NOTIFS_FILE), { recursive: true }); fs.writeFileSync(NOTIFS_FILE, JSON.stringify(arr, null, 2)); };

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
  const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
  const leerConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
  const guardarConfig = obj => { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2)); };

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
      const ARR_FILE = path.join(__dirname, 'data', 'arreglos.json');
      const SAT_FILE = path.join(__dirname, 'data', 'satelites.json');
      const CAL_FILE = path.join(__dirname, 'data', 'calandra.json');
      const DOCS_FILE = path.join(__dirname, 'data', 'docsNums.json');
      const arreglos = fs.existsSync(ARR_FILE) ? JSON.parse(fs.readFileSync(ARR_FILE, 'utf8')) : [];
      const satelites = fs.existsSync(SAT_FILE) ? JSON.parse(fs.readFileSync(SAT_FILE, 'utf8')) : [];
      const calandra = fs.existsSync(CAL_FILE) ? JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')) : [];
      const docs = fs.existsSync(DOCS_FILE) ? JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8')) : { historial: [], nextCot: 210, nextFac: 501 };
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
