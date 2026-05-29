// ═══════════════════════════════════════════════════════════════
// personas.js — Roster de personas de W&S Textil
// Base para "cada persona tiene su app" + historial "quién hizo qué"
// Slugs en kebab-case sin tildes; usados en URLs personales.
// ═══════════════════════════════════════════════════════════════

// vistaInicial: TODOS van a /#/mi-dia (vista unificada multi-rol).
// Mi Día arma los bloques según los roles de cada persona.
const PERSONAS = [
  // Ventas + diseño
  { slug: 'ney',        nombre: 'Ney',        roles: ['ventas', 'diseno'],         emoji: '💼', color: '#34d399', vistaInicial: '/#/mi-dia' },
  { slug: 'wendy',      nombre: 'Wendy',      roles: ['ventas', 'diseno'],         emoji: '💼', color: '#60a5fa', vistaInicial: '/#/mi-dia' },
  { slug: 'paola',      nombre: 'Paola',      roles: ['ventas', 'diseno'],         emoji: '💼', color: '#f472b6', vistaInicial: '/#/mi-dia' },

  // Ventas + producción
  { slug: 'betty',      nombre: 'Betty',      roles: ['ventas', 'produccion'],     emoji: '💼', color: '#fb923c', vistaInicial: '/#/mi-dia' },

  // Admin + diseño
  { slug: 'camilo',     nombre: 'Camilo',     roles: ['admin', 'diseno'],          emoji: '👤', color: '#a78bfa', vistaInicial: '/#/mi-dia' },

  // Diseñador full-time (nuevo, solo diseña, no admin)
  { slug: 'oscar',      nombre: 'Oscar',      roles: ['diseno'],                   emoji: '🎨', color: '#fbbf24', vistaInicial: '/#/mi-dia' },

  // Admin jefe
  { slug: 'graciela',   nombre: 'Graciela',   roles: ['admin'],                    emoji: '👑', color: '#c4b5fd', vistaInicial: '/#/mi-dia' },

  // Producción + corte
  { slug: 'lidermeyer', nombre: 'Lidermeyer', roles: ['produccion', 'corte'],      emoji: '✂️', color: '#f59e0b', vistaInicial: '/#/mi-dia' },

  // Costura (satélites)
  { slug: 'marcela',    nombre: 'Marcela',    roles: ['costura'],                  emoji: '🧵', color: '#ec4899', vistaInicial: '/c/marcela' },
  { slug: 'cristina',   nombre: 'Cristina',   roles: ['costura'],                  emoji: '🧵', color: '#8b5cf6', vistaInicial: '/c/cristina' },
  { slug: 'wilson',     nombre: 'Wilson',     roles: ['costura'],                  emoji: '🧵', color: '#3b82f6', vistaInicial: '/c/wilson' },
  { slug: 'yamile',     nombre: 'Yamile',     roles: ['costura'],                  emoji: '🧵', color: '#06b6d4', vistaInicial: '/c/yamile' },
  { slug: 'nicol',      nombre: 'Nicol',      roles: ['costura'],                  emoji: '🧵', color: '#10b981', vistaInicial: '/c/nicol' },
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
