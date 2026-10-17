# 中文路径的 HTTP 端到端验证：模拟浏览器真实的请求/响应链路
# 注意：PowerShell 发 POST 时字符串 body 默认不按 UTF-8 编码，必须显式转成 UTF-8 字节，
#       才能等价于浏览器 fetch 的行为。
$ErrorActionPreference = "Continue"
$base = "http://127.0.0.1:8787"
$pass = 0; $fail = 0
function Check($label, $got, $want) {
  if ($got -eq $want) { $script:pass++; Write-Host "  OK    $label" -ForegroundColor Green }
  else {
    $script:fail++
    Write-Host "  FAIL  $label" -ForegroundColor Red
    Write-Host "        得到: $got"
    Write-Host "        期望: $want"
  }
}
function PostJson($url, $obj) {
  $json = $obj | ConvertTo-Json -Depth 6
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod $url -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 15
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cnDir = Join-Path $root "test\中文目录 测试\2026国庆 游园会"
$cnOut = Join-Path $root "test\输出 目录\成品 中文"
New-Item -ItemType Directory -Force -Path $cnDir, $cnOut | Out-Null
Set-Content -Path (Join-Path $cnDir "示例 视频.mp4") -Value "x" -Encoding UTF8
Set-Content -Path (Join-Path $cnDir "第二段.mkv") -Value "x" -Encoding UTF8

Write-Host "`n[1] /api/fs/list —— 网页文件夹浏览器用" -ForegroundColor Cyan
$enc = [uri]::EscapeDataString((Join-Path $root "test"))
$r = Invoke-RestMethod "$base/api/fs/list?p=$enc" -TimeoutSec 15
Check "能列出中文子目录" ([bool]($r.dirs | Where-Object { $_.name -eq '中文目录 测试' })) $true
$sub = $r.dirs | Where-Object { $_.name -eq '中文目录 测试' }
Check "子目录路径正确" $sub.path (Join-Path $root "test\中文目录 测试")

Write-Host "`n[2] /api/fs/scan —— 扫描中文文件夹里的媒体文件" -ForegroundColor Cyan
$r2 = PostJson "$base/api/fs/scan" @{ path = $cnDir; use = @('video') }
Check "扫描成功" $r2.ok $true
Check "扫到 2 个文件" $r2.count 2
Check "文件名正确" ([bool]($r2.files | Where-Object { $_.name -eq '示例 视频.mp4' })) $true
Check "文件路径正确" ($r2.files | Where-Object { $_.name -eq '示例 视频.mp4' }).path (Join-Path $cnDir "示例 视频.mp4")

Write-Host "`n[3] /api/fs/mkdir + /api/fs/stat —— 中文输出目录" -ForegroundColor Cyan
$r3 = PostJson "$base/api/fs/mkdir" @{ path = $cnOut }
Check "创建中文目录" $r3.ok $true
$r4 = PostJson "$base/api/fs/stat" @{ path = $cnOut }
Check "识别为目录" $r4.isDirectory $true
Check "回传路径正确" $r4.path $cnOut

Write-Host "`n[4] /api/save —— 把脚本写进中文目录（= 点「保存到输出文件夹」）" -ForegroundColor Cyan
$cnFile = Join-Path $cnOut "生成命令_中文测试.bat"
$content = "@echo off`r`necho 中文测试：全部命令执行成功！`r`necho 输入 G:\测试用户\20261016国庆游园`r`n"
$r5 = PostJson "$base/api/save" @{ path = $cnFile; content = $content }
Check "保存成功" $r5.ok $true
Check "文件确实存在（中文文件名）" (Test-Path $cnFile) $true
if (Test-Path $cnFile) {
  $readBack = [IO.File]::ReadAllText($cnFile, [System.Text.Encoding]::UTF8)
  Check "写进去的中文没坏" ($readBack -match '全部命令执行成功') $true
  Check "写进去的中文路径没坏" ($readBack -match '20261016国庆游园') $true
}

Write-Host "`n[5] 前端资源编码" -ForegroundColor Cyan
$idx = Invoke-WebRequest "$base/" -TimeoutSec 15
Check "index.html 声明 UTF-8" ($idx.Content -match '<meta charset="UTF-8">') $true
Check "首页含中文标题" ($idx.Content -match 'FFmpeg 命令生成器') $true
$js = Invoke-WebRequest "$base/js/recipes-visual.js" -TimeoutSec 15
Check "配方 JS 含中文操作名" ($js.Content -match '画中画') $true

Write-Host "`n============================================"
Write-Host ("  通过 {0}   失败 {1}" -f $pass, $fail) -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
Write-Host "============================================"
exit $(if ($fail) { 1 } else { 0 })
