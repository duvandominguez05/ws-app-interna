param(
  [Parameter(Mandatory=$true)]
  [string]$ConfirmDeletion,
  [string[]]$ProjectIds = @(
    "4f7aae70-acb8-4589-bb35-52af2e3464b5",
    "1217456a-a50c-404a-b02a-0d399bc5d687",
    "1874a8ed-46c9-4a55-a213-1ba2e3402652",
    "3f9202bd-816b-45f9-a696-65072d17f42e"
  )
)

$ErrorActionPreference = "Stop"

if ($ConfirmDeletion -ne "TENGO_BACKUP_Y_APP_NUEVA_FUNCIONANDO") {
  throw "Bloqueado. Usa -ConfirmDeletion TENGO_BACKUP_Y_APP_NUEVA_FUNCIONANDO solo despues de validar backup y VPS."
}

foreach ($projectId in $ProjectIds) {
  Write-Host "Solicitando borrado Railway project: $projectId"
  railway delete --project $projectId --yes --json
}
