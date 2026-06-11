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

const VERSION = '3.2.1';
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
  'WhatsApp.Root.exe': 'whatsapp', // Windows Store version
  'WhatsAppDesktop.exe': 'whatsapp',
  'rip.exe': 'rip',
};

// Procesos NO laborales (juegos, redes, streaming, ocio)
const PROCESOS_NO_LABORALES = {
  'Steam.exe': 'steam',
  'EpicGamesLauncher.exe': 'epic',
  'RiotClientServices.exe': 'riot',
  'Riot Client.exe': 'riot',
  'LeagueOfLegends.exe': 'lol',
  'LeagueClientUx.exe': 'lol',
  'LeagueClient.exe': 'lol',
  'FortniteClient-Win64-Shipping.exe': 'fortnite',
  'FIFA23.exe': 'fifa',
  'FIFA24.exe': 'fifa',
  'FIFA25.exe': 'fifa',
  'Spotify.exe': 'spotify',
  'Discord.exe': 'discord',
  'Telegram.exe': 'telegram',
  'TelegramDesktop.exe': 'telegram',
  'Netflix.exe': 'netflix',
  'vlc.exe': 'vlc',
};

// Set categorias para acumular tiempo
const CATEGORIAS_PROGRAMA = {
  diseno: ['corel', 'photoshop', 'illustrator'],
  comunicacion: ['chrome', 'edge', 'firefox', 'whatsapp'],
  no_laboral: Object.values(PROCESOS_NO_LABORALES),
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
    let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    // Sacar BOM si vino del Bloc de notas
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const cfg = JSON.parse(raw);
    // Validar estructura minima
    if (!cfg || !cfg.persona || !cfg.carpetas) return null;
    // Validar que al menos una carpeta exista y este en Drive
    const carpetas = Object.values(cfg.carpetas).filter(Boolean);
    const algunaDriveValida = carpetas.some(r => esRutaDriveValida(r));
    if (!algunaDriveValida) {
      log('config existe pero NINGUNA carpeta apunta a Drive — regenerando');
      return null;
    }
    return cfg;
  } catch (e) {
    log('config invalido o corrupto:', e.message);
    return null;
  }
}

function esRutaDriveValida(ruta) {
  if (!ruta) return false;
  // Una ruta valida de Drive contiene "Mi unidad" o "My Drive" o esta en G:/H:/I:/J: (unidades virtuales Drive)
  const r = String(ruta).toLowerCase();
  if (/mi\s*unidad|my\s*drive|googledrive|google\s*drive/i.test(r)) return true;
  // Letras tipicas de Drive Stream: G, H, I, J, K
  if (/^[ghijk]:[\\/]/i.test(r)) return true;
  // C:\ProgramData o C:\Program Files o C:\Windows = NO valida
  if (/^c:[\\/](programdata|program\s+files|program\s+files\s*\(x86\)|windows|users)[\\/]/i.test(r)) return false;
  return false;
}

function guardarConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // UTF-8 sin BOM
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
}

