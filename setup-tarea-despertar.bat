@echo off
powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \"C:\CLAUDE\ws-app-interna\setup-tarea-despertar.ps1\"' -Verb RunAs"
