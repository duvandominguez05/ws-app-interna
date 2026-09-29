param(
  [string]$ProjectId = "4f7aae70-acb8-4589-bb35-52af2e3464b5",
  [string]$ServiceId = "cf7efb40-2873-4f9c-b8d7-05965e4fb2e6",
  [string]$EnvironmentId = "92567919-7f28-454f-8286-5fcf0ff40887",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\railway_ws_migration",
  [string]$BackupDir = "C:\CLAUDE\railway-backups"
)

$ErrorActionPreference = "Stop"

$railwayCmd = Get-Command railway -ErrorAction SilentlyContinue
if (!$railwayCmd) {
  throw "Railway CLI no esta disponible en PATH."
}
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (!$nodeCmd) {
  throw "Node.js no esta disponible en PATH."
}
$railwayDir = Split-Path $railwayCmd.Source -Parent
$railwayJs = Join-Path $railwayDir "node_modules\@railway\cli\bin\railway.js"
if (!(Test-Path -LiteralPath $railwayJs)) {
  throw "No se encontro el binario JS de Railway CLI: $railwayJs"
}
if (!(Test-Path -LiteralPath $IdentityFile)) {
  throw "No existe la llave SSH: $IdentityFile. Ejecuta scripts\New-RailwaySshKey.ps1 primero."
}
if (!(Test-Path -LiteralPath $BackupDir)) {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$partialPath = Join-Path $BackupDir "ws-app-interna-data-$timestamp.tgz.partial"
$backupPath = Join-Path $BackupDir "ws-app-interna-data-$timestamp.tgz"

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $nodeCmd.Source
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.ArgumentList.Add($railwayJs) | Out-Null
$psi.ArgumentList.Add("ssh") | Out-Null
$psi.ArgumentList.Add("--project") | Out-Null
$psi.ArgumentList.Add($ProjectId) | Out-Null
$psi.ArgumentList.Add("--service") | Out-Null
$psi.ArgumentList.Add($ServiceId) | Out-Null
$psi.ArgumentList.Add("--environment") | Out-Null
$psi.ArgumentList.Add($EnvironmentId) | Out-Null
$psi.ArgumentList.Add("--identity-file") | Out-Null
$psi.ArgumentList.Add($IdentityFile) | Out-Null
$psi.ArgumentList.Add("tar") | Out-Null
$psi.ArgumentList.Add("-C") | Out-Null
$psi.ArgumentList.Add("/app") | Out-Null
$psi.ArgumentList.Add("-czf") | Out-Null
$psi.ArgumentList.Add("-") | Out-Null
$psi.ArgumentList.Add("data") | Out-Null

$proc = [System.Diagnostics.Process]::Start($psi)
$file = [System.IO.File]::Open($partialPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $proc.StandardOutput.BaseStream.CopyTo($file)
} finally {
  $file.Dispose()
}
$stderr = $proc.StandardError.ReadToEnd()
$proc.WaitForExit()

if ($proc.ExitCode -ne 0) {
  Write-Error $stderr
  throw "Backup Railway fallo con codigo $($proc.ExitCode). Archivo parcial: $partialPath"
}

Move-Item -LiteralPath $partialPath -Destination $backupPath
$sizeMb = [math]::Round((Get-Item -LiteralPath $backupPath).Length / 1MB, 2)
Write-Host "Backup creado: $backupPath ($sizeMb MB)"
Write-Host "Restaurar en el VPS: tar -xzf $backupPath -C /opt/ws-app-interna"