// ───────────────────────────────────────────────────────────────────
// AUTO-DETECCION DE CARPETAS DRIVE
// Busca recursivamente desde unidades comunes (C:, D:, E:, F:, G:, H:, I:, J:)
// las carpetas corel/PDF RIP/CATALOGO bajo "Mi unidad" o cualquier path.
// ───────────────────────────────────────────────────────────────────
function buscarCarpetasDrive() {
  const encontradas = {};
  const candidatos = [];

  // Windows: SOLO buscar en raices Drive verificadas, NUNCA en C:\ entero
  if (process.platform === 'win32') {
    // Letras tipicas donde Drive Stream se monta: G, H, I, J, K (NO C ni D)
    for (const letra of 'GHIJK') {
      candidatos.push(`${letra}:\\Mi unidad`);
      candidatos.push(`${letra}:\\My Drive`);
    }
    // Tambien dentro de %USERPROFILE% pero solo carpetas Drive
    const userProfile = process.env.USERPROFILE || os.homedir();
    candidatos.push(path.join(userProfile, 'Google Drive', 'Mi unidad'));
    candidatos.push(path.join(userProfile, 'Mi unidad'));
    candidatos.push(path.join(userProfile, 'GoogleDrive'));
  } else {
    candidatos.push(path.join(os.homedir(), 'Google Drive', 'Mi unidad'));
    candidatos.push(path.join(os.homedir(), 'Library', 'CloudStorage'));
  }

  for (const base of candidatos) {
    if (!fs.existsSync(base)) continue;
    try {
      buscarRecursivo(base, encontradas, 4);
    } catch {}
    if (Object.keys(encontradas).length === CARPETAS_OBJETIVO.length) break;
  }

  // Filtro final: descartar rutas que NO son Drive (por si entra algun falso positivo)
  for (const k of Object.keys(encontradas)) {
    if (!esRutaDriveValida(encontradas[k])) {
      delete encontradas[k];
    }
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
function execPromise(cmd, timeoutMs = 20000) {
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
//  - "CorelDRAW (Versión OEM) - Recuperada_CAFETEROS FUT TB*"  (sin extension visible)
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
  // Patron 5: "Programa - nombre" sin extension (Corel recuperado, archivo modificado)
  // Ej: "CorelDRAW (Versión OEM) - Recuperada_CAFETEROS FUT TB*"
  m = t.match(/(CorelDRAW|Photoshop|Illustrator|Adobe)[^-]*[-–]\s*(.+?)\s*$/i);
  if (m) {
    const nombre = m[2].replace(/\*+$/, '').trim(); // quitar * de "modificado"
    // Solo si tiene sentido (>= 3 chars y no es solo "Sin titulo")
    if (nombre.length >= 3 && !/^(untitled|sin\s*t.tulo|new\s*document|nuevo\s*documento|documento\s*sin\s*nombre)/i.test(nombre)) {
      return nombre;
    }
  }
  return null;
}

// Filtro de privacidad: solo titulos de Chrome relacionados al trabajo W&S.
// NO se mandan al servidor titulos de navegacion personal del disenador.
function esTituloRelevante(titulo) {
  if (!titulo) return false;
  const t = titulo.toLowerCase();
  return /(whatsapp|wetransfer|drive\.google|\bdrive\b|corel|photoshop|illustrator|\.cdr|\.psd|\.ai|\.pdf|gmail|mi unidad|my drive|n8n|workflow|notion|airtable|w&s|ws-app|app-interna|nequi|bancolombia|comprobante|stickers?|chatwoot|chat\s*woot|conversaci.n|inbox|hoja\s*de\s*c.lculo|sheets|google\s*meet|w&s\s*textil|deportivos|asesora)/.test(t);
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

// Detecta chat activo en Chatwoot (panel web omnichannel que usa la empresa)
// Ejemplos de titulos vistos:
//   "Manuel Bustamante - Chatwoot"
//   "Conversation #123 - Inbox WhatsApp - Chatwoot"
//   "Pedro Mendoza · 3204525872 - Chatwoot"
//   "(3) Manuel Bustamante - Chatwoot"  (el numero entre parentesis = mensajes sin leer)
function extraerChatChatwoot(titulo) {
  if (!titulo) return null;
  const t = titulo.trim();
  // Debe contener "Chatwoot" para procesar
  if (!/chatwoot/i.test(t)) return null;
  // Sacar contadores tipo "(3) " al principio
  let limpio = t.replace(/^\(\d+\)\s*/, '');
  // Sacar el sufijo " - Chatwoot" y posibles " - Inbox X - Chatwoot"
  limpio = limpio.replace(/\s*[-–|]\s*Chatwoot.*$/i, '').trim();
  // Si quedan partes tipo "Nombre - Inbox WhatsApp" tomar la primera
  const partes = limpio.split(/\s*[-–|·]\s*/);
  const primero = partes[0]?.trim();
  if (!primero || /^(conversation|inbox|conversaciones|bandeja)/i.test(primero)) {
    // Si la primera parte es la palabra Inbox/Conversation, buscar nombre en partes siguientes
    for (let i = 1; i < partes.length; i++) {
      const p = partes[i].trim();
      if (p && !/^(inbox|conversation|whatsapp|sms|telegram|email|messenger|instagram)/i.test(p)) {
        return { chat: p, nombre: p, telefono: extraerTelefonoDeTexto(p), fuente: 'chatwoot' };
      }
    }
    return null;
  }
  return {
    chat: primero,
    nombre: primero.replace(/\(?\+?\d[\d\s().-]{6,}\)?/g, '').trim() || primero,
    telefono: extraerTelefonoDeTexto(primero),
    fuente: 'chatwoot',
  };
}

function extraerTelefonoDeTexto(s) {
  if (!s) return null;
  const m = s.match(/\(?(\+?\d[\d\s().-]{6,})\)?/);
  return m ? m[1].replace(/\D/g, '') : null;
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
let _ultimoTimestampMs = 0;
let _diaActual = ''; // YYYY-MM-DD
let _tiempoAcumuladoHoy = {}; // { diseno: ms, comunicacion: ms, no_laboral: ms, idle: ms, programas: { corel: ms, photoshop: ms, ... } }
let _pcArranqueMs = Date.now();
let _ultimosUsbs = new Set();
let _archivosCopiadosUSBRecientes = 0;
let _exportsRecientes = []; // {archivo, ts, carpeta}

function resetSiCambioElDia() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy !== _diaActual) {
    _diaActual = hoy;
    _tiempoAcumuladoHoy = { diseno: 0, comunicacion: 0, no_laboral: 0, idle: 0, programas: {}, programasAbiertosMs: {} };
    _ultimoTimestampMs = Date.now();
  }
}

// Llama a un PowerShell que devuelve JSON con:
//   { idleSeg, ventanaEnFoco, procFoco, usbs, uptimeMin,
//     procesos: [{name, title}], todosProcesos: [name, ...] }
// Reemplaza tasklist /V (que tarda 20+ segundos en algunas PCs).
async function capturarEstadoWindows() {
  if (process.platform !== 'win32') return {};
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
"@ -ErrorAction SilentlyContinue
$lii = New-Object W+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[W]::GetLastInputInfo([ref]$lii) | Out-Null
$idle = ([Environment]::TickCount - $lii.dwTime) / 1000
$hwnd = [W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[W]::GetWindowText($hwnd, $sb, 512) | Out-Null
$procPid = 0
[W]::GetWindowThreadProcessId($hwnd, [ref]$procPid) | Out-Null
$procName = ''
try { $procName = (Get-Process -Id $procPid -ErrorAction Stop).ProcessName + '.exe' } catch {}
# Procesos con ventana (rapido, ~50-100 normalmente)
$conVentana = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  @{ name = $_.ProcessName + '.exe'; title = $_.MainWindowTitle }
})
# Todos los nombres (rapido)
$todos = @(Get-Process | ForEach-Object { $_.ProcessName + '.exe' } | Sort-Object -Unique)
$usbs = @()
try { $usbs = @(Get-WmiObject Win32_DiskDrive -ErrorAction Stop | Where-Object { $_.InterfaceType -eq 'USB' } | ForEach-Object { $_.Model }) } catch {}
$uptime = [int]([Environment]::TickCount / 60000)
@{
  idleSeg = [int]$idle
  ventanaEnFoco = $sb.ToString()
  procFoco = $procName
  procesos = $conVentana
  todosProcesos = $todos
  usbs = $usbs
  uptimeMin = $uptime
} | ConvertTo-Json -Compress -Depth 4
`;
  return new Promise(resolve => {
    // Base64 UTF-16LE encoding evita problemas de escapado de comillas/Ñ
    const utf16 = Buffer.from(psScript, 'utf16le').toString('base64');
    const t0 = Date.now();
    exec(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${utf16}`, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const ms = Date.now() - t0;
      if (err) {
        log(`PS error tras ${ms}ms: ${err.message}`);
        return resolve({});
      }
      if (!stdout) {
        log(`PS sin output tras ${ms}ms`);
        return resolve({});
      }
      try {
        const j = JSON.parse(stdout.trim());
        if (ms > 5000) log(`PS lento: ${ms}ms`);
        resolve(j);
      } catch (e) {
        log(`PS JSON parse err tras ${ms}ms: ${e.message}`);
        resolve({});
      }
    });
  });
}

