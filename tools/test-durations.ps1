# 真机执行 + 时长断言 + 无损模式校验
# 专门抓「命令能跑但输出时长错误」这种静默 bug（例如滤镜里用了 HH:MM:SS），
# 以及验证「无损模式」确实没有重编码。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ff = if (Test-Path "D:\lux\ffmpegbin\ffmpeg.exe") { "D:\lux\ffmpegbin\ffmpeg.exe" } else { (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
$fp = if (Test-Path "D:\lux\ffmpegbin\ffprobe.exe") { "D:\lux\ffmpegbin\ffprobe.exe" } else { (Get-Command ffprobe -ErrorAction SilentlyContinue).Source }
if (-not $ff -or -not $fp) { Write-Host "找不到 ffmpeg/ffprobe"; exit 1 }

$caseFile = Join-Path $root "test\dur\cases.json"
if (-not (Test-Path $caseFile)) {
  Write-Host "缺少用例文件，先运行：node tools/gen-duration-cases.js"
  exit 1
}

function Get-Dur([string]$f) {
  if (-not (Test-Path $f)) { return -1 }
  $d = & $fp -v error -show_entries format=duration -of default=nw=1:nk=1 $f 2>&1
  try { return [double]($d | Select-Object -First 1) } catch { return -1 }
}
function Get-VCodec([string]$f) {
  if (-not (Test-Path $f)) { return "" }
  $d = & $fp -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 $f 2>&1
  return (($d | Select-Object -First 1) + "").Trim()
}

$cases = Get-Content $caseFile -Raw -Encoding UTF8 | ConvertFrom-Json
$pass = 0; $fail = 0

foreach ($c in $cases) {
  if (Test-Path $c.output) { Remove-Item $c.output -Force -ErrorAction SilentlyContinue }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $runErr = ""

  # 依次执行（无损模式是多条：切段 + 拼接）
  $idx = 0
  foreach ($argv in $c.argvList) {
    $idx++
    $out = & $ff @([string[]]$argv) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      $runErr = "第 $idx 条命令失败"
      ($out -split "`r?`n" | Where-Object { $_ -match 'Error|Invalid|matches no streams' } | Select-Object -First 2) |
        ForEach-Object { Write-Host ("          " + $_.Trim()) -ForegroundColor DarkGray }
      break
    }
  }
  $sw.Stop()

  if ($runErr -or -not (Test-Path $c.output)) {
    $fail++
    Write-Host ("  FAIL  {0,-24} -> {1}" -f $c.label, $(if ($runErr) { $runErr } else { "没有产出文件" })) -ForegroundColor Red
    continue
  }

  $got = Get-Dur $c.output
  $diff = [Math]::Abs($got - $c.expectSec)
  $problems = @()

  if ($diff -gt $c.tolerance) { $problems += ("时长 {0:N2}s 期望 {1:N2}s" -f $got, $c.expectSec) }

  # 无损模式：成品视频编码必须与源一致
  if ($c.srcCodec) {
    $vc = Get-VCodec $c.output
    if ($vc -ne $c.srcCodec) { $problems += ("成品编码 $vc 与源 $($c.srcCodec) 不一致") }
  }
  if ($c.requireCopy -and -not $c.copyOk) { $problems += "命令里出现了编码参数" }

  if ($problems.Count -eq 0) {
    $pass++
    Write-Host ("  OK    {0,-24} 输出 {1,6:N2}s  期望 {2:N2}s  耗时 {3,5:N2}s" -f $c.label, $got, $c.expectSec, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
  } else {
    $fail++
    Write-Host ("  FAIL  {0,-24} {1}" -f $c.label, ($problems -join '; ')) -ForegroundColor Red
    $c.argvList | ForEach-Object { Write-Host ("          " + ($_ -join ' ')) -ForegroundColor DarkGray }
  }
}

Write-Host ""
Write-Host ("  时长/无损断言：通过 {0}   失败 {1}" -f $pass, $fail) -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
