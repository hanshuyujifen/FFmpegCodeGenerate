/**
 * selftest.js —— 本地自检脚本（开发/校验用，不影响网页功能）
 *
 * 用法： node tools/selftest.js            全部检查
 *        node tools/selftest.js 剪辑       只跑名字里含关键词的配方
 *
 * 它会：加载全部配方 -> 对每个配方用默认参数生成命令 -> 校验参数合法性 -> 打印结果。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public', 'js');
const FILES = ['engine.js', 'recipes-edit.js', 'recipes-format.js', 'recipes-visual.js', 'recipes-audio.js'];

global.window = global;
let loaded = [];
for (const f of FILES) {
  const p = path.join(PUB, f);
  if (!fs.existsSync(p)) { console.log(`  [跳过] ${f} 不存在`); continue; }
  try {
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(p, 'utf8'));
    loaded.push(f);
  } catch (e) {
    console.error(`  [失败] 加载 ${f}: ${e.message}`);
    process.exit(1);
  }
}

const A = global.FFGEN;
const filter = process.argv[2] || '';

console.log('');
console.log('已加载：' + loaded.join(', '));
console.log('分类 ' + A.CATS.length + ' 个 | 操作 ' + A.RECIPES.length + ' 个');
console.log('');

/* ---------------- 结构校验 ---------------- */

let problems = 0;
const ids = new Set();
for (const r of A.RECIPES) {
  if (ids.has(r.id)) { console.error(`  ✗ 配方 id 重复: ${r.id}`); problems++; }
  ids.add(r.id);
  if (!A.getCat(r.cat)) { console.error(`  ✗ ${r.id} 的分类不存在: ${r.cat}`); problems++; }
  const keys = new Set();
  for (const f of r.fields || []) {
    if (keys.has(f.k)) { console.error(`  ✗ ${r.id} 字段 k 重复: ${f.k}`); problems++; }
    keys.add(f.k);
    if (!['text', 'number', 'time', 'select', 'bool', 'textarea', 'path', 'dir', 'range'].includes(f.type)) {
      console.error(`  ✗ ${r.id}.${f.k} 未知字段类型: ${f.type}`); problems++;
    }
    if (f.type === 'select' && (!f.options || !f.options.length)) {
      console.error(`  ✗ ${r.id}.${f.k} select 缺少 options`); problems++;
    }
  }
  if (typeof r.build !== 'function') { console.error(`  ✗ ${r.id} 缺少 build 函数`); problems++; }
}
for (const c of A.CATS) {
  if (!A.RECIPES.some((r) => r.cat === c.id)) console.log(`  ! 分类「${c.name}」下没有任何操作`);
}

/* ---------------- 逐个生成命令 ---------------- */

const INPUTS = [
  'C:\\Users\\Test\\Videos\\示例 视频 A.mp4',
  'C:\\Users\\Test\\Videos\\示例 视频 B.mkv'
];
const OUT = 'C:\\Users\\Test\\输出';

let okCount = 0, failCount = 0, skipped = 0;

