@echo off
cd /d C:\CLAUDE\ws-app-interna
if not exist logs mkdir logs

REM Matar procesos anteriores
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Borrar lock del browser de puppeteer
del /f /q "wa_auth_puppeteer\session\SingletonLock" >nul 2>&1
del /f /q "wa_auth_puppeteer\session\.org.chromium.Chromium*" >nul 2>&1

start "WS Server" cmd /k "cd /d C:\CLAUDE\ws-app-interna && node server.js"
timeout /t 3 /nobreak >nul
start "WS Bot" cmd /k "cd /d C:\CLAUDE\ws-app-interna && node bot-puppeteer.js"
