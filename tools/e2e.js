/**
 * e2e.js —— 端到端验证：用真实 ffmpeg 跑一遍生成的命令
 *
 * 因为 Node 在 DSH 沙箱里无法用管道捕获子进程输出，本脚本只负责「生成」，
 * 把 argv 列表写到 test/out/commands.json，再由 PowerShell 实际执行。
 *
 * 用法： node tools/e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public', 'js');
const MEDIA = path.join(ROOT, 'test', 'media');
const OUT = path.join(ROOT, 'test', 'out');

global.window = global;
for (const f of ['engine.js', 'recipes-edit.js', 'recipes-format.js', 'recipes-visual.js', 'recipes-audio.js']) {
  const p = path.join(PUB, f);
  if (!fs.existsSync(p)) continue;
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(p, 'utf8'));
}

const A = global.FFGEN;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const IN_A = path.join(MEDIA, 'a.mp4');
const IN_B = path.join(MEDIA, 'b 空格测试.mkv');
const WITHSUB = path.join(MEDIA, 'withsub.mp4');
const HDR = path.join(MEDIA, 'hdr.mp4');
const COVER = path.join(MEDIA, 'cover.png');
const SRT = path.join(MEDIA, 'sub.srt');
const ASS = path.join(MEDIA, 'sub.ass');
const MP3 = path.join(MEDIA, 'bgm.mp3');
const MP3B = path.join(MEDIA, 'bgm2.mp3');
const FRAMES = path.join(MEDIA, 'frames', 'img001.jpg');

fs.writeFileSync(SRT, '1\n00:00:00,500 --> 00:00:02,000\n测试字幕\n\n2\n00:00:02,500 --> 00:00:04,000\n第二行\n', 'utf8');

/* 需要特殊素材的配方：换掉输入文件，避免「素材不对」造成假失败 */
const FIXTURE = {
  'concat-image-to-video': { inputs: [FRAMES], values: { pattern: 'img%03d.jpg' } },
  'flt-hdr2sdr': { inputs: [HDR] },
  'sub-extract': { inputs: [WITHSUB] },
  'sub-burn-embedded': { inputs: [WITHSUB] },
  'audio-concat': { inputs: [MP3, MP3B] },
  'audio-volumedetect': { inputs: [MP3] },
  'audio-loudness-scan': { inputs: [MP3] }
};

/* 为 path 类型字段猜测一个合适的测试文件 */
function fillPaths(values, recipe) {
  for (const f of recipe.fields || []) {
    if (f.type !== 'path' && f.type !== 'dir') continue;
    const k = f.k.toLowerCase();
    if (f.type === 'dir') { values[f.k] = MEDIA; continue; }
    // 更具体的先判断：ass / srt 要分别给真正的 ass、srt 文件
    if (/ass/.test(k)) values[f.k] = ASS;
    else if (/srt|sub|caption/.test(k)) values[f.k] = SRT;
    else if (/font|ttf/.test(k)) values[f.k] = 'C:\\Windows\\Fonts\\msyh.ttc';
    else if (/audio|music|bgm|sound|mp3/.test(k)) values[f.k] = MP3;
    else if (/img|image|logo|water|pic|photo|mask/.test(k)) values[f.k] = COVER;
    else values[f.k] = COVER;
  }
}

/* 目前所有配方都应该能跑通；留这个集合是为了以后临时排除 */
const SKIP = new Set([]);

const commands = [];
const skipped = [];

for (const r of A.RECIPES) {
  if (SKIP.has(r.id)) { skipped.push(r.id + '（只做分析，无输出）'); continue; }

  const values = A.defaults(r);
  fillPaths(values, r);

  const fx = FIXTURE[r.id];
  if (fx && fx.values) Object.assign(values, fx.values);

  // 让时间类默认值不至于落在测试视频之外
  for (const f of r.fields || []) {
    if (f.type === 'time' && /start|from|at/i.test(f.k)) values[f.k] = '00:00:01';
    if (f.type === 'time' && /dur|hold|end|to/i.test(f.k) && !/end|to/i.test(f.k)) values[f.k] = '00:00:02';
  }
  if (values.offset != null && Number(values.offset) > 3) values.offset = 1.5;
  if (values.fps != null && Number(values.fps) > 60 && r.id.includes('interp')) values.fps = 60;
  if (values.every != null && Number(values.every) > 10) values.every = 5;
  if (values.segTime != null && Number(values.segTime) > 2) values.segTime = 2;
  if (values.factor != null && Number(values.factor) > 2) values.factor = 2;

  let inputs = [IN_A];
  if (r.scope === 'set' && r.minInputs >= 2) inputs = [IN_A, IN_B];
  if (r.minInputs >= 2 && r.scope !== 'set') inputs = [IN_A, IN_B];
  if (fx && fx.inputs) inputs = fx.inputs;

  const plan = A.buildPlan({
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    ffmpegBin: 'ffmpeg',
    inputMode: inputs.length > 1 ? 'files' : 'single',
    inputFiles: inputs,
    outputDir: OUT,
    suffix: '_e2e',
    overwrite: true,
    steps: [{ recipeId: r.id, values }]
  });

  if (!plan.ok) { skipped.push(r.id + '（' + plan.error + '）'); continue; }

  plan.jobs.forEach((job, i) => {
    commands.push({
      id: r.id,
      cat: r.cat,
      name: r.name,
      idx: i,
      argv: job.argv,
      output: job.output,
      aux: job.aux || []
    });
  });
  // 写附属文件
  (plan.auxFiles || []).forEach((a) => {
    try { fs.writeFileSync(a.path, a.content, 'utf8'); } catch (_) {}
  });
}

/* 让部分命令更快：把 CRF 测试用的 preset 调快 */
for (const c of commands) {
  const i = c.argv.indexOf('-preset');
  if (i >= 0 && ['medium', 'slow', 'slower', 'veryslow'].includes(c.argv[i + 1])) c.argv[i + 1] = 'ultrafast';
  const j = c.argv.indexOf('-crf');
  if (j >= 0) c.argv[j + 1] = '30';
}

fs.writeFileSync(path.join(OUT, 'commands.json'), JSON.stringify(commands, null, 1), 'utf8');
fs.writeFileSync(path.join(OUT, '_skipped.txt'), skipped.join('\n'), 'utf8');

console.log(`生成命令 ${commands.length} 条，涉及配方 ${new Set(commands.map((c) => c.id)).size} 个`);
console.log(`跳过 ${skipped.length} 条：`);
skipped.forEach((s) => console.log('  - ' + s));
