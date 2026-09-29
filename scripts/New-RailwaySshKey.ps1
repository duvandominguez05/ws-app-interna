param(
  [string]$KeyPath = "$env:USERPROFILE\.ssh\railway_ws_migration",
  [string]$KeyName = "railway-ws-migration"
)

$ErrorActionPreference = "Stop"

$sshDir = Split-Path -Parent $KeyPath
if (!(Test-Path -LiteralPath $sshDir)) {
  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
}

if (!(Test-Path -LiteralPath $KeyPath)) {
  ssh-keygen -t ed25519 -f $KeyPath -N "" -C $KeyName
}

$pub = "$KeyPath.pub"
if (!(Test-Path -LiteralPath $pub)) {
  throw "No se encontro la llave publica: $pub"
}

railway ssh keys add --key $pub --name $KeyName
Write-Host "Llave registrada en Railway."
Write-Host "Privada: $KeyPath"
Write-Host "Publica : $pub"
