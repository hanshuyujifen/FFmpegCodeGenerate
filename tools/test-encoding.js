/**
 * 中文编码回归测试（纯逻辑，不依赖子进程，任何环境都能跑）
 * 用法：node tools/test-encoding.js
 *
 * 覆盖：
 *   1. 服务端 decodeOutput 对 UTF-8 / GBK 两种字节流都能解对
 *   2. 中文路径在 JSON 往返后不变
 *   3. 中文路径生成的 ffmpeg 命令、批处理脚本内容正确
 *   4. 中文路径写入文件后读回一致
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        得到: ${JSON.stringify(got)}`);
    console.log(`        期望: ${JSON.stringify(want)}`);
  }
}

/* ---- 与 server.js 完全一致的解码逻辑 ---- */
const SYS_ENCODING = process.platform === 'win32' ? 'gbk' : 'utf-8';
let sysDecoder = null;
try { sysDecoder = new TextDecoder(SYS_ENCODING); } catch (_) { sysDecoder = null; }
function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) {
    if (sysDecoder) { try { return sysDecoder.decode(buf); } catch (__) {} }
    return Buffer.from(buf).toString('utf8');
  }
}

const CN_DIR = 'G:\\测试用户\\20261016国庆游园';
const CN_FILE = '示例视频 最终版.mp4';
const CN_PATH = CN_DIR + '\\' + CN_FILE;

/* ---- 造出真实字节：UTF-8 与 GBK 各一份 ---- */
function toBytes(str, enc) {
  if (enc === 'utf8') return Buffer.from(str, 'utf8');
  // Node 没有 GBK 编码器，这里用 iconv 不可用时的替代：只在 Windows 上用 PowerShell 生成过一次，
  // 测试里改成手工构造 —— 用已知的 GBK 字节序列（见下方 GBK_HEX）避免依赖。
  throw new Error('unsupported');
}
// 预先生成好的 GBK 字节（CP936 编码，等价于 PowerShell 在 936 控制台下的输出）
// "G:\测试用户\20261016国庆游园"
const GBK_HEX = '473a5cb2e2cad4d3c3bba75c3230323631303136b9fac7ecd3ced4b0';
// 同一字符串的 UTF-8 字节
const UTF8_HEX = '473a5ce6b58be8af95e794a8e688b75c3230323631303136e59bbde5ba86e6b8b8e59bad';

console.log('\n[1] 服务端子进程输出解码（decodeOutput）');
{
  const utf8Bytes = Buffer.from(UTF8_HEX, 'hex');
  const gbkBytes = Buffer.from(GBK_HEX, 'hex');
  check('UTF-8 字节 -> 正确中文', decodeOutput(utf8Bytes), CN_DIR);
  check('GBK 字节   -> 正确中文（模拟 PowerShell 在 936 控制台下的输出）', decodeOutput(gbkBytes), CN_DIR);
  check('空输入 -> 空串', decodeOutput(Buffer.alloc(0)), '');
  check('纯 ASCII -> 原样', decodeOutput(Buffer.from('C:\\videos\\a.mp4', 'utf8')), 'C:\\videos\\a.mp4');
  check('GBK 字节用朴素 toString 确实会乱码（说明兜底有必要）',
        gbkBytes.toString('utf8') !== CN_DIR, true);
}

console.log('\n[2] JSON 往返（服务端 -> 浏览器）');
{
  const payload = JSON.stringify({
    ok: true, path: CN_DIR, parent: 'G:\\测试用户',
    dirs: [{ name: '20261016国庆游园', path: CN_DIR }],
    files: [{ name: CN_FILE, path: CN_PATH, kind: 'video' }]
  });
  const raw = Buffer.from(payload, 'utf8');          // 网络上的字节
  const back = JSON.parse(raw.toString('utf8'));      // 浏览器 JSON.parse 的效果
  check('目录路径', back.path, CN_DIR);
  check('子目录名', back.dirs[0].name, '20261016国庆游园');
  check('文件名', back.files[0].name, CN_FILE);
  check('文件路径', back.files[0].path, CN_PATH);
}

console.log('\n[3] 中文路径生成命令与批处理脚本');
{
  global.window = global;
  const PUB = path.join(__dirname, '..', 'public', 'js');
  for (const f of ['engine.js', 'recipes-edit.js', 'recipes-format.js', 'recipes-visual.js', 'recipes-audio.js']) {
    const p = path.join(PUB, f);
    if (fs.existsSync(p)) eval(fs.readFileSync(p, 'utf8')); // eslint-disable-line no-eval
  }
  const A = global.FFGEN;
  const plan = A.buildPlan({
    platform: 'win32',
    ffmpegBin: 'ffmpeg',
    inputFiles: [CN_PATH],
    outputDir: 'G:\\成品 输出',
    suffix: '_成片',
    overwrite: true,
    steps: [{ recipeId: 'trim-accurate', values: Object.assign(A.defaults(A.getRecipe('trim-accurate')), { start: '00:00:05', dur: '00:00:10' }) }]
  });
  check('方案构建成功', plan.ok, true);
  const job = plan.jobs[0];
  check('命令里保留中文输入路径', job.text.includes(CN_PATH), true);
  check('输出文件名保留中文', job.text.includes('示例视频 最终版_成片.mp4'), true);
  check('输出目录保留中文', job.text.includes('G:\\成品 输出'), true);

  const bat = plan.scripts.bat;
  check('.bat 含中文输入路径', bat.includes(CN_PATH), true);
  check('.bat 含中文提示', bat.includes('正在准备输出目录'), true);
  check('.bat 头部是纯 ASCII（不能被中文污染）', /^@echo off\r\nif not "%~1"=="/.test(bat), true);
  const firstNonAscii = bat.split('\r\n').findIndex((l) => /[^\x00-\x7F]/.test(l));
  check('第一条非 ASCII 行出现在重入块之后（第 9 行及以后）', firstNonAscii >= 8, true);
}

console.log('\n[4] 中文路径写文件再读回');
{
  const dir = path.join(__dirname, '..', 'test', 'enc');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '中文路径.txt');
  fs.writeFileSync(f, CN_PATH, 'utf8');
  check('读回内容一致', fs.readFileSync(f, 'utf8'), CN_PATH);
  check('中文文件名本身可用', fs.existsSync(f), true);
  fs.rmSync(f, { force: true });
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
