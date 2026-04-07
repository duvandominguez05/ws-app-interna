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
  'corte':            'calidad',
  'calidad':          'costura',
  'costura':          'listo',
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
  'calidad':           'Calidad',
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
  'calidad':           'badge-calidad',
  'costura':           'badge-produccion',
  'listo':             'badge-listo',
  'enviado-final':     'badge-enviado',
};

/* ════════════════════════════════════════════════════════════════
   ESTADO
════════════════════════════════════════════════════════════════ */
let pedidos = JSON.parse(localStorage.getItem('ws_pedidos3') || '[]');
let nextId  = parseInt(localStorage.getItem('ws_nextId3') || '1');
const eliminadosLocales = new Set(JSON.parse(localStorage.getItem('ws_eliminados') || '[]'));
let modalCompletarId = null;
let tipoNuevo = 'cotizar';
let calandraRegistros = JSON.parse(localStorage.getItem('ws_calandra') || '[]');
let calandraAncho     = parseFloat(localStorage.getItem('ws_calandra_ancho') || '1.50');
const SATELITES = ['Marcela', 'Yamile', 'Wilson', 'Cristina'];
let satMovimientos = JSON.parse(localStorage.getItem('ws_satelites') || '[]');
let satTipoActual  = 'entrega';

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
  // Sincronizar con servidor para que n8n pueda leer y actualizar pedidos
  fetch('/api/pedidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pedidos, nextId, eliminados: [...eliminadosLocales] })
  }).catch(() => {}); // silencioso — no interrumpe si falla
}

/* ════════════════════════════════════════════════════════════════
   NAVEGACIÓN
════════════════════════════════════════════════════════════════ */
const HEADER_INFO = {
  'vista-general': { icon: '📊', title: 'Vista general' },
  'bandeja':       { icon: '💼', title: 'Ventas' },
  'diseno':        { icon: '🎨', title: 'Diseño' },
  'produccion':    { icon: '🏭', title: 'Producción' },
  'wetransfer':    { icon: '📤', title: 'WeTransfer — envíos a calandra' },
  'arreglos':      { icon: '🔧', title: 'Control de arreglos' },
  'calandra':      { icon: '📐', title: 'Metraje — Control Calandra' },
  'satelites':     { icon: '🧵', title: 'Satélites de costura' },
  'cotizaciones':  { icon: '🧾', title: 'Facturas y Cotizaciones' },
};

function showSection(id, navEl) {
  document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (navEl) navEl.classList.add('active');

  const info = HEADER_INFO[id] || {};
  document.getElementById('header-icon').textContent      = info.icon || '';
  document.getElementById('header-title-text').textContent = info.title || '';

  closeSidebar();
  render();
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
  }
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

/* ════════════════════════════════════════════════════════════════
   RENDER PRINCIPAL
════════════════════════════════════════════════════════════════ */
function render() {
  renderMetricas();
  renderDashboard();
  renderBadges();
  renderTablaRecientes();
  renderBandeja();
  renderKanban('hacer-diseno');
  renderKanban('confirmado');
  renderKanban('enviado-calandra');
  renderKanban('llego-impresion');
  renderKanban('corte');
  renderKanban('calidad');
  renderKanban('costura');
  renderKanban('listo');
  renderKanban('enviado-final');
  cargarWT();
  renderArreglos();
  renderCalandra();
  renderSatelites();
}

/* ─── Métricas ────────────────────────────────────────────────── */
function renderMetricas() {
  const total     = pedidos.filter(p => p.estado !== 'enviado-final').length;
  const enProd    = pedidos.filter(p => ['llego-impresion','corte','calidad','costura'].includes(p.estado)).length;
  const listos    = pedidos.filter(p => p.estado === 'listo').length;
  const enDiseno  = pedidos.filter(p => ['hacer-diseno','confirmado','enviado-calandra'].includes(p.estado)).length;

  document.getElementById('m-total').textContent      = total;
  document.getElementById('m-produccion').textContent = enProd;
  document.getElementById('m-listos').textContent     = listos;
  document.getElementById('m-diseno').textContent     = enDiseno;
}

