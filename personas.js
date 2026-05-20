// ═══════════════════════════════════════════════════════════════
// personas.js — Roster de personas de W&S Textil
// Base para "cada persona tiene su app" + historial "quién hizo qué"
// Slugs en kebab-case sin tildes; usados en URLs personales.
// ═══════════════════════════════════════════════════════════════

const PERSONAS = [
  // Ventas + diseño
  { slug: 'ney',        nombre: 'Ney',        roles: ['ventas', 'diseno'],         emoji: '💼', color: '#34d399', vistaInicial: '/#/ventas' },
  { slug: 'wendy',      nombre: 'Wendy',      roles: ['ventas', 'diseno'],         emoji: '💼', color: '#60a5fa', vistaInicial: '/#/ventas' },
  { slug: 'paola',      nombre: 'Paola',      roles: ['ventas', 'diseno'],         emoji: '💼', color: '#f472b6', vistaInicial: '/#/ventas' },

  // Ventas + producción
  { slug: 'betty',      nombre: 'Betty',      roles: ['ventas', 'produccion'],     emoji: '💼', color: '#fb923c', vistaInicial: '/#/ventas' },

  // Admin + diseño
  { slug: 'camilo',     nombre: 'Camilo',     roles: ['admin', 'diseno'],          emoji: '👤', color: '#a78bfa', vistaInicial: '/#/movil' },

  // Admin jefe
  { slug: 'graciela',   nombre: 'Graciela',   roles: ['admin'],                    emoji: '👑', color: '#c4b5fd', vistaInicial: '/#/movil' },

  // Producción + corte
  { slug: 'lidermeyer', nombre: 'Lidermeyer', roles: ['produccion', 'corte'],      emoji: '✂️', color: '#f59e0b', vistaInicial: '/#/produccion' },

  // Costura (satélites)
  { slug: 'marcela',    nombre: 'Marcela',    roles: ['costura'],                  emoji: '🧵', color: '#ec4899', vistaInicial: '/#/costura/marcela' },
  { slug: 'cristina',   nombre: 'Cristina',   roles: ['costura'],                  emoji: '🧵', color: '#8b5cf6', vistaInicial: '/#/costura/cristina' },
  { slug: 'wilson',     nombre: 'Wilson',     roles: ['costura'],                  emoji: '🧵', color: '#3b82f6', vistaInicial: '/#/costura/wilson' },
  { slug: 'yamile',     nombre: 'Yamile',     roles: ['costura'],                  emoji: '🧵', color: '#06b6d4', vistaInicial: '/#/costura/yamile' },
];

const PERSONAS_BY_SLUG = Object.fromEntries(PERSONAS.map(p => [p.slug, p]));

function getPersona(slug) {
  if (!slug) return null;
  return PERSONAS_BY_SLUG[String(slug).toLowerCase()] || null;
}

function manifestParaPersona(persona) {
  const startUrl = persona.vistaInicial || '/#/movil';
  return {
    name: `W&S ${persona.nombre}`,
    short_name: persona.nombre,
    description: `App de ${persona.nombre} — W&S Textil`,
    start_url: startUrl,
    id: `/app/${persona.slug}`,
    display: 'standalone',
    background_color: '#0f1117',
    theme_color: persona.color,
    scope: '/',
    orientation: 'portrait-primary',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}

module.exports = { PERSONAS, PERSONAS_BY_SLUG, getPersona, manifestParaPersona };