// Acumula tiempo desde la ultima medicion. Se llama desde capturarSnapshot.
function acumularTiempo(idleSeg, procFoco, programasActivos) {
  resetSiCambioElDia();
  const ahora = Date.now();
  if (_ultimoTimestampMs === 0) { _ultimoTimestampMs = ahora; return; }
  const deltaMs = ahora - _ultimoTimestampMs;
  _ultimoTimestampMs = ahora;

  // Tiempo de cada programa ABIERTO (aunque NO este en foco)
  if (!_tiempoAcumuladoHoy.programasAbiertosMs) _tiempoAcumuladoHoy.programasAbiertosMs = {};
  for (const prog of programasActivos) {
    _tiempoAcumuladoHoy.programasAbiertosMs[prog] = (_tiempoAcumuladoHoy.programasAbiertosMs[prog] || 0) + deltaMs;
  }

  // Si idle > 60s consideramos todo idle, sino bucket por programa en foco
  if (idleSeg > 60) {
    _tiempoAcumuladoHoy.idle = (_tiempoAcumuladoHoy.idle || 0) + deltaMs;
    return;
  }
  // Quien tiene el foco? bucket por categoria
  const exeFoco = (procFoco || '').toLowerCase();
  const progFoco = Object.entries(PROCESOS_DISEÑO).find(([k]) => k.toLowerCase() === exeFoco)?.[1];
  const progFocoNoLab = Object.entries(PROCESOS_NO_LABORALES).find(([k]) => k.toLowerCase() === exeFoco)?.[1];
  let categoria = 'otros';
  if (progFoco && CATEGORIAS_PROGRAMA.diseno.includes(progFoco)) categoria = 'diseno';
  else if (progFoco && CATEGORIAS_PROGRAMA.comunicacion.includes(progFoco)) categoria = 'comunicacion';
  else if (progFocoNoLab) categoria = 'no_laboral';
  _tiempoAcumuladoHoy[categoria] = (_tiempoAcumuladoHoy[categoria] || 0) + deltaMs;
  if (progFoco) {
    _tiempoAcumuladoHoy.programas[progFoco] = (_tiempoAcumuladoHoy.programas[progFoco] || 0) + deltaMs;
  }
  if (progFocoNoLab) {
    _tiempoAcumuladoHoy.programas[progFocoNoLab] = (_tiempoAcumuladoHoy.programas[progFocoNoLab] || 0) + deltaMs;
  }
}

