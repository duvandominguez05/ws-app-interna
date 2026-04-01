@echo off
cd /d C:\CLAUDE\ws-app-interna
start "WS Server" cmd /k "node server.js"
timeout /t 3 /nobreak
start "WS Bot" cmd /k "node bot-puppeteer.js"
