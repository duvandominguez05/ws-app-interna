// ═══════════════════════════════════════════════════════════════════
// VIGILANTE W&S — corre oculto en cada PC de diseñador
//
// Que hace:
//   1. Auto-detecta carpetas corel/PDF RIP/CATALOGO en Google Drive local
//   2. Vigila eventos (archivo nuevo, modificado)
//   3. Reporta al servidor Railway con identificacion de la PC
//
// Setup inicial (una sola vez):
//   - Al primer arranque, abre una ventana de consola pidiendo "quien eres"
//   - Guarda config en %APPDATA%\ws-vigilante\config.json
//   - Despues queda oculto + auto-start
//
// Instalacion:
//   1. Doble click al .exe
//   2. Identificas la PC
//   3. Listo, ya queda en auto-start
// ═══════════════════════════════════════════════════════════════════

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { exec } = require('child_process');

const VERSION = '2.0.0';
const SERVER_URL = process.env.WS_VIGILANTE_URL || 'https://ws-app-interna-production.up.railway.app';
const ENDPOINT = '/api/agente-evento';
const ENDPOINT_ACTIVIDAD = '/api/agente-actividad';
const CONFIG_DIR = path.join(process.env.APPDATA || os.homedir(), 'ws-vigilante');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'vigilante.log');

// Intervalos
const INTERVALO_SNAPSHOT_MS = 30 * 1000; // cada 30 seg
const INTERVALO_HEARTBEAT_MS = 60 * 60 * 1000; // cada 1 hora

// Procesos que queremos detectar (nombres del ejecutable)
const PROCESOS_DISEÑO = {
  'CorelDRW.exe': 'corel',
  'CorelDraw.exe': 'corel',
  'Coreldrw.exe': 'corel',
  'Photoshop.exe': 'photoshop',
  'Illustrator.exe': 'illustrator',
  'chrome.exe': 'chrome',
  'msedge.exe': 'edge',
  'firefox.exe': 'firefox',
  'WhatsApp.exe': 'whatsapp',
  'WhatsApp.exe.WerFault.exe': 'whatsapp',
  'rip.exe': 'rip',
};

// Nombres de carpeta que vamos a buscar (case-insensitive)
const CARPETAS_OBJETIVO = ['corel', 'pdf rip', 'catalogo'];

// Personas validas
const PERSONAS = ['Oscar', 'Wendy', 'Ney', 'Paola', 'Camilo'];

// ───────────────────────────────────────────────────────────────────
// LOGGING
// ───────────────────────────────────────────────────────────────────
function log(...args) {
  const linea = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, linea + '\n');
  } catch {}
  // En consola solo si no esta empaquetado o si --verbose
  if (process.env.WS_VIGILANTE_VERBOSE === '1') {
    console.log(linea);
  }
}

// ───────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────
function leerConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function guardarConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ───────────────────────────────────────────────────────────────────
// AUTO-DETECCION DE CARPETAS DRIVE
// Busca recursivamente desde unidades comunes (C:, D:, E:, F:, G:, H:, I:, J:)
// las carpetas corel/PDF RIP/CATALOGO bajo "Mi unidad" o cualquier path.
// ───────────────────────────────────────────────────────────────────
function buscarCarpetasDrive() {
  const encontradas = {};
  const candidatos = [];

  // Windows: probar unidades de letra
  if (process.platform === 'win32') {
    for (const letra of 'CDEFGHIJKLM') {
      candidatos.push(`${letra}:\\Mi unidad`);
      candidatos.push(`${letra}:\\My Drive`);
      candidatos.push(`${letra}:\\`);
    }
    // Tambien dentro de %USERPROFILE%
    const userProfile = process.env.USERPROFILE || os.homedir();
    candidatos.push(path.join(userProfile, 'Google Drive', 'Mi unidad'));
    candidatos.push(path.join(userProfile, 'Mi unidad'));
    candidatos.push(path.join(userProfile, 'GoogleDrive'));
  } else {
    // Mac/Linux fallback
    candidatos.push(path.join(os.homedir(), 'Google Drive', 'Mi unidad'));
    candidatos.push(path.join(os.homedir(), 'Library', 'CloudStorage'));
  }

  for (const base of candidatos) {
    if (!fs.existsSync(base)) continue;
    try {
      buscarRecursivo(base, encontradas, 4); // profundidad max 4 niveles
    } catch {}
    if (Object.keys(encontradas).length === CARPETAS_OBJETIVO.length) break;
  }

  return encontradas;
}

