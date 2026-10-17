/**
 * FFmpeg 命令生成器 —— 本地服务端（零第三方依赖）
 *
 * 职责：
 *   1. 托管 public/ 下的静态网页
 *   2. 提供本地文件系统浏览 / 扫描（用于选择输入与输出位置）
 *   3. 检测 ffmpeg / ffprobe，并读取媒体信息
 *   4. 执行生成的 ffmpeg 命令，实时回传日志
 *   5. 保存批处理脚本到磁盘
 *
 * 只监听 127.0.0.1，纯单机运行，不对外暴露。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const IS_WIN = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * 静态资源
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 解析失败: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

/** 把可能是相对路径的输入统一成绝对路径 */
function abs(p) {
  if (!p) return '';
  return path.resolve(String(p).replace(/^"|"$/g, '').trim());
}

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.mts', '.vob', '.3gp', '.rmvb', '.rm', '.ogv', '.f4v', '.asf', '.divx'
]);
const AUDIO_EXT = new Set(['.mp3', '.aac', '.wav', '.flac', '.ogg', '.m4a', '.wma', '.opus', '.aiff']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff', '.gif', '.heic']);
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub']);

function kindOf(ext) {
  ext = ext.toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (SUB_EXT.has(ext)) return 'subtitle';
  return 'other';
}

/* ------------------------------------------------------------------ *
 * ffmpeg / ffprobe 探测
 * ------------------------------------------------------------------ */

function findBinary(name) {
  const envKey = name.toUpperCase() + '_PATH';
  const candidates = [];
  if (process.env[envKey]) candidates.push(process.env[envKey]);
  candidates.push(path.join(ROOT, 'bin', IS_WIN ? name + '.exe' : name));
  if (IS_WIN) {
    candidates.push('D:\\lux\\ffmpegbin\\' + name + '.exe');
    candidates.push('C:\\ffmpeg\\bin\\' + name + '.exe');
  } else {
    candidates.push('/usr/local/bin/' + name, '/usr/bin/' + name, '/opt/homebrew/bin/' + name);
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return name; // 交给 PATH
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

const binCache = {};

/* ------------------------------------------------------------------ *
 * 子进程输出解码
 *
 * 中文 Windows 上很多命令行工具的 stdout 是按「当前控制台代码页」(通常是
 * GBK/936) 编码的，例如 PowerShell 的 [Console]::Out.Write。如果直接
 * Buffer.toString()（UTF-8）就会把中文路径解成 G:\�����û�\… 这种乱码。
 *
 * 策略：先按严格 UTF-8 解码，解不动说明不是 UTF-8，再按系统 ANSI 代码页解。
 * 调用方尽量把完整字节流拼好用本函数解码一次，避免多字节字符被分块截断。
 * ------------------------------------------------------------------ */

const SYS_ENCODING = process.platform === 'win32' ? 'gbk' : 'utf-8';
let sysDecoder = null;
try { sysDecoder = new TextDecoder(SYS_ENCODING); } catch (_) { sysDecoder = null; }

function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try {
    // fatal:true —— 遇到非法 UTF-8 序列会抛错，正好用来判断「这到底是不是 UTF-8」
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    if (sysDecoder) {
      try { return sysDecoder.decode(buf); } catch (__) { /* 落到最后兜底 */ }
    }
    return Buffer.from(buf).toString('utf8');
  }
}

function runCapture(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    const outChunks = [];
    const errChunks = [];
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: String(e && e.message) });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeout);
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: decodeOutput(Buffer.concat(outChunks)),
        stderr: decodeOutput(Buffer.concat(errChunks))
      });
    });
  });
}