/* ─── Dashboard ──────────────────────────────────────────────── */
function renderDashboard() {
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
    { key: 'corte',            label: 'Corte',                 color: '#a78bfa' },
    { key: 'calidad',          label: 'Control calidad',       color: '#fbbf24' },
    { key: 'costura',          label: 'Costura',               color: '#f472b6' },
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

/* ─── Badges sidebar ─────────────────────────────────────────── */
function renderBadges() {
  const bandeja  = pedidos.filter(p => p.estado === 'bandeja').length;
  const diseno   = pedidos.filter(p => ['hacer-diseno','confirmado','enviado-calandra'].includes(p.estado)).length;
  const prod     = pedidos.filter(p => ['llego-impresion','corte','calidad','costura','listo'].includes(p.estado)).length;
  const total    = pedidos.filter(p => p.estado !== 'enviado-final').length;
  document.getElementById('badge-general').textContent = total;
  document.getElementById('badge-bandeja').textContent = bandeja;
  document.getElementById('badge-diseno').textContent  = diseno;
  document.getElementById('badge-prod').textContent    = prod;
}

/* ─── Tabla recientes ────────────────────────────────────────── */
const TL_ETAPAS = [
  { key: 'bandeja',          label: 'Bandeja'    },
  { key: 'hacer-diseno',     label: 'Diseño'     },
  { key: 'confirmado',       label: 'Confirmado' },
  { key: 'enviado-calandra', label: 'Calandra'   },
  { key: 'llego-impresion',  label: 'Impresión'  },
  { key: 'corte',            label: 'Corte'      },
  { key: 'calidad',          label: 'Calidad'    },
  { key: 'arreglo',          label: 'Arreglo'    },
  { key: 'costura',          label: 'Costura'    },
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
  if (!arr.length) return `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">Sin entradas</div></div>`;
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
  'corte':             '#eab308',
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
    'calidad':           'produccion',
    'costura':           'produccion',
    'listo':             'envios',
    'enviado-final':     'envios',
  };
  const seccion = ESTADO_SECCION[p.estado] || 'produccion';
  const navEl = document.querySelector(`.nav-item[onclick*="'${seccion}'"]`);
  showSection(seccion, navEl);
}

function eliminarPedidoBandeja(id, event) {
  event.stopPropagation();
  if (!confirm(`¿Eliminar pedido #${id}?`)) return;
  pedidos = pedidos.filter(x => x.id !== id);
  eliminadosLocales.add(id);
  localStorage.setItem('ws_eliminados', JSON.stringify([...eliminadosLocales]));
  fetch(`/api/pedidos/${id}`, { method: 'DELETE' }).catch(() => {});
  guardar();
  render();
  toast(`Pedido #${id} eliminado`, 'info');
}

function renderBandejaPedidos(arr) {
  if (!arr.length) return `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">Sin entradas</div></div>`;
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
  if (!col) return;

  const items = pedidos.filter(p => p.estado === estado);
  if (cnt) cnt.textContent = items.length;

  if (!items.length) {
    col.innerHTML = `<div class="empty-state"><div class="empty-icon" style="font-size:1.3rem;opacity:0.2;">○</div><div class="empty-text">Vacío</div></div>`;
    return;
  }

  col.innerHTML = items.map(p => renderKanbanCard(p)).join('');
}

function renderKanbanCardDiseno(p) {
  const DISENADORES = ['Camilo', 'Wendy', 'Ney', 'Paola'];
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

  if (p.estado === 'calidad') {
    if (p.arreglo) {
      const descActual = (p.arreglo === 'pendiente') ? '' : esc(p.arreglo);
      actionsHtml = `
        <div style="font-size:0.68rem;color:#fca5a5;font-weight:600;margin-bottom:4px;">⚠ ¿Qué hay que arreglar?</div>
        <textarea id="arreglo-edit-${p.id}" placeholder="Escribe el arreglo (Enter = nueva línea)..." style="width:100%;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);border-radius:6px;color:var(--text);font-size:0.75rem;padding:5px 8px;outline:none;margin-bottom:6px;resize:vertical;min-height:52px;font-family:inherit;">${descActual}</textarea>
        <div class="kanban-card-actions">
          <button class="btn btn-success btn-xs" onclick="llegoFaltante(${p.id})">✓ Llegó</button>
          <button class="btn btn-xs" onclick="guardarDescArreglo(${p.id})" style="background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;font-size:0.72rem;padding:4px 8px;border-radius:5px;cursor:pointer;">Guardar</button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="kanban-card-actions">
          <button class="btn btn-xs" onclick="retroceder(${p.id})" title="Retroceder estado" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:var(--text-muted);padding:4px 8px;font-size:0.85rem;line-height:1;">←</button>
          <button class="btn btn-success btn-xs" onclick="avanzarNormal(${p.id})">→ Costura</button>
          <button class="btn btn-xs" onclick="registrarArreglo(${p.id})" title="Marcar arreglo" style="background:rgba(239,68,68,0.15);color:#fca5a5;border:1px solid rgba(239,68,68,0.35);padding:4px 8px;font-size:0.85rem;line-height:1;">🔧</button>
        </div>
      `;
    }
  } else if (p.estado === 'listo') {
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
      ${actionsHtml}
    </div>
  `;
}

function getBotonLabel(estado) {
  const labels = {
    'hacer-diseno':     '✓ Confirmado',
    'confirmado':       '→ Calandra',
    'enviado-calandra': '→ Llegó impresión',
    'llego-impresion':  '→ Corte',
    'corte':            '→ Calidad',
    'costura':          '→ Listo',
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
  'corte':            '✂️',
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
    crearNotif(icono, `<strong>#${id} ${esc(nombre)}</strong> llegó impresión — pasa a <strong>corte</strong>`, 'info', id);
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
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} pasó a Costura`, 'success');
  crearNotif('🧵', `<strong>#${id} ${esc(p.equipo || p.telefono)}</strong> — arreglo resuelto, pasa a <strong>costura</strong>`, 'success', id);
}

