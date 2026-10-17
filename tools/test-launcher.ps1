# 验证 Windows 下的编码兼容性（都在默认代码页 936 下进行，等价于用户直接双击/在 cmd 里跑）
#   ① 启动服务.bat 能否被 cmd 正确解析
#   ② 引擎生成的 ffmpeg 批处理脚本（含中文路径）能否正确执行
#   ③ 原生选择器 /api/pick 用到的 PowerShell 输出编码是否正确
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$enc = Join-Path $root "test\enc"
New-Item -ItemType Directory -Force -Path $enc | Out-Null

$ERRPAT = '不是内部或外部命令|语法不正确|系统找不到|is not recognized|operable program|The filename'

function Test-Bat([string]$name, [string]$path) {
  Write-Host ""
  Write-Host "=========== $name ===========" -ForegroundColor Cyan
  Write-Host "  文件: $path  ($((Get-Item $path).Length) 字节)"
  # 关键：从默认的 936 代码页启动 cmd，等价于在资源管理器里双击
  $out = cmd /c "chcp 936 >nul & `"$path`"" 2>&1 | Out-String
  $lines = ($out -split "`r?`n") | Where-Object { $_ -match '\S' }
  $bad = @($lines | Where-Object { $_ -match $ERRPAT })
  if ($bad.Count -eq 0) {
    Write-Host "  OK  无解析错误" -ForegroundColor Green
  } else {
    Write-Host "  FAIL 解析错误 $($bad.Count) 处：" -ForegroundColor Red
    $bad | Select-Object -First 6 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  }
  return @{ Name = $name; Errors = $bad.Count; Lines = $lines }
}

# ---------- (1) 启动脚本 ----------
$real = Get-Content (Join-Path $root "启动服务.bat") -Raw -Encoding UTF8
$probe = $real.Replace('node server.js', 'node -e "console.log(''SERVER_WOULD_START_OK'')"')
$probe = $probe -replace '(?m)^pause\s*$', 'rem pause'
[IO.File]::WriteAllText((Join-Path $enc "launcher_test.bat"), $probe, (New-Object System.Text.UTF8Encoding $false))
$r1 = Test-Bat "启动服务.bat（模拟双击）" (Join-Path $enc "launcher_test.bat")
$started = [bool]($r1.Lines -match 'SERVER_WOULD_START_OK')
Write-Host ("  Node 启动标记: {0}" -f $started) -ForegroundColor $(if ($started) { 'Green' } else { 'Red' })
$r1.Lines | Select-Object -First 8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }

# ---------- (2) 引擎生成的脚本 ----------
$bat = Join-Path $enc "out\run.bat"
if (Test-Path $bat) {
  Remove-Item (Join-Path $enc "out\*.mp4") -ErrorAction SilentlyContinue
  $r2 = Test-Bat "引擎生成的 ffmpeg 脚本（含中文路径）" $bat
  Write-Host "  关键回显:"
  $r2.Lines | Where-Object { $_ -match '^\[\d+/\d+\]|准备输出目录|全部命令|执行失败|输出目录:' } |
    ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  $made = @(Get-ChildItem (Join-Path $enc "out") -Filter *.mp4 -ErrorAction SilentlyContinue)
  Write-Host ("  产物: {0} 个" -f $made.Count) -ForegroundColor $(if ($made.Count -ge 4) { 'Green' } else { 'Red' })
  $made | ForEach-Object { Write-Host "      $($_.Name)  ($($_.Length) 字节)" -ForegroundColor DarkGray }
} else {
  Write-Host "  跳过（未找到 $bat）" -ForegroundColor Yellow
}

# ---------- (3) 原生选择器的 PowerShell 输出编码 ----------
Write-Host ""
Write-Host "=========== 原生选择器 /api/pick 的输出编码 ===========" -ForegroundColor Cyan

$CN = 'G:\测试用户\20261016国庆游园'
# 中文经 UTF-8 文件提供，保证命令行本身是纯 ASCII。
# （服务端真实场景里中文来自 .NET 对话框对象，同样不经过命令行编码）
$cnFile = Join-Path $enc "expected.txt"
[IO.File]::WriteAllText($cnFile, $CN, (New-Object System.Text.UTF8Encoding $false))

$WRITE = "[Console]::Out.Write([IO.File]::ReadAllText('$cnFile',[System.Text.Encoding]::UTF8))"
$UTF8PRE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; `$OutputEncoding=[System.Text.Encoding]::UTF8; "

function Get-RawStdout([string]$oneLine) {
  $tmp = Join-Path $enc "psout.bin"
  Remove-Item $tmp -ErrorAction SilentlyContinue
  # cmd 的 > 是字节级复制，才能看到子进程 stdout 的真实字节
  cmd /c "chcp 936 >nul & powershell.exe -NoProfile -Command ""$oneLine"" > ""$tmp"" 2>nul"
  if (Test-Path $tmp) { return , ([IO.File]::ReadAllBytes($tmp)) }
  return , ([byte[]]@())
}

$beforeTxt = [System.Text.Encoding]::UTF8.GetString((Get-RawStdout $WRITE))
$afterTxt = [System.Text.Encoding]::UTF8.GetString((Get-RawStdout ($UTF8PRE + $WRITE)))

Write-Host ("  修复前（PowerShell 默认输出，Node 按 UTF-8 解）: {0}" -f $beforeTxt) -ForegroundColor DarkGray
Write-Host ("  修复后（强制 UTF-8 输出）                      : {0}" -f $afterTxt) -ForegroundColor DarkGray

$pickOk = ($afterTxt.Trim() -eq $CN)
$beforeBroken = ($beforeTxt.Trim() -ne $CN)
if ($pickOk) {
  Write-Host ("  OK  中文路径回传正确（修复前确实乱码: {0}）" -f $beforeBroken) -ForegroundColor Green
} else {
  Write-Host "  FAIL 中文路径仍然乱码" -ForegroundColor Red
}

# ---------- 汇总 ----------
$allOk = ($r1.Errors -eq 0 -and $started)
if (Test-Path $bat) { $allOk = $allOk -and ($r2.Errors -eq 0) }
$allOk = $allOk -and $pickOk

Write-Host ""
Write-Host "============================================"
Write-Host ("  启动脚本   : {0}" -f $(if ($r1.Errors -eq 0 -and $started) { '通过' } else { '失败' }))
if (Test-Path $bat) { Write-Host ("  生成的脚本 : {0}" -f $(if ($r2.Errors -eq 0) { '通过' } else { '失败' })) }
Write-Host ("  选择器编码 : {0}" -f $(if ($pickOk) { '通过' } else { '失败' }))
Write-Host ("  >>> 总体   : {0}" -f $(if ($allOk) { '全部通过' } else { '有失败项' })) -ForegroundColor $(if ($allOk) { 'Green' } else { 'Red' })
Write-Host "============================================"
