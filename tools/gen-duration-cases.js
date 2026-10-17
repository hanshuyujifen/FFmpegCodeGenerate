/**
 * 生成「带时长断言」的测试用例（配合 tools/test-durations.ps1 使用）
 *
 * 为什么要专门测时长：
 *   trim=start=00:00:10:end=00:00:20 这种写法不会让 ffmpeg 报错，
 *   而是被静默解析成 start=0，输出时长完全错。只有量时长才能发现。
 *
 * 另外还验证「无损模式」：命令里必须只有 -c copy，不能出现编码器参数，
 * 且成品的视频编码必须与源素材一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public', 'js');
const MEDIA = path.join(ROOT, 'test', 'fmt');
const OUT = path.join(ROOT, 'test', 'dur');

global.window = global;
for (const f of ['engine.js', 'recipes-edit.js', 'recipes-format.js', 'recipes-visual.js', 'recipes-audio.js']) {
  const p = path.join(PUB, f);
  if (fs.existsSync(p)) eval(fs.readFileSync(p, 'utf8')); // eslint-disable-line no-eval
}
const A = global.FFGEN;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const WITH_A = path.join(MEDIA, 'withaudio.mp4');   // 8 秒，有音轨
const NO_A = path.join(MEDIA, 'noaudio.mp4');       // 8 秒，无音轨
const GOP = path.join(MEDIA, 'gop.mp4');            // 8 秒，每 1 秒一个关键帧

const cases = [];

/**
 * @param opts.requireCopy  要求所有命令里不能出现重编码参数（无损模式）
 * @param opts.tolerance    时长容差
 */
function add(label, recipeId, input, values, expectSec, hasAudio, opts) {
  opts = opts || {};
  const r = A.getRecipe(recipeId);
  if (!r) { console.log('  跳过不存在的配方 ' + recipeId); return; }
  const plan = A.buildPlan({
    platform: 'win32', ffmpegBin: 'ffmpeg',
    inputFiles: [input], outputDir: OUT, suffix: '_dur', overwrite: true,
    hasAudio, steps: [{ recipeId, values: Object.assign(A.defaults(r), values) }]
  });
  if (!plan.ok) { console.log('  ✗ ' + label + ' 构建失败: ' + plan.error); return; }

  // 按顺序执行：准备命令 -> 主命令
  const argvList = plan.jobs.map((j) => j.argv);
  const main = plan.jobs[plan.jobs.length - 1];

  const c = {
    label,
    id: recipeId,
    argvList,
    expectSec,
    tolerance: opts.tolerance == null ? 0.35 : opts.tolerance,
    output: main.output,
    requireCopy: !!opts.requireCopy,
    srcCodec: opts.srcCodec || null
  };

  if (c.requireCopy) {
    const all = argvList.map((a) => a.join(' ')).join(' || ');
    if (!/-c copy|-c:v copy/.test(all)) {
      console.log('  ✗ ' + label + ' 无损模式没有出现 -c copy');
    }
    if (/-c:v lib| -crf | -preset /.test(all)) {
      console.log('  ✗ ' + label + ' 无损模式里出现了编码参数（应当只做流复制）');
    }
    c.copyOk = !/-c:v lib| -crf | -preset /.test(all);
  }

  // 清理上次残留
  try { fs.unlinkSync(c.output); } catch (_) {}
  for (let i = 1; i <= 8; i++) {
    try { fs.unlinkSync(path.join(OUT, `gop_seg${i}.mp4`)); } catch (_) {}
    try { fs.unlinkSync(path.join(OUT, `withaudio_seg${i}.mp4`)); } catch (_) {}
  }
  (plan.auxFiles || []).forEach((a) => { try { fs.writeFileSync(a.path, a.content, 'utf8'); } catch (_) {} });

  cases.push(c);
}

/* 8 秒素材上的期望时长 */
// 保留 2-4 秒 + 6-7 秒  =>  2 + 1 = 3 秒
const RANGES = '00:00:02-00:00:04\n00:00:06-00:00:07';
add('保留多区间·重编码（有音轨）', 'trim-keep-ranges', WITH_A, { mode: 'precise', ranges: RANGES }, 3.0, true);
add('保留多区间·重编码（无音轨）', 'trim-keep-ranges', NO_A, { mode: 'precise', ranges: RANGES }, 3.0, false);

// 无损模式：需要关键帧密集的素材，容差放宽到 1.2 秒
add('保留多区间·无损（有音轨）', 'trim-keep-ranges', GOP, { mode: 'copy', ranges: RANGES }, 3.0, true,
    { requireCopy: true, tolerance: 1.2, srcCodec: 'h264' });
add('保留多区间·无损（无音轨）', 'trim-keep-ranges', NO_A, { mode: 'copy', ranges: RANGES }, 3.0, false,
    { requireCopy: true, tolerance: 2.5, srcCodec: 'h264' });

// 删掉 2-4 秒  =>  8 - 2 = 6 秒
add('删除中间段（有音轨）', 'trim-remove-middle', WITH_A, { from: '00:00:02', to: '00:00:04' }, 6.0, true);
add('删除中间段（无音轨）', 'trim-remove-middle', NO_A, { from: '00:00:02', to: '00:00:04' }, 6.0, false);

// 2 倍速  =>  4 秒
add('变速 2x（无音轨）', 'speed-change', NO_A, { speed: 2 }, 4.0, false);
add('变速 2x（有音轨）', 'speed-change', WITH_A, { speed: 2 }, 4.0, true);

// 普通精确剪辑：-ss/-t 本来就是命令行参数，HH:MM:SS 是合法的
add('精确剪辑 1s 起取 2s', 'trim-accurate', WITH_A, { start: '00:00:01', dur: '00:00:02' }, 2.0, true);

fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases, null, 1), 'utf8');
console.log(`已生成 ${cases.length} 个时长用例 -> ${path.join(OUT, 'cases.json')}`);
