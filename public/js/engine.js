/**
 * engine.js —— FFmpeg 命令生成引擎
 *
 * 设计要点：
 *   · 分类（CATS）与配方（RECIPES）由 recipes-*.js 通过全局注册表登记
 *   · 配方只描述“这一步做什么”，路径、引号、输入输出、批处理脚本由引擎统一拼装
 *   · 配方作用域：perFile（每个文件跑一遍）/ set（整个文件集跑一遍）
 *
 * 配方结构：
 * {
 *   id, cat, name, desc, tags:[],
 *   scope: 'perFile' | 'set',
 *   inputKind: 'video' | 'audio' | 'image' | 'any',
 *   minInputs: 1,
 *   outExt: 'mp4' | ((v, ctx) => 'mp4'),
 *   fields: [ {k,label,type,def,...,hint,showIf} ],
 *   build(v, ctx) -> { preArgs:[], inputs?, args:[], output?, aux?:[], notes?:[], warnings?:[] }
 * }
 *
 * 字段类型：text | number | time | select | bool | path | dir | textarea | password
 */
(function (global) {
  'use strict';

  const CATS = [];
  const RECIPES = [];
  const CAT_MAP = Object.create(null);

  /* ================================================================
   * 基础工具
   * ================================================================ */

  const U = {
    /** 目录部分 */
    dir(p) {
      p = String(p || '');
      const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      return i < 0 ? '' : p.slice(0, i);
    },
    /** 去掉目录的文件名 */
    base(p) {
      p = String(p || '');
      const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      return i < 0 ? p : p.slice(i + 1);
    },
    /** 扩展名（含点，小写） */
    ext(p) {
      const b = U.base(p);
      const i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i).toLowerCase();
    },
    /** 不含扩展名的文件名 */
    stem(p) {
      const b = U.base(p);
      const i = b.lastIndexOf('.');
      return i <= 0 ? b : b.slice(0, i);
    },
    join(dir, name, platform) {
      if (!dir) return name;
      const sep = platform === 'win32' ? '\\' : '/';
      let d = String(dir).replace(/[/\\]+$/, '');
      if (platform === 'win32') {
        // 折叠重复的反斜杠（D:\\out -> D:\out），但要保住开头的 UNC 前缀 \\server\share
        const isUnc = /^\\\\/.test(d);
        d = d.replace(/\\{2,}/g, '\\');
        if (isUnc) d = '\\' + d;
      }
      return d + sep + name;
    },
    /** 秒 -> HH:MM:SS 或 HH:MM:SS.mmm */
    hms(sec) {
      sec = Number(sec);
      if (!isFinite(sec) || sec < 0) sec = 0;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const whole = Math.floor(sec % 60);
      const ms = Math.round((sec - Math.floor(sec)) * 1000);
      const ss = String(whole).padStart(2, '0') + (ms ? '.' + String(ms).padStart(3, '0') : '');
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
    },
    /** HH:MM:SS(.ms) / 90 / 1:30 -> 秒 */
    toSec(t) {
      if (t == null || t === '') return null;
      if (typeof t === 'number') return t;
      const s = String(t).trim();
      if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
      const parts = s.split(':').map(Number);
      if (parts.some((n) => !isFinite(n))) return null;
      let sec = 0;
      for (const p of parts) sec = sec * 60 + p;
      return sec;
    },
    /** 人类可读时长 */
    humanDur(sec) {
      if (sec == null || !isFinite(sec)) return '';
      sec = Math.round(sec);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      if (h) return `${h}小时${m}分${s}秒`;
      if (m) return `${m}分${s}秒`;
      return `${s}秒`;
    },
    humanSize(bytes) {
      if (!bytes) return '';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0, n = Number(bytes);
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return n.toFixed(i ? 1 : 0) + ' ' + u[i];
    },
    /** 唯一化数组 */
    uniq(a) { return Array.from(new Set(a)); },
    /** 生成 safe 文件名片段 */
    slug(s) {
      return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    }
  };

  /* ================================================================
   * 引号与转义
   * ================================================================ */

  const Quote = {
    /** 用于命令行预览 / 直接粘贴执行 */
    forShell(s, platform) {
      s = String(s);
      if (s === '') return '""';
      if (platform === 'win32') {
        if (!/[\s"&|<>^()]/.test(s)) return s;
        return '"' + s.replace(/"/g, '\\"') + '"';
      }
      if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
      return "'" + s.replace(/'/g, `'\\''`) + "'";
    },
    /** 写进 .bat 文件（需转义 %） */
    forBat(s, platform) {
      const q = Quote.forShell(s, platform);
      return q.replace(/%/g, '%%');
    },
    /** 写进 .sh 文件 */
    forSh(s) {
      return Quote.forShell(s, 'linux');
    },
    /**
     * 滤镜参数里的路径转义：
     *  Windows 下 subtitles=C:\a\b.srt 会被当成选项分隔，必须写成 C\:/a/b.srt
     */
    filterPath(p, platform) {
      p = String(p);
      if (platform === 'win32') {
        return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      }
      return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    },
    /** drawtext 文本转义 */
    drawtext(s) {
      return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/%/g, '\\%')
        .replace(/,/g, '\\,')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/;/g, '\\;')
        .replace(/\n/g, '\\n');
    }
  };

  /* ================================================================
   * 注册表
   * ================================================================ */

  function addCategory(c) {
    if (CAT_MAP[c.id]) return;
    CAT_MAP[c.id] = c;
    CATS.push(c);
  }
  function addRecipe(r) {
    if (!r || !r.id) return;
    if (RECIPES.some((x) => x.id === r.id)) return;
    r.fields = r.fields || [];
    r.scope = r.scope || 'perFile';
    r.minInputs = r.minInputs || (r.scope === 'set' ? 2 : 1);
    r.inputKind = r.inputKind || 'video';
    r.tags = r.tags || [];

    // 开发者防护：字段 k 重复会让 defaults() 后者覆盖前者，导致选择器静默失效
    const seen = Object.create(null);
    r.fields.forEach((f) => {
      if (seen[f.k]) {
        console.warn(`[FFGEN] 配方 "${r.id}" 的字段 k 重复: "${f.k}"，后一个会覆盖前一个的默认值。`);
      }
      seen[f.k] = true;
    });

    RECIPES.push(r);
  }
  const getRecipe = (id) => RECIPES.find((r) => r.id === id) || null;
  const getCat = (id) => CAT_MAP[id] || null;

  /** 取字段默认值对象 */
  function defaults(recipe) {
    const v = {};
    if (!recipe) return v;
    (recipe.fields || []).forEach((f) => {
      if (f.def !== undefined) v[f.k] = f.def;
      else if (f.type === 'bool') v[f.k] = false;
      else if (f.type === 'number') v[f.k] = 0;
      else v[f.k] = '';
    });
    return v;
  }

  /* ================================================================
   * 单条命令拼装
   * ================================================================ */

  /**
   * 把配方 build() 的结果拼成一条 ffmpeg 命令
   * @returns {{argv:string[], text:string, inputs:string[], output:string}}
   */
  function assemble(recipe, values, ctx) {
    const bin = ctx.ffmpegBin || 'ffmpeg';
    const built = recipe.build(values, ctx) || {};

    // 输入：可以是字符串数组，也可以是 {path, args} 数组
    let inputs = built.inputs || ctx.inputs;
    if (!Array.isArray(inputs)) inputs = [inputs];

    const preArgs = (built.preArgs || []).map(String);
    const args = (built.args || []).map(String);
    // output 为空字符串 '' 是配方约定的「不写输出文件」（如 volumedetect 只做分析），
    // 不能用 || 兜底，否则会被替换成默认输出路径而在命令末尾多出一个参数。
    const output = (built.output === undefined || built.output === null) ? ctx.output : built.output;

    const argv = [];
    // 配方可以自带 -y / -n（例如「覆盖 / 不覆盖」操作），此时引擎不要再插一个 -y，
    // 否则会同时出现 -y 和 -n，ffmpeg 直接报 "both -y and -n supplied"
    if (ctx.overwrite !== false && built.noAutoOverwrite !== true) argv.push('-y');
    if (ctx.hideBanner) argv.push('-hide_banner');
    preArgs.forEach((a) => argv.push(a));
    inputs.forEach((inp) => {
      if (inp && typeof inp === 'object') {
        (inp.args || []).forEach((a) => argv.push(String(a)));
        argv.push('-i', String(inp.path));
      } else {
        argv.push('-i', String(inp));
      }
    });
    args.forEach((a) => argv.push(a));
    if (output) argv.push(output);

    // 全局画质档位：在参数拼装完成后统一改写编码参数，
    // 这样 145 个操作不用各自改一遍编码器逻辑。
    const finalArgv = ctx.quality ? applyQuality(argv, ctx.quality) : argv;
    const text = bin + ' ' + finalArgv.map((a) => Quote.forShell(a, ctx.platform)).join(' ');

    return {
      argv: finalArgv,
      text,
      inputs: inputs.map((i) => (typeof i === 'object' ? i.path : i)),
      output: output || '',
      notes: built.notes || [],
      warnings: built.warnings || [],
      aux: built.aux || [],
      // 有些操作需要先跑一条「准备命令」（两遍编码的第一遍、防抖的检测遍、响度分析遍…），
      // 配方通过 before 返回，由 buildPlan 插到主命令前面
      before: built.before || []
    };
  }

  /* ================================================================
   * 画质档位（全局覆盖各操作里的编码参数）
   *
   * 作用：用户不想被写死的 CRF 23 决定成品质量，所以这里在「参数拼装完成后」
   * 统一改写编码参数。只改已经存在的取值，不凭空造参数，避免把命令改坏。
   * ================================================================ */

  const CRF_FLAGS = ['-crf', '-cq', '-qp', '-qp_i', '-qp_p', '-global_quality'];
  const BITRATE_FLAGS = ['-b:v', '-maxrate', '-bufsize'];

  /**
   * @param {string[]} argv
   * @param {{mode:string, crf:number, preset:string, vcodec?:string}} q
   * @returns {string[]}
   */
  function applyQuality(argv, q) {
    if (!q || q.mode === 'off') return argv;
    const out = argv.slice();
    const crf = String(q.crf);
    let sawCrf = false;
    let videoEncIndex = -1;

    for (let i = 0; i < out.length - 1; i++) {
      const f = out[i];
      if (CRF_FLAGS.indexOf(f) >= 0) { out[i + 1] = crf; sawCrf = true; continue; }
      if (f === '-preset') { out[i + 1] = q.preset; continue; }
      if (f === '-c:v') { videoEncIndex = i; }
    }

    // 跟随源编码器：只在原本就是重编码、且明确指定了目标编码器时替换
    if (q.vcodec && videoEncIndex >= 0 && out[videoEncIndex + 1] !== 'copy') {
      out[videoEncIndex + 1] = q.vcodec;
    }

    // 跟随源位深：10bit 源 + libx265 时不要把画面压回 8bit
    if (q.pixFmt) {
      const pi = out.indexOf('-pix_fmt');
      if (pi >= 0 && out[pi + 1] !== 'copy') out[pi + 1] = q.pixFmt;
      else if (pi < 0 && videoEncIndex >= 0 && /^libx26[45]$/.test(out[videoEncIndex + 1])) {
        out.splice(videoEncIndex + 2, 0, '-pix_fmt', q.pixFmt);
      }
    }

    // 原本用「码率模式」的操作：去掉码率限制，补上 CRF，否则画质档位静默失效
    if (!sawCrf && videoEncIndex >= 0 && out[videoEncIndex + 1] !== 'copy') {
      const enc = out[videoEncIndex + 1];
      // 只有当编码器支持 CRF 类参数时才补，硬件编码器的参数名不同，交给它自己的默认
      if (/^libx26[45]$/.test(enc)) {
        for (let i = out.length - 1; i >= 0; i--) {
          if (BITRATE_FLAGS.indexOf(out[i]) >= 0) {
            out.splice(i, (out[i] === '-b:v' && out[i + 1] === '0') ? 0 : 2);
          }
        }
        out.splice(videoEncIndex + 2, 0, '-crf', crf);
      }
    }
    return out;
  }

  /**
   * 判断某个操作默认情况下会不会重新编码 —— 用于界面上的「流复制 / 需重编码」徽标。
   *
   * 注意：必须把 path / dir 字段填上占位路径再 build，
   * 否则很多操作会走「没填文件就退化成 -c copy」的分支，被误判成流复制。
   */
  const kindCache = Object.create(null);
  function encodeKind(recipe) {
    if (!recipe) return 'unknown';
    if (kindCache[recipe.id]) return kindCache[recipe.id];

    let kind = 'encode';
    try {
      const vals = defaults(recipe);
      (recipe.fields || []).forEach((f) => {
        if (f.type === 'path') vals[f.k] = 'C:\\__probe__\\extra.mp4';
        if (f.type === 'dir') vals[f.k] = 'C:\\__probe__';
      });
      const ctx = {
        platform: 'win32', outputDir: 'C:\\__probe__', ffmpegBin: 'ffmpeg',
        overwrite: true, hasAudio: true,
        inputs: ['C:\\__probe__\\in.mp4'], input: 'C:\\__probe__\\in.mp4',
        output: 'C:\\__probe__\\out.mp4', stepIndex: 0, stepCount: 1, suffix: '_out',
        U, Quote
      };
      const built = recipe.build(vals, ctx) || {};
      const args = (built.preArgs || []).concat(built.args || []).map(String);
      const joined = args.join(' ');

      // 只看信息、不写文件的操作单独归类
      const outArg = args.length ? args[args.length - 1] : '';
      if (built.output === '' || built.output === '-' || outArg === '-' || outArg === 'NUL' || outArg === 'nul') {
        kind = 'analysis'; kindCache[recipe.id] = kind; return kind;
      }

      // 导出图片 / GIF 的操作也不是「流复制」
      let ext = '';
      try { ext = typeof recipe.outExt === 'function' ? recipe.outExt(vals, { platform: 'win32' }) : (recipe.outExt || ''); } catch (_) { ext = ''; }
      if (/^(jpg|jpeg|png|webp|bmp|tif|tiff|gif|avif)$/i.test(String(ext))) {
        kind = 'image'; kindCache[recipe.id] = kind; return kind;
      }

      const vidFilter = args.indexOf('-vf') >= 0 ||
        (args.indexOf('-filter_complex') >= 0 && /\[\d*:?v[^\]]*\]|\[0:v\]|\[1:v\]/.test(joined));
      const audFilter = args.indexOf('-af') >= 0;
      const an = args.indexOf('-an') >= 0;
      const vn = args.indexOf('-vn') >= 0;
      const si = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
      const vcodec = si('-c:v');
      const acodec = si('-c:a');
      const scodec = si('-c:s');
      const allCopy = args.indexOf('-c') >= 0 && args[args.indexOf('-c') + 1] === 'copy';

      const videoCopied = allCopy || vn || vcodec === 'copy' || (vcodec == null && !vidFilter);
      const audioCopied = allCopy || an || acodec === 'copy' || (acodec == null && !audFilter);
      const subsCopied = scodec == null || scodec === 'copy';
      kind = (videoCopied && audioCopied && subsCopied) ? 'copy' : 'encode';
    } catch (_) {
      kind = 'encode';
    }

    kindCache[recipe.id] = kind;
    return kind;
  }

  /* ================================================================
   * 计划构建：把「输入 + 输出 + 一串操作」变成完整方案
   * ================================================================ */

  /**
   * 「准备命令」——配方在 build() 里通过 before 数组声明。
   * 典型用途：两遍编码的第一遍、vidstab 的检测遍、cropdetect 的探测遍。
   * spec 支持 assemble 认识的任意字段：preArgs / inputs / args / output / notes / warnings。
   */
  function makePrepJob(spec, ctx, stepIndex, recipeName) {
    const fakeRecipe = { name: spec.name || ((recipeName || '') + ' · 第一遍（分析）'), fields: [], build: () => spec };
    const prepCtx = Object.assign({}, ctx, {
      output: spec.output === undefined ? '' : spec.output,
      inputs: spec.inputs || ctx.inputs,
      // 准备命令（如两遍编码的第一遍）有自己的参数体系，不能被画质档位改写
      quality: spec.quality || null
    });
    const job = assemble(fakeRecipe, {}, prepCtx);
    job.recipe = { id: 'prep', name: fakeRecipe.name, scope: 'perFile', isPrep: true };
    job.stepIndex = stepIndex;
    job.inputFiles = prepCtx.inputs;
    job.isPrep = true;
    job.notes = spec.notes || [];
    job.warnings = spec.warnings || [];
    job.before = [];
    return job;
  }

  /**
   * @param {object} state
   *   platform, ffmpegBin, inputMode, inputPath, inputFiles:[], outputDir,
   *   suffix, steps:[{recipeId, values}], overwrite, hideBanner
   */
  function buildPlan(state) {
    const platform = state.platform || 'win32';
    const outputDir = state.outputDir || '';
    const userSuffix = state.suffix == null || state.suffix === '' ? '_out' : state.suffix;
    const steps = (state.steps || []).filter((s) => getRecipe(s.recipeId));

    const warnings = [];
    const notes = [];
    const auxFiles = [];
    const allJobs = [];
    const outputFiles = [];

    let items = (state.inputFiles || []).slice();
    if (!items.length && state.inputPath) {
      items = [state.inputPath];
    }
    if (!items.length) {
      return { ok: false, error: '请先指定输入（视频文件或包含视频的文件夹）', jobs: [], warnings: [] };
    }
    if (!outputDir) {
      return { ok: false, error: '请先指定输出文件夹', jobs: [], warnings: [] };
    }
    if (!steps.length) {
      return { ok: false, error: '请至少选择一个操作', jobs: [], warnings: [] };
    }

    // 校验输入数量
    for (const s of steps) {
      const r = getRecipe(s.recipeId);
      if (r.scope === 'set' && items.length < (r.minInputs || 2)) {
        return {
          ok: false,
          error: `操作「${r.name}」至少需要 ${r.minInputs} 个输入文件，当前只有 ${items.length} 个`,
          jobs: [], warnings: []
        };
      }
    }

    const multi = steps.length > 1;
    let current = items.map((p) => ({ path: p, base: U.stem(p) }));
    const stepAuxAccum = [];

    const KIND = {
      '.mp4': 'video', '.mkv': 'video', '.mov': 'video', '.avi': 'video', '.flv': 'video',
      '.wmv': 'video', '.webm': 'video', '.m4v': 'video', '.mpg': 'video', '.mpeg': 'video',
      '.ts': 'video', '.m2ts': 'video', '.vob': 'video', '.3gp': 'video', '.ogv': 'video',
      '.mp3': 'audio', '.aac': 'audio', '.wav': 'audio', '.flac': 'audio', '.ogg': 'audio',
      '.m4a': 'audio', '.wma': 'audio', '.opus': 'audio',
      '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.bmp': 'image', '.webp': 'image',
      '.tif': 'image', '.tiff': 'image', '.gif': 'image',
      '.srt': 'subtitle', '.ass': 'subtitle', '.ssa': 'subtitle', '.vtt': 'subtitle'
    };
    const kindOfFile = (p) => KIND[U.ext(p)] || 'other';

    steps.forEach((stepDef, si) => {
      const recipe = getRecipe(stepDef.recipeId);
      const values = Object.assign(defaults(recipe), stepDef.values || {});
      const tag = multi ? `_step${si + 1}` : userSuffix;
      const ext = typeof recipe.outExt === 'function' ? recipe.outExt(values, { platform }) : (recipe.outExt || 'mp4');

      if (recipe.scope === 'perFile') {
        const next = [];
        current.forEach((item) => {
          // 输出名始终基于「原始文件名」，这样多步之后是 a_step1.mp4 / a_step2.mp4，而不是层层堆叠
          const outName = item.base + tag + '.' + ext;
          const outPath = U.join(outputDir, outName, platform);
          const ctx = {
            platform, outputDir, ffmpegBin: state.ffmpegBin || 'ffmpeg',
            overwrite: state.overwrite, hideBanner: state.hideBanner,
            inputs: [item.path], input: item.path, inputsAll: current.map((x) => x.path),
            inputKind: kindOfFile(item.path),
            hasAudio: state.hasAudio,
            quality: state.quality,
            output: outPath, stepIndex: si, stepCount: steps.length,
            suffix: tag, U, Quote
          };
          const job = assemble(recipe, values, ctx);
          job.recipe = recipe;
          job.stepIndex = si;
          job.inputFiles = [item.path];
          (job.before || []).forEach((spec) => allJobs.push(makePrepJob(spec, ctx, si, recipe.name)));
          allJobs.push(job);
          (job.aux || []).forEach((a) => { stepAuxAccum.push(a); auxFiles.push(a); });
          next.push({ path: outPath, base: item.base });
          outputFiles.push(outPath);
        });
        current = next;
      } else {
        const anchor = current[0];
        const outName = anchor.base + tag + '.' + ext;
        const outPath = U.join(outputDir, outName, platform);
        const ctx = {
          platform, outputDir, ffmpegBin: state.ffmpegBin || 'ffmpeg',
          overwrite: state.overwrite, hideBanner: state.hideBanner,
          inputs: current.map((x) => x.path), input: anchor.path, inputsAll: current.map((x) => x.path),
          inputKind: kindOfFile(anchor.path),
          hasAudio: state.hasAudio,
          quality: state.quality,
          output: outPath, stepIndex: si, stepCount: steps.length,
          suffix: tag, U, Quote
        };
        const job = assemble(recipe, values, ctx);
        job.recipe = recipe;
        job.stepIndex = si;
        job.inputFiles = current.map((x) => x.path);
        (job.before || []).forEach((spec) => allJobs.push(makePrepJob(spec, ctx, si, recipe.name)));
        allJobs.push(job);
        (job.aux || []).forEach((a) => { auxFiles.push(a); });
        outputFiles.push(outPath);
        current = [{ path: outPath, base: anchor.base }];
      }
    });

    // 依赖顺序检查：set 作用域必须排在第一位，否则前面的产物会被吞掉
    const setIdx = steps.findIndex((s) => getRecipe(s.recipeId).scope === 'set');
    if (setIdx > 0) {
      warnings.push('「' + getRecipe(steps[setIdx].recipeId).name + '」会合并全部输入，建议把它放在流水线第一位。');
    }
    if (steps.length > 1 && state.inputMode === 'folder') {
      const perFileSteps = steps.filter((s) => getRecipe(s.recipeId).scope === 'perFile').length;
      if (perFileSteps === steps.length) {
        warnings.push(`已按「每个文件依次执行 ${steps.length} 步操作」的方式展开，共 ${allJobs.length} 条命令。`);
      }
    }
    if (!(state.ffmpegAvailable !== false)) { /* 占位，UI 层补充提示 */ }

    // 输入类型匹配检查：把字幕操作用在视频上、把图片序列用在视频上时提前提醒
    const KIND_LABEL = { video: '视频', audio: '音频', image: '图片', subtitle: '字幕', other: '其他' };
    allJobs.forEach((job) => {
      const want = job.recipe.inputKind;
      if (!want || want === 'any') return;
      const got = kindOfFile(job.inputs[0]);
      if (got === 'other' || got === want) return;
      job.warnings = (job.warnings || []).concat([
        `「${job.recipe.name}」通常用于${KIND_LABEL[want] || want}文件，当前输入是${KIND_LABEL[got] || got}文件，命令很可能报错。请确认输入是否选对了。`
      ]);
    });

    // 音轨检查：已知输入没有音轨，但命令仍然要音频流，ffmpeg 会报
    //   Stream specifier ':a' ... matches no streams
    //   或 Filtergraph 'volume' was specified through the -af option, which requires an input audio stream
    // 这里给出明确提示（自带音源的操作，如 anullsrc 造静音轨，不算）。
    if (state.hasAudio === false) {
      allJobs.forEach((job) => {
        const joined = job.argv.join(' ');
        if (/anullsrc|lavfi/.test(joined)) return; // 自己造了音源
        const needsAudio =
          /\[0:a\]/.test(joined) ||
          /-map\s+0:a/.test(joined) ||
          job.argv.indexOf('-af') >= 0;
        if (needsAudio) {
          job.warnings = (job.warnings || []).concat([
            '检测到输入没有音轨，但这条命令需要音频流，执行时会报 “Stream specifier \':a\' … matches no streams” 或 “-af … requires an input audio stream”。请改用不需要音频的选项，或换有声音的素材。'
          ]);
        }
      });
    }

    const scripts = buildScripts(allJobs, auxFiles, {
      platform, outputDir, state, steps, recipeOf: (id) => getRecipe(id)
    });

    return {
      ok: true,
      jobs: allJobs,
      files: outputFiles,
      auxFiles,
      warnings,
      notes,
      outputDir,
      inputCount: items.length,
      stepCount: steps.length,
      scripts
    };
  }

  /* ================================================================
   * 脚本生成
   * ================================================================ */

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /**
   * cmd 的 echo / rem 文本转义。
   * 关键：未经转义的 > < & | ^ ( ) 会被 cmd 当成语法（例如 "-> " 里的 > 会变成重定向，
   * 生成一个垃圾文件），所以必须逐个加 ^ 前缀。
   */
  function batEcho(s) {
    return String(s)
      .replace(/\^/g, '^^')
      .replace(/%/g, '%%')
      .replace(/[&|<>()]/g, (m) => '^' + m);
  }

  /** 脚本里每条命令的一行说明（准备步骤没有输出文件） */
  function jobLabel(j) {
    const from = U.base(j.inputs[0]);
    return j.output ? (from + ' -> ' + U.base(j.output)) : (from + ' -> （准备步骤，不写文件）');
  }

  function buildScripts(jobs, auxFiles, meta) {
    const platform = meta.platform;
    const outDir = meta.outputDir;
    const lines = { bat: [], sh: [], txt: [] };
    const header = [
      'FFmpeg 命令生成器 —— 自动生成',
      '生成时间: ' + timestamp(),
      '输入数量: ' + (meta.state.inputFiles || []).length + ' 个文件',
      '操作步骤: ' + meta.steps.length + ' 步',
      '输出目录: ' + outDir,
      '共 ' + jobs.length + ' 条命令'
    ];

    /* --- Windows .bat --- */
    // ⚠️ 这里有几个不能动的约束，改之前请先看 tools/test-launcher.ps1：
    //
    //  1. 整个文件是 UTF-8（无 BOM），但 cmd.exe 是按「当前控制台代码页」解码批处理
    //     文件的。中文 Windows 默认是 936，直接读 UTF-8 会变乱码，含中文的行还会因为
    //     多字节边界错位而被切断（典型报错：「'xxx' 不是内部或外部命令」）。
    //  2. 所以先用 chcp 65001 切代码页 —— 但不能在文件的「中途」切：cmd 有预读缓冲，
    //     切换代码页会让缓冲区里已解码的内容和后续字节偏移错位，后面整片行都会崩。
    //  3. 可靠做法：把「切代码页 + 用新代码页重新执行本文件」放在最开头，并且**这段
    //     头部必须是纯 ASCII**（一个中文都不能有）。子进程从第 0 字节开始就用 65001
    //     解码，整份文件自始至终编码一致。
    //  4. 头部之后保留两行 ASCII（setlocal / set）再出现中文，实测这样最稳。
    lines.bat.push('@echo off');
    lines.bat.push('if not "%~1"=="__utf8__" (');
    lines.bat.push('  chcp 65001 >nul');
    lines.bat.push('  "%~f0" __utf8__');
    lines.bat.push('  exit /b %errorlevel%');
    lines.bat.push(')');
    lines.bat.push('setlocal enabledelayedexpansion');
    lines.bat.push('set /a FAILED=0 >nul');
    // ↓↓↓ 从这一行起才允许出现非 ASCII 内容 ↓↓↓
    header.forEach((h) => lines.bat.push('rem ' + batEcho(h)));
    lines.bat.push('');
    lines.bat.push('echo 正在准备输出目录...');
    lines.bat.push('if not exist ' + Quote.forBat(outDir, 'win32') + ' mkdir ' + Quote.forBat(outDir, 'win32'));
    lines.bat.push('');

    auxFiles.forEach((a) => {
      lines.bat.push('rem --- 附属文件: ' + batEcho(a.name) + ' ---');
      lines.bat.push('rem 内容请用网页上的「保存附属文件」按钮生成');
      lines.bat.push('');
    });

    let lastStep = -1;
    jobs.forEach((j, i) => {
      if (j.stepIndex !== lastStep) {
        lines.bat.push('');
        lines.bat.push('rem ========== 步骤 ' + (j.stepIndex + 1) + ': ' + batEcho(j.recipe.name) + ' ==========');
        lastStep = j.stepIndex;
      }
      lines.bat.push('echo ' + batEcho('[' + (i + 1) + '/' + jobs.length + '] ' + jobLabel(j)));
      lines.bat.push((meta.state.ffmpegBin || 'ffmpeg') + ' ' + j.argv.map((a) => Quote.forBat(a, 'win32')).join(' '));
      lines.bat.push('if errorlevel 1 (echo   [失败] 上一条命令返回错误 & set /a FAILED+=1)');
      lines.bat.push('');
    });
    lines.bat.push('');
    lines.bat.push('echo.');
    lines.bat.push('if not "!FAILED!"=="0" echo ' + batEcho('注意：有 ') + '!FAILED!' + batEcho(' 条命令执行失败，请向上翻查看报错。'));
    lines.bat.push('if "!FAILED!"=="0" echo ' + batEcho('全部命令执行成功！'));
    lines.bat.push('echo ' + batEcho('输出目录: ' + outDir));
    lines.bat.push('pause');

    /* --- POSIX .sh --- */
    lines.sh.push('#!/usr/bin/env bash');
    lines.sh.push('# ' + header.join('\n# '));
    lines.sh.push('set -u');
    lines.sh.push('');
    lines.sh.push('OUTDIR=' + Quote.forSh(outDir));
    lines.sh.push('mkdir -p "$OUTDIR"');
    lines.sh.push('FAILED=0');
    lines.sh.push('');
    lastStep = -1;
    jobs.forEach((j, i) => {
      if (j.stepIndex !== lastStep) {
        lines.sh.push('');
        lines.sh.push('# ========== 步骤 ' + (j.stepIndex + 1) + ': ' + j.recipe.name + ' ==========');
        lastStep = j.stepIndex;
      }
      lines.sh.push('echo "' + ('[' + (i + 1) + '/' + jobs.length + '] ' + jobLabel(j)).replace(/"/g, '\\"') + '"');
      lines.sh.push((meta.state.ffmpegBin || 'ffmpeg') + ' ' + j.argv.map((a) => Quote.forSh(a)).join(' ') + ' || { echo "  [失败] 上一条命令返回错误"; FAILED=$((FAILED+1)); }');
      lines.sh.push('');
    });
    lines.sh.push('echo');
    lines.sh.push('echo "全部完成！输出目录: $OUTDIR  失败 $FAILED 条"');

    /* --- 纯文本命令清单 --- */
    lines.txt.push(header.join('\n'));
    lines.txt.push('');
    lines.txt.push('='.repeat(60));
    lines.txt.push('');
    lastStep = -1;
    jobs.forEach((j, i) => {
      if (j.stepIndex !== lastStep) {
        lines.txt.push('## 步骤 ' + (j.stepIndex + 1) + '：' + j.recipe.name);
        lines.txt.push('');
        lastStep = j.stepIndex;
      }
      lines.txt.push(`# [${i + 1}/${jobs.length}] ${jobLabel(j)}`);
      if (j.notes && j.notes.length) j.notes.forEach((n) => lines.txt.push('#   说明: ' + n));
      lines.txt.push(j.text);
      lines.txt.push('');
    });

    return {
      bat: lines.bat.join('\r\n'),
      sh: lines.sh.join('\n'),
      txt: lines.txt.join('\n')
    };
  }

  /* ================================================================
   * 常用参数片段（供配方复用）
   * ================================================================ */

  const Helpers = {
    /** 编码器参数：质量模式 -> 参数数组 */
    videoQuality(mode, value, encoder) {
      const enc = encoder || 'libx264';
      const isHw = /nvenc|qsv|amf|videotoolbox|vaapi/.test(enc);
      if (mode === 'crf') {
        if (/nvenc/.test(enc)) return ['-rc', 'vbr', '-cq', String(value), '-b:v', '0'];
        if (/qsv/.test(enc)) return ['-global_quality', String(value)];
        if (/videotoolbox/.test(enc)) return ['-q:v', String(Math.max(1, Math.min(100, Math.round((51 - Number(value)) * 100 / 51))))];
        if (/amf/.test(enc)) return ['-rc', 'cqp', '-qp_i', String(value), '-qp_p', String(value)];
        if (/vaapi/.test(enc)) return ['-qp', String(value)];
        return ['-crf', String(value)];
      }
      if (mode === 'bitrate') {
        return ['-b:v', String(value)];
      }
      if (mode === 'cq') {
        return ['-qp', String(value)];
      }
      return isHw ? [] : ['-crf', '23'];
    },
    /** 音频编码参数 */
    audioArgs(codec, bitrate, channels, sampleRate) {
      const a = [];
      if (!codec || codec === 'copy') return ['-c:a', 'copy'];
      if (codec === 'none') return ['-an'];
      a.push('-c:a', codec);
      if (bitrate && codec !== 'pcm_s16le' && codec !== 'flac') a.push('-b:a', String(bitrate));
      if (channels) a.push('-ac', String(channels));
      if (sampleRate) a.push('-ar', String(sampleRate));
      return a;
    },
    /** 像素格式 */
    pixFmt(v) { return v ? ['-pix_fmt', v] : []; },
    /** 预设 */
    preset(v, encoder) {
      if (!v) return [];
      if (/nvenc/.test(encoder || '')) return ['-preset', v === 'veryslow' || v === 'slower' || v === 'slow' ? 'p6' : v === 'medium' ? 'p4' : 'p1'];
      if (/qsv/.test(encoder || '')) return ['-preset', v === 'ultrafast' ? 'veryfast' : v];
      return ['-preset', v];
    },
    /** 自定义参数文本 -> 数组（支持引号） */
    parseExtra(text) {
      if (!text || !String(text).trim()) return [];
      const s = String(text);
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
      return out;
    },
    /** 时间参数：优先 HH:MM:SS（仅用于 -ss / -t 这类命令行参数） */
    timeArg(t) {
      if (t == null || t === '') return null;
      const sec = U.toSec(t);
      if (sec == null) return String(t);
      return U.hms(sec);
    },
    /**
     * 秒 -> 可以安全放进滤镜参数里的数字。
     * ⚠️ 滤镜参数里绝对不能用 HH:MM:SS：冒号是滤镜选项的分隔符，
     *    trim=start=00:00:10:end=00:00:20 会被解析成 start=0，静默产出错误结果。
     *    滤镜里一律用秒数：trim=start=10:end=20。
     */
    secs(x) {
      const n = Number(x);
      if (!isFinite(n)) return '0';
      return String(Math.round(n * 1000) / 1000);
    },
    /** 把 -vf / -af 合并 */
    vf(list) {
      const flat = flattenFilter(list);
      return flat.length ? ['-vf', flat.join(',')] : [];
    },
    af(list) {
      const flat = flattenFilter(list);
      return flat.length ? ['-af', flat.join(',')] : [];
    },
    /** 构建 -filter_complex */
    fc(chains, maps) {
      const out = [];
      if (chains && chains.length) out.push('-filter_complex', chains.join(';'));
      (maps || []).forEach((m) => out.push('-map', m));
      return out;
    },
    /** 视频编码通用块 */
    venc(v, prefix) {
      const p = prefix || '';
      const enc = v[p + 'vcodec'] || 'libx264';
      if (enc === 'copy' || enc === 'none') return enc === 'none' ? ['-vn'] : ['-c:v', 'copy'];
      const args = ['-c:v', enc];
      return args;
    }
  };

  function flattenFilter(list) {
    const out = [];
    (list || []).forEach((x) => {
      if (!x) return;
      if (Array.isArray(x)) out.push(...flattenFilter(x));
      else if (String(x).trim()) out.push(String(x).trim());
    });
    return out;
  }

  /* ================================================================
   * 导出
   * ================================================================ */

  const API = {
    CATS, RECIPES, CAT_MAP,
    addCategory, addRecipe, getRecipe, getCat, defaults,
    buildPlan, assemble, buildScripts, applyQuality, encodeKind,
    Quote, U, Helpers, flattenFilter,
    version: '1.0.0'
  };

  global.FFGEN = API;
  global.FFCATS = CATS;
  global.FFRECIPES = RECIPES;
  global.FFHELP = Helpers;
  global.FFU = U;
  global.FFQ = Quote;

  // 便捷注册函数（配方文件里用）
  global.defCat = addCategory;
  global.defOp = addRecipe;

})(typeof window !== 'undefined' ? window : globalThis);
