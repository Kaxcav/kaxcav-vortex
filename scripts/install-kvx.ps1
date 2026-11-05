#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$kvxCmd = Join-Path $repoRoot 'kvx.cmd'

Write-Host "=== INSTALANDO KAXCAV VORTEX (kvx) NO PATH DO USUARIO ===" -ForegroundColor Cyan
[Environment]::SetEnvironmentVariable('KVX_HOME', (Join-Path $env:USERPROFILE '.kaxcav-vortex'), 'User')

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$repoRoot*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$repoRoot", 'User')
}

& $kvxCmd status
Write-Host "[OK] Kaxcav Vortex ($kvxCmd) adicionado ao PATH do usuario!" -ForegroundColor Green
