# 用真实 ffmpeg 执行 tools/e2e.js 生成的命令，统计通过率
# 用法： & .\tools\run-e2e.ps1            （全部）
#        & .\tools\run-e2e.ps1 -Only trim （只跑 id 含 trim 的）
param(
  [string]$Ffmpeg = "",
  [string]$Only = ""
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$jsonPath = Join-Path $root "test\out\commands.json"
if (-not (Test-Path $jsonPath)) { Write-Host "缺少 $jsonPath，请先运行 node tools/e2e.js"; exit 1 }

if (-not $Ffmpeg) {
  if (Test-Path "D:\lux\ffmpegbin\ffmpeg.exe") { $Ffmpeg = "D:\lux\ffmpegbin\ffmpeg.exe" }
  else { $Ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
}
if (-not $Ffmpeg) { Write-Host "找不到 ffmpeg"; exit 1 }

$cmds = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ok = 0; $fail = 0; $failList = @()

foreach ($c in $cmds) {
  if ($Only -and $c.id -notlike "*$Only*") { continue }
  $argv = [string[]]$c.argv
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = & $Ffmpeg @argv 2>&1 | Out-String
  $code = $LASTEXITCODE
  $sw.Stop()

  if ($code -eq 0) {
    $ok++
    Write-Host ("  OK   [{0,6:N1}s] {1}" -f $sw.Elapsed.TotalSeconds, $c.name) -ForegroundColor Green
  } else {
    $fail++
    $lines = ($out -split "`r?`n") | Where-Object { $_ -match '\S' }
    $tail = ($lines | Select-Object -Last 3) -join '  ||  '
    if ($tail.Length -gt 300) { $tail = $tail.Substring($tail.Length - 300) }
    $failList += [pscustomobject]@{ Id = $c.id; Name = $c.name; Code = $code; Err = $tail }
    Write-Host ("  FAIL [{0,6:N1}s] {1}" -f $sw.Elapsed.TotalSeconds, $c.name) -ForegroundColor Red
    if ($tail) { Write-Host ("         {0}" -f $tail) -ForegroundColor DarkGray }
  }
}

Write-Host ""
Write-Host "================ 结果 ================"
Write-Host ("  通过 {0}   失败 {1}" -f $ok, $fail)
if ($failList.Count) {
  Write-Host ""
  Write-Host "  失败明细："
  foreach ($f in $failList) {
    Write-Host ("   - {0}  (exit {1})" -f $f.Id, $f.Code) -ForegroundColor Yellow
    Write-Host ("     {0}" -f $f.Err) -ForegroundColor DarkGray
  }
}
Write-Host "====================================="