function detectarUsbsNuevosYSospecha(usbsActuales) {
  const setActual = new Set(usbsActuales || []);
  const nuevos = [...setActual].filter(u => !_ultimosUsbs.has(u));
  _ultimosUsbs = setActual;
  return { conectados: [...setActual], nuevos };
}

async function capturarSnapshot(cfg) {
  try {
  if (process.platform !== 'win32') return null;
  // Captura nativa todo en una llamada PS: procesos+titulos+foco+idle+usbs
  const winState = await capturarEstadoWindows();
  const procesos = (winState.procesos || []).map(p => ({ imagen: p.name, titulo: p.title || '' }));
  const todosNombres = new Set(winState.todosProcesos || []);

  const programasActivos = new Set();
  const archivosAbiertos = []; // {programa, archivo, titulo}
  const chatsWhatsApp = []; // {chat, nombre, telefono, fuente}
  const programasNoLaborales = []; // {tipo, imagen}
  let weTransferAbierto = false;

  for (const { imagen, titulo } of procesos) {
    const prog = PROCESOS_DISEÑO[imagen] || PROCESOS_DISEÑO[imagen.toLowerCase()];
    if (prog) programasActivos.add(prog);

    // Grupo 6: detectar programas no laborales
    const noLab = PROCESOS_NO_LABORALES[imagen] || PROCESOS_NO_LABORALES[imagen.toLowerCase()];
    if (noLab && !programasNoLaborales.find(p => p.tipo === noLab)) {
      programasNoLaborales.push({ tipo: noLab, imagen });
    }

    if (prog === 'corel' || prog === 'photoshop' || prog === 'illustrator') {
      const archivo = extraerArchivoDeTitulo(titulo, prog);
      if (archivo) archivosAbiertos.push({ programa: prog, archivo, titulo });
    }
    if (prog === 'chrome' || prog === 'edge' || prog === 'firefox') {
      // Filtro privacidad: solo procesamos titulos relacionados a W&S
      if (!esTituloRelevante(titulo)) continue;
      // Verifica chat WhatsApp Web
      const chatWA = extraerChatWhatsApp(titulo);
      if (chatWA) chatsWhatsApp.push({ ...chatWA, fuente: 'whatsapp-web' });
      // Verifica chat Chatwoot
      const chatCW = extraerChatChatwoot(titulo);
      if (chatCW) chatsWhatsApp.push(chatCW);
      // Verifica WeTransfer
      if (esWeTransfer(titulo)) weTransferAbierto = true;
    }
    if (prog === 'whatsapp') {
      // WhatsApp Desktop: titulo tipo "Manuel Bustamante - WhatsApp"
      const chat = extraerChatWhatsApp(titulo);
      if (chat) chatsWhatsApp.push({ ...chat, fuente: 'whatsapp-desktop' });
    }
  }

  // Grupo 1, 3, 5: foco + idle + usbs ya vinieron arriba en winState
  // Extra para programas no laborales corriendo SIN ventana visible:
  for (const nombre of todosNombres) {
    const noLab = PROCESOS_NO_LABORALES[nombre] || PROCESOS_NO_LABORALES[nombre.toLowerCase()];
    if (noLab && !programasNoLaborales.find(p => p.tipo === noLab)) {
      programasNoLaborales.push({ tipo: noLab, imagen: nombre });
    }
  }
  acumularTiempo(winState.idleSeg || 0, winState.procFoco || '', programasActivos);
  const usbInfo = detectarUsbsNuevosYSospecha(winState.usbs);

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

  // Categorizar foco actual
  const exeFoco = (winState.procFoco || '').toLowerCase();
  const progFoco = Object.entries(PROCESOS_DISEÑO).find(([k]) => k.toLowerCase() === exeFoco)?.[1] || null;
  const progFocoNoLab = Object.entries(PROCESOS_NO_LABORALES).find(([k]) => k.toLowerCase() === exeFoco)?.[1] || null;
  let categoriaFoco = 'otros';
  if (progFoco && CATEGORIAS_PROGRAMA.diseno.includes(progFoco)) categoriaFoco = 'diseno';
  else if (progFoco && CATEGORIAS_PROGRAMA.comunicacion.includes(progFoco)) categoriaFoco = 'comunicacion';
  else if (progFocoNoLab) categoriaFoco = 'no_laboral';
  else if (!winState.procFoco) categoriaFoco = 'desconocido';

  // Tiempo acumulado convertido a minutos
  const tiempoMin = {
    diseno: Math.round((_tiempoAcumuladoHoy.diseno || 0) / 60000),
    comunicacion: Math.round((_tiempoAcumuladoHoy.comunicacion || 0) / 60000),
    no_laboral: Math.round((_tiempoAcumuladoHoy.no_laboral || 0) / 60000),
    idle: Math.round((_tiempoAcumuladoHoy.idle || 0) / 60000),
    otros: Math.round((_tiempoAcumuladoHoy.otros || 0) / 60000),
    // Tiempo de programas EN FOCO (lo que dedicas atencion real)
    programas: Object.fromEntries(
      Object.entries(_tiempoAcumuladoHoy.programas || {}).map(([k, v]) => [k, Math.round(v / 60000)])
    ),
    // Tiempo de programas ABIERTOS (aunque no esten en foco)
    programasAbiertos: Object.fromEntries(
      Object.entries(_tiempoAcumuladoHoy.programasAbiertosMs || {}).map(([k, v]) => [k, Math.round(v / 60000)])
    ),
  };

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
    // === Nuevos campos v3 ===
    foco: {
      ventana: winState.ventanaEnFoco || '',
      proceso: winState.procFoco || '',
      categoria: categoriaFoco,
      programa: progFoco || progFocoNoLab || null,
    },
    idleSeg: winState.idleSeg || 0,
    enUso: (winState.idleSeg || 0) < 60,
    uptimeMin: winState.uptimeMin || 0,
    usbs: usbInfo,
    programasNoLaborales,
    tiempoHoyMin: tiempoMin,
    dia: _diaActual,
    vigilanteVersion: VERSION,
  };
  } catch (e) {
    log(`capturarSnapshot EXCEPCION: ${e.message} @ ${e.stack?.split('\n')[1] || ''}`);
    return null;
  }
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
  let tickCount = 0;
  const tick = async () => {
    const n = ++tickCount;
    log(`tick #${n} start`);
    try {
      const snap = await capturarSnapshot(cfg);
      log(`tick #${n} snap=${!!snap}`);
      if (snap) {
        await enviarSnapshot(snap);
        const foco = snap.foco?.programa || snap.foco?.proceso || 'nada';
        const noLab = (snap.programasNoLaborales || []).length ? ` noLab=${snap.programasNoLaborales.map(p=>p.tipo).join(',')}` : '';
        const usbNew = (snap.usbs?.nuevos || []).length ? ` USB+=${snap.usbs.nuevos.length}` : '';
        const archivoCorel = snap.corelActivo?.archivo ? ` cdr="${snap.corelActivo.archivo}"` : '';
        const corelAbiertoMin = snap.tiempoHoyMin?.programasAbiertos?.corel || 0;
        log(`snap: foco=${foco}/${snap.foco?.categoria} idle=${snap.idleSeg}s diseñoHoy=${snap.tiempoHoyMin?.diseno}m corelAbierto=${corelAbiertoMin}m progs=${snap.programasActivos.join(',')||'-'}${archivoCorel} arch=${snap.archivosAbiertos.length} chats=${snap.chatsWhatsApp.length}${noLab}${usbNew}`);
      }
    } catch (e) { log(`tick #${n} ERR:`, e.message, e.stack?.split('\n')[1] || ''); }
  };
  // Warm-up PowerShell .NET runtime para que primera captura no demore 9s
  capturarEstadoWindows().catch(() => {}).then(() => {
    log('PS warm-up ok');
    setInterval(tick, INTERVALO_SNAPSHOT_MS);
    setTimeout(tick, 5 * 1000); // primer snapshot a los 5s post-warmup
  });
  log('captura de actividad activa (cada 30s, primer snap tras warm-up)');
}

