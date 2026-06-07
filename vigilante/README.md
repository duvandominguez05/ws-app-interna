# Vigilante W&S

Mini app que corre **oculto en cada PC de diseñador**. Detecta cuando aparecen archivos nuevos en las carpetas `corel`, `PDF RIP` y `CATALOGO` del Drive local y reporta al servidor de la app W&S para que avance el pedido automáticamente.

## Cómo se instala (1 vez por PC)

### Paso 1: Descargar el .exe
- Pasarle al diseñador el archivo `dist/ws-vigilante.exe` (38 MB)
- Lo pueden guardar en cualquier carpeta de su PC. Recomendado: `C:\Users\<usuario>\WS\ws-vigilante.exe`

### Paso 2: Primer arranque (1 sola vez)
- Doble click al `.exe`
- Se abre una ventana de consola que pregunta:
  ```
  ═══════════════════════════════════════════
    VIGILANTE W&S — configuracion inicial
  ═══════════════════════════════════════════

  Quien usa esta PC?
    1. Oscar
    2. Wendy
    3. Ney
    4. Paola
    5. Camilo
  Numero (1-5):
  ```
- Escribir el número y Enter
- El vigilante busca automáticamente las carpetas `corel`, `PDF RIP`, `CATALOGO` en el Drive local
- Si las encuentra → arranca solo
- Si no encuentra alguna → pregunta la ruta manualmente (ej: `H:\Mi unidad\DISEÑO\corel`)
- Al final muestra:
  ```
  El vigilante ahora va a correr OCULTO.
  Auto-start configurandose...
  ```

### Paso 3: Auto-start
- El primer arranque registra el .exe en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- Desde el siguiente reinicio, arranca **invisible al iniciar sesión Windows**
- No aparece en barra de tareas
- No aparece como ventana abierta
- Solo se ve en Administrador de tareas como proceso `ws-vigilante.exe`

## Qué hace en tiempo real

Cuando el diseñador guarda/exporta un archivo en una de las 3 carpetas vigiladas:

```
Diseñador guarda Almany FC.cdr en corel
       ↓
Drive sync local detecta el cambio
       ↓
Vigilante detecta el archivo (al instante)
       ↓
POST a https://ws-app-interna-production.up.railway.app/api/agente-evento
{
  "pc": "Oscar",
  "carpeta": "corel",
  "archivo": "Almany FC.cdr",
  "evento": "add",
  "ts": "2026-06-07T14:30:00Z"
}
       ↓
Servidor matchea con pedido #17 (Almany FC)
       ↓
Marca disenoIniciado=true + disenadorReal=Oscar
       ↓
Si el archivo está en PDF RIP → avanza estado a confirmado
Si ya tiene WT enviado → avanza a enviado-calandra
```

## Avance automático según carpeta

| Carpeta | Acción en el pedido |
|---|---|
| `corel/` | Marca **diseño iniciado** + guarda quién (PC) |
| `PDF RIP/` | Marca **PDF listo** + avanza estado a `confirmado` |
| `CATALOGO/` | Marca **catalogado** |

## Para parar el vigilante (si hace falta)

1. Administrador de tareas (`Ctrl+Shift+Esc`)
2. Buscar `ws-vigilante.exe`
3. Click derecho → Finalizar tarea

Para que NO vuelva a arrancar en el próximo reinicio:
- `Win+R` → escribir `regedit` → ir a `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
- Borrar la entrada `WSVigilante`

## Para reconfigurar (cambiar de diseñador o ruta)

1. Borrar el archivo de config:
   - `Win+R` → `%APPDATA%\ws-vigilante\config.json`
   - Borrar `config.json`
2. Abrir de nuevo el `.exe` → pregunta otra vez

## Logs

- Ubicación: `%APPDATA%\ws-vigilante\vigilante.log`
- Contiene todos los eventos enviados al servidor
- Útil si algo no funciona — Camilo puede pedir el log para diagnosticar

## Desarrollo (para Claude/programador)

```bash
cd vigilante/
npm install          # instala chokidar + pkg
npm start            # corre sin empaquetar (modo dev)
npm run build        # empaqueta como .exe en dist/
```

Para correr en modo verbose y ver logs en consola:
```
set WS_VIGILANTE_VERBOSE=1
node index.js
```

## Variables de entorno opcionales

| Variable | Default | Uso |
|---|---|---|
| `WS_VIGILANTE_URL` | `https://ws-app-interna-production.up.railway.app` | URL del servidor donde reportar |
| `WS_VIGILANTE_VERBOSE` | `0` | Si es `1`, muestra logs en consola |