for (const r of A.RECIPES) {
  if (filter && !(r.name + r.id + (r.tags || []).join('')).includes(filter)) { skipped++; continue; }
  const values = A.defaults(r);
  // 把 path / dir 字段填上假路径，否则很多操作会走「缺文件就退化」的分支，测不到真正逻辑
  for (const f of r.fields || []) {
    if (f.type === 'path') values[f.k] = 'C:\\Users\\Test\\extra\\素材.mp4';
    if (f.type === 'dir') values[f.k] = 'C:\\Users\\Test\\extra';
  }
  const plan = A.buildPlan({
    platform: 'win32',
    ffmpegBin: 'ffmpeg',
    inputMode: 'files',
    inputFiles: INPUTS,
    outputDir: OUT,
    suffix: '_out',
    overwrite: true,
    steps: [{ recipeId: r.id, values }]
  });

  if (!plan.ok) {
    console.error(`  ✗ [${r.cat}] ${r.name}\n      buildPlan 失败: ${plan.error}`);
    failCount++;
    continue;
  }

  const job = plan.jobs[plan.jobs.length - 1];
  const argv = job.argv;

  // 基本合法性
  const errs = [];
  if (!Array.isArray(argv) || !argv.length) errs.push('argv 为空');
  if (argv.some((a) => a == null)) errs.push('argv 含 null/undefined');
  if (argv.some((a) => typeof a === 'string' && a.indexOf('undefined') >= 0)) errs.push('argv 含 "undefined" 字面量');
  if (argv.some((a) => typeof a === 'string' && a.indexOf('NaN') >= 0)) errs.push('argv 含 "NaN"');
  if (argv.filter((a) => a === '-i').length < job.inputs.length) {
    errs.push(`-i 数量(${argv.filter((a) => a === '-i').length}) 少于输入数(${job.inputs.length})`);
  }
  if (plan.jobs.some((j) => !j.output) && r.outExt && !/volumedetect|loglevel|benchmark/.test(r.id)) {
    // 允许少数只做分析的操作没有输出
  }
  // 检查 -vf / -filter_complex 括号配平
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-vf' || argv[i] === '-af' || argv[i] === '-filter_complex') {
      const v = argv[i + 1] || '';
      const open = (v.match(/\[/g) || []).length, close = (v.match(/\]/g) || []).length;
      if (open !== close) errs.push(`${argv[i]} 的 [] 不配平: ${v}`);
      const p1 = (v.match(/\(/g) || []).length, p2 = (v.match(/\)/g) || []).length;
      if (p1 !== p2) errs.push(`${argv[i]} 的 () 不配平: ${v}`);
    }
  }
  // 不要出现重复的 -c:v
  const cv = argv.filter((a) => a === '-c:v').length;
  if (cv > 1) errs.push(`重复出现 -c:v (${cv} 次)`);

  // 关键审计：滤镜图里引用的输入编号不能超过实际 -i 的数量
  // （这是「配方忘了返回 inputs」这类 bug 的唯一可自动检测特征）
  const iCount = argv.filter((a) => a === '-i').length;
  const graphs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-vf' || argv[i] === '-af' || argv[i] === '-filter_complex') graphs.push(argv[i + 1] || '');
  }
  graphs.push(...(job.aux || []).map((x) => String(x.content || '')));

  // 审计：时间类滤镜选项里绝对不能出现 HH:MM:SS。
  // 冒号是滤镜选项的分隔符，trim=start=00:00:10:end=00:00:20 会被静默解析成 start=0，
  // 命令不报错但输出时长完全错 —— 必须用秒数 trim=start=10:end=20。
  // 只认「时间类选项名 + HH:MM(:SS)」这个组合，避免把 pad=...:48:24:24 之类的坐标误判。
  const TIME_OPT_HMS = /(?:^|[;,\[\]=])(start|end|st|ss|to|duration|offset|start_time|end_time|hold)=(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)/;
  for (const g of graphs) {
    const m = g.match(TIME_OPT_HMS);
    if (m) {
      errs.push(`滤镜参数 ${m[1]}=${m[2]} 用了 HH:MM:SS（冒号会破坏滤镜选项解析，应改用秒数）`);
    }
  }

  // 审计：trim/atrim 的 start / end 必须是纯数字
  for (const g of graphs) {
    const trimRe = /(?:trim|atrim)=((?:[^:;,\[\]]*:)*?)(start|end)=([^:;,\s]+)/g;
    let tm;
    while ((tm = trimRe.exec(g))) {
      const val = tm[3];
      if (!/^-?\d+(?:\.\d+)?$/.test(val)) {
        errs.push(`trim 的 ${tm[2]}=${val} 不是纯秒数（滤镜里不能用 HH:MM:SS）`);
      }
    }
  }
  for (const g of graphs) {
    const refs = new Set();
    const re = /\[(\d+):[vasi](?::\d+)?\]/g;
    let m;
    while ((m = re.exec(g))) refs.add(Number(m[1]));
    for (const n of refs) {
      if (n >= iCount) {
        errs.push(`滤镜图引用了输入 #${n}，但命令里只有 ${iCount} 个 -i（配方很可能忘了返回 inputs）`);
      }
    }
    // -map N:... 同理
    const mapRe = /-map\s+(\d+):/g;
    const joined = argv.join(' ');
    while ((m = mapRe.exec(joined))) {
      if (Number(m[1]) >= iCount) errs.push(`-map 引用了输入 #${m[1]}，但只有 ${iCount} 个 -i`);
    }
  }
  // 声明了 inputs 却没出现在命令里
  if (job.inputs.length > iCount) {
    errs.push(`声明了 ${job.inputs.length} 个输入，但命令里只有 ${iCount} 个 -i`);
  }

  if (errs.length) {
    console.error(`  ✗ [${r.cat}] ${r.name}`);
    errs.forEach((e) => console.error('      · ' + e));
    console.error('      ' + job.text.slice(0, 220));
    failCount++;
    continue;
  }

  okCount++;
  const tag = (A.getCat(r.cat) || {}).name || r.cat;
  console.log(`  ✓ [${tag}] ${r.name}`);
  console.log('      ' + job.text.replace(/\s+/g, ' ').slice(0, 300) + (job.text.length > 300 ? ' …' : ''));
  if (job.notes && job.notes.length) job.notes.forEach((n) => console.log('      ℹ ' + n));
  if (job.warnings && job.warnings.length) job.warnings.forEach((n) => console.log('      ⚠ ' + n));
}

