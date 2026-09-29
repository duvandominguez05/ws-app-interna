param(
  [string]$ProjectId = "1217456a-a50c-404a-b02a-0d399bc5d687",
  [string]$EnvironmentId = "c8642d49-cc07-4a56-812b-3a363141f628",
  [string]$PostgresServiceId = "7253f219-3024-409d-b21f-1b426e2dd1ff",
  [string]$RedisServiceId = "14d8a6a0-c118-42ca-9bbb-2f4ac1d04354",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\railway_ws_migration",
  [string]$BackupDir = "C:\CLAUDE\railway-backups",
  [switch]$IncludeRedis
)

$ErrorActionPreference = "Stop"

function Resolve-RailwayCli {
  $railwayCmd = Get-Command railway -ErrorAction SilentlyContinue
  if (!$railwayCmd) { throw "Railway CLI no esta disponible en PATH." }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (!$nodeCmd) { throw "Node.js no esta disponible en PATH." }
  $railwayDir = Split-Path $railwayCmd.Source -Parent
  $railwayJs = Join-Path $railwayDir "node_modules\@railway\cli\bin\railway.js"
  if (!(Test-Path -LiteralPath $railwayJs)) {
    throw "No se encontro el binario JS de Railway CLI: $railwayJs"
  }
  return @{ Node = $nodeCmd.Source; RailwayJs = $railwayJs }
}

function Invoke-RailwayBinaryBackup {
  param(
    [hashtable]$Cli,
    [string]$ServiceId,
    [string[]]$RemoteArgs,
    [string]$Destination
  )

  $partial = "$Destination.partial"
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Cli.Node
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.ArgumentList.Add($Cli.RailwayJs) | Out-Null
  $psi.ArgumentList.Add("ssh") | Out-Null
  $psi.ArgumentList.Add("--project") | Out-Null
  $psi.ArgumentList.Add($ProjectId) | Out-Null
  $psi.ArgumentList.Add("--service") | Out-Null
  $psi.ArgumentList.Add($ServiceId) | Out-Null
  $psi.ArgumentList.Add("--environment") | Out-Null
  $psi.ArgumentList.Add($EnvironmentId) | Out-Null
  $psi.ArgumentList.Add("--identity-file") | Out-Null
  $psi.ArgumentList.Add($IdentityFile) | Out-Null
  foreach ($arg in $RemoteArgs) { $psi.ArgumentList.Add($arg) | Out-Null }

  $proc = [System.Diagnostics.Process]::Start($psi)
  $file = [System.IO.File]::Open($partial, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    $proc.StandardOutput.BaseStream.CopyTo($file)
  } finally {
    $file.Dispose()
  }

  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()

  if ($proc.ExitCode -ne 0) {
    Write-Error $stderr
    throw "Backup Railway fallo con codigo $($proc.ExitCode). Archivo parcial: $partial"
  }

  Move-Item -LiteralPath $partial -Destination $Destination -Force
}

if (!(Test-Path -LiteralPath $IdentityFile)) {
  throw "No existe la llave SSH: $IdentityFile. Ejecuta scripts\New-RailwaySshKey.ps1 primero."
}
if (!(Test-Path -LiteralPath $BackupDir)) {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

$cli = Resolve-RailwayCli
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$pgPath = Join-Path $BackupDir "evolution-postgres-$timestamp.sql.gz"
$redisPath = Join-Path $BackupDir "evolution-redis-$timestamp.tgz"

Write-Host "Respaldando Postgres de Evolution..."
Invoke-RailwayBinaryBackup `
  -Cli $cli `
  -ServiceId $PostgresServiceId `
  -RemoteArgs @("sh", "-lc", "pg_dumpall --clean --if-exists --quote-all-identifiers -U `"`$POSTGRES_USER`" | gzip -c") `
  -Destination $pgPath

$pgMb = [math]::Round((Get-Item -LiteralPath $pgPath).Length / 1MB, 2)
Write-Host "Backup Postgres Evolution: $pgPath ($pgMb MB)"

if ($IncludeRedis) {
  Write-Host "Respaldando Redis de Evolution..."
  Invoke-RailwayBinaryBackup `
    -Cli $cli `
    -ServiceId $RedisServiceId `
    -RemoteArgs @("sh", "-lc", "redis-cli -a `"`$REDIS_PASSWORD`" SAVE >/dev/null 2>&1 || true; tar -C /data -czf - .") `
    -Destination $redisPath

  $redisMb = [math]::Round((Get-Item -LiteralPath $redisPath).Length / 1MB, 2)
  Write-Host "Backup Redis Evolution: $redisPath ($redisMb MB)"
} else {
  Write-Host "Redis Evolution omitido por defecto. Usa -IncludeRedis si necesitas intentar ese respaldo."
}
