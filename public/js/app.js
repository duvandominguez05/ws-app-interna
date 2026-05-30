/* ════════════════════════════════════════════════════════════════
   CONSTANTES
════════════════════════════════════════════════════════════════ */
const PRENDAS = ['Camiseta','Uniforme completo','Pantalón','Chaqueta','Buso','Sudadera','Portero acolchado buso','Portero acolchado pantalón','Camiseta adicional'];
const TELAS   = ['Normal','Antifluido','Dry Fit','Camuflada','Colmena','Cuadros'];

const SIGUIENTE = {
  'bandeja':          'hacer-diseno',
  'hacer-diseno':     'confirmado',
  'confirmado':       'enviado-calandra',
  'enviado-calandra': 'llego-impresion',
  'llego-impresion':  'corte',
  'corte':            'costura',
  'costura':          'calidad',
  'en-satelite':      'calidad',
  'calidad':          'listo',
  'listo':            'enviado-final',
};

const ANTERIOR = Object.fromEntries(Object.entries(SIGUIENTE).map(([a, b]) => [b, a]));

const ESTADO_LABELS = {
  'bandeja':           'Bandeja',
  'hacer-diseno':      'Hacer diseño',
  'confirmado':        'Confirmado',
  'enviado-calandra':  'En calandra',
  'llego-impresion':   'Llegó impresión',
  'corte':             'Corte',
  'en-satelite':       'En costura',
  'calidad':           'Revision final',
  'costura':           'Costura',
  'listo':             'Listo',
  'enviado-final':     'Enviado',
};

const ESTADO_BADGE = {
  'bandeja':           'badge-bandeja',
  'hacer-diseno':      'badge-diseno',
  'confirmado':        'badge-diseno',
  'enviado-calandra':  'badge-diseno',
  'llego-impresion':   'badge-produccion',
  'corte':             'badge-produccion',
  'en-satelite':       'badge-produccion',
  'calidad':           'badge-calidad',
  'costura':           'badge-produccion',
  'listo':             'badge-listo',
  'enviado-final':     'badge-enviado',
};

/* ════════════════════════════════════════════════════════════════
   ESTADO
════════════════════════════════════════════════════════════════ */
// Servidor es fuente única de verdad. localStorage = cache de respaldo offline.
let pedidos = JSON.parse(localStorage.getItem('ws_pedidos3') || '[]');
let nextId  = parseInt(localStorage.getItem('ws_nextId3') || '1');
// eliminadosLocales: ids borrados recientemente. Se persiste con TTL para
// evitar que el merge del servidor reviva un pedido recién eliminado.
// 7 días para que aunque otro dispositivo (PC, celu) tarde en sincronizar
// y vuelva a re-subir su cache vieja, no resucite el pedido borrado.
const ELIMINADOS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
function _leerEliminados() {
  try {
    const raw = JSON.parse(localStorage.getItem('ws_eliminados') || '{}');
    const ahora = Date.now();
    const limpio = {};
    Object.entries(raw).forEach(([id, ts]) => {
      if (ahora - ts < ELIMINADOS_TTL_MS) limpio[id] = ts;
    });
    return limpio;
  } catch { return {}; }
}
let _eliminadosMap = _leerEliminados();
const eliminadosLocales = {
  has(id) { return Object.prototype.hasOwnProperty.call(_eliminadosMap, String(id)); },
  add(id) {
    _eliminadosMap[String(id)] = Date.now();
    localStorage.setItem('ws_eliminados', JSON.stringify(_eliminadosMap));
  },
  delete(id) {
    delete _eliminadosMap[String(id)];
    localStorage.setItem('ws_eliminados', JSON.stringify(_eliminadosMap));
  },
  values() { return Object.keys(_eliminadosMap).map(n => parseInt(n, 10)); },
  [Symbol.iterator]() { return this.values()[Symbol.iterator](); }
};
let modalCompletarId = null;
let tipoNuevo = 'cotizar';
let calandraRegistros = JSON.parse(localStorage.getItem('ws_calandra') || '[]');
let calandraAncho     = parseFloat(localStorage.getItem('ws_calandra_ancho') || '1.50');
const SATELITES = ['Marcela', 'Yamile', 'Wilson', 'Cristina'];
let satMovimientos = JSON.parse(localStorage.getItem('ws_satelites') || '[]');
let satTipoActual  = 'entrega';
let miniCosturaPersona = localStorage.getItem('ws_mini_costura_persona') || 'todas';
let miniCosturaVistaPersonal = false;
// Estado de sincronización
let _syncEstado = 'cargando'; // 'cargando' | 'ok' | 'error'
let _syncUltimoTs = 0;

// Rol del usuario actual (legacy: un solo rol activo).
// userRoles es el nuevo array de roles activos de la persona. Permite multi-rol.
let userRol = localStorage.getItem('ws_rol') || 'admin';
let userRoles = []; // se llena cuando se identifica la persona desde /api/personas

// Roster de personas — se inicializa con valores correctos y se actualiza
// dinámicamente desde /api/personas al cargar la app. Alineado con personas.js (server).
let WORKERS = [
  { slug: 'ney',        nombre: 'Ney',        roles: ['ventas', 'diseno'] },
  { slug: 'wendy',      nombre: 'Wendy',      roles: ['ventas', 'diseno'] },
  { slug: 'paola',      nombre: 'Paola',      roles: ['ventas', 'diseno'] },
  { slug: 'betty',      nombre: 'Betty',      roles: ['ventas', 'produccion'] },
  { slug: 'camilo',     nombre: 'Camilo',     roles: ['admin', 'diseno'] },
  { slug: 'graciela',   nombre: 'Graciela',   roles: ['admin'] },
  { slug: 'lidermeyer', nombre: 'Lidermeyer', roles: ['produccion', 'corte'] },
  { slug: 'marcela',    nombre: 'Marcela',    roles: ['costura'] },
  { slug: 'cristina',   nombre: 'Cristina',   roles: ['costura'] },
  { slug: 'wilson',     nombre: 'Wilson',     roles: ['costura'] },
  { slug: 'yamile',     nombre: 'Yamile',     roles: ['costura'] },
];

// Carga WORKERS dinámicamente desde el server (fuente única de verdad: personas.js).
async function _cargarPersonasDesdeServer() {
  try {
    const r = await fetch('/api/personas');
    const data = await r.json();
    if (Array.isArray(data.personas) && data.personas.length > 0) {
      WORKERS = data.personas.map(p => ({ slug: p.slug, nombre: p.nombre, roles: p.roles, color: p.color, emoji: p.emoji }));
      if (typeof renderPersonaChip === 'function') renderPersonaChip();
    }
  } catch (e) { console.warn('[personas] no se pudo cargar del server, usando fallback', e.message); }
}
_cargarPersonasDesdeServer();

// Helpers para roles
function getPersonaActual() {
  const slug = (window.WS_PERSONA && window.WS_PERSONA.slug) || '';
  return WORKERS.find(w => w.slug === slug) || null;
}
function personaTieneRol(rol) {
  const p = getPersonaActual();
  return !!(p && p.roles && p.roles.includes(rol));
}
const ROLE_LABELS = {
  ventas: 'Ventas',
  diseno: 'Diseno',
  produccion: 'Produccion',
  corte: 'Corte',
  admin: 'Admin',
  costura: 'Mi costura',
  // Legacy: mantener para compatibilidad con datos viejos en localStorage
  'costura-personal': 'Mi costura',
};
function cambiarRol() {
  // Legacy: mantenido para compatibilidad con código viejo que aún lee userRol.
  // El selector del header ya no existe; la identidad real viene de window.WS_PERSONA.
  localStorage.setItem('ws_rol', userRol);
  render();
}

// Pinta el chip de persona en el header. Llamar al cargar y tras cambiar persona.
function renderPersonaChip() {
  const chipIcon = document.getElementById('persona-chip-icon');
  const chipText = document.getElementById('persona-chip-text');
  if (!chipText) return;
  const persona = getPersonaActual();
  if (!persona) {
    if (chipIcon) chipIcon.textContent = '👋';
    chipText.textContent = 'Identificarme';
    return;
  }
  if (chipIcon) chipIcon.textContent = persona.emoji || '👤';
  const rolesTxt = (persona.roles || []).map(r => ROLE_LABELS[r] || r).join(' · ');
  chipText.innerHTML = `<strong>${esc(persona.nombre)}</strong>` + (rolesTxt ? ` <span style="opacity:0.7;font-weight:500;">· ${esc(rolesTxt)}</span>` : '');
  // Setear userRol automaticamente al primer rol de la persona (para compat con codigo viejo)
  if (persona.roles && persona.roles[0]) {
    userRol = persona.roles[0];
    localStorage.setItem('ws_rol', userRol);
  }
}

// Modal: seleccionar/cambiar persona
function abrirSelectorPersona() {
  const actual = getPersonaActual();
  const m = document.createElement('div');
  m.id = 'modal-selector-persona';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
  const personasHtml = (WORKERS || []).map(p => {
    const sel = actual && actual.slug === p.slug;
    const rolesTxt = (p.roles || []).map(r => ROLE_LABELS[r] || r).join(' · ');
    return `<button onclick="seleccionarPersona('${p.slug}','${esc(p.nombre).replace(/'/g, "\\'")}')" style="
      background:${sel ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.04)'};
      border:1px solid ${sel ? p.color || '#a78bfa' : 'rgba(255,255,255,0.08)'};
      border-radius:10px;
      padding:14px 16px;
      text-align:left;
      color:#fff;
      cursor:pointer;
      display:flex;
      align-items:center;
      gap:12px;
      font-size:0.92rem;
      width:100%;
      transition:transform 0.1s;
    " onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='translateY(0)'">
      <span style="font-size:1.4rem;">${p.emoji || '👤'}</span>
      <div style="flex:1;">
        <div style="font-weight:700;">${esc(p.nombre)}${sel ? ' ✓' : ''}</div>
        <div style="font-size:0.72rem;opacity:0.7;margin-top:2px;">${esc(rolesTxt)}</div>
      </div>
    </button>`;
  }).join('');
  m.innerHTML = `
    <div style="background:#1a1d2e;border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:22px;max-width:460px;width:100%;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <h3 style="margin:0;color:#fff;font-size:1.05rem;">¿Quién eres?</h3>
        <button onclick="document.getElementById('modal-selector-persona').remove()" style="background:none;border:none;color:#9ca3af;font-size:1.5rem;cursor:pointer;">×</button>
      </div>
      <div style="font-size:0.78rem;color:#9ca3af;margin-bottom:14px;">Selecciona tu nombre para que la app te muestre lo tuyo:</div>
      <div style="display:flex;flex-direction:column;gap:8px;">${personasHtml}</div>
      ${actual ? `<button onclick="cerrarSesionPersona()" style="margin-top:14px;width:100%;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;padding:10px;border-radius:8px;font-size:0.82rem;cursor:pointer;">🚪 Cerrar sesión</button>` : ''}
    </div>
  `;
  document.body.appendChild(m);
}

function seleccionarPersona(slug, nombre) {
  try {
    localStorage.setItem('ws_persona', slug);
    localStorage.setItem('ws_persona_nombre', nombre);
    // Recargar la página para que window.WS_PERSONA tome el cambio y todo se rearme
    window.location.href = '/#/mi-dia';
    setTimeout(() => window.location.reload(), 100);
  } catch (e) { alert('Error: ' + e.message); }
}

function cerrarSesionPersona() {
  if (!confirm('¿Cerrar sesión? Tendrás que volver a identificarte.')) return;
  try {
    localStorage.removeItem('ws_persona');
    localStorage.removeItem('ws_persona_nombre');
    window.location.reload();
  } catch (e) {}
}

// Inicializar al cargar
document.addEventListener('DOMContentLoaded', () => {
  // Pintar chip; reintentar al cargar WORKERS desde server
  renderPersonaChip();
  setTimeout(renderPersonaChip, 800);
  setTimeout(renderPersonaChip, 2000);
});


/* ════════════════════════════════════════════════════════════════
   PERSISTENCIA
════════════════════════════════════════════════════════════════ */
function getMesActual() {
  const n = new Date();
  return `${n.getFullYear()}-${n.getMonth()}`;
}

function limpiarEnviadosDelMesPasado() {
  const mesGuardado = localStorage.getItem('ws_mes') || getMesActual();
  const mesActual   = getMesActual();
  if (mesGuardado !== mesActual) {
    // Nuevo mes: borrar todos los pedidos en enviado-final
    pedidos = pedidos.filter(p => p.estado !== 'enviado-final');
    localStorage.setItem('ws_mes', mesActual);
    guardar();
  } else {
    localStorage.setItem('ws_mes', mesActual);
  }
}

function guardar() {
  localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
  localStorage.setItem('ws_nextId3', String(nextId));
  // Sincronizar con servidor y RECIBIR DE VUELTA la lista mergeada.
  // Si el server preservó/agregó pedidos (origenBot, origenFacturaHuerfana, etc),
  // actualizamos localStorage para que el tablero NO siga mostrando cache vieja.
  fetch('/api/pedidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pedidos, nextId, eliminados: [...eliminadosLocales] })
  }).then(r => r.ok ? r.json() : null).then(resp => {
    if (!resp || !Array.isArray(resp.pedidos)) return;
    const idsLocales = new Set(pedidos.map(p => p.id));
    const agregadosPorServer = resp.pedidos.filter(p => !idsLocales.has(p.id));
    if (agregadosPorServer.length === 0) return;
    // Server agregó pedidos que el cliente no tenía -> merge y re-render
    console.log(`[guardar] server agregó ${agregadosPorServer.length} pedido(s) preservados: ${agregadosPorServer.map(p => '#' + p.id).join(', ')}`);
    pedidos = resp.pedidos;
    if (resp.nextId && resp.nextId > nextId) nextId = resp.nextId;
    localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
    localStorage.setItem('ws_nextId3', String(nextId));
    try { render(); } catch (e) { console.error('[guardar re-render]', e); }
  }).catch(() => {}); // silencioso — no interrumpe si falla
}

/* ════════════════════════════════════════════════════════════════
   NAVEGACIÓN
════════════════════════════════════════════════════════════════ */
const HEADER_INFO = {
  'mi-dia':            { icon: '☀️', title: 'Mi Día' },
  'mobile-role-hub':   { icon: '📱', title: 'Areas moviles' },
  'vista-general': { icon: '📊', title: 'Vista general' },
  'torre':         { icon: '🗼', title: 'Torre de Control' },
  'pdfs-huerfanos':{ icon: '📎', title: 'PDFs sin asignar' },
  'tablero-principal': { icon: '📋', title: 'Tablero W&S' },
  'torre-unificada':   { icon: '🗼', title: 'Torre de Control' },
  'bandeja':       { icon: '💼', title: 'Ventas' },
  'diseno':        { icon: '🎨', title: 'Diseño' },
  'produccion':    { icon: '🏭', title: 'Producción' },
  'arreglos':      { icon: '🔧', title: 'Control de arreglos' },
  'wetransfer':    { icon: '📤', title: 'WeTransfer' },
  'calandra':      { icon: '📏', title: 'Calandra' },
  'satelites':     { icon: '🧵', title: 'Satélites de costura' },
  'cotizaciones':  { icon: '🧾', title: 'Facturas y Cotizaciones' },
};

function showSection(id, navEl) {
  document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (navEl) navEl.classList.add('active');

  // Ajuste de Sidebar para TV
  const sidebar = document.getElementById('sidebar');
  if (id === 'torre-tv') {
    sidebar.classList.add('hidden');
    document.body.classList.add('no-sidebar');
  } else {
    sidebar.classList.remove('hidden');
    document.body.classList.remove('no-sidebar');
  }

  const info = HEADER_INFO[id] || {};
  document.getElementById('header-icon').textContent      = info.icon || '';
  document.getElementById('header-title-text').textContent = info.title || '';

  closeSidebar();
  render();
  if (id === 'mi-dia' && typeof renderMiDia === 'function') {
    try { renderMiDia(); } catch (e) { console.error('[mi-dia]', e); }
  }
}

function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebarOverlay');
  const isOpen   = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    sidebar.classList.add('open');
    overlay.classList.add('open');
    actualizarPersonaSidebar(); // refrescar info de persona al abrir
  }
}

// Pinta en el bloque del sidebar quien esta conectado para no perderse.
function actualizarPersonaSidebar() {
  const cont = document.getElementById('sidebar-persona-info');
  if (!cont) return;
  const persona = getPersonaActual();
  if (!persona) {
    cont.removeAttribute('data-active');
    cont.style.display = 'none';
    return;
  }
  cont.setAttribute('data-active', 'true');
  cont.style.display = 'block';
  const nombreEl = document.getElementById('sidebar-persona-nombre');
  const rolEl    = document.getElementById('sidebar-persona-rol');
  if (nombreEl) nombreEl.textContent = (persona.emoji ? persona.emoji + ' ' : '') + persona.nombre;
  if (rolEl) {
    const roles = (persona.roles || []).map(r => ROLE_LABELS[r] || r).join(' · ');
    rolEl.textContent = roles || '—';
  }
}
// Llamar al cargar para que arranque visible si ya hay persona
setTimeout(actualizarPersonaSidebar, 500);

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

/* ════════════════════════════════════════════════════════════════
   RENDER PRINCIPAL
════════════════════════════════════════════════════════════════ */
function abrirRolMovil(rol) {
  localStorage.setItem('ws_mobile_last_role', rol);
  if (rol === 'produccion') {
    location.href = '/produccion.html';
    return;
  }
  if (rol === 'admin') {
    document.body.classList.remove('modo-miniapp');
    showSection('tablero-principal', null);
    return;
  }
  const destino = rol === 'ventas' ? 'bandeja' : rol === 'diseno' ? 'diseno' : 'satelites';
  modoMiniApp(destino);
  showSection(destino, null);
}

function abrirWorkerRole(nombre, rol) {
  localStorage.setItem('ws_worker_actual', nombre || '');
  // 'costura' (oficial) y 'costura-personal' (legacy) llevan al mismo lugar
  if (rol === 'costura' || rol === 'costura-personal') {
    abrirCosturera(nombre);
    return;
  }
  if (rol === 'admin') {
    localStorage.setItem('ws_rol', 'admin');
    userRol = 'admin';
  } else if (rol === 'diseno') {
    localStorage.setItem('ws_rol', 'diseno');
    userRol = 'diseno';
  } else if (rol === 'ventas') {
    localStorage.setItem('ws_rol', 'ventas');
    userRol = 'ventas';
  } else if (rol === 'produccion') {
    localStorage.setItem('ws_rol', 'produccion');
    userRol = 'produccion';
  }
  abrirRolMovil(rol);
}

function renderMobileQuickAccess() {
  const cont = document.getElementById('mobile-quick-access');
  if (!cont) return;
  // Si la persona ya está identificada, mostrar acceso directo a Mi Día (lo principal)
  const personaActual = getPersonaActual();
  if (personaActual) {
    cont.innerHTML = `<button class="mobile-quick-card" onclick="window.location.hash='#/mi-dia';showSection('mi-dia',null);renderMiDia();" style="background:linear-gradient(135deg,${personaActual.color || '#a78bfa'} 0%, #6366f1 100%);"><small>${esc(personaActual.nombre)}</small><strong>☀️ Mi Día</strong></button>`;
    return;
  }
  const rol = localStorage.getItem('ws_mobile_last_role');
  if (rol && rol.startsWith('costura-')) {
    const costurera = costureraDesdeSlug(rol.replace('costura-', ''));
    if (costurera) {
      cont.innerHTML = `<button class="mobile-quick-card" onclick="abrirCosturera('${costurera}')"><small>Acceso rapido</small><strong>Entrar como ${costurera}</strong></button>`;
      return;
    }
  }
  const labels = {
    ventas: 'Ventas',
    diseno: 'Diseno',
    produccion: 'Produccion',
    satelites: 'Costura',
    admin: 'Admin'
  };
  if (!rol || !labels[rol]) {
    cont.innerHTML = '';
    return;
  }
  cont.innerHTML = `<button class="mobile-quick-card" onclick="abrirRolMovil('${rol}')"><small>Acceso rapido</small><strong>Entrar a ${labels[rol]}</strong></button>`;
}

function renderStaffAccess() {
  const cont = document.getElementById('mobile-staff-access');
  if (!cont) return;
  cont.innerHTML = `
    <div class="mobile-staff-panel">
      <div class="mobile-staff-title">Entrar por trabajador</div>
      <div class="mobile-staff-grid">
        ${WORKERS.map(w => `
          <div class="mobile-staff-card">
            <strong>${esc(w.nombre)}</strong>
            <div class="mobile-staff-actions">
              ${w.roles.map(r => `<button onclick="abrirWorkerRole('${esc(w.nombre)}','${r}')">${ROLE_LABELS[r] || r}</button>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function miniEnsure(sectionId, html) {
  const section = document.getElementById(sectionId);
  if (!section) return null;
  let screen = section.querySelector('.mini-role-screen');
  if (!screen) {
    screen = document.createElement('div');
    screen.className = 'mini-role-screen';
    section.prepend(screen);
  }
  screen.innerHTML = html;
  return screen;
}

function miniStats(items) {
  return items.map(([num, label]) => `
    <div class="mini-stat"><strong>${num}</strong><span>${esc(label)}</span></div>
  `).join('');
}

function miniCard(p, options = {}) {
  const nombre = esc(p.equipo || p.telefono || 'Pedido sin nombre');
  const meta = [
    p.fechaEntrega ? `Entrega: ${fmtFecha(p.fechaEntrega)}` : '',
    p.vendedora ? `Venta: ${p.vendedora}` : '',
    p.disenadorAsignado ? `Diseno: ${p.disenadorAsignado}` : '',
    ESTADO_LABELS[p.estado] || p.estado || ''
  ].filter(Boolean).map(x => `<span class="mini-chip">${esc(x)}</span>`).join('');
  return `
    <article class="mini-card ${options.clase || ''}">
      <div class="mini-card-head">
        <div class="mini-card-name">${nombre}</div>
        <div class="mini-card-id">#${p.id}</div>
      </div>
      <div class="mini-card-meta">${meta}</div>
      ${options.next ? `<div class="mini-next"><span>Siguiente paso</span><strong>${esc(options.next)}</strong></div>` : ''}
      ${options.body || ''}
      ${options.actions || ''}
    </article>
  `;
}

function renderMiniRoleViews() {
  renderInstallCard();
  renderMobileQuickAccess();
  renderPersonalApps();
  renderStaffAccess();
  renderMiniVentas();
  renderMiniDiseno();
  renderMiniCostura();
}

/* ════════════════════════════════════════════════════════════════
   MI DÍA — vista unificada por persona con bloques por cada rol
   Camilo (admin+diseno) ve ambos bloques en una sola pantalla.
   Ney/Wendy/Paola (ventas+diseno) ven sus ventas + sus diseños.
   Betty (ventas+produccion), Lidermeyer (produccion+corte), etc.
════════════════════════════════════════════════════════════════ */
function _miDiaActivos() {
  return pedidos.filter(p => p.estado !== 'enviado-final' && p.estado !== 'archivado');
}

// Cache de arreglos (compartido en Mi Día).
let _miDiaArreglos = [];
async function _miDiaCargarArreglos() {
  try {
    const r = await fetch('/api/arreglos');
    const d = await r.json();
    _miDiaArreglos = Array.isArray(d.arreglos) ? d.arreglos : [];
  } catch (e) { _miDiaArreglos = []; }
}

function _miDiaBloqueArreglos(nombrePersona, vistaCompleta) {
  // vistaCompleta = true para Lidermeyer (todos los pendientes)
  // vistaCompleta = false para diseñadores (solo los suyos)
  const pendientes = _miDiaArreglos.filter(a => !a.resuelto);
  const mios = vistaCompleta ? pendientes : pendientes.filter(a => a.disenador === nombrePersona);
  const cards = mios.slice(0, 15).map(a => `
    <div class="midia-card warn" onclick="${a.pedidoId ? `irAlPedido(${a.pedidoId})` : `showSection('arreglos', null)`}">
      <div class="midia-card-name">🔧 ${esc(a.equipo)}</div>
      <div class="midia-card-meta">Falta: ${esc(a.faltante)} ${vistaCompleta ? '· ' + esc(a.disenador) : ''}</div>
    </div>
  `).join('') || '<div class="midia-empty">Sin arreglos pendientes. 🎉</div>';
  return `
    <article class="midia-bloque" style="--bloque-color:#ef4444;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">🔧</span>
        <div>
          <h2>Arreglos pendientes</h2>
          <small>${mios.length} ${vistaCompleta ? 'sin resolver' : 'asignados a ti'}</small>
        </div>
      </header>
      <div class="midia-cards">${cards}</div>
      <div class="midia-actions">
        <button class="midia-btn" onclick="showSection('arreglos', null)">Ver tablero de arreglos</button>
      </div>
    </article>
  `;
}

function _miDiaBloqueEntregasHoy() {
  const hoyStr = new Date().toISOString().slice(0, 10);
  const hoy = _miDiaActivos().filter(p => (p.fechaEntrega || '').slice(0, 10) === hoyStr);
  if (!hoy.length) return '';
  const cards = hoy.slice(0, 8).map(p => `
    <div class="midia-card warn" onclick="irAlPedido(${p.id})">
      <div class="midia-card-name">⏰ #${p.id} ${esc(p.equipo || p.telefono || 'Sin equipo')}</div>
      <div class="midia-card-meta">${ESTADO_LABELS[p.estado] || p.estado} · ${esc(p.vendedora || '—')}</div>
    </div>
  `).join('');
  return `
    <article class="midia-bloque" style="--bloque-color:#fbbf24;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">⏰</span>
        <div>
          <h2>Entregas para HOY</h2>
          <small>${hoy.length} pedidos con fecha de entrega hoy</small>
        </div>
      </header>
      <div class="midia-cards">${cards}</div>
    </article>
  `;
}

function _miDiaBloqueAdmin() {
  const activos = _miDiaActivos();
  const sinSticker = activos.filter(p => p.estado === 'bandeja' && !p.stickerVenta).length;
  const enDiseno = activos.filter(p => p.estado === 'hacer-diseno').length;
  const enProd = activos.filter(p => ['enviado-calandra','llego-impresion','corte','calidad','costura'].includes(p.estado)).length;
  const listos = activos.filter(p => p.estado === 'listo').length;
  return `
    <article class="midia-bloque" style="--bloque-color:#a78bfa;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">👑</span>
        <div>
          <h2>Admin</h2>
          <small>Visión general del taller</small>
        </div>
      </header>
      <div class="midia-kpis">
        <div class="midia-kpi"><strong>${activos.length}</strong><span>Activos</span></div>
        <div class="midia-kpi"><strong>${enDiseno}</strong><span>En diseño</span></div>
        <div class="midia-kpi"><strong>${enProd}</strong><span>En producción</span></div>
        <div class="midia-kpi"><strong>${listos}</strong><span>Listos</span></div>
        <div class="midia-kpi ${sinSticker ? 'alert' : ''}"><strong>${sinSticker}</strong><span>Sin sticker</span></div>
      </div>
      <div class="midia-actions">
        <button class="midia-btn" onclick="showSection('tablero-principal', null); window.location.hash='';">📋 Tablero</button>
        <button class="midia-btn" onclick="showSection('torre-unificada', null); renderTorreUnificada(); window.location.hash='';">🗼 Torre</button>
        <button class="midia-btn" onclick="showSection('vista-general', null); window.location.hash='';">📊 Vista general</button>
        <button class="midia-btn" style="background:rgba(34,197,94,0.18);border-color:rgba(34,197,94,0.4);color:#86efac;" onclick="abrirPanelAdmin()">⚙️ Panel admin</button>
      </div>
    </article>
  `;
}

// Modal con acciones de admin: onboarding masivo, backup, etc.
function abrirPanelAdmin() {
  const overlay = document.createElement('div');
  overlay.id = 'modal-panel-admin';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  const opciones = (WORKERS || []).map(w => `<option value="${esc(w.slug)}">${esc(w.nombre)} (${(w.roles||[]).join(', ')})</option>`).join('');
  overlay.innerHTML = `
    <div style="background:#1e1b2e;border:1px solid rgba(124,58,237,0.4);border-radius:14px;padding:24px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <h2 style="margin:0;font-family:'Outfit',sans-serif;font-size:1.3rem;font-weight:800;color:#fff;">⚙️ Panel Admin</h2>
        <button onclick="document.getElementById('modal-panel-admin').remove()" style="background:transparent;border:none;color:#94a3b8;font-size:1.4rem;cursor:pointer;">✕</button>
      </div>

      <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.25);border-radius:10px;padding:14px;margin-bottom:14px;">
        <div style="font-weight:700;color:#c4b5fd;margin-bottom:10px;font-size:0.95rem;">📨 Onboarding por WhatsApp</div>
        <div style="font-size:0.75rem;color:#94a3b8;margin-bottom:10px;">
          Manda el link personal de instalación a una persona o a TODAS las que tengan número configurado en Railway.
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <select id="onb-persona-select" style="flex:1;background:#0f0d1a;border:1px solid #4c1d95;border-radius:7px;color:#e2e8f0;font-size:0.82rem;padding:7px 9px;outline:none;">
            <option value="">— Seleccionar persona —</option>
            ${opciones}
          </select>
          <button onclick="enviarOnboardingUno()" style="background:rgba(96,165,250,0.18);border:1px solid rgba(96,165,250,0.4);color:#93c5fd;border-radius:7px;padding:7px 14px;font-size:0.78rem;font-weight:600;cursor:pointer;white-space:nowrap;">📨 Enviar</button>
        </div>
        <button onclick="enviarOnboardingTodos()" style="width:100%;background:#22c55e;border:none;color:#fff;border-radius:8px;padding:10px;font-size:0.85rem;font-weight:700;cursor:pointer;">
          📢 Enviar a TODAS las personas con número
        </button>
      </div>

      <div style="background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.25);border-radius:10px;padding:14px;margin-bottom:14px;">
        <div style="font-weight:700;color:#93c5fd;margin-bottom:10px;font-size:0.95rem;">💾 Backup BD a Drive</div>
        <div style="font-size:0.75rem;color:#94a3b8;margin-bottom:10px;">
          El backup nocturno corre a las 2 AM. Aquí puedes forzar uno manual ahora.
        </div>
        <button onclick="forzarBackup()" style="width:100%;background:rgba(96,165,250,0.25);border:1px solid rgba(96,165,250,0.5);color:#93c5fd;border-radius:8px;padding:10px;font-size:0.85rem;font-weight:700;cursor:pointer;">
          💾 Hacer backup ahora
        </button>
      </div>

      <div style="background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.25);border-radius:10px;padding:14px;">
        <div style="font-weight:700;color:#c4b5fd;margin-bottom:10px;font-size:0.95rem;">🔄 Sincronización Gmail + Drive</div>
        <div style="font-size:0.75rem;color:#94a3b8;margin-bottom:10px;">
          Los cron corren automáticos (Gmail cada 5 min, Drive cada 10 min). Click para forzar ahora.
        </div>
        <button onclick="syncCalandraManual();document.getElementById('modal-panel-admin').remove();" style="width:100%;background:rgba(124,58,237,0.25);border:1px solid rgba(124,58,237,0.5);color:#c4b5fd;border-radius:8px;padding:10px;font-size:0.85rem;font-weight:700;cursor:pointer;">
          🔄 Sincronizar Gmail + Drive
        </button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function enviarOnboardingUno() {
  const sel = document.getElementById('onb-persona-select');
  const slug = sel ? sel.value : '';
  if (!slug) return toast('Selecciona una persona', 'warning');
  if (!confirm(`¿Enviar mensaje de onboarding a ${slug} por WhatsApp?`)) return;
  toast('Enviando…', 'info');
  try {
    const r = await fetch('/api/onboarding/enviar-uno', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'falló');
    if (d.sent) {
      toast(`✅ Onboarding enviado a ${slug}`, 'success');
    } else {
      toast(`⚠️ ${slug} no tiene número configurado en Railway (env WA_${slug.toUpperCase()})`, 'warning');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function enviarOnboardingTodos() {
  if (!confirm('¿Enviar el mensaje de onboarding a TODAS las personas con número configurado?\n\nEsto manda WhatsApp con su link personal.')) return;
  toast('Enviando onboarding masivo…', 'info');
  try {
    const r = await fetch('/api/onboarding/enviar-todos', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'falló');
    const enviados = (d.enviados || []).length;
    const sin = (d.sinNumero || []).length;
    toast(`✅ Enviados: ${enviados}. Sin número: ${sin}`, 'success');
    console.log('[onboarding] Enviados:', d.enviados, 'Sin número:', d.sinNumero);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function forzarBackup() {
  if (!confirm('¿Hacer backup de la BD a Drive AHORA?')) return;
  toast('Haciendo backup… (puede tardar 30s)', 'info');
  try {
    const r = await fetch('/api/backup/forzar', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'falló');
    toast(`✅ Backup creado: ${d.titulo} (${(d.size/1024/1024).toFixed(2)} MB)`, 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function _miDiaBloqueDiseno(nombrePersona) {
  const mios = _miDiaActivos().filter(p => p.estado === 'hacer-diseno' && p.disenadorAsignado === nombrePersona);
  const sinAsignar = _miDiaActivos().filter(p => p.estado === 'hacer-diseno' && !p.disenadorAsignado);
  const cards = mios.slice(0, 10).map(p => {
    const urg = _urgenciaFechaCorta(p.fechaEntrega);
    return '<div class="midia-card" onclick="abrirDetallePedido(' + p.id + ')">'
      + '<div class="midia-card-name">' + esc(p.equipo || 'Cliente +57 ' + (p.telefono || '?')) + '</div>'
      + '<div class="midia-card-meta">🛍️ ' + esc(p.vendedora || '—') + (urg ? ' · ' + urg : '') + '</div>'
    + '</div>';
  }).join('') || (sinAsignar.length
      ? `<div class="midia-empty">
          <div style="margin-bottom:14px;">No tienes ningún diseño asignado todavía.<br>Hay <strong>${sinAsignar.length} en cola sin asignar</strong>.</div>
          <button class="midia-btn" style="background:linear-gradient(180deg,#fb923c 0%,#ea580c 100%);border:none;color:#fff;font-weight:800;padding:14px 22px;font-size:0.95rem;box-shadow:0 4px 14px rgba(251,146,60,0.35);min-height:48px;" onclick="tomarProximoDiseno()">🎨 Tomar próximo diseño en cola</button>
        </div>`
      : '<div class="midia-empty">✅ Sin diseños pendientes. Todo al día.</div>');
  // Boton tomar otro arriba de la lista cuando ya tiene asignados Y hay sin asignar
  const tomarMas = (mios.length > 0 && sinAsignar.length > 0)
    ? `<button class="midia-btn" style="background:rgba(251,146,60,0.15);border:1px solid rgba(251,146,60,0.40);color:#fb923c;font-weight:700;margin-bottom:10px;font-size:0.85rem;" onclick="tomarProximoDiseno()">🎨 Tomar uno más de la cola (${sinAsignar.length} disponibles)</button>`
    : '';
  return `
    <article class="midia-bloque" style="--bloque-color:#fb923c;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">🎨</span>
        <div>
          <h2>Mis diseños</h2>
          <small>${mios.length} asignados · ${sinAsignar.length} sin asignar en cola</small>
        </div>
      </header>
      ${tomarMas}
      <div class="midia-cards">${cards}</div>
      <div class="midia-actions">
        <button class="midia-btn" onclick="showSection('diseno', null);">Ver todos los diseños</button>
      </div>
    </article>
  `;
}

// Asigna el proximo diseño en cola al usuario actual.
// Toma el más urgente (fechaEntrega más cercana o vencida).
async function tomarProximoDiseno() {
  const persona = getPersonaActual();
  if (!persona) { toast('No se identifica tu persona', 'error'); return; }
  const cola = _miDiaActivos()
    .filter(p => p.estado === 'hacer-diseno' && !p.disenadorAsignado)
    .sort((a, b) => {
      // Más urgente primero (fecha más cercana o vencida)
      const fa = a.fechaEntrega ? new Date(a.fechaEntrega).getTime() : Infinity;
      const fb = b.fechaEntrega ? new Date(b.fechaEntrega).getTime() : Infinity;
      return fa - fb;
    });
  if (!cola.length) {
    toast('No hay diseños sin asignar en cola', 'info');
    return;
  }
  const p = cola[0];
  // Confirmacion inline (no popup feo)
  const ok = confirm(`¿Tomar el diseño de "${p.equipo || p.telefono || ('#' + p.id)}"?\n\nVendedora: ${p.vendedora || '—'}\nEntrega: ${p.fechaEntrega || 'sin fecha'}`);
  if (!ok) return;
  try {
    const r = await fetch('/api/pedidos/' + p.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disenadorAsignado: persona.nombre }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    toast(`🎨 Diseño tomado: ${p.equipo || '#' + p.id}`, 'success');
    // Refrescar pedidos locales y re-render
    if (typeof resincronizarConServidor === 'function') {
      try { await resincronizarConServidor(); } catch (e) {}
    }
    renderMiDia();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Helper para barra de pago (solo se renderiza si la persona puede ver finanzas).
function _barraPago(p, puedeVerFinanzas) {
  if (!puedeVerFinanzas) return '';
  if (typeof p.total !== 'number' || p.total <= 0) return '';
  const abonado = typeof p.abonado === 'number' ? p.abonado : 0;
  const pct = Math.min(100, Math.round((abonado / p.total) * 100));
  const completo = abonado >= p.total;
  const colorBar = completo ? '#34d399' : (pct >= 50 ? '#fbbf24' : '#fca5a5');
  const fmt = (n) => '$' + Math.round(n || 0).toLocaleString('es-CO');
  return `<div style="margin-top:6px;background:rgba(255,255,255,0.04);border-radius:6px;padding:6px 8px;">
    <div style="display:flex;justify-content:space-between;font-size:0.66rem;color:var(--text-muted);font-weight:600;margin-bottom:3px;">
      <span>${fmt(abonado)} / ${fmt(p.total)}</span>
      <span style="color:${colorBar};font-weight:800;">${completo ? '✓ pagado' : pct + '%'}</span>
    </div>
    <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:999px;overflow:hidden;">
      <div style="height:100%;background:${colorBar};width:${pct}%;transition:width 200ms;"></div>
    </div>
  </div>`;
}

// Una persona puede ver finanzas del pedido si:
// - Es admin (Camilo, Graciela)
// - Es la vendedora dueña del pedido
function _puedeVerFinanzas(p) {
  const persona = getPersonaActual();
  if (!persona) return false;
  if ((persona.roles || []).includes('admin')) return true;
  if (p.vendedora && p.vendedora === persona.nombre) return true;
  return false;
}

function _miDiaBloqueVentas(nombrePersona) {
  const mias = _miDiaActivos().filter(p => p.vendedora === nombrePersona);
  const hoyStr = new Date().toISOString().slice(0,10);
  const hoy = mias.filter(p => (p.fechaVenta || '').slice(0,10) === hoyStr);
  const sinSticker = mias.filter(p => p.estado === 'bandeja' && !p.stickerVenta);
  const cards = mias.slice(0, 10).map(p => {
    const isWarn = p.estado === 'bandeja' && !p.stickerVenta;
    const urgenciaTxt = _urgenciaFechaCorta(p.fechaEntrega);
    const estadoLabel = ESTADO_LABELS[p.estado] || p.estado;
    // Es SU venta → puede ver finanzas del pedido
    return '<div class="midia-card' + (isWarn ? ' warn' : '') + '" onclick="abrirDetallePedido(' + p.id + ')">'
      + '<div class="midia-card-name">' + esc(p.equipo || 'Cliente +57 ' + (p.telefono || '?')) + '</div>'
      + '<div class="midia-card-meta">'
        + '<span style="background:rgba(124,58,237,0.18);color:#c4b5fd;padding:1px 7px;border-radius:6px;font-weight:600;font-size:0.65rem;">' + estadoLabel + '</span>'
        + (p.telefono ? ' · 📱 ' + esc(p.telefono) : '')
        + (urgenciaTxt ? ' · ' + urgenciaTxt : '')
        + (isWarn ? ' · <span style="color:#fcd34d;font-weight:700;">⚠️ Falta sticker</span>' : '')
      + '</div>'
      + _barraPago(p, true) // siempre ven barra en su propia venta
    + '</div>';
  }).join('') || '<div class="midia-empty">✨ Sin ventas registradas todavia. Cuando llegue un comprobante por WA aparece aqui.</div>';
  // Mini resumen "por cobrar" — solo si hay pedidos con total y saldo
  const conSaldo = mias.filter(p => typeof p.total === 'number' && p.total > 0 && (p.abonado || 0) < p.total && p.estado !== 'enviado-final');
  const saldoTotal = conSaldo.reduce((s, p) => s + (p.total - (p.abonado || 0)), 0);
  const cobrarBlock = conSaldo.length > 0
    ? `<div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:0.66rem;text-transform:uppercase;letter-spacing:1px;color:#fbbf24;font-weight:800;">💰 Por cobrar</div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;">${conSaldo.length} pedido${conSaldo.length !== 1 ? 's' : ''} con saldo</div>
          </div>
          <div style="font-size:1.15rem;font-weight:800;color:#fcd34d;font-variant-numeric:tabular-nums;">$${Math.round(saldoTotal).toLocaleString('es-CO')}</div>
        </div>
      </div>`
    : '';

  return `
    <article class="midia-bloque" style="--bloque-color:#34d399;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">💼</span>
        <div>
          <h2>Mis ventas</h2>
          <small>${hoy.length} hoy · ${mias.length} activas ${sinSticker.length ? ' · ⚠️ '+sinSticker.length+' sin sticker' : ''}</small>
        </div>
      </header>
      ${cobrarBlock}
      <div class="midia-cards">${cards}</div>
      <div class="midia-actions">
        <button class="midia-btn" onclick="abrirRolMovil('ventas')">Ver todas mis ventas</button>
      </div>
    </article>
  `;
}

// Devuelve texto corto de urgencia para mostrar en cards (ej. "🚨 vencido 2d", "🔥 hoy", "⏰ 3d")
function _urgenciaFechaCorta(fechaEntrega) {
  if (!fechaEntrega) return '';
  const d = Math.ceil((new Date(fechaEntrega).getTime() - Date.now()) / 86400000);
  if (d < 0) return '<span style="color:#fca5a5;font-weight:700;">🚨 ' + Math.abs(d) + 'd venc</span>';
  if (d === 0) return '<span style="color:#fca5a5;font-weight:700;">🔥 HOY</span>';
  if (d <= 2) return '<span style="color:#fcd34d;font-weight:600;">🔥 ' + d + 'd</span>';
  if (d <= 5) return '<span style="color:#fde68a;">⏰ ' + d + 'd</span>';
  return '<span style="color:var(--text-muted);">📅 ' + d + 'd</span>';
}

function _miDiaBloqueProduccion() {
  const enProd = _miDiaActivos().filter(p => ['enviado-calandra','llego-impresion','corte','calidad','costura','listo'].includes(p.estado));
  const cards = enProd.slice(0, 10).map(p => {
    const urg = _urgenciaFechaCorta(p.fechaEntrega);
    return '<div class="midia-card" onclick="abrirDetallePedido(' + p.id + ')">'
      + '<div class="midia-card-name">' + esc(p.equipo || 'Cliente +57 ' + (p.telefono || '?')) + '</div>'
      + '<div class="midia-card-meta">'
        + '<span style="background:rgba(103,232,249,0.15);color:#67e8f9;padding:1px 7px;border-radius:6px;font-size:0.65rem;font-weight:600;">' + (ESTADO_LABELS[p.estado] || p.estado) + '</span>'
        + (urg ? ' · ' + urg : '')
      + '</div>'
    + '</div>';
  }).join('') || '<div class="midia-empty">✅ Sin pedidos en produccion. ¡Equipo al dia!</div>';
  return `
    <article class="midia-bloque" style="--bloque-color:#67e8f9;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">🏭</span>
        <div>
          <h2>Producción</h2>
          <small>${enProd.length} pedidos activos</small>
        </div>
      </header>
      <div class="midia-cards">${cards}</div>
      <div class="midia-actions">
        <button class="midia-btn" onclick="location.href='/produccion.html'">📱 Tablet de producción</button>
      </div>
    </article>
  `;
}

function _miDiaBloqueCorte() {
  const enCorte = _miDiaActivos().filter(p => p.estado === 'corte');
  return `
    <article class="midia-bloque" style="--bloque-color:#f59e0b;">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">✂️</span>
        <div>
          <h2>Corte</h2>
          <small>${enCorte.length} en corte</small>
        </div>
      </header>
      <div class="midia-cards">${enCorte.slice(0, 10).map(p => `
        <div class="midia-card" onclick="irAlPedido(${p.id})">
          <div class="midia-card-name">#${p.id} ${esc(p.equipo || p.telefono || 'Sin equipo')}</div>
          <div class="midia-card-meta">${esc(p.vendedora || '—')}</div>
        </div>
      `).join('') || '<div class="midia-empty">No hay pedidos en corte.</div>'}</div>
    </article>
  `;
}

function _miDiaBloqueCostura(nombrePersona) {
  // Para costureras: contenedor que se llena con AJAX (lotes desde /api/c/<slug>/lotes)
  const slugCostu = (window.WS_PERSONA && window.WS_PERSONA.slug) || (localStorage.getItem('ws_persona') || '').toLowerCase();
  const link = '/c/' + slugCostu;
  return `
    <article class="midia-bloque" style="--bloque-color:#ec4899;" id="bloque-costura-${slugCostu}">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">🧵</span>
        <div>
          <h2>Mis lotes pendientes</h2>
          <small id="costu-pend-count">cargando...</small>
        </div>
      </header>
      <div id="costu-lotes-list" class="midia-cards"><div class="midia-empty">Cargando...</div></div>
      <div class="midia-actions">
        <button class="midia-btn" onclick="location.href='${link}'">📲 Abrir mi vista completa</button>
      </div>
    </article>
  `;
}

// Carga lotes pendientes para la costurera identificada (rol 'costura') y los pinta.
async function _miDiaCargarLotesCostura() {
  const slugCostu = (window.WS_PERSONA && window.WS_PERSONA.slug) || (localStorage.getItem('ws_persona') || '').toLowerCase();
  if (!slugCostu) return;
  try {
    const r = await fetch('/api/c/' + slugCostu + '/lotes');
    if (!r.ok) return;
    const data = await r.json();
    const cont = document.getElementById('costu-lotes-list');
    const cnt = document.getElementById('costu-pend-count');
    if (!cont) return;
    if (cnt) cnt.textContent = (data.pendientes.length || 0) + ' lote' + (data.pendientes.length !== 1 ? 's' : '') + ' pendiente' + (data.pendientes.length !== 1 ? 's' : '');
    if (!data.pendientes.length) {
      cont.innerHTML = '<div class="midia-empty">🎉 Sin lotes pendientes</div>';
      return;
    }
    cont.innerHTML = data.pendientes.map(m => {
      const dias = Math.floor((Date.now() - new Date(m.fecha_envio).getTime()) / 86400000);
      const urg = dias >= 7;
      const yaConf = m.confirmado_costurera == 1;
      const btnConf = yaConf
        ? '<div style="margin-top:6px;color:#6ee7b7;font-size:0.75rem;">✅ Ya marcaste como entregado</div>'
        : `<button onclick="confirmarLoteCostura(${m.id},'${slugCostu}')" style="margin-top:8px;width:100%;background:#10b981;color:#fff;border:none;padding:8px;border-radius:7px;font-weight:600;font-size:0.82rem;cursor:pointer;">✅ Ya lo entregué</button>`;
      return `<div class="midia-card" style="${urg ? 'border-color:rgba(239,68,68,0.4);' : ''}">
        <div class="midia-card-name">${esc(m.equipo || 'Lote #' + m.id)}</div>
        <div class="midia-card-meta">${esc(m.prenda || '-')} · ${m.cantidad_enviada} prendas · ${dias}d</div>
        ${btnConf}
      </div>`;
    }).join('');
  } catch (e) { console.warn('[costu-lotes]', e.message); }
}

async function confirmarLoteCostura(movId, slug) {
  if (!confirm('¿Confirmar que ya entregaste este lote?')) return;
  try {
    const r = await fetch('/api/costureras/confirmar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimiento_id: movId, costurera_slug: slug }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'falló');
    toast('✅ Marcado. Avisamos al taller.', 'success');
    _miDiaCargarLotesCostura();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ───────────────────────────────────────────────────────────────────
// BLOQUE GESTION COSTURAS — solo para Lidermeyer (rol corte) y admin
// Muestra lotes pendientes globales + boton "Enviar pedido a costura"
// ───────────────────────────────────────────────────────────────────
function _miDiaBloqueGestionCosturas() {
  return `
    <article class="midia-bloque" style="--bloque-color:#10b981;" id="bloque-gestion-costuras">
      <header class="midia-bloque-head">
        <span class="midia-bloque-icon">🧵</span>
        <div>
          <h2>Costuras — gestión</h2>
          <small id="gest-cost-count">cargando...</small>
        </div>
      </header>
      <div id="gest-cost-list" class="midia-cards"><div class="midia-empty">Cargando...</div></div>
      <div class="midia-actions" style="display:flex;flex-direction:column;gap:8px;">
        <button class="midia-btn" style="background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;font-weight:700;" onclick="abrirModalEnvioCostura()">📦 Enviar pedido a costura</button>
      </div>
    </article>
  `;
}

async function _miDiaCargarGestionCosturas() {
  try {
    const r = await fetch('/api/costureras/pendientes');
    if (!r.ok) return;
    const data = await r.json();
    const cont = document.getElementById('gest-cost-list');
    const cnt = document.getElementById('gest-cost-count');
    if (!cont) return;
    const n = data.pendientes.length;
    if (cnt) cnt.textContent = n + ' lote' + (n !== 1 ? 's' : '') + ' en costura';
    if (!n) {
      cont.innerHTML = '<div class="midia-empty">Sin lotes en costura</div>';
      return;
    }
    cont.innerHTML = data.pendientes.slice(0, 15).map(m => {
      const urg = m.dias_en_costura >= 7;
      return `<div class="midia-card" style="${urg ? 'border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.04);' : ''}">
        <div class="midia-card-name">${esc(m.costurera_nombre)} — ${esc(m.equipo || '#' + m.id)}</div>
        <div class="midia-card-meta">${esc(m.prenda || '-')} · ${m.cantidad_enviada} · ${m.dias_en_costura}d${m.confirmado_costurera ? ' · ✅ marco entrega' : ''}</div>
        <button onclick="abrirModalRecibirCostura(${m.id})" style="margin-top:8px;width:100%;background:rgba(34,197,94,0.18);border:1px solid rgba(34,197,94,0.4);color:#86efac;padding:7px;border-radius:7px;font-weight:600;font-size:0.78rem;cursor:pointer;">✅ Recibí este lote</button>
      </div>`;
    }).join('');
  } catch (e) { console.warn('[gest-cost]', e.message); }
}

// Modal: enviar pedido a costura
function abrirModalEnvioCostura() {
  const pedidos = (typeof window.pedidos !== 'undefined' ? window.pedidos : []) || [];
  const candidatos = pedidos.filter(p => ['costura','calidad','listo','confirmado','enviado-calandra','llego-impresion','corte'].includes(p.estado));
  const slug = (window.WS_PERSONA && window.WS_PERSONA.slug) || 'admin';

  fetch('/api/costureras').then(r => r.json()).then(data => {
    const costureras = data.costureras || [];
    const m = document.createElement('div');
    m.id = 'modal-envio-cost';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#1a1d2e;border:1px solid rgba(16,185,129,0.3);border-radius:14px;padding:22px;max-width:480px;width:100%;max-height:90vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
          <h3 style="margin:0;color:#10b981;">📦 Enviar a costura</h3>
          <button onclick="document.getElementById('modal-envio-cost').remove()" style="background:none;border:none;color:#9ca3af;font-size:1.4rem;cursor:pointer;">×</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div>
            <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Pedido (opcional)</label>
            <select id="env-cost-pedido" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.92rem;">
              <option value="">— Sin asociar a un pedido —</option>
              ${candidatos.map(p => `<option value="${p.id}" data-equipo="${esc(p.equipo || p.telefono || '')}">#${p.id} ${esc(p.equipo || p.telefono || '')} (${p.estado})</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Costurera <span style="color:#ef4444;">*</span></label>
            <select id="env-cost-slug" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.92rem;">
              <option value="">— Seleccionar —</option>
              ${costureras.map(c => `<option value="${c.slug}">${esc(c.nombre)}</option>`).join('')}
            </select>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div>
              <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Prenda</label>
              <select id="env-cost-prenda" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.92rem;">
                <option value="Camiseta">Camiseta</option>
                <option value="Sudadera">Sudadera</option>
                <option value="Pantalón">Pantalón</option>
                <option value="Pantaloneta">Pantaloneta</option>
                <option value="Chaqueta">Chaqueta</option>
                <option value="Buso">Buso</option>
                <option value="Uniforme completo">Uniforme completo</option>
                <option value="Portero acolchado">Portero acolchado</option>
                <option value="Otro">Otro</option>
              </select>
            </div>
            <div>
              <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Cantidad <span style="color:#ef4444;">*</span></label>
              <input type="number" id="env-cost-cant" min="1" placeholder="30" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.92rem;">
            </div>
          </div>
          <div>
            <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Observaciones (opcional)</label>
            <textarea id="env-cost-obs" rows="2" placeholder="Ej: urgente, especial, etc" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.88rem;resize:vertical;"></textarea>
          </div>
          <button onclick="enviarACostura('${slug}')" style="background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;padding:14px;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;">📦 Enviar a costura</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
  });
}

async function enviarACostura(enviadoPor) {
  const pedido_id = parseInt(document.getElementById('env-cost-pedido').value || '0', 10) || null;
  const costurera_slug = document.getElementById('env-cost-slug').value;
  const prenda = document.getElementById('env-cost-prenda').value;
  const cantidad = parseInt(document.getElementById('env-cost-cant').value || '0', 10);
  const observaciones = document.getElementById('env-cost-obs').value.trim();

  if (!costurera_slug) { toast('Falta seleccionar costurera', 'error'); return; }
  if (!cantidad || cantidad < 1) { toast('Falta cantidad', 'error'); return; }

  // Si hay pedido_id, agarrar el equipo
  let equipo = '';
  if (pedido_id) {
    const opt = document.querySelector('#env-cost-pedido option[value="' + pedido_id + '"]');
    if (opt) equipo = opt.getAttribute('data-equipo') || '';
  }

  try {
    const r = await fetch('/api/costureras/envio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pedido_id, costurera_slug, prenda, cantidad, observaciones, equipo, enviado_por: enviadoPor }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'falló');
    toast('✅ Enviado a ' + costurera_slug, 'success');
    document.getElementById('modal-envio-cost').remove();
    _miDiaCargarGestionCosturas();
    if (typeof syncTodoConServidor === 'function') syncTodoConServidor(true);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// Modal: marcar recepción de un lote
function abrirModalRecibirCostura(movId) {
  fetch('/api/costureras/pendientes').then(r => r.json()).then(data => {
    const mov = (data.pendientes || []).find(x => x.id === movId);
    if (!mov) { toast('No se encontró el lote', 'error'); return; }
    const slug = (window.WS_PERSONA && window.WS_PERSONA.slug) || 'admin';
    const m = document.createElement('div');
    m.id = 'modal-recibir-cost';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#1a1d2e;border:1px solid rgba(34,197,94,0.3);border-radius:14px;padding:22px;max-width:420px;width:100%;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;color:#86efac;">✅ Recibí este lote</h3>
          <button onclick="document.getElementById('modal-recibir-cost').remove()" style="background:none;border:none;color:#9ca3af;font-size:1.4rem;cursor:pointer;">×</button>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);padding:12px;border-radius:9px;margin-bottom:14px;font-size:0.88rem;">
          <div style="color:#fff;font-weight:600;margin-bottom:4px;">${esc(mov.costurera_nombre)}</div>
          <div style="color:#9ca3af;font-size:0.78rem;">${esc(mov.equipo || '#' + movId)} · ${esc(mov.prenda || '-')} · enviadas ${mov.cantidad_enviada}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Cantidad recibida</label>
            <input type="number" id="rec-cant" value="${mov.cantidad_enviada}" min="0" max="${mov.cantidad_enviada}" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.95rem;">
          </div>
          <div>
            <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Faltantes / Devolución</label>
            <input type="number" id="rec-falt" value="0" min="0" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.95rem;">
          </div>
          <div>
            <label style="font-size:0.78rem;color:#9ca3af;display:block;margin-bottom:4px;">Observaciones</label>
            <textarea id="rec-obs" rows="2" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:8px;font-size:0.88rem;resize:vertical;"></textarea>
          </div>
          <button onclick="marcarRecibidoCostura(${movId},'${slug}')" style="background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;padding:13px;border-radius:10px;font-weight:700;font-size:0.98rem;cursor:pointer;">✅ Confirmar recepción</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
  });
}

async function marcarRecibidoCostura(movId, recibidoPor) {
  const cantidad_recibida = parseInt(document.getElementById('rec-cant').value || '0', 10);
  const faltante = parseInt(document.getElementById('rec-falt').value || '0', 10);
  const observaciones = document.getElementById('rec-obs').value.trim();
  if (cantidad_recibida < 0) { toast('Cantidad inválida', 'error'); return; }
  try {
    const r = await fetch('/api/costureras/recepcion', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimiento_id: movId, cantidad_recibida, faltante, observaciones, recibido_por: recibidoPor }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'falló');
    toast('✅ Recepción registrada', 'success');
    document.getElementById('modal-recibir-cost').remove();
    _miDiaCargarGestionCosturas();
    if (typeof syncTodoConServidor === 'function') syncTodoConServidor(true);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// Auto-refresh: cuando llega Mi Día arranca un loop que cada 60s vuelve
// a pintar (recogiendo cambios del server y de la cache local).
let _miDiaRefreshInt = null;
function _miDiaArrancarRefresh() {
  if (_miDiaRefreshInt) return;
  _miDiaRefreshInt = setInterval(() => {
    const seccion = document.getElementById('mi-dia');
    if (seccion && seccion.classList.contains('active')) {
      _miDiaCargarArreglos().then(() => renderMiDia());
      if (typeof hardSyncFromServer === 'function') {
        try { hardSyncFromServer(true); } catch (e) {}
      }
    }
  }, 60 * 1000);
}

function renderMiDia() {
  const cont = document.getElementById('mi-dia-content');
  if (!cont) return;
  // Carga arreglos en background la primera vez y re-renderiza
  if (!_miDiaArreglos.length && !window._miDiaArreglosCargando) {
    window._miDiaArreglosCargando = true;
    _miDiaCargarArreglos().then(() => {
      window._miDiaArreglosCargando = false;
      renderMiDia();
    });
  }
  _miDiaArrancarRefresh();
  const persona = getPersonaActual();
  if (!persona) {
    cont.innerHTML = `
      <div class="midia-vacio">
        <h1>☀️ Mi Día</h1>
        <p>Para ver tu día personalizado, abre tu link personal y guarda la app en tu inicio.</p>
        <button class="midia-btn" onclick="showSection('mobile-role-hub', null); window.location.hash='#/movil';">Ver lista de personas</button>
      </div>
    `;
    return;
  }
  const roles = persona.roles || [];
  const bloques = [];

  // Entregas HOY arriba de todo (alerta), si aplica para este rol
  if (roles.some(r => ['admin','ventas','diseno','produccion','corte'].includes(r))) {
    const entregasHoy = _miDiaBloqueEntregasHoy();
    if (entregasHoy) bloques.push(entregasHoy);
  }

  if (roles.includes('admin'))      bloques.push(_miDiaBloqueAdmin());
  if (roles.includes('ventas'))     bloques.push(_miDiaBloqueVentas(persona.nombre));
  if (roles.includes('diseno')) {
    bloques.push(_miDiaBloqueDiseno(persona.nombre));
    // Diseñadores ven SUS arreglos asignados
    bloques.push(_miDiaBloqueArreglos(persona.nombre, false));
  }
  if (roles.includes('produccion')) bloques.push(_miDiaBloqueProduccion());
  if (roles.includes('corte') || roles.includes('admin')) {
    bloques.push(_miDiaBloqueGestionCosturas());
  }
  if (roles.includes('corte')) {
    bloques.push(_miDiaBloqueCorte());
    // Lidermeyer (el de corte) ve TODOS los arreglos pendientes — él los gestiona
    bloques.push(_miDiaBloqueArreglos(persona.nombre, true));
  }
  if (roles.includes('costura'))    bloques.push(_miDiaBloqueCostura(persona.nombre));

  const saludo = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  })();

  cont.innerHTML = `
    <header class="midia-header">
      <div>
        <div class="midia-kicker">${saludo}</div>
        <h1>${esc(persona.nombre)}</h1>
        <div class="midia-roles">${roles.map(r => `<span class="midia-rol-chip">${ROLE_LABELS[r] || r}</span>`).join('')}</div>
      </div>
      <button class="midia-btn ghost" onclick="renderMiDia()" title="Refrescar">🔄</button>
    </header>
    <div class="midia-bloques">${bloques.join('')}</div>
  `;

  // Disparar cargas AJAX de bloques que necesitan datos del servidor
  if (roles.includes('corte') || roles.includes('admin')) {
    setTimeout(_miDiaCargarGestionCosturas, 100);
  }
  if (roles.includes('costura')) {
    setTimeout(_miDiaCargarLotesCostura, 100);
  }
}

// Carga el roster desde /api/personas y dibuja una tarjeta por persona
// con el link a /app/:slug. Cada uno puede abrir SU app y desde el celular
// pulsar "Instalar app" para tenerla con su nombre en la pantalla principal.
let _personasCache = null;
async function renderPersonalApps() {
  const cont = document.getElementById('mobile-personal-apps');
  if (!cont) return;
  try {
    if (!_personasCache) {
      const r = await fetch('/api/personas');
      const d = await r.json();
      _personasCache = d.personas || [];
    }
    const actual = (window.WS_PERSONA && WS_PERSONA.slug) || '';
    const filas = _personasCache.map(p => {
      const esActual = p.slug === actual;
      return `<a class="mini-persona-card${esActual ? ' actual' : ''}" href="/app/${p.slug}" style="--color:${p.color};">
        <span class="mini-persona-emoji">${p.emoji}</span>
        <div class="mini-persona-body">
          <strong>${esc(p.nombre)}</strong>
          <small>${p.roles.join(' · ')}</small>
        </div>
        <span class="mini-persona-arrow">${esActual ? '✓ Tu app' : 'Abrir →'}</span>
      </a>`;
    }).join('');
    cont.innerHTML = `
      <div class="mobile-staff-panel">
        <div class="mobile-staff-title">Tu app personal</div>
        <p style="margin:0 0 10px;color:var(--text-muted);font-size:0.78rem;">
          Abre el link con tu nombre y pulsa <strong>Instalar app</strong> desde el menú del navegador.
          Cada quien queda con su ícono propio.
        </p>
        <div class="mini-persona-grid">${filas}</div>
      </div>
    `;
  } catch (e) {
    console.warn('[personas] no se pudo cargar', e);
    cont.innerHTML = '';
  }
}

function renderMiniVentas() {
  const cotizaciones = pedidos.filter(p => p.tipoBandeja === 'cotizar' && p.estado === 'bandeja');
  const activos = pedidos.filter(p => p.tipoBandeja === 'pedido' && p.estado !== 'enviado-final');
  const listos = activos.filter(p => p.estado === 'listo');
  const hoy = activos.filter(p => p.fechaEntrega && fmtFecha(p.fechaEntrega) === fmtFecha(new Date().toISOString().slice(0, 10)));
  const cards = [
    ...cotizaciones.map(p => miniCard(p, {
      clase: 'warn',
      next: 'Completar datos del pedido',
      actions: `<div class="mini-actions"><button class="mini-btn orange" onclick="openModalCompletar(${p.id})"><small>Tocar aqui</small>Completar pedido</button></div>`
    })),
    ...activos.slice(0, 30).map(p => miniCard(p, {
      next: 'Responder al cliente con el estado',
      actions: `<div class="mini-actions two">
        <button class="mini-btn" onclick="copiarEstadoCliente(${p.id})"><small>Tocar aqui</small>Copiar estado</button>
        <button class="mini-btn gray" onclick="irAlPedido(${p.id})">Ver pedido</button>
      </div>`
    }))
  ];
  miniEnsure('bandeja', `
    <div class="mini-role-top">
      <div class="mini-role-title"><h1>Ventas</h1><p>Primero completa cotizaciones. Despues responde rapido al cliente con el estado del pedido.</p></div>
      <div class="mini-role-stats">${miniStats([[cotizaciones.length, 'Por completar'], [activos.length, 'Pedidos activos'], [listos.length, 'Listos']])}</div>
    </div>
    <div class="mini-card-list">${cards.length ? cards.join('') : '<div class="mini-empty">No hay trabajo pendiente para ventas.</div>'}</div>
  `);
}

function renderMiniDiseno() {
  const pendientes = pedidos.filter(p => p.estado === 'hacer-diseno');
  const sinAsignar = pendientes.filter(p => !p.disenadorAsignado);
  const asignados = pendientes.filter(p => p.disenadorAsignado);
  const confirmados = pedidos.filter(p => p.estado === 'confirmado');
  const calandra = pedidos.filter(p => p.estado === 'enviado-calandra');
  const DISENADORES = ['Camilo', 'Oscar', 'Wendy', 'Ney', 'Paola'];
  const cards = [
    ...sinAsignar.map(p => miniCard(p, {
      clase: 'warn',
      next: 'Asignar a un disenador',
      body: `<select class="mini-select" id="mini-dis-${p.id}"><option value="">Escoger disenador</option>${DISENADORES.map(d => `<option value="${d}">${d}</option>`).join('')}</select>`,
      actions: `<div class="mini-actions"><button class="mini-btn purple" onclick="tomarPedidoDisenoMini(${p.id})"><small>Tocar aqui</small>Asignar diseno</button></div>`
    })),
    ...asignados.map(p => miniCard(p, {
      next: 'Cuando el diseno este aprobado',
      actions: `<div class="mini-actions two">
        <button class="mini-btn green" onclick="marcarDisenoListo(${p.id})"><small>Tocar aqui</small>Diseno listo</button>
        <button class="mini-btn gray" onclick="liberarPedidoDiseno(${p.id})">Cambiar</button>
      </div>`
    })),
    ...confirmados.map(p => miniCard(p, {
      clase: 'good',
      next: 'Enviar archivo a calandra',
      actions: `<div class="mini-actions"><button class="mini-btn" onclick="avanzar(${p.id})"><small>Tocar aqui</small>Enviar a calandra</button></div>`
    })),
    ...calandra.map(p => miniCard(p, {
      clase: 'good',
      next: 'Esperar impresion',
      actions: `<div class="mini-actions"><button class="mini-btn gray" onclick="irAlPedido(${p.id})">Ver pedido</button></div>`
    }))
  ];
  miniEnsure('diseno', `
    <div class="mini-role-top">
      <div class="mini-role-title"><h1>Diseno</h1><p>Asigna pedidos, marca diseno listo y manda a calandra. Lo urgente aparece arriba.</p></div>
      <div class="mini-role-stats">${miniStats([[sinAsignar.length, 'Sin asignar'], [asignados.length, 'En diseno'], [confirmados.length, 'Para calandra']])}</div>
    </div>
    <div class="mini-card-list">${cards.length ? cards.join('') : '<div class="mini-empty">No hay trabajo pendiente para diseno.</div>'}</div>
  `);
}

function slugCosturera(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function costureraDesdeSlug(slug) {
  const limpio = slugCosturera(slug);
  return SATELITES.find(s => slugCosturera(s) === limpio) || '';
}

function abrirCosturera(nombre) {
  const costurera = costureraDesdeSlug(nombre) || nombre;
  if (!costurera) return;
  miniCosturaPersona = costurera;
  miniCosturaVistaPersonal = true;
  localStorage.setItem('ws_mini_costura_persona', costurera);
  localStorage.setItem('ws_mobile_last_role', `costura-${slugCosturera(costurera)}`);
  window.location.hash = `#/costura/${slugCosturera(costurera)}`;
  modoMiniApp('satelites');
  showSection('satelites', null);
  renderMiniCostura();
}

function renderMiniCostura() {
  const paraAsignar = pedidos.filter(p => (p.estado === 'corte' || p.estado === 'costura') && !p.satelite);
  const trabajandoBase = pedidos.filter(p => p.estado === 'en-satelite' || (p.estado === 'costura' && p.satelite));
  const trabajando = miniCosturaPersona === 'todas'
    ? trabajandoBase
    : trabajandoBase.filter(p => p.satelite === miniCosturaPersona);
  const revision = pedidos.filter(p => p.estado === 'calidad');
  const listos = pedidos.filter(p => p.estado === 'listo');
  const opciones = SATELITES.map(s => `<button class="mini-filter ${miniCosturaPersona === s ? 'active' : ''}" onclick="setMiniCosturaPersona('${s}')">${s}</button>`).join('');
  if (miniCosturaVistaPersonal && miniCosturaPersona !== 'todas') {
    const urgentes = trabajando.filter(p => p.fechaEntrega && new Date(p.fechaEntrega + 'T00:00:00').getTime() <= Date.now() + 2 * 86400000);
    const links = SATELITES.map(s => `<button class="mini-filter ${miniCosturaPersona === s ? 'active' : ''}" onclick="abrirCosturera('${s}')">${s}</button>`).join('');
    const cards = trabajando.map(p => miniCard(p, {
      clase: 'good',
      next: 'Cuando termines este pedido',
      body: `<div class="mini-card-meta"><span class="mini-chip">Asignado a: ${esc(miniCosturaPersona)}</span></div>`,
      actions: `<div class="mini-actions"><button class="mini-btn green" onclick="terminarPedidoCosturaConFoto(${p.id})"><small>Toma una foto del pedido cosido</small>📸 Terminé</button></div>`
    }));
    miniEnsure('satelites', `
      <div class="mini-role-top costurera-simple">
        <div class="mini-role-title"><h1>${esc(miniCosturaPersona)}</h1><p>Estos son tus pedidos de costura. Cuando termines uno, toca el boton grande.</p></div>
        <div class="mini-role-stats">${miniStats([[trabajando.length, 'Mis pedidos'], [urgentes.length, 'Urgentes'], ['1 toque', 'Para terminar']])}</div>
        <div class="mini-filters">${links}</div>
      </div>
      <div class="mini-card-list">${cards.length ? cards.join('') : '<div class="mini-empty">No tienes pedidos asignados ahora.</div>'}</div>
    `);
    return;
  }
  const linksCostureras = SATELITES.map(s => `
    <button class="mini-person-link" onclick="abrirCosturera('${s}')">
      <small>Link</small><strong>${s}</strong>
    </button>
  `).join('');
  const cards = [
    ...paraAsignar.map(p => miniCard(p, {
      clase: 'warn',
      next: p.estado === 'corte' ? 'Corte listo: escoger costurera' : 'Escoger quien lo va a coser',
      body: `<select class="mini-select" id="mini-sat-${p.id}"><option value="">Escoger costurera</option>${SATELITES.map(s => `<option value="${s}">${s}</option>`).join('')}</select>`,
      actions: `<div class="mini-actions">
        <button class="mini-btn purple" onclick="asignarSatelitePedidoMini(${p.id})"><small>Tocar aqui</small>Asignar a costura</button>
      </div>`
    })),
    ...trabajando.map(p => miniCard(p, {
      next: 'Cuando la costurera termine',
      body: `<div class="mini-card-meta"><span class="mini-chip">Costurera: ${esc(p.satelite || 'Sin nombre')}</span></div>`,
      actions: `<div class="mini-actions"><button class="mini-btn green" onclick="recibirSatelitePedido(${p.id})"><small>Tocar aqui</small>Recibi terminado</button></div>`
    })),
    ...revision.map(p => miniCard(p, {
      clase: 'good',
      next: 'Revision final antes de entregar',
      actions: `<div class="mini-actions"><button class="mini-btn green" onclick="avanzar(${p.id})"><small>Tocar aqui</small>Revision OK</button></div>`
    })),
    ...listos.map(p => miniCard(p, {
      clase: 'good',
      next: 'Entregar al cliente',
      actions: `<div class="mini-actions"><button class="mini-btn green" onclick="avanzar(${p.id})"><small>Tocar aqui</small>Entregado</button></div>`
    }))
  ];
  miniEnsure('satelites', `
    <div class="mini-role-top">
      <div class="mini-role-title"><h1>Costura</h1><p>Escoge costurera, entrega el pedido y marca cuando vuelva terminado.</p></div>
      <div class="mini-role-stats">${miniStats([[paraAsignar.length, 'Por asignar'], [trabajandoBase.length, 'En costura'], [revision.length, 'Revision']])}</div>
      <div class="mini-person-links">${linksCostureras}</div>
      <div class="mini-filters">
        <button class="mini-filter ${miniCosturaPersona === 'todas' ? 'active' : ''}" onclick="setMiniCosturaPersona('todas')">Todas</button>
        ${opciones}
      </div>
    </div>
    <div class="mini-card-list">${cards.length ? cards.join('') : '<div class="mini-empty">No hay trabajo pendiente de costura.</div>'}</div>
  `);
}

function setMiniCosturaPersona(nombre) {
  miniCosturaPersona = nombre || 'todas';
  miniCosturaVistaPersonal = false;
  localStorage.setItem('ws_mini_costura_persona', miniCosturaPersona);
  renderMiniCostura();
}

function asignarSatelitePedidoMini(id) {
  const sel = document.getElementById(`mini-sat-${id}`);
  const nombre = sel ? sel.value : '';
  if (!nombre) { toast('Escoge una costurera', 'error'); return; }
  asignarSatelitePedido(id, nombre);
}

function tomarPedidoDisenoMini(id) {
  const sel = document.getElementById(`mini-dis-${id}`);
  const original = document.getElementById(`sel-dis-${id}`);
  if (original && sel) original.value = sel.value;
  tomarPedidoDiseno(id);
}

function copiarEstadoCliente(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const estado = ESTADO_LABELS[p.estado] || p.estado || 'en proceso';
  const fecha = p.fechaEntrega ? ` Entrega estimada: ${fmtFecha(p.fechaEntrega)}.` : '';
  const msg = `Hola, tu pedido ${p.equipo || '#' + id} va en estado: ${estado}.${fecha}`;
  navigator.clipboard?.writeText(msg).then(
    () => toast('Estado copiado para enviar al cliente', 'ok'),
    () => prompt('Copia este mensaje:', msg)
  );
}

// Calcula y actualiza badges del sidebar — desacoplado de renderXXX
// para que siempre refleje el estado actual de `pedidos` aunque el
// usuario esté en otra sección (ej. Mi Día).
function actualizarBadgesSidebar() {
  try {
    const activos = (pedidos || []).filter(p => p && p.estado && p.estado !== 'enviado-final' && p.estado !== 'archivado');
    const setBadge = (id, n) => {
      const el = document.getElementById(id);
      if (el) el.textContent = (n == null ? 0 : n);
    };
    setBadge('badge-tab-principal', activos.length);
    setBadge('badge-torre-unif', activos.length);
    const enCalandra = activos.filter(p => ['enviado-calandra', 'llego-impresion'].includes(p.estado));
    setBadge('badge-calandra', enCalandra.length);
    const arregPend = ((_miDiaArreglos || []).filter(a => !a.resuelto)).length;
    setBadge('badge-arreglos', arregPend);
  } catch (e) { /* silencioso */ }
}

function render() {
  const safe = (nombre, fn) => { try { fn(); } catch (e) { console.error('[render]', nombre, e); } };
  safe('badges-sidebar', actualizarBadgesSidebar);
  safe('metricas', renderMetricas);
  safe('dashboard', renderDashboard);
  safe('badges', renderBadges);
  safe('tabla-recientes', renderTablaRecientes);
  if (typeof renderTableroPrincipal === 'function') safe('tablero-principal', renderTableroPrincipal);
  if (typeof renderTorreUnificada === 'function') safe('torre-unificada', renderTorreUnificada);
  safe('bandeja', renderBandeja);
  ['hacer-diseno','confirmado','enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad','listo','enviado-final']
    .forEach(estado => safe('kanban-' + estado, () => renderKanban(estado)));
  safe('wt', cargarWT);
  safe('arreglos', renderArreglos);
  safe('calandra', renderCalandra);
  safe('satelites', renderSatelites);
  safe('mini-roles', renderMiniRoleViews);
  if (document.body.classList.contains('modo-tv')) safe('tv-lista', renderTVLista);
}

/* ─── Métricas ────────────────────────────────────────────────── */
function renderMetricas() {
  const total     = pedidos.filter(p => p.estado !== 'enviado-final').length;
  const enProd    = pedidos.filter(p => ['llego-impresion','corte','costura','en-satelite','calidad'].includes(p.estado)).length;
  const listos    = pedidos.filter(p => p.estado === 'listo').length;
  const enDiseno  = pedidos.filter(p => ['hacer-diseno','confirmado','enviado-calandra'].includes(p.estado)).length;

  document.getElementById('m-total').textContent      = total;
  document.getElementById('m-produccion').textContent = enProd;
  document.getElementById('m-listos').textContent     = listos;
  document.getElementById('m-diseno').textContent     = enDiseno;
}

/* ─── Dashboard ──────────────────────────────────────────────── */
function renderDashboard() {
  const adminDash = document.getElementById('admin-dashboard');
  const proDash   = document.getElementById('proactive-dashboard');
  
  if(userRol !== 'admin' && proDash && adminDash) {
    adminDash.style.display = 'none';
    proDash.style.display = 'flex';
    renderMiDia(proDash);
    return;
  }
  
  if(proDash && adminDash) {
    proDash.style.display = 'none';
    adminDash.style.display = 'block';
  }

  // KPIs calandra y satélites
  const semanaKey = getSemanaKey(new Date());
  const semLista  = calandraRegistros.filter(r => r.semana === semanaKey);
  const totalMetros = semLista.reduce((a, r) => a + (r.metros || 0), 0);
  document.getElementById('m-cal-semana').textContent = totalMetros.toFixed(1);

  const pendTotalSat = SATELITES.reduce((sum, s) => {
    const ent = satMovimientos.filter(m => m.satelite === s && m.tipo === 'entrega').reduce((a, m) => a + m.cantidad, 0);
    const rec = satMovimientos.filter(m => m.satelite === s && m.tipo === 'recepcion').reduce((a, m) => a + m.cantidad, 0);
    return sum + Math.max(0, ent - rec);
  }, 0);
  document.getElementById('m-sat-pend').textContent = pendTotalSat;

  // Panel alertas entregas próximas
  const hoy   = new Date(); hoy.setHours(0,0,0,0);
  const activos = pedidos.filter(p => p.estado !== 'enviado-final' && p.fechaEntrega);
  const conFecha = activos.map(p => {
    const d = new Date(p.fechaEntrega + 'T00:00:00');
    const diff = Math.round((d - hoy) / 86400000);
    return { ...p, diff };
  }).filter(p => p.diff <= 2).sort((a, b) => a.diff - b.diff);

  const contAlertas = document.getElementById('dash-alertas');
  if (!conFecha.length) {
    contAlertas.innerHTML = '<div class="dash-empty">Sin pedidos con entrega en los próximos 2 días</div>';
  } else {
    contAlertas.innerHTML = conFecha.map(p => {
      const cls   = p.diff <= 1 ? 'red' : 'yellow';
      const tipo  = p.diff < 0 ? `${Math.abs(p.diff)}d vencido` : p.diff === 0 ? 'HOY' : `${p.diff}d`;
      const estad = ESTADO_LABELS[p.estado] || p.estado;
      return `<div class="dash-alert-item ${p.diff <= 1 ? '' : 'warn'}">
        <div class="dash-alert-dias ${cls}">${tipo}</div>
        <div class="dash-alert-info">
          <div class="dash-alert-equipo">#${p.id} ${esc(p.equipo || p.telefono)}</div>
          <div class="dash-alert-estado">${esc(p.vendedora || '—')} · ${estad}</div>
        </div>
      </div>`;
    }).join('');
  }

  // Panel pipeline conteos
  const PIPE_ESTADOS = [
    { key: 'bandeja',          label: 'Ventas / Cotizaciones', color: '#94a3b8' },
    { key: 'hacer-diseno',     label: 'Hacer diseño',          color: '#818cf8' },
    { key: 'confirmado',       label: 'Confirmado',            color: '#fb923c' },
    { key: 'enviado-calandra', label: 'Enviado calandra',      color: '#06b6d4' },
    { key: 'llego-impresion',  label: 'Llegó impresión',       color: '#38bdf8' },
    { key: 'corte',            label: 'Corte',                 color: '#f97316' },
    { key: 'costura',          label: 'Costura',               color: '#f472b6' },
    { key: 'en-satelite',      label: 'En costura',            color: '#a855f7' },
    { key: 'calidad',          label: 'Revision final',        color: '#fbbf24' },
    { key: 'listo',            label: 'Listo p/entregar',      color: '#4ade80' },
  ];
  const contPipe = document.getElementById('dash-pipeline');
  const rowsPipe = PIPE_ESTADOS.map(e => {
    const cnt = pedidos.filter(p => p.estado === e.key).length;
    return `<div class="dash-pipe-row" style="${cnt === 0 ? 'opacity:0.35;' : ''}">
      <div class="dash-pipe-dot" style="background:${cnt > 0 ? e.color : '#334155'};box-shadow:${cnt > 0 ? '0 0 5px ' + e.color + '66' : 'none'};"></div>
      <div class="dash-pipe-label">${e.label}</div>
      <div class="dash-pipe-count" style="color:${cnt > 0 ? e.color : 'var(--text-muted)'};">${cnt}</div>
    </div>`;
  }).join('');
  contPipe.innerHTML = rowsPipe || '<div class="dash-empty">Sin pedidos activos</div>';

  // Panel satélites
  const contSat = document.getElementById('dash-satelites');
  contSat.innerHTML = SATELITES.map(s => {
    const ent = satMovimientos.filter(m => m.satelite === s && m.tipo === 'entrega').reduce((a, m) => a + m.cantidad, 0);
    const rec = satMovimientos.filter(m => m.satelite === s && m.tipo === 'recepcion').reduce((a, m) => a + m.cantidad, 0);
    const pend = Math.max(0, ent - rec);
    const cls = pend === 0 ? 'ok' : pend <= 10 ? 'warn' : 'high';

    const prendasMap = {};
    satMovimientos.filter(m => m.satelite === s).forEach(m => {
      const p = m.prenda || 'Sin tipo';
      if (!prendasMap[p]) prendasMap[p] = 0;
      prendasMap[p] += m.tipo === 'entrega' ? m.cantidad : -m.cantidad;
    });
    const prendasPend = Object.entries(prendasMap).filter(([, v]) => v > 0);
    const prendasHtml = prendasPend.map(([p, v]) =>
      `<div style="font-size:0.68rem;color:var(--text-muted);">${esc(p)}: <span style="color:var(--text);font-weight:600;">${v}</span></div>`
    ).join('');

    return `<div class="dash-sat-row" style="flex-wrap:wrap;gap:4px;">
      <div class="dash-sat-nombre">${s}</div>
      <div>
        <div class="dash-sat-pend ${cls}">${pend}</div>
        <div class="dash-sat-label">pend.</div>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted);text-align:right;">
        <div>↑${ent} entregado</div>
        <div>↓${rec} recibido</div>
      </div>
      ${prendasHtml ? `<div style="width:100%;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);display:flex;flex-wrap:wrap;gap:6px;">${prendasHtml}</div>` : ''}
    </div>`;
  }).join('');

  // Panel calandra semana
  const contCal = document.getElementById('dash-calandra');
  if (!semLista.length) {
    contCal.innerHTML = '<div class="dash-empty">Sin registros esta semana</div>';
  } else {
    const totalSem = semLista.reduce((a, r) => a + (r.metros || 0), 0);
    const numEnvios = semLista.length;
    const ultimoEnvio = semLista[0];
    contCal.innerHTML = `<div class="dash-cal-stats">
      <div class="dash-cal-stat">
        <div class="dash-cal-stat-val">${totalSem.toFixed(1)}</div>
        <div class="dash-cal-stat-label">metros esta semana</div>
      </div>
      <div class="dash-cal-stat">
        <div class="dash-cal-stat-val">${numEnvios}</div>
        <div class="dash-cal-stat-label">envíos registrados</div>
      </div>
    </div>
    <div style="margin-top:10px;font-size:0.75rem;color:var(--text-muted);">
      Último: <span style="color:var(--text);">${esc(ultimoEnvio.equipo || '—')}</span>
      · ${ultimoEnvio.metros}m · ${ultimoEnvio.fecha || ''}
    </div>`;
  }
}

function renderMiDia(container) {
  let html = `<div style="font-family:'Outfit',sans-serif; font-size:1.6rem; font-weight:800; color:var(--text); margin-bottom:10px;">👋 Hola, equipo de <span style="color:var(--accent2);">${userRol.toUpperCase()}</span></div>`;
  html += `<div style="color:var(--text-muted); font-size:0.9rem; margin-bottom:20px;">Aquí tienes tu resumen operativo para hoy. ¡Vamos a darle! 🚀</div>`;
  
  const activos = pedidos.filter(p => p.estado !== 'enviado-final');
  let tareas = [];

  if (userRol === 'ventas') {
    const listos = activos.filter(p => p.estado === 'listo');
    const enAprobacion = activos.filter(p => p.estado === 'bandeja');
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #4ade80;">
        <div class="dash-panel-title">📦 Pedidos Listos para Entregar (${listos.length})</div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Estos pedidos ya terminaron producción. ¡Contacta al cliente!</div>
        ${listos.length ? listos.map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;" onclick="irAlPedido(${p.id})">
            <div>
              <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
              <div style="font-size:0.75rem; color:var(--text-muted);">Vendedora: ${esc(p.vendedora || '-')}</div>
            </div>
            <button class="btn btn-success btn-sm">Ver</button>
          </div>
        `).join('') : '<div class="dash-empty">No hay pedidos listos.</div>'}
      </div>
    `);
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #94a3b8;">
        <div class="dash-panel-title">⏳ Cotizaciones Pendientes (${enAprobacion.length})</div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Haz seguimiento para confirmarlas.</div>
        ${enAprobacion.slice(0, 5).map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;" onclick="showSection('bandeja', document.querySelector('[onclick*=bandeja]'))">
            <div>
              <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
            </div>
          </div>
        `).join('')}
        ${enAprobacion.length > 5 ? `<div style="text-align:center; font-size:0.75rem; color:var(--text-muted); margin-top:10px;">y ${enAprobacion.length - 5} más...</div>` : ''}
        ${enAprobacion.length === 0 ? '<div class="dash-empty">No hay cotizaciones pendientes.</div>' : ''}
      </div>
    `);
  } 
  else if (userRol === 'diseno') {
    const porDisenar = activos.filter(p => p.estado === 'hacer-diseno' && !p.disenadorAsignado);
    const misDisenos = activos.filter(p => p.estado === 'hacer-diseno' && p.disenadorAsignado);
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #a78bfa;">
        <div class="dash-panel-title">🎨 Diseños Sin Asignar (${porDisenar.length})</div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Toma un pedido de la cola para empezar a trabajar.</div>
        ${porDisenar.slice(0,5).map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;" onclick="showSection('diseno', document.querySelector('[onclick*=diseno]'))">
            <div>
              <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
              <div style="font-size:0.75rem; color:var(--orange);">Entrega: ${p.fechaEntrega ? fmtFecha(p.fechaEntrega) : 'Sin fecha'}</div>
            </div>
            <button class="btn btn-primary btn-sm">Ir a Diseño</button>
          </div>
        `).join('')}
        ${porDisenar.length === 0 ? '<div class="dash-empty">Cola vacía. ¡Buen trabajo!</div>' : ''}
      </div>
    `);
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #06b6d4;">
        <div class="dash-panel-title">🔥 Diseños en Proceso (${misDisenos.length})</div>
        ${misDisenos.slice(0,5).map(p => `
          <div class="bandeja-card" style="margin-bottom:8px;">
            <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
            <div style="font-size:0.75rem; color:var(--text-muted);">Asignado a: ${esc(p.disenadorAsignado)}</div>
          </div>
        `).join('')}
        ${misDisenos.length === 0 ? '<div class="dash-empty">Nadie está diseñando actualmente.</div>' : ''}
      </div>
    `);
  }
  else if (userRol === 'produccion') {
    const porCortar = activos.filter(p => p.estado === 'llego-impresion');
    const enCorte = activos.filter(p => p.estado === 'corte');
    const enCalidad = activos.filter(p => p.estado === 'calidad');
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #f97316;">
        <div class="dash-panel-title">✂️ Llegó Impresión / Por Cortar (${porCortar.length})</div>
        ${porCortar.map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
            <button class="btn btn-glass btn-sm" onclick="avanzar(${p.id}); setTimeout(render,100)">Pasar a Corte →</button>
          </div>
        `).join('')}
        ${porCortar.length === 0 ? '<div class="dash-empty">No hay tela pendiente por cortar.</div>' : ''}
      </div>
    `);

    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #a855f7;">
        <div class="dash-panel-title">Corte terminado / Pasar a Costura (${enCorte.length})</div>
        ${enCorte.map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
            <button class="btn btn-primary btn-sm" onclick="avanzar(${p.id}); setTimeout(render,100)">Pasar a Costura →</button>
          </div>
        `).join('')}
        ${enCorte.length === 0 ? '<div class="dash-empty">No hay pedidos cortados pendientes.</div>' : ''}
      </div>
    `);
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #fbbf24;">
        <div class="dash-panel-title">Revision Final (${enCalidad.length})</div>
        ${enCalidad.map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
            <button class="btn btn-primary btn-sm" onclick="avanzar(${p.id}); setTimeout(render,100)">Revision OK →</button>
          </div>
        `).join('')}
        ${enCalidad.length === 0 ? '<div class="dash-empty">No hay pedidos en revision final.</div>' : ''}
      </div>
    `);
  }
  else if (userRol === 'costura') {
    const enCostura = activos.filter(p => p.estado === 'costura' && !p.satelite);
    const trabajando = activos.filter(p => p.estado === 'en-satelite' || (p.estado === 'costura' && p.satelite));
    
    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #f472b6;">
        <div class="dash-panel-title">Pedidos para repartir en costura (${enCostura.length})</div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Elige la persona de costura y entregale el pedido.</div>
        ${enCostura.map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
            <div style="display:flex; gap:6px;">
               <button class="btn btn-success btn-sm" onclick="abrirFormSat('entrega'); document.getElementById('sat-equipo').value='${esc(p.equipo||p.telefono)}'">📦 Entregar</button>
            </div>
          </div>
        `).join('')}
        ${enCostura.length === 0 ? '<div class="dash-empty">No hay pedidos pendientes de costura.</div>' : ''}
      </div>
    `);

    tareas.push(`
      <div class="dash-panel" style="border-left: 4px solid #a855f7;">
        <div class="dash-panel-title">En manos de costura (${trabajando.length})</div>
        ${trabajando.map(p => `
          <div class="bandeja-card" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:700;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
              <div style="font-size:0.75rem; color:var(--text-muted);">Costurera: ${esc(p.satelite || 'Sin asignar')}</div>
            </div>
            <button class="btn btn-success btn-sm" onclick="recibirSatelitePedido(${p.id}); setTimeout(render,100)">Recibi terminado</button>
          </div>
        `).join('')}
        ${trabajando.length === 0 ? '<div class="dash-empty">Nadie tiene pedidos en costura ahora.</div>' : ''}
      </div>
    `);
  }

  container.innerHTML = html + `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:20px;">${tareas.join('')}</div>`;
}

/* ─── Badges sidebar ─────────────────────────────────────────── */
function renderBadges() {
  const bandeja  = pedidos.filter(p => p.estado === 'bandeja').length;
  const diseno   = pedidos.filter(p => ['hacer-diseno','confirmado','enviado-calandra'].includes(p.estado)).length;
  const prod     = pedidos.filter(p => ['llego-impresion','corte','costura','en-satelite','calidad','listo'].includes(p.estado)).length;
  const total    = pedidos.filter(p => p.estado !== 'enviado-final').length;
  const setBadge = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setBadge('badge-general', total);
  setBadge('badge-bandeja', bandeja);
  setBadge('badge-diseno', diseno);
  setBadge('badge-prod', prod);
  setBadge('badge-produccion', prod);
}

/* ─── Tabla recientes ────────────────────────────────────────── */
const TL_ETAPAS = [
  { key: 'bandeja',          label: 'Bandeja'    },
  { key: 'hacer-diseno',     label: 'Diseño'     },
  { key: 'confirmado',       label: 'Confirmado' },
  { key: 'enviado-calandra', label: 'Calandra'   },
  { key: 'llego-impresion',  label: 'Impresión'  },
  { key: 'corte',            label: 'Corte'      },
  { key: 'arreglo',          label: 'Arreglo'    },
  { key: 'costura',          label: 'Costura'    },
  { key: 'en-satelite',      label: 'En costura' },
  { key: 'calidad',          label: 'Revision'   },
  { key: 'listo',            label: 'Listo'      },
];

const TL_ORDER = TL_ETAPAS.map(e => e.key);

function renderTablaRecientes() {
  const cont = document.getElementById('tabla-recientes');
  const lista = pedidos.filter(p => p.estado !== 'enviado-final').sort((a, b) => a.id - b.id);

  if (!lista.length) {
    cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.82rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);">Sin pedidos aún</div>`;
    return;
  }

  cont.innerHTML = lista.map(p => {
    const items  = p.items && p.items.length ? p.items.map(i => esc(i.prenda)).join(', ') : '—';
    const fecha  = p.fechaEntrega ? `📅 ${fmtFecha(p.fechaEntrega)}` : '';
    // Para el timeline, si el pedido tiene arreglo registrado tratamos la etapa 'arreglo'
    // como activa cuando está en calidad (esperando que llegue), o done cuando ya pasó de calidad
    const curIdx = TL_ORDER.indexOf(p.estado);
    const arregloIdx = TL_ORDER.indexOf('arreglo');

    const steps = TL_ETAPAS.map((etapa, i) => {
      let cls = '';
      if (etapa.key === 'arreglo') {
        if (p.arreglo && p.estado === 'calidad') cls = 'active';
        else if (p.arreglo && curIdx > arregloIdx) cls = 'done';
        else if (curIdx > arregloIdx) cls = 'done'; // pasó calidad sin arreglo
      } else {
        // índice real del estado actual (saltando 'arreglo' que no es estado real)
        const estadoIdx = curIdx >= arregloIdx ? curIdx + 1 : curIdx; // ajuste por etapa virtual
        if (i < arregloIdx) {
          if (i < curIdx) cls = 'done';
          if (i === curIdx) cls = 'active';
        } else if (i > arregloIdx) {
          const realI = i - 1; // índice real sin la etapa virtual
          if (realI < curIdx) cls = 'done';
          if (realI === curIdx) cls = 'active';
        }
      }
      return `<div class="tl-step ${cls}"><div class="tl-dot"></div><div class="tl-label">${etapa.label}</div></div>`;
    }).join('');

    return `
      <div class="pedido-row">
        <div class="pedido-row-top">
          <div class="pedido-row-id">#${p.id}</div>
          <div class="pedido-row-nombre">${esc(p.equipo || p.telefono)}</div>
          <div class="pedido-row-meta">
            <span>${esc(p.vendedora || '—')}</span>
            <span style="color:var(--text-muted);font-size:0.68rem;">${items}</span>
          </div>
          ${fecha ? `<div class="pedido-row-fecha">${fecha}</div>` : ''}
        </div>
        <div class="timeline-bar">${steps}</div>
      </div>
    `;
  }).join('');

}

/* ─── Bandeja ────────────────────────────────────────────────── */
let busquedaActual = '';
let wsInstallPrompt = null;

function registrarPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('[pwa] sw', e.message));
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    wsInstallPrompt = e;
    renderInstallCard();
  });
  window.addEventListener('appinstalled', () => {
    wsInstallPrompt = null;
    localStorage.setItem('ws_pwa_installed', '1');
    renderInstallCard();
  });
}

function renderInstallCard() {
  const cont = document.getElementById('mobile-install-card');
  if (!cont) return;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone || localStorage.getItem('ws_pwa_installed') === '1') {
    cont.innerHTML = '';
    return;
  }
  const canInstall = !!wsInstallPrompt;
  cont.innerHTML = `
    <div class="mobile-install-card">
      <strong>Instalar como app</strong>
      <p>${canInstall ? 'Deja W&S en la pantalla principal del celular.' : 'En Chrome toca los 3 puntos y elige Agregar a pantalla principal.'}</p>
      <button onclick="instalarAppWys()">${canInstall ? 'Instalar ahora' : 'Ver instrucciones'}</button>
    </div>
  `;
}

async function instalarAppWys() {
  if (!wsInstallPrompt) {
    alert('Para instalar: abre el menu de Chrome (3 puntos) y toca "Agregar a pantalla principal" o "Instalar app".');
    return;
  }
  wsInstallPrompt.prompt();
  await wsInstallPrompt.userChoice.catch(() => null);
  wsInstallPrompt = null;
  renderInstallCard();
}

function buscarPedidos(q) {
  busquedaActual = q.toLowerCase().trim();
  renderBandeja();
}

function renderBandeja() {
  const q = busquedaActual;
  const filtrar = p => !q ||
    (p.equipo   && p.equipo.toLowerCase().includes(q)) ||
    (p.telefono && p.telefono.toLowerCase().includes(q));

  const cotizaciones = pedidos.filter(p => p.tipoBandeja === 'cotizar' && p.estado === 'bandeja' && filtrar(p));
  // Pedidos confirmados: visible desde que se confirman hasta que se entregan (todo excepto enviado-final)
  const pedidosConf  = pedidos.filter(p => p.tipoBandeja === 'pedido' && p.estado !== 'enviado-final' && filtrar(p));

  document.getElementById('count-cotizar').textContent = cotizaciones.length;
  document.getElementById('count-pedido').textContent  = pedidosConf.length;

  document.getElementById('lista-cotizar').innerHTML = renderBandejaCotizaciones(cotizaciones);
  document.getElementById('lista-pedido').innerHTML  = renderBandejaPedidos(pedidosConf);
}

function renderBandejaCotizaciones(arr) {
  if (!arr.length) return `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">Sin cotizaciones pendientes</div><div class="empty-hint">Cuando llegue un PDF por correo o WhatsApp aparece aqui. O toca <strong>+ Nuevo pedido</strong> para crear uno manual.</div></div>`;
  return arr.map(p => `
    <div class="bandeja-card">
      <div class="bandeja-card-top">
        <div>
          <div class="bandeja-phone" style="display:flex;align-items:center;gap:6px;">${esc(p.equipo || p.telefono)} <span onclick="editarEquipo(${p.id})" title="Editar nombre" style="cursor:pointer;font-size:0.75rem;color:var(--text-muted);opacity:0.7;">✎</span></div>
          ${p.equipo && p.telefono ? `<div style="font-size:0.7rem;color:var(--text-muted);">📱 ${esc(p.telefono)}</div>` : ''}
        </div>
        <div class="bandeja-id">#${p.id}</div>
      </div>
      <div class="bandeja-meta">
        <span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${esc(p.vendedora || '—')}
        </span>
        <span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          ${esc(p.creadoEn || '—')}
        </span>
      </div>
      <div class="bandeja-actions">
        <button class="btn btn-primary btn-sm" onclick="openModalCompletar(${p.id})">Completar →</button>
      </div>
    </div>
  `).join('');
}

// Colores de etapa para el badge en la tarjeta de bandeja
const ETAPA_COLOR = {
  'bandeja':           '#64748b',
  'hacer-diseno':      '#a78bfa',
  'confirmado':        '#06b6d4',
  'enviado-calandra':  '#f97316',
  'llego-impresion':   '#f97316',
  'corte':             '#f59e0b',
  'en-satelite':       '#a855f7',
  'calidad':           '#ef4444',
  'costura':           '#10b981',
  'listo':             '#10b981',
};

function irAlPedido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const ESTADO_SECCION = {
    'hacer-diseno':      'diseno',
    'confirmado':        'diseno',
    'enviado-calandra':  'diseno',
    'llego-impresion':   'produccion',
    'corte':             'produccion',
    'costura':           'satelites',
    'en-satelite':       'satelites',
    'calidad':           'produccion',
    'listo':             'envios',
    'enviado-final':     'envios',
  };
  const seccion = ESTADO_SECCION[p.estado] || 'produccion';
  const navEl = document.querySelector(`.nav-item[onclick*="'${seccion}'"]`);
  showSection(seccion, navEl);
}

// Limpieza masiva: borra cotizaciones (estado=bandeja) más viejas que N días.
// Útil para el caso de pedidos zombies que vienen de antes del fix de eliminadosLocales.
async function limpiarBandejaVieja(diasUmbral = 30) {
  const ahora = Date.now();
  const limite = ahora - (diasUmbral * 24 * 60 * 60 * 1000);
  const candidatos = pedidos.filter(p => {
    if (p.estado !== 'bandeja') return false;
    if ((p.tipoBandeja || 'cotizar') !== 'cotizar') return false;
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    return t < limite;
  });
  if (!candidatos.length) {
    toast(`No hay cotizaciones de más de ${diasUmbral} días para limpiar`, 'info');
    return;
  }
  const lista = candidatos.slice(0, 5).map(p => `#${p.id} ${p.equipo || p.telefono || ''}`).join(', ');
  const extras = candidatos.length > 5 ? ` y ${candidatos.length - 5} más` : '';
  if (!confirm(`¿Borrar ${candidatos.length} cotización${candidatos.length>1?'es':''} viejas?\n\n${lista}${extras}\n\nSe eliminan en todos los dispositivos.`)) return;

  const ids = candidatos.map(p => p.id);
  ids.forEach(id => eliminadosLocales.add(id));
  pedidos = pedidos.filter(p => !ids.includes(p.id));
  render();
  let okCount = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`/api/pedidos/${id}`, { method: 'DELETE' });
      if (r.ok || r.status === 404) okCount++;
    } catch {}
  }
  guardar();
  toast(`🧹 ${okCount}/${ids.length} cotizaciones viejas eliminadas`, 'success');
}

async function eliminarPedidoBandeja(id, event) {
  event.stopPropagation();
  const p = pedidos.find(x => x.id === id);
  const esProtegido = p && (p.origenBot || p.origenFacturaHuerfana || p.origenHuerfano || p.origenComprobante);
  const aviso = esProtegido
    ? `¿Eliminar pedido #${id}?\n\n⚠️ Este pedido fue creado por el sistema (sticker/factura/comprobante). Si lo borrás solo en este dispositivo, el server puede recrearlo. Para borrarlo en serio hay que borrar también la factura/comprobante origen.`
    : `¿Eliminar pedido #${id}?`;
  if (!confirm(aviso)) return;
  // Solo marcar como eliminado local si NO es protegido (los protegidos los recrea el server
  // y deben aparecer en todos los dispositivos — eliminadosLocales rompía esa coherencia)
  if (!esProtegido) eliminadosLocales.add(id);
  pedidos = pedidos.filter(x => x.id !== id);
  render();
  // Intentar DELETE con un retry si falla (red caída por un instante, etc.)
  let serverOk = false;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const r = await fetch(`/api/pedidos/${id}`, { method: 'DELETE' });
      if (r.ok || r.status === 404) { serverOk = true; break; }
    } catch {}
  }
  guardar();
  if (serverOk) {
    toast(`Pedido #${id} eliminado en todos los dispositivos`, 'success');
  } else {
    toast(`#${id} eliminado localmente — se sincronizará apenas vuelva la conexión`, 'info');
  }
}

function renderBandejaPedidos(arr) {
  if (!arr.length) return `<div class="empty-state"><div class="empty-icon">🎯</div><div class="empty-text">Sin pedidos confirmados ahora</div><div class="empty-hint">Cuando la vendedora oficialice una venta con el sticker 💰 aparece aqui en camino a diseño/produccion.</div></div>`;
  return arr.map(p => {
    const etiqueta = ESTADO_LABELS[p.estado] || p.estado;
    const color    = ETAPA_COLOR[p.estado] || '#64748b';

    const itemsTxt = p.items && p.items.length
      ? p.items.map(i => `${esc(i.prenda)}`).join(', ')
      : 'Sin prendas';

    const fechaHtml = p.fechaEntrega
      ? `<span onclick="editarFecha(${p.id});event.stopPropagation();" title="Clic para cambiar fecha" style="cursor:pointer;color:#fde047;">📅 ${fmtFecha(p.fechaEntrega)} <span style="opacity:0.5;font-size:0.65rem;">✎</span></span>`
      : `<span onclick="editarFecha(${p.id});event.stopPropagation();" title="Agregar fecha de entrega" style="cursor:pointer;color:var(--text-muted);">📅 Agregar fecha</span>`;

    const esNavegable = p.estado !== 'bandeja';

    return `
    <div class="bandeja-card" ${esNavegable ? `onclick="irAlPedido(${p.id})" style="cursor:pointer;"` : ''}>
      <div class="bandeja-card-top">
        <div>
          <div class="bandeja-phone" style="display:flex;align-items:center;gap:6px;">${esc(p.equipo || p.telefono)} ${['bandeja','hacer-diseno','confirmado','enviado-calandra'].includes(p.estado) ? `<span onclick="editarEquipo(${p.id});event.stopPropagation();" title="Editar nombre" style="cursor:pointer;font-size:0.75rem;color:var(--text-muted);opacity:0.7;">✎</span>` : ''}</div>
          ${p.equipo && p.telefono ? `<div style="font-size:0.7rem;color:var(--text-muted);">📱 ${esc(p.telefono)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="bandeja-id">#${p.id}</div>
          <button onclick="eliminarPedidoBandeja(${p.id}, event)" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:4px;padding:1px 6px;font-size:0.7rem;cursor:pointer;line-height:1.4;">✕</button>
        </div>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">${itemsTxt}</div>
      <div class="bandeja-meta">
        <span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${esc(p.vendedora || '—')}
        </span>
        ${fechaHtml}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span style="display:inline-block;font-size:0.68rem;font-weight:700;padding:3px 8px;border-radius:20px;background:${color}22;color:${color};border:1px solid ${color}55;">● ${etiqueta}</span>
        ${esNavegable ? `<span style="font-size:0.65rem;color:var(--text-muted);">→ ver pedido</span>` : ''}
        <button onclick="openModalCompletar(${p.id});event.stopPropagation();" style="margin-left:auto;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);color:#a78bfa;border-radius:4px;padding:2px 8px;font-size:0.68rem;cursor:pointer;">✏ Editar prendas</button>
      </div>
    </div>
  `;
  }).join('');
}

/* ─── Kanban ─────────────────────────────────────────────────── */


function renderKanban(estado) {
  const col = document.getElementById(`col-${estado}`);
  const cnt = document.getElementById(`cnt-${estado}`);

  const items = pedidos.filter(p => p.estado === estado);
  if (cnt) cnt.textContent = items.length;

  const emptyHtml = `<div class="empty-state"><div class="empty-icon" style="font-size:1.3rem;opacity:0.2;">○</div><div class="empty-text">Vacío</div></div>`;

  if (col) col.innerHTML = items.length ? items.map(p => renderKanbanCard(p)).join('') : emptyHtml;
}

// Render del bloque Drive (Corel + PDF RIP) en una tarjeta de pedido.
// Muestra botones para ver el .cdr y el .pdf que se mandó a calandra.
function driveBadgeHtml(p) {
  const d = p.drive;
  if (!d || (!d.corel && !d.pdfRip)) return '';
  const corelBtn = d.corel
    ? `<a href="${esc(d.corel.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(d.corel.nombre)}" style="display:inline-block;background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.4);color:#c4b5fd;border-radius:5px;padding:3px 8px;font-size:0.68rem;font-weight:600;text-decoration:none;margin-right:4px;">🎨 Ver Corel</a>`
    : '';
  const pdfBtn = d.pdfRip
    ? `<a href="${esc(d.pdfRip.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(d.pdfRip.nombre)}" style="display:inline-block;background:rgba(251,146,60,0.18);border:1px solid rgba(251,146,60,0.4);color:#fdba74;border-radius:5px;padding:3px 8px;font-size:0.68rem;font-weight:600;text-decoration:none;">📑 Ver PDF rip</a>`
    : '';
  return `<div style="margin-bottom:6px;">${corelBtn}${pdfBtn}</div>`;
}

// Render del bloque WeTransfer en una tarjeta de pedido.
// Muestra archivos enviados a calandra, m², link al envío y estado (enviado/descargado).
function wtBadgeHtml(p) {
  if (!p.wetransfer || !p.wetransfer.archivos || !p.wetransfer.archivos.length) return '';
  const archivos = p.wetransfer.archivos;
  const linkUnico = archivos.find(a => a.linkWT) ? archivos.find(a => a.linkWT).linkWT : null;
  const m2Total = archivos.reduce((s, a) => s + (a.m2 || 0), 0);
  const tipoBadges = {
    original: '📦',
    arreglo: '🔧',
    adicional: '➕',
    muestra: '🧪',
  };
  const items = archivos.slice(0, 4).map(a => {
    const icon = tipoBadges[a.tipo] || '📄';
    const descargado = a.fechaDescarga ? '<span title="Calandra ya descargó" style="color:#34d399;font-weight:700;">✓</span>' : '<span title="Esperando descarga" style="color:#fbbf24;">⏳</span>';
    const m2Txt = a.m2 ? `${a.m2}m²` : '';
    const prio = a.prioridad === 'urgente' ? ' <span style="color:#fca5a5;font-weight:700;">URGENTE</span>' : '';
    const tela = a.tela ? ` · ${esc(a.tela)}` : '';
    return `<div style="font-size:0.66rem;color:#cbd5e1;margin:1px 0;">${icon} ${esc(a.nombreOriginal)} ${descargado} <span style="color:var(--text-muted);">${m2Txt}${tela}${prio}</span></div>`;
  }).join('');
  const masTxt = archivos.length > 4 ? `<div style="font-size:0.62rem;color:var(--text-muted);">+ ${archivos.length - 4} más…</div>` : '';
  const linkBtn = linkUnico
    ? `<a href="${esc(linkUnico)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="display:inline-block;background:rgba(96,165,250,0.18);border:1px solid rgba(96,165,250,0.4);color:#93c5fd;border-radius:5px;padding:3px 8px;font-size:0.68rem;font-weight:600;text-decoration:none;margin-top:4px;">👁️ Ver en WeTransfer</a>`
    : '';
  return `
    <div style="background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.18);border-radius:6px;padding:6px 8px;margin-bottom:6px;">
      <div style="font-size:0.66rem;color:#93c5fd;font-weight:700;margin-bottom:3px;display:flex;justify-content:space-between;">
        <span>📤 WeTransfer</span>
        <span style="color:var(--text-muted);">${archivos.length} archivo${archivos.length>1?'s':''} · ${m2Total}m²</span>
      </div>
      ${items}
      ${masTxt}
      ${linkBtn}
    </div>
  `;
}

function renderKanbanCardDiseno(p) {
  const DISENADORES = ['Camilo', 'Oscar', 'Wendy', 'Ney', 'Paola'];
  const fechaTxt = p.fechaEntrega ? fmtFecha(p.fechaEntrega) : '-';
  const disenadorTxt = p.disenadorAsignado || '';

  const disenadorHtml = disenadorTxt
    ? `<div style="font-size:0.78rem;color:#a78bfa;font-weight:600;margin-bottom:8px;">🎨 ${esc(disenadorTxt)}</div>`
    : `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:8px;">🎨 Sin asignar</div>`;

  const notasHtml = p.notas
    ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px;font-style:italic;">📝 ${esc(p.notas)}</div>`
    : '';

  let actionHtml = '';
  if (p.estado === 'hacer-diseno') {
    if (!disenadorTxt) {
      const opts = DISENADORES.map(d => `<option value="${d}">${d}</option>`).join('');
      actionHtml = `
        <div style="display:flex;gap:6px;align-items:center;">
          <select id="sel-dis-${p.id}" style="flex:1;background:#1e1b2e;border:1px solid #4c1d95;border-radius:6px;color:#e2e8f0;font-size:0.75rem;padding:5px 8px;outline:none;">
            <option value="" style="background:#1e1b2e;color:#e2e8f0;">Seleccionar...</option>${opts.replace(/<option /g, '<option style="background:#1e1b2e;color:#e2e8f0;" ')}
          </select>
          <button onclick="tomarPedidoDiseno(${p.id})" style="background:rgba(124,58,237,0.25);border:1px solid rgba(124,58,237,0.5);color:#c4b5fd;border-radius:6px;padding:5px 10px;font-size:0.75rem;cursor:pointer;white-space:nowrap;">Tomar</button>
        </div>`;
    } else {
      actionHtml = `
        <div style="display:flex;gap:6px;">
          <button onclick="marcarDisenoListo(${p.id})" style="flex:1;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.4);color:#4ade80;border-radius:6px;padding:6px;font-size:0.78rem;cursor:pointer;font-weight:600;">✓ Listo</button>
          <button onclick="liberarPedidoDiseno(${p.id})" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:6px;padding:6px 10px;font-size:0.75rem;cursor:pointer;" title="Liberar pedido">✕</button>
        </div>`;
    }
  } else if (p.estado === 'confirmado') {
    actionHtml = `
      <div class="kanban-card-actions">
        <button class="btn btn-xs" onclick="retroceder(${p.id})" title="Retroceder estado" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:var(--text-muted);padding:4px 8px;font-size:0.85rem;line-height:1;">←</button>
        <button class="btn btn-primary btn-xs" onclick="avanzar(${p.id})">Enviar a calandra</button>
      </div>`;
  } else if (p.estado === 'enviado-calandra') {
    actionHtml = `
      <div class="kanban-card-actions">
        <button class="btn btn-xs" onclick="retroceder(${p.id})" title="Retroceder estado" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:var(--text-muted);padding:4px 8px;font-size:0.85rem;line-height:1;">←</button>
        <button class="btn btn-primary btn-xs" onclick="avanzar(${p.id})">Llegó impresión</button>
      </div>`;
  }

  return `
    <div class="kanban-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:0.7rem;color:var(--text-muted);">#${p.id}</div>
      </div>
      <div style="font-size:0.9rem;font-weight:700;color:var(--text);margin-bottom:6px;">${esc(p.equipo || p.telefono)}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
        <span style="background:rgba(234,179,8,0.15);border:1px solid rgba(234,179,8,0.35);color:#fde047;border-radius:5px;padding:2px 8px;font-size:0.73rem;font-weight:700;">📅 ${fechaTxt}</span>
        <span style="font-size:0.73rem;color:var(--text-muted);">👤 ${esc(p.vendedora || '-')}</span>
      </div>
      ${notasHtml}
      ${disenadorHtml}
      ${driveBadgeHtml(p)}
      ${wtBadgeHtml(p)}
      ${actionHtml}
    </div>
  `;
}

function tomarPedidoDiseno(id) {
  const sel = document.getElementById(`sel-dis-${id}`);
  const nombre = sel ? sel.value : '';
  if (!nombre) { toast('Selecciona un diseñador', 'error'); return; }
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.disenadorAsignado = nombre;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`${nombre} tomó el pedido #${id}`, 'ok');
}

function marcarDisenoListo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.estado = 'confirmado';
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`Pedido #${id} marcado como listo`, 'ok');
}

function editarFecha(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;

  // Mini modal inline
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#1e1b2e;border:1px solid #4c1d95;border-radius:12px;padding:24px;min-width:280px;text-align:center;">
      <div style="font-size:0.9rem;color:#e2e8f0;font-weight:600;margin-bottom:16px;">📅 Fecha de entrega — #${p.id} ${esc(p.equipo||'')}</div>
      <input type="date" id="fecha-edit-input" value="${p.fechaEntrega||''}" style="width:100%;background:#0f0d1a;border:1px solid #4c1d95;border-radius:8px;color:#e2e8f0;font-size:1rem;padding:8px 12px;outline:none;margin-bottom:16px;">
      <div style="display:flex;gap:8px;justify-content:center;">
        <button onclick="confirmarFecha(${id})" style="background:rgba(124,58,237,0.3);border:1px solid rgba(124,58,237,0.6);color:#c4b5fd;border-radius:8px;padding:8px 20px;cursor:pointer;font-size:0.85rem;">Guardar</button>
        <button onclick="this.closest('.fecha-overlay').remove()" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;border-radius:8px;padding:8px 20px;cursor:pointer;font-size:0.85rem;">Cancelar</button>
      </div>
    </div>`;
  overlay.classList.add('fecha-overlay');
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function confirmarFecha(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const val = document.getElementById('fecha-edit-input').value;
  p.fechaEntrega = val;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  document.querySelector('.fecha-overlay')?.remove();
  toast('Fecha actualizada', 'ok');
}

function editarEquipo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#1e1b2e;border:1px solid #4c1d95;border-radius:12px;padding:24px;min-width:300px;text-align:center;">
      <div style="font-size:0.9rem;color:#e2e8f0;font-weight:600;margin-bottom:16px;">✏️ Nombre del equipo — #${p.id}</div>
      <input type="text" id="equipo-edit-input" value="${esc(p.equipo||'')}" placeholder="Nombre del equipo / cliente" style="width:100%;background:#0f0d1a;border:1px solid #4c1d95;border-radius:8px;color:#e2e8f0;font-size:1rem;padding:8px 12px;outline:none;margin-bottom:16px;box-sizing:border-box;">
      <div style="display:flex;gap:8px;justify-content:center;">
        <button onclick="confirmarEquipo(${id})" style="background:rgba(124,58,237,0.3);border:1px solid rgba(124,58,237,0.6);color:#c4b5fd;border-radius:8px;padding:8px 20px;cursor:pointer;font-size:0.85rem;">Guardar</button>
        <button onclick="this.closest('.equipo-overlay').remove()" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;border-radius:8px;padding:8px 20px;cursor:pointer;font-size:0.85rem;">Cancelar</button>
      </div>
    </div>`;
  overlay.classList.add('equipo-overlay');
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  setTimeout(() => { const i = document.getElementById('equipo-edit-input'); if(i){i.focus();i.select();} }, 100);
}

function confirmarEquipo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const val = document.getElementById('equipo-edit-input').value.trim();
  if (!val) { toast('El nombre no puede estar vacío', 'error'); return; }
  p.equipo = val;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  document.querySelector('.equipo-overlay')?.remove();
  toast('Nombre actualizado', 'ok');
}

function liberarPedidoDiseno(id) {
  if (!confirm('¿Liberar este pedido para que otro diseñador lo tome?')) return;
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.disenadorAsignado = '';
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`Pedido #${id} liberado`, 'info');
}

function renderKanbanCard(p) {
  const ESTADOS_DISENO = ['hacer-diseno', 'confirmado', 'enviado-calandra'];
  if (ESTADOS_DISENO.includes(p.estado)) return renderKanbanCardDiseno(p);

  const siguiente = SIGUIENTE[p.estado];
  const itemsTxt = p.items && p.items.length
    ? p.items.map(i => `<span>${esc(i.prenda)}</span> · <span style="opacity:.7">${esc(i.tela)}</span>`).join('<br>')
    : '<span style="opacity:.5">Sin prendas</span>';

  const fechaHtml = p.fechaEntrega
    ? `<div class="kanban-card-date" onclick="editarFecha(${p.id})" title="Clic para cambiar fecha" style="cursor:pointer;">📅 ${fmtFecha(p.fechaEntrega)} ✎</div>`
    : `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;cursor:pointer;" onclick="editarFecha(${p.id})" title="Agregar fecha de entrega">📅 Sin fecha — agregar</div>`;

  const notasHtml = p.notas
    ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-bottom:6px;font-style:italic;">"${esc(p.notas)}"</div>`
    : '';

  const arregloInfoHtml = (p.arreglo && p.arreglo !== 'pendiente' && p.estado !== 'calidad')
    ? `<div style="font-size:0.68rem;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:5px;padding:4px 7px;color:#fca5a5;margin-bottom:6px;white-space:pre-line;">⚠ Arreglo: ${esc(p.arreglo)}</div>`
    : '';

  let actionsHtml = '';

  if (p.estado === 'listo') {
    actionsHtml = `
      <button onclick="copiarMsgListo(${p.id})" style="width:100%;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.35);border-radius:6px;color:#4ade80;font-size:0.75rem;font-weight:600;padding:6px 10px;cursor:pointer;margin-bottom:8px;">📋 Copiar mensaje para cliente</button>
      <div style="font-size:0.68rem;color:var(--text-muted);margin-bottom:4px;font-weight:600;">¿Cómo se envía?</div>
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:6px;">
        ${METODOS_ENVIO.map(m => `<button onclick="registrarEnvioDirecto(${p.id},'${esc(m)}')" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:var(--text);font-size:0.72rem;padding:5px 8px;cursor:pointer;text-align:left;">${esc(m)}</button>`).join('')}
      </div>
    `;
  } else if (siguiente) {
    const btnLabel = getBotonLabel(p.estado);
    const antEstado = ANTERIOR[p.estado];
    actionsHtml = `
      <div class="kanban-card-actions">
        ${antEstado ? `<button class="btn btn-xs" onclick="retroceder(${p.id})" title="Retroceder estado" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:var(--text-muted);padding:4px 8px;font-size:0.85rem;line-height:1;">←</button>` : ''}
        <button class="btn btn-primary btn-xs" onclick="avanzar(${p.id})">${btnLabel}</button>
      </div>
    `;
  } else if (p.estado === 'enviado-final') {
    actionsHtml = `
      <div class="kanban-card-actions">
        <button onclick="eliminarPedido(${p.id})" style="width:100%;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:6px;padding:5px 10px;font-size:0.75rem;cursor:pointer;">✕ Eliminar</button>
      </div>`;
  } else {
    actionsHtml = '';
  }

  return `
    <div class="kanban-card ${p.arreglo ? 'arreglo' : ''}">
      <div class="kanban-card-id">#${p.id}</div>
      <div class="kanban-card-phone" style="font-size:0.85rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;">
        ${esc(p.equipo || p.telefono)}
        ${['bandeja','hacer-diseno','confirmado','enviado-calandra'].includes(p.estado) ? `<span onclick="editarEquipo(${p.id})" title="Editar nombre" style="cursor:pointer;font-size:0.75rem;color:var(--text-muted);opacity:0.7;">✎</span>` : ''}
      </div>
      ${p.equipo && p.telefono ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px;">📱 ${esc(p.telefono)}</div>` : ''}
      <div class="kanban-card-items">${itemsTxt}</div>
      <div class="kanban-card-vendor">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        ${esc(p.vendedora || '—')}
      </div>
      ${fechaHtml}
      ${notasHtml}
      ${arregloInfoHtml}
      ${driveBadgeHtml(p)}
      ${wtBadgeHtml(p)}
      ${actionsHtml}
    </div>
  `;
}

function getBotonLabel(estado) {
  const flujoReal = {
    'hacer-diseno': 'Confirmado',
    'confirmado': 'A calandra',
    'enviado-calandra': 'Llego impresion',
    'llego-impresion': 'A corte',
    'corte': 'A costura',
    'costura': 'A revision',
    'en-satelite': 'A revision',
    'calidad': 'Listo',
    'listo': 'Enviar',
  };
  if (flujoReal[estado]) return flujoReal[estado];
  const labels = {
    'hacer-diseno':     '✓ Confirmado',
    'confirmado':       '→ Calandra',
    'enviado-calandra': '→ Llegó impresión',
    'llego-impresion':  '→ Corte',
    'corte':            '→ Costura',
    'costura':          '→ Revision',
    'en-satelite':      '→ Revision',
    'calidad':          '→ Listo',
    'listo':            '→ Enviar',
  };
  return labels[estado] || '→ Siguiente';
}

/* ════════════════════════════════════════════════════════════════
   ACCIONES
════════════════════════════════════════════════════════════════ */
const NOTIF_ICONS = {
  'bandeja':          '💼',
  'hacer-diseno':     '🎨',
  'confirmado':       '✅',
  'enviado-calandra': '📤',
  'llego-impresion':  '🖨️',
  'calidad':          '🔍',
  'costura':          '🧵',
  'listo':            '📦',
  'enviado-final':    '🚀',
};

function avanzar(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const sig = SIGUIENTE[p.estado];
  if (!sig) return;
  p.estado = sig;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} → ${ESTADO_LABELS[sig]}`, 'success');

  const icono = NOTIF_ICONS[sig] || '➡️';
  const nombre = p.equipo || p.telefono;
  if (sig === 'listo') {
    crearNotif(icono, `<strong>#${id} ${esc(nombre)}</strong> está <strong>listo para entregar</strong> — vendedora: ${esc(p.vendedora || '—')}`, 'success', id);
  } else if (sig === 'calidad') {
    crearNotif(icono, `<strong>#${id} ${esc(nombre)}</strong> llegó a <strong>control calidad</strong>`, 'info', id);
  } else if (sig === 'enviado-calandra') {
    crearNotif(icono, `<strong>#${id} ${esc(nombre)}</strong> enviado a <strong>calandra</strong>`, 'info', id);
  } else if (sig === 'llego-impresion') {
    crearNotif(icono, `<strong>#${id} ${esc(nombre)}</strong> llego impresion, pasa a <strong>corte</strong>`, 'info', id);
  } else if (sig === 'enviado-final') {
    crearNotif('🚀', `<strong>#${id} ${esc(nombre)}</strong> <strong>enviado al cliente</strong> — pedido completado`, 'success', id);
  } else {
    crearNotif(icono, `<strong>#${id} ${esc(nombre)}</strong> avanzó a <strong>${ESTADO_LABELS[sig]}</strong>`, 'info', id);
  }
}

function retroceder(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const ant = ANTERIOR[p.estado];
  if (!ant) return;
  p.estado = ant;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} ← ${ESTADO_LABELS[ant]}`, 'info');
}

function avanzarNormal(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.estado = 'costura';
  p.arreglo = null;
  p.arregloDisenador = null;
  p.arregloEnviado = false;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} arreglo llegó → Costura`, 'success');
  crearNotif('🧵', `<strong>#${id} ${esc(p.equipo || p.telefono)}</strong> — arreglo resuelto, pasa a <strong>costura</strong>`, 'success', id);
}

function registrarArreglo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.arreglo = 'pendiente';
  p.arregloDisenador = null;
  p.arregloEnviado = false;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} marcado con arreglo — escribe la descripción y asigna diseñador`, 'info');
  crearNotif('⚠️', `<strong>#${id} ${esc(p.equipo || p.telefono)}</strong> — tiene un <strong>arreglo pendiente</strong> en calidad`, 'warning', id);
}

function guardarArregloConDisenador(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const el = document.getElementById(`arreglo-edit-${id}`);
  const selDis = document.getElementById(`arreglo-dis-${id}`);
  const desc = el ? el.value.trim() : '';
  const dis = selDis ? selDis.value : '';
  if (!desc) { toast('Escribe qué hay que arreglar', 'error'); return; }
  if (!dis) { toast('Selecciona un diseñador', 'error'); return; }
  p.arreglo = desc;
  p.arregloDisenador = dis;
  p.arregloEnviado = false;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} arreglo asignado a ${dis}`, 'success');
  crearNotif('🎨', `<strong>#${id} ${esc(p.equipo || p.telefono)}</strong> — arreglo asignado a <strong>${esc(dis)}</strong>`, 'warning', id);
}

function marcarArregloEnviado(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.arregloEnviado = true;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} arreglo enviado por ${p.arregloDisenador}`, 'info');
  crearNotif('📤', `<strong>#${id} ${esc(p.equipo || p.telefono)}</strong> — arreglo <strong>enviado</strong> por ${esc(p.arregloDisenador)}`, 'info', id);
}

function guardarDescArreglo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const el = document.getElementById(`arreglo-edit-${id}`);
  const val = el ? el.value.trim() : '';
  if (!val) { toast('Escribe qué hay que arreglar', 'error'); return; }
  p.arreglo = val;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  renderBadges();
  renderMetricas();
  toast(`✓ Arreglo guardado`, 'success');
}

function llegoFaltante(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.arreglo = null;
  p.estado  = 'costura';
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} → Costura (faltante llegó)`, 'success');
}

async function eliminarPedido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  if (p.estado !== 'enviado-final') {
    toast(`#${id} solo se puede eliminar cuando esté enviado`, 'info');
    return;
  }
  if (!confirm(`¿Eliminar pedido #${id}?`)) return;
  eliminadosLocales.add(id);
  pedidos = pedidos.filter(x => x.id !== id);
  render();
  try { await fetch(`/api/pedidos/${id}`, { method: 'DELETE' }); } catch {}
  guardar();
  toast(`Pedido #${id} eliminado`, 'info');
}

/* ════════════════════════════════════════════════════════════════
   MODAL COMPLETAR
════════════════════════════════════════════════════════════════ */
function openModalCompletar(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  modalCompletarId = id;

  // Ajustar título según tipo
  const titulo = document.getElementById('modal-completar-titulo');
  if (titulo) titulo.textContent = p.tipoBandeja === 'cotizar' ? 'Confirmar cotización' : 'Completar pedido';

  document.getElementById('comp-telefono').value = p.telefono || '';
  document.getElementById('comp-vendedora').value = p.vendedora || '';
  document.getElementById('comp-fecha').value = p.fechaEntrega || '';
  document.getElementById('comp-notas').value = p.notas || '';

  // Poblar items existentes si hay
  const lista = document.getElementById('comp-items-list');
  lista.innerHTML = '';
  const items = p.items && p.items.length ? p.items : [{ prenda: PRENDAS[0], tela: TELAS[0] }];
  items.forEach(item => addItemCompConValor(item.prenda, item.tela));

  document.getElementById('modal-completar').classList.add('open');
}

function addItemComp() { addItemCompConValor(); }

function addItemCompConValor(prenda = PRENDAS[0], tela = TELAS[0]) {
  const lista = document.getElementById('comp-items-list');
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <select>
      ${PRENDAS.map(pr => `<option ${pr === prenda ? 'selected' : ''}>${pr}</option>`).join('')}
    </select>
    <span class="item-sep">·</span>
    <select>
      ${TELAS.map(t => `<option ${t === tela ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <button class="item-remove" onclick="this.parentElement.remove()">×</button>
  `;
  lista.appendChild(row);
}

function guardarCompletar() {
  if (!modalCompletarId) return;
  const p = pedidos.find(x => x.id === modalCompletarId);
  if (!p) return;

  const fecha = document.getElementById('comp-fecha').value;
  const notas = document.getElementById('comp-notas').value.trim();

  const rows  = document.querySelectorAll('#comp-items-list .item-row');
  const items = Array.from(rows).map(row => {
    const sels = row.querySelectorAll('select');
    return { prenda: sels[0].value, tela: sels[1].value };
  });

  p.fechaEntrega = fecha;
  p.notas        = notas;
  p.items        = items;

  // Cotización completada → se convierte en pedido confirmado
  // Estado pasa a 'hacer-diseno' y tipoBandeja a 'pedido'
  // A partir de aquí aparece en la columna "Pedidos confirmados" con su etapa visible
  p.tipoBandeja = 'pedido';
  p.estado      = 'hacer-diseno';
  p.ultimoMovimiento = new Date().toISOString();

  guardar();
  closeModal('modal-completar');
  render();
  toast(`#${p.id} confirmado — en cola de diseño`, 'success');
}

function avanzarDesdeBandeja(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const sig = SIGUIENTE[p.estado];
  if (!sig) return;
  p.estado = sig;
  guardar();
  render();
  toast(`#${id} → ${ESTADO_LABELS[sig]}`, 'success');
}

function getBandejaBotonLabel(estado) {
  const flujoReal = {
    'bandeja': 'Iniciar diseno',
    'hacer-diseno': 'Diseno listo',
    'confirmado': 'Enviar a calandra',
    'enviado-calandra': 'Llego impresion',
    'llego-impresion': 'Pasar a corte',
    'corte': 'Pasar a costura',
    'costura': 'Pasar a revision',
    'en-satelite': 'Pasar a revision',
    'calidad': 'Revision OK',
    'listo': 'Entregar / Enviar',
  };
  if (flujoReal[estado]) return flujoReal[estado];
  const labels = {
    'bandeja':           '→ Iniciar diseño',
    'hacer-diseno':      '→ Diseño listo',
    'confirmado':        '→ Enviar a calandra',
    'enviado-calandra':  '→ Llegó impresión',
    'llego-impresion':   '→ Corte',
    'corte':             '→ Costura',
    'costura':           '→ Revision',
    'en-satelite':       '→ Revision',
    'calidad':           '→ Listo',
    'listo':             '→ Entregar / Enviar',
  };
  return labels[estado] || '→ Siguiente';
}

/* ════════════════════════════════════════════════════════════════
   MODAL NUEVO PEDIDO
════════════════════════════════════════════════════════════════ */
function openModalNuevo() {
  tipoNuevo = 'cotizar';
  document.getElementById('nuevo-telefono').value = '';
  document.getElementById('nuevo-vendedora').value = '';
  document.getElementById('nuevo-fecha').value = '';
  document.getElementById('nuevo-notas').value = '';
  document.getElementById('nuevo-items-list').innerHTML = '';
  document.getElementById('nuevo-extra').style.display = 'none';
  document.getElementById('tipo-cotizar').className = 'tipo-btn active-cotizar';
  document.getElementById('tipo-pedido').className  = 'tipo-btn';
  document.getElementById('modal-nuevo').classList.add('open');
}

function setTipo(tipo) {
  tipoNuevo = tipo;
  if (tipo === 'cotizar') {
    document.getElementById('tipo-cotizar').className = 'tipo-btn active-cotizar';
    document.getElementById('tipo-pedido').className  = 'tipo-btn';
    document.getElementById('nuevo-extra').style.display = 'none';
  } else {
    document.getElementById('tipo-cotizar').className = 'tipo-btn';
    document.getElementById('tipo-pedido').className  = 'tipo-btn active-pedido';
    document.getElementById('nuevo-extra').style.display = 'block';
    if (!document.getElementById('nuevo-items-list').children.length) {
      addItemNuevo();
    }
  }
}

function addItemNuevo() { addItemNuevoConValor(); }

function addItemNuevoConValor(prenda = PRENDAS[0], tela = TELAS[0]) {
  const lista = document.getElementById('nuevo-items-list');
  const row   = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <select>
      ${PRENDAS.map(pr => `<option ${pr === prenda ? 'selected' : ''}>${pr}</option>`).join('')}
    </select>
    <span class="item-sep">·</span>
    <select>
      ${TELAS.map(t => `<option ${t === tela ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <button class="item-remove" onclick="this.parentElement.remove()">×</button>
  `;
  lista.appendChild(row);
}

function guardarNuevo() {
  const equipo = document.getElementById('nuevo-equipo').value.trim();
  const tel  = document.getElementById('nuevo-telefono').value.trim();
  const vend = document.getElementById('nuevo-vendedora').value;

  if (!equipo) { toast('Ingresa el nombre del equipo o cliente', 'error'); return; }
  if (!vend) { toast('Selecciona una vendedora', 'error'); return; }

  const pedido = {
    id:          nextId++,
    equipo:      equipo,
    telefono:    tel,
    vendedora:   vend,
    tipoBandeja: tipoNuevo,
    estado:      'bandeja',
    creadoEn:    new Date().toLocaleDateString('es-CO'),
    items:       [],
    fechaEntrega: '',
    notas:       '',
    arreglo:     null,
  };

  if (tipoNuevo === 'pedido') {
    pedido.fechaEntrega = document.getElementById('nuevo-fecha').value;
    pedido.notas        = document.getElementById('nuevo-notas').value.trim();
    const rows = document.querySelectorAll('#nuevo-items-list .item-row');
    pedido.items = Array.from(rows).map(row => {
      const sels = row.querySelectorAll('select');
      return { prenda: sels[0].value, tela: sels[1].value };
    });
    // Pedido directo entra confirmado, va directo a diseño
    pedido.estado = 'hacer-diseno';
  }

  pedidos.push(pedido);
  guardar();
  closeModal('modal-nuevo');
  render();
  toast(`Pedido #${pedido.id} creado en bandeja`, 'success');

  if (tipoNuevo === 'pedido') {
    crearNotif('✅', `Nuevo pedido <strong>#${pedido.id} ${esc(pedido.equipo)}</strong> confirmado — vendedora: ${esc(pedido.vendedora)}`, 'success', pedido.id);
  } else {
    crearNotif('💼', `Nueva cotización <strong>#${pedido.id} ${esc(pedido.equipo)}</strong> — vendedora: ${esc(pedido.vendedora)}`, 'info', pedido.id);
  }
}

/* ════════════════════════════════════════════════════════════════
   MODALES HELPERS
════════════════════════════════════════════════════════════════ */
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// Cerrar al click fuera
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ESC key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  }
});

/* ════════════════════════════════════════════════════════════════
   TOAST
════════════════════════════════════════════════════════════════ */
function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span> ${esc(msg)}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ════════════════════════════════════════════════════════════════
   UTILIDADES
════════════════════════════════════════════════════════════════ */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Formatea "YYYY-MM-DD" → "Lun 26/03"
function fmtFecha(iso) {
  if (!iso) return '';
  // Parsear sin desfase de zona horaria
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${dias[date.getDay()]} ${dd}/${mm}`;
}

/* ════════════════════════════════════════════════════════════════
   FECHA HEADER
════════════════════════════════════════════════════════════════ */
function updateDate() {
  const now = new Date();
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  document.getElementById('header-date').textContent = now.toLocaleDateString('es-CO', opts);
}


function arregloLlego(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.arreglo = null;
  p.estado  = 'costura';
  guardar();
  render();
  toast(`#${id} → Costura`, 'success');
}

/* ════════════════════════════════════════════════════════════════
   ENVÍOS
════════════════════════════════════════════════════════════════ */
const METODOS_ENVIO = ['Interrapidísimo', 'Bus / Encomienda terminal', 'Recogió en fábrica'];

function registrarEnvio(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const sel = document.getElementById(`metodo-${id}`);
  const metodo = sel ? sel.value : '';
  if (!metodo) { toast('Selecciona el método de envío', 'error'); return; }
  p.metodoEnvio = metodo;
  p.estado      = 'enviado-final';
  guardar();
  render();
  toast(`#${id} enviado — ${metodo}`, 'success');
}

function copiarMsgListo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const nombre = p.equipo || p.telefono || 'cliente';
  const msg = `Hola! 👋 Le informamos que su pedido *${nombre}* ya está listo para despacho. 🎉\n\nPor favor enviar el saldo restante para proceder con el envío.\n\n¡Gracias por su compra! 🙏`;
  navigator.clipboard.writeText(msg).then(() => {
    toast('Mensaje copiado — pégalo en WhatsApp', 'success');
  }).catch(() => {
    prompt('Copia este mensaje:', msg);
  });
}

function registrarEnvioDirecto(id, metodo) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.metodoEnvio = metodo;
  p.estado      = 'enviado-final';
  guardar();
  render();
  toast(`#${id} enviado — ${metodo}`, 'success');
}

/* ════════════════════════════════════════════════════════════════
   WETRANSFER
════════════════════════════════════════════════════════════════ */
let wtRegistros = []; // cargados del servidor
let _wtTipo = 'enviado'; // tipo activo en formulario

async function cargarWT() {
  try {
    const r = await fetch('/api/wetransfer');
    const d = await r.json();
    wtRegistros = d.registros || [];
  } catch { wtRegistros = []; }
  renderWT();
}

function registrarWT(tipo) {
  _wtTipo = tipo || 'enviado';
  document.getElementById('wt-archivo').value = '';
  document.getElementById('wt-equipo').value = '';
  document.getElementById('wt-form-title').textContent =
    tipo === 'descargado' ? '✅ Registrar descarga WeTransfer' : '📤 Registrar envío WeTransfer';
  document.getElementById('wt-form-sub').textContent =
    tipo === 'descargado' ? 'Mauricio confirmó que descargó el archivo' : 'Se envió el diseño por WeTransfer a calandra';
  document.getElementById('wt-btn-guardar').textContent = tipo === 'descargado' ? 'Guardar descarga' : 'Guardar envío';
  document.getElementById('form-wt').style.display = 'block';
  document.getElementById('wt-archivo').focus();
}

async function guardarWT() {
  const archivo = document.getElementById('wt-archivo').value.trim();
  const equipo  = document.getElementById('wt-equipo').value.trim();
  if (!archivo) { toast('Ingresa el nombre del archivo', 'error'); return; }

  try {
    const r = await fetch('/api/wetransfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: _wtTipo, archivo, equipo }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    document.getElementById('form-wt').style.display = 'none';
    toast(_wtTipo === 'descargado' ? `Descarga registrada: ${archivo}` : `Envío registrado: ${archivo}`, 'success');
    await cargarWT();
  } catch (e) {
    toast('Error al guardar: ' + e.message, 'error');
  }
}

function renderWT() {
  const cont = document.getElementById('lista-wt');
  const resumen = document.getElementById('wt-resumen-hoy');
  if (!cont) return;

  const hoy = new Date().toLocaleDateString('es-CO');
  const hoy_list = wtRegistros.filter(e => e.fecha === hoy);

  // Contar enviados y descargados hoy
  const envHoy  = hoy_list.filter(e => e.tipo === 'enviado').length;
  const descHoy = hoy_list.filter(e => e.tipo === 'descargado').length;

  const badgeWt = document.getElementById('badge-wt');
  if (badgeWt) badgeWt.textContent = hoy_list.length;

  if (resumen) {
    resumen.innerHTML = `
      <div style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);border-radius:10px;padding:10px 18px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:1.1rem;">📤</span>
        <div>
          <div style="font-size:1.3rem;font-weight:800;color:#67e8f9;line-height:1;">${envHoy}</div>
          <div style="font-size:0.68rem;color:var(--text-muted);">Enviados hoy</div>
        </div>
      </div>
      <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);border-radius:10px;padding:10px 18px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:1.1rem;">✅</span>
        <div>
          <div style="font-size:1.3rem;font-weight:800;color:#4ade80;line-height:1;">${descHoy}</div>
          <div style="font-size:0.68rem;color:var(--text-muted);">Descargados hoy</div>
        </div>
      </div>
    `;
  }

  // Agrupar: unir enviado + descargado del mismo archivo
  function renderFila(e, dim) {
    const esBadge = e.tipo === 'descargado'
      ? `<span style="font-size:0.65rem;background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.35);border-radius:10px;padding:2px 8px;white-space:nowrap;">✅ Descargado</span>`
      : `<span style="font-size:0.65rem;background:rgba(6,182,212,0.15);color:#67e8f9;border:1px solid rgba(6,182,212,0.3);border-radius:10px;padding:2px 8px;white-space:nowrap;">📤 Enviado</span>`;
    const autoTag = e.auto ? `<span style="font-size:0.62rem;background:rgba(167,139,250,0.12);color:#a78bfa;border:1px solid rgba(167,139,250,0.25);border-radius:10px;padding:1px 6px;">auto</span>` : '';
    return `
      <div style="background:var(--card-bg);border:1px solid ${e.tipo==='descargado'?'rgba(34,197,94,0.2)':'rgba(6,182,212,0.15)'};border-radius:var(--radius);padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px;${dim?'opacity:0.6;':''}">
        <span style="font-size:1.1rem;">${e.tipo==='descargado'?'✅':'📤'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(e.archivo)}</div>
          ${e.equipo ? `<div style="font-size:0.72rem;color:var(--text-muted);">Equipo: ${esc(e.equipo)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          ${esBadge}${autoTag}
          <span style="font-size:0.68rem;color:var(--text-muted);">${dim ? e.fecha+' ' : ''}${e.hora}</span>
        </div>
      </div>`;
  }

  // Separar por tipo y deduplicar por archivo (quedarse con el más reciente)
  function dedup(arr) {
    const mapa = {};
    arr.forEach(e => {
      const key = (e.archivo || '').toLowerCase().trim();
      if (!mapa[key] || (e.id||0) > (mapa[key].id||0)) mapa[key] = e;
    });
    return Object.values(mapa).sort((a,b) => (b.id||0)-(a.id||0));
  }
  const enviados    = dedup(wtRegistros.filter(e => e.tipo === 'enviado'));
  const descargados = dedup(wtRegistros.filter(e => e.tipo === 'descargado'));

  function renderLista(items, emptyMsg) {
    if (!items.length) return `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.8rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);">${emptyMsg}</div>`;
    return items.slice(0, 40).map(e => {
      const dim = e.fecha !== new Date().toLocaleDateString('es-CO');
      return renderFila(e, dim);
    }).join('');
  }

  cont.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div>
        <div style="font-size:0.78rem;font-weight:700;color:#67e8f9;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
          📤 Enviados <span style="font-size:0.7rem;font-weight:400;color:var(--text-muted);">(${enviados.length})</span>
        </div>
        ${renderLista(enviados, 'Sin envíos registrados')}
      </div>
      <div>
        <div style="font-size:0.78rem;font-weight:700;color:#4ade80;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
          ✅ Descargados <span style="font-size:0.7rem;font-weight:400;color:var(--text-muted);">(${descargados.length})</span>
        </div>
        ${renderLista(descargados, 'Sin descargas registradas')}
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   ARREGLOS MANUALES
════════════════════════════════════════════════════════════════ */
let arreglosManuales = JSON.parse(localStorage.getItem('ws_arreglos_manuales') || '[]');

function guardarArreglos_store() {
  localStorage.setItem('ws_arreglos_manuales', JSON.stringify(arreglosManuales));
  fetch('/api/arreglos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arreglos: arreglosManuales })
  }).catch(() => {});
}

async function sincronizarArreglosServidor() {
  try {
    const r = await fetch('/api/arreglos');
    if (!r.ok) return;
    const data = await r.json();
    const serv = Array.isArray(data.arreglos) ? data.arreglos : [];
    const todos = [...arreglosManuales, ...serv];
    const vistos = new Set();
    arreglosManuales = todos.filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; });
    arreglosManuales.sort((a, b) => b.id - a.id);
    localStorage.setItem('ws_arreglos_manuales', JSON.stringify(arreglosManuales));
    // Subir merge al servidor
    fetch('/api/arreglos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arreglos: arreglosManuales })
    }).catch(() => {});
    renderArreglos();
  } catch {}
}

function registrarArregloManual() {
  document.getElementById('ar-equipo').value = '';
  document.getElementById('ar-faltante').value = '';
  document.getElementById('ar-disenador').value = '';
  document.getElementById('form-arreglo').style.display = 'block';
  document.getElementById('ar-equipo').focus();
}

function guardarArregloManual() {
  const equipo    = document.getElementById('ar-equipo').value.trim();
  const faltante  = document.getElementById('ar-faltante').value.trim();
  const disenador = document.getElementById('ar-disenador').value;
  if (!equipo) { toast('Ingresa el nombre del equipo', 'error'); return; }
  if (!faltante) { toast('Ingresa qué falta', 'error'); return; }
  if (!disenador) { toast('Selecciona un diseñador', 'error'); return; }
  arreglosManuales.unshift({
    id: Date.now(), equipo, faltante, disenador,
    enviado: false, resuelto: false,
    fecha: new Date().toLocaleDateString('es-CO')
  });
  guardarArreglos_store();
  document.getElementById('form-arreglo').style.display = 'none';
  renderArreglos();
  toast(`Arreglo registrado: ${equipo} → ${disenador}`, 'info');
}

function enviarArregloManual(id) {
  const a = arreglosManuales.find(x => x.id === id);
  if (!a) return;
  a.enviado = true;
  guardarArreglos_store();
  renderArreglos();
  toast(`Arreglo de ${a.equipo} — enviado por ${a.disenador}`, 'info');
}

function llegoArregloManual(id) {
  const a = arreglosManuales.find(x => x.id === id);
  if (!a) return;
  a.resuelto = true;
  guardarArreglos_store();
  renderArreglos();
  toast(`Arreglo de ${a.equipo} — llegó, resuelto ✓`, 'success');
}

function resolverArregloManual(id) {
  const a = arreglosManuales.find(x => x.id === id);
  if (!a) return;
  a.resuelto = true;
  guardarArreglos_store();
  renderArreglos();
  toast('Arreglo resuelto', 'success');
}

function renderArreglos() {
  const container = document.getElementById('lista-arreglos-unificada');
  if (!container) return;

  const badgeArr = document.getElementById('badge-arreglos');
  
  // Arreglos de pedidos activos
  const conArreglo = pedidos.filter(p => p.arreglo && p.arreglo !== 'pendiente' && p.estado !== 'enviado-final');
  
  const pendientes = arreglosManuales.filter(a => !a.resuelto);
  const resueltos  = arreglosManuales.filter(a =>  a.resuelto);

  if (badgeArr) badgeArr.textContent = conArreglo.length + pendientes.length;

  let htmlElements = [];

  // 1. Pedidos activos con arreglo
  conArreglo.forEach(p => {
    htmlElements.push(`
      <div style="background:linear-gradient(135deg, rgba(239,68,68,0.1), rgba(153,27,27,0.3)); border:1px solid rgba(239,68,68,0.5); border-radius:var(--radius); padding:16px; position:relative; overflow:hidden;">
        <div style="position:absolute; top:0; left:0; width:4px; height:100%; background:#ef4444;"></div>
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
          <div>
            <div style="font-size:0.65rem; color:#fca5a5; font-weight:700; letter-spacing:1px; text-transform:uppercase;">Pedido de Producción #${p.id}</div>
            <div style="font-weight:800; font-size:1.1rem; color:#fff; margin-top:2px;">${esc(p.equipo || p.telefono)}</div>
          </div>
          <span style="font-size:0.7rem; background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid rgba(239,68,68,0.4); border-radius:4px; padding:2px 8px;">En Calidad</span>
        </div>
        <div style="font-size:0.85rem; color:#fecaca; white-space:pre-line; margin-bottom:14px; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px; border-left:2px solid #ef4444;">
          ⚠️ ${esc(p.arreglo)}
        </div>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-danger btn-sm" style="flex:1;" onclick="avanzar(${p.id}); setTimeout(render,100)">✅ Marcar como Resuelto</button>
          <button class="btn btn-glass btn-sm" onclick="irAlPedido(${p.id})">Ver Pedido</button>
        </div>
      </div>
    `);
  });

  // 2. Arreglos Manuales
  [...pendientes, ...resueltos].forEach(a => {
    const dis = a.disenador ? `<span style="font-size:0.75rem; color:#c4b5fd; font-weight:700; background:rgba(124,58,237,0.2); padding:2px 8px; border-radius:4px;">🎨 ${esc(a.disenador)}</span>` : '';
    
    let estadoBadge = '';
    let accionHtml = '';
    let cardStyle = '';
    let accentColor = '';

    if (a.resuelto) {
      estadoBadge = `<span style="font-size:0.7rem; background:rgba(16,185,129,0.15); color:#6ee7b7; border:1px solid rgba(16,185,129,0.3); border-radius:4px; padding:2px 8px;">✅ Listo</span>`;
      accionHtml = `<div style="font-size:0.8rem; color:#6ee7b7; text-align:center; padding:6px; background:rgba(16,185,129,0.1); border-radius:4px;">El arreglo ya fue resuelto</div>`;
      cardStyle = 'opacity:0.6; filter:grayscale(0.5);';
      accentColor = '#10b981';
    } else if (a.enviado) {
      estadoBadge = `<span style="font-size:0.7rem; background:rgba(6,182,212,0.15); color:#67e8f9; border:1px solid rgba(6,182,212,0.3); border-radius:4px; padding:2px 8px;">📤 Enviado al Taller</span>`;
      accionHtml = `<button class="btn btn-success btn-sm" style="width:100%;" onclick="llegoArregloManual(${a.id})">✅ Recibir y Marcar Resuelto</button>`;
      accentColor = '#06b6d4';
    } else {
      estadoBadge = `<span style="font-size:0.7rem; background:rgba(251,146,60,0.15); color:#fb923c; border:1px solid rgba(251,146,60,0.3); border-radius:4px; padding:2px 8px;">⏳ Esperando Diseño</span>`;
      accionHtml = `<button class="btn btn-primary btn-sm" style="width:100%;" onclick="enviarArregloManual(${a.id})">📤 Diseñador Ya Envió Archivo</button>`;
      accentColor = '#fb923c';
    }

    htmlElements.push(`
      <div style="background:var(--card-bg); border:1px solid rgba(255,255,255,0.08); border-radius:var(--radius); padding:16px; position:relative; overflow:hidden; ${cardStyle}">
        <div style="position:absolute; top:0; left:0; width:4px; height:100%; background:${accentColor};"></div>
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
          <div>
            <div style="font-size:0.65rem; color:var(--text-muted); font-weight:700; letter-spacing:1px; text-transform:uppercase;">Registro Manual - ${a.fecha}</div>
            <div style="font-weight:800; font-size:1.1rem; color:#fff; margin-top:2px;">${esc(a.equipo)}</div>
          </div>
          ${estadoBadge}
        </div>
        <div style="font-size:0.85rem; color:var(--text); white-space:pre-line; margin-bottom:14px; background:rgba(255,255,255,0.03); padding:10px; border-radius:6px;">
          🔧 ${esc(a.faltante)}
        </div>
        <div style="margin-bottom:14px;">${dis}</div>
        ${accionHtml}
      </div>
    `);
  });

  if (htmlElements.length === 0) {
    container.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; padding:40px; color:var(--text-muted); font-size:0.9rem; background:var(--card-bg); border:1px dashed rgba(255,255,255,0.1); border-radius:var(--radius);">🎉 ¡No hay arreglos pendientes! Todo está marchando perfecto.</div>`;
  } else {
    container.innerHTML = htmlElements.join('');
  }
}

/* ════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════ */
limpiarEnviadosDelMesPasado();
// Migración: limpiar valores rotos de p.arreglo (false, "", 0) y normalizar tipoBandeja
pedidos.forEach(p => {
  if (p.arreglo !== null && p.arreglo !== undefined && !p.arreglo) {
    p.arreglo = null;
  }
  if (p.tipoBandeja) {
    p.tipoBandeja = p.tipoBandeja.toLowerCase();
  }
});
// Solo subir al servidor al inicio si hay pedidos en localStorage (evita borrar datos del servidor)
if (pedidos.length > 0) guardar();
updateDate();
render();

// Sincronizar desde servidor — el servidor es fuente de verdad
function syncConServidor(silencioso = false) {
  fetch('/api/pedidos')
    .then(r => r.json())
    .then(data => {
      const serverPedidos = Array.isArray(data) ? data : (data.pedidos || []);
      const serverNextId  = data.nextId || null;

      if (!serverPedidos.length && !pedidos.length) return;

      if (!serverPedidos.length) {
        if (pedidos.length > 0) guardar();
        return;
      }

      // HARD OVERRIDE: si local tiene 0 o muchos menos que el server, reemplazar entero.
      // Evita quedar trancado con cache vieja que no sincroniza.
      if (pedidos.length === 0 || pedidos.length < serverPedidos.length / 2) {
        pedidos = serverPedidos.map(p => ({ ...p }));
        nextId = Math.max(nextId, serverNextId || 1, ...pedidos.map(p => p.id + 1));
        localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
        localStorage.setItem('ws_nextId3', String(nextId));
        try { actualizarBadgesSidebar(); } catch (e) {}
        render();
        try { if (document.getElementById('mi-dia') && document.getElementById('mi-dia').classList.contains('active')) renderMiDia(); } catch (e) {}
        if (!silencioso) toast('🔄 ' + pedidos.length + ' pedidos cargados del servidor', 'success');
        return;
      }

      const mapaServer = new Map(serverPedidos.map(p => [p.id, p]));
      const mapaLocal  = new Map(pedidos.map(p => [p.id, p]));
      const merged = [];

      const todosIds = new Set([...mapaServer.keys(), ...mapaLocal.keys()]);
      todosIds.forEach(id => {
        // Si fue eliminado recientemente en este dispositivo, ignorar lo que diga el server
        if (eliminadosLocales.has(id)) return;
        const s = mapaServer.get(id);
        const l = mapaLocal.get(id);
        if (s && l) {
          const tS = s.ultimoMovimiento ? new Date(s.ultimoMovimiento).getTime() : 0;
          const tL = l.ultimoMovimiento ? new Date(l.ultimoMovimiento).getTime() : 0;

          if (tS > tL) {
            merged.push({ ...s });
          } else {
            merged.push({ ...l,
              notaWebhook: s.notaWebhook || l.notaWebhook,
              ultimaActWebhook: s.ultimaActWebhook || l.ultimaActWebhook
            });
          }
        } else if (s && !l) {
          merged.push(s);
        } else if (l) {
          merged.push(l);
        }
      });

      merged.sort((a, b) => a.id - b.id);

      const maxId = merged.reduce((m, p) => Math.max(m, p.id), 0);
      const nuevoNextId = Math.max(nextId, serverNextId || 1, maxId + 1);

      const cambios = JSON.stringify(merged) !== JSON.stringify(pedidos) || nuevoNextId !== nextId;
      if (cambios) {
        pedidos = merged;
        nextId  = nuevoNextId;
        localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
        localStorage.setItem('ws_nextId3', String(nextId));
        guardar();
        render();
        try { if (document.getElementById('mi-dia') && document.getElementById('mi-dia').classList.contains('active')) renderMiDia(); } catch (e) {}
        if (!silencioso) toast('🔄 Pedidos sincronizados', 'info');
      }
    })
    .catch(() => {});
}

// SERVER-DRIVEN SYNC: el servidor es la única fuente de verdad.
// Reemplazamos pedidos locales con los del server SIEMPRE, respetando solo los
// eliminadosLocales recientes (TTL 7d) para que un dispositivo offline no
// reviva pedidos que otro borró.
function hardSyncFromServer(silencioso = false) {
  return fetch('/api/pedidos')
    .then(r => r.json())
    .then(data => {
      const srv = Array.isArray(data) ? data : (data.pedidos || []);
      const archivados = new Set(data.archivados || []);
      // Si el server devuelve un pedido creado por sistema (origenBot, origenFacturaHuerfana,
      // origenHuerfano, origenComprobante), siempre lo aceptamos — y limpiamos la marca de
      // "eliminado local" si la había, porque el server lo recreó intencionalmente.
      const esProtegido = p => p.origenBot || p.origenFacturaHuerfana || p.origenHuerfano || p.origenComprobante;
      let limpiados = 0;
      const filtrados = srv
        .filter(p => {
          if (archivados.has(p.id)) return false;
          if (esProtegido(p)) {
            if (eliminadosLocales.has(p.id)) {
              eliminadosLocales.delete(p.id);
              limpiados++;
            }
            return true;
          }
          return !eliminadosLocales.has(p.id);
        });
      if (limpiados > 0) console.log(`[sync] limpiados ${limpiados} pedido(s) de eliminadosLocales (recreados por server)`);
      const map = new Map();
      filtrados.forEach(p => map.set(p.id, { ...p }));
      const nuevos = Array.from(map.values());
      const cambios = JSON.stringify(nuevos) !== JSON.stringify(pedidos);
      pedidos = nuevos;
      nextId = Math.max(nextId || 1, data.nextId || 1, ...pedidos.map(p => (p.id || 0) + 1));
      localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
      localStorage.setItem('ws_nextId3', String(nextId));
      if (cambios) { try { render(); } catch (e) { console.error('[sync] render error', e); } }
      if (!silencioso) console.log('[sync] ' + pedidos.length + ' pedidos del servidor');
    })
    .catch(e => console.error('[sync] fetch error', e));
}
// Mantenemos syncConServidor como alias para no romper llamadas existentes
const _syncOld = syncConServidor;
syncConServidor = hardSyncFromServer;
// Sync inicial
hardSyncFromServer(false);

// Polling automático cada 7 segundos (era 15)
setInterval(() => syncConServidor(true), 7000);

// Sync calandra Drive al cargar y cada 2 minutos
setTimeout(sincronizarCalandraServidor, 500);
setInterval(sincronizarCalandraServidor, 120000);

/* ════════════════════════════════════════════════════════════════
   SYNC UNIFICADO — todos los datos del servidor cada 7 seg
   El servidor es fuente única de verdad. Todos los dispositivos
   ven la misma información.
════════════════════════════════════════════════════════════════ */
let _ultimoSyncTs = 0;
async function syncTodoConServidor(silencioso = true) {
  try {
    _syncEstado = 'cargando';
    actualizarIndicadorSync();
    const r = await fetch('/api/sync-todo');
    if (!r.ok) throw new Error('servidor');
    const data = await r.json();

    // Notificaciones compartidas — reemplazar siempre con las del servidor
    if (Array.isArray(data.notificaciones)) {
      const nuevoArr = data.notificaciones;
      const cambioNotifs = JSON.stringify(nuevoArr) !== JSON.stringify(notificaciones || []);
      if (cambioNotifs) {
        notificaciones = nuevoArr;
        localStorage.setItem('ws_notifs', JSON.stringify(notificaciones));
        if (typeof renderNotifs === 'function') renderNotifs();
      }
    }

    // Arreglos manuales — reemplazar con los del servidor si cambió
    if (Array.isArray(data.arreglos)) {
      const nuevo = JSON.stringify(data.arreglos);
      const actual = JSON.stringify(arreglosManuales || []);
      if (nuevo !== actual) {
        arreglosManuales = data.arreglos;
        localStorage.setItem('ws_arreglos_manuales', JSON.stringify(arreglosManuales));
        if (typeof renderArreglos === 'function') renderArreglos();
      }
    }

    // Satélites
    if (Array.isArray(data.satelites)) {
      const nuevo = JSON.stringify(data.satelites);
      const actual = JSON.stringify(satMovimientos || []);
      if (nuevo !== actual) {
        satMovimientos = data.satelites;
        localStorage.setItem('ws_satelites', JSON.stringify(satMovimientos));
        if (typeof renderSat === 'function') renderSat();
      }
    }

    // Documentos (cotizaciones/facturas consecutivos)
    if (data.docs) {
      if (typeof data.docs.nextCot === 'number' && data.docs.nextCot > nextCot) {
        nextCot = data.docs.nextCot;
        localStorage.setItem('ws_nextCot', String(nextCot));
      }
      if (typeof data.docs.nextFac === 'number' && data.docs.nextFac > nextFac) {
        nextFac = data.docs.nextFac;
        localStorage.setItem('ws_nextFac', String(nextFac));
      }
      if (Array.isArray(data.docs.historial)) {
        const nuevo = JSON.stringify(data.docs.historial);
        const actual = JSON.stringify(docHistorial || []);
        if (nuevo !== actual) {
          docHistorial = data.docs.historial;
          localStorage.setItem('ws_docs', JSON.stringify(docHistorial));
        }
      }
    }

    _syncEstado = 'ok';
    _syncUltimoTs = Date.now();
    actualizarIndicadorSync();
  } catch (e) {
    _syncEstado = 'error';
    actualizarIndicadorSync();
    if (!silencioso) console.error('[sync-todo]', e.message);
  }
}

// Indicador visual del estado de sync (puntito en esquina)
function actualizarIndicadorSync() {
  let chip = document.getElementById('sync-indicator');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'sync-indicator';
    chip.style.cssText = 'position:fixed;bottom:14px;right:14px;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(15,23,42,0.92);border:1px solid rgba(255,255,255,0.15);color:#fff;font-size:0.78rem;font-weight:600;z-index:9999;cursor:pointer;backdrop-filter:blur(8px);box-shadow:0 4px 16px rgba(0,0,0,0.3);user-select:none;transition:all 0.2s;';
    const dot = document.createElement('span');
    dot.id = 'sync-indicator-dot';
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;box-shadow:0 0 8px currentColor;';
    const txt = document.createElement('span');
    txt.id = 'sync-indicator-text';
    chip.appendChild(dot);
    chip.appendChild(txt);
    chip.onclick = () => { syncConServidor(false); syncTodoConServidor(false); };
    chip.onmouseenter = () => chip.style.background = 'rgba(30,41,59,0.95)';
    chip.onmouseleave = () => chip.style.background = 'rgba(15,23,42,0.92)';
    document.body.appendChild(chip);
  }
  const dot = document.getElementById('sync-indicator-dot');
  const txt = document.getElementById('sync-indicator-text');
  if (_syncEstado === 'ok') {
    dot.style.background = '#22c55e';
    dot.style.color = '#22c55e';
    const seg = Math.floor((Date.now() - _syncUltimoTs) / 1000);
    txt.textContent = seg < 10 ? 'Sincronizado' : `hace ${seg}s`;
    chip.title = 'Conectado al servidor — clic para forzar sync';
  } else if (_syncEstado === 'cargando') {
    dot.style.background = '#facc15';
    dot.style.color = '#facc15';
    txt.textContent = 'Sincronizando…';
    chip.title = 'Pidiendo cambios al servidor';
  } else {
    dot.style.background = '#ef4444';
    dot.style.color = '#ef4444';
    txt.textContent = 'Sin conexión';
    chip.title = 'No se pudo conectar — clic para reintentar';
  }
}

// Arrancar sync unificado
setTimeout(() => syncTodoConServidor(true), 1500);
setInterval(() => syncTodoConServidor(true), 7000);
// Refrescar texto del tooltip cada segundo (para que diga "hace Xs")
setInterval(actualizarIndicadorSync, 1000);

/* ════════════════════════════════════════════════════════════════
   CALANDRA — CONTROL DE METRAJE
════════════════════════════════════════════════════════════════ */
function guardarCalandra_store() {
  localStorage.setItem('ws_calandra', JSON.stringify(calandraRegistros));
}

// Sincroniza registros de Drive (vienen del servidor vía n8n) con los locales
async function sincronizarCalandraServidor() {
  try {
    const r = await fetch('/api/drive-pdfs');
    if (!r.ok) return;
    const { pdfs } = await r.json();
    if (!pdfs || !pdfs.length) return;

    // Deduplicar por archivo (nombre único) — el servidor es fuente de verdad
    const vistos = new Set();
    const normalizados = pdfs
      .filter(r => {
        const key = (r.archivo || r.equipo || '').toLowerCase();
        if (vistos.has(key)) return false;
        vistos.add(key);
        return true;
      })
      .map(r => ({
        id:          r.id,
        equipo:      r.equipo,
        altoCm:      r.alto,
        metros:      r.metros,
        fecha:       r.fecha,
        hora:        '',
        semana:      getSemanaKey((() => { try { const [d,m,y] = r.fecha.split('/'); return new Date(+y, +m-1, +d); } catch { return new Date(); } })()),
        archivo:     r.archivo || '',
        disenador:   r.disenador || '',
        origen:      'drive',
        enviado:     r.enviado || false,
        createdTime: r.createdTime || null,
        modifiedTime: r.modifiedTime || null,
        driveIndex:  r.driveIndex !== undefined ? r.driveIndex : null,
      }));

    // Solo conservar locales manuales (no drive) — los de Drive vienen del servidor
    const soloLocales = calandraRegistros.filter(r => r.origen !== 'drive');
    // Ordenar por createdTime (fecha real Drive) del más nuevo al más viejo
    const archivosServidor = new Set(normalizados.map(r => (r.archivo || '').toLowerCase()));
    calandraRegistros = [
      ...normalizados,
      ...soloLocales.filter(r => !archivosServidor.has((r.archivo || '').toLowerCase()))
    ].sort((a, b) => {
      const ta = a.createdTime ? new Date(a.createdTime).getTime() : a.id;
      const tb = b.createdTime ? new Date(b.createdTime).getTime() : b.id;
      return tb - ta;
    });
    guardarCalandra_store();
    renderCalandra();
    renderDashboard();
  } catch {}
}

function cambiarAnchoTela(val) {
  calandraAncho = parseFloat(val);
  localStorage.setItem('ws_calandra_ancho', String(calandraAncho));
  document.getElementById('cal-ancho-label').textContent = calandraAncho.toFixed(2) + ' m';
  renderCalandra();
}

function abrirFormCalandra() {
  document.getElementById('cal-equipo').value = '';
  document.getElementById('cal-alto').value   = '';
  document.getElementById('form-calandra').style.display = 'block';
  document.getElementById('cal-equipo').focus();
}

function guardarCalandra() {
  const equipo = document.getElementById('cal-equipo').value.trim();
  const alto   = parseFloat(document.getElementById('cal-alto').value);
  if (!equipo) { toast('Ingresa el nombre del equipo', 'error'); return; }
  if (!alto || alto <= 0) { toast('Ingresa el alto del PDF en cm', 'error'); return; }

  // alto en cm × ancho en m → metros lineales
  // (alto / 100) = alto en metros; metros lineales = alto_m (el ancho ya está fijo por la tela)
  const altoCm   = alto;
  const metros   = parseFloat(((altoCm / 100)).toFixed(3)); // metros lineales del rollo
  const metros2  = parseFloat(((altoCm / 100) * calandraAncho).toFixed(3)); // m²

  const hoy = new Date().toLocaleDateString('es-CO');
  const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  calandraRegistros.unshift({
    id:       Date.now(),
    equipo,
    altoCm,
    metros,
    metros2,
    ancho:    calandraAncho,
    fecha:    hoy,
    hora,
    semana:   getSemanaKey(new Date()),
  });

  guardarCalandra_store();
  document.getElementById('form-calandra').style.display = 'none';
  renderCalandra();
  toast(`Registrado: ${equipo} — ${metros} m lineales`, 'success');
}

function getSemanaKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + 1); // lunes
  return d.toLocaleDateString('es-CO');
}

function renderCalandra() {
  const cont = document.getElementById('lista-calandra');
  if (!cont) return;

  const hoy       = new Date().toLocaleDateString('es-CO');
  const semanaKey = getSemanaKey(new Date());

  const sortByDate = (a, b) => {
    if (a.driveIndex !== null && a.driveIndex !== undefined && b.driveIndex !== null && b.driveIndex !== undefined) {
      return a.driveIndex - b.driveIndex;
    }
    const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : (a.createdTime ? new Date(a.createdTime).getTime() : 0);
    const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : (b.createdTime ? new Date(b.createdTime).getTime() : 0);
    if (ta !== tb) return tb - ta;
    return b.id - a.id;
  };
  const hoyList   = calandraRegistros.filter(r => r.fecha === hoy).sort(sortByDate);
  const semanaList = calandraRegistros.filter(r => r.semana === semanaKey).sort(sortByDate);
  const historico  = calandraRegistros.filter(r => r.fecha !== hoy).sort(sortByDate);

  const metrosHoy    = hoyList.reduce((s, r) => s + r.metros, 0);
  const metrosSemana = semanaList.reduce((s, r) => s + r.metros, 0);

  // Actualizar ancho selector
  const sel = document.getElementById('cal-ancho-sel');
  if (sel) sel.value = String(calandraAncho);
  const lbl = document.getElementById('cal-ancho-label');
  if (lbl) lbl.textContent = calandraAncho.toFixed(2) + ' m';

  // Métricas
  const elSemana = document.getElementById('cal-metros-semana');
  const elHoy    = document.getElementById('cal-metros-hoy');
  const elArch   = document.getElementById('cal-archivos-hoy');
  if (elSemana) elSemana.textContent = metrosSemana.toFixed(2);
  if (elHoy)    elHoy.textContent    = metrosHoy.toFixed(2);
  if (elArch)   elArch.textContent   = hoyList.length;

  // Badge sidebar
  const badgeCal = document.getElementById('badge-calandra');
  if (badgeCal) badgeCal.textContent = hoyList.length;

  let html = '';

  if (!hoyList.length) {
    html += `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:0.8rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);">Sin envíos registrados hoy</div>`;
  } else {
    html += `<div class="cal-semana-header">Hoy — ${hoyList.length} archivos · ${metrosHoy.toFixed(2)} m lineales</div>`;
    html += hoyList.map(r => renderCalItem(r)).join('');
  }

  // Agrupar histórico por semana (solo mostramos la semana actual para no saturar)
  const historicoSemana = historico.filter(r => r.semana === semanaKey);
  if (historicoSemana.length) {
    const porSemana = {};
    historicoSemana.forEach(r => {
      if (!porSemana[r.semana]) porSemana[r.semana] = [];
      porSemana[r.semana].push(r);
    });
    Object.entries(porSemana).forEach(([sem, items]) => {
      const total = items.reduce((s, r) => s + r.metros, 0);
      html += `<div class="cal-semana-header">Semana del ${sem} — ${items.length} archivos · ${total.toFixed(2)} m lineales</div>`;
      html += items.map(r => renderCalItem(r, true)).join('');
    });
  }

  cont.innerHTML = html;
}

function renderCalItem(r, opaco = false) {
  const esDrive = r.origen === 'drive';
  const icono   = esDrive ? '🌐' : '📄';
  const extra   = esDrive && r.archivo
    ? `<span style="font-size:0.7rem;color:#a78bfa;margin-left:6px;" title="${esc(r.archivo)}">Drive · ${esc(r.disenador || '')}</span>`
    : '';
  const wtBadge = esDrive
    ? (r.enviado
        ? `<span style="font-size:0.7rem;background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);border-radius:4px;padding:1px 6px;">✅ WeTransfer</span>`
        : `<span style="font-size:0.7rem;background:rgba(239,68,68,0.12);color:#fca5a5;border:1px solid rgba(239,68,68,0.3);border-radius:4px;padding:1px 6px;">⚠️ Sin enviar</span>`)
    : '';
  return `
    <div class="cal-item" style="${opaco ? 'opacity:0.65;' : ''}">
      <span style="font-size:1.3rem;">${icono}</span>
      <div class="cal-item-info" style="flex:1;">
        <div class="cal-item-equipo">${esc(r.equipo)}${extra}</div>
        <div class="cal-item-meta" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${r.alto || r.altoCm || 0} cm · ${r.fecha} ${r.hora || ''} ${wtBadge}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="cal-item-metros">${r.metros <= 0.01 ? '<span style="color:var(--orange);font-size:0.75em;font-weight:700;">⚠️ Sin métrica</span>' : r.metros.toFixed(2) + ' m'}</div>
        <button onclick="borrarCalItem('${r.id}')" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:4px;padding:1px 7px;font-size:0.8rem;cursor:pointer;line-height:1.4;" title="Borrar">✕</button>
      </div>
    </div>
  `;
}

async function borrarCalItem(id) {
  if (!confirm('¿Borrar este registro?')) return;
  calandraRegistros = calandraRegistros.filter(r => String(r.id) !== String(id));
  guardarCalandra_store();
  renderCalandra();
  renderDashboard();
  // También borra del servidor para que no vuelva a aparecer
  try { await fetch('/api/calandra/' + id, { method: 'DELETE' }); } catch {}
}

/* ════════════════════════════════════════════════════════════════
   SATÉLITES — CONTROL COSTURA
════════════════════════════════════════════════════════════════ */
function guardarSat_store() {
  localStorage.setItem('ws_satelites', JSON.stringify(satMovimientos));
  fetch('/api/satelites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ movimientos: satMovimientos })
  }).catch(() => {});
}

async function sincronizarSatelitesServidor() {
  try {
    const r = await fetch('/api/satelites');
    if (!r.ok) return;
    const data = await r.json();
    const serv = Array.isArray(data.movimientos) ? data.movimientos : [];
    const todos = [...satMovimientos, ...serv];
    const vistos = new Set();
    satMovimientos = todos.filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; });
    satMovimientos.sort((a, b) => b.id - a.id);
    localStorage.setItem('ws_satelites', JSON.stringify(satMovimientos));
    // Subir merge al servidor
    fetch('/api/satelites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: satMovimientos })
    }).catch(() => {});
    renderSatelites();
  } catch {}
}

function abrirFormSat(tipo) {
  satTipoActual = tipo;
  document.getElementById('sat-nombre').value   = '';
  document.getElementById('sat-equipo').value   = '';
  document.getElementById('sat-cantidad').value = '';
  const titulo = document.getElementById('form-sat-titulo');
  if (titulo) titulo.textContent = tipo === 'entrega' ? '📦 Registrar entrega a satélite' : '✅ Registrar recepción de satélite';
  document.getElementById('form-sat').style.display = 'block';
  document.getElementById('sat-nombre').focus();
}

function guardarSat() {
  const nombre   = document.getElementById('sat-nombre').value;
  const equipo   = document.getElementById('sat-equipo').value.trim();
  const prenda   = document.getElementById('sat-prenda').value;
  const cantidad = parseInt(document.getElementById('sat-cantidad').value);

  if (!nombre)           { toast('Selecciona el satélite', 'error'); return; }
  if (!equipo)           { toast('Ingresa el equipo o pedido', 'error'); return; }
  if (!cantidad || cantidad <= 0) { toast('Ingresa la cantidad', 'error'); return; }

  const hoy = new Date().toLocaleDateString('es-CO');
  const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  satMovimientos.unshift({
    id:       Date.now(),
    tipo:     satTipoActual,
    satelite: nombre,
    equipo,
    prenda,
    cantidad,
    fecha:    hoy,
    hora,
  });

  guardarSat_store();
  document.getElementById('form-sat').style.display = 'none';
  renderSatelites();
  toast(`${satTipoActual === 'entrega' ? 'Entregado' : 'Recibido'}: ${cantidad} ${prenda} a ${nombre}`, 'success');
}

// Funciones integradas (Pedido <-> Satélite)
function asignarSatelitePedido(id, satelite) {
  const p = pedidos.find(x => x.id === id);
  if(!p) return;
  p.satelite = satelite;
  p.estado = 'en-satelite'; // Nuevo sub-estado o simplemente mantener costura pero con satelite asignado
  
  // Opcional: auto-registrar movimiento
  const cant = p.cantidades ? p.cantidades.reduce((a,b)=>a+b.c,0) : 1;
  const hoy = new Date().toLocaleDateString('es-CO');
  const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  satMovimientos.unshift({
    id: Date.now(), tipo: 'entrega', satelite,
    equipo: p.equipo || p.telefono, prenda: 'Uniforme completo', cantidad: cant,
    fecha: hoy, hora
  });
  guardarSat_store();
  guardar();
  render();
  toast(`Pedido #${id} enviado a ${satelite}`, 'success');
}

// Flujo costurera personal: foto obligatoria al terminar.
// Abre la cámara del celular (capture="environment"), comprime la foto y
// la sube a /api/pedidos/:id/foto-costura. El backend avanza a 'calidad'
// y registra en historial quién terminó (vía X-Ws-Persona).
function terminarPedidoCosturaConFoto(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  let input = document.getElementById('input-foto-costura');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.id = 'input-foto-costura';
    input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.dataset.pedidoId = String(id);
  input.value = '';
  input.onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      toast('Procesando foto...', 'info');
      const fotoBase64 = await _comprimirImagenAFile(file, 1600, 0.78);
      const r = await fetch(`/api/pedidos/${id}/foto-costura`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fotoBase64 }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'No se pudo subir la foto');
      // Refrescar pedidos del servidor para que la vista se actualice
      try {
        const rp = await fetch('/api/pedidos');
        const dp = await rp.json();
        pedidos = dp.pedidos || dp;
      } catch (e) {}
      try { guardar(); } catch (e) {}
      try { render(); } catch (e) {}
      renderMiniCostura();
      toast(`✅ Pedido #${id} terminado. Pasa a revisión.`, 'success');
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  };
  input.click();
}

// Reduce la imagen a maxLado px y JPEG calidad q. Devuelve data URL base64.
function _comprimirImagenAFile(file, maxLado, q) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (Math.max(w, h) > maxLado) {
          const escala = maxLado / Math.max(w, h);
          w = Math.round(w * escala);
          h = Math.round(h * escala);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', q || 0.78));
      };
      img.onerror = () => reject(new Error('No se pudo leer la imagen'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

function recibirSatelitePedido(id) {
  const p = pedidos.find(x => x.id === id);
  if(!p || !p.satelite) return;
  const satelite = p.satelite;
  delete p.satelite;
  p.estado = 'calidad';
  
  // Auto-registrar recepción
  const cant = p.cantidades ? p.cantidades.reduce((a,b)=>a+b.c,0) : 1;
  const hoy = new Date().toLocaleDateString('es-CO');
  const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  satMovimientos.unshift({
    id: Date.now(), tipo: 'recepcion', satelite,
    equipo: p.equipo || p.telefono, prenda: 'Uniforme completo', cantidad: cant,
    fecha: hoy, hora
  });
  guardarSat_store();
  guardar();
  render();
  toast(`Pedido #${id} recibido de ${satelite}. Pasa a revision final.`, 'success');
}


function renderSatelites() {
  const contResumen = document.getElementById('sat-resumen');
  const contLista   = document.getElementById('lista-satelites');
  if (!contResumen || !contLista) return;

  // Precios estandarizados para cálculo ciego de caja
  const VALOR_PRENDA = {
    'Sublimado completo': 1500,
    'Sudadera': 2000,
    'Camiseta': 1200,
    'Polo': 1800,
    'Chaqueta': 3500,
    'Pantaloneta': 1000
  };

  // Badge sidebar
  const pendTotal = SATELITES.reduce((sum, s) => {
    const entregado = satMovimientos.filter(m => m.satelite === s && m.tipo === 'entrega').reduce((a, m) => a + m.cantidad, 0);
    const recibido  = satMovimientos.filter(m => m.satelite === s && m.tipo === 'recepcion').reduce((a, m) => a + m.cantidad, 0);
    return sum + Math.max(0, entregado - recibido);
  }, 0);
  const badgeSat = document.getElementById('badge-satelites');
  if (badgeSat) badgeSat.textContent = pendTotal;

  // Colores únicos por satélite
  const SAT_COLORS = {
    'Marcela':     { border: 'rgba(139,92,246,0.35)', header: '#a78bfa', dot: '#7c3aed' },
    'Yamile':      { border: 'rgba(6,182,212,0.35)',  header: '#67e8f9', dot: '#0891b2' },
    'Wilson':      { border: 'rgba(249,115,22,0.35)', header: '#fb923c', dot: '#ea580c' },
    'Cristina':    { border: 'rgba(236,72,153,0.35)', header: '#f9a8d4', dot: '#db2777' },
  };

  // Botón Admin Secreto para ver la nómina
  window.verNominaSatelites = function() {
    const pass = prompt('Clave de Admin:');
    if (pass === '777') {
      document.querySelectorAll('.liq-secreta').forEach(el => el.style.display = 'block');
    }
  };

  // Resumen por satélite
  contResumen.innerHTML = `
    <div style="width:100%; display:flex; justify-content: flex-end; margin-bottom: 10px;">
       <button class="btn btn-glass btn-xs" onclick="verNominaSatelites()">🔒 Liquidación</button>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:16px;">
  ` + SATELITES.map(s => {
    const entregado = satMovimientos.filter(m => m.satelite === s && m.tipo === 'entrega').reduce((a, m) => a + m.cantidad, 0);
    const recibido  = satMovimientos.filter(m => m.satelite === s && m.tipo === 'recepcion').reduce((a, m) => a + m.cantidad, 0);
    const pendiente = Math.max(0, entregado - recibido);
    const col = SAT_COLORS[s] || { border: 'rgba(255,255,255,0.1)', header: '#94a3b8', dot: '#64748b' };

    // Cálculo Ciego (Dinero que se debe por prendas RECIBIDAS)
    let saldoAdeudado = 0;

    // Prendas pendientes por tipo
    const prendasMap = {};
    satMovimientos.filter(m => m.satelite === s).forEach(m => {
      const p = m.prenda || 'Sin tipo';
      if (!prendasMap[p]) prendasMap[p] = 0;
      prendasMap[p] += m.tipo === 'entrega' ? m.cantidad : -m.cantidad;
      
      // La plata se debe basada en lo que devuelven ya cosido (recepción)
      if (m.tipo === 'recepcion') {
         const valor = VALOR_PRENDA[p] || 1000; // 1000 base si no existe
         saldoAdeudado += m.cantidad * valor;
      }
      // Nota: Si se implementaran anticipos habría que restarlos, esto cubre el total de producción
    });
    
    // Formatear a pesos colombianos
    const saldoFormateado = '$' + saldoAdeudado.toLocaleString('es-CO');

    const prendasPend = Object.entries(prendasMap).filter(([, v]) => v > 0);
    const prendasHtml = prendasPend.length
      ? `<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.07);padding-top:6px;">
          ${prendasPend.map(([p, v]) => `<div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text-muted);padding:1px 0;"><span>${esc(p)}</span><span style="color:var(--text);font-weight:600;">${v}</span></div>`).join('')}
         </div>`
      : '';

    return `
      <div class="sat-card" style="border-color:${col.border}; width: 100%; max-width: 280px; flex: 1; margin:0;">
        <div class="sat-card-nombre" style="color:${col.header};display:flex;align-items:center;gap:7px;">
          <span style="width:9px;height:9px;border-radius:50%;background:${col.dot};flex-shrink:0;"></span>
          ${esc(s)}
          ${pendiente > 0 ? `<span style="margin-left:auto;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:10px;padding:1px 7px;font-size:0.68rem;font-weight:700;">${pendiente} pend.</span>` : ''}
        </div>
        <div class="sat-stat-row">
          <span class="sat-stat-label">Entregado</span>
          <span class="sat-stat-val sat-entregado">${entregado}</span>
        </div>
        <div class="sat-stat-row">
          <span class="sat-stat-label">Recibido</span>
          <span class="sat-stat-val sat-recibido">${recibido}</span>
        </div>
        <div class="sat-stat-row" style="border-top:1px solid rgba(255,255,255,0.07);margin-top:6px;padding-top:6px;">
          <span class="sat-stat-label">Pendiente</span>
          <span class="sat-stat-val ${pendiente > 0 ? 'sat-pendiente' : 'sat-recibido'}">${pendiente}</span>
        </div>
        ${prendasHtml}
        
        <!-- Contabilidad Ciega -->
        <div class="liq-secreta" style="display:none; margin-top:12px; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.3); border-radius:6px; padding:8px; text-align:center;">
           <div style="font-size:0.65rem; color:#4ade80; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">Deuda Acumulada</div>
           <div style="font-size:1.1rem; color:#fff; font-weight:700;">${saldoFormateado}</div>
        </div>
      </div>
    `;
  }).join('') + `</div>`;

  // NUEVAS LISTAS OPERATIVAS (Para Enviar y En Satélite)
  const listParaEnviar = document.getElementById('sat-para-enviar-list');
  const listTrabajando = document.getElementById('sat-trabajando-list');
  
  if (listParaEnviar && listTrabajando) {
    const pParaEnviar = pedidos.filter(p => p.estado === 'costura' && !p.satelite);
    const pTrabajando = pedidos.filter(p => p.estado === 'en-satelite' || (p.estado === 'costura' && p.satelite));
    
    // Select dinámico de satélites
    const satOptions = SATELITES.map(s => `<option value="${s}">${s}</option>`).join('');

    listParaEnviar.innerHTML = pParaEnviar.length ? pParaEnviar.map(p => `
      <div class="sat-card" style="margin:0; padding:12px;">
        <div style="font-weight:700; margin-bottom:4px;">#${p.id} - ${esc(p.equipo || p.telefono)}</div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">${p.prendas?.map(pr=>pr.tipo).join(', ') || 'Uniforme'}</div>
        <div style="display:flex; gap:6px;">
          <select class="form-select" id="sel-sat-${p.id}" style="padding:4px; font-size:0.75rem;">
            <option value="">-- Satélite --</option>
            ${satOptions}
          </select>
          <button class="btn btn-success btn-sm" onclick="if(document.getElementById('sel-sat-${p.id}').value) asignarSatelitePedido(${p.id}, document.getElementById('sel-sat-${p.id}').value); else toast('Seleccione satélite','error')">Enviar</button>
        </div>
      </div>
    `).join('') : '<div class="dash-empty">No hay pedidos pendientes de enviar a satélite.</div>';

    listTrabajando.innerHTML = pTrabajando.length ? pTrabajando.map(p => {
      const sName = p.satelite || 'Desconocido';
      const col = SAT_COLORS[sName] || { header: '#94a3b8' };
      return `
      <div class="sat-card" style="margin:0; padding:12px; border-left:4px solid ${col.header};">
        <div style="font-weight:700; margin-bottom:4px; display:flex; justify-content:space-between;">
          <span>#${p.id} - ${esc(p.equipo || p.telefono)}</span>
          <span style="font-size:0.7rem; background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px;">${sName}</span>
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">${p.prendas?.map(pr=>pr.tipo).join(', ') || 'Uniforme'}</div>
        <button class="btn btn-success btn-sm" style="width:100%;" onclick="recibirSatelitePedido(${p.id})">✅ Recibir y Terminar</button>
      </div>
    `}).join('') : '<div class="dash-empty">No hay pedidos actualmente en satélite.</div>';
  }

  // Lista de movimientos por satélite — cada uno su columna (Historial)
  if (!satMovimientos.length) {
    contLista.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:0.8rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);">Sin movimientos registrados</div>`;
    return;
  }

  function renderMovItem(m) {
    return `
      <div class="sat-item ${m.tipo}" style="margin-bottom:6px;">
        <span style="font-size:0.9rem;">${m.tipo === 'entrega' ? '📦' : '✅'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.equipo)}</div>
          <div style="font-size:0.68rem;color:var(--text-muted);">${esc(m.prenda)} · ${m.fecha} ${m.hora}</div>
        </div>
        <span class="sat-tipo-badge" style="${m.tipo === 'entrega' ? 'background:rgba(6,182,212,0.15);color:#67e8f9;border:1px solid rgba(6,182,212,0.3);' : 'background:rgba(16,185,129,0.15);color:#4ade80;border:1px solid rgba(16,185,129,0.3);'}">${m.tipo === 'entrega' ? '+' : '-'}${m.cantidad}</span>
      </div>`;
  }

  contLista.innerHTML = `
    <div class="cal-semana-header" style="color:var(--text-muted);">Movimientos por satélite</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:16px;margin-top:10px;">
      ${SATELITES.map(s => {
        const col = SAT_COLORS[s] || { border: 'rgba(255,255,255,0.1)', header: '#94a3b8', dot: '#64748b' };
        const movs = satMovimientos.filter(m => m.satelite === s);
        const movsHtml = movs.length
          ? movs.slice(0, 25).map(renderMovItem).join('')
          : `<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.75rem;">Sin movimientos</div>`;
        return `
          <div style="background:var(--card-bg);border:1px solid ${col.border};border-radius:var(--radius);padding:14px;overflow:hidden;">
            <div style="font-size:0.82rem;font-weight:700;color:${col.header};margin-bottom:10px;display:flex;align-items:center;gap:7px;">
              <span style="width:9px;height:9px;border-radius:50%;background:${col.dot};flex-shrink:0;"></span>
              ${esc(s)}
              <span style="font-size:0.7rem;font-weight:400;color:var(--text-muted);margin-left:auto;">${movs.length} mov.</span>
            </div>
            <div style="max-height:400px;overflow-y:auto;">
              ${movsHtml}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   SISTEMA DE NOTIFICACIONES
════════════════════════════════════════════════════════════════ */
let notificaciones = JSON.parse(localStorage.getItem('ws_notifs') || '[]');

function guardarNotifs() {
  // Máximo 60 notificaciones guardadas
  if (notificaciones.length > 60) notificaciones = notificaciones.slice(0, 60);
  localStorage.setItem('ws_notifs', JSON.stringify(notificaciones));
  // Sincronizar con servidor para que todos los dispositivos las vean
  fetch('/api/notificaciones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notificaciones })
  }).catch(() => {});
}

function crearNotif(icono, mensaje, tipo = 'info', pedidoId = null) {
  const notif = {
    id:      Date.now(),
    icono,
    mensaje,
    tipo,       // 'info' | 'success' | 'warning' | 'danger'
    pedidoId,
    leida:   false,
    hora:    new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
    fecha:   new Date().toLocaleDateString('es-CO'),
  };
  notificaciones.unshift(notif);
  guardarNotifs();
  renderNotifs();
}

function renderNotifs() {
  const lista  = document.getElementById('notif-list');
  const badge  = document.getElementById('notif-badge');
  if (!lista || !badge) return;

  const noLeidas = notificaciones.filter(n => !n.leida).length;

  // Badge
  if (noLeidas > 0) {
    badge.textContent = noLeidas > 99 ? '99+' : noLeidas;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }

  if (!notificaciones.length) {
    lista.innerHTML = '<div class="notif-empty">🔕 Sin notificaciones</div>';
    return;
  }

  // Agrupar por fecha
  const grupos = {};
  notificaciones.forEach(n => {
    const hoy = new Date().toLocaleDateString('es-CO');
    const key = n.fecha === hoy ? 'Hoy' : n.fecha;
    if (!grupos[key]) grupos[key] = [];
    grupos[key].push(n);
  });

  lista.innerHTML = Object.entries(grupos).map(([fecha, items]) => `
    <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);padding:6px 10px 4px;">${fecha}</div>
    ${items.map(n => `
      <div class="notif-item ${n.leida ? '' : 'unread'}" onclick="notifClick(${n.id})">
        <div class="notif-icon">${n.icono}</div>
        <div class="notif-body">
          <div class="notif-msg">${n.mensaje}</div>
          <div class="notif-time">${n.hora}</div>
        </div>
      </div>
    `).join('')}
  `).join('');
}

function notifClick(id) {
  const n = notificaciones.find(x => x.id === id);
  if (!n) return;
  n.leida = true;
  guardarNotifs();
  renderNotifs();
  // Si tiene pedido asociado, navegar a vista general
  if (n.pedidoId) {
    showSection('vista-general', document.querySelector('[onclick*="vista-general"]'));
  }
}

function marcarTodasLeidas() {
  notificaciones.forEach(n => n.leida = true);
  guardarNotifs();
  renderNotifs();
}

function borrarNotifs() {
  notificaciones = [];
  guardarNotifs();
  renderNotifs();
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  panel.classList.toggle('open');
  // Al abrir, marcar como leídas
  if (panel.classList.contains('open')) {
    setTimeout(() => {
      notificaciones.forEach(n => n.leida = true);
      guardarNotifs();
      renderNotifs();
    }, 1500);
  }
}

// Cerrar panel al hacer click fuera
document.addEventListener('click', e => {
  const panel = document.getElementById('notif-panel');
  const btn   = document.querySelector('.notif-btn');
  if (panel && btn && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.remove('open');
  }
});

// Verificar alertas de fechas próximas (se llama cada hora y al cargar)
function verificarAlertasFechas() {
  const hoy  = new Date(); hoy.setHours(0,0,0,0);
  const hoyStr = hoy.toLocaleDateString('es-CO');

  pedidos.filter(p => p.estado !== 'enviado-final' && p.fechaEntrega).forEach(p => {
    const d    = new Date(p.fechaEntrega + 'T00:00:00');
    const diff = Math.round((d - hoy) / 86400000);
    const clave = `alerta-fecha-${p.id}-${hoyStr}`;

    // Solo una alerta por pedido por día
    if (localStorage.getItem(clave)) return;

    if (diff === 0) {
      localStorage.setItem(clave, '1');
      crearNotif('🚨', `<strong>#${p.id} ${esc(p.equipo || p.telefono)}</strong> — entrega HOY`, 'danger', p.id);
    } else if (diff === 1) {
      localStorage.setItem(clave, '1');
      crearNotif('⚠️', `<strong>#${p.id} ${esc(p.equipo || p.telefono)}</strong> — entrega mañana`, 'warning', p.id);
    } else if (diff === 2) {
      localStorage.setItem(clave, '1');
      crearNotif('📅', `<strong>#${p.id} ${esc(p.equipo || p.telefono)}</strong> — entrega en 2 días`, 'info', p.id);
    } else if (diff < 0) {
      localStorage.setItem(clave, '1');
      crearNotif('🔴', `<strong>#${p.id} ${esc(p.equipo || p.telefono)}</strong> — entrega vencida hace ${Math.abs(diff)}d`, 'danger', p.id);
    }
  });
}

// Inicializar notificaciones al cargar
renderNotifs();
setTimeout(verificarAlertasFechas, 1000);
setInterval(verificarAlertasFechas, 3600000); // cada hora


/* ════════════════════════════════════════════════════════════════
   MÓDULO COTIZACIONES / FACTURAS
════════════════════════════════════════════════════════════════ */
const LOGO_WYS = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? '/logos wys.png'
  : 'https://' + location.hostname + '/logos%20wys.png';

let docTipo = 'cotizacion';
let docItems = [];
let docHistorial = JSON.parse(localStorage.getItem('ws_docs') || '[]');
let nextCot = parseInt(localStorage.getItem('ws_nextCot') || '210');
let nextFac = parseInt(localStorage.getItem('ws_nextFac') || '501');
let docCuenta = 1; // 1 = Duvan, 2 = William

const CUENTAS_BANCOLOMBIA = {
  1: { num: '215 0000 3773', nombre: 'DUVAN DOMINGUEZ VELANDIA', cc: 'C.C. 1 030 675 743', tipo: 'CTA DE AHORROS' },
  2: { num: '912 383 287 94', nombre: 'william sneider dominguez', cc: '1.233.506.852', tipo: 'cta de ahorros' },
};
// Segundo número de Nequi para mostrar en la factura.
const NEQUI_EXTRA = '322 976 13 81';

function selCuenta(n) {
  docCuenta = n;
  document.getElementById('btn-cta1').className = 'btn btn-xs ' + (n===1 ? 'btn-orange' : 'btn-glass');
  document.getElementById('btn-cta2').className = 'btn btn-xs ' + (n===2 ? 'btn-orange' : 'btn-glass');
}

function guardarDocs() {
  localStorage.setItem('ws_docs', JSON.stringify(docHistorial));
  localStorage.setItem('ws_nextCot', String(nextCot));
  localStorage.setItem('ws_nextFac', String(nextFac));
  // Subir al servidor (historial + contadores)
  fetch('/api/docs/nums', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nextCot, nextFac, historial: docHistorial })
  }).catch(() => {});
}

// Sincroniza historial entre este dispositivo y el servidor (bidireccional)
async function cargarDocsServidor() {
  try {
    // 1. Bajar lo que tiene el servidor
    const r = await fetch('/api/docs/nums');
    if (!r.ok) return;
    const data = await r.json();
    if (data.nextCot) { nextCot = data.nextCot; localStorage.setItem('ws_nextCot', String(nextCot)); }
    if (data.nextFac) { nextFac = data.nextFac; localStorage.setItem('ws_nextFac', String(nextFac)); }

    // 2. Merge servidor + local
    const servidorHist = Array.isArray(data.historial) ? data.historial : [];
    const todos = [...docHistorial, ...servidorHist];
    const vistos = new Set();
    const merged = todos.filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; });
    merged.sort((a, b) => b.id - a.id);
    if (merged.length > 50) merged.length = 50;
    docHistorial = merged;
    localStorage.setItem('ws_docs', JSON.stringify(docHistorial));
    renderDocHistorial();

    // 3. Siempre subir el merge completo al servidor (para que quede todo centralizado)
    fetch('/api/docs/nums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextCot, nextFac, historial: docHistorial })
    }).catch(() => {});
  } catch {}
}

function abrirFormDoc(tipo) {
  docTipo = tipo;
  docItems = [{ cant: 1, desc: '', precio: 0 }];
  document.getElementById('form-doc-titulo').textContent = tipo === 'cotizacion' ? 'Nueva cotización' : 'Nueva factura';
  document.getElementById('doc-cliente').value = '';
  document.getElementById('doc-telefono').value = '';
  document.getElementById('doc-nit').value = '';
  document.getElementById('doc-correo').value = '';
  document.getElementById('doc-vendedora').value = '';
  document.getElementById('doc-abono').value = '';
  document.getElementById('doc-abono-grupo').style.display = tipo === 'factura' ? '' : 'none';
  document.getElementById('form-doc').style.display = '';
  renderDocItems();
  renderDocTotales();
  document.getElementById('form-doc').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cerrarFormDoc() {
  document.getElementById('form-doc').style.display = 'none';
}

function addItemDoc() {
  docItems.push({ cant: 1, desc: '', precio: 0 });
  renderDocItems();
  renderDocTotales();
}

function removeItemDoc(i) {
  docItems.splice(i, 1);
  if (docItems.length === 0) docItems.push({ cant: 1, desc: '', precio: 0 });
  renderDocItems();
  renderDocTotales();
}

function renderDocItems() {
  const cont = document.getElementById('doc-items-list');
  cont.innerHTML = docItems.map((it, i) => `
    <div class="doc-item-row">
      <input type="number" class="form-input" min="1" value="${it.cant}"
        oninput="docItems[${i}].cant=+this.value;renderDocTotales()">
      <input type="text" class="form-input" value="${esc(it.desc)}" placeholder="Descripción (ej: CAMISETAS NIÑO)"
        oninput="docItems[${i}].desc=this.value">
      <input type="number" class="form-input" min="0" value="${it.precio}" placeholder="Precio unit."
        oninput="docItems[${i}].precio=+this.value;renderDocTotales()">
      <div style="font-size:0.78rem;color:var(--text-muted);text-align:right;padding-right:4px;">
        ${fmtPeso(it.cant * it.precio)}
      </div>
      <button class="btn btn-glass btn-xs" onclick="removeItemDoc(${i})">✕</button>
    </div>
  `).join('');
}

function calcDocTotales() {
  const subtotal = docItems.reduce((s, it) => s + (it.cant * it.precio), 0);
  const abono = docTipo === 'factura' ? (parseInt(document.getElementById('doc-abono')?.value || '0') || 0) : 0;
  const total = subtotal - abono;
  return { subtotal, abono, total };
}

function renderDocTotales() {
  const { subtotal, abono, total } = calcDocTotales();
  const cont = document.getElementById('doc-totales');
  let html = `<div class="doc-totales-row"><span class="lbl">SUBTOTAL:</span><span class="val">${fmtPeso(subtotal)}</span></div>`;
  if (docTipo === 'factura') {
    html += `<div class="doc-totales-row"><span class="lbl">ABONO:</span><span class="val" style="color:var(--orange)">${fmtPeso(abono)}</span></div>`;
  }
  html += `<div class="doc-totales-row total-final"><span class="lbl">TOTAL:</span><span class="val">${fmtPeso(total)}</span></div>`;
  cont.innerHTML = html;
}

function fmtPeso(n) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
}

function fmtPesoNum(n) {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);
}

// generarPDF: solo imprimir / vista previa. Usa MISMO template buildDocHTML
// que el flow nuevo (Generar+Drive) para que el estilo sea consistente
// entre lo que ve el cliente por WhatsApp y lo que se imprime.
function generarPDF() {
  const cliente   = document.getElementById('doc-cliente').value.trim();
  const vendedora = document.getElementById('doc-vendedora').value;
  if (!cliente)   return toast('Ingresa el nombre del cliente', 'warning');
  if (!vendedora) return toast('Selecciona la vendedora', 'warning');
  if (docItems.every(it => !it.desc)) return toast('Agrega al menos un ítem', 'warning');

  const telefono = document.getElementById('doc-telefono').value.trim();
  const abono    = docTipo === 'factura' ? (parseInt(document.getElementById('doc-abono').value || '0') || 0) : 0;
  const { subtotal, total } = calcDocTotales();

  const num    = docTipo === 'cotizacion' ? nextCot : nextFac;
  const numStr = String(num).padStart(5, '0');
  const fecha  = new Date().toLocaleDateString('es-CO');

  // Construir registro con misma forma que el historial / flow nuevo
  const registro = {
    id: Date.now(), tipo: docTipo, numero: numStr, cliente, vendedora, telefono,
    subtotal, abono, total, fecha, cuenta: docCuenta,
    items: docItems.filter(it => it.desc).map(it => ({...it})),
  };

  // Guardar en historial local + bump contador
  docHistorial.unshift(registro);
  if (docHistorial.length > 50) docHistorial = docHistorial.slice(0, 50);
  if (docTipo === 'cotizacion') nextCot++; else nextFac++;
  guardarDocs();
  renderDocHistorial();

  // Usar el MISMO template que el flow nuevo y el envío WA
  const htmlDoc = buildDocHTML(registro);
  const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 1200);
  else window.location.href = url;

  const tituloLabel = docTipo === 'cotizacion' ? 'Cotización' : 'Factura';
  toast(tituloLabel + ' #' + numStr + ' generada', 'success');
  cerrarFormDoc();
}

// ════════════════════════════════════════════════════════════════
// DASHBOARD CALANDRA — KPIs + huérfanos + envíos recientes
// ════════════════════════════════════════════════════════════════
let _calandraCache = null;
let _calandraUltimaCarga = 0;

async function _cargarCalandraServer(force) {
  const ahora = Date.now();
  if (!force && _calandraCache && (ahora - _calandraUltimaCarga) < 20000) return _calandraCache;
  try {
    const r = await fetch('/api/calandra/dashboard');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _calandraCache = await r.json();
    _calandraUltimaCarga = ahora;
  } catch (e) {
    console.warn('[calandra dash] error:', e.message);
    _calandraCache = null;
  }
  return _calandraCache;
}

function _calandraKpiCard(val, label, color, sub) {
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;">
    <div style="font-size:0.66rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">${label}</div>
    <div style="font-family:'Outfit',sans-serif;font-size:1.6rem;font-weight:800;color:${color};line-height:1;">${val}</div>
    ${sub ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">${sub}</div>` : ''}
  </div>`;
}

async function renderCalandraDashboard(force) {
  await _cargarCalandraServer(force);
  renderCalandraKPIs();
  renderCalandraHuerfanos();
  renderCalandraEnvios();
}

function renderCalandraKPIs() {
  const cont = document.getElementById('calandra-kpis');
  if (!cont) return;
  const d = _calandraCache || {};
  const s = d.stats || {};
  cont.innerHTML =
    _calandraKpiCard(`${(s.hoy && s.hoy.m2 || 0).toLocaleString('es-CO')} m²`, 'Hoy', '#34d399', `${(s.hoy && s.hoy.pedidos) || 0} pedidos`) +
    _calandraKpiCard(`${(s.semana && s.semana.m2 || 0).toLocaleString('es-CO')} m²`, 'Esta semana', '#60a5fa', `${(s.semana && s.semana.pedidos) || 0} pedidos`) +
    _calandraKpiCard(`${(s.mes && s.mes.m2 || 0).toLocaleString('es-CO')} m²`, 'Este mes', '#a78bfa', `${(s.mes && s.mes.pedidos) || 0} pedidos`) +
    _calandraKpiCard(`${(s.anio && s.anio.m2 || 0).toLocaleString('es-CO')} m²`, 'Este año', '#fb923c', `${(s.anio && s.anio.pedidos) || 0} pedidos`) +
    _calandraKpiCard((d.totalEnvios || 0).toLocaleString('es-CO'), 'Envíos totales', '#f472b6', 'históricos');
}

// Normaliza texto para matching: minusculas, sin tildes, sin puntuacion
function _normMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Busca el mejor pedido para asociar a un PDF segun nombre base.
// Devuelve { pedido, score } o null. Score: cantidad de tokens del PDF que aparecen en el equipo.
function _matchPedidoParaArchivo(base) {
  if (!base) return null;
  // Limpiar base: quitar sufijos tipicos _XXX, faltantes, exedentes, _xxxm
  const limpio = _normMatch(base)
    .replace(/\b(faltantes|exedentes|excedentes|original|copia|m2|m²)\b/g, '')
    .replace(/\b\d+\b/g, '') // quitar numeros
    .trim();
  const tokens = limpio.split(' ').filter(t => t.length >= 3);
  if (!tokens.length) return null;
  let best = null;
  for (const p of (pedidos || [])) {
    if (p.estado === 'enviado-final') continue; // ignorar entregados
    const equipoNorm = _normMatch(p.equipo || '');
    if (!equipoNorm) continue;
    let score = 0;
    for (const t of tokens) {
      if (equipoNorm.includes(t)) score++;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { pedido: p, score };
    }
  }
  return best && best.score >= 1 ? best : null;
}

function renderCalandraHuerfanos() {
  const cont = document.getElementById('calandra-huerfanos');
  if (!cont) return;
  const d = _calandraCache || {};
  const huerfanos = d.huerfanos || [];
  if (!huerfanos.length) {
    cont.innerHTML = '';
    return;
  }

  // Lista de pedidos candidatos para el selector (no entregados)
  const candidatos = (pedidos || [])
    .filter(p => p.estado !== 'enviado-final')
    .sort((a, b) => (b.id || 0) - (a.id || 0))
    .slice(0, 200);

  const filas = huerfanos.slice(0, 30).map(h => {
    const arch = h.archivo || {};
    const safeMsgId = esc(h.msgId);
    const sugerido = _matchPedidoParaArchivo(arch.base || arch.nombreOriginal || '');

    // Selector con datalist (HTML5 autocompletar nativo)
    const datalistId = `dl-${safeMsgId}`;
    const opts = candidatos.map(p => {
      const lbl = `#${p.id} — ${(p.equipo || 'Sin nombre').slice(0, 60)}${p.vendedora ? ' · ' + p.vendedora : ''}`;
      return `<option value="${p.id}" label="${esc(lbl)}">${esc(lbl)}</option>`;
    }).join('');

    // Si hay sugerencia: card destacada con boton de 1-click
    const sugerenciaHTML = sugerido
      ? `<div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:8px 12px;margin:6px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:0.92rem;">💡</span>
          <div style="flex:1;min-width:160px;">
            <div style="font-size:0.7rem;color:#86efac;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">Posible coincidencia</div>
            <div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-top:1px;">#${sugerido.pedido.id} ${esc(sugerido.pedido.equipo || 'Sin nombre')}</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">${esc(sugerido.pedido.vendedora || '—')} · ${esc(sugerido.pedido.telefono || 'sin tel')}</div>
          </div>
          <button onclick="vincularHuerfanoDirecto('${safeMsgId}', ${sugerido.pedido.id})" style="background:linear-gradient(135deg,#22c55e,#16a34a);color:white;border:none;padding:8px 16px;border-radius:8px;font-size:0.78rem;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(34,197,94,0.3);">✓ Vincular</button>
        </div>`
      : `<div style="background:rgba(148,163,184,0.06);border:1px solid rgba(148,163,184,0.15);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:0.72rem;color:var(--text-muted);">
          🔎 No se encontro un pedido que coincida con el nombre. Elegi de la lista o crea uno nuevo.
        </div>`;

    return `
      <div style="background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.22);border-radius:10px;padding:12px;margin-bottom:8px;">
        <div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <span style="font-size:1rem;">📎</span>
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:700;color:var(--text);font-size:0.88rem;letter-spacing:-0.01em;">${esc(arch.nombreOriginal || '—')}</div>
            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">base: <em>${esc(arch.base || '')}</em>${arch.m2 ? ' · ' + arch.m2 + 'm²' : ''} · ${esc((h.fecha || '').slice(0, 10))}</div>
          </div>
          ${h.linkWT ? `<a href="${esc(h.linkWT)}" target="_blank" style="background:rgba(96,165,250,0.18);border:1px solid rgba(96,165,250,0.4);color:#93c5fd;border-radius:6px;padding:5px 10px;font-size:0.72rem;text-decoration:none;font-weight:600;">Ver WT</a>` : ''}
        </div>
        ${sugerenciaHTML}
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;">
          <input list="${datalistId}" id="huerf-pid-${safeMsgId}" placeholder="🔎 Buscar pedido por nombre, telefono o #ID..."
            style="flex:1;min-width:220px;background:var(--card-bg);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:var(--text);font-size:0.82rem;padding:7px 11px;outline:none;">
          <datalist id="${datalistId}">${opts}</datalist>
          <button onclick="vincularHuerfano('${safeMsgId}')" style="background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.45);color:#c4b5fd;border-radius:6px;padding:7px 14px;font-size:0.78rem;font-weight:600;cursor:pointer;">Vincular</button>
          <button onclick="crearPedidoDesdeHuerfano('${safeMsgId}', '${esc(arch.base || arch.nombreOriginal || '').replace(/'/g, '\\\'')}')" title="Crear un pedido nuevo a partir de este archivo" style="background:rgba(34,197,94,0.18);border:1px solid rgba(34,197,94,0.4);color:#86efac;border-radius:6px;padding:7px 12px;font-size:0.78rem;font-weight:600;cursor:pointer;">+ Crear pedido</button>
        </div>
      </div>
    `;
  }).join('');

  cont.innerHTML = `
    <div style="background:rgba(251,191,36,0.04);border:1px solid rgba(251,191,36,0.18);border-radius:12px;padding:14px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-size:1.1rem;">⚠️</span>
        <span style="font-size:0.9rem;font-weight:700;color:#fbbf24;">Archivos de calandra sin pedido vinculado (${huerfanos.length})</span>
      </div>
      <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:12px;line-height:1.45;">
        Cuando el sistema reconoce el cliente, te muestra una sugerencia con boton verde — solo das click. Si no, busca el pedido en el campo de abajo (escribiendo el nombre o teléfono) o crea uno nuevo.
      </div>
      ${filas}
      ${huerfanos.length > 30 ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px;">+ ${huerfanos.length - 30} más…</div>` : ''}
    </div>
  `;
}

// Vincular directamente desde sugerencia (1-click)
async function vincularHuerfanoDirecto(msgId, pedidoId) {
  await _vincularHuerfanoCore(msgId, pedidoId);
}

// Vincular desde el input (con validacion)
async function vincularHuerfano(msgId) {
  const inp = document.getElementById('huerf-pid-' + msgId);
  if (!inp) return;
  const val = inp.value.trim();
  // Si val es "#123" o "123 — Equipo", extraer el numero
  const m = val.match(/#?(\d+)/);
  if (!m) return toast('Elige un pedido de la lista o escribe su numero', 'warning');
  await _vincularHuerfanoCore(msgId, parseInt(m[1], 10));
}

async function _vincularHuerfanoCore(msgId, pedidoId) {
  if (!pedidoId) return toast('ID de pedido invalido', 'warning');
  try {
    const r = await fetch('/api/calandra/vincular-huerfano', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgId, pedidoId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'falló');
    toast(`✅ Vinculado al pedido #${data.pedidoId}`, 'success');
    renderCalandraDashboard(true);
    if (typeof hardSyncFromServer === 'function') hardSyncFromServer(true);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Crear un pedido nuevo a partir del archivo huerfano (usa el nombre base como equipo)
async function crearPedidoDesdeHuerfano(msgId, baseSugerido) {
  const nombreLimpio = String(baseSugerido || '')
    .replace(/_[\d]+/g, '').replace(/[_\-]/g, ' ').trim();
  const nombre = prompt('Crear pedido nuevo desde este archivo.\n\nNombre del equipo o cliente:', nombreLimpio);
  if (!nombre || !nombre.trim()) return;
  try {
    const pedido = {
      id: nextId++,
      equipo: nombre.trim(),
      telefono: '',
      vendedora: '',
      tipoBandeja: 'pedido',
      // Si llego archivo de calandra, el pedido ya esta en esa etapa
      estado: 'enviado-calandra',
      creadoEn: new Date().toLocaleDateString('es-CO'),
      ultimoMovimiento: new Date().toISOString(),
      items: [],
      fechaEntrega: '',
      notas: 'Creado automaticamente desde archivo huerfano de calandra',
      origenHuerfano: true,
    };
    pedidos.push(pedido);
    guardar();
    render();
    toast(`✅ Pedido #${pedido.id} creado. Vinculando archivo...`, 'success');
    // Pequeño delay para que el guardar termine y el server tenga el pedido
    setTimeout(() => _vincularHuerfanoCore(msgId, pedido.id), 600);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function renderCalandraEnvios() {
  const cont = document.getElementById('calandra-envios-lista');
  if (!cont) return;
  const d = _calandraCache || {};
  const envios = d.enviadosRecientes || [];
  const buscar = (document.getElementById('calandra-buscar')?.value || '').toLowerCase().trim();
  let lista = envios;
  if (buscar) lista = lista.filter(e =>
    (e.equipo || '').toLowerCase().includes(buscar) ||
    (e.archivo || '').toLowerCase().includes(buscar) ||
    (e.vendedora || '').toLowerCase().includes(buscar)
  );
  if (!lista.length) {
    cont.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center;">No hay envíos a calandra todavía.</div>';
    return;
  }
  cont.innerHTML = lista.slice(0, 80).map(e => {
    const descargado = !!e.fechaDescarga;
    const fEnvio = (e.fechaEnvio || '').slice(0, 16).replace('T', ' ');
    const fDesc = descargado ? (e.fechaDescarga || '').slice(0, 16).replace('T', ' ') : '';
    const badgeEstado = descargado
      ? '<span style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.35);color:#86efac;border-radius:5px;padding:2px 8px;font-size:0.66rem;font-weight:700;" title="Calandra ya descargó">✓ DESCARGADO</span>'
      : '<span style="background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;border-radius:5px;padding:2px 8px;font-size:0.66rem;font-weight:700;">⏳ ESPERANDO</span>';
    const tipoBadge = {
      original: '<span style="background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.3);color:#c4b5fd;border-radius:5px;padding:2px 7px;font-size:0.65rem;font-weight:600;">📦 ORIGINAL</span>',
      arreglo: '<span style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:5px;padding:2px 7px;font-size:0.65rem;font-weight:600;">🔧 ARREGLO</span>',
      adicional: '<span style="background:rgba(96,165,250,0.15);border:1px solid rgba(96,165,250,0.3);color:#93c5fd;border-radius:5px;padding:2px 7px;font-size:0.65rem;font-weight:600;">➕ ADICIONAL</span>',
      muestra: '<span style="background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.3);color:#d8b4fe;border-radius:5px;padding:2px 7px;font-size:0.65rem;font-weight:600;">🧪 MUESTRA</span>',
    }[e.tipo] || '';
    const prio = e.prioridad === 'urgente' ? '<span style="background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.4);color:#fca5a5;border-radius:5px;padding:2px 6px;font-size:0.65rem;font-weight:800;">🚨 URGENTE</span>' : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:6px;flex-wrap:wrap;background:rgba(255,255,255,0.02);">
        <a onclick="irAlPedido(${e.pedidoId})" style="font-family:'Outfit',sans-serif;font-weight:800;color:#a78bfa;font-size:0.85rem;min-width:55px;cursor:pointer;text-decoration:none;">#${e.pedidoId}</a>
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:600;color:var(--text);font-size:0.85rem;">${esc(e.equipo || '—')}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);">${esc(e.archivo || '')}</div>
        </div>
        <span style="font-weight:700;color:#fbbf24;font-size:0.85rem;min-width:75px;text-align:right;">${(e.m2 || 0).toLocaleString('es-CO')}m²</span>
        ${tipoBadge}
        ${prio}
        ${badgeEstado}
        <div style="font-size:0.68rem;color:var(--text-muted);min-width:120px;text-align:right;">
          📤 ${esc(fEnvio)}<br>
          ${descargado ? `✓ ${esc(fDesc)}` : ''}
        </div>
        ${e.linkWT ? `<a href="${esc(e.linkWT)}" target="_blank" style="background:rgba(96,165,250,0.18);border:1px solid rgba(96,165,250,0.4);color:#93c5fd;border-radius:5px;padding:3px 8px;font-size:0.7rem;text-decoration:none;">Ver WT</a>` : ''}
      </div>
    `;
  }).join('');
}

async function syncCalandraManual() {
  toast('Sincronizando Gmail + Drive…', 'info');
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/gmail/sync', { method: 'POST' }),
      fetch('/api/drive/sync', { method: 'POST' }),
    ]);
    const d1 = await r1.json();
    const d2 = await r2.json();
    const msg = `Gmail: ${d1.aplicados || 0}/${d1.total || 0} · Drive: ${d2.aplicados || 0} archivos`;
    toast('✅ ' + msg, 'success');
    renderCalandraDashboard(true);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// LISTA FACTURAS SERVER-SIDE (BD profesional)
// ════════════════════════════════════════════════════════════════
let _facturasCache = null; // { facturas, stats } cargado del server
let _facturasUltimaCarga = 0;

async function _cargarFacturasServer(force) {
  const ahora = Date.now();
  if (!force && _facturasCache && (ahora - _facturasUltimaCarga) < 30000) return _facturasCache;
  try {
    const r = await fetch('/api/facturas?limit=200');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _facturasCache = await r.json();
    _facturasUltimaCarga = ahora;
  } catch (e) {
    console.warn('[facturas] error cargando del server, fallback localStorage', e.message);
    _facturasCache = null;
  }
  return _facturasCache;
}

function _fmtPeso0(n) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
}

function renderFacturasStats() {
  const cont = document.getElementById('facturas-stats');
  if (!cont) return;
  const esAdmin = personaTieneRol('admin') || userRol === 'admin';
  if (!esAdmin) {
    cont.style.display = 'none';
    cont.innerHTML = '';
    return;
  }
  cont.style.display = '';
  const data = _facturasCache || {};
  const stats = data.stats || { mes: { total: 0, n: 0 }, anio: { total: 0, n: 0 }, totalFacturas: 0, totalCotizaciones: 0 };
  // Hoy: contar facturas con fecha = hoy
  const hoyStr = new Date().toISOString().slice(0, 10);
  const facturas = data.facturas || [];
  const hoyArr = facturas.filter(f => f.tipo === 'factura' && (f.fecha || '').slice(0, 10) === hoyStr);
  const totalHoy = hoyArr.reduce((s, f) => s + (f.total || 0), 0);

  const kpi = (val, label, color, sub) => `
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;">
      <div style="font-size:0.66rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">${label}</div>
      <div style="font-family:'Outfit',sans-serif;font-size:1.6rem;font-weight:800;color:${color};line-height:1;">${val}</div>
      ${sub ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">${sub}</div>` : ''}
    </div>
  `;
  cont.innerHTML =
    kpi(_fmtPeso0(totalHoy), 'Facturado hoy', '#34d399', `${hoyArr.length} facturas`) +
    kpi(_fmtPeso0(stats.mes.total), 'Facturado mes', '#60a5fa', `${stats.mes.n} facturas`) +
    kpi(_fmtPeso0(stats.anio.total), 'Facturado año', '#a78bfa', `${stats.anio.n} facturas`) +
    kpi(stats.totalFacturas || 0, 'Total facturas', '#fb923c', 'históricas') +
    kpi(stats.totalCotizaciones || 0, 'Total cotizaciones', '#f472b6', 'históricas');
}

async function renderFacturasLista(forceReload) {
  const cont = document.getElementById('doc-historial');
  if (!cont) return;
  cont.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:16px 0;">Cargando…</div>';
  // Ocultar selector "Todas las vendedoras" a no-admin (no le sirve, solo ve las suyas)
  const _esAdminFL = personaTieneRol('admin') || userRol === 'admin';
  const _selVend = document.getElementById('doc-filtro-vendedora');
  if (_selVend) _selVend.style.display = _esAdminFL ? '' : 'none';
  await _cargarFacturasServer(forceReload);
  renderFacturasStats();

  const buscar = (document.getElementById('doc-buscar')?.value || '').toLowerCase().trim();
  const filtroTipo = document.getElementById('doc-filtro-tipo')?.value || '';
  const filtroVendedora = document.getElementById('doc-filtro-vendedora')?.value || '';

  // Combinar facturas del server + las locales que aún no se subieron (si el server fallaba)
  const fromServer = (_facturasCache && _facturasCache.facturas) ? _facturasCache.facturas : [];
  const map = new Map();
  for (const f of fromServer) {
    // Normalizar campos para que coincidan con los del historial local
    map.set(`s-${f.id}`, {
      _serverId: f.id,
      tipo: f.tipo,
      numero: f.numero,
      cliente: f.cliente_nombre,
      telefono: f.cliente_telefono,
      vendedora: f.vendedora,
      total: f.total,
      subtotal: f.subtotal,
      abono: f.abono,
      fecha: f.fecha,
      items: f.items || [],
      drive_link: f.drive_link,
      drive_file_id: f.drive_file_id,
      wa_enviado_a: f.wa_enviado_a,
      creado_en: f.creado_en,
    });
  }
  // Añadir las del historial local que aún no están en server (por número+tipo)
  for (const d of docHistorial) {
    const existe = fromServer.find(f => f.numero === d.numero && f.tipo === d.tipo);
    if (!existe) map.set(`l-${d.id}`, { ...d, _local: true });
  }
  let lista = Array.from(map.values());

  if (filtroTipo) lista = lista.filter(d => d.tipo === filtroTipo);
  if (filtroVendedora) lista = lista.filter(d => d.vendedora === filtroVendedora);
  // Filtro por rol: si NO es admin, solo ve sus propias facturas.
  // En BD vendedora se guarda con nombre completo ("Betty Forero", "Paola Cruz")
  // y getPersonaActual().nombre es corto ("Betty"/"Paola") → match por substring.
  const esAdmin = personaTieneRol('admin') || userRol === 'admin';
  if (!esAdmin) {
    const persona = getPersonaActual();
    const miNombre = (persona?.nombre || '').toLowerCase().trim();
    if (miNombre) lista = lista.filter(d => (d.vendedora || '').toLowerCase().includes(miNombre));
  }
  if (buscar) lista = lista.filter(d =>
    (d.cliente || '').toLowerCase().includes(buscar) ||
    (d.numero || '').toLowerCase().includes(buscar) ||
    (d.vendedora || '').toLowerCase().includes(buscar) ||
    (d.telefono || '').toLowerCase().includes(buscar)
  );

  // Ordenar por fecha desc
  lista.sort((a, b) => {
    const ta = a.creado_en || a.fecha || '';
    const tb = b.creado_en || b.fecha || '';
    return tb.localeCompare(ta);
  });

  if (!lista.length) {
    cont.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:24px;text-align:center;">' +
      ((_facturasCache && _facturasCache.facturas && _facturasCache.facturas.length) ? 'Sin resultados para esa búsqueda.' : 'No hay documentos generados aún.') +
      '</div>';
    return;
  }

  cont.innerHTML = lista.slice(0, 100).map(d => {
    const id = d._serverId || d.id;
    const esCot = d.tipo === 'cotizacion';
    const driveBtn = d.drive_link
      ? `<a href="${esc(d.drive_link)}" target="_blank" rel="noopener" style="background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.4);color:#c4b5fd;border-radius:6px;padding:4px 9px;font-size:0.72rem;font-weight:600;text-decoration:none;">📁 Drive</a>`
      : '';
    const waBtn = (d._serverId && d.telefono)
      ? `<button onclick="enviarFacturaPorWA(${d._serverId})" style="background:#25d366;border:none;color:#fff;border-radius:6px;padding:4px 10px;font-size:0.72rem;font-weight:600;cursor:pointer;" title="Enviar al cliente por WhatsApp">📤 WA</button>`
      : (d._local ? `<button onclick="compartirDocWA(${d.id})" style="background:#25d366;border:none;color:#fff;border-radius:6px;padding:4px 10px;font-size:0.72rem;font-weight:600;cursor:pointer;" title="Compartir PDF">📤 WA</button>` : '');
    const verBtn = d._local
      ? `<button onclick="verDocHistorial(${d.id})" style="background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;border-radius:6px;padding:4px 9px;font-size:0.72rem;cursor:pointer;">Ver</button>`
      : '';
    const waEnviado = d.wa_enviado_a
      ? `<span style="background:rgba(37,211,102,0.12);border:1px solid rgba(37,211,102,0.3);color:#86efac;border-radius:5px;padding:1px 7px;font-size:0.66rem;font-weight:700;" title="Enviado a ${esc(d.wa_enviado_a)}">✓ enviado WA</span>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:6px;flex-wrap:wrap;background:rgba(255,255,255,0.02);">
        <span style="font-family:'Outfit',sans-serif;font-weight:800;color:#94a3b8;font-size:0.82rem;min-width:62px;">#${d.numero}</span>
        <span style="background:${esCot ? 'rgba(249,115,22,0.15)' : 'rgba(16,185,129,0.15)'};border:1px solid ${esCot ? 'rgba(249,115,22,0.35)' : 'rgba(16,185,129,0.35)'};color:${esCot ? '#fdba74' : '#6ee7b7'};border-radius:5px;padding:2px 8px;font-size:0.66rem;font-weight:700;text-transform:uppercase;">${esCot ? 'Cot' : 'Fac'}</span>
        <span style="font-weight:600;color:var(--text);font-size:0.85rem;flex:1;min-width:160px;">${esc(d.cliente || '—')}</span>
        <span style="color:var(--text-muted);font-size:0.74rem;min-width:90px;">👤 ${esc((d.vendedora || '').split(' ')[0] || '—')}</span>
        <span style="font-weight:700;color:#fbbf24;font-size:0.85rem;min-width:110px;text-align:right;">${_fmtPeso0(d.total || 0)}</span>
        <span style="color:var(--text-muted);font-size:0.7rem;min-width:85px;">${esc((d.fecha || '').slice(0, 10))}</span>
        ${waEnviado}
        <div style="display:flex;gap:5px;margin-left:auto;flex-wrap:wrap;">
          ${verBtn}${driveBtn}${waBtn}
        </div>
      </div>
    `;
  }).join('');
}

function renderDocHistorial() {
  // Wrapper de compatibilidad. Llama a la nueva lista server-side.
  renderFacturasLista();
}

// Auto-cargar facturas cuando se entra a la sección
document.addEventListener('DOMContentLoaded', () => {
  // Si entran a cotizaciones, recargar
  const obs = setInterval(() => {
    const sec = document.getElementById('cotizaciones');
    if (sec && sec.classList.contains('active') && !_facturasUltimaCarga) {
      renderFacturasLista();
    }
  }, 3000);
});

function _renderDocHistorialAntiguo_NO_USAR() {
  const cont = document.getElementById('doc-historial');
  if (!cont) return;

  const buscar = (document.getElementById('doc-buscar')?.value || '').toLowerCase().trim();
  const filtroTipo = document.getElementById('doc-filtro-tipo')?.value || '';

  let lista = docHistorial;
  if (filtroTipo) lista = lista.filter(d => d.tipo === filtroTipo);
  if (buscar) lista = lista.filter(d =>
    (d.cliente || '').toLowerCase().includes(buscar) ||
    (d.numero || '').toLowerCase().includes(buscar) ||
    (d.vendedora || '').toLowerCase().includes(buscar)
  );

  if (!lista.length) {
    cont.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:16px 0;">' +
      (docHistorial.length ? 'Sin resultados para esa búsqueda.' : 'No hay documentos generados aún.') + '</div>';
    return;
  }
  cont.innerHTML = lista.slice(0, 30).map(d => `
    <div class="doc-hist-row" style="flex-wrap:wrap;gap:4px;">
      <span class="doc-num">#${d.numero}</span>
      <span class="${d.tipo === 'cotizacion' ? 'doc-badge-cot' : 'doc-badge-fac'}">${d.tipo === 'cotizacion' ? 'Cot' : 'Fac'}</span>
      <span class="doc-cliente">${esc(d.cliente)}</span>
      <span class="doc-total">${fmtPeso(d.total)}</span>
      <span class="doc-fecha">${d.fecha}</span>
      <div style="margin-left:auto;display:flex;gap:5px;">
        <button onclick="verDocHistorial(${d.id})" style="background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;border-radius:6px;padding:3px 10px;font-size:0.75rem;cursor:pointer;">Ver</button>
        <button onclick="compartirDocWA(${d.id})" style="background:#25d366;border:none;color:#fff;border-radius:6px;padding:3px 10px;font-size:0.75rem;cursor:pointer;">WhatsApp</button>
      </div>
    </div>
  `).join('');
}

function verDocHistorial(id) {
  const d = docHistorial.find(x => x.id === id);
  if (!d) return;
  const htmlDoc = buildDocHTML(d);
  const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

function buildDocHTML(d) {
  const esCot   = d.tipo === 'cotizacion';
  const titulo  = esCot ? 'COTIZACIÓN' : 'FACTURA COMERCIAL';
  const color1  = '#0ea5e9'; // Acento primario W&S (Cyan/Azul)
  const color2  = '#1e293b'; // Fondo oscuro premium para header

  const filasItems = d.items.filter(it => it.desc).map(it => {
    const tot = (it.cant || 1) * (it.precio || 0);
    return `<tr>
      <td style="text-align:center;padding:12px 10px;font-size:13px;font-weight:700;color:#64748b;">${it.cant}</td>
      <td style="padding:12px 10px;font-size:13px;font-weight:600;color:#334155;">${esc(it.desc)}</td>
      <td style="text-align:right;padding:12px 10px;font-size:13px;color:#64748b;">${fmtPesoNum(it.precio || 0)}</td>
      <td style="text-align:right;padding:12px 10px;font-size:13px;font-weight:700;color:#0f172a;">${fmtPesoNum(tot)}</td>
    </tr>`;
  }).join('');

  const itemsValidos = d.items.filter(it => it.desc).length;
  const filasVacias  = Array.from({ length: Math.max(0, 4 - itemsValidos) })
    .map(() => `<tr><td style="padding:12px 10px;">&nbsp;</td><td></td><td></td><td></td></tr>`).join('');

  const abonoFila = !esCot && d.abono > 0 ? `<tr>
    <td colspan="2" style="border:none;"></td>
    <td style="text-align:right;font-weight:600;padding:8px 10px;font-size:12px;color:#64748b;">ABONO RECIBIDO:</td>
    <td style="text-align:right;padding:8px 10px;">
      <span style="background:#10b981;color:white;padding:4px 10px;border-radius:6px;font-weight:700;font-size:13px;">- ${fmtPesoNum(d.abono)}</span>
    </td>
  </tr>` : '';

  const notaCot = esCot ? `<div style="margin-top:24px;padding:16px;background:#f8fafc;border-left:4px solid ${color1};border-radius:0 8px 8px 0;font-size:11px;color:#475569;line-height:1.6;">
    <strong style="text-transform:uppercase;font-size:12px;color:${color1};margin-bottom:6px;display:inline-block;">Notas Comerciales:</strong><br>
    <strong>TELA:</strong> Microfibra poliéster semilicrado 8005 (Brillo, suavidad y resistente).<br><br>
    <strong>BONOS:</strong><br>
    • Por la compra de 35 uniformes obsequiamos bandera 1m x 1.50m.<br>
    • Por la compra de +100 uniformes aplicamos descuento del 5%.
  </div>` : '';

  // Mostrar AMBAS cuentas Bancolombia (Duvan + William) en cada factura.
  const cta1 = CUENTAS_BANCOLOMBIA[1];
  const cta2 = CUENTAS_BANCOLOMBIA[2];

  return `<!DOCTYPE html><html style="background:#f1f5f9;"><head><meta charset="UTF-8"><title>${titulo} #${d.numero}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{font-family:'Inter',sans-serif;background:white !important;color-scheme:light !important}
  .page{width:800px;min-height:900px;margin:0 auto;background:white;position:relative;}
  
  .header-bg { background:${color2}; color:white; padding:40px; display:flex; justify-content:space-between; align-items:center; border-radius:0 0 20px 20px; margin-bottom:30px; border-bottom:6px solid ${color1}; }
  .logo-box { display:flex; align-items:center; gap:10px; }
  .logo-icon { width:45px; height:45px; background:linear-gradient(135deg, #7c3aed, #0ea5e9); border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:800; font-family:'Outfit'; }
  .logo-text { font-family:'Outfit'; font-size:28px; font-weight:900; letter-spacing:0.5px; }
  .logo-sub { font-size:11px; text-transform:uppercase; letter-spacing:3px; color:#94a3b8; font-weight:600; margin-top:2px; }
  
  .company-dt { text-align:right; font-size:12px; color:#cbd5e1; line-height:1.6; }
  .company-dt strong { color:white; font-size:14px; }
  
  .doc-meta { padding:0 40px; display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:30px; }
  .doc-meta-left { display:flex; gap:40px; }
  .doc-meta-item { display:flex; flex-direction:column; gap:4px; }
  .doc-meta-lbl { font-size:11px; text-transform:uppercase; color:#94a3b8; font-weight:700; letter-spacing:1px; }
  .doc-meta-val { font-size:14px; color:#0f172a; font-weight:600; }
  .doc-title { text-align:right; }
  .doc-title h1 { font-family:'Outfit'; font-size:36px; color:${color1}; font-weight:900; letter-spacing:1px; line-height:1; }
  .doc-title .num { font-size:18px; font-weight:700; color:#64748b; margin-top:4px; }
  
  .client-box { margin:0 40px 30px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:20px; }
  .client-grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  
  .table-wrap { padding:0 40px; margin-bottom:30px; }
  table { width:100%; border-collapse:separate; border-spacing:0; }
  thead th { background:#f1f5f9; padding:12px 10px; font-size:11px; font-weight:700; color:#475569; text-transform:uppercase; text-align:left; border-top:1px solid #e2e8f0; border-bottom:1px solid #e2e8f0; }
  thead th:first-child { text-align:center; border-left:1px solid #e2e8f0; border-radius:8px 0 0 8px; }
  thead th:last-child { text-align:right; border-right:1px solid #e2e8f0; border-radius:0 8px 8px 0; }
  tbody td { border-bottom:1px solid #e2e8f0; }
  
  .totals-row td { background:#f8fafc; }
  .totals-row.final td { background:#fff; border-bottom:none; }
  .total-val { font-size:18px; font-weight:800; color:#0f172a; background:#e0f2fe; padding:6px 12px; border-radius:8px; display:inline-block; }
  
  .footer { padding:0 40px; margin-top:10px; }
  .footer-alert { background:#fff1f2; border:1px solid #fecdd3; border-radius:8px; padding:12px; text-align:center; font-size:10px; font-weight:700; color:#be123c; margin-bottom:20px; line-height:1.5; }
  
  .banks-title { text-align:center; font-family:'Outfit'; font-weight:800; font-size:14px; color:#334155; margin-bottom:12px; text-transform:uppercase; letter-spacing:1px; }
  .cuentas { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; }
  .cuenta { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px; text-align:center; font-size:11px; color:#475569; line-height:1.6; }
  .cuenta strong { display:block; font-size:13px; color:#0f172a; font-family:'Outfit'; margin-bottom:4px; }
  
  @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<div class="page">
  
  <div class="header-bg">
    <div class="logo-box">
      <div class="logo-icon">⚡</div>
      <div>
        <div class="logo-text">W&S UNIFORMES DEPORTIVOS</div>
        <div class="logo-sub">Producción Deportiva</div>
      </div>
    </div>
    <div class="company-dt">
      <strong>NIT: 52271474-9</strong><br>
      Carrera 90A # 4-40, Bogotá D.C.<br>
      350 697-4711 • 301 663-9430
    </div>
  </div>

  <div class="doc-meta">
    <div class="doc-meta-left">
      <div class="doc-meta-item">
        <span class="doc-meta-lbl">Fecha Emisión</span>
        <span class="doc-meta-val">${d.fecha}</span>
      </div>
      <div class="doc-meta-item">
        <span class="doc-meta-lbl">Asesor / Vendedor</span>
        <span class="doc-meta-val" style="display:flex;align-items:center;gap:6px;">
          <span style="display:inline-block;width:8px;height:8px;background:#10b981;border-radius:50%;"></span> ${esc(d.vendedora)}
        </span>
      </div>
    </div>
    <div class="doc-title">
      <h1>${titulo}</h1>
      <div class="num">Nº ${d.numero}</div>
    </div>
  </div>
  
  <div class="client-box">
    <div class="doc-meta-lbl" style="margin-bottom:12px;">Datos del Cliente</div>
    <div class="client-grid">
      <div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">Señor(es) / Equipo:</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a;">${esc(d.cliente)}</div>
      </div>
      <div>
        ${d.telefono ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">Teléfono:</div>
        <div style="font-size:13px;font-weight:600;color:#334155;">${d.telefono}</div>` : ''}
      </div>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th style="width:80px">Cant.</th><th>Descripción del Producto</th>
        <th style="width:120px;text-align:right;">Valor Unit.</th><th style="width:130px;text-align:right;">Total</th>
      </tr></thead>
      <tbody>
        ${filasItems}${filasVacias}
        <tr class="totals-row">
          <td colspan="2" style="border:none;"></td>
          <td style="text-align:right;font-weight:600;padding:12px 10px;color:#64748b;font-size:12px;">SUBTOTAL:</td>
          <td style="text-align:right;font-weight:700;padding:12px 10px;font-size:13px;color:#334155;">${fmtPesoNum(d.subtotal)}</td>
        </tr>
        ${abonoFila}
        <tr class="totals-row final">
          <td colspan="2" style="border:none;"></td>
          <td style="text-align:right;font-weight:800;font-size:14px;padding:16px 10px;color:#0f172a;">TOTAL A PAGAR:</td>
          <td style="text-align:right;padding:12px 0 12px 10px;"><span class="total-val">${fmtPesoNum(d.total)}</span></td>
        </tr>
      </tbody>
    </table>
  </div>
  
  <div class="footer">
    ${notaCot}
    
    <div class="footer-alert">
      RECUERDE: EL UNIFORME DE NIÑO VALE $5.000 MENOS QUE EL UNIFORME DE ADULTO.<br>
      PARA INICIAR PRODUCCIÓN SE REQUIERE UN ANTICIPO INICIAL DEL 50% DEL TOTAL DEL PEDIDO.
    </div>

    <div class="banks-title">Cuentas Bancarias Autorizadas</div>
    <div class="cuentas" style="grid-template-columns:repeat(2, 1fr);">
      <div class="cuenta"><strong>BANCOLOMBIA</strong>${cta1.num}<br>${cta1.nombre}<br>${cta1.cc}<br><span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-top:4px;display:inline-block;">${cta1.tipo}</span></div>
      <div class="cuenta"><strong>BANCOLOMBIA</strong>${cta2.num}<br>${cta2.nombre}<br>${cta2.cc}<br><span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-top:4px;display:inline-block;">${cta2.tipo}</span></div>
    </div>
    <div class="cuentas" style="grid-template-columns:repeat(3, 1fr);margin-top:14px;">
      <div class="cuenta"><strong>NEQUI</strong>350 697 47 11<br>301 663 94 30</div>
      <div class="cuenta"><strong>NEQUI</strong>${esc((typeof NEQUI_EXTRA !== 'undefined' && NEQUI_EXTRA) || '— pendiente —')}</div>
      <div class="cuenta"><strong>DAVIPLATA</strong>350 697 47 11<br>301 663 94 30</div>
    </div>
  </div>

</div>
</body></html>`;
}

// Convierte una URL de imagen a base64 para embeber en el PDF
async function imgToBase64(src) {
  try {
    const resp = await fetch(src);
    if (!resp.ok) throw new Error('fetch failed');
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    // fallback via canvas
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(''); // sin logo antes que romper el PDF
      img.src = src;
    });
  }
}

// ════════════════════════════════════════════════════════════════
// FACTURAS / COTIZACIONES — flow nuevo (server + Drive + WA)
// ════════════════════════════════════════════════════════════════

// Helper: convierte Blob a base64 (sin prefijo data:...)
function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const i = result.indexOf(',');
      resolve(i >= 0 ? result.slice(i + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Helper: genera PDF blob desde un registro de documento
async function _generarPdfBlobDesdeRegistro(registro) {
  const htmlDoc = buildDocHTML(registro);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px;height:1200px;border:none;background:white;';
  document.body.appendChild(iframe);
  iframe.contentDocument.open();
  iframe.contentDocument.write(htmlDoc);
  iframe.contentDocument.close();
  await new Promise(r => setTimeout(r, 1000));
  const opt = {
    margin: [8, 8, 8, 8],
    image: { type: 'jpeg', quality: 0.97 },
    html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#ffffff', logging: false },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };
  const pdfBlob = await html2pdf().set(opt).from(iframe.contentDocument.body).outputPdf('blob');
  document.body.removeChild(iframe);
  return pdfBlob;
}

// Flow nuevo: genera factura → PDF → server → Drive → modal WA
async function generarYGuardarFactura() {
  const cliente   = document.getElementById('doc-cliente').value.trim();
  const vendedora = document.getElementById('doc-vendedora').value;
  if (!cliente)   return toast('Ingresa el nombre del cliente', 'warning');
  if (!vendedora) return toast('Selecciona la vendedora', 'warning');
  if (docItems.every(it => !it.desc)) return toast('Agrega al menos un ítem', 'warning');

  const telefono = document.getElementById('doc-telefono').value.trim();
  const nit      = document.getElementById('doc-nit').value.trim();
  const correo   = document.getElementById('doc-correo').value.trim();
  const abono    = docTipo === 'factura' ? (parseInt(document.getElementById('doc-abono').value || '0') || 0) : 0;
  const { subtotal, total } = calcDocTotales();

  const num    = docTipo === 'cotizacion' ? nextCot : nextFac;
  const numStr = String(num).padStart(5, '0');
  const fecha  = new Date().toLocaleDateString('es-CO');
  const items  = docItems.filter(it => it.desc).map(it => ({ cant: it.cant, desc: it.desc, precio: it.precio }));

  const registroLocal = {
    id: Date.now(), tipo: docTipo, numero: numStr, cliente, vendedora, telefono,
    subtotal, abono, total, fecha, cuenta: docCuenta, items,
  };

  toast('Generando PDF…', 'info');

  let pdfBase64 = null;
  try {
    const blob = await _generarPdfBlobDesdeRegistro(registroLocal);
    pdfBase64 = await _blobToBase64(blob);
  } catch (e) {
    console.error('[fact pdf]', e);
    toast('Error generando PDF', 'error');
    return;
  }

  toast('Subiendo a Drive…', 'info');

  // POST al server
  let facturaServer = null;
  try {
    const r = await fetch('/api/facturas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        numero: numStr,
        tipo: docTipo,
        cliente_nombre: cliente,
        cliente_telefono: telefono || null,
        cliente_nit: nit || null,
        cliente_correo: correo || null,
        vendedora,
        items,
        subtotal,
        abono,
        total,
        fecha: new Date().toISOString().slice(0, 10),
        pdfBase64,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.factura) throw new Error(data.error || 'fallo al guardar');
    facturaServer = data.factura;
  } catch (e) {
    console.error('[fact post]', e);
    toast('Guardado local pero falló subir al servidor: ' + e.message, 'error');
    // Fallback: seguir con historial local
  }

  // Guardar también en localStorage (historial corto + contadores)
  docHistorial.unshift(registroLocal);
  if (docHistorial.length > 50) docHistorial = docHistorial.slice(0, 50);
  if (docTipo === 'cotizacion') nextCot++; else nextFac++;
  guardarDocs();
  renderDocHistorial();

  if (facturaServer && facturaServer.drive_link) {
    toast(`${docTipo === 'cotizacion' ? 'Cotización' : 'Factura'} #${numStr} guardada en Drive`, 'success');
    mostrarModalPostFactura(facturaServer, registroLocal);
  } else {
    toast(`${docTipo === 'cotizacion' ? 'Cotización' : 'Factura'} #${numStr} generada (sin subir a Drive)`, 'warning');
  }
  cerrarFormDoc();
}

// Modal post-generación con botón gigante "Enviar al cliente por WA"
function mostrarModalPostFactura(facturaServer, registroLocal) {
  const tipoLabel = facturaServer.tipo === 'cotizacion' ? 'Cotización' : 'Factura';
  const tipoEmoji = facturaServer.tipo === 'cotizacion' ? '🧾' : '📄';
  const tel = facturaServer.cliente_telefono || (registroLocal && registroLocal.telefono) || '';
  const overlay = document.createElement('div');
  overlay.id = 'modal-post-factura';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:#1e1b2e;border:1px solid rgba(124,58,237,0.4);border-radius:14px;padding:24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="text-align:center;font-size:2.2rem;margin-bottom:8px;">${tipoEmoji}</div>
      <div style="text-align:center;font-family:'Outfit',sans-serif;font-size:1.3rem;font-weight:800;color:#fff;margin-bottom:4px;">${tipoLabel} #${facturaServer.numero}</div>
      <div style="text-align:center;font-size:0.85rem;color:#94a3b8;margin-bottom:6px;">${esc(facturaServer.cliente_nombre || 'Sin cliente')}</div>
      <div style="text-align:center;font-size:1.3rem;font-weight:800;color:#10b981;margin-bottom:18px;">${fmtPeso(facturaServer.total || 0)}</div>

      <button onclick="compartirDocWA(${registroLocal ? registroLocal.id : 0})" style="width:100%;background:#25d366;border:none;color:#fff;border-radius:12px;padding:14px;font-size:0.95rem;font-weight:700;cursor:pointer;margin-bottom:8px;">
        📤 Compartir / Enviar al cliente
      </button>
      <div style="font-size:0.72rem;color:#94a3b8;text-align:center;margin-bottom:14px;line-height:1.4;">
        Se abre el menú de compartir del celular. Elegí <strong>WhatsApp</strong> y mandalo al cliente desde TU número.
      </div>

      <div style="display:flex;gap:8px;margin-bottom:10px;">
        ${facturaServer.drive_link ? `
          <a href="${esc(facturaServer.drive_link)}" target="_blank" rel="noopener" style="flex:1;background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.4);color:#c4b5fd;border-radius:10px;padding:10px;font-size:0.82rem;font-weight:600;text-decoration:none;text-align:center;">
            👁️ Ver en Drive
          </a>
        ` : ''}
        <button onclick="descargarFacturaDelHistorial(${registroLocal ? registroLocal.id : 0})" style="flex:1;background:rgba(124,58,237,0.18);border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;border-radius:10px;padding:10px;font-size:0.82rem;font-weight:600;cursor:pointer;">
          💾 Descargar PDF
        </button>
      </div>
      <button onclick="document.getElementById('modal-post-factura').remove()" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;border-radius:10px;padding:9px;font-size:0.82rem;cursor:pointer;">
        Cerrar
      </button>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function descargarFacturaDelHistorial(id) {
  if (id) compartirDocWA(id);
}

// Llamar al server para enviar factura por WhatsApp al cliente
async function enviarFacturaPorWA(facturaId) {
  if (!confirm('¿Enviar la factura por WhatsApp al cliente?')) return;
  toast('Enviando por WhatsApp…', 'info');
  try {
    const r = await fetch(`/api/facturas/${facturaId}/enviar-wa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'falló envío');
    toast(`✅ Enviada por WA a ${data.telefono} (instancia ${data.instance})`, 'success');
    document.getElementById('modal-post-factura')?.remove();
  } catch (e) {
    console.error('[wa send]', e);
    toast('Error al enviar por WA: ' + e.message, 'error');
  }
}

async function compartirDocWA(id) {
  const d = docHistorial.find(x => x.id === id);
  if (!d) return;
  const tipo   = d.tipo === 'cotizacion' ? 'Cotización' : 'Factura';
  const nombre = `${tipo} #${d.numero} - ${d.cliente}.pdf`;

  toast('Generando PDF...', 'info');

  try {
    const htmlDoc = buildDocHTML(d);

    // Renderizar en iframe oculto para que html2pdf capture bien
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px;height:1200px;border:none;background:white;';
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(htmlDoc);
    iframe.contentDocument.close();

    await new Promise(r => setTimeout(r, 1000)); // esperar renderizado

    const opt = {
      margin:      [8, 8, 8, 8],
      filename:    nombre,
      image:       { type: 'jpeg', quality: 0.97 },
      html2canvas: { scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#ffffff', logging: false },
      jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' },
    };

    const pdfBlob = await html2pdf()
      .set(opt)
      .from(iframe.contentDocument.body)
      .outputPdf('blob');

    document.body.removeChild(iframe);

    // Celular: compartir como PDF directo (abre WhatsApp)
    if (navigator.canShare) {
      const pdfFile = new File([pdfBlob], nombre, { type: 'application/pdf' });
      if (navigator.canShare({ files: [pdfFile] })) {
        await navigator.share({ files: [pdfFile], title: nombre });
        return;
      }
    }

    // PC: descargar PDF
    const url = URL.createObjectURL(pdfBlob);
    const a   = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('PDF descargado', 'success');

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      toast('Error al generar PDF', 'error');
    }
  }
}

// ── Pendientes WeTransfer ─────────────────────────────────────
async function cargarPendientesWT() {
  try {
    const r = await fetch('/api/pendientes-wt');
    const data = await r.json();
    const panel = document.getElementById('panel-pendientes-wt');
    const lista = document.getElementById('lista-pendientes-wt');
    const ts    = document.getElementById('pendientes-wt-ts');
    if (!panel || !lista) return;

    if (!data.pendientes || data.pendientes.length === 0) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    if (ts && data.ts) {
      const fecha = new Date(data.ts);
      ts.textContent = 'Última verificación: ' + fecha.toLocaleString('es-CO', { hour:'2-digit', minute:'2-digit', day:'numeric', month:'short' });
    }

    lista.innerHTML = data.pendientes.map(p => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(239,68,68,0.05);border-radius:6px;border:1px solid rgba(239,68,68,0.15);">
        <span style="font-size:0.75rem;">📄</span>
        <span style="font-size:0.8rem;color:var(--text);flex:1;">${p.nombre}</span>
        <span style="font-size:0.7rem;color:var(--text-muted);">${p.fecha || ''}</span>
      </div>
    `).join('');
  } catch(e) {}
}

// Hook showSection — un solo hook consolidado para sincronizar datos al abrir secciones
(function() {
  const _orig = showSection;
  showSection = function(id, navEl) {
    _orig(id, navEl);
    if (id === 'cotizaciones') { cargarDocsServidor(); renderDocHistorial(); }
    if (id === 'arreglos')     { sincronizarArreglosServidor(); }
    if (id === 'satelites')    { sincronizarSatelitesServidor(); }
    if (id === 'wetransfer')   { cargarWT(); cargarPendientesWT(); }
    if (id === 'calandra')     { sincronizarCalandraServidor(); }
  };
})();

// Sync inicial con servidor para todos los módulos
setTimeout(cargarDocsServidor, 1500);
setTimeout(sincronizarArreglosServidor, 2000);
setTimeout(sincronizarSatelitesServidor, 2500);
setTimeout(cargarPendientesWT, 3000);

/* ─── MODOS DE ENTORNO (SPA) ──────────────────────────────────── */

let tvScrollInterval = null;
let tvRefreshInterval = null;

function renderTVLista() {
  const cont = document.getElementById('tv-lista');
  if (!cont) return;
  const activos = pedidos.filter(p => p.estado !== 'enviado-final');

  cont.innerHTML = `
    <div style="color:var(--text-muted);font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:3px;margin-bottom:16px;">
      ⟳ Estado de todos los pedidos activos — ${activos.length} pedidos
    </div>
  ` + activos.map(p => {
    const curIdx = TL_ORDER.indexOf(p.estado);
    const arregloIdx = TL_ORDER.indexOf('arreglo');
    const steps = TL_ETAPAS.map((etapa, i) => {
      let cls = '';
      if (etapa.key === 'arreglo') {
        if (p.arreglo && p.estado === 'calidad') cls = 'active';
        else if (p.arreglo && curIdx > arregloIdx) cls = 'done';
        else if (curIdx > arregloIdx) cls = 'done';
      } else {
        if (i < arregloIdx) {
          if (i < curIdx) cls = 'done';
          if (i === curIdx) cls = 'active';
        } else if (i > arregloIdx) {
          const realI = i - 1;
          if (realI < curIdx) cls = 'done';
          if (realI === curIdx) cls = 'active';
        }
      }
      return `<div class="tl-step ${cls}"><div class="tl-dot"></div><div class="tl-label">${etapa.label}</div></div>`;
    }).join('');

    const fechaTxt = p.fechaEntrega ? fmtFecha(p.fechaEntrega) : '';
    const itemsTxt = p.items && p.items.length ? p.items.map(i => esc(i.prenda)).join(', ') : '';

    return `
      <div style="display:flex;align-items:center;gap:16px;padding:14px 20px;background:var(--card-bg);border:1px solid rgba(255,255,255,0.06);border-radius:10px;margin-bottom:8px;">
        <div style="font-size:0.75rem;color:var(--text-muted);font-weight:700;min-width:40px;">#${p.id}</div>
        <div style="font-size:0.95rem;font-weight:700;color:var(--text);min-width:160px;">${esc(p.equipo || p.telefono)}</div>
        <div style="flex:1;"><div class="timeline-bar">${steps}</div></div>
        <div style="display:flex;align-items:center;gap:12px;min-width:200px;justify-content:flex-end;">
          <span style="font-size:0.78rem;color:var(--text-muted);">${esc(p.vendedora || '—')}</span>
          ${itemsTxt ? `<span style="font-size:0.72rem;color:var(--text-muted);opacity:0.7;">${esc(itemsTxt)}</span>` : ''}
          ${fechaTxt ? `<span style="font-size:0.75rem;color:var(--accent2);font-weight:600;">📅 ${fechaTxt}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function activarModoTV() {
  document.body.classList.add('modo-tv');
  showSection('torre-tv', null);

  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(e => console.log(e));
  }

  // Reloj
  setInterval(() => {
    const d = new Date();
    document.getElementById('reloj-tv').textContent = d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true});
  }, 1000);

  // Render inicial
  renderTVLista();

  // Auto-scroll suave vertical (muy lento, tipo pantalla aeropuerto)
  const wrapper = document.querySelector('.tv-scroll-wrapper');
  let scrollDir = 1;
  if (tvScrollInterval) clearInterval(tvScrollInterval);
  tvScrollInterval = setInterval(() => {
    wrapper.scrollTop += scrollDir * 0.3;
    if (wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 2) {
      scrollDir = -1;
    }
    if (wrapper.scrollTop <= 0) {
      scrollDir = 1;
    }
  }, 40);

  // Refrescar datos cada 60s
  if (tvRefreshInterval) clearInterval(tvRefreshInterval);
  tvRefreshInterval = setInterval(() => {
    fetch('/api/pedidos').then(r => r.json()).then(d => {
      pedidos = d.pedidos || d;
      renderTVLista();
    }).catch(() => {});
  }, 60000);
}

function salirDeModos() {
  if (tvScrollInterval) { clearInterval(tvScrollInterval); tvScrollInterval = null; }
  if (tvRefreshInterval) { clearInterval(tvRefreshInterval); tvRefreshInterval = null; }
  document.body.classList.remove('modo-miniapp');
  document.body.classList.remove('modo-tv');
  if (window.innerWidth <= 768) {
    window.location.hash = '#/movil';
    showSection('mobile-role-hub', null);
  } else {
    showSection('tablero-principal', document.querySelector('[onclick*="tablero-principal"]'));
  }
  const btn = document.getElementById('btn-salir-miniapp');
  if (btn) btn.style.display = 'none';
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(e => console.log(e));
  }
}

function modoMiniApp(seccion) {
  document.body.classList.add('modo-miniapp');
  // Inyectar o mostrar botón de salir
  let btn = document.getElementById('btn-salir-miniapp');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'btn-salir-miniapp';
    btn.className = 'btn-salir-miniapp';
    btn.innerHTML = '← Regresar al Inicio';
    btn.onclick = salirDeModos;
    document.body.appendChild(btn);
  }
  btn.style.display = 'block';
}

// Al inicio de la aplicación verificamos si hay algún Hash
window.addEventListener('DOMContentLoaded', () => {
  registrarPWA();
  // Renderizar inmediatamente el Tablero principal y la Torre con lo que haya en localStorage
  if (typeof renderTableroPrincipal === 'function') {
    try { renderTableroPrincipal(); } catch (e) { console.error('[tab-principal init]', e); }
  }
  if (typeof renderTorreUnificada === 'function') {
    try { renderTorreUnificada(); } catch (e) { console.error('[torre-unif init]', e); }
  }
  // Restaurar filtro de diseñador
  const selDis = document.getElementById('sel-dis-filtro');
  if (selDis) selDis.value = _tabPrincipalDisFiltro || 'todos';
  const hash = window.location.hash;
  if(hash === '#/ventas') {
    localStorage.setItem('ws_mobile_last_role', 'ventas');
    modoMiniApp('bandeja');
    showSection('bandeja', document.querySelector('[onclick*="bandeja"]'));
  } else if(hash === '#/diseno') {
    localStorage.setItem('ws_mobile_last_role', 'diseno');
    modoMiniApp('diseno');
    showSection('diseno', document.querySelector('[onclick*="diseno"]'));
  } else if(hash === '#/produccion') {
    localStorage.setItem('ws_mobile_last_role', 'produccion');
    modoMiniApp('produccion');
    showSection('produccion', document.querySelector('[onclick*="produccion"]'));
  } else if(hash === '#/satelites') {
    localStorage.setItem('ws_mobile_last_role', 'satelites');
    miniCosturaVistaPersonal = false;
    miniCosturaPersona = 'todas';
    modoMiniApp('satelites');
    showSection('satelites', document.querySelector('[onclick*="satelites"]'));
  } else if(hash.startsWith('#/costura/')) {
    const costurera = costureraDesdeSlug(hash.split('/').pop());
    if (costurera) {
      miniCosturaPersona = costurera;
      miniCosturaVistaPersonal = true;
      localStorage.setItem('ws_mini_costura_persona', costurera);
      localStorage.setItem('ws_mobile_last_role', `costura-${slugCosturera(costurera)}`);
      modoMiniApp('satelites');
      showSection('satelites', null);
    } else {
      showSection('mobile-role-hub', null);
    }
  } else if(hash === '#/movil') {
    showSection('mobile-role-hub', null);
  } else if(hash === '#/mi-dia') {
    showSection('mi-dia', null);
    if (typeof renderMiDia === 'function') renderMiDia();
  } else if(hash === '#/tv') {
    activarModoTV();
  } else {
    // Cualquiera (PC o móvil) que esté identificado entra directo a su Mi Día.
    // Si NO está identificado: en móvil va al hub, en PC abre el selector de persona.
    const slugIdent = (window.WS_PERSONA && window.WS_PERSONA.slug) || localStorage.getItem('ws_persona');
    if (slugIdent) {
      window.location.hash = '#/mi-dia';
      showSection('mi-dia', null);
      if (typeof renderMiDia === 'function') renderMiDia();
    } else if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
      showSection('mobile-role-hub', null);
    } else {
      // PC sin identificar: deja el tablero por default + abre selector automaticamente
      setTimeout(() => { if (typeof abrirSelectorPersona === 'function') abrirSelectorPersona(); }, 500);
    }
  }
});

/* ════════════════════════════════════════════════════════════════
   TORRE DE CONTROL — vista única con KPIs, ventas por vendedora y alertas
════════════════════════════════════════════════════════════════ */

const VENDEDORAS_COLORS = {
  'Betty':    '#fb923c',
  'Ney':      '#34d399',
  'Wendy':    '#60a5fa',
  'Paola':    '#f472b6',
  'Graciela': '#c4b5fd'
};

function _kpiCard(label, value, color, sub) {
  return '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:18px;min-width:130px;flex:1;">' +
    '<div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">' + esc(label) + '</div>' +
    '<div style="font-family:Outfit,sans-serif;font-size:2.2rem;font-weight:800;color:' + color + ';line-height:1;">' + value + '</div>' +
    (sub ? '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px;">' + sub + '</div>' : '') +
    '</div>';
}

function _semaforoCard(p, motivo, nivel) {
  const colorBg = nivel === 'rojo' ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.10)';
  const colorBorder = nivel === 'rojo' ? 'rgba(239,68,68,0.35)' : 'rgba(245,158,11,0.35)';
  const colorText = nivel === 'rojo' ? '#fca5a5' : '#fbbf24';
  return '<div onclick="irAlPedido(' + p.id + ')" style="background:' + colorBg + ';border:1px solid ' + colorBorder + ';border-radius:8px;padding:10px 14px;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
    '<div><div style="font-weight:600;font-size:0.88rem;">#' + p.id + ' ' + esc(p.equipo || p.telefono || 'Sin equipo') + '</div>' +
    '<div style="font-size:0.72rem;color:var(--text-muted);">' + esc(p.vendedora || '—') + ' · ' + (ESTADO_LABELS[p.estado] || p.estado) + '</div></div>' +
    '<div style="font-size:0.74rem;color:' + colorText + ';font-weight:600;text-align:right;flex-shrink:0;">' + motivo + '</div>' +
    '</div>';
}

function _calcularAlertas() {
  const alertas = [];
  const ahora = Date.now();
  (pedidos || []).forEach(p => {
    if (p.estado === 'enviado-final') return;
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    const horas = (ahora - t) / (1000 * 60 * 60);
    if (p.estado === 'hacer-diseno' && horas > 24) {
      alertas.push({ p, motivo: Math.floor(horas) + 'h sin avanzar', nivel: horas > 48 ? 'rojo' : 'amarillo' });
    } else if (p.estado === 'confirmado' && horas > 48) {
      alertas.push({ p, motivo: Math.floor(horas) + 'h esperando PDF/WT', nivel: 'rojo' });
    } else if (p.estado === 'enviado-calandra' && horas > 72) {
      alertas.push({ p, motivo: Math.floor(horas) + 'h en calandra', nivel: 'rojo' });
    } else if ((p.estado === 'hacer-diseno' || p.estado === 'confirmado') && !p.disenadorAsignado && horas > 12) {
      alertas.push({ p, motivo: Math.floor(horas) + 'h sin diseñador', nivel: 'amarillo' });
    }
  });
  alertas.sort((a, b) => (a.nivel === 'rojo' ? -1 : 1) - (b.nivel === 'rojo' ? -1 : 1));
  return alertas;
}

function renderTorreControl() {
  const cont = document.getElementById('torre-content');
  if (!cont) return;

  const todos = pedidos || [];
  const activos = todos.filter(p => p.estado !== 'enviado-final');

  const cnt = {
    bandeja: activos.filter(p => p.estado === 'bandeja').length,
    hacerDiseno: activos.filter(p => p.estado === 'hacer-diseno').length,
    confirmado: activos.filter(p => p.estado === 'confirmado').length,
    calandra: activos.filter(p => p.estado === 'enviado-calandra').length,
    impresion: activos.filter(p => p.estado === 'llego-impresion').length,
    corte: activos.filter(p => p.estado === 'corte').length,
    calidad: activos.filter(p => p.estado === 'calidad').length,
    costura: activos.filter(p => ['costura','en-satelite'].includes(p.estado)).length,
    listo: activos.filter(p => p.estado === 'listo').length,
  };

  const haceSemana = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const ventasSemana = {};
  todos.forEach(p => {
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    if (t < haceSemana) return;
    if (!['hacer-diseno', 'confirmado', 'enviado-calandra', 'llego-impresion', 'corte', 'costura', 'en-satelite', 'calidad', 'listo', 'enviado-final'].includes(p.estado)) return;
    const v = p.vendedora || 'Sin asignar';
    ventasSemana[v] = (ventasSemana[v] || 0) + 1;
  });

  const alertas = _calcularAlertas();

  let html = '';
  // KPIs
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;">';
  html += _kpiCard('Cotizaciones', cnt.bandeja, '#fde047', 'Sin pagar');
  html += _kpiCard('Hacer Diseño', cnt.hacerDiseno, '#fb923c', 'Esperando arte');
  html += _kpiCard('Confirmado', cnt.confirmado, '#a78bfa', 'Esperando PDF+WT');
  html += _kpiCard('Calandra', cnt.calandra, '#67e8f9', 'En impresión');
  html += _kpiCard('Producción', cnt.impresion + cnt.corte + cnt.costura + cnt.calidad, '#34d399', 'Corte/costura/revision');
  html += _kpiCard('Listos', cnt.listo, '#22c55e', 'Para entregar');
  html += '</div>';

  // Ventas por vendedora
  html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:18px;margin-bottom:24px;">';
  html += '<div style="font-family:Outfit,sans-serif;font-size:1rem;font-weight:700;margin-bottom:14px;">📈 Ventas esta semana (últimos 7 días)</div>';
  const totalSem = Object.values(ventasSemana).reduce((s, x) => s + x, 0);
  if (totalSem === 0) {
    html += '<div style="color:var(--text-muted);font-size:0.85rem;">Sin ventas registradas en los últimos 7 días.</div>';
  } else {
    Object.entries(ventasSemana).sort((a, b) => b[1] - a[1]).forEach(([v, n]) => {
      const color = VENDEDORAS_COLORS[v] || '#94a3b8';
      const pct = Math.round(n / totalSem * 100);
      html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">' +
        '<div style="min-width:90px;font-weight:600;color:' + color + ';">' + esc(v) + '</div>' +
        '<div style="flex:1;height:14px;background:rgba(255,255,255,0.04);border-radius:7px;overflow:hidden;">' +
        '<div style="height:100%;width:' + pct + '%;background:' + color + ';opacity:0.8;"></div></div>' +
        '<div style="font-family:Outfit,sans-serif;font-weight:700;color:' + color + ';min-width:60px;text-align:right;">' + n + ' <span style="font-size:0.7rem;opacity:0.6;">(' + pct + '%)</span></div>' +
        '</div>';
    });
  }
  html += '</div>';

  // Alertas
  html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:18px;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">';
  html += '<div style="font-family:Outfit,sans-serif;font-size:1rem;font-weight:700;">🚨 Pedidos atascados</div>';
  html += '<div style="font-size:0.78rem;color:var(--text-muted);">' + alertas.length + ' ' + (alertas.length === 1 ? 'alerta' : 'alertas') + '</div>';
  html += '</div>';
  if (alertas.length === 0) {
    html += '<div style="color:#22c55e;font-size:0.88rem;">✅ Todo fluyendo bien — sin pedidos atascados.</div>';
  } else {
    alertas.forEach(a => { html += _semaforoCard(a.p, a.motivo, a.nivel); });
  }
  html += '</div>';

  cont.innerHTML = html;

  const badge = document.getElementById('badge-torre');
  if (badge) badge.textContent = alertas.length;
}

// Refrescar badge de Torre cuando cambian los pedidos
function _actualizarBadgeTorre() {
  try {
    const alertas = _calcularAlertas();
    const badge = document.getElementById('badge-torre');
    if (badge) badge.textContent = alertas.length;
  } catch {}
}

/* ════════════════════════════════════════════════════════════════
   📸 LECTOR DEL TABLERO — foto del tablero físico → Gemini → pedidos
════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════
   📋 TABLERO PRINCIPAL — vista de 4 columnas igual al tablero físico
════════════════════════════════════════════════════════════════ */

// Mapeo estado app → columna del tablero físico
const TAB_PRINCIPAL_MAP = {
  'bandeja':           { col: 'hacer-disenos', orden: 0 },
  'hacer-diseno':      { col: 'ventas',        orden: 0 },
  'confirmado':        { col: 'aprobados',     orden: 0, badge: null },
  'enviado-calandra':  { col: 'produccion',    orden: 0, badge: { texto: '📦 calandra',  clase: 'sub-calandra'  } },
  'llego-impresion':   { col: 'produccion',    orden: 1, badge: { texto: '🖨️ impresión', clase: 'sub-impresion' } },
  'corte':             { col: 'produccion',    orden: 2, badge: { texto: '✂️ corte',     clase: 'sub-calidad'   } },
  'costura':           { col: 'produccion',    orden: 3, badge: { texto: '🪡 costura',   clase: 'sub-listo'     } },
  'en-satelite':       { col: 'produccion',    orden: 4, badge: { texto: '🪡 en costura', clase: 'sub-listo'     } },
  'calidad':           { col: 'produccion',    orden: 5, badge: { texto: '🔍 revision',  clase: 'sub-calidad'   } },
  'listo':             { col: 'produccion',    orden: 6, badge: { texto: '✅ listo',     clase: 'sub-listo'     } },
  'enviado-final':     { col: 'enviados',      orden: 0 },
};
var _tabPrincipalFiltro = '';
var _tabPrincipalDisFiltro = localStorage.getItem('ws_tab_dis_filtro') || 'todos';

function workerCarga(activos, nombre) {
  const worker = WORKERS.find(w => w.nombre === nombre);
  const aliases = (worker && worker.aliases ? worker.aliases : [nombre])
    .map(x => String(x || '').toLowerCase());
  const matches = value => aliases.some(a => String(value || '').toLowerCase().includes(a));
  const n = aliases[0] || '';
  const venta = activos.filter(p => matches(p.vendedora)).length;
  const diseno = activos.filter(p => matches(p.disenadorAsignado)).length;
  const costura = activos.filter(p => matches(p.satelite)).length;
  let produccion = 0;
  if (['betty', 'lidermeyer'].includes(n)) {
    produccion = activos.filter(p => ['enviado-calandra','llego-impresion','corte','costura','en-satelite','calidad'].includes(p.estado)).length;
  }
  const admin = ['graciela', 'camilo', 'duvan'].includes(n)
    ? activos.filter(p => p.estado !== 'enviado-final').length
    : 0;
  return { venta, diseno, costura, produccion, admin, total: venta + diseno + costura + produccion + admin };
}

function renderWorkerMonitor(activos) {
  return `
    <div class="torre-section">
      <div class="torre-section-title">Equipo y responsabilidades</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">
        ${WORKERS.map(w => {
          const c = workerCarga(activos, w.nombre);
          const partes = [];
          if (w.roles.includes('ventas')) partes.push(`Ventas ${c.venta}`);
          if (w.roles.includes('diseno')) partes.push(`Diseno ${c.diseno}`);
          if (w.roles.includes('produccion')) partes.push(`Produccion ${c.produccion}`);
          if (w.roles.includes('costura') || w.roles.includes('costura-personal')) partes.push(`Costura ${c.costura}`);
          if (w.roles.includes('admin')) partes.push(`Admin ${c.admin}`);
          return `<div style="background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px;">
            <div style="font-family:Outfit,sans-serif;font-weight:800;margin-bottom:6px;">${esc(w.nombre)}</div>
            <div style="font-size:.72rem;color:var(--text-muted);line-height:1.55;">${partes.join(' · ') || 'Sin carga'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function filtrarTableroPrincipal(q) {
  _tabPrincipalFiltro = String(q || '').trim().toLowerCase();
  renderTableroPrincipal();
}

function filtrarTableroPorDisenador(dis) {
  _tabPrincipalDisFiltro = dis || 'todos';
  localStorage.setItem('ws_tab_dis_filtro', _tabPrincipalDisFiltro);
  renderTableroPrincipal();
}

/* ════════════════════════════════════════════════════════════════
   🗼 TORRE DE CONTROL UNIFICADA — KPIs + alertas + pipeline + ranking
════════════════════════════════════════════════════════════════ */

function renderTorreUnificada() {
  try {
  const cont = document.getElementById('torre-unificada-content');
  if (!cont) return;
  const lista = Array.isArray(pedidos) ? pedidos : [];
  const ahora = Date.now();
  const hace30 = ahora - 30 * 86400000;
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);

  // Solo pedidos con movimiento últimos 30d (ignora zombies)
  const activos = lista.filter(p => {
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    return t >= hace30;
  });

  // KPIs por estado
  const enDiseno = activos.filter(p => ['bandeja', 'hacer-diseno'].includes(p.estado)).length;
  const enProduccion = activos.filter(p => ['confirmado', 'enviado-calandra', 'llego-impresion', 'corte', 'costura', 'en-satelite', 'calidad'].includes(p.estado)).length;
  const listos = activos.filter(p => p.estado === 'listo').length;
  const entregadosHoy = activos.filter(p => {
    if (p.estado !== 'enviado-final') return false;
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    return t >= new Date().setHours(0,0,0,0);
  }).length;
  const totalActivos = activos.filter(p => p.estado !== 'enviado-final').length;

  // Alertas
  const alertas = [];
  activos.forEach(p => {
    if (p.estado === 'enviado-final') return;
    // Vencidos
    if (p.fechaEntrega) {
      const dias = Math.ceil((new Date(p.fechaEntrega).getTime() - ahora) / 86400000);
      if (dias < 0) alertas.push({ nivel: 'rojo', tipo: 'vencido', p, txt: 'VENCIDO ' + Math.abs(dias) + 'd' });
      else if (dias <= 2) alertas.push({ nivel: 'naranja', tipo: 'urgente', p, txt: 'Entrega en ' + dias + 'd' });
    }
    // Sin movimiento +7d
    const dSinMov = Math.round((ahora - new Date(p.ultimoMovimiento).getTime()) / 86400000);
    if (dSinMov >= 7) alertas.push({ nivel: dSinMov >= 14 ? 'rojo' : 'naranja', tipo: 'parado', p, txt: dSinMov + 'd sin moverse' });
    // Sin diseñador
    if (!p.disenadorAsignado && p.estado !== 'bandeja') alertas.push({ nivel: 'amarillo', tipo: 'sin-dis', p, txt: 'Sin diseñador asignado' });
  });
  // Top 8 alertas, priorizar rojas
  alertas.sort((a, b) => {
    const peso = { rojo: 0, naranja: 1, amarillo: 2 };
    return peso[a.nivel] - peso[b.nivel];
  });
  const topAlertas = alertas.slice(0, 8);

  // Pipeline counts (4 columnas tablero)
  const pipeline = {
    hd: activos.filter(p => p.estado === 'bandeja').length,
    v: activos.filter(p => p.estado === 'hacer-diseno').length,
    a: activos.filter(p => p.estado === 'confirmado').length,
    e: activos.filter(p => ['enviado-calandra', 'llego-impresion', 'corte', 'costura', 'en-satelite', 'calidad', 'listo', 'enviado-final'].includes(p.estado)).length,
  };

  // Ranking vendedoras (ventas este mes — pedidos creados en hacer-diseno o más allá)
  const ranking = {};
  lista.forEach(p => {
    if (!p.creadoEn) return;
    let t = 0;
    const m = String(p.creadoEn).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) t = new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1])).getTime();
    else t = new Date(p.creadoEn).getTime();
    if (isNaN(t) || t < inicioMes.getTime()) return;
    if (p.estado === 'bandeja') return; // solo ventas confirmadas
    const v = p.vendedora || 'Sin asignar';
    ranking[v] = (ranking[v] || 0) + 1;
  });
  const rankArr = Object.entries(ranking).sort((a, b) => b[1] - a[1]);
  const maxRank = rankArr[0] ? rankArr[0][1] : 1;

  // HTML
  let html = '';
  // KPIs
  html += '<div class="torre-kpis">';
  html += kpiCard('📊', totalActivos, 'Activos', '#c4b5fd');
  html += kpiCard('🎨', enDiseno, 'En diseño', '#7dd3fc');
  html += kpiCard('🏭', enProduccion, 'En producción', '#fcd34d');
  html += kpiCard('✅', listos, 'Listos', '#86efac');
  html += kpiCard('📦', entregadosHoy, 'Entregados hoy', '#f9a8d4');
  html += '</div>';

  html += renderWorkerMonitor(activos);

  // Alertas
  html += '<div class="torre-section">';
  html += '<div class="torre-section-title">🚨 Alertas (' + alertas.length + ')</div>';
  if (!topAlertas.length) {
    html += '<div class="torre-empty">✅ Sin alertas — todo en orden</div>';
  } else {
    topAlertas.forEach(a => {
      const colorEmoji = a.nivel === 'rojo' ? '🔴' : a.nivel === 'naranja' ? '🟠' : '🟡';
      html += '<div class="torre-alerta" onclick="abrirDetallePedido(' + a.p.id + ')">';
      html += '<span class="torre-alerta-emoji">' + colorEmoji + '</span>';
      html += '<span class="torre-alerta-eq">#' + a.p.id + ' ' + esc(a.p.equipo || a.p.telefono || 'Sin equipo') + '</span>';
      html += '<span class="torre-alerta-meta">' + esc(a.txt) + '</span>';
      html += '</div>';
    });
    if (alertas.length > 8) {
      html += '<div style="font-size:0.72rem;color:var(--text-muted);text-align:center;margin-top:8px;">... y ' + (alertas.length - 8) + ' alertas más</div>';
    }
  }
  html += '</div>';

  // Pipeline
  html += '<div class="torre-section">';
  html += '<div class="torre-section-title">📈 Pipeline de producción</div>';
  html += '<div class="torre-pipeline">';
  // Pipeline en orden cronologico (flujo del pedido en el tiempo)
  html += pipelineStep('COTIZACIONES', pipeline.hd, 'rgba(96,165,250,0.6)');
  html += pipelineArrow();
  html += pipelineStep('EN DISEÑO', pipeline.v, 'rgba(34,197,94,0.6)');
  html += pipelineArrow();
  html += pipelineStep('APROBADOS', pipeline.a, 'rgba(168,85,247,0.6)');
  html += pipelineArrow();
  html += pipelineStep('PRODUCCIÓN', pipeline.p || 0, 'rgba(251,146,60,0.6)');
  html += pipelineArrow();
  html += pipelineStep('ENTREGADOS', pipeline.e, 'rgba(148,163,184,0.6)');
  html += '</div></div>';

  // Ranking vendedoras
  html += '<div class="torre-section">';
  html += '<div class="torre-section-title">👥 Ventas este mes (' + inicioMes.toLocaleDateString('es-CO', { month: 'long' }) + ')</div>';
  if (!rankArr.length) {
    html += '<div class="torre-empty">Aún sin ventas este mes</div>';
  } else {
    rankArr.forEach(([nombre, count]) => {
      const pct = Math.round((count / maxRank) * 100);
      html += '<div class="torre-rank-row">';
      html += '<span class="torre-rank-nombre">' + esc(nombre) + '</span>';
      html += '<div class="torre-rank-barra"><div class="torre-rank-fill" style="width:' + pct + '%;"></div></div>';
      html += '<span class="torre-rank-count">' + count + '</span>';
      html += '</div>';
    });
  }
  html += '</div>';

  cont.innerHTML = html;

  // Badge sidebar = alertas pendientes
  const bd = document.getElementById('badge-torre-unif');
  if (bd) bd.textContent = alertas.length;

  } catch (e) {
    console.error('[torre-unificada] error', e);
  }
}

function kpiCard(icon, value, label, color) {
  return '<div class="torre-kpi">' +
    '<div class="torre-kpi-icon" style="color:' + color + ';">' + icon + '</div>' +
    '<div class="torre-kpi-val">' + value + '</div>' +
    '<div class="torre-kpi-label">' + label + '</div>' +
    '</div>';
}

function pipelineStep(label, count, color) {
  return '<div class="torre-pipe-step" style="border-color:' + color + ';">' +
    '<div class="torre-pipe-count">' + count + '</div>' +
    '<div class="torre-pipe-label">' + label + '</div>' +
    '</div>';
}

function pipelineArrow() {
  return '<div class="torre-pipe-arrow">→</div>';
}

function renderTableroPrincipal() {
  try {
  const cont = document.getElementById('tab-principal-content');
  if (!cont) return;
  // Orden CRONOLOGICO natural: se lee izquierda → derecha siguiendo el tiempo del pedido
  //   COTIZACIONES (cliente cotizo) → EN DISEÑO (pago, falta disenar) → APROBADOS (diseno OK)
  //   → PRODUCCION (calandra/corte/costura) → ENTREGADOS (cliente recibio)
  const cols = {
    'hacer-disenos': { titulo: 'COTIZACIONES',  clase: 'tab-col-hacer-disenos', items: [] },
    'ventas':        { titulo: 'EN DISEÑO',     clase: 'tab-col-ventas',        items: [] },
    'aprobados':     { titulo: 'APROBADOS',     clase: 'tab-col-aprobados',     items: [] },
    'produccion':    { titulo: 'PRODUCCIÓN',    clase: 'tab-col-produccion',    items: [] },
    'enviados':      { titulo: 'ENTREGADOS',    clase: 'tab-col-enviados',      items: [] },
  };
  const q = _tabPrincipalFiltro;
  const disFiltro = _tabPrincipalDisFiltro;
  const listaPedidos = Array.isArray(pedidos) ? pedidos : [];
  const hace30Dias = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let sinDisenador = 0;
  listaPedidos.forEach(p => {
    const m = TAB_PRINCIPAL_MAP[p.estado];
    if (!m) return;
    // Filtro 30 días: oculta pedidos viejos sin movimiento
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : Date.now();
    if (t < hace30Dias) return;
    // Filtro por diseñador
    const dis = String(p.disenadorAsignado || '').toLowerCase();
    if (disFiltro !== 'todos') {
      if (disFiltro === 'sin-asignar') {
        if (dis) return;
      } else if (dis !== disFiltro) return;
    }
    if (!dis && p.estado !== 'bandeja') sinDisenador++;
    // Búsqueda por texto
    if (q) {
      const haystack = (String(p.equipo || '') + ' ' + String(p.telefono || '') + ' ' + String(p.vendedora || '') + ' ' + String(p.disenadorAsignado || '')).toLowerCase();
      if (!haystack.includes(q)) return;
    }
    cols[m.col].items.push({ p, badge: m.badge || null, orden: m.orden });
  });
  // Ordenar: dentro de cada columna por urgencia (fecha entrega más cercana primero) + orden subestado
  Object.values(cols).forEach(c => c.items.sort((a, b) => {
    const fa = a.p.fechaEntrega ? new Date(a.p.fechaEntrega).getTime() : Infinity;
    const fb = b.p.fechaEntrega ? new Date(b.p.fechaEntrega).getTime() : Infinity;
    if (fa !== fb) return fa - fb;
    return (a.orden - b.orden) || ((b.p.ultimoMovimiento || '').localeCompare(a.p.ultimoMovimiento || ''));
  }));

  let html = '';
  // Banner si hay pedidos sin diseñador
  if (sinDisenador > 0 && disFiltro === 'todos') {
    html += '<div style="grid-column:1/-1;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.35);border-radius:8px;padding:10px 14px;margin-bottom:10px;color:#fca5a5;font-size:0.82rem;">';
    html += '⚠️ <strong>' + sinDisenador + '</strong> pedido(s) <strong>sin diseñador asignado</strong> — ';
    html += '<a href="#" onclick="filtrarTableroPorDisenador(\'sin-asignar\');document.getElementById(\'sel-dis-filtro\').value=\'sin-asignar\';return false;" style="color:#fca5a5;text-decoration:underline;">Ver solo esos</a>';
    html += '</div>';
  }
  for (const [, c] of Object.entries(cols)) {
    html += '<div class="tab-principal-col">';
    html += '<div class="tab-principal-col-header ' + c.clase + '">';
    html += '<span class="tab-principal-col-title">' + c.titulo + '</span>';
    html += '<span class="tab-principal-col-count">' + c.items.length + '</span>';
    html += '</div>';
    if (!c.items.length) {
      html += '<div class="tab-empty">—</div>';
    } else {
      c.items.forEach(({ p, badge }) => {
        const eq = esc(p.equipo || 'Sin nombre');
        const tel = p.telefono ? esc(String(p.telefono).trim()) : '';
        const dis = p.disenadorAsignado ? esc(p.disenadorAsignado) : '';
        const ven = p.vendedora ? esc(p.vendedora) : '';
        const sinDis = !dis && p.estado !== 'bandeja';
        // Urgencia: cuántos días faltan para fecha entrega
        let urgencia = '';
        let urgenciaClase = '';
        if (p.fechaEntrega) {
          const diasParaEntrega = Math.ceil((new Date(p.fechaEntrega).getTime() - Date.now()) / 86400000);
          if (diasParaEntrega < 0) { urgencia = '🚨 VENCIDO ' + Math.abs(diasParaEntrega) + 'd'; urgenciaClase = 'urgente-vencido'; }
          else if (diasParaEntrega <= 2) { urgencia = '🔥 ' + diasParaEntrega + 'd'; urgenciaClase = 'urgente-alta'; }
          else if (diasParaEntrega <= 5) { urgencia = '⏰ ' + diasParaEntrega + 'd'; urgenciaClase = 'urgente-media'; }
          else { urgencia = '📅 ' + diasParaEntrega + 'd'; urgenciaClase = ''; }
        }
        // Botón de acción rápida según el estado actual (1 toque, sin modal)
        const ACCIONES_RAPIDAS = {
          'enviado-calandra': { proximo: 'llego-impresion', texto: '✅ Llegó impresión', color: '#0ea5e9' },
          'llego-impresion':  { proximo: 'corte',           texto: '→ Pasar a corte', color: '#f97316' },
          'corte':            { proximo: 'costura',         texto: '→ Pasar a costura', color: '#a855f7' },
          'costura':          { proximo: 'calidad',         texto: '→ Pasar a revision', color: '#eab308' },
          'en-satelite':      { proximo: 'calidad',         texto: '→ Recibido / revision', color: '#eab308' },
          'calidad':          { proximo: 'listo',           texto: '✅ Revision OK', color: '#22c55e' },
          'listo':            { proximo: 'enviado-final',   texto: '📦 Entregado al cliente', color: '#16a34a' },
        };
        const accion = ACCIONES_RAPIDAS[p.estado];

        const sinNombre = !p.equipo || !p.equipo.trim();
        html += '<div class="tab-card ' + (sinDis ? 'tab-card-sin-dis' : '') + '" onclick="abrirDetallePedido(' + p.id + ')">';
        // Línea 1: nombre del equipo + lápiz para editar rápido
        html += '<div class="tab-card-eq-row">';
        if (sinNombre) {
          html += '<button class="tab-card-eq-vacio" onclick="event.stopPropagation(); editarNombreEquipoRapido(' + p.id + ')">✏️ Ponerle nombre</button>';
        } else {
          html += '<div class="tab-card-eq">' + eq + '</div>';
          html += '<button class="tab-card-eq-edit" onclick="event.stopPropagation(); editarNombreEquipoRapido(' + p.id + ')" title="Editar nombre">✏️</button>';
        }
        html += '</div>';
        // Línea 2: teléfono (si tiene)
        if (tel) html += '<div class="tab-card-tel">📞 ' + tel + '</div>';
        // Línea 3: vendedora + diseñador
        html += '<div class="tab-card-personas">';
        if (ven) html += '<span class="tab-card-ven">🛍️ ' + ven + '</span>';
        if (dis) html += '<span class="tab-card-dis">🎨 ' + dis + '</span>';
        else if (sinDis) html += '<span class="tab-card-sindis">⚠️ sin diseñador</span>';
        html += '</div>';
        // Línea 4: badges (sub-estado producción + urgencia)
        if (badge || urgencia) {
          html += '<div class="tab-card-badges">';
          if (badge) html += '<span class="tab-card-badge ' + badge.clase + '">' + badge.texto + '</span>';
          if (urgencia) html += '<span class="tab-card-badge ' + urgenciaClase + '">' + urgencia + '</span>';
          html += '</div>';
        }
        // Línea 5: BOTÓN DE ACCIÓN RÁPIDA (solo en producción + listo)
        if (accion) {
          html += '<button class="tab-card-accion" style="background:' + accion.color + ';" ' +
                  'onclick="event.stopPropagation(); avanzarRapidoTablero(' + p.id + ', \'' + accion.proximo + '\', \'' + accion.texto.replace(/'/g, "\\'") + '\')">' +
                  accion.texto + '</button>';
        }
        html += '</div>';
      });
    }
    html += '</div>';
  }
  cont.innerHTML = html;
  // Badge sidebar
  const total = Object.values(cols).reduce((a, c) => a + c.items.length, 0);
  const bd = document.getElementById('badge-tab-principal');
  if (bd) bd.textContent = total;
  } catch (e) {
    console.error('[tablero-principal] render error', e);
  }
}

// Etapas del flujo (orden secuencial) y nombres legibles
const ETAPAS_FLUJO = [
  { id: 'bandeja',          label: 'Cotización' },
  { id: 'hacer-diseno',     label: 'Hacer diseño (Venta)' },
  { id: 'confirmado',       label: 'Aprobado (Diseño OK)' },
  { id: 'enviado-calandra', label: 'Enviado a calandra' },
  { id: 'llego-impresion',  label: 'Llegó impresión' },
  { id: 'corte',            label: 'Corte' },
  { id: 'costura',          label: 'Costura' },
  { id: 'en-satelite',      label: 'En costura' },
  { id: 'calidad',          label: 'Revision final' },
  { id: 'listo',            label: 'Listo' },
  { id: 'enviado-final',    label: 'Entregado al cliente' },
];

function siguienteEtapa(estadoActual) {
  const i = ETAPAS_FLUJO.findIndex(e => e.id === estadoActual);
  if (i < 0 || i >= ETAPAS_FLUJO.length - 1) return null;
  return ETAPAS_FLUJO[i + 1];
}

function etapaActualLabel(estado) {
  const e = ETAPAS_FLUJO.find(x => x.id === estado);
  return e ? e.label : estado;
}

// Modal de DETALLE de pedido (no completar). Muestra info + acciones rápidas.
function abrirDetallePedido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  // Eliminar modal previo
  const existente = document.getElementById('modal-detalle-pedido');
  if (existente) existente.remove();

  const siguiente = siguienteEtapa(p.estado);
  const tel = p.telefono ? esc(p.telefono) : '—';
  const ven = p.vendedora ? esc(p.vendedora) : 'Sin asignar';
  const DISENADORES = ['Camilo', 'Oscar', 'Wendy', 'Ney', 'Paola', 'Betty'];
  const disHTML = p.disenadorAsignado
    ? '🎨 ' + esc(p.disenadorAsignado) + ' <button onclick="cambiarDisenadorDetalle(' + p.id + ')" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:0.7rem;margin-left:4px;">✎</button>'
    : '<select id="dis-asignar-' + p.id + '" style="width:100%;background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;padding:6px 8px;border-radius:6px;font-size:0.8rem;margin-top:2px;"><option value="">🎨 Asignar diseñador…</option>' + DISENADORES.map(d => '<option value="' + d + '">' + d + '</option>').join('') + '</select>'
      + '<button onclick="asignarDisenadorDesdeDetalle(' + p.id + ')" style="margin-top:6px;width:100%;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:white;border:none;padding:7px;border-radius:6px;font-size:0.78rem;font-weight:600;cursor:pointer;">Confirmar diseñador</button>';
  const fechaEntrega = p.fechaEntrega ? esc(p.fechaEntrega) : 'Sin fecha';
  const notas = p.notas ? esc(p.notas) : '';
  const items = Array.isArray(p.items) && p.items.length
    ? p.items.map(i => esc(typeof i === 'string' ? i : [i.prenda, i.tela].filter(Boolean).join(' · '))).join(', ')
    : 'Sin prendas registradas';

  // Urgencia
  let urgencia = '';
  if (p.fechaEntrega) {
    const dParaEntrega = Math.ceil((new Date(p.fechaEntrega).getTime() - Date.now()) / 86400000);
    if (dParaEntrega < 0) urgencia = '<span style="color:#fca5a5;font-weight:700;">🚨 Vencido hace ' + Math.abs(dParaEntrega) + ' días</span>';
    else if (dParaEntrega <= 2) urgencia = '<span style="color:#fca5a5;font-weight:600;">🔥 Faltan ' + dParaEntrega + ' días</span>';
    else if (dParaEntrega <= 5) urgencia = '<span style="color:#fcd34d;">⏰ Faltan ' + dParaEntrega + ' días</span>';
    else urgencia = '<span style="color:var(--text-muted);">📅 Faltan ' + dParaEntrega + ' días</span>';
  }

  // ── Hero info (urgencia o estado destacado) ──
  const heroBg = p.fechaEntrega
    ? (() => {
        const dDays = Math.ceil((new Date(p.fechaEntrega).getTime() - Date.now()) / 86400000);
        if (dDays < 0)  return 'linear-gradient(135deg,rgba(239,68,68,0.25),rgba(220,38,38,0.1))';
        if (dDays <= 2) return 'linear-gradient(135deg,rgba(245,158,11,0.22),rgba(202,138,4,0.08))';
        return 'linear-gradient(135deg,rgba(34,197,94,0.16),rgba(22,163,74,0.06))';
      })()
    : 'linear-gradient(135deg,rgba(124,58,237,0.16),rgba(76,29,149,0.06))';

  const heroTxt = p.fechaEntrega
    ? '<div style="font-size:0.66rem;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,0.55);font-weight:700;">Entrega</div>'
      + '<div style="font-family:Outfit,sans-serif;font-size:1.35rem;font-weight:800;margin-top:2px;">' + fmtFecha(p.fechaEntrega) + '</div>'
      + (urgencia ? '<div style="margin-top:4px;font-size:0.85rem;">' + urgencia + '</div>' : '')
    : '<div style="font-size:0.66rem;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,0.55);font-weight:700;">Sin fecha de entrega</div>'
      + '<div style="font-size:0.8rem;color:rgba(255,255,255,0.55);margin-top:4px;">Edita los datos para poner una fecha.</div>';

  const montoTxt = p.montoComprobante
    ? '<div style="font-size:0.66rem;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,0.55);font-weight:700;">Pagado</div>'
      + '<div style="font-family:Outfit,sans-serif;font-size:1.35rem;font-weight:800;margin-top:2px;color:#86efac;">$' + Number(p.montoComprobante).toLocaleString('es-CO') + '</div>'
      + (p.bancoComprobante ? '<div style="margin-top:2px;font-size:0.75rem;color:rgba(255,255,255,0.55);">' + esc(p.bancoComprobante) + '</div>' : '')
    : '';

  // Etapa pill
  const estadoColors = {
    'bandeja':         'rgba(245,158,11,0.18);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);',
    'hacer-diseno':    'rgba(124,58,237,0.18);color:#c4b5fd;border:1px solid rgba(124,58,237,0.35);',
    'confirmado':      'rgba(34,197,94,0.18);color:#86efac;border:1px solid rgba(34,197,94,0.35);',
    'enviado-final':   'rgba(34,197,94,0.22);color:#86efac;border:1px solid rgba(34,197,94,0.4);',
  };
  const estadoPillStyle = estadoColors[p.estado] || 'rgba(103,232,249,0.18);color:#67e8f9;border:1px solid rgba(103,232,249,0.35);';

  const modal = document.createElement('div');
  modal.id = 'modal-detalle-pedido';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:flex-end;justify-content:center;padding:0;';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.innerHTML =
    '<div style="background:#0c0e16;border-top:1px solid rgba(255,255,255,0.12);border-radius:18px 18px 0 0;max-width:560px;width:100%;max-height:92vh;overflow-y:auto;padding:0;animation:slide-up 0.25s cubic-bezier(0.16,1,0.3,1);">' +
      // === HEADER STICKY ===
      '<div style="position:sticky;top:0;z-index:5;background:#0c0e16;border-bottom:1px solid rgba(255,255,255,0.06);padding:14px 18px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-family:Outfit,sans-serif;font-weight:800;font-size:1.25rem;color:var(--text);line-height:1.15;letter-spacing:-0.02em;overflow:hidden;text-overflow:ellipsis;">' + esc(p.equipo || 'Sin equipo') + '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;">' +
            '<span style="font-size:0.66rem;color:var(--text-muted);letter-spacing:0.6px;text-transform:uppercase;font-weight:600;">#' + p.id + '</span>' +
            '<span style="padding:2px 9px;border-radius:99px;font-size:0.7rem;font-weight:700;background:' + estadoPillStyle + '">' + etapaActualLabel(p.estado) + '</span>' +
          '</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'modal-detalle-pedido\').remove()" style="background:rgba(255,255,255,0.06);border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">×</button>' +
      '</div>' +

      '<div style="padding:18px;">' +

      // === HERO (urgencia + monto si hay) ===
      (montoTxt
        ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">'
          + '<div style="background:' + heroBg + ';border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;">' + heroTxt + '</div>'
          + '<div style="background:linear-gradient(135deg,rgba(34,197,94,0.18),rgba(22,163,74,0.06));border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:14px;">' + montoTxt + '</div>'
        + '</div>'
        : '<div style="background:' + heroBg + ';border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;margin-bottom:14px;">' + heroTxt + '</div>'
      ) +

      // === DATOS (con WhatsApp inline en telefono) ===
      '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:12px;padding:14px;margin-bottom:14px;">' +
        // Telefono con boton WA
        (p.telefono
          ? '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.05);margin-bottom:12px;">'
            + '<div><div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;">Cliente</div>'
            + '<div style="font-size:0.95rem;font-weight:600;margin-top:2px;">📱 ' + tel + '</div></div>'
            + '<button onclick="window.open(\'https://wa.me/57' + String(p.telefono).replace(/\\D/g, '') + '\', \'_blank\')" style="background:linear-gradient(135deg,#22c55e,#16a34a);color:white;border:none;padding:8px 14px;border-radius:8px;font-weight:600;font-size:0.78rem;cursor:pointer;box-shadow:0 2px 8px rgba(34,197,94,0.3);">💬 WhatsApp</button>'
          + '</div>'
          : '') +
        // Vendedora + Diseñador
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' +
          '<div><div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Vendedora</div><div style="font-size:0.85rem;font-weight:600;">🛍️ ' + ven + '</div></div>' +
          '<div><div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Diseñador</div><div style="font-size:0.85rem;font-weight:600;">' + disHTML + '</div></div>' +
        '</div>' +
        // Prendas (si las hay)
        (items !== 'Sin prendas registradas'
          ? '<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);"><div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Prendas</div><div style="font-size:0.82rem;">' + items + '</div></div>'
          : '') +
        // Notas (si las hay)
        (notas
          ? '<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);"><div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Notas</div><div style="font-size:0.82rem;font-style:italic;color:var(--text-muted);">' + notas + '</div></div>'
          : '') +
      '</div>' +

      // === ACCION PRIMARIA: avanzar etapa ===
      (siguiente
        ? '<button onclick="avanzarEtapaPedido(' + p.id + ')" style="width:100%;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:white;padding:14px;border:none;border-radius:12px;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(124,58,237,0.35);margin-bottom:12px;letter-spacing:-0.01em;">Pasar a: ' + siguiente.label + ' →</button>'
        : '<div style="background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.35);color:#86efac;padding:14px;border-radius:12px;text-align:center;font-size:0.95rem;font-weight:600;margin-bottom:12px;">✅ Pedido entregado al cliente</div>') +

      // Notion (solo si entregado)
      (p.estado === 'enviado-final'
        ? '<button onclick="archivarUnPedidoNotion(' + p.id + ')" style="width:100%;background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.35);color:#86efac;padding:11px;border-radius:10px;font-weight:600;font-size:0.85rem;cursor:pointer;margin-bottom:12px;">📁 Archivar en Notion</button>'
        : '') +

      // === ACCIONES SECUNDARIAS ===
      '<button onclick="openModalCompletar(' + p.id + '); document.getElementById(\'modal-detalle-pedido\').remove();" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text);padding:11px;border-radius:10px;font-weight:600;font-size:0.85rem;cursor:pointer;margin-bottom:8px;">✏️ Editar datos del pedido</button>' +

      // === ACCION PELIGROSA (al fondo, mas pequeña) ===
      '<button onclick="eliminarPedidoCualquierEstado(' + p.id + ')" style="width:100%;background:transparent;border:1px solid rgba(239,68,68,0.25);color:#fca5a5;padding:9px;border-radius:8px;font-size:0.78rem;cursor:pointer;margin-top:6px;">🗑️ Eliminar pedido</button>' +

      '</div>' + // end padding
    '</div>';

  // Animacion de subida (slide-up bottom-sheet style)
  if (!document.getElementById('css-modal-detalle-anim')) {
    const st = document.createElement('style');
    st.id = 'css-modal-detalle-anim';
    st.textContent = '@keyframes slide-up { from { transform: translateY(100%); opacity: 0.5; } to { transform: translateY(0); opacity: 1; } } @media (min-width: 769px) { #modal-detalle-pedido { align-items: center !important; } #modal-detalle-pedido > div { border-radius: 18px !important; border: 1px solid rgba(255,255,255,0.1) !important; max-height: 88vh; } }';
    document.head.appendChild(st);
  }

  document.body.appendChild(modal);
}

function asignarDisenadorDesdeDetalle(id) {
  const sel = document.getElementById('dis-asignar-' + id);
  if (!sel) return;
  const nombre = sel.value;
  if (!nombre) { toast('Elige un diseñador primero', 'error'); return; }
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.disenadorAsignado = nombre;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  toast('🎨 ' + nombre + ' asignado al pedido', 'ok');
  const modal = document.getElementById('modal-detalle-pedido');
  if (modal) modal.remove();
  render();
  abrirDetallePedido(id);
}

function cambiarDisenadorDetalle(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.disenadorAsignado = '';
  guardar();
  const modal = document.getElementById('modal-detalle-pedido');
  if (modal) modal.remove();
  abrirDetallePedido(id);
}

async function avanzarEtapaPedido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const sig = siguienteEtapa(p.estado);
  if (!sig) { toast('Ya está en la última etapa', 'info'); return; }
  // Si va a enviado-final, advertir que se va a archivar a Notion automaticamente
  const esCierre = sig.id === 'enviado-final';
  const mensaje = esCierre
    ? '¿Marcar "' + (p.equipo || '#' + id) + '" como ENTREGADO?\n\nSe va a archivar en Notion y borrar del servidor automaticamente.'
    : '¿Pasar pedido a "' + sig.label + '"?';
  if (!confirm(mensaje)) return;
  p.estado = sig.id;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  toast('✅ Movido a ' + sig.label, 'success');
  const modal = document.getElementById('modal-detalle-pedido');
  if (modal) modal.remove();
  // Auto-archivar en Notion si llegó al final del flujo
  if (esCierre) {
    setTimeout(async () => {
      try {
        toast('⏳ Archivando en Notion...', 'info');
        const r = await fetch('/api/pedidos/' + id + '/archivar', { method: 'POST' });
        const data = await r.json();
        if (r.ok && data.ok) {
          eliminadosLocales.add(id);
          await hardSyncFromServer(true);
          toast('📁 Pedido #' + id + ' archivado en Notion', 'success');
        } else {
          toast('⚠️ Pedido entregado, pero falló el archivado automático. Archivá manual desde el modal.', 'error');
        }
      } catch (e) { console.error('[auto-archivar]', e); }
    }, 800);
    return;
  }
  render();
}

// Edita el nombre del equipo/pedido rápido sin abrir el modal completo.
async function editarNombreEquipoRapido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const actual = p.equipo || '';
  const nuevo = prompt('Nombre del equipo o pedido:\n(Ej: "Brasil Dragón", "Bykers Colombia", etc.)', actual);
  if (nuevo === null) return; // canceló
  const limpio = nuevo.trim();
  if (limpio === actual) return; // sin cambios
  p.equipo = limpio;
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  toast(limpio ? '✏️ Nombre guardado' : '🗑️ Nombre borrado', 'success');
  render();
}

// Avanza un pedido a la siguiente etapa con UN solo toque desde la card del Tablero.
// Confirma rapido y dispara auto-archive si termina en enviado-final.
async function avanzarRapidoTablero(id, proximoEstado, textoAccion) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const etiqueta = p.equipo || '#' + id;
  const esCierre = proximoEstado === 'enviado-final';
  const mensaje = esCierre
    ? '¿Confirmar entrega de "' + etiqueta + '"?\n\nSe archiva en Notion automaticamente.'
    : '¿' + textoAccion + ' — "' + etiqueta + '"?';
  if (!confirm(mensaje)) return;
  // UI optimista
  const estadoAnterior = p.estado;
  p.estado = proximoEstado;
  p.ultimoMovimiento = new Date().toISOString();
  toast('✅ ' + textoAccion, 'success');
  render();
  // Server-side: usar endpoint /avanzar para registrar historial con la persona del header
  try {
    const r = await fetch('/api/pedidos/' + id + '/avanzar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado: proximoEstado }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo en avanzar');
    if (data.archivado) {
      // El server auto-archivó a Notion al pasar a enviado-final
      eliminadosLocales.add(id);
      pedidos = pedidos.filter(x => x.id !== id);
      render();
      toast('📁 Pedido #' + id + ' archivado en Notion', 'success');
    } else {
      // Persistir el cambio local también (para que el próximo guardar() no lo regrese)
      guardar();
    }
  } catch (e) {
    // Rollback si falla
    console.error('[avanzar-rapido]', e);
    p.estado = estadoAnterior;
    render();
    toast('Error al avanzar: ' + e.message, 'error');
  }
}

// Archiva UN pedido a Notion (desde modal de detalle cuando esta en enviado-final)
async function archivarUnPedidoNotion(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  if (p.estado !== 'enviado-final') {
    toast('Solo se pueden archivar pedidos entregados', 'info');
    return;
  }
  if (!confirm('¿Archivar "' + (p.equipo || '#' + id) + '" a Notion?\n\nQueda en el histórico de Notion y se borra del servidor. No se puede deshacer.')) return;
  try {
    toast('⏳ Archivando...', 'info');
    const r = await fetch('/api/pedidos/' + id + '/archivar', { method: 'POST' });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    eliminadosLocales.add(id);
    const modal = document.getElementById('modal-detalle-pedido');
    if (modal) modal.remove();
    await hardSyncFromServer(true);
    toast('✅ Pedido #' + id + ' archivado en Notion', 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Elimina un pedido en CUALQUIER estado (para limpiar pedidos basura: mal escritos,
// sin telefono, duplicados, etc). Borra local + server.
async function eliminarPedidoCualquierEstado(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  const esProtegido = p.origenBot || p.origenFacturaHuerfana || p.origenHuerfano || p.origenComprobante;
  const etiqueta = (p.equipo || p.telefono || '(sin nombre)') + ' #' + id;
  const aviso = esProtegido
    ? '¿Eliminar permanentemente el pedido "' + etiqueta + '"?\n\n⚠️ Este pedido fue creado por el sistema (sticker/factura/comprobante). Si lo borrás solo en este dispositivo, el server puede recrearlo. Para borrarlo en serio hay que borrar también la factura/comprobante origen.'
    : '¿Eliminar permanentemente el pedido "' + etiqueta + '"?\n\nNo se puede deshacer.';
  if (!confirm(aviso)) return;
  // Solo marcamos como eliminado local si NO es protegido (los protegidos los recrea el server
  // y deben quedar visibles en TODOS los dispositivos — coherencia multi-device)
  if (!esProtegido) eliminadosLocales.add(id);
  pedidos = pedidos.filter(x => x.id !== id);
  const modal = document.getElementById('modal-detalle-pedido');
  if (modal) modal.remove();
  render();
  try {
    const r = await fetch('/api/pedidos/' + id, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      console.error('[eliminar] server respondió', r.status);
    }
  } catch (e) { console.error('[eliminar] error:', e); }
  guardar();
  toast('🗑️ Pedido #' + id + ' eliminado', 'info');
}

// Limpieza masiva: borra todos los pedidos sin teléfono Y sin vendedora.
// Útil para limpiar el spam del lector de tablero foto.
async function limpiarBasura() {
  // Contar localmente para mostrar al usuario
  const candidatos = (pedidos || []).filter(p => {
    if (p.estado === 'enviado-final') return false;
    if (p.stickerVenta) return false;
    const sinTel = !p.telefono || String(p.telefono).replace(/\D/g, '').length < 7;
    const sinVen = !p.vendedora || p.vendedora === 'Sin asignar' || p.vendedora === '';
    return sinTel && sinVen;
  });
  if (candidatos.length === 0) {
    toast('No hay pedidos basura para limpiar 🎉', 'info');
    return;
  }
  const ejemplos = candidatos.slice(0, 8).map(p => '#' + p.id + ' ' + (p.equipo || '(sin nombre)')).join(', ');
  const extras = candidatos.length > 8 ? ' y ' + (candidatos.length - 8) + ' más' : '';
  if (!confirm('¿Borrar ' + candidatos.length + ' pedido(s) sin teléfono y sin vendedora?\n\n' + ejemplos + extras + '\n\nNo se puede deshacer.')) return;
  try {
    toast('⏳ Limpiando...', 'info');
    const r = await fetch('/api/pedidos/limpiar-basura', { method: 'POST' });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    // Marcar como eliminados localmente para que el sync no los reviva
    (data.ids || []).forEach(id => eliminadosLocales.add(id));
    // Forzar resync
    await hardSyncFromServer(true);
    toast('✅ ' + data.eliminados + ' pedidos basura eliminados', 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Archivar los enviado-final con MÁS DE 30 DÍAS en Notion y borrar del server.
// Los enviados recientes (≤30d) se quedan visibles en la columna ENVIADOS.
async function archivarEntregadosNotion() {
  const DIAS_UMBRAL = 30;
  const hace30 = Date.now() - DIAS_UMBRAL * 86400000;
  const enviados = (pedidos || []).filter(p => p.estado === 'enviado-final');
  const candidatosViejos = enviados.filter(p => {
    const t = p.ultimoMovimiento ? new Date(p.ultimoMovimiento).getTime() : 0;
    return t > 0 && t < hace30;
  });
  const proceder = confirm(
    '¿Archivar pedidos entregados de hace MÁS de ' + DIAS_UMBRAL + ' días en Notion?\n\n' +
    'Candidatos (>30d): ' + candidatosViejos.length + '\n' +
    'Enviados recientes (≤30d, se quedan visibles): ' + (enviados.length - candidatosViejos.length) + '\n\n' +
    'No se puede deshacer.'
  );
  if (!proceder) return;
  try {
    toast('⏳ Archivando pedidos en Notion...', 'info');
    const r = await fetch('/api/pedidos/archivar-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soloMasViejosQue: DIAS_UMBRAL })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    const ok = data.archivados.length;
    const fail = data.fallidos.length;
    // FORZAR resincronización: traer pedidos del server y reemplazar localStorage
    try {
      const rp = await fetch('/api/pedidos');
      const dp = await rp.json();
      const srv = Array.isArray(dp) ? dp : (dp.pedidos || []);
      pedidos = srv;
      localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
    } catch (eSync) { console.error('[archivar] no se pudo resync:', eSync); }
    let msg = '✅ ' + ok + ' archivados';
    if (fail) msg += ' · ❌ ' + fail + ' fallaron';
    toast(msg + ' · Total en servidor: ' + (Array.isArray(pedidos) ? pedidos.length : '?'), fail ? 'error' : 'success');
    if (fail && data.fallidos.length) console.error('Pedidos fallidos:', data.fallidos);
    render();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Reset duro: borra localStorage de pedidos Y limpia eliminadosLocales (que pudo borrar pedidos del bot)
// Resincroniza estado completo con el servidor.
async function resincronizarConServidor() {
  if (!confirm('Esto va a reemplazar todos los pedidos locales con los del servidor y limpiar el cache de borrados. ¿Continuar?')) return;
  try {
    const r = await fetch('/api/pedidos');
    const d = await r.json();
    const srv = Array.isArray(d) ? d : (d.pedidos || []);
    pedidos = srv;
    if (d.nextId) {
      nextId = d.nextId;
      localStorage.setItem('ws_nextId3', String(nextId));
    }
    localStorage.setItem('ws_pedidos3', JSON.stringify(pedidos));
    // CRITICO: limpiar eliminadosLocales que pueden contener IDs de pedidos
    // creados por bot/comprobante (que el usuario nunca borro explicitamente).
    // Sin esto, el proximo POST mandaria eliminados=[...] y el servidor (sin proteccion vieja)
    // los borraria de nuevo. Con la proteccion nueva ya no, pero limpiamos igual por higiene.
    const idsBot = new Set(srv.filter(p => p.origenBot || p.origenComprobante || p.origenHuerfano).map(p => p.id));
    let limpiados = 0;
    for (const id of [...eliminadosLocales]) {
      if (idsBot.has(id)) {
        eliminadosLocales.delete(id);
        limpiados++;
      }
    }
    toast('✅ Resync OK · ' + pedidos.length + ' pedidos del servidor' + (limpiados ? ' · liberados ' + limpiados + ' del cache' : ''), 'success');
    render();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Submenu "Más" en sidebar
function toggleSubmenuMas() {
  const s = document.getElementById('submenu-mas');
  if (!s) return;
  s.style.display = s.style.display === 'none' ? 'block' : 'none';
}


// Archivar un pedido individual en Notion + borrar del servidor
async function archivarPedidoUno(id, divId) {
  if (!confirm('¿Marcar #' + id + ' como entregado y archivarlo en Notion?')) return;
  try {
    const r = await fetch('/api/pedidos/' + id + '/archivar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || data.motivo || 'fallo');
    toast('✅ #' + id + ' archivado en Notion', 'success');
    const el = document.getElementById(divId);
    if (el) el.style.opacity = '0.4';
    if (el) el.innerHTML = '<div style="color:#86efac;font-size:0.82rem;">✅ Archivado en Notion</div>';
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Marcar pedido como "activo" (solo actualiza ultimoMovimiento para que no se quede colgado)
function dejarPedidoActivo(id, divId) {
  const p = pedidos.find(x => x.id === id);
  if (p) {
    p.ultimoMovimiento = new Date().toISOString();
    guardar();
  }
  const el = document.getElementById(divId);
  if (el) { el.style.opacity = '0.4'; el.innerHTML = '<div style="color:#c4b5fd;font-size:0.82rem;">↺ Marcado como activo (no archivar)</div>'; }
  toast('Pedido #' + id + ' queda activo', 'info');
}

/* ════════════════════════════════════════════════════════════════
   PDFs SIN ASIGNAR — bandeja para vincular manualmente PDFs huérfanos
════════════════════════════════════════════════════════════════ */

async function renderPdfsHuerfanos() {
  const cont = document.getElementById('huerfanos-content');
  if (!cont) return;
  cont.innerHTML = '<div style="color:var(--text-muted);">Cargando...</div>';
  try {
    const r = await fetch('/api/pdfs-huerfanos');
    if (!r.ok) throw new Error('servidor');
    const data = await r.json();
    const items = data.items || [];

    const badge = document.getElementById('badge-huerfanos');
    if (badge) badge.textContent = items.length;

    if (!items.length) {
      cont.innerHTML = '<div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:10px;padding:18px;color:#86efac;">✅ No hay PDFs huérfanos. Todos los archivos llegados se asociaron correctamente con un pedido.</div>';
      return;
    }

    const candidatos = pedidos.filter(p => ['hacer-diseno', 'confirmado', 'enviado-calandra'].includes(p.estado));
    const opts = candidatos
      .sort((a, b) => (b.ultimoMovimiento || '').localeCompare(a.ultimoMovimiento || ''))
      .map(p => '<option value="' + p.id + '">#' + p.id + ' ' + esc(p.equipo || p.telefono || 'Sin equipo') + ' — ' + esc(p.vendedora || '') + ' (' + (ESTADO_LABELS[p.estado] || p.estado) + ')</option>')
      .join('');

    let html = '';
    items.forEach(it => {
      const fechaStr = it.ts ? new Date(it.ts).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : '';
      const refKey = (it.id || it.archivo || '').toString().replace(/[^a-zA-Z0-9_-]/g, '_');
      const idEsc = esc(it.id || it.archivo || '');
      const archEsc = esc(it.archivo || '');
      // Sugerencias top 3 (vienen del backend, ya rankeadas por similitud)
      const sugs = Array.isArray(it.sugerencias) ? it.sugerencias : [];
      let sugHtml = '';
      if (sugs.length) {
        sugHtml = '<div style="margin:8px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">' +
          '<span style="font-size:0.72rem;color:var(--text-muted);">Sugerencias:</span>' +
          sugs.map(s => '<button onclick="vincularHuerfanoDirecto(\'' + it.tipo + '\',\'' + idEsc + '\',\'' + archEsc + '\',' + s.id + ')" ' +
            'style="background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);color:#86efac;border-radius:6px;padding:4px 10px;font-size:0.74rem;cursor:pointer;" ' +
            'title="' + s.score + '% similitud">#' + s.id + ' ' + esc(s.equipo) + ' (' + s.score + '%)</button>').join('') +
          '</div>';
      }
      // Equipo sugerido para "crear pedido nuevo": usar el equipo del archivo limpio
      const equipoSug = (it.equipo || it.archivo || '').replace(/\.pdf$/i, '').replace(/[_]+\d+(\.\d+)?\s*m?$/i, '').replace(/_/g, ' ').trim();
      html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:14px;margin-bottom:10px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:10px;">' +
        '<div><div style="font-weight:600;font-size:0.92rem;">' + (it.tipo === 'wt' ? '📨' : '📄') + ' ' + archEsc + '</div>' +
        '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">' + (it.tipo === 'wt' ? 'WeTransfer' : 'Drive') + ' · ' + esc(fechaStr) + (it.equipo ? ' · equipo: "' + esc(it.equipo) + '"' : '') + '</div></div>' +
        '<button onclick="ignorarHuerfano(\'' + it.tipo + '\',\'' + idEsc + '\')" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:6px;padding:4px 10px;font-size:0.72rem;cursor:pointer;">✕ Ignorar</button>' +
        '</div>' +
        sugHtml +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        '<select id="sel-' + it.tipo + '-' + refKey + '" class="form-input" style="flex:1;min-width:200px;font-size:0.82rem;padding:6px 10px;">' +
        '<option value="">— Ver todos los pedidos —</option>' + opts +
        '</select>' +
        '<button onclick="vincularHuerfano(\'' + it.tipo + '\',\'' + idEsc + '\',\'' + archEsc + '\',\'' + refKey + '\')" class="btn btn-sm" style="background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;">Vincular</button>' +
        '<button onclick="crearPedidoDesdeHuerfano(\'' + it.tipo + '\',\'' + idEsc + '\',\'' + archEsc + '\',\'' + esc(equipoSug) + '\')" class="btn btn-sm" style="background:rgba(34,197,94,0.18);border:1px solid rgba(34,197,94,0.4);color:#86efac;" title="No hay pedido para este PDF — crear uno nuevo">+ Crear pedido nuevo</button>' +
        '</div></div>';
    });
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = '<div style="color:#fca5a5;">Error cargando huérfanos: ' + esc(e.message) + '</div>';
  }
}

async function vincularHuerfanoDirecto(tipo, idItem, archivo, pedidoId) {
  if (!confirm('¿Vincular este PDF al pedido #' + pedidoId + '?')) return;
  try {
    const r = await fetch('/api/pdfs-huerfanos/vincular', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, idItem, archivo, pedidoId })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    toast('✅ Vinculado a #' + pedidoId, 'success');
    renderPdfsHuerfanos();
    setTimeout(() => { if (typeof syncTodoConServidor === 'function') syncTodoConServidor(true); }, 500);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function crearPedidoDesdeHuerfano(tipo, idItem, archivo, equipoSug) {
  const equipo = prompt('Nombre del equipo para el pedido nuevo:', equipoSug);
  if (!equipo || !equipo.trim()) return;
  const VENDS = ['Betty', 'Ney', 'Wendy', 'Paola'];
  const vendStr = prompt('Vendedora (Betty, Ney, Wendy o Paola):', 'Betty');
  if (!vendStr) return;
  const vendedora = VENDS.find(v => v.toLowerCase() === vendStr.trim().toLowerCase()) || vendStr.trim();
  const telefono = prompt('Teléfono del cliente (10 dígitos, opcional):', '') || '';
  try {
    const r = await fetch('/api/pdfs-huerfanos/crear-pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, idItem, archivo, equipo: equipo.trim(), vendedora, telefono: telefono.trim() })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    toast('✅ Pedido #' + data.pedidoId + ' creado y vinculado', 'success');
    renderPdfsHuerfanos();
    setTimeout(() => { if (typeof syncTodoConServidor === 'function') syncTodoConServidor(true); }, 500);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function vincularHuerfano(tipo, idItem, archivo, refKey) {
  const sel = document.getElementById('sel-' + tipo + '-' + refKey);
  if (!sel || !sel.value) { toast('Selecciona un pedido', 'error'); return; }
  const pedidoId = parseInt(sel.value);
  try {
    const r = await fetch('/api/pdfs-huerfanos/vincular', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, idItem, archivo, pedidoId })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fallo');
    toast('✅ Vinculado a #' + pedidoId, 'success');
    renderPdfsHuerfanos();
    setTimeout(() => { if (typeof syncTodoConServidor === 'function') syncTodoConServidor(true); }, 500);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function ignorarHuerfano(tipo, idItem) {
  if (!confirm('¿Ignorar este archivo? No volverá a aparecer en la lista.')) return;
  try {
    await fetch('/api/pdfs-huerfanos/ignorar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, idItem })
    });
    renderPdfsHuerfanos();
  } catch {}
}

// Auto-refresh: torre cada 60s (es lokal, no pesa). Huérfanos NO auto-refresh
// porque ese endpoint es pesado y crashearía Railway. Usuario lo refresca manual.
setInterval(() => {
  const torreActive = document.getElementById('torre') && document.getElementById('torre').classList.contains('active');
  if (torreActive) renderTorreControl();
  _actualizarBadgeTorre();
}, 60000);

_actualizarBadgeTorre();
