# 单独运行某条生成的命令并打印完整 ffmpeg 输出
# 用法： & .\tools\one.ps1 geo-crop
param([string]$Id, [string]$Ffmpeg = "D:\lux\ffmpegbin\ffmpeg.exe")
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$json = Join-Path $root "test\out\commands.json"
$cmds = Get-Content $json -Raw -Encoding UTF8 | ConvertFrom-Json
$c = $cmds | Where-Object { $_.id -eq $Id }
if (-not $c) { Write-Host "找不到 $Id"; exit 1 }
Write-Host "=== $($c.name) [$($c.id)] ===" -ForegroundColor Cyan
Write-Host ($c.argv -join ' ') -ForegroundColor DarkGray
Write-Host ""
$out = & $Ffmpeg @([string[]]$c.argv) 2>&1 | Out-String
$out
Write-Host "exit = $LASTEXITCODE" -ForegroundColor Yellow