// ───────────────────────────────────────────────────────────────────
// AUTO-START EN WINDOWS
// 1. Entrada en Run del registro (arranca al iniciar sesion)
// 2. Tarea programada WATCHDOG cada 5 min (si murio, lo resucita)
// ───────────────────────────────────────────────────────────────────
function configurarAutoStart() {
  if (process.platform !== 'win32') return;
  const exePath = process.execPath;
  if (!exePath.toLowerCase().endsWith('.exe')) return;
  try {
    const { execSync } = require('child_process');
    // 1. Registry Run (al iniciar sesion Windows)
    const cmdReg = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "WSVigilante" /t REG_SZ /d "\\"${exePath}\\"" /f`;
    execSync(cmdReg, { stdio: 'ignore' });
    log('auto-start configurado en registry');
  } catch (e) {
    log('error configurando auto-start:', e.message);
  }
  // 2. Watchdog scheduled task — cada 5 min revive el proceso si murio
  // Usamos un .vbs (Visual Basic Script) porque WScript.Shell.Run con
  // parametro 0 = SW_HIDE oculta TODA ventana, incluso de procesos consola.
  // Borramos .bat viejo si existe (versiones anteriores).
  try {
    const { execSync } = require('child_process');
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Borrar .bat viejo de v3.2.0 si existe
    try { fs.unlinkSync(path.join(CONFIG_DIR, 'watchdog.bat')); } catch {}
    const vbsPath = path.join(CONFIG_DIR, 'watchdog.vbs');
    // VBS: verifica si el proceso esta corriendo via WMI, si no, lo lanza OCULTO (param 0).
    // Las comillas dobles en exePath se escapan duplicandolas en VBS string.
    const exePathVbs = exePath.replace(/"/g, '""');
    const vbsContent =
      'Set objWMI = GetObject("winmgmts:\\\\.\\root\\cimv2")\r\n' +
      'Set procs = objWMI.ExecQuery("Select * From Win32_Process Where Name=\'ws-vigilante.exe\'")\r\n' +
      'If procs.Count = 0 Then\r\n' +
      '  Set sh = CreateObject("WScript.Shell")\r\n' +
      `  sh.Run """${exePathVbs}""", 0, False\r\n` +
      'End If\r\n';
    fs.writeFileSync(vbsPath, vbsContent);
    // Borrar tarea vieja
    try { execSync('schtasks /Delete /TN "WSVigilanteWatchdog" /F', { stdio: 'ignore' }); } catch {}
    // Crear tarea programada cada 5 minutos. wscript.exe con //B = batch silencioso
    const cmdSch = `schtasks /Create /TN "WSVigilanteWatchdog" /TR "wscript.exe //B //Nologo \\"${vbsPath}\\"" /SC MINUTE /MO 5 /F`;
    execSync(cmdSch, { stdio: 'ignore' });
    log(`watchdog configurado: ${vbsPath} cada 5 min (oculto)`);
  } catch (e) {
    log('error configurando watchdog:', e.message);
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
      // Drive Stream (H:\) no emite eventos de FS hasta que sincroniza.
      // Polling cada 3s revisa la carpeta manual y ve los archivos nuevos.
      usePolling: true,
      interval: 3000,
      binaryInterval: 5000,
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
    }
    // SIEMPRE asegurar auto-start + watchdog (no solo en setup inicial)
    // Esto garantiza que si actualizamos el .exe a una version con watchdog
    // nuevo, queda configurado al arrancar sin reinstalar.
    configurarAutoStart();
    iniciarVigilancia(cfg);
    iniciarCapturaSnapshot(cfg);
  } catch (e) {
    log('ERROR fatal:', e.message);
    if (process.env.WS_VIGILANTE_VERBOSE === '1') console.error(e);
    process.exit(1);
  }
})();
