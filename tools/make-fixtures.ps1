# 生成 tools/e2e.js 需要的测试素材（跑端到端验证前先执行一次）
# 用法： powershell -ExecutionPolicy Bypass -File tools\make-fixtures.ps1
param([string]$Ffmpeg = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$m = Join-Path $root "test\media"

if (-not $Ffmpeg) {
  if (Test-Path "D:\lux\ffmpegbin\ffmpeg.exe") { $Ffmpeg = "D:\lux\ffmpegbin\ffmpeg.exe" }
  else { $Ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
}
if (-not $Ffmpeg) { Write-Host "找不到 ffmpeg，请用 -Ffmpeg 指定完整路径"; exit 1 }

New-Item -ItemType Directory -Force -Path $m, (Join-Path $m "frames") | Out-Null
Write-Host "素材目录: $m"

function Run([string[]]$a) { & $Ffmpeg -hide_banner -loglevel error -y @a; if ($LASTEXITCODE -ne 0) { throw "ffmpeg 失败: $($a -join ' ')" } }

# 1) 主素材：640x360 30fps 6 秒，带 440Hz 正弦音轨
Run @('-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=6',
      '-f','lavfi','-i','sine=frequency=440:duration=6',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest', (Join-Path $m 'a.mp4'))

# 2) 第二段素材：分辨率/帧率都不同，且文件名带空格
Run @('-f','lavfi','-i','testsrc2=size=1280x720:rate=25:duration=4',
      '-f','lavfi','-i','sine=frequency=880:duration=4',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest', (Join-Path $m 'b 空格测试.mkv'))

# 3) 静态图（水印 / 截图 / 封面用）
Run @('-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=2','-frames:v','1', (Join-Path $m 'cover.png'))

# 4) 音频素材
Run @('-f','lavfi','-i','sine=frequency=330:duration=8','-c:a','libmp3lame','-b:a','128k', (Join-Path $m 'bgm.mp3'))
Run @('-f','lavfi','-i','sine=frequency=220:duration=3','-c:a','libmp3lame','-b:a','128k', (Join-Path $m 'bgm2.mp3'))

# 5) 字幕文件
$srt = "1`n00:00:00,500 --> 00:00:02,000`n测试字幕`n`n2`n00:00:02,500 --> 00:00:04,000`n第二行`n"
[System.IO.File]::WriteAllText((Join-Path $m 'sub.srt'), $srt, (New-Object System.Text.UTF8Encoding $false))

$ass = @"
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,测试 ASS 字幕
Dialogue: 0,0:00:02.50,0:00:04.00,Default,,0,0,0,,第二行 {\i1}斜体{\i0}
"@
[System.IO.File]::WriteAllText((Join-Path $m 'sub.ass'), $ass, (New-Object System.Text.UTF8Encoding $false))

# 6) 带内嵌字幕轨的视频（测「烧录内嵌字幕」「提取字幕轨」）
Run @('-i', (Join-Path $m 'a.mp4'), '-i', (Join-Path $m 'sub.srt'),
      '-map','0','-map','1','-c','copy','-c:s','mov_text','-metadata:s:s:0','language=chi', (Join-Path $m 'withsub.mp4'))

# 7) 图片序列（测「图片序列合成视频」）
Run @('-i', (Join-Path $m 'a.mp4'), '-vf','fps=5,scale=320:-2', (Join-Path $m 'frames\img%03d.jpg'))

# 8) 真正的 HDR 素材（测「HDR 转 SDR」，只有 libx265 时才生成）
$enc = & $Ffmpeg -hide_banner -encoders 2>&1 | Out-String
if ($enc -match 'libx265') {
  Run @('-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=2','-vf','format=yuv420p10le',
        '-c:v','libx265','-preset','ultrafast',
        '-x265-params','log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        '-tag:v','hvc1', (Join-Path $m 'hdr.mp4'))
} else {
  Write-Host "  [跳过] 没有 libx265，不生成 hdr.mp4（HDR 转 SDR 那条会因缺素材失败，属正常）"
}

# 9) 时长断言用的 8 秒素材：有音轨 / 无音轨各一（tools/test-durations.ps1 需要）
$fmtDir = Join-Path $root "test\fmt"
New-Item -ItemType Directory -Force -Path $fmtDir | Out-Null
Run @('-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=8',
      '-f','lavfi','-i','sine=frequency=440:duration=8',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest', (Join-Path $fmtDir 'withaudio.mp4'))
Run @('-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=8',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-an', (Join-Path $fmtDir 'noaudio.mp4'))
# 关键帧密集的素材（每 1 秒一个关键帧），用于验证无损切片的时长准确度
Run @('-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=8',
      '-f','lavfi','-i','sine=frequency=440:duration=8',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','25','-keyint_min','25','-sc_threshold','0',
      '-c:a','aac','-shortest', (Join-Path $fmtDir 'gop.mp4'))

Write-Host ""
Get-ChildItem $m -File | Select-Object Name, Length | Format-Table -AutoSize
Write-Host "素材准备完成。"