async function checkTool(key, bin, args) {
  if (binCache[key]) return binCache[key];
  const r = await runCapture(bin, args);
  const info = r.ok
    ? { available: true, path: bin, version: (r.stdout || r.stderr).split('\n')[0].trim() }
    : { available: false, path: bin, error: r.error || (r.stderr || '').split('\n')[0] || '不可用' };
  binCache[key] = info;
  return info;
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const routes = {

  /* 运行环境 */
  'GET /api/env': async (req, res) => {
    const [ff, fp] = await Promise.all([
      checkTool('ffmpeg', FFMPEG, ['-version']),
      checkTool('ffprobe', FFPROBE, ['-version'])
    ]);
    if (!encodersCache && ff.available) await loadEncoders();
    sendJson(res, 200, {
      platform: process.platform,
      isWindows: IS_WIN,
      pathSep: path.sep,
      node: process.version,
      cwd: process.cwd(),
      home: os.homedir(),
      desktop: path.join(os.homedir(), 'Desktop'),
      ffmpeg: ff,
      ffprobe: fp,
      encoders: encodersCache || [],
      filters: FF_FILTERS
    });
  },

  /* 目录浏览 */
  'GET /api/fs/list': async (req, res, q) => {
    let p = abs(q.get('p')) || os.homedir();
    let st;
    try {
      st = await fsp.stat(p);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '路径不存在或无法访问：' + p });
    }
    if (!st.isDirectory()) p = path.dirname(p);

    let entries;
    try {
      entries = await fsp.readdir(p, { withFileTypes: true });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '无法读取目录：' + e.message });
    }

    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        dirs.push({ name: e.name, path: full, type: 'dir' });
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        const kind = kindOf(ext);
        files.push({ name: e.name, path: full, type: 'file', ext: ext.toLowerCase(), kind });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    // Windows 下提供盘符快捷入口
    const drives = [];
    if (IS_WIN) {
      for (let i = 67; i <= 90; i++) { // C..Z
        const d = String.fromCharCode(i) + ':\\';
        try { if (fs.existsSync(d)) drives.push(d); } catch (_) {}
      }
    }

    sendJson(res, 200, {
      ok: true,
      path: p,
      parent: path.dirname(p) === p ? null : path.dirname(p),
      sep: path.sep,
      dirs,
      files,
      drives,
      quick: [
        { name: '桌面', path: path.join(os.homedir(), 'Desktop') },
        { name: '下载', path: path.join(os.homedir(), 'Downloads') },
        { name: '视频', path: path.join(os.homedir(), 'Videos') },
        { name: '用户目录', path: os.homedir() }
      ]
    });
  },

  /* 扫描目录中的媒体文件 */
  'POST /api/fs/scan': async (req, res) => {
    const body = await readBody(req);
    const dir = abs(body.path);
    if (!dir) return sendJson(res, 200, { ok: false, error: '请提供目录路径' });

    const recursive = !!body.recursive;
    const use = new Set((body.use || ['video']).map((s) => String(s).toLowerCase()));
    const results = [];

    async function walk(d, depth) {
      if (depth > 6) return;
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch (_) { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (recursive && !e.name.startsWith('.')) await walk(full, depth + 1);
        } else if (e.isFile()) {
          const kind = kindOf(path.extname(e.name));
          if (use.has(kind)) results.push({ name: e.name, path: full, kind, ext: path.extname(e.name).toLowerCase() });
        }
      }
    }

    try {
      const st = await fsp.stat(dir);
      if (st.isFile()) {
        results.push({ name: path.basename(dir), path: dir, kind: kindOf(path.extname(dir)), ext: path.extname(dir).toLowerCase() });
      } else {
        await walk(dir, 0);
      }
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '扫描失败：' + e.message });
    }

    const sortBy = body.sort || 'name';
    if (sortBy === 'name') results.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
    else if (sortBy === 'mtime') { /* 保持 readdir 顺序 */ }
    else if (sortBy === 'size') results.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));

    sendJson(res, 200, { ok: true, dir, count: results.length, files: results });
  },

  /* 新建输出目录 */
  'POST /api/fs/mkdir': async (req, res) => {
    const body = await readBody(req);
    const dir = abs(body.path);
    if (!dir) return sendJson(res, 200, { ok: false, error: '请提供目录路径' });
    try {
      await fsp.mkdir(dir, { recursive: true });
      sendJson(res, 200, { ok: true, path: dir });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: '创建失败：' + e.message });
    }
  },

  /* 判断路径类型 */
  'POST /api/fs/stat': async (req, res) => {
    const body = await readBody(req);
    const p = abs(body.path);
    try {
      const st = await fsp.stat(p);
      sendJson(res, 200, {
        ok: true, path: p,
        isDirectory: st.isDirectory(), isFile: st.isFile(),
        size: st.size, kind: st.isFile() ? kindOf(path.extname(p)) : 'dir'
      });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: '路径不可访问：' + p });
    }
  },

  /* ffprobe 读取媒体信息 */
  'POST /api/probe': async (req, res) => {
    const body = await readBody(req);
    const p = abs(body.path);
    if (!p) return sendJson(res, 200, { ok: false, error: '请提供文件路径' });
    const r = await runCapture(FFPROBE, [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', p
    ], 30000);
    if (!r.ok) return sendJson(res, 200, { ok: false, error: (r.stderr || r.error || '探测失败').trim() });
    try {
      const j = JSON.parse(r.stdout);
      const v = (j.streams || []).find((s) => s.codec_type === 'video');
      const a = (j.streams || []).find((s) => s.codec_type === 'audio');
      sendJson(res, 200, {
        ok: true,
        summary: {
          duration: j.format && j.format.duration ? Number(j.format.duration) : null,
          size: j.format && j.format.size ? Number(j.format.size) : null,
          bitrate: j.format && j.format.bit_rate ? Number(j.format.bit_rate) : null,
          formatName: j.format ? j.format.format_name : '',
          vcodec: v ? v.codec_name : null,
          width: v ? v.width : null,
          height: v ? v.height : null,
          fps: v && v.r_frame_rate ? evalFps(v.r_frame_rate) : null,
          pixFmt: v ? v.pix_fmt : null,
          acodec: a ? a.codec_name : null,
          sampleRate: a ? Number(a.sample_rate) : null,
          channels: a ? a.channels : null,
          streamCount: (j.streams || []).length
        },
        raw: j
      });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: '解析 ffprobe 输出失败' });
    }
  },

  /* 打开系统文件/文件夹选择器（Windows 优先） */
  'POST /api/pick': async (req, res) => {
    const body = await readBody(req);
    const mode = body.mode === 'file' ? 'file' : body.mode === 'files' ? 'files' : 'dir';
    if (!IS_WIN) return sendJson(res, 200, { ok: false, error: '当前系统暂不支持原生选择器，请手动输入路径' });

    // ⚠️ 第一行不能省：PowerShell 重定向 stdout 时默认按「控制台代码页」(中文系统是 GBK/936)
    // 编码输出，中文路径会变成乱码。这里强制它用 UTF-8 写，Node 侧才能正确解出来。
    const PS_UTF8 = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
`;
    const ps = mode === 'dir'
      ? PS_UTF8 + `Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择文件夹'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`
      : PS_UTF8 + `Add-Type -AssemblyName System.Windows.Forms | Out-Null
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Filter = '媒体文件|*.mp4;*.mkv;*.mov;*.avi;*.flv;*.wmv;*.webm;*.m4v;*.ts;*.mpg;*.mpeg;*.mp3;*.wav;*.aac;*.flac;*.m4a;*.jpg;*.png;*.srt;*.ass|所有文件|*.*'
$f.Multiselect = ${mode === 'files' ? '$true' : '$false'}
if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write(($f.FileNames -join "\`n")) }`;

    const r = await runCapture('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], 300000);
    const picked = (r.stdout || '').replace(/^\uFEFF/, '').trim();
    if (!picked) return sendJson(res, 200, { ok: true, canceled: true });
    sendJson(res, 200, { ok: true, canceled: false, paths: picked.split('\n').map((s) => s.trim()).filter(Boolean) });
  },

  /* 执行 ffmpeg 命令（SSE 风格流式日志） */
  'POST /api/run': async (req, res) => {
    const body = await readBody(req);
    const args = Array.isArray(body.args) ? body.args.map(String) : [];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const emit = (event, data) => {
      try { res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`); } catch (_) {}
    };

    if (body.dryRun) {
      emit('log', { text: '$ ffmpeg ' + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') + '\n' });
      emit('done', { code: 0, dryRun: true });
      return res.end();
    }

    emit('log', { text: '$ ffmpeg ' + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') + '\n\n' });

    let child;
    try {
      child = spawn(FFMPEG, args, { windowsHide: true, cwd: body.cwd || undefined });
    } catch (e) {
      emit('log', { text: '\n[启动失败] ' + e.message + '\n' });
      emit('done', { code: -1 });
      return res.end();
    }

    let tail = '';
    // 用流式 TextDecoder：中文路径的 UTF-8 字节可能被切在两个 data 块之间，
    // 直接 d.toString() 会产生半个字符的乱码。stdout/stderr 各用一个解码器。
    const makeSink = () => {
      const dec = new TextDecoder('utf-8');
      return (d) => {
        const text = dec.decode(d, { stream: true });
        if (!text) return;
        tail = (tail + text).slice(-4000);
        emit('log', { text });
      };
    };
    child.stdout.on('data', makeSink());
    child.stderr.on('data', makeSink());
    child.on('error', (e) => {
      emit('log', { text: '\n[错误] ' + e.message + '\n（若提示找不到 ffmpeg，请把它加入 PATH 或放到项目 bin 目录）\n' });
      emit('done', { code: -1 });
      res.end();
    });
    child.on('close', (code) => {
      emit('done', { code, tail: tail.slice(-1200) });
      res.end();
    });

    req.on('close', () => {
      if (!res.writableEnded) { try { child.kill(); } catch (_) {} }
    });
  },

  /* 保存脚本 / 文本文件 */
  'POST /api/save': async (req, res) => {
    const body = await readBody(req);
    const target = abs(body.path);
    if (!target) return sendJson(res, 200, { ok: false, error: '请提供保存路径' });
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, String(body.content == null ? '' : body.content), 'utf8');
      sendJson(res, 200, { ok: true, path: target });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: '保存失败：' + e.message });
    }
  },

  /* 在资源管理器中打开 */
  'POST /api/open': async (req, res) => {
    const body = await readBody(req);
    const p = abs(body.path);
    if (!p) return sendJson(res, 200, { ok: false, error: '请提供路径' });
    try {
      if (IS_WIN) spawn('explorer.exe', [p], { detached: true, windowsHide: false }).unref();
      else if (process.platform === 'darwin') spawn('open', [p], { detached: true }).unref();
      else spawn('xdg-open', [p], { detached: true }).unref();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message });
    }
  },

  /* 磁盘/根目录 */
  'GET /api/fs/roots': async (req, res) => {
    const roots = [];
    if (IS_WIN) {
      for (let i = 67; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try { if (fs.existsSync(d)) roots.push(d); } catch (_) {}
      }
    } else {
      roots.push('/');
      roots.push(os.homedir());
    }
    sendJson(res, 200, { ok: true, roots });
  }
};

function evalFps(rate) {
  if (!rate) return null;
  const [n, d] = String(rate).split('/').map(Number);
  if (!d) return n || null;
  return Math.round((n / d) * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * ffmpeg 滤镜能力探测（启动时一次性）
 * ------------------------------------------------------------------ */

let FF_FILTERS = [];
let encodersCache = null;

/** 读取可用编码器列表，供「跟随源素材编码器」判断 libx265 等是否存在 */
async function loadEncoders() {
  const r = await runCapture(FFMPEG, ['-hide_banner', '-encoders'], 20000);
  if (!r.ok) return;
  const names = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*[VAS][F.][S.][X.][B.][D.]\s+([A-Za-z0-9_]+)\s+/);
    if (m) names.push(m[1]);
  }
  encodersCache = names;
}

async function loadFilters() {
  const r = await runCapture(FFMPEG, ['-hide_banner', '-filters'], 20000);
  if (!r.ok) return;
  const names = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*[TSC.]{3}\s+([A-Za-z0-9_]+)\s+/);
    if (m) names.push(m[1]);
  }
  FF_FILTERS = names;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  // 本地服务，允许同源即可
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${parsed.pathname}`;

  if (routes[key]) {
    try {
      await routes[key](req, res, parsed.searchParams);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      else try { res.end(); } catch (_) {}
    }
    return;
  }

  if (parsed.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: '未知接口: ' + parsed.pathname });
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, async () => {
  const ff = await checkTool('ffmpeg', FFMPEG, ['-version']);
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║        FFmpeg 命令生成器  已启动                 ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('   访问地址 : ' + url);
  console.log('   FFmpeg   : ' + (ff.available ? ff.version : '未检测到（仍可生成命令，无法直接执行）'));
  console.log('');
  console.log('   按 Ctrl+C 停止服务');
  console.log('');
  if (!ff.available) {
    console.log('   [提示] 未找到 ffmpeg，请安装后加入 PATH，');
    console.log('          或将 ffmpeg.exe 放到项目 bin 目录下。');
    console.log('');
  }
  loadFilters();
  loadEncoders();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用。可用环境变量换端口启动，例如：`);
    console.error(`  Windows:  set PORT=8899 && node server.js`);
    console.error(`  macOS/Linux:  PORT=8899 node server.js\n`);
  } else {
    console.error('[错误] ' + e.message);
  }
  process.exit(1);
});