function buscarRecursivo(dir, encontradas, profundidadRestante) {
  if (profundidadRestante <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const nombreLower = ent.name.toLowerCase();
    const fullPath = path.join(dir, ent.name);
    // Match exacto con cualquiera de los objetivos
    for (const objetivo of CARPETAS_OBJETIVO) {
      if (nombreLower === objetivo && !encontradas[objetivo]) {
        encontradas[objetivo] = fullPath;
      }
    }
    if (Object.keys(encontradas).length === CARPETAS_OBJETIVO.length) return;
    // Recursar en subcarpetas (saltea carpetas conocidas que no nos interesan)
    if (!/^(node_modules|\.|temp|tmp|cache|appdata|windows|program files)/i.test(ent.name)) {
      buscarRecursivo(fullPath, encontradas, profundidadRestante - 1);
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// SETUP INICIAL (interactivo, 1 sola vez)
// ───────────────────────────────────────────────────────────────────
async function setupInicial() {
  console.log('═══════════════════════════════════════════');
  console.log('  VIGILANTE W&S — configuracion inicial');
  console.log('═══════════════════════════════════════════');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pregunta = (q) => new Promise(r => rl.question(q, r));

  // 1. Identificacion
  console.log('Quien usa esta PC?');
  PERSONAS.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  let persona = null;
  while (!persona) {
    const ans = (await pregunta('Numero (1-5): ')).trim();
    const idx = parseInt(ans, 10);
    if (idx >= 1 && idx <= PERSONAS.length) persona = PERSONAS[idx - 1];
    else console.log('Opcion invalida, prueba de nuevo.');
  }

  // 2. Auto-detectar carpetas
  console.log('');
  console.log('Buscando carpetas corel/PDF RIP/CATALOGO en Drive...');
  const carpetas = buscarCarpetasDrive();
  console.log('Encontradas:');
  CARPETAS_OBJETIVO.forEach(obj => {
    if (carpetas[obj]) console.log(`  [OK] ${obj.padEnd(10)} -> ${carpetas[obj]}`);
    else console.log(`  [??] ${obj.padEnd(10)} -> NO ENCONTRADA`);
  });

  // 3. Si falta alguna, pedir manual
  for (const obj of CARPETAS_OBJETIVO) {
    if (carpetas[obj]) continue;
    console.log('');
    const ruta = (await pregunta(`Ruta completa de carpeta "${obj}" (ej H:\\Mi unidad\\DISEÑO\\corel): `)).trim();
    if (ruta && fs.existsSync(ruta)) {
      carpetas[obj] = ruta;
    } else {
      console.log(`  [SKIP] no se vigilara "${obj}"`);
    }
  }

  rl.close();

  const cfg = {
    version: VERSION,
    persona,
    hostname: os.hostname(),
    plataforma: process.platform + '-' + os.release(),
    carpetas,
    instaladoEn: new Date().toISOString(),
  };
  guardarConfig(cfg);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  Configuracion guardada en:');
  console.log('  ' + CONFIG_PATH);
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('El vigilante ahora va a correr OCULTO.');
  console.log('Auto-start configurandose...');
  return cfg;
}

// ───────────────────────────────────────────────────────────────────
// SNAPSHOT DE ACTIVIDAD — captura cada 30 seg lo que esta haciendo la PC.
//
// Captura:
//   - Procesos activos con titulos de ventanas (Corel, Photoshop, Illustrator, Chrome, WhatsApp)
//   - Para Corel/PS/AI: extrae nombre del archivo abierto
//   - Para Chrome: detecta tabs con WhatsApp Web (con cliente) y WeTransfer
//   - Para WhatsApp Desktop: detecta chat activo
//
// Envia al servidor consolidado en un POST cada 30 seg.
// ───────────────────────────────────────────────────────────────────
function execPromise(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(stdout || '');
    });
  });
}

