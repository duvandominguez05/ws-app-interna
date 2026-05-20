// ═══════════════════════════════════════════════════════════════
// persona-shim.js — Identidad de la persona en cada request
// Carga ANTES de app.js. Hace 2 cosas:
//   1. Sobrescribe window.fetch para añadir X-Ws-Persona en cada
//      llamada a /api/ con el slug guardado en localStorage.
//   2. Expone window.WS_PERSONA con los datos de la persona actual.
// ═══════════════════════════════════════════════════════════════
(function () {
  function getSlug() {
    try { return localStorage.getItem('ws_persona') || ''; } catch (e) { return ''; }
  }
  function getNombre() {
    try { return localStorage.getItem('ws_persona_nombre') || ''; } catch (e) { return ''; }
  }

  window.WS_PERSONA = {
    get slug() { return getSlug(); },
    get nombre() { return getNombre(); },
    set: function (slug, nombre) {
      try {
        localStorage.setItem('ws_persona', slug || '');
        localStorage.setItem('ws_persona_nombre', nombre || '');
      } catch (e) {}
    },
    clear: function () {
      try {
        localStorage.removeItem('ws_persona');
        localStorage.removeItem('ws_persona_nombre');
      } catch (e) {}
    },
  };

  // Si la URL trae ?persona=marcela, guardarla (atajo para QR / links compartidos)
  try {
    var u = new URL(window.location.href);
    var fromUrl = u.searchParams.get('persona');
    if (fromUrl) {
      localStorage.setItem('ws_persona', fromUrl);
    }
  } catch (e) {}

  // Si entra por /#/costura/{slug}, fijar persona automáticamente
  try {
    var h = window.location.hash || '';
    var m = h.match(/^#\/costura\/([a-z0-9_-]+)/i);
    if (m && m[1]) {
      var current = localStorage.getItem('ws_persona') || '';
      if (current !== m[1]) localStorage.setItem('ws_persona', m[1].toLowerCase());
    }
  } catch (e) {}

  var originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // Solo tocar requests a nuestro propio backend /api/
    var esApiInterna = url.indexOf('/api/') === 0 || url.indexOf(window.location.origin + '/api/') === 0;
    if (!esApiInterna) return originalFetch(input, init);

    var slug = getSlug();
    if (!slug) return originalFetch(input, init);

    init = init || {};
    var headers = new Headers(init.headers || (input && input.headers) || {});
    if (!headers.has('X-Ws-Persona')) headers.set('X-Ws-Persona', slug);
    init.headers = headers;
    return originalFetch(input, init);
  };
})();
