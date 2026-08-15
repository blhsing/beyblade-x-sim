# Deploys the combined web app + relay to the OCI Always Free VM tier.
#
# The VM's ingress only allows TCP 80 (OCI security list), which DeskFerry's
# relay used to occupy, so the deployed mode is "front": beyblade-relay owns
# :80, serves the game at "/" and /game/*, and reverse-proxies /relay/* to
# the DeskFerry relay on 127.0.0.1:8081 (its unit must listen there).
#
# Usage:
#   .\build\deploy-oci.ps1 -SshHost <ip-or-host> [-SshUser opc] [-KeyPath ~\.ssh\key] `
#       [-Peer https://<azure-app>.azurewebsites.net/beyblade] [-ProxyCommand '...']
#
# Requires .\build\build-relay.ps1 first. The systemd unit is created on
# first run; later runs just replace the binary and restart.
param(
    [Parameter(Mandatory = $true)][string]$SshHost,
    [string]$SshUser = 'opc',
    [string]$KeyPath = "$env:USERPROFILE\.ssh\oci-beyblade.key",
    [string]$Peer = '',
    [string]$DataPath = '/opt/beyblade/db.json',
    [string]$ProxyCommand
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'dist\bin\beyblade-relay-linux-amd64'
if (-not (Test-Path $bin)) { throw "run build\build-relay.ps1 first" }

$sshOpts = @('-i', $KeyPath, '-o', 'IdentitiesOnly=yes')
if ($ProxyCommand) { $sshOpts += @('-o', "ProxyCommand=$ProxyCommand") }

$peerFlag = if ($Peer) { " -peer $Peer" } else { '' }
$exec = "/opt/beyblade/beyblade-relay -listen 0.0.0.0:80 -forward http://127.0.0.1:8081 -data $DataPath$peerFlag"

Write-Host '== uploading binary =='
scp @sshOpts $bin "$SshUser@${SshHost}:/tmp/beyblade-relay-linux-amd64"

$remote = "sudo mkdir -p /opt/beyblade && sudo install -m 0755 /tmp/beyblade-relay-linux-amd64 /opt/beyblade/beyblade-relay && rm -f /tmp/beyblade-relay-linux-amd64 && if [ ! -f /etc/systemd/system/beyblade-relay.service ]; then printf '[Unit]\nDescription=Beyblade X sim web+relay\nAfter=network.target\n\n[Service]\nExecStart=$exec\nRestart=always\nRestartSec=2\nEnvironment=GOMEMLIMIT=128MiB\n\n[Install]\nWantedBy=multi-user.target\n' | sudo tee /etc/systemd/system/beyblade-relay.service >/dev/null; else sudo sed -i 's|ExecStart=.*|ExecStart=$exec|' /etc/systemd/system/beyblade-relay.service; fi && sudo systemctl daemon-reload && sudo systemctl enable --now beyblade-relay.service && sudo systemctl restart beyblade-relay.service && sleep 1 && sudo systemctl is-active beyblade-relay.service && curl -s -m 5 http://127.0.0.1/game/health && echo && curl -s -m 5 http://127.0.0.1/relay/health"
ssh @sshOpts "$SshUser@$SshHost" $remote
Write-Host "`ngame: http://$SshHost/"
Write-Host 'rollback: restore deskferry-relay.service.bak (listen 0.0.0.0:80), stop beyblade-relay.service'