/* ---------------- 组合遍历：把界面上每种可选组合都跑一遍 ---------------- */

console.log('');
console.log('─── 组合遍历（showIf / outExt / build 的所有取值分支） ───');

const COMBO_PATHS = 'C:\\Users\\Test\\extra\\素材.mp4';
const COMBO_DIR = 'C:\\Users\\Test\\extra';
let combos = 0, comboErrs = 0;

function buildOnce(recipe, values, inputs) {
  const plan = A.buildPlan({
    platform: 'win32', ffmpegBin: 'ffmpeg',
    inputFiles: inputs, outputDir: OUT, suffix: '_combo', overwrite: true,
    steps: [{ recipeId: recipe.id, values }]
  });
  if (!plan.ok) throw new Error(plan.error);
  for (const j of plan.jobs) {
    if (j.argv.some((a) => a == null)) throw new Error('argv 含 null');
    if (j.argv.some((a) => typeof a === 'string' && /undefined|NaN|\[object/.test(a))) {
      throw new Error('argv 含脏值: ' + j.text.slice(0, 160));
    }
    // 滤镜里不能出现 HH:MM:SS（冒号会被当成选项分隔符，静默产出错误结果）
    for (let i = 0; i < j.argv.length; i++) {
      if (j.argv[i] !== '-vf' && j.argv[i] !== '-af' && j.argv[i] !== '-filter_complex') continue;
      const g = j.argv[i + 1] || '';
      const m = g.match(/(?:^|[;,\[\]=])(start|end|st|ss|to|duration|offset|start_time|end_time|hold)=(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)/);
      if (m) throw new Error(`滤镜参数 ${m[1]}=${m[2]} 用了 HH:MM:SS（应改用秒数）`);
    }
  }
  return plan;
}

for (const r of A.RECIPES) {
  // 收集所有 select 字段的取值，做笛卡尔积（上限 60 种组合，够覆盖真实分支）
  const selects = (r.fields || []).filter((f) => f.type === 'select' && f.options && f.options.length);
  const bools = (r.fields || []).filter((f) => f.type === 'bool');
  const variants = [];
  let acc = [{}];
  for (const f of selects) {
    const next = [];
    for (const base of acc) {
      for (const o of f.options) {
        const val = o && typeof o === 'object' ? (o.v != null ? o.v : o) : o;
        next.push(Object.assign({}, base, { [f.k]: val }));
      }
    }
    acc = next;
    if (acc.length > 60) break;
  }
  if (bools.length) {
    // 再把 bool 逐个翻一遍（不全组合，避免爆炸）
    const extras = [];
    for (const base of acc) {
      for (const b of bools) extras.push(Object.assign({}, base, { [b.k]: true }));
    }
    acc = acc.concat(extras).slice(0, 120);
  }
  variants.push(...acc);

  for (const variant of variants) {
    const values = Object.assign(A.defaults(r), variant);
    for (const f of r.fields || []) {
      if (f.type === 'path') values[f.k] = COMBO_PATHS;
      if (f.type === 'dir') values[f.k] = COMBO_DIR;
    }
    // 顺带把 showIf 谓词全部调用一遍，谓词抛错也要被发现
    for (const f of r.fields || []) {
      if (typeof f.showIf === 'function') {
        try { f.showIf(values); } catch (e) { comboErrs++; console.error(`  ✗ showIf 抛错 ${r.id}.${f.k}: ${e.message}`); }
      }
    }
    if (typeof r.outExt === 'function') {
      try { r.outExt(values, { platform: 'win32' }); } catch (e) { comboErrs++; console.error(`  ✗ outExt 抛错 ${r.id}: ${e.message}`); }
    }
    combos++;
    try {
      buildOnce(r, values, r.minInputs >= 2 ? INPUTS : [INPUTS[0]]);
    } catch (e) {
      comboErrs++;
      console.error(`  ✗ ${r.id}  取值 ${JSON.stringify(variant)}`);
      console.error(`      ${e.message}`);
      if (comboErrs > 12) break;
    }
  }
  if (comboErrs > 12) { console.error('  （错误过多，提前结束组合遍历）'); break; }
}
console.log(`  共跑 ${combos} 种取值组合，异常 ${comboErrs} 处`);
problems += comboErrs;

/* ---------------- 画质档位覆盖 ---------------- */

console.log('');
console.log('─── 画质档位（全局 CRF/preset 覆盖） ───');
{
  const sample = A.getRecipe('trim-accurate') || A.RECIPES.find((r) => A.encodeKind(r) === 'encode');
  const base = A.defaults(sample);
  const build = (quality) => A.buildPlan({
    platform: 'win32', ffmpegBin: 'ffmpeg', inputFiles: INPUTS, outputDir: OUT,
    suffix: '_q', overwrite: true, hasAudio: true, quality,
    steps: [{ recipeId: sample.id, values: base }]
  }).jobs[0].argv;

  const g = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const off = build(null);
  const q16 = build({ mode: 'crf', crf: 16, preset: 'slow' });
  const q28 = build({ mode: 'crf', crf: 28, preset: 'veryfast' });
  const q265 = build({ mode: 'crf', crf: 18, preset: 'medium', vcodec: 'libx265' });

  const checks = [
    ['不覆盖时用操作自己的 CRF', g(off, '-crf') === '23', `得到 ${g(off, '-crf')}`],
    ['CRF16 档位生效', g(q16, '-crf') === '16', `得到 ${g(q16, '-crf')}`],
    ['preset 跟着档位走', g(q16, '-preset') === 'slow', `得到 ${g(q16, '-preset')}`],
    ['CRF28 档位生效', g(q28, '-crf') === '28', `得到 ${g(q28, '-crf')}`],
    ['跟随源编码器替换 -c:v', g(q265, '-c:v') === 'libx265', `得到 ${g(q265, '-c:v')}`]
  ];
  for (const [label, ok, detail] of checks) {
    if (ok) { console.log('  ✓ ' + label); }
    else { console.error(`  ✗ ${label}（${detail}）`); problems++; }
  }

  // 流复制类操作不该被画质档位改写
  const copyOp = A.RECIPES.find((r) => A.encodeKind(r) === 'copy');
  if (copyOp) {
    const before = A.buildPlan({ platform: 'win32', inputFiles: INPUTS, outputDir: OUT, suffix: '_c', overwrite: true, steps: [{ recipeId: copyOp.id, values: A.defaults(copyOp) }] }).jobs[0].argv.join(' ');
    const after = A.buildPlan({ platform: 'win32', inputFiles: INPUTS, outputDir: OUT, suffix: '_c', overwrite: true, quality: { mode: 'crf', crf: 16, preset: 'slow' }, steps: [{ recipeId: copyOp.id, values: A.defaults(copyOp) }] }).jobs[0].argv.join(' ');
    if (before === after) console.log('  ✓ 流复制操作不受画质档位影响（' + copyOp.name + '）');
    else { console.error('  ✗ 流复制操作被画质档位改写了: ' + copyOp.name); problems++; }
  }
}

/* ---------------- 多步流水线 + 脚本生成 ---------------- */

console.log('');
console.log('─── 多步流水线测试 ───');
const pipePlan = A.buildPlan({
  platform: 'win32',
  inputFiles: INPUTS,
  outputDir: OUT,
  suffix: '_out',
  overwrite: true,
  steps: [
    { recipeId: 'trim-accurate', values: Object.assign(A.defaults(A.getRecipe('trim-accurate')), { start: '00:00:05', dur: '00:00:20' }) },
    { recipeId: 'geometry-scale-width', values: A.getRecipe('geometry-scale-width') ? A.defaults(A.getRecipe('geometry-scale-width')) : {} }
  ].filter((s) => A.getRecipe(s.recipeId))
});
if (!pipePlan.ok) {
  console.error('  ✗ 流水线构建失败: ' + pipePlan.error); problems++;
} else {
  console.log(`  ✓ 共 ${pipePlan.jobs.length} 条命令，输出 ${pipePlan.files.length} 个文件`);
  pipePlan.jobs.forEach((j) => console.log(`      [步骤${j.stepIndex + 1}] ${path.basename(j.inputs[0])} -> ${path.basename(j.output)}`));
  const s = pipePlan.scripts;
  console.log(`  ✓ 脚本生成: .bat ${s.bat.length} 字 / .sh ${s.sh.length} 字 / .txt ${s.txt.length} 字`);
  if (!/ffmpeg/.test(s.bat)) { console.error('  ✗ .bat 脚本里没有 ffmpeg'); problems++; }
  if (/undefined/.test(s.bat + s.sh + s.txt)) { console.error('  ✗ 脚本里出现 undefined'); problems++; }
}

/* ---------------- 拼接（set 作用域） ---------------- */

console.log('');
console.log('─── 多文件拼接测试 ───');
const cj = A.getRecipe('concat-demuxer') || A.RECIPES.find((r) => r.scope === 'set');
if (cj) {
  const cp = A.buildPlan({
    platform: 'win32', inputFiles: INPUTS, outputDir: OUT, suffix: '_out', overwrite: true,
    steps: [{ recipeId: cj.id, values: A.defaults(cj) }]
  });
  if (!cp.ok) { console.error('  ✗ ' + cp.error); problems++; }
  else {
    console.log('  ✓ ' + cp.jobs[0].text);
    (cp.auxFiles || []).forEach((a) => {
      console.log('  ✓ 附属文件 ' + a.name + '：');
      String(a.content).split('\n').forEach((l) => l && console.log('      ' + l));
    });
  }
}

/* ---------------- 汇总 ---------------- */

console.log('');
console.log('════════════════════════════════════════');
console.log(`  结构问题: ${problems}    生成成功: ${okCount}    生成失败: ${failCount}    跳过: ${skipped}`);
console.log('════════════════════════════════════════');
console.log('');
process.exit(problems || failCount ? 1 : 0);