function registrarArreglo(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  p.arreglo = 'pendiente';
  p.ultimoMovimiento = new Date().toISOString();
  guardar();
  render();
  toast(`#${id} marcado con arreglo — escribe la descripción`, 'info');
  crearNotif('⚠️', `<strong>#${id} ${esc(p.equipo || p.telefono)}</strong> — tiene un <strong>arreglo pendiente</strong> en calidad`, 'warning', id);
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
  // No re-renderizar para no destruir el textarea — solo actualizar badges
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

function eliminarPedido(id) {
  const p = pedidos.find(x => x.id === id);
  if (!p) return;
  if (p.estado !== 'enviado-final') {
    toast(`#${id} solo se puede eliminar cuando esté enviado`, 'info');
    return;
  }
  if (!confirm(`¿Eliminar pedido #${id}?`)) return;
  pedidos = pedidos.filter(x => x.id !== id);
  eliminadosLocales.add(id);
  localStorage.setItem('ws_eliminados', JSON.stringify([...eliminadosLocales]));
  fetch(`/api/pedidos/${id}`, { method: 'DELETE' }).catch(() => {});
  guardar();
  render();
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
  const labels = {
    'bandeja':           '→ Iniciar diseño',
    'hacer-diseno':      '→ Diseño listo',
    'confirmado':        '→ Enviar a calandra',
    'enviado-calandra':  '→ Llegó impresión',
    'llego-impresion':   '→ Corte',
    'corte':             '→ Calidad',
    'calidad':           '→ Costura',
    'costura':           '→ Listo',
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
  const hist     = wtRegistros.filter(e => e.fecha !== hoy);

  // Contar enviados y descargados hoy
  const envHoy  = hoy_list.filter(e => e.tipo === 'enviado').length;
  const descHoy = hoy_list.filter(e => e.tipo === 'descargado').length;

  document.getElementById('badge-wt').textContent = hoy_list.length;

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

  let html = '';
  if (!hoy_list.length) {
    html += `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:0.8rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);">Sin registros hoy</div>`;
  } else {
    html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">Hoy</div>`;
    // Ordenar: más reciente primero
    html += [...hoy_list].sort((a,b) => (b.id||0)-(a.id||0)).map(e => renderFila(e, false)).join('');
  }

  if (hist.length) {
    html += `<div style="font-size:0.72rem;color:var(--text-muted);margin:18px 0 8px;text-transform:uppercase;letter-spacing:1px;">Días anteriores</div>`;
    html += [...hist].sort((a,b) => (b.id||0)-(a.id||0)).slice(0, 30).map(e => renderFila(e, true)).join('');
  }

  cont.innerHTML = html;
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
  document.getElementById('form-arreglo').style.display = 'block';
  document.getElementById('ar-equipo').focus();
}

function guardarArregloManual() {
  const equipo   = document.getElementById('ar-equipo').value.trim();
  const faltante = document.getElementById('ar-faltante').value.trim();
  if (!equipo) { toast('Ingresa el nombre del equipo', 'error'); return; }
  if (!faltante) { toast('Ingresa qué falta', 'error'); return; }
  arreglosManuales.unshift({ id: Date.now(), equipo, faltante, fecha: new Date().toLocaleDateString('es-CO'), resuelto: false });
  guardarArreglos_store();
  document.getElementById('form-arreglo').style.display = 'none';
  renderArreglos();
  toast(`Arreglo registrado: ${equipo}`, 'info');
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
  const contPed = document.getElementById('lista-arreglos-pedidos');
  const contMan = document.getElementById('lista-arreglos-manuales');
  if (!contPed || !contMan) return;

  // Arreglos de pedidos activos
  const conArreglo = pedidos.filter(p => p.arreglo && p.arreglo !== 'pendiente' && p.estado !== 'enviado-final');
  document.getElementById('badge-arreglos').textContent = conArreglo.length + arreglosManuales.filter(a => !a.resuelto).length;

  if (!conArreglo.length) {
    contPed.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.78rem;">Sin arreglos en pedidos activos</div>`;
  } else {
    contPed.innerHTML = conArreglo.map(p => `
      <div style="background:linear-gradient(135deg,rgba(239,68,68,0.08),var(--card-bg));border:1px solid rgba(239,68,68,0.3);border-radius:var(--radius);padding:14px 16px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span style="font-size:0.65rem;color:var(--text-muted);">#${p.id}</span>
          <span style="font-weight:700;font-size:0.88rem;">${esc(p.equipo || p.telefono)}</span>
          <span style="font-size:0.68rem;background:rgba(239,68,68,0.15);color:#fca5a5;border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:2px 7px;">calidad</span>
        </div>
        <div style="font-size:0.78rem;color:#fca5a5;white-space:pre-line;">🔧 ${esc(p.arreglo)}</div>
      </div>
    `).join('');
  }

  const pendientes = arreglosManuales.filter(a => !a.resuelto);
  const resueltos  = arreglosManuales.filter(a =>  a.resuelto);

  if (!pendientes.length && !resueltos.length) {
    contMan.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.78rem;">Sin registros manuales</div>`;
    return;
  }

  contMan.innerHTML = [...pendientes, ...resueltos].map(a => `
    <div style="background:var(--card-bg);border:1px solid ${a.resuelto ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'};border-radius:var(--radius);padding:14px 16px;margin-bottom:8px;${a.resuelto ? 'opacity:0.55;' : ''}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <span style="font-weight:700;font-size:0.88rem;">${esc(a.equipo)}</span>
        <span style="margin-left:auto;font-size:0.68rem;color:var(--text-muted);">${a.fecha}</span>
      </div>
      <div style="font-size:0.78rem;color:${a.resuelto ? '#6ee7b7' : '#fca5a5'};margin-bottom:8px;">🔧 ${esc(a.faltante)}</div>
      ${!a.resuelto ? `<button class="btn btn-success btn-xs" onclick="resolverArregloManual(${a.id})">✓ Resuelto</button>` : `<span style="font-size:0.7rem;color:#6ee7b7;">✓ Resuelto</span>`}
    </div>
  `).join('');
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

      const mapaServer = new Map(serverPedidos.map(p => [p.id, p]));
      const mapaLocal  = new Map(pedidos.map(p => [p.id, p]));
      const merged = [];

      const todosIds = new Set([...mapaServer.keys(), ...mapaLocal.keys()]);
      todosIds.forEach(id => {
        const s = mapaServer.get(id);
        const l = mapaLocal.get(id);
        if (s && l) {
          const tS = s.ultimoMovimiento ? new Date(s.ultimoMovimiento).getTime() : 0;
          const tL = l.ultimoMovimiento ? new Date(l.ultimoMovimiento).getTime() : 0;
          
          if (tS > tL) {
            // El servidor tiene una versión más nueva, la tomamos completa
            merged.push({ ...s });
          } else {
            // La local es más nueva o igual, conservamos la local pero preservamos campos clave de webhook
            merged.push({ ...l, 
              notaWebhook: s.notaWebhook || l.notaWebhook, 
              ultimaActWebhook: s.ultimaActWebhook || l.ultimaActWebhook
            });
          }
        } else if (s && !l) {
          // Solo agregar si no fue eliminado explícitamente en este dispositivo
          if (!eliminadosLocales.has(id)) merged.push(s);
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
        if (!silencioso) toast('🔄 Pedidos sincronizados', 'info');
      }
    })
    .catch(() => {});
}

// Sync al cargar
syncConServidor(false);

// Polling automático cada 15 segundos
setInterval(() => syncConServidor(true), 15000);

// Sync calandra Drive al cargar y cada 2 minutos
setTimeout(sincronizarCalandraServidor, 500);
setInterval(sincronizarCalandraServidor, 120000);

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
    const ta = a.createdTime ? new Date(a.createdTime).getTime() : a.id;
    const tb = b.createdTime ? new Date(b.createdTime).getTime() : b.id;
    return tb - ta;
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
  const badge = document.getElementById('badge-calandra');
  if (badge) badge.textContent = hoyList.length;

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

function renderSatelites() {
  const contResumen = document.getElementById('sat-resumen');
  const contLista   = document.getElementById('lista-satelites');
  if (!contResumen || !contLista) return;

  // Badge sidebar
  const pendTotal = SATELITES.reduce((sum, s) => {
    const entregado = satMovimientos.filter(m => m.satelite === s && m.tipo === 'entrega').reduce((a, m) => a + m.cantidad, 0);
    const recibido  = satMovimientos.filter(m => m.satelite === s && m.tipo === 'recepcion').reduce((a, m) => a + m.cantidad, 0);
    return sum + Math.max(0, entregado - recibido);
  }, 0);
  const badge = document.getElementById('badge-satelites');
  if (badge) badge.textContent = pendTotal;

  // Colores únicos por satélite
  const SAT_COLORS = {
    'Marcela':     { border: 'rgba(139,92,246,0.35)', header: '#a78bfa', dot: '#7c3aed' },
    'Yamile':      { border: 'rgba(6,182,212,0.35)',  header: '#67e8f9', dot: '#0891b2' },
    'Wilson':      { border: 'rgba(249,115,22,0.35)', header: '#fb923c', dot: '#ea580c' },
    'Cristina':    { border: 'rgba(236,72,153,0.35)', header: '#f9a8d4', dot: '#db2777' },
  };

  // Resumen por satélite
  contResumen.innerHTML = SATELITES.map(s => {
    const entregado = satMovimientos.filter(m => m.satelite === s && m.tipo === 'entrega').reduce((a, m) => a + m.cantidad, 0);
    const recibido  = satMovimientos.filter(m => m.satelite === s && m.tipo === 'recepcion').reduce((a, m) => a + m.cantidad, 0);
    const pendiente = Math.max(0, entregado - recibido);
    const col = SAT_COLORS[s] || { border: 'rgba(255,255,255,0.1)', header: '#94a3b8', dot: '#64748b' };

    // Prendas pendientes por tipo
    const prendasMap = {};
    satMovimientos.filter(m => m.satelite === s).forEach(m => {
      const p = m.prenda || 'Sin tipo';
      if (!prendasMap[p]) prendasMap[p] = 0;
      prendasMap[p] += m.tipo === 'entrega' ? m.cantidad : -m.cantidad;
    });
    const prendasPend = Object.entries(prendasMap).filter(([, v]) => v > 0);
    const prendasHtml = prendasPend.length
      ? `<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.07);padding-top:6px;">
          ${prendasPend.map(([p, v]) => `<div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text-muted);padding:1px 0;"><span>${esc(p)}</span><span style="color:var(--text);font-weight:600;">${v}</span></div>`).join('')}
         </div>`
      : '';

    return `
      <div class="sat-card" style="border-color:${col.border};">
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
      </div>
    `;
  }).join('');

  // Lista de movimientos recientes
  if (!satMovimientos.length) {
    contLista.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:0.8rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);">Sin movimientos registrados</div>`;
    return;
  }

  contLista.innerHTML = `
    <div class="cal-semana-header" style="color:var(--text-muted);">Movimientos recientes</div>
    ${satMovimientos.slice(0, 40).map(m => `
      <div class="sat-item ${m.tipo}">
        <span style="font-size:1.1rem;">${m.tipo === 'entrega' ? '📦' : '✅'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.satelite)} — ${esc(m.equipo)}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);">${esc(m.prenda)} · ${m.fecha} ${m.hora}</div>
        </div>
        <span class="sat-tipo-badge" style="${m.tipo === 'entrega' ? 'background:rgba(6,182,212,0.15);color:#67e8f9;border:1px solid rgba(6,182,212,0.3);' : 'background:rgba(16,185,129,0.15);color:#4ade80;border:1px solid rgba(16,185,129,0.3);'}">${m.tipo === 'entrega' ? '+' : '-'}${m.cantidad}</span>
      </div>
    `).join('')}
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

function generarPDF() {
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
  const esCot  = docTipo === 'cotizacion';
  const titulo = esCot ? 'COTIZACION' : 'FACTURA';
  const color1 = '#c8a96e';
  const color2 = '#f5e6c8';

  const filasItems = docItems.filter(it => it.desc).map(it => {
    const tot = it.cant * it.precio;
    return `<tr>
      <td style="text-align:center;padding:10px 6px;font-size:13px;font-weight:700;color:#c8501a;">${it.cant}</td>
      <td style="text-align:center;padding:10px 6px;font-size:13px;font-weight:700;text-transform:uppercase;">${esc(it.desc)}</td>
      <td style="text-align:center;padding:10px 6px;font-size:12px;">${fmtPesoNum(it.precio)}</td>
      <td style="text-align:center;padding:10px 6px;font-size:12px;">${fmtPesoNum(tot)}</td>
    </tr>`;
  }).join('');

  const itemsValidos = docItems.filter(it => it.desc).length;
  const filasVacias  = Array.from({ length: Math.max(0, 4 - itemsValidos) })
    .map(() => `<tr><td style="padding:10px 6px;">&nbsp;</td><td></td><td></td><td></td></tr>`).join('');

  const abonoFila = !esCot ? `<tr>
    <td colspan="2"></td>
    <td style="text-align:right;font-weight:600;padding:6px 6px;">ABONO:</td>
    <td style="text-align:center;padding:6px 6px;">
      <span style="background:${color1};color:white;padding:2px 10px;border-radius:3px;font-weight:700;">${abono > 0 ? fmtPesoNum(abono) : '0'}</span>
    </td>
  </tr>` : '';

  const notaCot = esCot ? `<div style="margin-top:16px;font-size:11px;line-height:1.8;">
    <strong style="text-transform:uppercase;font-size:12px;">NOTA:</strong><br>
    TELA<br>
    microfibra poliéster semilicrado 8005 &nbsp;brillo sauvidad y resistente<br><br>
    BONOS<br>
    por compra de 35 uniformes obsequiamos bandera 1mtr x 1.50<br>
    por compra de +100 uniformes obsequiamos descuento del 5%
  </div>` : '';

  const htmlDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${titulo} #${numStr}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:12px;color:#333;background:white}
  .page{width:800px;margin:0 auto;padding:30px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
  .empresa-info{font-size:11px;line-height:1.7}
  .titulo-doc h1{font-size:32px;color:${color1};font-weight:900;letter-spacing:2px;text-align:right}
  .titulo-doc .num{font-size:22px;font-weight:700;color:#555;text-align:right}
  hr{border:none;border-top:1px solid #ddd;margin:14px 0}
  .campo{color:#999;min-width:60px;display:inline-block}
  table{width:100%;border-collapse:collapse}
  thead tr{background:${color1}}
  thead th{padding:8px 6px;font-size:11px;font-weight:700;color:white;text-transform:uppercase;text-align:center}
  tbody tr:nth-child(even){background:${color2}}
  tbody tr{border-bottom:1px solid #e8d8b8}
  .footer-text{text-align:center;font-size:9.5px;font-weight:700;margin:16px 0 10px;text-transform:uppercase;line-height:1.6}
  .cuentas{display:flex;justify-content:space-around;margin-top:10px}
  .cuenta{text-align:center;font-size:10px;line-height:1.7}
  .cuenta strong{font-size:11px;text-transform:uppercase}
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <img src="${LOGO_WYS}" style="height:90px;width:auto;" alt="W&S">
      <div class="empresa-info" style="margin-top:8px;">
        <strong>W&S DEPORTIVO</strong><br>
        1030675743-0<br>
        CARRERA 90A # 4-40<br>
        Bogotá D.C<br>
        (350) 697-4711<br>
        301 663 94 30
      </div>
    </div>
    <div class="titulo-doc">
      <h1>${titulo}</h1>
      <div class="num"># ${numStr}</div>
      <div style="text-align:right;font-size:11px;margin-top:10px;">
        Fecha: ${fecha}<br>
        <strong>VENDEDOR: ${esc(vendedora)}</strong>
      </div>
    </div>
  </div>

  <hr>

  <div style="margin-bottom:16px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;font-weight:700;margin-bottom:6px;">Cliente</div>
    <div style="font-size:11px;line-height:1.8;">
      <span class="campo">Nombre</span> ${esc(cliente)}<br>
      <span class="campo">Teléfono</span> ${telefono || '—'}<br>
      ${nit ? `<span class="campo">NIT/CC</span> ${nit}<br>` : ''}
      ${correo ? `<span class="campo">Correo</span> ${correo}<br>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:80px">CANTIDAD</th>
        <th>DESCRIPCION</th>
        <th style="width:110px">PRECIO</th>
        <th style="width:110px">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${filasItems}
      ${filasVacias}
      <tr>
        <td colspan="2"></td>
        <td style="text-align:right;font-weight:600;padding:8px 6px;">SUBTOTAL:</td>
        <td style="text-align:center;font-weight:700;padding:8px 6px;">${fmtPesoNum(subtotal)}</td>
      </tr>
      ${abonoFila}
      <tr style="background:${color2};">
        <td colspan="2"></td>
        <td style="text-align:right;font-weight:800;font-size:13px;padding:8px 6px;">TOTAL:</td>
        <td style="text-align:center;font-weight:800;font-size:14px;padding:8px 6px;">${fmtPesoNum(total)}</td>
      </tr>
    </tbody>
  </table>

  <div class="footer-text">
    UNIFORME DE NIÑO VALE 5.000 PESOS MENOS QUE EL UNIFORME DE ADULTO<br>
    SE LE INFORMA A LOS CLIENTES QUE PARA INICIAR EL PEDIDO DEBE COMENZAR CON EL 50% DEL PEDIDO
  </div>

  <div style="text-align:center;font-weight:700;font-size:12px;margin-bottom:10px;">CUENTAS DE CONSIGNACION</div>

  <div class="cuentas">
    <div class="cuenta">
      <strong>BANCOLOMBIA</strong><br>
      ${CUENTAS_BANCOLOMBIA[docCuenta].num}<br>
      ${CUENTAS_BANCOLOMBIA[docCuenta].nombre}<br>
      ${CUENTAS_BANCOLOMBIA[docCuenta].cc}<br>
      ${CUENTAS_BANCOLOMBIA[docCuenta].tipo}
    </div>
    <div class="cuenta">
      <strong>NEQUI</strong><br>
      350 697 47 11<br>
      301 663 94 30
    </div>
    <div class="cuenta">
      <strong>DAVIPLATA</strong><br>
      350 697 47 11<br>
      301 663 94 30
    </div>
  </div>

  ${notaCot}
</div>
</body>
</html>`;

  // Guardar en historial
  const registro = {
    id: Date.now(), tipo: docTipo, numero: numStr, cliente, vendedora, telefono,
    subtotal, abono, total, fecha, cuenta: docCuenta,
    items: docItems.filter(it => it.desc).map(it => ({...it})),
  };
  docHistorial.unshift(registro);
  if (docHistorial.length > 50) docHistorial = docHistorial.slice(0, 50);
  if (docTipo === 'cotizacion') nextCot++; else nextFac++;
  guardarDocs();
  renderDocHistorial();

  const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 1200);
  else window.location.href = url; // fallback celular bloqueó popup

  toast(titulo + ' #' + numStr + ' generada', 'success');
  cerrarFormDoc();
}

function renderDocHistorial() {
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
  const titulo  = esCot ? 'COTIZACION' : 'FACTURA';
  const color1  = '#c8a96e';
  const color2  = '#f5e6c8';

  const filasItems = d.items.filter(it => it.desc).map(it => {
    const tot = (it.cant || 1) * (it.precio || 0);
    return `<tr>
      <td style="text-align:center;padding:10px 6px;font-size:13px;font-weight:700;color:#c8501a;">${it.cant}</td>
      <td style="text-align:center;padding:10px 6px;font-size:13px;font-weight:700;text-transform:uppercase;">${esc(it.desc)}</td>
      <td style="text-align:center;padding:10px 6px;font-size:12px;">${fmtPesoNum(it.precio || 0)}</td>
      <td style="text-align:center;padding:10px 6px;font-size:12px;">${fmtPesoNum(tot)}</td>
    </tr>`;
  }).join('');

  const itemsValidos = d.items.filter(it => it.desc).length;
  const filasVacias  = Array.from({ length: Math.max(0, 4 - itemsValidos) })
    .map(() => `<tr><td style="padding:10px 6px;">&nbsp;</td><td></td><td></td><td></td></tr>`).join('');

  const abonoFila = !esCot && d.abono > 0 ? `<tr>
    <td colspan="2"></td>
    <td style="text-align:right;font-weight:600;padding:6px 6px;">ABONO:</td>
    <td style="text-align:center;padding:6px 6px;">
      <span style="background:${color1};color:white;padding:2px 10px;border-radius:3px;font-weight:700;">${fmtPesoNum(d.abono)}</span>
    </td>
  </tr>` : '';

  const notaCot = esCot ? `<div style="margin-top:16px;font-size:11px;line-height:1.8;">
    <strong style="text-transform:uppercase;font-size:12px;">NOTA:</strong><br>
    TELA<br>
    microfibra poliéster semilicrado 8005 &nbsp;brillo sauvidad y resistente<br><br>
    BONOS<br>
    por compra de 35 uniformes obsequiamos bandera 1mtr x 1.50<br>
    por compra de +100 uniformes obsequiamos descuento del 5%
  </div>` : '';

  // Cuenta bancolombia (usar la seleccionada actualmente, o la 1 por defecto)
  const cta = CUENTAS_BANCOLOMBIA[d.cuenta || docCuenta || 1];

  return `<!DOCTYPE html><html style="background:white;"><head><meta charset="UTF-8"><title>${titulo} #${d.numero}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{font-family:Arial,sans-serif;font-size:12px;color:#333 !important;background:white !important;color-scheme:light !important}
  .page{width:800px;margin:0 auto;padding:30px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
  .empresa-info{font-size:11px;line-height:1.7}
  .titulo-doc h1{font-size:32px;color:${color1};font-weight:900;letter-spacing:2px;text-align:right}
  .titulo-doc .num{font-size:22px;font-weight:700;color:#555;text-align:right}
  hr{border:none;border-top:1px solid #ddd;margin:14px 0}
  .campo{color:#999;min-width:60px;display:inline-block}
  table{width:100%;border-collapse:collapse}
  thead tr{background:${color1}}
  thead th{padding:8px 6px;font-size:11px;font-weight:700;color:white;text-transform:uppercase;text-align:center}
  tbody tr:nth-child(even){background:${color2}}
  tbody tr{border-bottom:1px solid #e8d8b8}
  .footer-text{text-align:center;font-size:9.5px;font-weight:700;margin:16px 0 10px;text-transform:uppercase;line-height:1.6}
  .cuentas{display:flex;justify-content:space-around;margin-top:10px}
  .cuenta{text-align:center;font-size:10px;line-height:1.7}
  .cuenta strong{font-size:11px;text-transform:uppercase}
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="page">
  <div class="header">
    <div>
      <div class="empresa-info">
        <strong>W&S DEPORTIVO</strong><br>1030675743-0<br>CARRERA 90A # 4-40<br>Bogotá D.C<br>(350) 697-4711<br>301 663 94 30
      </div>
    </div>
    <div class="titulo-doc">
      <h1>${titulo}</h1>
      <div class="num"># ${d.numero}</div>
      <div style="text-align:right;font-size:11px;margin-top:10px;">
        Fecha: ${d.fecha}<br><strong>VENDEDOR: ${esc(d.vendedora)}</strong>
      </div>
    </div>
  </div>
  <hr>
  <div style="margin-bottom:16px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;font-weight:700;margin-bottom:6px;">Cliente</div>
    <div style="font-size:11px;line-height:1.8;">
      <span class="campo">Nombre</span> ${esc(d.cliente)}<br>
      ${d.telefono ? `<span class="campo">Teléfono</span> ${d.telefono}<br>` : ''}
    </div>
  </div>
  <table>
    <thead><tr>
      <th style="width:80px">CANTIDAD</th><th>DESCRIPCION</th>
      <th style="width:110px">PRECIO</th><th style="width:110px">TOTAL</th>
    </tr></thead>
    <tbody>
      ${filasItems}${filasVacias}
      <tr><td colspan="2"></td>
        <td style="text-align:right;font-weight:600;padding:8px 6px;">SUBTOTAL:</td>
        <td style="text-align:center;font-weight:700;padding:8px 6px;">${fmtPesoNum(d.subtotal)}</td>
      </tr>
      ${abonoFila}
      <tr style="background:${color2};">
        <td colspan="2"></td>
        <td style="text-align:right;font-weight:800;font-size:13px;padding:8px 6px;">TOTAL:</td>
        <td style="text-align:center;font-weight:800;font-size:14px;padding:8px 6px;">${fmtPesoNum(d.total)}</td>
      </tr>
    </tbody>
  </table>
  <div class="footer-text">
    UNIFORME DE NIÑO VALE 5.000 PESOS MENOS QUE EL UNIFORME DE ADULTO<br>
    SE LE INFORMA A LOS CLIENTES QUE PARA INICIAR EL PEDIDO DEBE COMENZAR CON EL 50% DEL PEDIDO
  </div>
  <div style="text-align:center;font-weight:700;font-size:12px;margin-bottom:10px;">CUENTAS DE CONSIGNACION</div>
  <div class="cuentas">
    <div class="cuenta"><strong>BANCOLOMBIA</strong><br>${cta.num}<br>${cta.nombre}<br>${cta.cc}<br>${cta.tipo}</div>
    <div class="cuenta"><strong>NEQUI</strong><br>350 697 47 11<br>301 663 94 30</div>
    <div class="cuenta"><strong>DAVIPLATA</strong><br>350 697 47 11<br>301 663 94 30</div>
  </div>
  ${notaCot}
</div></body></html>`;
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

// Hook showSection para renderizar historial al abrir la sección
(function() {
  const _orig = showSection;
  showSection = function(id, navEl) {
    _orig(id, navEl);
    if (id === 'cotizaciones') { cargarDocsServidor(); renderDocHistorial(); }
    if (id === 'arreglos')     { sincronizarArreglosServidor(); }
    if (id === 'satelites')    { sincronizarSatelitesServidor(); }
  };
})();

// Sync inicial con servidor para todos los módulos
setTimeout(cargarDocsServidor, 1500);
setTimeout(sincronizarArreglosServidor, 2000);
setTimeout(sincronizarSatelitesServidor, 2500);

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

// Cargar pendientes al abrir la sección calandra
(function() {
  const _origCalandra = showSection;
  showSection = function(id, navEl) {
    _origCalandra(id, navEl);
    if (id === 'calandra') cargarPendientesWT();
  };
})();

setTimeout(cargarPendientesWT, 3000);