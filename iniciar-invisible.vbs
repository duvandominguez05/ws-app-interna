Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\CLAUDE\ws-app-interna"" && node bot-local.js >> ""C:\CLAUDE\ws-app-interna\bot-log.txt"" 2>&1", 0, False
