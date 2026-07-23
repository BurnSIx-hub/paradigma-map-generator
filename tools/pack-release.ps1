# Paradigma Map Generator - build a GitHub release.
# Produces release\module.zip (code + sounds, no dev files) and
# release\module.json (manifest for install-by-URL in Foundry).
#
# Run:  powershell -ExecutionPolicy Bypass -File tools\pack-release.ps1

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot
$release = Join-Path $root 'release'

# 1. Stage module contents into a temp folder, excluding dev/service files
$stage = Join-Path $env:TEMP 'pmg-release'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$exclude = @('.git', '.gitignore', 'release', 'tools', 'CLAUDE.md')
Get-ChildItem $root | Where-Object { $exclude -notcontains $_.Name } |
    Copy-Item -Destination $stage -Recurse

# 2. Zip + manifest side by side
New-Item -ItemType Directory -Force $release | Out-Null
$zipPath = Join-Path $release 'module.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path "$stage\*" -DestinationPath $zipPath
Copy-Item (Join-Path $root 'module.json') (Join-Path $release 'module.json') -Force
Remove-Item $stage -Recurse -Force

$ver = (Get-Content (Join-Path $root 'module.json') -Raw | ConvertFrom-Json).version
Write-Host "Done: $zipPath (version $ver)"
Write-Host 'Next: gh release create v<version> release\module.zip release\module.json'
