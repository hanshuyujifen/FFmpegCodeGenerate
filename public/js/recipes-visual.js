/**
 * recipes-visual.js —— 配方库：画面尺寸 / 水印叠加 / 画质滤镜 / 字幕处理
 * 依赖 engine.js 暴露的全局函数 defCat / defOp 与 FFHELP / FFQ / FFU
 *
 * 说明：本文件里的操作都会改变画面像素，因此必须重新编码（filter 与 -c:v copy 不能同时用）。
 *       需要第二个输入文件的操作（水印图、画中画、软字幕），统一用 type:'path' 字段收集路径，
 *       在 build() 里返回 inputs:[主输入, 附加输入]，并按 [1:v] / [1:0] 取流。
 */
(function () {
  'use strict';
  const H = FFHELP, Q = FFQ, U = FFU;

  /* ================================================================
   * 分类
   * ================================================================ */
  defCat({ id: 'geometry', name: '画面尺寸与变换', icon: '📐', color: '#0ea5e9', desc: '缩放、裁剪、旋转、翻转、加黑边、裁剪黑边' });
  defCat({ id: 'overlay', name: '水印与叠加', icon: '💧', color: '#a855f7', desc: '图片水印、文字水印、画中画、多画面拼接' });
  defCat({ id: 'filter', name: '画质滤镜', icon: '🎨', color: '#f43f5e', desc: '亮度对比度、锐化降噪、模糊、调色、去隔行' });
  defCat({ id: 'subtitle', name: '字幕处理', icon: '💬', color: '#22c55e', desc: '烧录硬字幕、封装软字幕、提取字幕、字幕格式转换' });

  /* ================================================================
   * 内部小工具
   * ================================================================ */

  /** 安全取数 */
  function num(x, d) {
    const n = Number(x);
    return isFinite(n) ? n : d;
  }
  /** 取整并限定最小值 */
  function int(x, d, min) {
    const n = Math.round(num(x, d));
    return Math.max(min == null ? 1 : min, n);
  }
  /** 路径字段没填时的兜底：退化成直接复制，绝不生成会报错的命令 */
  function warnCopy(msg) {
    return { args: ['-c', 'copy', '-map', '0'], warnings: [msg] };
  }
  /** 九宫格位置（overlay 的 W/H 是底图尺寸，w/h 是叠加层尺寸；drawtext 同名的常量含义一致） */
  function overlayXY(pos, mx, my) {
    const dx = Math.max(0, int(mx, 20, 0));
    const dy = Math.max(0, int(my, 20, 0));
    const L = String(dx), C = '(W-w)/2', R = `W-w-${dx}`;
    const T = String(dy), M = '(H-h)/2', B = `H-h-${dy}`;
    const map = {
      tl: [L, T], tc: [C, T], tr: [R, T],
      ml: [L, M], mc: [C, M], mr: [R, M],
      bl: [L, B], bc: [C, B], br: [R, B]
    };
    const hit = map[pos] || map.br;
    return { x: hit[0], y: hit[1] };
  }

  const POSITIONS = [
    { v: 'tl', label: '左上角' }, { v: 'tc', label: '上边居中' }, { v: 'tr', label: '右上角' },
    { v: 'ml', label: '左边居中' }, { v: 'mc', label: '正中央' }, { v: 'mr', label: '右边居中' },
    { v: 'bl', label: '左下角' }, { v: 'bc', label: '下边居中' }, { v: 'br', label: '右下角' }
  ];
  function posField(def, col) {
    return { k: 'pos', label: '摆放位置', type: 'select', def: def || 'br', options: POSITIONS, col: col || 4 };
  }
  function marginFields(col) {
    const c = col || 4;
    return [
      { k: 'mx', label: '左右边距（像素）', type: 'number', def: 24, min: 0, col: c },
      { k: 'my', label: '上下边距（像素）', type: 'number', def: 24, min: 0, col: c }
    ];
  }

  /* ---------- 编码参数（滤镜改了画面，必须重编码，所以不提供 copy） ---------- */

  const VCODECS = [
    { v: 'libx264', label: 'libx264（H.264 软件，通用）' },
    { v: 'libx265', label: 'libx265（H.265 软件，体积小）' },
    { v: 'h264_nvenc', label: 'h264_nvenc（NVIDIA 显卡加速）' },
    { v: 'hevc_nvenc', label: 'hevc_nvenc（NVIDIA H.265）' },
    { v: 'h264_qsv', label: 'h264_qsv（Intel 核显）' },
    { v: 'h264_amf', label: 'h264_amf（AMD 显卡）' },
    { v: 'h264_videotoolbox', label: 'h264_videotoolbox（Apple 芯片）' },
    { v: 'mpeg4', label: 'mpeg4（老设备兼容）' }
  ];
  const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

  function encFields(crfDefault) {
    const crf = crfDefault === undefined ? 23 : crfDefault;
    return [
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'libx264', options: VCODECS, col: 4 },
      { k: 'qmode', label: '质量控制', type: 'select', def: 'crf', col: 4, options: [
        { v: 'crf', label: 'CRF 恒定质量（推荐）' },
        { v: 'bitrate', label: '指定码率' }
      ] },
      { k: 'crf', label: 'CRF 值（18~28，越小越清晰）', type: 'number', def: crf, min: 0, max: 51, col: 4,
        showIf: (v) => v.qmode === 'crf' },
      { k: 'bitrate', label: '视频码率', type: 'text', def: '6M', col: 4, placeholder: '如 6M / 3000k',
        showIf: (v) => v.qmode === 'bitrate' },
      { k: 'preset', label: '编码预设', type: 'select', def: 'medium', col: 4,
        options: PRESETS.map((x) => ({ v: x, label: x })),
        hint: '越慢压缩率越高，画质相同但文件更小。' }
    ];
  }
  function encArgs(v) {
    const enc = v.vcodec || 'libx264';
    const a = ['-c:v', enc];
    if (v.qmode === 'bitrate') a.push(...H.videoQuality('bitrate', v.bitrate || '6M', enc));
    else a.push(...H.videoQuality('crf', num(v.crf, 23), enc));
    a.push(...H.preset(v.preset, enc));
    if (/libx26[45]/.test(enc)) a.push('-pix_fmt', 'yuv420p');
    return a;
  }
  function audFields() {
    return [
      { k: 'acodec', label: '音频处理', type: 'select', def: 'copy', col: 6, options: [
        { v: 'copy', label: 'copy（原样复制，最快，推荐）' },
        { v: 'aac', label: 'aac（重新编码）' },
        { v: 'none', label: '不要音频' }
      ] },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '192k', col: 6,
        options: ['128k', '160k', '192k', '256k', '320k'].map((x) => ({ v: x, label: x })),
        showIf: (v) => v.acodec === 'aac' }
    ];
  }
  function audArgs(v) {
    return H.audioArgs(v.acodec || 'copy', v.abitrate, null, null);
  }

  const EXTRA_FIELD = { k: 'extra', label: '附加参数（高级）', type: 'text', def: '', col: 12, placeholder: '如 -movflags +faststart -threads 4', hint: '空格分隔；含空格的参数请用双引号包起来。将追加在输出文件之前。' };

  /* ================================================================
   * 画面尺寸与变换
   * ================================================================ */

  defOp({
    id: 'geo-scale-width',
    cat: 'geometry',
    name: '按宽度等比缩放',
    desc: '给一个目标宽度，高度按比例自动算，最常用的改分辨率方式，画质损失最小。',
    tags: ['缩放', '分辨率', 'scale', '改大小'],
    outExt: 'mp4',
    fields: [
      { k: 'width', label: '目标宽度（像素）', type: 'number', def: 1280, min: 16, max: 16384, col: 3 },
      { k: 'flag', label: '缩放算法', type: 'select', def: 'lanczos', col: 3, options: [
        { v: 'lanczos', label: 'lanczos（最锐利，推荐）' },
        { v: 'bicubic', label: 'bicubic（均衡）' },
        { v: 'bilinear', label: 'bilinear（最快）' },
        { v: 'neighbor', label: 'neighbor（像素风，不模糊）' }
      ] },
      { k: 'noUp', label: '原画面更小时不放大', type: 'bool', def: false, col: 3,
        hint: '避免把小视频硬拉大导致模糊。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const w = int(v.width, 1280, 16);
      const target = v.noUp ? `'min(${w}\\,iw)'` : String(w);
      return {
        args: [...H.vf([`scale=${target}:-2:flags=${v.flag || 'lanczos'}`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['高度写 -2：ffmpeg 按比例算出高度并强制成偶数（H.264/H.265 要求偶数）。']
      };
    }
  });

  defOp({
    id: 'geo-scale-exact',
    cat: 'geometry',
    name: '缩放到指定分辨率',
    desc: '明确指定宽高，可选「保持比例加黑边 / 直接拉伸 / 裁满全屏」三种适配方式。',
    tags: ['分辨率', '1080p', '黑边', 'pad', '拉伸'],
    outExt: 'mp4',
    fields: [
      { k: 'width', label: '目标宽度', type: 'number', def: 1920, min: 16, col: 4 },
      { k: 'height', label: '目标高度', type: 'number', def: 1080, min: 16, col: 4 },
      { k: 'mode', label: '适配方式', type: 'select', def: 'pad', col: 4, options: [
        { v: 'pad', label: '保持比例 + 补黑边（不裁画面）' },
        { v: 'stretch', label: '直接拉伸（可能变形）' },
        { v: 'crop', label: '保持比例 + 裁满全屏（会裁掉边缘）' }
      ] },
      { k: 'color', label: '黑边颜色', type: 'select', def: 'black', col: 4, options: ['black', 'white', 'gray'],
        showIf: (v) => v.mode === 'pad' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const w = int(v.width, 1920, 16), h = int(v.height, 1080, 16);
      let f;
      if (v.mode === 'stretch') f = `scale=${w}:${h}:flags=lanczos,setsar=1`;
      else if (v.mode === 'crop') f = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`;
      else f = `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${v.color || 'black'},setsar=1`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['force_original_aspect_ratio 会先等比缩放到能放进目标框，再由 pad / crop 补齐。']
      };
    }
  });

  defOp({
    id: 'geo-fit-max',
    cat: 'geometry',
    name: '限制最大尺寸（只缩不放）',
    desc: '超过设定尺寸才缩小，本来就小的画面原样保留，适合统一处理一堆大小不一的素材。',
    tags: ['限制', '最大', '批量', '缩放'],
    outExt: 'mp4',
    fields: [
      { k: 'maxW', label: '最大宽度', type: 'number', def: 1920, min: 16, col: 4 },
      { k: 'maxH', label: '最大高度', type: 'number', def: 1080, min: 16, col: 4 },
      { k: 'flag', label: '缩放算法', type: 'select', def: 'lanczos', col: 4, options: [
        { v: 'lanczos', label: 'lanczos（推荐）' }, { v: 'bicubic', label: 'bicubic' }, { v: 'bilinear', label: 'bilinear' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const w = int(v.maxW, 1920, 16), h = int(v.maxH, 1080, 16);
      const f = `scale=w='min(iw\\,${w})':h='min(ih\\,${h})':force_original_aspect_ratio=decrease:flags=${v.flag || 'lanczos'}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [`画面比 ${w}x${h} 小的时候不会被放大，宽高都保持偶数。`]
      };
    }
  });

  defOp({
    id: 'geo-crop',
    cat: 'geometry',
    name: '裁剪画面区域',
    desc: '从画面里切出指定大小的矩形（依次填 x、y、宽、高），常用于去掉台标、裁掉边缘。',
    tags: ['裁剪', 'crop', '切图', '去台标'],
    outExt: 'mp4',
    fields: [
      { k: 'w', label: '裁剪宽度', type: 'number', def: 1280, min: 2, col: 3 },
      { k: 'h', label: '裁剪高度', type: 'number', def: 720, min: 2, col: 3 },
      { k: 'x', label: '起点 X', type: 'number', def: 0, min: 0, col: 3, hint: '可填表达式，如 (in_w-out_w)/2；含逗号请写成 \\,' },
      { k: 'y', label: '起点 Y', type: 'number', def: 0, min: 0, col: 3 },
      { k: 'center', label: '自动居中（忽略上面填的 X/Y）', type: 'bool', def: false, col: 6 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const w = int(v.w, 1280, 2), h = int(v.h, 720, 2);
      const x = v.center ? '(in_w-out_w)/2' : String(int(v.x, 0, 0));
      const y = v.center ? '(in_h-out_h)/2' : String(int(v.y, 0, 0));
      // min(iw,宽) 保证「要的尺寸比画面还大」时自动缩到画面大小，而不是直接报
      // "Invalid too big or non positive size for width"
      return {
        args: [...H.vf([`crop='min(iw,${w})':'min(ih,${h})':${x}:${y}`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [
          '如果填的宽高超过画面本身，会自动按画面大小裁剪（不会报错）。',
          '宽高必须是偶数（yuv420p 限制），否则末尾会被 ffmpeg 自动减 1。'
        ]
      };
    }
  });

  defOp({
    id: 'geo-crop-aspect',
    cat: 'geometry',
    name: '裁剪成指定比例（居中）',
    desc: '把画面居中裁成 16:9 / 9:16 / 1:1 等比例，多余的部分切掉，画面不会被拉伸。',
    tags: ['比例', '16:9', '方形', '竖屏', '裁剪'],
    outExt: 'mp4',
    fields: [
      { k: 'ratio', label: '目标比例', type: 'select', def: '16:9', col: 4, options: [
        { v: '16:9', label: '16:9 横屏' },
        { v: '9:16', label: '9:16 竖屏' },
        { v: '4:3', label: '4:3' },
        { v: '1:1', label: '1:1 正方形' },
        { v: '21:9', label: '21:9 宽银幕' },
        { v: '2.35:1', label: '2.35:1 电影宽银幕' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const m = String(v.ratio || '16:9').split(':');
      const rw = num(m[0], 16), rh = num(m[1], 9);
      // 目标宽 = min(iw, ih*R)，目标高 = min(ih, iw/R)，再强制偶数
      const wExpr = `trunc(min(iw\\,ih*${rw}/${rh})/2)*2`;
      const hExpr = `trunc(min(ih\\,iw*${rh}/${rw})/2)*2`;
      return {
        args: [...H.vf([`crop=w='${wExpr}':h='${hExpr}'`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [`按 ${v.ratio} 居中裁剪：只切掉多出来的边，画面内容不会被拉伸变形。`]
      };
    }
  });

  defOp({
    id: 'geo-pad-aspect',
    cat: 'geometry',
    name: '补黑边到指定比例',
    desc: '不缩小画面，只在四周补上纯色边，让成品刚好是 16:9 / 1:1 等比例（老片转宽屏常用）。',
    tags: ['黑边', '比例', 'pad', '加边'],
    outExt: 'mp4',
    fields: [
      { k: 'ratio', label: '目标比例', type: 'select', def: '16:9', col: 4, options: [
        { v: '16:9', label: '16:9' }, { v: '4:3', label: '4:3' }, { v: '1:1', label: '1:1' },
        { v: '9:16', label: '9:16' }, { v: '21:9', label: '21:9' }
      ] },
      { k: 'color', label: '填充颜色', type: 'select', def: 'black', col: 4, options: ['black', 'white', 'gray'] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const m = String(v.ratio || '16:9').split(':');
      const rw = num(m[0], 16), rh = num(m[1], 9);
      const wExpr = `trunc(max(iw\\,ih*${rw}/${rh})/2)*2`;
      const hExpr = `trunc(max(ih\\,iw*${rh}/${rw})/2)*2`;
      return {
        args: [...H.vf([`pad=w='${wExpr}':h='${hExpr}':x=(ow-iw)/2:y=(oh-ih)/2:color=${v.color || 'black'},setsar=1`]),
          ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['pad 只会加边、不会裁画面；如果原画面比目标比例更扁，加的是上下边，反之加左右边。']
      };
    }
  });

  defOp({
    id: 'geo-remove-black',
    cat: 'geometry',
    name: '自动去除黑边（两遍）',
    desc: '先跑一遍 cropdetect 让 ffmpeg 把黑边尺寸算出来，再把结果填回第二遍真正裁掉。',
    tags: ['黑边', 'cropdetect', '去黑边', '自动'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '第几遍', type: 'select', def: 'detect', col: 4, options: [
        { v: 'detect', label: '第一遍：检测黑边尺寸' },
        { v: 'apply', label: '第二遍：按检测结果裁剪' }
      ] },
      { k: 'crop', label: '裁剪参数（检测结果，格式 宽:高:X:Y）', type: 'text', def: '1920:800:0:140', col: 8,
        placeholder: '1920:800:0:140', showIf: (v) => v.mode === 'apply' },
      { k: 'limit', label: '黑边判定阈值', type: 'number', def: 24, min: 0, max: 255, col: 4,
        showIf: (v) => v.mode === 'detect', hint: '像素亮度低于它就算黑，画面偏暗时请调低（如 16）。' },
      { k: 'round', label: '尺寸对齐', type: 'number', def: 16, min: 2, col: 4,
        showIf: (v) => v.mode === 'detect', hint: '检测结果会对齐到这个数的倍数，H.264 建议 16。' },
      { k: 'seconds', label: '只分析前 N 秒（0=全片）', type: 'number', def: 30, min: 0, col: 4,
        showIf: (v) => v.mode === 'detect', hint: '检测整片很慢，30 秒足够看出黑边。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      if (v.mode === 'apply') {
        const crop = String(v.crop || '').trim();
        if (!/^\d+:\d+(:\d+)?(:\d+)?$/.test(crop)) {
          return { args: ['-c', 'copy'], warnings: ['裁剪参数格式不对，请填成 宽:高:X:Y（例如 1920:800:0:140），已退化为直接复制。'] };
        }
        return {
          args: [...H.vf([`crop=${crop}`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
          notes: ['第二遍只做裁剪，速度很快。']
        };
      }
      const args = ['-vf', `cropdetect=limit=${int(v.limit, 24, 0)}:round=${int(v.round, 16, 2)}`];
      const sec = num(v.seconds, 30);
      if (sec > 0) args.push('-t', String(sec));
      args.push('-an', '-f', 'null');
      return {
        args,
        output: '-',
        notes: [
          '这一遍不产出文件，只把结果打印在窗口里。运行后请在输出里找类似 crop=1920:800:0:140 的那一行。',
          '把找到的数值填回本操作的「裁剪参数」框，再把「第几遍」改成第二遍，重新生成命令执行。'
        ]
      };
    }
  });

  defOp({
    id: 'geo-rotate',
    cat: 'geometry',
    name: '旋转 90° / 180° / 270°',
    desc: '把横屏拍成竖屏的视频转正，或做 180° 倒转，画面不损失任何像素。',
    tags: ['旋转', '竖屏', 'transpose', '中枪转正'],
    outExt: 'mp4',
    fields: [
      { k: 'dir', label: '旋转方向', type: 'select', def: 'cw', col: 4, options: [
        { v: 'cw', label: '顺时针 90°（手机横拍转竖）' },
        { v: 'ccw', label: '逆时针 90°' },
        { v: '180', label: '180°（上下颠倒转正）' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = v.dir === 'ccw' ? 'transpose=2' : v.dir === '180' ? 'hflip,vflip' : 'transpose=1';
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['如果播放器里仍然显示成旋转过的样子，在「附加参数」里加 -metadata:s:v rotate=0 试试。']
      };
    }
  });

  defOp({
    id: 'geo-rotate-angle',
    cat: 'geometry',
    name: '任意角度旋转（自动补边）',
    desc: '按角度斜着转画面，可选自动扩大画布避免四角被切掉，适合做轻微歪斜校正。',
    tags: ['旋转', '角度', 'rotate', '校正'],
    outExt: 'mp4',
    fields: [
      { k: 'angle', label: '旋转角度（度，正数=逆时针）', type: 'number', def: 15, min: -180, max: 180, step: 0.5, col: 4 },
      { k: 'expand', label: '自动扩大画布（不切角）', type: 'bool', def: true, col: 4 },
      { k: 'color', label: '空出来的区域填什么颜色', type: 'select', def: 'black', col: 4, options: ['black', 'white', 'gray', 'none@0'] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const a = num(v.angle, 15);
      const rad = `${a}*PI/180`;
      const parts = [`rotate=${rad}`];
      // rotw/roth 算出来的外接矩形常常是奇数，yuv420p + libx264 会直接拒绝，所以向上取到偶数
      if (v.expand) parts.push(`ow=ceil(rotw(${rad})/2)*2`, `oh=ceil(roth(${rad})/2)*2`);
      parts.push(`c=${v.color || 'black'}`);
      return {
        args: [...H.vf([parts.join(':')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['rotw()/roth() 按旋转后的外接矩形算尺寸，能保证四个角完整保留；转正后画面会变大。',
                '尺寸已向上取到偶数，避免 yuv420p 编码器因奇数宽高报错。']
      };
    }
  });

  defOp({
    id: 'geo-flip',
    cat: 'geometry',
    name: '水平镜像 / 垂直翻转',
    desc: '左右对调（照镜子）或上下对调，常用于避开版权检测或修正摄像头装反。',
    tags: ['镜像', '翻转', 'hflip', 'vflip'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '翻转方式', type: 'select', def: 'h', col: 4, options: [
        { v: 'h', label: '水平镜像（左右对调）' },
        { v: 'v', label: '垂直翻转（上下对调）' },
        { v: 'both', label: '两者都做（等于转 180°）' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = v.mode === 'v' ? 'vflip' : v.mode === 'both' ? 'hflip,vflip' : 'hflip';
      return { args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)] };
    }
  });

  defOp({
    id: 'geo-sar-dar',
    cat: 'geometry',
    name: '设置像素宽高比 SAR / DAR',
    desc: '修正画面被压扁或拉长的问题（DVD、老摄像机常见），只改写比例信息。',
    tags: ['sar', 'dar', '比例', '变形'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '改哪个', type: 'select', def: 'dar', col: 4, options: [
        { v: 'dar', label: '显示宽高比 DAR（推荐）' },
        { v: 'sar', label: '像素宽高比 SAR' },
        { v: 'both', label: '两个都设置' }
      ] },
      { k: 'sar', label: 'SAR 值（如 1 或 32:27）', type: 'text', def: '1', col: 4, showIf: (v) => v.mode !== 'dar' },
      { k: 'dar', label: 'DAR 值（如 16:9）', type: 'text', def: '16:9', col: 4, showIf: (v) => v.mode !== 'sar' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = [];
      if (v.mode !== 'dar') f.push(`setsar=${String(v.sar || '1').replace(':', '/')}`);
      if (v.mode !== 'sar') f.push(`setdar=${String(v.dar || '16:9').replace(':', '/')}`);
      if (!f.length) f.push('setsar=1');
      return {
        args: [...H.vf([f.join(',')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['大部分按宽度缩放的滤镜会自动写 setsar=1，如果画面仍被拉长，用这个操作强制指定。']
      };
    }
  });

  defOp({
    id: 'geo-social',
    cat: 'geometry',
    name: '适配社交平台尺寸',
    desc: '一键输出抖音竖屏、B 站横屏、方屏等成品尺寸，自带黑边填充或裁满两种模式。',
    tags: ['抖音', 'B站', '竖屏', '1080x1920', '平台'],
    outExt: 'mp4',
    fields: [
      { k: 'platform', label: '平台 / 尺寸', type: 'select', def: 'douyin', col: 6, options: [
        { v: 'douyin', label: '抖音 / 快手 / 视频号 竖屏 1080x1920' },
        { v: 'bilibili', label: 'B 站 / YouTube 横屏 1920x1080' },
        { v: 'square', label: '朋友圈 / 小红书 方屏 1080x1080' },
        { v: 'xhs', label: '小红书 竖屏 1080x1440' },
        { v: 'wxcover', label: '公众号封面 900x383' }
      ] },
      { k: 'mode', label: '适配方式', type: 'select', def: 'pad', col: 6, options: [
        { v: 'pad', label: '完整画面 + 黑边（不丢内容）' },
        { v: 'crop', label: '裁满全屏（铺满，切掉多余）' }
      ] },
      ...encFields(20), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const table = {
        douyin: [1080, 1920], bilibili: [1920, 1080], square: [1080, 1080], xhs: [1080, 1440], wxcover: [900, 383]
      };
      const wh = table[v.platform] || table.douyin;
      const w = wh[0], h = wh[1];
      const f = v.mode === 'crop'
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [`输出固定为 ${w}x${h}，平台二次压缩更少。抖音竖屏建议用后配的字幕/水印操作把重点放在中间安全区。`]
      };
    }
  });

  defOp({
    id: 'geo-superres',
    cat: 'geometry',
    name: '放大画面（插值 + 锐化）',
    desc: '用 lanczos 插值把小画面放大，并可顺手锐化让观感更清晰。注意：插值不会凭空补出细节。',
    tags: ['放大', '超分', 'upscale', '锐化', 'lanczos'],
    outExt: 'mp4',
    fields: [
      { k: 'factor', label: '放大倍数', type: 'number', def: 2, min: 1.05, max: 4, step: 0.05, col: 4 },
      { k: 'flag', label: '插值算法', type: 'select', def: 'lanczos', col: 4, options: [
        { v: 'lanczos', label: 'lanczos（最清晰，推荐）' },
        { v: 'bicubic', label: 'bicubic（柔和）' },
        { v: 'neighbor', label: 'neighbor（像素风 / 动画）' }
      ] },
      { k: 'sharpen', label: '放大后锐化强度（0=不锐化）', type: 'number', def: 0.8, min: 0, max: 2, step: 0.1, col: 4,
        hint: '轻微锐化能改善放大后的发虚，过大容易出现白边。' },
      ...encFields(20), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = num(v.factor, 2);
      const parts = [`scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2:flags=${v.flag || 'lanczos'}`];
      const s = num(v.sharpen, 0.8);
      if (s > 0) parts.push(`unsharp=5:5:${s}:5:5:0`);
      return {
        args: [...H.vf([parts.join(',')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [
          '这是传统插值放大：画面变大会更清晰一点，但不会补出原本不存在的细节。',
          '想要真正的 AI 超分请用 Real-ESRGAN 等外部工具先放大，再用本工具做后续处理。'
        ]
      };
    }
  });

  defOp({
    id: 'geo-pixfmt',
    cat: 'geometry',
    name: '修改像素格式 / 位深',
    desc: '转成 yuv420p 解决「别的播放器打不开」，或转 10bit 做后续调色，不改分辨率。',
    tags: ['像素格式', 'yuv420p', '10bit', '兼容'],
    outExt: 'mp4',
    fields: [
      { k: 'pix', label: '目标像素格式', type: 'select', def: 'yuv420p', col: 6, options: [
        { v: 'yuv420p', label: 'yuv420p（8bit，兼容性最好）' },
        { v: 'yuv422p', label: 'yuv422p（8bit，剪辑用）' },
        { v: 'yuv420p10le', label: 'yuv420p10le（10bit，H.265 常用）' },
        { v: 'yuv444p', label: 'yuv444p（无色度抽样，体积大）' },
        { v: 'rgb24', label: 'rgb24（给部分老软件用）' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const pix = v.pix || 'yuv420p';
      const args = [...H.vf([`format=${pix}`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)];
      if (!/libx26[45]/.test(v.vcodec || '')) args.push('-pix_fmt', pix);
      return { args, notes: ['滤镜只做格式转换，不会改变画面尺寸和内容。'] };
    }
  });

  /* ================================================================
   * 水印与叠加
   * ================================================================ */

  defOp({
    id: 'ov-image-watermark',
    cat: 'overlay',
    name: '图片水印',
    desc: '把 PNG/JPG 台标叠在指定角落，可缩放、调透明度、留边距，支持透明背景 PNG。',
    tags: ['水印', 'logo', '台标', 'overlay', '图片'],
    outExt: 'mp4',
    fields: [
      { k: 'wm', label: '水印图片路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\logo.png',
        hint: '建议用带透明通道的 PNG；第二输入文件不需要放进「输入文件夹」。' },
      posField('br', 4), ...marginFields(4),
      { k: 'scale', label: '水印缩放（1=原图大小）', type: 'number', def: 0.2, min: 0.01, max: 4, step: 0.05, col: 3 },
      { k: 'opacity', label: '不透明度（1=完全不透明）', type: 'number', def: 1, min: 0, max: 1, step: 0.05, col: 3 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const wm = String(v.wm || '').trim();
      if (!wm) return warnCopy('没有填写水印图片路径，已退化为直接复制原文件。');
      const op = Math.min(1, Math.max(0, num(v.opacity, 1)));
      const chain = [`format=rgba`, `scale=iw*${num(v.scale, 0.2)}:-1`];
      if (op < 1) chain.push(`colorchannelmixer=aa=${op}`);
      const xy = overlayXY(v.pos, v.mx, v.my);
      const fc = [
        `[1:v]${chain.join(',')}[wm]`,
        `[0:v][wm]overlay=${xy.x}:${xy.y}:format=auto[out]`
      ];
      return {
        inputs: [ctx.input, wm],
        args: [
          ...H.fc(fc, ['[out]']),
          ...(v.acodec === 'none' ? [] : ['-map', '0:a?']),
          ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)
        ],
        notes: [
          '缩放比例是相对水印图片本身的尺寸（0.2 表示缩到原图的 20%），不是相对视频宽度。',
          '加了 -map 0:a? 表示原视频的音频照原样保留。'
        ]
      };
    }
  });

  defOp({
    id: 'ov-text-watermark',
    cat: 'overlay',
    name: '文字水印',
    desc: '把一段文字（账号名、网址、版权）印在画面上，可选描边、底色块、颜色和位置。',
    tags: ['文字水印', 'drawtext', '版权', '署名'],
    outExt: 'mp4',
    fields: [
      { k: 'text', label: '水印文字', type: 'text', def: '@我的频道', col: 8, hint: '不要用英文单引号，会破坏滤镜语法。' },
      { k: 'font', label: '字体文件', type: 'path', def: 'C:\\Windows\\Fonts\\msyh.ttc', col: 4,
        hint: 'Windows 可填 C:\\Windows\\Fonts\\msyh.ttc（微软雅黑）、simhei.ttf（黑体）。' },
      { k: 'textfile', label: '或从文本文件读取（填了它上面的文字失效）', type: 'path', def: '', col: 12,
        hint: '适合多行文字；文件请存成 UTF-8。' },
      { k: 'size', label: '字号', type: 'number', def: 32, min: 4, max: 400, col: 3 },
      { k: 'color', label: '文字颜色', type: 'select', def: 'white', col: 3,
        options: ['white', 'black', 'yellow', 'gold', 'red', 'orange', 'cyan', 'lime'] },
      { k: 'alpha', label: '文字不透明度', type: 'number', def: 1, min: 0, max: 1, step: 0.05, col: 3 },
      posField('br', 3), ...marginFields(3),
      { k: 'borderw', label: '描边粗细（0=不描边）', type: 'number', def: 2, min: 0, max: 20, col: 3 },
      { k: 'bordercolor', label: '描边颜色', type: 'select', def: 'black', col: 3, options: ['black', 'white', 'red', 'blue'] },
      { k: 'box', label: '加半透明底色块', type: 'bool', def: false, col: 3 },
      { k: 'boxcolor', label: '底色块颜色', type: 'select', def: 'black@0.45', col: 3,
        options: ['black@0.45', 'black@0.7', 'white@0.5', 'red@0.6'], showIf: (v) => v.box },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const tf = String(v.textfile || '').trim();
      const txt = String(v.text == null ? '' : v.text);
      if (!tf && !txt.trim()) return warnCopy('没有填写水印文字，已退化为直接复制原文件。');
      const fpath = String(v.font || '').trim() || 'C:\\Windows\\Fonts\\msyh.ttc';
      const parts = [`fontfile='${Q.filterPath(fpath, ctx.platform)}'`];
      parts.push(tf ? `textfile='${Q.filterPath(tf, ctx.platform)}'` : `text='${Q.drawtext(txt)}'`);
      parts.push(`fontsize=${int(v.size, 32, 4)}`, `fontcolor=${v.color || 'white'}`);
      const bw = int(v.borderw, 2, 0);
      if (bw > 0) parts.push(`borderw=${bw}`, `bordercolor=${v.bordercolor || 'black'}`);
      if (v.box) parts.push('box=1', `boxcolor=${v.boxcolor || 'black@0.45'}`, 'boxborderw=10');
      const a = num(v.alpha, 1);
      if (a < 1) parts.push(`alpha=${a}`);
      const xy = overlayXY(v.pos, v.mx, v.my);
      parts.push(`x=${xy.x}`, `y=${xy.y}`);
      return {
        args: [...H.vf([`drawtext=${parts.join(':')}`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['字体文件要真实存在，路径里用反斜杠或正斜杠都行，程序会自动转义成 ffmpeg 认识的写法。']
      };
    }
  });

  defOp({
    id: 'ov-timecode',
    cat: 'overlay',
    name: '时间码水印',
    desc: '在画面上实时显示播放时间（HH:MM:SS），做审片、取证、监控回放时很有用。',
    tags: ['时间码', 'timecode', 'pts', 'drawtext'],
    outExt: 'mp4',
    fields: [
      { k: 'prefix', label: '时间码前面的文字（可留空）', type: 'text', def: '', col: 6, hint: '例如：拍摄时间 ' },
      { k: 'suffix', label: '时间码后面的文字（可留空）', type: 'text', def: '', col: 6 },
      { k: 'font', label: '字体文件', type: 'path', def: 'C:\\Windows\\Fonts\\msyh.ttc', col: 6 },
      { k: 'size', label: '字号', type: 'number', def: 36, min: 4, max: 400, col: 3 },
      { k: 'color', label: '文字颜色', type: 'select', def: 'white', col: 3, options: ['white', 'yellow', 'lime', 'red'] },
      posField('tl', 4), ...marginFields(4),
      { k: 'box', label: '加半透明底色块', type: 'bool', def: true, col: 4 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const fpath = String(v.font || '').trim() || 'C:\\Windows\\Fonts\\msyh.ttc';
      const parts = [`fontfile='${Q.filterPath(fpath, ctx.platform)}'`];
      const pre = Q.drawtext(String(v.prefix || ''));
      const suf = Q.drawtext(String(v.suffix || ''));
      parts.push(`text='${pre}%{pts\\:hms}${suf}'`);
      parts.push(`fontsize=${int(v.size, 36, 4)}`, `fontcolor=${v.color || 'white'}`);
      if (v.box) parts.push('box=1', 'boxcolor=black@0.5', 'boxborderw=10');
      const xy = overlayXY(v.pos, v.mx, v.my);
      parts.push(`x=${xy.x}`, `y=${xy.y}`);
      return {
        args: [...H.vf([`drawtext=${parts.join(':')}`]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [
          '%{pts:hms} 会随着播放进度实时变化。',
          '% 在批处理文件里必须写成 %%：如果你把预览里的命令手工粘进 .bat，请把 %{pts:hms} 改成 %%{pts:hms}；用本工具保存的 .bat 会自动处理好。'
        ]
      };
    }
  });

  defOp({
    id: 'ov-pip',
    cat: 'overlay',
    name: '画中画',
    desc: '把第二个视频缩小后叠到角落（人物解说、反应镜头），音频只保留主视频。',
    tags: ['画中画', 'pip', '叠加', '双画面'],
    outExt: 'mp4',
    fields: [
      { k: 'pip', label: '画中画视频路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\小窗.mp4' },
      { k: 'w', label: '小窗宽度（像素）', type: 'number', def: 480, min: 32, col: 4 },
      posField('br', 4),
      { k: 'border', label: '小窗白色边框（像素，0=不要）', type: 'number', def: 4, min: 0, max: 80, col: 4 },
      ...marginFields(6),
      { k: 'mute', label: '音频处理', type: 'select', def: 'first', col: 6, options: [
        { v: 'first', label: '只保留主视频声音' },
        { v: 'mix', label: '两个视频混音' },
        { v: 'none', label: '不要声音' }
      ] },
      ...encFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const pip = String(v.pip || '').trim();
      if (!pip) return warnCopy('没有填写画中画视频路径，已退化为直接复制原文件。');
      const w = int(v.w, 480, 32);
      const b = int(v.border, 4, 0);
      const pipChain = [`scale=${w}:-2`];
      if (b > 0) pipChain.push(`pad=iw+${b * 2}:ih+${b * 2}:${b}:${b}:color=white`);
      pipChain.push('setsar=1');
      const xy = overlayXY(v.pos, v.mx, v.my);
      const fc = [
        `[1:v]${pipChain.join(',')}[pip]`,
        `[0:v][pip]overlay=${xy.x}:${xy.y}:format=auto[out]`
      ];
      const args = [...H.fc(fc, ['[out]'])];
      if (v.mute === 'mix') {
        fc.push('[0:a][1:a]amix=inputs=2:duration=longest[aout]');
        args.length = 0;
        args.push(...H.fc(fc, ['[out]', '[aout]']));
        args.push('-c:a', 'aac', '-b:a', '192k');
      } else if (v.mute === 'none') {
        args.push('-an');
      } else {
        args.push('-map', '0:a?');
      }
      args.push(...encArgs(v), ...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, pip],
        args,
        notes: [
          '小窗比主视频短时，它的最后一帧会停住直到主视频结束；想让小窗循环播放请用「图片循环叠加」思路或先循环小窗素材。',
          v.mute === 'mix' ? '混音要求两个视频都带音频轨，缺一个会报错。' : ''
        ].filter(Boolean)
      };
    }
  });

  defOp({
    id: 'ov-hstack',
    cat: 'overlay',
    name: '左右并排（双画面）',
    desc: '两个视频各占一半并排显示，对比测评、前后对照最常用。',
    tags: ['并排', '左右', 'hstack', '对比'],
    outExt: 'mp4',
    fields: [
      { k: 'second', label: '第二个视频路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\右边.mp4' },
      { k: 'height', label: '统一高度（像素）', type: 'number', def: 720, min: 64, col: 4 },
      { k: 'audio', label: '音频处理', type: 'select', def: 'first', col: 8, options: [
        { v: 'first', label: '只保留第一个视频的声音' },
        { v: 'mix', label: '两个声音混在一起' },
        { v: 'none', label: '不要音频' }
      ] },
      ...encFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const sec = String(v.second || '').trim();
      if (!sec) return warnCopy('没有填写第二个视频路径，已退化为直接复制原文件。');
      const h = int(v.height, 720, 64);
      const fc = [
        `[0:v]scale=-2:${h}:flags=lanczos,setsar=1[a]`,
        `[1:v]scale=-2:${h}:flags=lanczos,setsar=1[b]`,
        `[a][b]hstack=inputs=2[out]`
      ];
      const maps = ['[out]'];
      if (v.audio === 'mix') {
        fc.push('[0:a][1:a]amix=inputs=2:duration=shortest[aout]');
        maps.push('[aout]');
      } else if (v.audio !== 'none') {
        maps.push('0:a?');
      }
      const args = [...H.fc(fc, maps)];
      if (v.audio === 'mix') args.push('-c:a', 'aac', '-b:a', '192k');
      args.push(...encArgs(v), ...H.parseExtra(v.extra));
      return {
        args,
        inputs: [ctx.input, sec],
        notes: ['两个画面会缩放到同一高度后再并排，宽度自动按各自比例计算，总宽度不固定。']
      };
    }
  });

  defOp({
    id: 'ov-vstack',
    cat: 'overlay',
    name: '上下并排（双画面）',
    desc: '两个视频一上一下叠放，适合竖屏手机观看的对比视频。',
    tags: ['并排', '上下', 'vstack', '对比'],
    outExt: 'mp4',
    fields: [
      { k: 'second', label: '第二个视频路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\下面.mp4' },
      { k: 'width', label: '统一宽度（像素）', type: 'number', def: 1280, min: 64, col: 4 },
      { k: 'audio', label: '音频处理', type: 'select', def: 'first', col: 8, options: [
        { v: 'first', label: '只保留第一个视频的声音' },
        { v: 'mix', label: '两个声音混在一起' },
        { v: 'none', label: '不要音频' }
      ] },
      ...encFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const sec = String(v.second || '').trim();
      if (!sec) return warnCopy('没有填写第二个视频路径，已退化为直接复制原文件。');
      const w = int(v.width, 1280, 64);
      const fc = [
        `[0:v]scale=${w}:-2:flags=lanczos,setsar=1[a]`,
        `[1:v]scale=${w}:-2:flags=lanczos,setsar=1[b]`,
        `[a][b]vstack=inputs=2[out]`
      ];
      const maps = ['[out]'];
      if (v.audio === 'mix') {
        fc.push('[0:a][1:a]amix=inputs=2:duration=shortest[aout]');
        maps.push('[aout]');
      } else if (v.audio !== 'none') {
        maps.push('0:a?');
      }
      const args = [...H.fc(fc, maps)];
      if (v.audio === 'mix') args.push('-c:a', 'aac', '-b:a', '192k');
      args.push(...encArgs(v), ...H.parseExtra(v.extra));
      return { args, inputs: [ctx.input, sec] };
    }
  });

  defOp({
    id: 'ov-grid-2x2',
    cat: 'overlay',
    name: '2x2 四宫格',
    desc: '四个视频排成田字格，做多机位监看或四路对比，每个格子保持完整画面（自动补黑边）。',
    tags: ['四宫格', 'xstack', '多画面', '矩阵'],
    outExt: 'mp4',
    fields: [
      { k: 'v2', label: '第 2 个视频', type: 'path', def: '', col: 4 },
      { k: 'v3', label: '第 3 个视频', type: 'path', def: '', col: 4 },
      { k: 'v4', label: '第 4 个视频', type: 'path', def: '', col: 4 },
      { k: 'cellW', label: '每格宽度', type: 'number', def: 960, min: 64, col: 4 },
      { k: 'cellH', label: '每格高度', type: 'number', def: 540, min: 64, col: 4 },
      { k: 'audio', label: '音频处理', type: 'select', def: 'first', col: 4, options: [
        { v: 'first', label: '只保留第一个视频的声音' },
        { v: 'none', label: '不要音频' }
      ] },
      ...encFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const others = [String(v.v2 || '').trim(), String(v.v3 || '').trim(), String(v.v4 || '').trim()];
      if (others.some((x) => !x)) {
        return warnCopy('四宫格需要填满另外 3 个视频路径，已退化为直接复制原文件。');
      }
      const w = int(v.cellW, 960, 64), h = int(v.cellH, 540, 64);
      const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
      const fc = [];
      for (let i = 0; i < 4; i++) fc.push(`[${i}:v]${fit}[c${i}]`);
      fc.push(`[c0][c1][c2][c3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]`);
      const maps = ['[out]'];
      if (v.audio !== 'none') maps.push('0:a?');
      return {
        inputs: [ctx.input, ...others],
        args: [...H.fc(fc, maps), ...encArgs(v), ...H.parseExtra(v.extra)],
        notes: [`输出为 ${w * 2}x${h * 2}；每格内画面完整显示，多出来的部分补黑边。`]
      };
    }
  });

  defOp({
    id: 'ov-frame',
    cat: 'overlay',
    name: '加边框 / 相框',
    desc: '在画面外面加一圈纯色边框，或在画面内侧描一条细线，做照片墙、明信片风格。',
    tags: ['边框', '相框', 'pad', 'drawbox'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '边框方式', type: 'select', def: 'pad', col: 6, options: [
        { v: 'pad', label: '外扩纯色边框（画面完整）' },
        { v: 'inner', label: '内侧描边（画面不变大）' },
        { v: 'both', label: '外扩边框 + 内侧细线' }
      ] },
      { k: 'width', label: '边框宽度（像素）', type: 'number', def: 24, min: 1, max: 400, col: 3 },
      { k: 'color', label: '边框颜色', type: 'select', def: 'white', col: 3,
        options: ['white', 'black', 'gray', 'gold', 'navy', 'darkgreen'] },
      { k: 'innerW', label: '内侧细线宽度', type: 'number', def: 3, min: 1, max: 60, col: 3,
        showIf: (v) => v.mode !== 'pad' },
      { k: 'innerColor', label: '内侧细线颜色', type: 'select', def: 'black', col: 3,
        options: ['black', 'white', 'gray'], showIf: (v) => v.mode !== 'pad' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const b = int(v.width, 24, 1);
      const iw = int(v.innerW, 3, 1);
      const color = v.color || 'white';
      const f = [];
      if (v.mode === 'pad' || v.mode === 'both') {
        f.push(`pad=iw+${b * 2}:ih+${b * 2}:${b}:${b}:color=${color}`);
      }
      if (v.mode === 'inner') {
        f.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${v.innerColor || 'black'}:t=${iw}`);
      } else if (v.mode === 'both') {
        f.push(`drawbox=x=${b}:y=${b}:w=iw-${b * 2}:h=ih-${b * 2}:color=${v.innerColor || 'black'}:t=${iw}`);
      }
      f.push('setsar=1');
      return {
        args: [...H.vf([f.join(',')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['外扩边框会让输出尺寸变大（宽高各增加 2 倍边框宽度）。']
      };
    }
  });

  defOp({
    id: 'ov-mask',
    cat: 'overlay',
    name: '叠加色块遮罩',
    desc: '整体压暗调色、铺一层半透明颜色，或只遮住某个区域（打码前的临时遮挡）。',
    tags: ['遮罩', '半透明', '压暗', 'drawbox', '色块'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '遮罩方式', type: 'select', def: 'full', col: 6, options: [
        { v: 'full', label: '整屏铺半透明色块' },
        { v: 'region', label: '只遮住某个矩形区域' },
        { v: 'tint', label: '整体色调压制（无覆盖层）' }
      ] },
      { k: 'color', label: '遮罩颜色', type: 'select', def: 'black', col: 3,
        options: ['black', 'white', 'red', 'blue', 'yellow', 'gray'], showIf: (v) => v.mode !== 'tint' },
      { k: 'opacity', label: '遮罩不透明度', type: 'number', def: 0.4, min: 0.02, max: 1, step: 0.02, col: 3,
        showIf: (v) => v.mode !== 'tint' },
      { k: 'x', label: '区域 X', type: 'number', def: 100, min: 0, col: 3, showIf: (v) => v.mode === 'region' },
      { k: 'y', label: '区域 Y', type: 'number', def: 100, min: 0, col: 3, showIf: (v) => v.mode === 'region' },
      { k: 'w', label: '区域宽', type: 'number', def: 400, min: 2, col: 3, showIf: (v) => v.mode === 'region' },
      { k: 'h', label: '区域高', type: 'number', def: 200, min: 2, col: 3, showIf: (v) => v.mode === 'region' },
      { k: 'r', label: '红色通道系数', type: 'number', def: 0.8, min: 0, max: 2, step: 0.05, col: 4, showIf: (v) => v.mode === 'tint' },
      { k: 'g', label: '绿色通道系数', type: 'number', def: 0.8, min: 0, max: 2, step: 0.05, col: 4, showIf: (v) => v.mode === 'tint' },
      { k: 'b', label: '蓝色通道系数', type: 'number', def: 0.9, min: 0, max: 2, step: 0.05, col: 4, showIf: (v) => v.mode === 'tint' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      let f;
      if (v.mode === 'tint') {
        f = `colorchannelmixer=rr=${num(v.r, 0.8)}:gg=${num(v.g, 0.8)}:bb=${num(v.b, 0.9)}`;
      } else if (v.mode === 'region') {
        f = `drawbox=x=${int(v.x, 100, 0)}:y=${int(v.y, 100, 0)}:w=${int(v.w, 400, 2)}:h=${int(v.h, 200, 2)}`
          + `:color=${v.color || 'black'}@${num(v.opacity, 0.4)}:t=fill`;
      } else {
        f = `drawbox=x=0:y=0:w=iw:h=ih:color=${v.color || 'black'}@${num(v.opacity, 0.4)}:t=fill`;
      }
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [v.mode === 'tint'
          ? '系数 1 表示不变，小于 1 变暗、大于 1 提亮；三个通道不一致就会改变色调。'
          : 't=fill 表示实心填充，不透明度靠颜色后面的 @数值 控制（如 black@0.4）。']
      };
    }
  });

  defOp({
    id: 'ov-animated-watermark',
    cat: 'overlay',
    name: '动态水印（图片循环漂移）',
    desc: '让水印图一直叠在画面上并来回移动，比静止水印更难被裁掉，适合防盗搬。',
    tags: ['动态水印', '漂移', '循环', '跑马灯', 'logo'],
    outExt: 'mp4',
    fields: [
      { k: 'wm', label: '水印图片路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\logo.png' },
      { k: 'motion', label: '运动方式', type: 'select', def: 'h', col: 4, options: [
        { v: 'none', label: '静止不动' },
        { v: 'h', label: '左右来回漂移' },
        { v: 'v', label: '上下来回漂移' },
        { v: 'd', label: '斜向漂移' }
      ] },
      { k: 'speed', label: '漂移速度（像素/秒）', type: 'number', def: 40, min: 1, max: 600, col: 4,
        showIf: (v) => v.motion !== 'none' },
      { k: 'scale', label: '水印缩放（1=原图大小）', type: 'number', def: 0.18, min: 0.01, max: 4, step: 0.02, col: 4 },
      posField('br', 4), ...marginFields(4),
      { k: 'opacity', label: '不透明度', type: 'number', def: 0.85, min: 0, max: 1, step: 0.05, col: 4 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const wm = String(v.wm || '').trim();
      if (!wm) return warnCopy('没有填写水印图片路径，已退化为直接复制原文件。');
      const op = Math.min(1, Math.max(0, num(v.opacity, 0.85)));
      const sp = num(v.speed, 40);
      const chain = ['format=rgba', `scale=iw*${num(v.scale, 0.18)}:-1`];
      if (op < 1) chain.push(`colorchannelmixer=aa=${op}`);
      const xy = overlayXY(v.pos, v.mx, v.my);
      let x = xy.x, y = xy.y;
      if (v.motion === 'h') x = `W-mod(t*${sp}\\,W+w)`;
      else if (v.motion === 'v') y = `H-mod(t*${sp}\\,H+h)`;
      else if (v.motion === 'd') {
        x = `W-mod(t*${sp}\\,W+w)`;
        y = `H-mod(t*${sp * 0.6}\\,H+h)`;
      }
      const fc = [
        `[1:v]${chain.join(',')}[wm]`,
        `[0:v][wm]overlay='${x}':'${y}':format=auto[out]`
      ];
      return {
        inputs: [ctx.input, { path: wm, args: ['-loop', '1', '-framerate', '5'] }],
        args: [
          ...H.fc(fc, ['[out]']),
          ...(v.acodec === 'none' ? [] : ['-map', '0:a?']),
          ...encArgs(v), ...audArgs(v), '-shortest', ...H.parseExtra(v.extra)
        ],
        notes: [
          '水印图用 -loop 1 无限循环，漂移位置由时间 t 计算，-shortest 保证编码在主视频结束时停下来。',
          v.motion === 'none' ? '选择「静止不动」时位置由九宫格决定。' : '漂移轨迹会绕画面循环，不会跑出画面外。'
        ]
      };
    }
  });

  /* ================================================================
   * 画质滤镜
   * ================================================================ */

  defOp({
    id: 'flt-eq',
    cat: 'filter',
    name: '亮度 / 对比度 / 饱和度 / 伽马',
    desc: '最基础的四项画面调节，暗片提亮、灰片加对比、颜色发闷时加饱和度。',
    tags: ['亮度', '对比度', '饱和度', 'eq', '调色'],
    outExt: 'mp4',
    fields: [
      { k: 'brightness', label: '亮度（-1 ~ 1，0 不变）', type: 'number', def: 0, min: -1, max: 1, step: 0.01, col: 3 },
      { k: 'contrast', label: '对比度（0 ~ 3，1 不变）', type: 'number', def: 1, min: 0, max: 3, step: 0.01, col: 3 },
      { k: 'saturation', label: '饱和度（0=黑白，1 不变）', type: 'number', def: 1, min: 0, max: 3, step: 0.01, col: 3 },
      { k: 'gamma', label: '伽马（1 不变，>1 中间调更亮）', type: 'number', def: 1, min: 0.1, max: 10, step: 0.05, col: 3 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = `eq=brightness=${num(v.brightness, 0)}:contrast=${num(v.contrast, 1)}`
        + `:saturation=${num(v.saturation, 1)}:gamma=${num(v.gamma, 1)}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['四项全部按填写的值写入命令；只想改一项时，其余保持默认值（0/1/1/1）即可。']
      };
    }
  });

  defOp({
    id: 'flt-hue',
    cat: 'filter',
    name: '色相旋转 / 单独调饱和',
    desc: '把整体色调沿色轮转一个角度（修正偏色、做怪色效果），或只调饱和度。',
    tags: ['色相', 'hue', '偏色', '饱和度'],
    outExt: 'mp4',
    fields: [
      { k: 'h', label: '色相偏移（度，0~360）', type: 'number', def: 0, min: -360, max: 360, step: 1, col: 4 },
      { k: 's', label: '饱和度倍数', type: 'number', def: 1, min: 0, max: 5, step: 0.05, col: 4 },
      { k: 'b', label: '亮度增量（-1 ~ 1）', type: 'number', def: 0, min: -1, max: 1, step: 0.01, col: 4 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = `hue=h=${num(v.h, 0)}:s=${num(v.s, 1)}:b=${num(v.b, 0)}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['色相 180 度会把红蓝对调，可以得到类似「红外摄影」的怪色效果。']
      };
    }
  });

  defOp({
    id: 'flt-temperature',
    cat: 'filter',
    name: '色温 / 色调修正',
    desc: '按开尔文色温把画面调暖或调冷，再单独微调绿-品红，修正白平衡偏色。',
    tags: ['色温', '白平衡', '冷暖', 'colortemperature'],
    outExt: 'mp4',
    fields: [
      { k: 'temp', label: '目标色温（K，6500 为中性）', type: 'number', def: 6500, min: 1000, max: 40000, step: 100, col: 4,
        hint: '调低变暖（偏黄），调高变冷（偏蓝）。' },
      { k: 'mix', label: '应用强度（0~1）', type: 'number', def: 1, min: 0, max: 1, step: 0.05, col: 4 },
      { k: 'gm', label: '绿色-品红微调（-0.3 ~ 0.3）', type: 'number', def: 0, min: -0.3, max: 0.3, step: 0.01, col: 4,
        hint: '正数偏绿，负数偏品红；日光灯下发绿时用负数修。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = [`colortemperature=temperature=${int(v.temp, 6500, 1000)}:mix=${num(v.mix, 1)}`];
      const gm = num(v.gm, 0);
      if (gm !== 0) f.push(`colorbalance=gm=${gm}`);
      return {
        args: [...H.vf([f.join(',')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['colortemperature 滤镜需要 ffmpeg 4.4 及以上；老版本请改用附加参数 colorbalance=rs=0.1:bs=-0.1 这类写法。']
      };
    }
  });

  defOp({
    id: 'flt-sharpen',
    cat: 'filter',
    name: '锐化（unsharp）',
    desc: '让画面边缘更挺、细节更清楚，也可以反过来填负数做轻微柔化。',
    tags: ['锐化', 'unsharp', '清晰', '柔化'],
    outExt: 'mp4',
    fields: [
      { k: 'amount', label: '锐化强度（1 左右合适，负数=柔化）', type: 'number', def: 1, min: -2, max: 5, step: 0.1, col: 4 },
      { k: 'size', label: '锐化半径', type: 'select', def: 5, col: 4, options: [3, 5, 7, 9, 11, 13, 23, 25].map((x) => ({ v: String(x), label: x + 'x' + x })) },
      { k: 'chroma', label: '色度锐化强度（一般 0）', type: 'number', def: 0, min: 0, max: 3, step: 0.1, col: 4,
        hint: '调高会让彩色噪点变明显，除非画面糊得厉害否则保持 0。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const m = int(v.size, 5, 3);
      const f = `unsharp=${m}:${m}:${num(v.amount, 1)}:${m}:${m}:${num(v.chroma, 0)}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['顺序为 亮度半径X:Y:亮度强度:色度半径X:Y:色度强度，半径必须是奇数。']
      };
    }
  });

  defOp({
    id: 'flt-blur',
    cat: 'filter',
    name: '高斯模糊 / 方框模糊',
    desc: '整体虚化画面，做背景板、遮挡敏感内容或做转场素材。',
    tags: ['模糊', 'gblur', 'boxblur', '虚化'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '模糊算法', type: 'select', def: 'gblur', col: 4, options: [
        { v: 'gblur', label: 'gblur 高斯模糊（自然，推荐）' },
        { v: 'boxblur', label: 'boxblur 方框模糊（更快）' }
      ] },
      { k: 'strength', label: '模糊强度', type: 'number', def: 10, min: 1, max: 100, step: 1, col: 4,
        hint: 'gblur 是 sigma 值（8~20 已经很糊），boxblur 是半径像素。' },
      { k: 'steps', label: 'gblur 迭代次数', type: 'number', def: 1, min: 1, max: 6, col: 4, showIf: (v) => v.mode === 'gblur' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const s = num(v.strength, 10);
      const f = v.mode === 'boxblur'
        ? `boxblur=luma_radius=${s}:luma_power=2:chroma_radius=${(s / 2).toFixed(1)}:chroma_power=2`
        : `gblur=sigma=${s}:steps=${int(v.steps, 1, 1)}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['只想模糊某个区域（比如打码）请用「局部马赛克 / 去台标」这个操作。']
      };
    }
  });

  defOp({
    id: 'flt-mosaic',
    cat: 'filter',
    name: '局部马赛克 / 去台标',
    desc: '只对指定矩形区域打马赛克，或用 delogo 把台标、时间戳平滑地抹掉。',
    tags: ['马赛克', '打码', '去台标', 'delogo', '遮挡'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '处理方式', type: 'select', def: 'mosaic', col: 4, options: [
        { v: 'mosaic', label: '马赛克（像素块，最彻底）' },
        { v: 'delogo', label: 'delogo 平滑抹除（去台标更自然）' }
      ] },
      { k: 'x', label: '区域 X', type: 'number', def: 40, min: 0, col: 2 },
      { k: 'y', label: '区域 Y', type: 'number', def: 40, min: 0, col: 2 },
      { k: 'w', label: '区域宽', type: 'number', def: 240, min: 2, col: 2 },
      { k: 'h', label: '区域高', type: 'number', def: 120, min: 2, col: 2 },
      { k: 'strength', label: '马赛克粒度', type: 'number', def: 12, min: 1, max: 60, col: 4, showIf: (v) => v.mode === 'mosaic' },
      { k: 'show', label: '显示区域框（调试用）', type: 'bool', def: false, col: 4, showIf: (v) => v.mode === 'delogo' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const x = int(v.x, 40, 0), y = int(v.y, 40, 0), w = int(v.w, 240, 2), h = int(v.h, 120, 2);
      if (v.mode === 'delogo') {
        return {
          args: [...H.vf([`delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=${v.show ? 1 : 0}`]),
            ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
          notes: ['delogo 会用四周像素做插值填充，区域要刚好盖住台标（略大一点），太小会留下痕迹。']
        };
      }
      const s = num(v.strength, 12);
      const fc = [
        '[0:v]split=2[base][tmp]',
        `[tmp]crop=${w}:${h}:${x}:${y},boxblur=${s}:2[mos]`,
        `[base][mos]overlay=${x}:${y}[out]`
      ];
      return {
        args: [
          ...H.fc(fc, ['[out]']),
          ...(v.acodec === 'none' ? [] : ['-map', '0:a?']),
          ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)
        ],
        notes: ['原理是先复制一路画面，把要遮挡的矩形裁出来模糊，再盖回原位置；区域坐标以左上角为原点。']
      };
    }
  });

  defOp({
    id: 'flt-denoise',
    cat: 'filter',
    name: '视频降噪',
    desc: '去掉暗光下的颗粒噪点：hqdn3d 快而够用，nlmeans 质量高但非常慢。',
    tags: ['降噪', '噪点', 'hqdn3d', 'nlmeans', '夜拍'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '降噪算法', type: 'select', def: 'hqdn3d', col: 4, options: [
        { v: 'hqdn3d', label: 'hqdn3d（快速，推荐先用它）' },
        { v: 'nlmeans', label: 'nlmeans（高质量，极慢）' }
      ] },
      { k: 'strength', label: '降噪强度（1~10）', type: 'number', def: 3, min: 1, max: 10, step: 0.5, col: 4,
        hint: '过大画面会变得像塑料，边缘细节也会丢。' },
      { k: 'temporal', label: '保留时间维降噪（hqdn3d）', type: 'bool', def: true, col: 4, showIf: (v) => v.mode === 'hqdn3d' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const s = num(v.strength, 3);
      const f = v.mode === 'nlmeans'
        ? `nlmeans=s=${(s / 2).toFixed(2)}:p=7:r=15`
        : `hqdn3d=${s}:${(s * 0.75).toFixed(2)}:${v.temporal ? (s * 2).toFixed(2) : 0}:${v.temporal ? (s * 1.5).toFixed(2) : 0}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [
          'hqdn3d 参数顺序：亮度空间:色度空间:亮度时间:色度时间，时间维设为 0 就只做单帧降噪。',
          v.mode === 'nlmeans' ? 'nlmeans 速度极慢（1080p 大约每秒几帧），建议先用短视频试参数。' : ''
        ].filter(Boolean)
      };
    }
  });

  defOp({
    id: 'flt-deinterlace',
    cat: 'filter',
    name: '去隔行（去交错横纹）',
    desc: '老电视录制、DVD 素材常见的横向拉丝用它消除，可选输出双倍帧率让运动更顺。',
    tags: ['去隔行', '交错', 'yadif', 'bwdif', '横纹'],
    outExt: 'mp4',
    fields: [
      { k: 'engine', label: '去隔行滤镜', type: 'select', def: 'yadif', col: 4, options: [
        { v: 'yadif', label: 'yadif（经典，兼容性好）' },
        { v: 'bwdif', label: 'bwdif（更锐利，推荐）' }
      ] },
      { k: 'double', label: '输出双倍帧率', type: 'bool', def: false, col: 4,
        hint: '勾上后 25i 变 50p，动作更顺但文件更大。' },
      { k: 'parity', label: '场序（大多数选自动）', type: 'select', def: '-1', col: 4, options: [
        { v: '-1', label: '自动判断' },
        { v: '0', label: '上场优先（TFF）' },
        { v: '1', label: '下场优先（BFF）' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const mode = v.double ? 1 : 0;
      const f = `${v.engine === 'bwdif' ? 'bwdif' : 'yadif'}=mode=${mode}:parity=${v.parity || '-1'}:deint=0`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['mode=1 表示每场输出一帧（帧率翻倍），mode=0 表示每两场合成一帧（帧率不变）。']
      };
    }
  });

  defOp({
    id: 'flt-looks',
    cat: 'filter',
    name: '风格化调色（预设）',
    desc: '一键套用复古褪色、黑白、棕褐怀旧、高对比、负片、暖调、冷调等常见风格。',
    tags: ['风格', '黑白', '复古', '怀旧', '负片'],
    outExt: 'mp4',
    fields: [
      { k: 'look', label: '风格', type: 'select', def: 'vintage', col: 6, options: [
        { v: 'vintage', label: '复古褪色（曲线 preset=vintage）' },
        { v: 'bw', label: '黑白（去色）' },
        { v: 'sepia', label: '棕褐怀旧（老照片）' },
        { v: 'contrast', label: '高对比硬朗' },
        { v: 'negative', label: '负片（颜色反转）' },
        { v: 'warm', label: '暖调阳光' },
        { v: 'cold', label: '冷调忧郁' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const table = {
        vintage: 'curves=preset=vintage',
        bw: 'hue=s=0',
        sepia: 'colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131',
        contrast: 'curves=preset=strong_contrast',
        negative: 'negate',
        warm: 'colorbalance=rs=0.06:gs=0.02:bs=-0.06:rm=0.04:bm=-0.04',
        cold: 'colorbalance=bs=0.06:bm=0.04:rs=-0.05'
      };
      return {
        args: [...H.vf([table[v.look] || table.vintage]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['想要「复古 + 加噪点 + 暗角」的组合效果，可以把本操作和「添加噪点 / 胶片颗粒」一起放进流水线。']
      };
    }
  });

  defOp({
    id: 'flt-cinematic',
    cat: 'filter',
    name: '电影感调色',
    desc: '青橙色调 + 对比 + 色相微调 + 可选暗角与 2.35:1 黑边，让画面像电影一样「有味」。',
    tags: ['电影感', '青橙', '调色', '暗角', '宽银幕'],
    outExt: 'mp4',
    fields: [
      { k: 'teal', label: '青橙色调（暗部偏青、高光偏橙）', type: 'bool', def: true, col: 4 },
      { k: 'contrast', label: '对比度', type: 'number', def: 1.12, min: 0.5, max: 2, step: 0.02, col: 4 },
      { k: 'saturation', label: '饱和度', type: 'number', def: 1.05, min: 0, max: 2, step: 0.02, col: 4 },
      { k: 'hue', label: '色相偏移（度）', type: 'number', def: 0, min: -30, max: 30, step: 1, col: 4 },
      { k: 'vignette', label: '加暗角', type: 'bool', def: false, col: 4 },
      { k: 'letterbox', label: '加 2.35:1 上下黑边', type: 'bool', def: false, col: 4,
        hint: '用黑条覆盖上下画面，画面本身不缩放。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = [];
      if (v.teal) f.push('colorbalance=rs=-0.05:bs=0.08:rm=0.03:bm=-0.03:rh=0.05:bh=-0.05');
      f.push(`eq=contrast=${num(v.contrast, 1.12)}:saturation=${num(v.saturation, 1.05)}`);
      const hue = num(v.hue, 0);
      if (hue !== 0) f.push(`hue=h=${hue}`);
      if (v.vignette) f.push('vignette=PI/4');
      if (v.letterbox) {
        const bar = '(ih-iw/2.35)/2';
        f.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`);
        f.push(`drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
      }
      return {
        args: [...H.vf([f.join(',')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [v.letterbox
          ? '2.35:1 黑边只在画面比 2.35:1 更「方」的时候有效；已经是超宽画面的素材请改用裁剪。'
          : '调色顺序是：青橙 → 对比饱和度 → 色相 → 暗角/黑边，想换顺序可以拆成多个操作。']
      };
    }
  });

  defOp({
    id: 'flt-auto-contrast',
    cat: 'filter',
    name: '自动对比度增强',
    desc: '让 ffmpeg 自己分析画面把灰蒙蒙的素材拉开明暗；normalize 稳，histeq 猛但容易过曝。',
    tags: ['自动', '对比度', 'normalize', 'histeq', '增强'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '增强方式', type: 'select', def: 'normalize', col: 6, options: [
        { v: 'normalize', label: 'normalize（自动白平衡 + 拉伸，推荐）' },
        { v: 'histeq', label: 'histeq（直方图均衡，效果强）' },
        { v: 'eq', label: 'eq 固定参数（不分析画面，最快）' }
      ] },
      { k: 'strength', label: '强度（1=默认，越大越猛）', type: 'number', def: 1, min: 0, max: 3, step: 0.05, col: 3 },
      { k: 'smoothing', label: 'normalize 平滑（帧数）', type: 'number', def: 10, min: 0, max: 200, col: 3,
        showIf: (v) => v.mode === 'normalize' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const st = num(v.strength, 1);
      const f = v.mode === 'histeq'
        ? `histeq=strength=${Math.min(1, st)}:intensity=${Math.min(1, 0.21 * st).toFixed(2)}:antibanding=none`
        : v.mode === 'eq'
          ? `eq=contrast=${(1 + 0.15 * st).toFixed(2)}:brightness=${(0.02 * st).toFixed(2)}:saturation=${(1 + 0.05 * st).toFixed(2)}`
          : `normalize=blackpt=black:whitept=white:smoothing=${int(v.smoothing, 10, 0)}:strength=${st}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [v.mode === 'histeq'
          ? 'histeq 会明显改变整体影调，明亮的天空容易一片死白，建议只取小段先试。'
          : 'normalize 逐帧统计并平滑，闪烁少，是自动增强里最稳的选择。']
      };
    }
  });

  defOp({
    id: 'flt-vidstab',
    cat: 'filter',
    name: '画面防抖稳定（两遍）',
    desc: '手持拍摄的抖动交给 vidstab 处理：第一遍分析抖动写进 trf 文件，第二遍按它稳定画面。',
    tags: ['防抖', '稳定', 'vidstab', '手持', '两遍'],
    outExt: 'mp4',
    fields: [
      { k: 'pass', label: '第几遍', type: 'select', def: 'detect', col: 4, options: [
        { v: 'detect', label: '第一遍：分析抖动（生成 trf）' },
        { v: 'apply', label: '第二遍：应用稳定（出成品）' }
      ] },
      { k: 'trf', label: '抖动数据文件（.trf，两遍必须一致）', type: 'text', def: '', col: 8,
        placeholder: '留空 = 输出目录下 原文件名_transforms.trf' },
      { k: 'shakiness', label: '抖动程度（1~10，越大越积极）', type: 'number', def: 5, min: 1, max: 10, col: 4,
        showIf: (v) => v.pass === 'detect' },
      { k: 'accuracy', label: '检测精度（1~15，越大越慢越准）', type: 'number', def: 9, min: 1, max: 15, col: 4,
        showIf: (v) => v.pass === 'detect' },
      { k: 'smoothing', label: '平滑帧数（越大越稳但会漂）', type: 'number', def: 15, min: 0, max: 60, col: 4,
        showIf: (v) => v.pass === 'apply' },
      { k: 'zoom', label: '画面缩放补偿（0=不缩放）', type: 'number', def: 0, min: 0, max: 3, step: 0.01, col: 4,
        showIf: (v) => v.pass === 'apply' },
      { k: 'optzoom', label: '自动缩放', type: 'select', def: '1', col: 4, showIf: (v) => v.pass === 'apply', options: [
        { v: '0', label: '关闭' },
        { v: '1', label: '自动避免黑边（推荐）' },
        { v: '2', label: '自动 + 尽量少缩放' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const trf = String(v.trf || '').trim() || U.join(ctx.outputDir, U.stem(ctx.input) + '_transforms.trf', ctx.platform);
      const trfArg = `'${Q.filterPath(trf, ctx.platform)}'`;
      if (v.pass === 'apply') {
        const f = `vidstabtransform=input=${trfArg}:smoothing=${int(v.smoothing, 15, 0)}`
          + `:zoom=${num(v.zoom, 0)}:optzoom=${v.optzoom || '1'}:interpol=bicubic,unsharp=5:5:0.8:3:3:0.4`;
        return {
          args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
          notes: ['第二遍必须能找到第一遍生成的 trf 文件，路径要和上面填的完全一致。']
        };
      }
      return {
        args: [
          '-vf', `vidstabdetect=shakiness=${int(v.shakiness, 5, 1)}:accuracy=${int(v.accuracy, 9, 1)}:result=${trfArg}`,
          '-an', '-f', 'null'
        ],
        output: '-',
        notes: [
          '这一遍不产出视频，只生成抖动数据文件：' + trf,
          '跑完后把「第几遍」改成第二遍，用同样的 trf 路径再执行一次即可得到稳定后的成品。',
          '第一遍会把整片分析一遍，文件很长时请耐心等待；中途也可以直接 Ctrl+C（trf 已经写完）。'
        ]
      };
    }
  });

  defOp({
    id: 'flt-colorspace',
    cat: 'filter',
    name: '色彩空间转换（BT.601 / 709 / 2020）',
    desc: '修正「颜色发灰、偏绿、对比不对」的色域错标问题，也能补上输出文件里的色彩标记。',
    tags: ['色彩空间', 'bt709', 'bt601', '色域', 'colorspace'],
    outExt: 'mp4',
    fields: [
      { k: 'out', label: '目标标准', type: 'select', def: 'bt709', col: 4, options: [
        { v: 'bt709', label: 'BT.709（高清通用）' },
        { v: 'bt601', label: 'BT.601 / SMPTE170M（标清、老 DVD）' },
        { v: 'bt2020', label: 'BT.2020（4K HDR 容器）' }
      ] },
      { k: 'in', label: '源素材标准', type: 'select', def: 'bt709', col: 4, options: [
        { v: 'bt709', label: 'BT.709（绝大多数高清素材）' },
        { v: 'bt601', label: 'BT.601 / SMPTE170M（老标清素材）' },
        { v: 'bt2020', label: 'BT.2020（4K HDR 素材）' },
        { v: 'auto', label: '让 ffmpeg 自动判断（素材没写标记时会报错）' }
      ] },
      { k: 'range', label: '亮度范围', type: 'select', def: 'keep', col: 4, options: [
        { v: 'keep', label: '保持不变' },
        { v: 'tv', label: '转成有限范围 16-235（视频标准）' },
        { v: 'pc', label: '转成全范围 0-255（电脑屏幕）' }
      ] },
      { k: 'tag', label: '同时写入输出色彩标记', type: 'bool', def: true, col: 4,
        hint: '让播放器按正确的标准解码，避免「发灰」。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      // colorspace 滤镜的 all / iall 只认下面这些常量名：BT.601 用 smpte170m，BT.2020 用 bt2020
      const table = {
        bt709: { cs: 'bt709', meta: ['bt709', 'bt709', 'bt709'] },
        bt601: { cs: 'smpte170m', meta: ['smpte170m', 'smpte170m', 'smpte170m'] },
        bt2020: { cs: 'bt2020', meta: ['bt2020nc', 'bt2020', 'bt2020-10'] }
      };
      const out = table[v.out] ? v.out : 'bt709';
      const inn = v.in && v.in !== 'auto' && table[v.in] ? v.in : null;
      const parts = [`all=${table[out].cs}`];
      // fast=1 只有在明确告诉 ffmpeg 源标准时才好用；自动判断时让滤镜自己读输入标记
      if (inn) parts.push(`iall=${table[inn].cs}`, 'fast=1');
      if (v.range === 'tv' || v.range === 'pc') parts.push(`range=${v.range}`);
      const args = [...H.vf([`colorspace=${parts.join(':')}`])];
      if (v.tag) {
        const t = table[out].meta;
        args.push('-colorspace', t[0], '-color_primaries', t[1], '-color_trc', t[2]);
        if (v.range === 'tv' || v.range === 'pc') args.push('-color_range', v.range === 'pc' ? 'pc' : 'tv');
      }
      args.push(...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra));
      return {
        args,
        warnings: [
          ...(out === 'bt2020' ? ['BT.2020 通常配合 HDR（PQ/HLG）使用，把 SDR 素材标成 BT.2020 可能让播放器显示异常。'] : []),
          ...(inn ? [] : ['源素材标准选了「自动判断」：如果素材里没有写色彩标记，colorspace 滤镜会直接报 “Unsupported input primaries”，这时请手动指定源标准（高清素材基本都是 BT.709）。'])
        ],
        notes: ['iall 用来告诉 ffmpeg 源素材的真实标准，填错会导致颜色更偏；不确定就先把源标准设成 BT.709 试一次。']
      };
    }
  });

  defOp({
    id: 'flt-hdr2sdr',
    cat: 'filter',
    name: 'HDR 转 SDR（色调映射）',
    desc: '把手机/相机拍的 HDR（HLG、PQ）转成普通 SDR，解决在普通屏幕上发灰发白的问题。',
    tags: ['hdr', 'sdr', 'tonemap', 'zscale', '发灰'],
    outExt: 'mp4',
    fields: [
      { k: 'chain', label: '处理链', type: 'select', def: 'zscale', col: 6, options: [
        { v: 'zscale', label: 'zscale 完整链（效果最好，需 ffmpeg 带 libzimg）' },
        { v: 'simple', label: '简化 tonemap（不依赖 zscale，可能偏色）' }
      ] },
      { k: 'tonemap', label: '映射算法', type: 'select', def: 'hable', col: 6, options: [
        { v: 'hable', label: 'hable（电影感，推荐）' },
        { v: 'mobius', label: 'mobius（保留高光细节）' },
        { v: 'reinhard', label: 'reinhard（柔和）' },
        { v: 'linear', label: 'linear（线性）' },
        { v: 'clip', label: 'clip（直接截断，最快）' }
      ] },
      { k: 'desat', label: '高光去饱和（0~1）', type: 'number', def: 0, min: 0, max: 1, step: 0.05, col: 4,
        hint: '高光颜色过艳时调大一点会更自然。' },
      { k: 'npl', label: '峰值亮度（npl）', type: 'number', def: 100, min: 10, max: 10000, col: 4,
        showIf: (v) => v.chain === 'zscale', hint: '按素材峰值填，手机 HDR 一般 100~1000。' },
      ...encFields(20), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const tm = v.tonemap || 'hable';
      const de = num(v.desat, 0);
      const f = v.chain === 'simple'
        ? `tonemap=tonemap=${tm}:desat=${de},format=yuv420p`
        : `zscale=t=linear:npl=${int(v.npl, 100, 10)},format=gbrpf32le,zscale=p=bt709,`
          + `tonemap=tonemap=${tm}:desat=${de},zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
      return {
        args: [
          ...H.vf([f]),
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
          ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)
        ],
        warnings: v.chain === 'zscale'
          ? ['zscale 需要 ffmpeg 编译时带上 libzimg（官方版一般都有，精简版可能没有）；报错就换「简化 tonemap」。',
             '输入必须是真正的 HDR 素材（10bit、bt2020 + PQ/HLG）。对普通 SDR 素材执行会报 “no path between colorspaces” —— 那说明这个文件本来就不是 HDR，不需要转换。']
          : ['简化链没有做线性化，颜色可能与原片有偏差，追求准确请用 zscale 完整链。',
             '输入必须是真正的 HDR 素材，SDR 素材执行这个操作没有意义。'],
        notes: ['转换后输出会写入 BT.709 标记，播放器就不会再按 HDR 处理，画面不再发灰。']
      };
    }
  });

  defOp({
    id: 'flt-grain',
    cat: 'filter',
    name: '添加噪点 / 胶片颗粒',
    desc: '给过于干净的画面加一点点颗粒，掩盖压缩块效应，或者做老胶片质感。',
    tags: ['噪点', '颗粒', '胶片', 'noise', '质感'],
    outExt: 'mp4',
    fields: [
      { k: 'strength', label: '噪点强度（1~100）', type: 'number', def: 12, min: 1, max: 100, col: 4 },
      { k: 'flags', label: '噪点变化方式', type: 'select', def: 't+u', col: 4, options: [
        { v: 't+u', label: '随时间变化 + 平均化（像真颗粒）' },
        { v: 't', label: '每帧随机变化' },
        { v: 'u', label: '静止不动（像脏镜头）' },
        { v: 'a', label: '与画面亮度相关' }
      ] },
      { k: 'mono', label: '只加亮度噪点（黑白颗粒）', type: 'bool', def: false, col: 4,
        hint: '不勾选会同时加彩色噪点，容易显脏。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const s = int(v.strength, 12, 1);
      const fl = v.flags || 't+u';
      const f = v.mono
        ? `noise=alls=0:c0s=${s}:c0f=${fl}`
        : `noise=alls=${s}:allf=${fl}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['加噪点会让文件变大；强度 8~15 之间最像真实胶片颗粒，超过 30 就明显是噪点了。']
      };
    }
  });

  defOp({
    id: 'flt-edge',
    cat: 'filter',
    name: '边缘检测 / 线稿',
    desc: '把画面变成素描线稿、彩色边缘图，做动画风开场或科技感字幕背景。',
    tags: ['边缘', '线稿', '素描', 'edgedetect', '科技感'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '边缘模式', type: 'select', def: 'wires', col: 4, options: [
        { v: 'wires', label: '白色线稿（黑底白线）' },
        { v: 'colormix', label: '彩色边缘（保留颜色）' },
        { v: 'canny', label: 'canny 细线（最干净）' }
      ] },
      { k: 'low', label: '低阈值（0~1）', type: 'number', def: 0.1, min: 0, max: 1, step: 0.01, col: 4 },
      { k: 'high', label: '高阈值（0~1）', type: 'number', def: 0.4, min: 0, max: 1, step: 0.01, col: 4 },
      { k: 'invert', label: '反色（变成白底黑线，像铅笔稿）', type: 'bool', def: false, col: 4 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = [`edgedetect=low=${num(v.low, 0.1)}:high=${num(v.high, 0.4)}:mode=${v.mode || 'wires'}`];
      if (v.invert) f.push('negate');
      return {
        args: [...H.vf([f.join(',')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['阈值越低边缘越多；想更像铅笔线稿，把高阈值调到 0.2 左右再勾上反色。']
      };
    }
  });

  /* ================================================================
   * 字幕处理
   * ================================================================ */

  const SUB_COLORS = [
    { v: '&H00FFFFFF', label: '白色' },
    { v: '&H0000FFFF', label: '黄色' },
    { v: '&H000000FF', label: '红色' },
    { v: '&H00FF0000', label: '蓝色' },
    { v: '&H0000FF00', label: '绿色' },
    { v: '&H00000000', label: '黑色' }
  ];
  const OUT_COLORS = [
    { v: '&H00000000', label: '黑色' },
    { v: '&H00FFFFFF', label: '白色' },
    { v: '&H00808080', label: '灰色' },
    { v: '&H000000FF', label: '红色' }
  ];

  defOp({
    id: 'sub-burn-srt',
    cat: 'subtitle',
    name: '烧录硬字幕（SRT）',
    desc: '把 .srt 字幕永久印进画面，任何播放器都能看到；字幕位置和样式可以自己定。',
    tags: ['硬字幕', '烧录', 'srt', 'subtitles', '内嵌'],
    outExt: 'mp4',
    fields: [
      { k: 'sub', label: '字幕文件路径（.srt）', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\字幕.srt' },
      { k: 'size', label: '字号', type: 'number', def: 24, min: 6, max: 200, col: 3 },
      { k: 'fontName', label: '字体名称', type: 'text', def: 'Microsoft YaHei', col: 3,
        hint: '写系统里已安装的字体名，如 Microsoft YaHei、SimHei、SimSun。' },
      { k: 'fontColor', label: '文字颜色', type: 'select', def: '&H00FFFFFF', col: 3, options: SUB_COLORS },
      { k: 'outline', label: '描边粗细', type: 'number', def: 2, min: 0, max: 10, col: 3 },
      { k: 'outlineColor', label: '描边颜色', type: 'select', def: '&H00000000', col: 3, options: OUT_COLORS },
      { k: 'shadow', label: '阴影大小', type: 'number', def: 0, min: 0, max: 10, col: 3 },
      { k: 'marginV', label: '距底边距离（像素）', type: 'number', def: 28, min: 0, col: 3 },
      { k: 'charenc', label: '字幕文件编码', type: 'select', def: '', col: 4, options: [
        { v: '', label: '自动（UTF-8）' },
        { v: 'GBK', label: 'GBK / GB2312（老 Windows 字幕）' },
        { v: 'UTF-8', label: '强制 UTF-8' },
        { v: 'BIG5', label: 'BIG5（繁体）' }
      ] },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const sub = String(v.sub || '').trim();
      if (!sub) return warnCopy('没有填写字幕文件路径，已退化为直接复制原文件。');
      const style = [
        `FontName=${String(v.fontName || 'Microsoft YaHei')}`,
        `FontSize=${int(v.size, 24, 6)}`,
        `PrimaryColour=${v.fontColor || '&H00FFFFFF'}`,
        `OutlineColour=${v.outlineColor || '&H00000000'}`,
        'BorderStyle=1',
        `Outline=${int(v.outline, 2, 0)}`,
        `Shadow=${int(v.shadow, 0, 0)}`,
        `MarginV=${int(v.marginV, 28, 0)}`
      ].join(',');
      const parts = [`subtitles='${Q.filterPath(sub, ctx.platform)}'`, `force_style='${style}'`];
      if (v.charenc) parts.push(`charenc=${v.charenc}`);
      return {
        args: [...H.vf([parts.join(':')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [
          '路径已按 ffmpeg 滤镜语法转义（Windows 的 C:\\ 会变成 C\\:），这是烧字幕最容易出错的地方。',
          '硬字幕是烧进像素的，无法再关闭或提取；需要可开关的字幕请用「封装软字幕轨」。'
        ]
      };
    }
  });

  defOp({
    id: 'sub-burn-ass',
    cat: 'subtitle',
    name: '烧录 ASS 特效字幕',
    desc: '用 ass 滤镜烧字幕，完整保留 ASS 的字体、位置、卡拉OK等特效样式。',
    tags: ['ass', '特效字幕', '烧录', '硬字幕', '字体'],
    outExt: 'mp4',
    fields: [
      { k: 'ass', label: 'ASS / SSA 字幕文件路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\特效.ass' },
      { k: 'fontsDir', label: '字体文件夹（可选）', type: 'path', def: '', col: 6,
        hint: '字幕自带字体时填这里，ffmpeg 会优先从这里找字体。' },
      { k: 'alpha', label: '字幕整体透明度（1=不透明）', type: 'number', def: 1, min: 0, max: 1, step: 0.05, col: 6 },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const ass = String(v.ass || '').trim();
      if (!ass) return warnCopy('没有填写 ASS 字幕路径，已退化为直接复制原文件。');
      const parts = [`ass='${Q.filterPath(ass, ctx.platform)}'`];
      const fd = String(v.fontsDir || '').trim();
      if (fd) parts.push(`fontsdir='${Q.filterPath(fd, ctx.platform)}'`);
      const a = num(v.alpha, 1);
      if (a < 1) parts.push(`alpha=${a}`);
      return {
        args: [...H.vf([parts.join(':')]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: ['ass 滤镜会按样式里的字号和分辨率自适应，比 subtitles 更适合复杂排版。']
      };
    }
  });

  defOp({
    id: 'sub-burn-embedded',
    cat: 'subtitle',
    name: '烧录视频里的字幕轨',
    desc: 'MKV/MP4 里已经带字幕轨时，直接把那条轨烧进画面，不用另外准备字幕文件。',
    tags: ['内嵌字幕', '字幕轨', '烧录', 'mkv', 'stream_index'],
    outExt: 'mp4',
    fields: [
      { k: 'index', label: '字幕轨序号（从 0 开始）', type: 'number', def: 0, min: 0, max: 30, col: 4,
        hint: '不确定序号时先用「提取字幕轨」或媒体信息查看。' },
      ...encFields(), ...audFields(), EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = `subtitles='${Q.filterPath(ctx.input, ctx.platform)}':stream_index=${int(v.index, 0, 0)}`;
      return {
        args: [...H.vf([f]), ...encArgs(v), ...audArgs(v), ...H.parseExtra(v.extra)],
        notes: [
          'subtitles 滤镜会重新读取当前输入文件，按 stream_index 取字幕轨烧进画面。',
          '输出只保留烧好的画面 + 原音频，原来那条字幕轨不会再出现在新文件里。'
        ]
      };
    }
  });

  defOp({
    id: 'sub-mux-soft',
    cat: 'subtitle',
    name: '封装软字幕轨（可开关）',
    desc: '把外部 .srt 作为一条字幕轨塞进视频，播放器里可以随时开关，视频本身不重编码。',
    tags: ['软字幕', '封装', 'mkv', 'mov_text', '字幕轨'],
    outExt: (v) => (v.container === 'mkv' ? 'mkv' : 'mp4'),
    fields: [
      { k: 'sub', label: '字幕文件路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\中字.srt' },
      { k: 'container', label: '输出封装格式', type: 'select', def: 'mp4', col: 4, options: [
        { v: 'mp4', label: 'MP4（字幕转 mov_text，兼容性最好）' },
        { v: 'mkv', label: 'MKV（字幕原样保留，样式更好）' }
      ] },
      { k: 'lang', label: '字幕语言标记', type: 'text', def: 'chi', col: 4, placeholder: 'chi / eng / jpn' },
      { k: 'title', label: '字幕轨名称（可留空）', type: 'text', def: '简体中文', col: 4 },
      { k: 'default', label: '设为默认字幕轨', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const sub = String(v.sub || '').trim();
      if (!sub) return warnCopy('没有填写字幕文件路径，已退化为直接复制原文件。');
      const mkv = v.container === 'mkv';
      const args = ['-map', '0', '-map', '1:0', '-c', 'copy', '-c:s', mkv ? 'copy' : 'mov_text'];
      args.push('-metadata:s:s:0', 'language=' + (v.lang || 'chi'));
      if (String(v.title || '').trim()) args.push('-metadata:s:s:0', 'title=' + String(v.title).trim());
      if (v.default) args.push('-disposition:s:0', 'default');
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, sub],
        args,
        notes: [
          '视频和音频都是 -c copy，速度极快、画质无损；只有字幕这一条轨做了转换。',
          mkv ? 'MKV 支持原样复制 SRT/ASS，样式和字号都能保留。' : 'MP4 只支持 mov_text，ASS 特效会全部丢失，只保留文字和时间。',
          '如果原视频里本来就有字幕轨，-map 0 会把它们一起带出来，需要的话请改用「移除全部字幕轨」。'
        ]
      };
    }
  });

  defOp({
    id: 'sub-extract',
    cat: 'subtitle',
    name: '提取字幕轨为字幕文件',
    desc: '把视频里的第 N 条字幕轨单独导出成 .srt / .ass / .vtt，方便修改或另作他用。',
    tags: ['提取', '导出', '字幕轨', 'srt', 'ass'],
    outExt: (v) => v.format || 'srt',
    fields: [
      { k: 'index', label: '字幕轨序号（从 0 开始）', type: 'number', def: 0, min: 0, max: 30, col: 4 },
      { k: 'format', label: '导出格式', type: 'select', def: 'srt', col: 4, options: [
        { v: 'srt', label: 'SRT（纯文本，最通用）' },
        { v: 'ass', label: 'ASS（保留样式）' },
        { v: 'vtt', label: 'WebVTT（网页用）' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const fmt = v.format || 'srt';
      const codec = fmt === 'ass' ? 'ass' : fmt === 'vtt' ? 'webvtt' : 'srt';
      const out = U.join(ctx.outputDir, U.stem(ctx.input) + '.' + fmt, ctx.platform);
      return {
        inputs: [ctx.input],
        args: ['-map', `0:s:${int(v.index, 0, 0)}`, '-c:s', codec, '-vn', '-an', ...H.parseExtra(v.extra)],
        output: out,
        notes: [
          '序号从 0 开始；如果提示找不到流，说明这个文件没有第 ' + int(v.index, 0, 0) + ' 条字幕轨，换个序号再试。',
          '从图形字幕（DVD/PGS）提取出来的是图片式字幕，转成 srt 需要 OCR，本操作不做识别。'
        ]
      };
    }
  });

  defOp({
    id: 'sub-convert',
    cat: 'subtitle',
    name: '字幕格式互转（srt / ass / vtt）',
    desc: '在不同字幕格式之间转换，顺便可以修掉老字幕的 GBK 编码乱码问题。',
    tags: ['转换', 'srt转ass', 'vtt', '编码', 'gbk'],
    outExt: (v) => v.format || 'ass',
    fields: [
      { k: 'sub', label: '字幕文件路径（留空则用输入文件本身）', type: 'path', def: '', col: 12,
        placeholder: 'C:\\素材\\字幕.srt' },
      { k: 'format', label: '目标格式', type: 'select', def: 'ass', col: 6, options: [
        { v: 'ass', label: 'ASS（可自定义样式）' },
        { v: 'srt', label: 'SRT（通用纯文本）' },
        { v: 'vtt', label: 'WebVTT（网页 <track>）' }
      ] },
      { k: 'charenc', label: '源文件编码（乱码时改这里）', type: 'select', def: '', col: 6, options: [
        { v: '', label: '自动 / UTF-8' },
        { v: 'GBK', label: 'GBK / GB2312' },
        { v: 'BIG5', label: 'BIG5' },
        { v: 'UTF-8', label: '强制 UTF-8' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const src = String(v.sub || '').trim() || ctx.input;
      const fmt = v.format || 'ass';
      const codec = fmt === 'ass' ? 'ass' : fmt === 'vtt' ? 'webvtt' : 'srt';
      const preArgs = v.charenc ? ['-sub_charenc', v.charenc] : [];
      const out = U.join(ctx.outputDir, U.stem(src) + '_' + fmt + '.' + fmt, ctx.platform);
      return {
        inputs: [src],
        preArgs,
        args: ['-c:s', codec, ...H.parseExtra(v.extra)],
        output: out,
        notes: [
          '这个操作只处理字幕文件本身，和输入视频无关；如果流水线里有多个输入视频，同一条命令会重复出现，保留其中一条执行即可。',
          '输出文件用了 _' + fmt + ' 后缀以免覆盖原字幕。'
        ]
      };
    }
  });

  defOp({
    id: 'sub-delay-file',
    cat: 'subtitle',
    name: '字幕整体延迟 / 提前',
    desc: '把字幕文件的时间轴整体后移（正数）或前移（负数）若干秒，修字幕比画面早或晚的问题。',
    tags: ['字幕延迟', '同步', 'itsoffset', '时间轴'],
    outExt: (v) => (String(v.sub || '').toLowerCase().endsWith('.ass') ? 'ass' : 'srt'),
    fields: [
      { k: 'sub', label: '字幕文件路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\字幕.srt' },
      { k: 'offset', label: '偏移秒数（正数=字幕延后出现）', type: 'number', def: 2, min: -600, max: 600, step: 0.1, col: 6,
        hint: '字幕比画面早了 2 秒，就填 2；字幕比画面晚了 1.5 秒，就填 -1.5。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const sub = String(v.sub || '').trim();
      if (!sub) return warnCopy('没有填写字幕文件路径，已退化为直接复制原文件。');
      const off = num(v.offset, 2);
      const fmt = U.ext(sub).replace('.', '') || 'srt';
      const out = U.join(ctx.outputDir, U.stem(sub) + '_delay.' + fmt, ctx.platform);
      return {
        inputs: [{ path: sub, args: ['-itsoffset', String(off)] }],
        args: ['-c', 'copy', ...H.parseExtra(v.extra)],
        output: out,
        warnings: off < 0 ? ['负偏移会让开头的字幕落到 0 秒之前，那部分字幕可能被丢弃，请确认开头没有重要内容。'] : [],
        notes: ['用 -itsoffset 改输入时间戳，字幕文件本身不会被重新编码，速度极快。']
      };
    }
  });

  defOp({
    id: 'sub-sync-mux',
    cat: 'subtitle',
    name: '字幕平移后封装进视频（修同步）',
    desc: '字幕和画面整体差了几秒时，一边平移字幕时间轴一边封装成软字幕，视频不用重编码。',
    tags: ['同步', '偏移', '封装', '软字幕', '对轴'],
    outExt: (v) => (v.container === 'mkv' ? 'mkv' : 'mp4'),
    fields: [
      { k: 'sub', label: '字幕文件路径', type: 'path', def: '', col: 12, placeholder: 'C:\\素材\\字幕.srt' },
      { k: 'offset', label: '偏移秒数（正数=字幕延后）', type: 'number', def: 0, min: -600, max: 600, step: 0.1, col: 4 },
      { k: 'container', label: '输出封装格式', type: 'select', def: 'mp4', col: 4, options: [
        { v: 'mp4', label: 'MP4（mov_text）' },
        { v: 'mkv', label: 'MKV（原样保留）' }
      ] },
      { k: 'lang', label: '语言标记', type: 'text', def: 'chi', col: 4 },
      { k: 'default', label: '设为默认字幕轨', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const sub = String(v.sub || '').trim();
      if (!sub) return warnCopy('没有填写字幕文件路径，已退化为直接复制原文件。');
      const off = num(v.offset, 0);
      const mkv = v.container === 'mkv';
      const args = [
        '-map', '1:v', '-map', '1:a?', '-map', '0:0',
        '-c:v', 'copy', '-c:a', 'copy', '-c:s', mkv ? 'copy' : 'mov_text',
        '-metadata:s:s:0', 'language=' + (v.lang || 'chi')
      ];
      if (v.default) args.push('-disposition:s:0', 'default');
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [{ path: sub, args: ['-itsoffset', String(off)] }, ctx.input],
        args,
        notes: [
          '这里字幕是第 0 个输入、视频是第 1 个输入，所以视频流写成 1:v、字幕流写成 0:0。',
          '视频和音频都是 copy，不重新编码，几十秒就能完成长片。'
        ]
      };
    }
  });

  defOp({
    id: 'sub-bilingual',
    cat: 'subtitle',
    name: '双语字幕轨（两条）',
    desc: '把中文和外语两个字幕文件都封装进视频，播放器里可以自由切换。',
    tags: ['双语', '双字幕', '多轨', '封装', '语言'],
    outExt: (v) => (v.container === 'mkv' ? 'mkv' : 'mp4'),
    fields: [
      { k: 'sub1', label: '第一条字幕（默认轨）', type: 'path', def: '', col: 6, placeholder: '中文字幕.srt' },
      { k: 'sub2', label: '第二条字幕', type: 'path', def: '', col: 6, placeholder: 'English.srt' },
      { k: 'lang1', label: '第一条语言标记', type: 'text', def: 'chi', col: 3 },
      { k: 'lang2', label: '第二条语言标记', type: 'text', def: 'eng', col: 3 },
      { k: 'container', label: '输出格式', type: 'select', def: 'mp4', col: 3, options: [
        { v: 'mp4', label: 'MP4（mov_text）' },
        { v: 'mkv', label: 'MKV（原样保留）' }
      ] },
      { k: 'default', label: '第一条设为默认轨', type: 'bool', def: true, col: 3 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const a = String(v.sub1 || '').trim(), b = String(v.sub2 || '').trim();
      if (!a || !b) return warnCopy('需要同时填写两条字幕文件路径，已退化为直接复制原文件。');
      const mkv = v.container === 'mkv';
      const args = [
        '-map', '0', '-map', '1:0', '-map', '2:0',
        '-c', 'copy', '-c:s', mkv ? 'copy' : 'mov_text',
        '-metadata:s:s:0', 'language=' + (v.lang1 || 'chi'),
        '-metadata:s:s:1', 'language=' + (v.lang2 || 'eng')
      ];
      if (v.default) args.push('-disposition:s:0', 'default');
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, a, b],
        args,
        notes: ['两条字幕轨的语言标记（chi / eng 等）能让播放器正确显示语言名，字幕菜单里就能切换。']
      };
    }
  });

  defOp({
    id: 'sub-strip',
    cat: 'subtitle',
    name: '移除全部字幕轨',
    desc: '把视频里已有的字幕轨全部丢掉（含内嵌软字幕），画面和声音原样保留。',
    tags: ['删除字幕', '移除', '字幕轨', '清理'],
    outExt: 'mp4',
    fields: [
      { k: 'keepMeta', label: '同时保留章节与附件', type: 'bool', def: true, col: 6,
        hint: '不勾选只保留默认的流，章节信息会丢。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = v.keepMeta
        ? ['-map', '0', '-map', '-0:s', '-c', 'copy']
        : ['-map', '0:v', '-map', '0:a?', '-c', 'copy'];
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-map -0:s 表示「从已选的流里去掉所有字幕流」，是 ffmpeg 的负向映射写法，不重编码。',
          '已经被烧进画面的硬字幕属于图像内容，无法用这个操作去掉。']
      };
    }
  });

  defOp({
    id: 'sub-attach-font',
    cat: 'subtitle',
    name: '给 MKV 附加字体文件',
    desc: '把 .ttf/.otf 字体塞进 MKV，别的电脑播放 ASS 特效字幕时就不会因为缺字体而串行。',
    tags: ['字体', 'attach', 'mkv', 'ass', '特效字幕'],
    outExt: 'mkv',
    fields: [
      { k: 'font', label: '字体文件路径（.ttf / .otf）', type: 'path', def: '', col: 8, placeholder: 'C:\\素材\\字体.ttf' },
      { k: 'mime', label: '字体类型', type: 'select', def: 'application/x-truetype-font', col: 4, options: [
        { v: 'application/x-truetype-font', label: 'TrueType（.ttf）' },
        { v: 'application/vnd.ms-opentype', label: 'OpenType（.otf）' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const font = String(v.font || '').trim();
      if (!font) return warnCopy('没有填写字体文件路径，已退化为直接复制原文件（封装格式改为 MKV）。');
      return {
        args: [
          '-map', '0', '-c', 'copy',
          '-attach', font,
          '-metadata:s:t:0', 'mimetype=' + (v.mime || 'application/x-truetype-font'),
          ...H.parseExtra(v.extra)
        ],
        notes: ['附件是 MKV 独有的能力，所以输出固定为 .mkv，不会重新编码任何流。',
          '播放器（PotPlayer、mpv、VLC）会优先使用内嵌字体来渲染 ASS 字幕。']
      };
    }
  });

})();
