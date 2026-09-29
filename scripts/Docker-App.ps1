param(
  [ValidateSet("start", "start-all", "stop", "stop-all", "restart", "restart-all", "logs", "logs-evolution", "status", "health", "start-evolution", "start-proxy")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker no esta disponible en PATH."
}

if (!(Test-Path -LiteralPath ".env")) {
  Write-Warning "No existe .env. Se usaran defaults seguros de docker-compose.yml; copia .env.example a .env antes de produccion."
}

switch ($Action) {
  "start" {
    docker compose up -d --build app
  }
  "start-all" {
    docker compose --profile evolution up -d --build app evolution-api
  }
  "stop" {
    docker compose stop app
  }
  "stop-all" {
    docker compose --profile evolution --profile proxy stop
  }
  "restart" {
    docker compose restart app
  }
  "restart-all" {
    docker compose --profile evolution restart
  }
  "logs" {
    docker compose logs -f --tail=100 app
  }
  "logs-evolution" {
    docker compose --profile evolution logs -f --tail=100 evolution-api
  }
  "status" {
    docker compose --profile evolution ps
  }
  "health" {
    Invoke-RestMethod "http://127.0.0.1:3000/api/health" | ConvertTo-Json -Depth 5
  }
  "start-evolution" {
    docker compose --profile evolution up -d evolution-api
  }
  "start-proxy" {
    docker compose --profile proxy up -d caddy
  }
}