// Parsea salida CSV de tasklist /v
function parsearTasklistCSV(csv) {
  const lineas = csv.split(/\r?\n/).filter(Boolean);
  const procesos = [];
  for (const linea of lineas) {
    // CSV con comillas: "Imagen","PID","Sesion","Sesion#","Memoria","Estado","Usuario","CPU","Titulo"
    const partes = linea.match(/"([^"]*)"/g);
    if (!partes || partes.length < 9) continue;
    const limpios = partes.map(p => p.replace(/^"|"$/g, ''));
    const imagen = limpios[0];
    const titulo = limpios[8] || '';
    if (!titulo || titulo === 'N/A' || titulo === 'N/D' || titulo === 'N/V') continue;
    procesos.push({ imagen, titulo });
  }
  return procesos;
}

// Extrae nombre de archivo de un titulo tipico de Corel/PS/AI
//  - "CorelDRAW 2024 - [almany_v3.cdr]"
//  - "almany_v3.cdr - CorelDRAW Graphics Suite 2024"
//  - "Photoshop - escudo.psd"
//  - "Adobe Illustrator - <archivo>"
function extraerArchivoDeTitulo(titulo, programa) {
  if (!titulo) return null;
  const t = titulo.replace(/\s+/g, ' ').trim();
  // Patron 1: [archivo.ext]
  let m = t.match(/\[([^\]]+\.(cdr|psd|ai|eps|svg|png|jpg|jpeg|pdf))\]/i);
  if (m) return m[1];
  // Patron 2: archivo.ext - Programa
  m = t.match(/([^\\\/:*?"<>|\r\n]+\.(cdr|psd|ai|eps|svg|pdf))\s*[-–]\s*(CorelDRAW|Photoshop|Illustrator|Adobe)/i);
  if (m) return m[1];
  // Patron 3: Programa - archivo.ext
  m = t.match(/(CorelDRAW|Photoshop|Illustrator|Adobe)[^-]*[-–]\s*([^\\\/:*?"<>|\r\n]+\.(cdr|psd|ai|eps|svg|pdf))/i);
  if (m) return m[2];
  // Patron 4: solo archivo.ext en titulo
  m = t.match(/([^\\\/:*?"<>|\r\n]+\.(cdr|psd|ai|eps|svg))/i);
  if (m) return m[1];
  return null;
}

// Filtro de privacidad: solo titulos de Chrome relacionados al trabajo W&S.
// NO se mandan al servidor titulos de navegacion personal del disenador.
function esTituloRelevante(titulo) {
  if (!titulo) return false;
  const t = titulo.toLowerCase();
  return /(whatsapp|wetransfer|drive\.google|\bdrive\b|corel|photoshop|illustrator|\.cdr|\.psd|\.ai|\.pdf|gmail|mi unidad|my drive)/.test(t);
}

// Detecta si un titulo de Chrome es WhatsApp Web con cliente
// Ejemplos:
//   "Manuel Bustamante (3104999999) - WhatsApp - Google Chrome"
//   "Almany FC - WhatsApp - Google Chrome"
//   "WhatsApp - Google Chrome"  (sin chat activo)
function extraerChatWhatsApp(titulo) {
  if (!titulo) return null;
  const t = titulo.trim();
  // Regex: cualquier cosa antes de " - WhatsApp"
  const m = t.match(/^(.+?)\s*[-–]\s*WhatsApp/i);
  if (!m) return null;
  const chat = m[1].trim();
  if (!chat || /^WhatsApp/i.test(chat)) return null;
  // Extraer telefono si esta entre parentesis
  let telefono = null;
  const tel = chat.match(/\(?(\+?\d[\d\s().-]{6,})\)?/);
  if (tel) telefono = tel[1].replace(/\D/g, '');
  // Nombre = sin el telefono
  const nombre = chat.replace(/\s*\(?\+?\d[\d\s().-]{6,}\)?\s*/g, '').trim() || null;
  return { chat, nombre, telefono };
}

// Detecta WeTransfer en titulo de Chrome
function esWeTransfer(titulo) {
  if (!titulo) return false;
  return /wetransfer/i.test(titulo);
}

// State interno de tracking
let _wtAbierto = { activo: false, desde: 0 };
let _archivoCorelPrev = null;
let _archivoCorelDesde = 0;

async function capturarSnapshot(cfg) {
  if (process.platform !== 'win32') return null;
  // tasklist /V /FO CSV /NH = sin header, CSV con titulos
  const csv = await execPromise('tasklist /V /FO CSV /NH');
  if (!csv) return null;
  const procesos = parsearTasklistCSV(csv);

  const programasActivos = new Set();
  const archivosAbiertos = []; // {programa, archivo, titulo}
  const chatsWhatsApp = []; // {chat, nombre, telefono, fuente}
  let weTransferAbierto = false;

  for (const { imagen, titulo } of procesos) {
    const prog = PROCESOS_DISEÑO[imagen] || PROCESOS_DISEÑO[imagen.toLowerCase()];
    if (prog) programasActivos.add(prog);

    if (prog === 'corel' || prog === 'photoshop' || prog === 'illustrator') {
      const archivo = extraerArchivoDeTitulo(titulo, prog);
      if (archivo) archivosAbiertos.push({ programa: prog, archivo, titulo });
    }
    if (prog === 'chrome' || prog === 'edge' || prog === 'firefox') {
      // Filtro privacidad: solo procesamos titulos relacionados a W&S
      if (!esTituloRelevante(titulo)) continue;
      // Verifica chat WhatsApp Web
      const chat = extraerChatWhatsApp(titulo);
      if (chat) chatsWhatsApp.push({ ...chat, fuente: 'whatsapp-web' });
      // Verifica WeTransfer
      if (esWeTransfer(titulo)) weTransferAbierto = true;
    }
    if (prog === 'whatsapp') {
      // WhatsApp Desktop: titulo tipo "Manuel Bustamante - WhatsApp"
      const chat = extraerChatWhatsApp(titulo);
      if (chat) chatsWhatsApp.push({ ...chat, fuente: 'whatsapp-desktop' });
    }
  }

  // Detectar WT abierto +2min
  const ahora = Date.now();
  if (weTransferAbierto) {
    if (!_wtAbierto.activo) {
      _wtAbierto = { activo: true, desde: ahora };
    }
  } else if (_wtAbierto.activo) {
    _wtAbierto = { activo: false, desde: 0 };
  }
  const wtMinutosAbierto = _wtAbierto.activo ? Math.floor((ahora - _wtAbierto.desde) / 60000) : 0;

  // Detectar cambio de archivo Corel (tiempo activo por archivo)
  let archivoActual = null;
  let tiempoActivoArchivoMin = 0;
  const corelArchivo = archivosAbiertos.find(a => a.programa === 'corel');
  if (corelArchivo) {
    archivoActual = corelArchivo.archivo;
    if (archivoActual !== _archivoCorelPrev) {
      _archivoCorelPrev = archivoActual;
      _archivoCorelDesde = ahora;
    } else {
      tiempoActivoArchivoMin = Math.floor((ahora - _archivoCorelDesde) / 60000);
    }
  } else if (_archivoCorelPrev) {
    _archivoCorelPrev = null;
    _archivoCorelDesde = 0;
  }

  return {
    pc: cfg.persona,
    hostname: os.hostname(),
    ts: new Date().toISOString(),
    programasActivos: Array.from(programasActivos),
    archivosAbiertos,
    chatsWhatsApp,
    weTransfer: {
      abierto: weTransferAbierto,
      minutosAbierto: wtMinutosAbierto,
    },
    corelActivo: archivoActual ? {
      archivo: archivoActual,
      tiempoActivoMin: tiempoActivoArchivoMin,
    } : null,
    vigilanteVersion: VERSION,
  };
}

async function enviarSnapshot(snapshot) {
  if (!snapshot) return;
  try {
    const r = await fetch(SERVER_URL + ENDPOINT_ACTIVIDAD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (!r.ok) log(`fallo snapshot HTTP ${r.status}`);
  } catch (e) {
    log(`error red snapshot:`, e.message);
  }
}

function iniciarCapturaSnapshot(cfg) {
  const tick = async () => {
    try {
      const snap = await capturarSnapshot(cfg);
      if (snap) {
        await enviarSnapshot(snap);
        log(`snapshot enviado: progs=${snap.programasActivos.join(',')||'-'} arch=${snap.archivosAbiertos.length} chats=${snap.chatsWhatsApp.length} wt=${snap.weTransfer.abierto}`);
      }
    } catch (e) { log('snapshot err:', e.message); }
  };
  setInterval(tick, INTERVALO_SNAPSHOT_MS);
  setTimeout(tick, 10 * 1000); // primer snapshot a los 10s
  log('captura de actividad activa (cada 30s)');
}

// ───────────────────────────────────────────────────────────────────
// AUTO-START EN WINDOWS
// Crea una entrada en Run del registro para que arranque al iniciar sesion.
// ───────────────────────────────────────────────────────────────────
function configurarAutoStart() {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    const exePath = process.execPath;
    // Solo si esta empaquetado como .exe (no en modo dev)
    if (!exePath.toLowerCase().endsWith('.exe')) return;
    const cmd = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "WSVigilante" /t REG_SZ /d "\\"${exePath}\\"" /f`;
    execSync(cmd, { stdio: 'ignore' });
    log('auto-start configurado en registry');
  } catch (e) {
    log('error configurando auto-start:', e.message);
  }
}

// ───────────────────────────────────────────────────────────────────
// REPORTAR EVENTO AL SERVIDOR
// ───────────────────────────────────────────────────────────────────
async function reportar(evento, carpeta, filepath, persona) {
  const archivo = path.basename(filepath);
  const carpetaNorm = carpeta.toLowerCase().replace(/\s+/g, '-');
  const payload = {
    pc: persona,
    hostname: os.hostname(),
    carpeta: carpetaNorm,
    archivo,
    pathCompleto: filepath,
    evento,
    ts: new Date().toISOString(),
    vigilanteVersion: VERSION,
  };
  try {
    const r = await fetch(SERVER_URL + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) log(`fallo reportar ${archivo}: HTTP ${r.status}`);
    else log(`reportado: ${persona} ${evento} ${carpeta}/${archivo}`);
  } catch (e) {
    log(`error red reportando ${archivo}:`, e.message);
  }
}

// ───────────────────────────────────────────────────────────────────
// VIGILANCIA — chokidar sobre las 3 carpetas
// ───────────────────────────────────────────────────────────────────
function iniciarVigilancia(cfg) {
  log(`iniciando vigilancia para ${cfg.persona} en ${os.hostname()}`);

  for (const [carpeta, ruta] of Object.entries(cfg.carpetas)) {
    if (!ruta || !fs.existsSync(ruta)) {
      log(`carpeta no existe, saltando: ${carpeta}`);
      continue;
    }
    log(`vigilando: ${carpeta} -> ${ruta}`);
    const watcher = chokidar.watch(ruta, {
      ignoreInitial: true,
      persistent: true,
      depth: 3, // no recursar muy profundo
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
      ignored: [/(^|[\/\\])\../, /\.tmp$/i, /~\$/], // hidden + tmp
    });
    watcher.on('add', f => reportar('add', carpeta, f, cfg.persona));
    watcher.on('change', f => reportar('change', carpeta, f, cfg.persona));
    watcher.on('error', e => log(`watcher error ${carpeta}:`, e.message));
  }

  // Heartbeat cada hora: avisa al servidor que sigue vivo
  setInterval(async () => {
    try {
      await fetch(SERVER_URL + ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pc: cfg.persona,
          evento: 'heartbeat',
          ts: new Date().toISOString(),
          carpetas: Object.keys(cfg.carpetas),
        }),
      });
    } catch {}
  }, 60 * 60 * 1000);

  log('vigilancia activa. Heartbeat cada 1h.');
}

// ───────────────────────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    let cfg = leerConfig();
    if (!cfg) {
      cfg = await setupInicial();
      configurarAutoStart();
    }
    iniciarVigilancia(cfg);
    iniciarCapturaSnapshot(cfg);
  } catch (e) {
    log('ERROR fatal:', e.message);
    if (process.env.WS_VIGILANTE_VERBOSE === '1') console.error(e);
    process.exit(1);
  }
})();
