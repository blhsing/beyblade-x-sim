# Builds the web app, embeds it into the relay, and produces per-tier
# binaries under dist\bin\. Usage: .\build\build-relay.ps1 [-SkipApp]
param([switch]$SkipApp)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app'
$relay = Join-Path $root 'server\relay'
$webroot = Join-Path $relay 'webroot'
$out = Join-Path $root 'dist\bin'

if (-not $SkipApp) {
    Write-Host '== building web app =='
    Push-Location $app
    try { npm run build; if ($LASTEXITCODE -ne 0) { throw "vite build failed" } }
    finally { Pop-Location }
}

Write-Host '== staging webroot =='
Get-ChildItem $webroot -Exclude '.gitkeep' | Remove-Item -Recurse -Force
Copy-Item -Recurse -Force (Join-Path $app 'dist\*') $webroot

New-Item -ItemType Directory -Force $out | Out-Null
Push-Location $relay
try {
    Write-Host '== go test/vet =='
    go vet ./...; if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }

    Write-Host '== windows-amd64 (Azure httpPlatform / local) =='
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
    go build -trimpath -ldflags '-s -w' -o (Join-Path $out 'beyblade-relay-windows-amd64.exe') .
    if ($LASTEXITCODE -ne 0) { throw 'windows build failed' }

    Write-Host '== linux-amd64 (OCI VM / Linux App Service) =='
    $env:GOOS = 'linux'
    go build -trimpath -ldflags '-s -w' -o (Join-Path $out 'beyblade-relay-linux-amd64') .
    if ($LASTEXITCODE -ne 0) { throw 'linux build failed' }
}
finally {
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}
Get-ChildItem $out | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
