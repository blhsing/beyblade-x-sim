# Deploys the combined web app + relay to the Azure tier.
#
# Two modes:
#   -VirtualApp (default; used because this account lacks Microsoft.Web/sites/write):
#       deploys into an EXISTING site as IIS virtual application /beyblade
#       (physical path site\beyblade-app, own web.config + Go process via
#       httpPlatformHandler). The site's root app (DeskFerry relay) is not
#       modified; the vapp registration is added once via ARM PATCH.
#       Game URL: https://<app>.azurewebsites.net/beyblade/
#   -OwnWebApp: creates/uses a dedicated webapp (needs create permission).
#       Game URL: https://<app>.azurewebsites.net/
#
# Usage:
#   .\build\deploy-azure.ps1 -AppName <existing-app> -ResourceGroup <rg>     # vapp mode
#   .\build\deploy-azure.ps1 -AppName my-new-app -ResourceGroup rg -OwnWebApp -Plan planName
#
# Requires: az CLI logged in; .\build\build-relay.ps1 already run.
param(
    [Parameter(Mandatory = $true)][string]$AppName,
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [switch]$OwnWebApp,
    [string]$Plan,
    [string]$SubscriptionId
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'dist\bin\beyblade-relay-windows-amd64.exe'
if (-not (Test-Path $bin)) { throw "run build\build-relay.ps1 first" }
if (-not $SubscriptionId) { $SubscriptionId = az account show --query id -o tsv }

$stage = Join-Path $root 'dist\azure-vapp-stage'
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $bin (Join-Path $stage 'beyblade-relay.exe')

if ($OwnWebApp) {
    Copy-Item (Join-Path $root 'server\relay\azure\web.config') (Join-Path $stage 'web.config')
    $zip = Join-Path $root 'dist\beyblade-azure.zip'
    Remove-Item $zip -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
    $exists = az webapp show --resource-group $ResourceGroup --name $AppName 2>$null
    if (-not $exists) {
        if (-not $Plan) { throw 'pass -Plan to create the webapp' }
        az webapp create --resource-group $ResourceGroup --plan $Plan --name $AppName | Out-Null
    }
    az webapp config set --resource-group $ResourceGroup --name $AppName --web-sockets-enabled true | Out-Null
    az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $zip --type zip --clean true --restart true --track-status true
    Write-Host "app: https://$AppName.azurewebsites.net/"
    return
}

# ---- virtual-app mode ----
Copy-Item (Join-Path $root 'server\relay\azure\web.vapp.config') (Join-Path $stage 'web.config')
$zip = Join-Path $root 'dist\beyblade-vapp.zip'
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip

Write-Host '== deploying files to site/beyblade-app =='
az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $zip --type zip --target-path /home/site/beyblade-app --restart false --track-status true

Write-Host '== ensuring /beyblade virtual application =='
$cfgUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AppName/config/web?api-version=2023-12-01"
$current = az rest --method get --url $cfgUrl | ConvertFrom-Json
$vapps = @($current.properties.virtualApplications)
if (-not ($vapps | Where-Object { $_.virtualPath -eq '/beyblade' })) {
    $vapps += [pscustomobject]@{ virtualPath = '/beyblade'; physicalPath = 'site\beyblade-app'; preloadEnabled = $true }
    $bodyFile = Join-Path $env:TEMP 'beyblade-vapps.json'
    @{ properties = @{ virtualApplications = $vapps } } | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $bodyFile
    az rest --method patch --url $cfgUrl --body "@$bodyFile" | Out-Null
    Write-Host 'virtual application registered (site restarted)'
} else {
    # files changed under an existing vapp: restart to pick up the new exe
    az webapp restart --resource-group $ResourceGroup --name $AppName | Out-Null
    Write-Host 'redeployed; site restarted'
}
Write-Host "game: https://$AppName.azurewebsites.net/beyblade/"
Write-Host "rollback: remove the /beyblade entry from virtualApplications and delete site\beyblade-app"
