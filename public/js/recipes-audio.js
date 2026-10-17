/**
 * recipes-audio.js —— 配方库：音频处理
 * 依赖 engine.js 暴露的全局函数 defCat / defOp 与 FFHELP / FFQ / FFU
 *
 * 覆盖范围：音量 / 淡化 / 静音区间、音轨的删除替换与混合、声道与采样率、
 *           延迟、降噪、动态压缩与响度标准化、滤波与均衡、变速变调、
 *           音轨提取与格式转换、拼接裁剪、音量分析
 */
(function () {
  'use strict';
  const H = FFHELP, Q = FFQ, U = FFU;

  /* ================================================================
   * 分类
   * ================================================================ */

  defCat({
    id: 'audio',
    name: '音频处理',
    icon: '🔊',
    color: '#f59e0b',
    desc: '音量、淡化、混音、声道、采样率、替换/混合音轨、降噪'
  });

  /* ================================================================
   * 公共选项表
   * ================================================================ */

  /** 通用音频编码器（输出格式由本操作自己决定时使用） */
  const ACODEC_ALL = [
    { v: 'aac', label: 'aac（通用，推荐）' },
    { v: 'libmp3lame', label: 'mp3（libmp3lame）' },
    { v: 'libopus', label: 'opus（libopus）' },
    { v: 'libvorbis', label: 'vorbis（ogg）' },
    { v: 'ac3', label: 'ac3（DVD / 电视）' },
    { v: 'flac', label: 'flac（无损压缩）' },
    { v: 'pcm_s16le', label: 'pcm_s16le（WAV 未压缩）' }
  ];

  /** 输出容器固定为 mp4 / m4a 时安全的编码器（mp4 里放 pcm、flac 容易出兼容问题） */
  const ACODEC_MP4 = [
    { v: 'aac', label: 'aac（通用，推荐）' },
    { v: 'libmp3lame', label: 'mp3（兼容老设备）' },
    { v: 'ac3', label: 'ac3（DVD / 电视）' }
  ];

  const ABITRATES = ['96k', '128k', '160k', '192k', '256k', '320k', '512k'].map((x) => ({ v: x, label: x }));

  const ACURVES = ['tri', 'qsin', 'hsin', 'esin', 'exp', 'log', 'par', 'qua', 'cub', 'squ', 'cbr']
    .map((x) => ({ v: x, label: x }));

  /** 采样率下拉（转码 / 提取时用，含「保持原样」） */
  const ARATE_KEEP = [
    { v: 'keep', label: '保持原采样率' },
    { v: '44100', label: '44100 Hz（CD 标准）' },
    { v: '48000', label: '48000 Hz（视频标准）' },
    { v: '22050', label: '22050 Hz（体积小）' },
    { v: '16000', label: '16000 Hz（语音）' },
    { v: '8000', label: '8000 Hz（电话）' }
  ];

  /** 声道下拉（含「保持原样」） */
  const ACH_KEEP = [
    { v: 'keep', label: '保持原声道数' },
    { v: '1', label: '1 声道（单声道）' },
    { v: '2', label: '2 声道（立体声）' },
    { v: '6', label: '6 声道（5.1）' }
  ];

  const EXTRA_FIELD = { k: 'extra', label: '附加参数（高级）', type: 'text', def: '', col: 12, placeholder: '如 -movflags +faststart -threads 4', hint: '空格分隔；含空格的参数请用双引号包起来。将追加在输出文件之前。' };

  /* ================================================================
   * 公共字段 / 参数片段
   * ================================================================ */

  /**
   * 音频编码字段组
   * @param {string} prefix 字段前缀
   * @param {object} opt  { copy: 是否允许 copy, none: 是否允许「不要音频」, list: 编码器表, def: 默认编码, label: 标签前缀, hint: 提示 }
   */
  function aencFields(prefix, opt) {
    const o = opt || {};
    const p = prefix || '';
    const list = (o.list || ACODEC_ALL).slice();
    if (o.copy) list.push({ v: 'copy', label: 'copy（不重编码，仅在不加音频滤镜时可用）' });
    if (o.none) list.push({ v: 'none', label: '不要音频流' });
    return [
      { k: p + 'acodec', label: (o.label || '') + '音频编码', type: 'select', def: o.def || 'aac', col: 6, options: list, hint: o.hint },
      { k: p + 'abitrate', label: (o.label || '') + '音频码率', type: 'select', def: '192k', col: 6, options: ABITRATES,
        showIf: (v) => !['copy', 'none', 'flac', 'pcm_s16le'].includes(v[p + 'acodec']) }
    ];
  }

  /** 音频编码参数（复用引擎的通用块） */
  function aencArgs(v, prefix) {
    const p = prefix || '';
    return H.audioArgs(v[p + 'acodec'], v[p + 'abitrate']);
  }

  /**
   * 视频流处理字段组：音频操作默认把画面原样带过去
   * @param {object} opt { none: 是否提供「不要画面」, def: 默认值, hint: 自定义提示 }
   */
  function vstreamFields(prefix, opt) {
    const o = opt || {};
    const p = prefix || '';
    const list = [{ v: 'copy', label: '原样保留（-c:v copy，最快，推荐）' }];
    if (o.none !== false) list.push({ v: 'none', label: '不要画面（只输出音频）' });
    list.push({ v: 'reencode', label: '重新编码（H.264，兼容性更好）' });
    return [
      { k: p + 'vkeep', label: (o.label || '') + '视频画面', type: 'select', def: o.def || 'copy', col: 6, options: list,
        hint: o.hint === undefined ? '输入是视频文件时才有意义；纯音频文件请选「不要画面」。' : o.hint },
      { k: p + 'vcrf', label: '视频重编码质量 CRF（越小越清晰，18~28）', type: 'number', def: 23, min: 0, max: 51, col: 6,
        showIf: (v) => v[p + 'vkeep'] === 'reencode' }
    ];
  }

  /** 视频流参数 */
  function vstreamArgs(v, prefix) {
    const p = prefix || '';
    const k = v[p + 'vkeep'] || 'copy';
    if (k === 'none') return ['-vn'];
    if (k === 'reencode') {
      return ['-c:v', 'libx264', '-crf', String(num(v[p + 'vcrf'], 23)), '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    }
    return ['-c:v', 'copy'];
  }

  /** 需要保留画面时显式映射视频流（带 ? 表示没有视频也不报错） */
  function videoMapArgs(v, prefix) {
    const p = prefix || '';
    return String(v[p + 'vkeep'] || 'copy') === 'none' ? [] : ['-map', '0:v?'];
  }

  /** 输出扩展名：保留画面时是 mp4，丢画面时用音频扩展名 */
  function outExtByVideo(v, audioExt) {
    return String(v.vkeep || 'copy') === 'none' ? (audioExt || 'm4a') : 'mp4';
  }

  /** 数值兜底 */
  function num(x, d) {
    const n = Number(x);
    return isFinite(n) ? n : (d == null ? 0 : d);
  }

  /** 给一组字段统一再套一层显示条件（与原 showIf 取「与」） */
  function withShowIf(fields, fn) {
    return fields.map((f) => {
      const prev = f.showIf;
      return Object.assign({}, f, { showIf: prev ? (v) => fn(v) && prev(v) : fn });
    });
  }

  /**
   * atempo 链：单级 atempo 只支持 0.5~2.0，超出范围自动串联多级
   * 例：6 倍 -> atempo=2.0,atempo=2.0,atempo=1.5
   */
  function atempoChain(speed) {
    const out = [];
    let s = Number(speed);
    if (!isFinite(s) || s <= 0) return ['1.0'];
    while (s > 2.0) { out.push('2.0'); s /= 2.0; }
    while (s < 0.5) { out.push('0.5'); s /= 0.5; }
    out.push(s.toFixed(6));
    return out;
  }

  /** atempo 滤镜串 */
  function atempoFilter(speed) {
    return 'atempo=' + atempoChain(speed).join(',atempo=');
  }

  /** 解析「开始-结束」区间文本，返回 [[秒, 秒], ...] */
  function parseRanges(text) {
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const ln of lines) {
      const m = ln.split(/\s*[-~到至]\s*/);
      if (m.length >= 2) {
        const a = U.toSec(m[0]), b = U.toSec(m[1]);
        if (a != null && b != null && b > a) out.push([a, b]);
      }
    }
    return out;
  }

  /** 音频格式 -> 推荐编码器 */
  const CODEC_BY_EXT = {
    mp3: 'libmp3lame', wav: 'pcm_s16le', m4a: 'aac', aac: 'aac',
    flac: 'flac', opus: 'libopus', ogg: 'libvorbis', wma: 'wmav2'
  };

  const AEXT_OPTIONS = [
    { v: 'mp3', label: 'mp3（最通用）' },
    { v: 'm4a', label: 'm4a / aac（苹果与网页）' },
    { v: 'wav', label: 'wav（未压缩，体积大）' },
    { v: 'flac', label: 'flac（无损压缩）' },
    { v: 'opus', label: 'opus（体积最小）' },
    { v: 'ogg', label: 'ogg vorbis' },
    { v: 'aac', label: 'aac（裸流 .aac）' },
    { v: 'wma', label: 'wma（老 Windows）' }
  ];

  /* ================================================================
   * 一、音量 · 淡化 · 静音区间
   * ================================================================ */

  defOp({
    id: 'audio-volume',
    cat: 'audio',
    name: '音量调整（倍数 / 分贝）',
    desc: '整体放大或减小音量，支持 2 倍、0.5 倍、+3dB、-6dB 等写法，画面原样保留。',
    tags: ['音量', 'volume', '分贝', 'db', '放大'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'mode', label: '调整方式', type: 'select', def: 'factor', col: 4, options: [
        { v: 'factor', label: '按倍数（2 = 两倍响）' },
        { v: 'db', label: '按分贝（+6dB / -6dB）' }
      ] },
      { k: 'factor', label: '音量倍数', type: 'number', def: 2, min: 0, max: 100, step: 0.1, col: 4,
        showIf: (v) => v.mode === 'factor', hint: '1 = 原样，0.5 = 一半，0 = 完全静音。' },
      { k: 'db', label: '音量变化（dB）', type: 'number', def: -6, min: -60, max: 60, step: 0.5, col: 4,
        showIf: (v) => v.mode === 'db', hint: '-6dB 约等于一半响度，+6dB 约等于两倍。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const warnings = [];
      let spec;
      if (v.mode === 'db') {
        spec = num(v.db, -6) + 'dB';
      } else {
        spec = String(num(v.factor, 1));
        if (num(v.factor, 1) === 0) warnings.push('倍数为 0 会得到一段完全无声的音频。');
        else if (num(v.factor, 1) > 4) warnings.push('放大超过 4 倍时很容易削波（刺耳的失真），建议改用分贝并配合「动态压缩与响度标准化」。');
      }
      const args = [
        ...H.af(['volume=' + spec]),
        ...vstreamArgs(v),
        ...aencArgs(v),
        ...H.parseExtra(v.extra)
      ];
      return {
        args, warnings,
        notes: [`音量按 ${spec} 处理。`, '只压低某一段（例如背景音乐太吵的片段）请用「静音 / 压低某一段」。']
      };
    }
  });

  defOp({
    id: 'audio-fade',
    cat: 'audio',
    name: '音频淡入淡出',
    desc: '开头渐强、结尾渐弱，避免突然出声或突然断掉；结尾淡出可选「距结尾 N 秒」自动定位。',
    tags: ['淡入', '淡出', 'afade', '渐强', '渐弱'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'fin', label: '启用淡入', type: 'bool', def: true, col: 4 },
      { k: 'finDur', label: '淡入时长（秒）', type: 'number', def: 2, min: 0.1, step: 0.1, col: 4, showIf: (v) => v.fin },
      { k: 'finCurve', label: '淡入曲线', type: 'select', def: 'tri', col: 4, options: ACURVES, showIf: (v) => v.fin },
      { k: 'fout', label: '启用淡出', type: 'bool', def: true, col: 4 },
      { k: 'foutMode', label: '淡出定位方式', type: 'select', def: 'abs', col: 4, showIf: (v) => v.fout, options: [
        { v: 'abs', label: '指定开始时间（推荐）' },
        { v: 'tail', label: '距结尾 N 秒（倒放实现，占内存）' }
      ] },
      { k: 'foutAt', label: '淡出开始时间', type: 'time', def: '00:01:00', col: 4, showIf: (v) => v.fout && v.foutMode === 'abs',
        hint: '填「总时长 - 淡出时长」，例如 1 分 3 秒的视频淡出 3 秒就填 00:01:00。' },
      { k: 'foutDur', label: '淡出时长（秒）', type: 'number', def: 3, min: 0.1, step: 0.1, col: 4, showIf: (v) => v.fout },
      { k: 'foutCurve', label: '淡出曲线', type: 'select', def: 'tri', col: 4, options: ACURVES, showIf: (v) => v.fout },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const af = [];
      const notes = [];
      if (v.fin) af.push(`afade=t=in:st=0:d=${num(v.finDur, 2)}:curve=${v.finCurve || 'tri'}`);
      if (v.fout) {
        const d = num(v.foutDur, 3);
        const curve = v.foutCurve || 'tri';
        if (v.foutMode === 'tail') {
          // 不知总时长时，用「倒放 -> 淡入 -> 再倒放」实现结尾淡出
          af.push('areverse', `afade=t=in:st=0:d=${d}:curve=${curve}`, 'areverse');
          notes.push('结尾淡出采用 areverse（倒放）实现，需要把整段音频读进内存，长音频会明显变慢。');
        } else {
          const st = num(U.toSec(v.foutAt), 0);
          af.push(`afade=t=out:st=${st}:d=${d}:curve=${curve}`);
        }
      }
      if (!af.length) {
        return { args: [...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)], warnings: ['淡入与淡出都没有启用，将只是把音视频重新封装一遍。'] };
      }
      const args = [...H.af(af), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      notes.push('淡入淡出只作用于音频；如需画面一起渐变，请改用视频淡化（fade 滤镜）。');
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-mute-range',
    cat: 'audio',
    name: '静音 / 压低某一段',
    desc: '把指定时间段的声音抹掉或压低（去掉那段杂音、脏话、背景音乐），其余部分不动。',
    tags: ['静音', 'mute', '区间', '压低', '消音'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'ranges', label: '区间（每行一个，格式 开始-结束）', type: 'textarea', def: '00:00:10-00:00:20', col: 12,
        placeholder: '00:00:10-00:00:20\n00:01:05-00:01:12',
        hint: '时间可写 00:01:30 或 90（秒）。至少填 1 行。' },
      { k: 'mode', label: '处理方式', type: 'select', def: 'mute', col: 4, options: [
        { v: 'mute', label: '这些区间完全静音' },
        { v: 'lower', label: '这些区间压低音量' },
        { v: 'keep', label: '只保留这些区间，其余静音' }
      ] },
      { k: 'level', label: '压低到多少倍', type: 'number', def: 0.2, min: 0, max: 1, step: 0.05, col: 4,
        showIf: (v) => v.mode === 'lower', hint: '0.2 表示只留 20% 音量，用于「压住但还能听见」。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const rs = parseRanges(v.ranges);
      if (!rs.length) {
        return {
          args: [...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)],
          warnings: ['没有解析到有效区间（需要「开始-结束」且结束大于开始），本次不做任何音频处理。']
        };
      }
      const parts = [];
      if (v.mode === 'keep') {
        // 多个区间取并集：not(b1+b2+...) 为真时（区间之外）静音
        const expr = rs.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+');
        parts.push(`volume=enable='not(${expr})':volume=0`);
      } else {
        const vol = v.mode === 'lower' ? String(num(v.level, 0.2)) : '0';
        rs.forEach(([a, b]) => {
          parts.push(`volume=enable='between(t,${a.toFixed(3)},${b.toFixed(3)})':volume=${vol}`);
        });
      }
      const total = rs.reduce((s, r) => s + (r[1] - r[0]), 0);
      const args = [...H.af(parts), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      return {
        args,
        notes: [`共处理 ${rs.length} 个区间，合计 ${U.humanDur(total)}。`, '滤镜按时间轴逐帧判断，画面保持原样不动。']
      };
    }
  });

  /* ================================================================
   * 二、音轨的删除 · 替换 · 混合
   * ================================================================ */

  defOp({
    id: 'audio-remove',
    cat: 'audio',
    name: '移除音频（-an）',
    desc: '丢掉音轨只留画面，体积更小，适合监控录像与需要静音上传的素材。',
    tags: ['去音频', '无声', '-an', '静音视频'],
    outExt: 'mp4',
    fields: [
      ...vstreamFields('', { none: false, hint: '这里只能选择画面的处理方式，音频会被整条丢弃。' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      return {
        args: [...vstreamArgs(v), '-an', ...H.parseExtra(v.extra)],
        notes: ['输出文件将完全不包含音频流；配合 -c:v copy 时几乎瞬间完成。']
      };
    }
  });

  defOp({
    id: 'audio-replace-track',
    cat: 'audio',
    name: '用外部音频替换原音轨',
    desc: '把视频自带的声音整条换成你准备的音乐或配音（换 BGM、替换录错的解说）。',
    tags: ['替换音轨', '配音', '换背景音乐', 'map', 'mux'],
    outExt: 'mp4',
    fields: [
      { k: 'audioPath', label: '外部音频文件路径', type: 'path', def: '', col: 12,
        placeholder: 'C:\\音乐\\bgm.mp3', hint: '支持 mp3 / wav / m4a / aac / flac / opus 等。留空则退化为原样复制。' },
      { k: 'shortest', label: '以较短的流为准结束（-shortest）', type: 'bool', def: true, col: 6,
        hint: '外部音频比视频长时，开启后视频结束就停止；关闭则按最长的一方输出。' },
      ...aencFields('', { list: ACODEC_MP4, label: '新音轨 ', hint: '外部音频会被重新编码成这里的格式。' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      if (!String(v.audioPath || '').trim()) {
        return {
          args: ['-c', 'copy', ...H.parseExtra(v.extra)],
          warnings: ['没有填写外部音频文件路径，已退化为原样复制（-c copy），相当于什么都没换。请填好路径再生成。']
        };
      }
      const args = [
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy'
      ];
      if (v.shortest) args.push('-shortest');
      args.push(...aencArgs(v), ...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, v.audioPath],
        args,
        notes: [
          '原音轨被整条丢弃，只保留外部音频；画面直接复制不重编码。',
          '若外部音频比画面短，结尾会出现无声段；比画面长时建议保留 -shortest。'
        ]
      };
    }
  });

  defOp({
    id: 'audio-mix-external',
    cat: 'audio',
    name: '外部音频与原音轨混合',
    desc: '把背景音乐叠加在原声上（人声仍在），可调双方权重；也可两路各占一个声道。',
    tags: ['混音', 'amix', 'amerge', '叠加', '背景音乐'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'musicPath', label: '外部音频文件路径', type: 'path', def: '', col: 12,
        placeholder: 'C:\\音乐\\bgm.mp3', hint: '留空则退化为原样复制（并给出提示）。' },
      { k: 'mode', label: '混合方式', type: 'select', def: 'amix', col: 6, options: [
        { v: 'amix', label: '叠加混合（两边同时出声，推荐配乐）' },
        { v: 'amerge', label: '左右分开（原声走左耳，外部走右耳）' }
      ] },
      { k: 'loopBgm', label: '循环外部音频直到结束', type: 'bool', def: true, col: 6,
        hint: '开启后会给外部音频加 -stream_loop -1，并自动以画面长度为结束点。' },
      { k: 'w0', label: '原音轨权重', type: 'number', def: 1, min: 0, max: 8, step: 0.05, col: 3 },
      { k: 'w1', label: '外部音频权重', type: 'number', def: 0.3, min: 0, max: 8, step: 0.05, col: 3,
        hint: '背景音乐一般 0.15~0.35，人声才不会糊。' },
      { k: 'dur', label: 'amix 时长策略', type: 'select', def: 'longest', col: 3, showIf: (v) => v.mode === 'amix', options: [
        { v: 'longest', label: '以最长的为准' },
        { v: 'shortest', label: '以最短的为准' },
        { v: 'first', label: '以原音轨为准（推荐）' }
      ] },
      { k: 'normalize', label: 'amix 自动归一化', type: 'bool', def: false, col: 3,
        showIf: (v) => v.mode === 'amix', hint: '关闭时按权重直接相加，可能削波；开启时 ffmpeg 会自动压低总音量。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      if (!String(v.musicPath || '').trim()) {
        return {
          args: [...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)],
          warnings: ['没有填写外部音频文件路径，已退化为原样复制。请填好路径再生成。']
        };
      }
      const w0 = String(num(v.w0, 1));
      const w1 = String(num(v.w1, 0.3));
      const inp2 = { path: v.musicPath, args: v.loopBgm ? ['-stream_loop', '-1'] : [] };
      let fc;
      if (v.mode === 'amerge') {        // 两路各自转单声道再合并，得到「左=原声、右=外部音频」
        fc = `[0:a]volume=${w0},aresample=48000,aformat=channel_layouts=mono[a0];` +
          `[1:a]volume=${w1},aresample=48000,aformat=channel_layouts=mono[a1];` +
          `[a0][a1]amerge=inputs=2[aout]`;
      } else {
        fc = `[0:a]volume=${w0},aresample=48000[a0];` +
          `[1:a]volume=${w1},aresample=48000[a1];` +
          `[a0][a1]amix=inputs=2:duration=${v.dur || 'longest'}:dropout_transition=0:normalize=${v.normalize ? 1 : 0}[aout]`;
      }
      const args = ['-filter_complex', fc, ...videoMapArgs(v), '-map', '[aout]'];
      if (v.loopBgm) args.push('-shortest');
      args.push(...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra));
      const notes = ['两路都统一重采样到 48000Hz，避免采样率不一致导致的变速或报错。'];
      if (v.mode === 'amerge') notes.push('amerge 输出为双声道：左声道是原音轨，右声道是外部音频（适合做左右对比）。');
      if (v.loopBgm && v.mode === 'amix') notes.push('外部音频被循环播放，输出长度由画面（或 -shortest）决定。');
      return { inputs: [ctx.input, inp2], args, notes };
    }
  });

  defOp({
    id: 'audio-silent-track',
    cat: 'audio',
    name: '生成静音音轨',
    desc: '用 lavfi 造一条空白音轨，可替换原音轨，也可作为第二条音轨保留原声。',
    tags: ['静音', '空音轨', 'anullsrc', 'lavfi', '无声'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '使用方式', type: 'select', def: 'replace', col: 6, options: [
        { v: 'replace', label: '替换原音轨（只要画面 + 静音）' },
        { v: 'add', label: '作为附加音轨（原音轨保留）' }
      ] },
      { k: 'ch', label: '静音音轨声道', type: 'select', def: 'stereo', col: 3, options: [
        { v: 'mono', label: '单声道' }, { v: 'stereo', label: '立体声' }, { v: '5.1', label: '5.1' }
      ] },
      { k: 'rate', label: '采样率', type: 'select', def: '48000', col: 3, options: [
        { v: '44100', label: '44100 Hz' }, { v: '48000', label: '48000 Hz' }
      ] },
      { k: 'dur', label: '静音时长（留空 = 跟随画面）', type: 'time', def: '', col: 6,
        hint: '通常留空即可：配合 -shortest 会自动与视频同长。纯音频输入时请填写时长。' },
      { k: 'shortest', label: '自动与画面同长（-shortest）', type: 'bool', def: true, col: 6 },
      ...aencFields('', { list: ACODEC_MP4, label: '静音音轨 ' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const cl = v.ch === 'mono' ? 'mono' : v.ch === '5.1' ? '5.1' : 'stereo';
      const src = `anullsrc=r=${v.rate || 48000}:cl=${cl}`;
      const inputs = [ctx.input, { path: src, args: ['-f', 'lavfi'] }];
      let args;
      if (v.mode === 'add') {
        // 第 0 条音轨原样复制，第 1 条（静音）重新编码
        const codec = v.acodec === 'none' ? 'aac' : v.acodec;
        args = ['-map', '0:v?', '-map', '0:a?', '-map', '1:a:0', '-c:v', 'copy',
          '-c:a:0', 'copy', '-c:a:1', codec, '-b:a', v.abitrate || '192k'];
      } else {
        args = ['-map', '0:v?', '-map', '1:a:0', '-c:v', 'copy', ...aencArgs(v)];
      }
      if (v.dur) args.push('-t', H.timeArg(v.dur));
      else if (v.shortest) args.push('-shortest');
      args.push(...H.parseExtra(v.extra));
      const notes = ['静音音轨由 -f lavfi 的 anullsrc 现场生成，不占用磁盘。'];
      if (!v.dur && !v.shortest) notes.push('既没有填时长也没有开启 -shortest，静音是无限长的，输出会一直跑下去，请务必二选一。');
      return { args, inputs, notes };
    }
  });

  defOp({
    id: 'audio-bgm-mix',
    cat: 'audio',
    name: '给视频配背景音乐（自动压低原声）',
    desc: '加入外部音乐、压低背景音量、音乐淡入并可结尾淡出，一步完成常见的「配乐」需求。',
    tags: ['背景音乐', 'BGM', '配乐', '混音', '淡入淡出'],
    outExt: 'mp4',
    fields: [
      { k: 'musicPath', label: '背景音乐文件路径', type: 'path', def: '', col: 12,
        placeholder: 'C:\\音乐\\bgm.mp3', hint: '支持 mp3 / wav / m4a / flac 等。留空会给出提示并退化为原样复制。' },
      { k: 'bgmVol', label: '背景音乐音量', type: 'number', def: 0.25, min: 0, max: 4, step: 0.05, col: 3,
        hint: '0.25 表示压到 25%，人声才听得清。' },
      { k: 'voiceVol', label: '原声（人声）音量', type: 'number', def: 1, min: 0, max: 8, step: 0.05, col: 3 },
      { k: 'fadeIn', label: '音乐淡入时长（秒）', type: 'number', def: 2, min: 0, step: 0.5, col: 3 },
      { k: 'fadeOutDur', label: '音乐淡出时长（秒）', type: 'number', def: 3, min: 0, step: 0.5, col: 3 },
      { k: 'fadeOutAt', label: '淡出开始时间（留空 = 不淡出）', type: 'time', def: '', col: 6,
        hint: '填「视频总时长 - 淡出时长」，如 1 分钟的视频淡出 3 秒就填 00:00:57。' },
      { k: 'loopBgm', label: '音乐循环播放直到视频结束', type: 'bool', def: true, col: 3 },
      { k: 'normalize', label: '混合后自动归一化', type: 'bool', def: false, col: 3,
        hint: '关闭时按上面两个音量直接相加，声音更实但可能削波。' },
      ...aencFields('', { list: ACODEC_MP4, label: '输出 ' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      if (!String(v.musicPath || '').trim()) {
        return {
          args: ['-c:v', 'copy', ...aencArgs(v), ...H.parseExtra(v.extra)],
          warnings: ['没有填写背景音乐路径，已退化为原样复制。请填好路径再生成。']
        };
      }
      const bgm = [`volume=${num(v.bgmVol, 0.25)}`, 'aresample=48000'];
      if (num(v.fadeIn, 2) > 0) bgm.push(`afade=t=in:st=0:d=${num(v.fadeIn, 2)}`);
      const voice = [`volume=${num(v.voiceVol, 1)}`];
      let mix = `[voice][bgm]amix=inputs=2:duration=first:normalize=${v.normalize ? 1 : 0}`;
      if (v.fadeOutAt && num(v.fadeOutDur, 3) > 0) {
        mix += `,afade=t=out:st=${num(U.toSec(v.fadeOutAt), 0)}:d=${num(v.fadeOutDur, 3)}`;
      }
      const fc = `[1:a]${bgm.join(',')}[bgm];[0:a]${voice.join(',')}[voice];${mix}[aout]`;
      const inputs = [ctx.input, { path: v.musicPath, args: v.loopBgm ? ['-stream_loop', '-1'] : [] }];
      const args = ['-filter_complex', fc, '-map', '0:v?', '-map', '[aout]', '-c:v', 'copy'];
      if (v.loopBgm) args.push('-shortest');
      args.push(...aencArgs(v), ...H.parseExtra(v.extra));
      const notes = [
        'amix 使用 duration=first，输出长度以原音轨（也就是视频）为准。',
        '背景音乐会被重采样到 48000Hz 后再混合，避免与视频音轨采样率不一致。'
      ];
      if (v.loopBgm) notes.push('音乐循环播放（-stream_loop -1）并用 -shortest 在画面结束时停止。');
      return { args, inputs, notes };
    }
  });

  /* ================================================================
   * 三、声道 · 采样率 · 声场
   * ================================================================ */

  defOp({
    id: 'audio-channels',
    cat: 'audio',
    name: '声道转换（单声道 / 立体声 / 5.1）',
    desc: '把多声道下混成单声道、把单声道撑成立体声，或者升到 5.1；可选简单下混或自定义矩阵。',
    tags: ['声道', '单声道', '立体声', '5.1', '-ac'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'target', label: '目标声道', type: 'select', def: '2', col: 4, options: [
        { v: '1', label: '单声道 mono（1 声道）' },
        { v: '2', label: '立体声 stereo（2 声道）' },
        { v: '6', label: '5.1 环绕（6 声道）' }
      ] },
      { k: 'method', label: '处理方式', type: 'select', def: 'ac', col: 8, options: [
        { v: 'ac', label: '直接指定声道数（-ac，最简单，推荐）' },
        { v: 'pan', label: '自定义 pan 矩阵（可精确控制每一路的来源）' }
      ] },
      { k: 'panExpr', label: 'pan 滤镜表达式', type: 'text', def: 'pan=mono|c0=0.5*c0+0.5*c1', col: 12,
        showIf: (v) => v.method === 'pan',
        hint: '例如 pan=stereo|c0=c0|c1=c1 保持立体声；pan=mono|c0=0.5*c0+0.5*c1 为左右平均下混。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      const notes = [];
      if (v.method === 'pan') {
        args.push(...H.af([String(v.panExpr || 'pan=mono|c0=0.5*c0+0.5*c1').trim()]));
        notes.push('pan 矩阵中的 c0 / c1 分别代表输入的左、右声道，输入的声道数不够时会报错。');
      } else {
        args.push('-ac', String(num(v.target, 2)));
        notes.push('用 -ac 直接指定输出声道数，ffmpeg 会自动做下混（多声道变少）或复制（单声道变多声道）。');
      }
      args.push(...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra));
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-channel-swap',
    cat: 'audio',
    name: '左右声道互换 / 只留单侧',
    desc: '交换左右声道、只保留某一侧，或把右声道反相（用于排查相位抵消问题）。',
    tags: ['左右声道', '互换', '单侧', 'pan', '相位'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'mode', label: '处理方式', type: 'select', def: 'swap', col: 12, options: [
        { v: 'swap', label: '左右声道互换（pan=stereo|c0=c1|c1=c0）' },
        { v: 'left2both', label: '只保留左声道，输出双声道（左右都是左）' },
        { v: 'right2both', label: '只保留右声道，输出双声道（左右都是右）' },
        { v: 'leftmono', label: '只保留左声道，输出单声道（pan=mono|c0=c0）' },
        { v: 'rightmono', label: '只保留右声道，输出单声道（pan=mono|c0=c1）' },
        { v: 'invert', label: '右声道反相（相位排查用）' }
      ] },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const MAP = {
        swap: 'pan=stereo|c0=c1|c1=c0',
        left2both: 'pan=stereo|c0=c0|c1=c0',
        right2both: 'pan=stereo|c0=c1|c1=c1',
        leftmono: 'pan=mono|c0=c0',
        rightmono: 'pan=mono|c0=c1',
        invert: 'pan=stereo|c0=c0|c1=-1*c1'
      };
      const filter = MAP[v.mode] || MAP.swap;
      const notes = ['pan 滤镜要求输入至少是双声道；单声道素材请先转成立体声再使用。'];
      if (v.mode === 'invert') notes.push('右声道反相后，用单声道设备播放时人声会明显变小——这正是相位抵消的典型表现。');
      const args = [...H.af([filter]), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-resample',
    cat: 'audio',
    name: '音频重采样（改采样率）',
    desc: '统一采样率解决音画不同步、设备不兼容；可选 soxr 高质量重采样。',
    tags: ['采样率', '重采样', 'aresample', 'soxr', '48000'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'rate', label: '目标采样率', type: 'select', def: '48000', col: 4, options: [
        { v: '44100', label: '44100 Hz（CD）' },
        { v: '48000', label: '48000 Hz（视频标准）' },
        { v: '22050', label: '22050 Hz' },
        { v: '16000', label: '16000 Hz（语音）' },
        { v: '8000', label: '8000 Hz（电话）' },
        { v: 'custom', label: '自定义' }
      ] },
      { k: 'custom', label: '自定义采样率（Hz）', type: 'number', def: 32000, min: 1000, max: 384000, col: 4,
        showIf: (v) => v.rate === 'custom' },
      { k: 'hq', label: '使用 soxr 高质量重采样', type: 'bool', def: false, col: 4,
        hint: '音质更好但更费 CPU；需要 ffmpeg 编译时带 libsoxr，否则会报 Unknown resampler。' },
      { k: 'precision', label: 'soxr 精度（20~33）', type: 'number', def: 28, min: 20, max: 33, col: 4, showIf: (v) => v.hq },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const sr = v.rate === 'custom' ? num(v.custom, 32000) : num(v.rate, 48000);
      const args = [];
      const notes = [];
      if (v.hq) {
        args.push('-af', `aresample=resampler=soxr:osr=${sr}:precision=${num(v.precision, 28)}`);
        notes.push('soxr 由 libsoxr 提供，属于「重采样质量最好」的方案，代价是 CPU 占用更高。');
      }
      args.push('-ar', String(sr));
      args.push(...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra));
      notes.push(`输出采样率统一为 ${sr} Hz；视频画面不受影响。`);
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-stereo-width',
    cat: 'audio',
    name: '立体声宽度 / 相位调整',
    desc: '把声场拉宽或收窄（更有包围感或更集中），也可给单侧声道反相。',
    tags: ['立体声宽度', '声场', 'stereotools', 'extrastereo', '相位'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'mode', label: '处理方式', type: 'select', def: 'width', col: 4, options: [
        { v: 'width', label: '调整宽度（stereotools，推荐）' },
        { v: 'extra', label: '外差增强（extrastereo，效果更猛）' },
        { v: 'phase', label: '右声道反相（相位检查）' }
      ] },
      { k: 'slev', label: '侧向（宽度）强度', type: 'number', def: 1.5, min: 0.015625, max: 4, step: 0.05, col: 4,
        showIf: (v) => v.mode === 'width', hint: '1 = 原样，1.5 = 明显变宽，0.3 = 收窄，接近 0 = 近似单声道。' },
      { k: 'em', label: '外差系数（-10 ~ 10）', type: 'number', def: 2.5, min: -10, max: 10, step: 0.1, col: 4,
        showIf: (v) => v.mode === 'extra', hint: 'ffmpeg 默认 2.5；数值越大左右差异越夸张，0 会变成近乎单声道。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      let filter;
      const notes = ['立体声处理要求输入至少是双声道；单声道素材请先转成立体声（声场类操作对单声道无效）。'];
      if (v.mode === 'extra') {
        filter = `extrastereo=m=${num(v.em, 2.5)}`;
      } else if (v.mode === 'phase') {
        filter = 'stereotools=phaser=1';
        notes.push('右声道反相后与左声道在单声道设备上会相互抵消，人声变虚属正常现象。');
      } else {
        filter = `stereotools=mlev=1:slev=${num(v.slev, 1.5)}`;
        notes.push('slev 控制「侧向信号」大小，也就是左右声道的差异量。');
      }
      const args = [...H.af([filter]), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-delay',
    cat: 'audio',
    name: '音频延迟（延后几毫秒 / 几秒）',
    desc: '把声音整体或单侧声道往后推，用于修正「声音比画面早」的问题。',
    tags: ['延迟', 'adelay', '音画同步', '偏移'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'unit', label: '时间单位', type: 'select', def: 'ms', col: 4, options: [
        { v: 'ms', label: '毫秒（ms）' }, { v: 'sec', label: '秒（s）' }
      ] },
      { k: 'ms', label: '延迟毫秒数', type: 'number', def: 1500, min: 0, max: 600000, col: 4, showIf: (v) => v.unit === 'ms' },
      { k: 'sec', label: '延迟秒数', type: 'number', def: 1.5, min: 0, max: 3600, step: 0.1, col: 4, showIf: (v) => v.unit === 'sec' },
      { k: 'channel', label: '作用于', type: 'select', def: 'all', col: 6, options: [
        { v: 'all', label: '所有声道一起延后' },
        { v: 'left', label: '只延后左声道（a|0）' },
        { v: 'right', label: '只延后右声道（0|a）' }
      ] },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const ms = Math.round(v.unit === 'sec' ? num(v.sec, 1.5) * 1000 : num(v.ms, 1500));
      const spec = v.channel === 'left' ? `${ms}|0` : v.channel === 'right' ? `0|${ms}` : `${ms}|${ms}`;
      const args = [...H.af([`adelay=${spec}`]), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      const warnings = [];
      if (ms <= 0) warnings.push('延迟为 0，本次不会有任何变化。');
      if (v.channel !== 'all') warnings.push('只延后单侧声道会明显偏向一边，一般用于修复单只麦克风的相位差。');
      return {
        args, warnings,
        notes: [
          `adeelay 按声道依次给出毫秒数，「${spec}」分别对应第 1、第 2 声道。`,
          '画面保持原样不动：音频被推后，开头会补一段静音，可修正「声音早于画面」的问题。',
          `当前延迟约 ${U.humanDur(ms / 1000)}。`
        ]
      };
    }
  });

  /* ================================================================
   * 四、降噪 · 响度 · 滤波 · 均衡
   * ================================================================ */

  defOp({
    id: 'audio-denoise',
    cat: 'audio',
    name: '音频降噪（去底噪）',
    desc: '削弱持续的背景噪声（风扇、电流、嘶声）；会或多或少让人声发闷，建议先小强度试一版。',
    tags: ['降噪', 'afftdn', 'anlmdn', '底噪', '去噪'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'method', label: '降噪算法', type: 'select', def: 'afftdn', col: 6, options: [
        { v: 'afftdn', label: 'afftdn 频域降噪（快，通用）' },
        { v: 'anlmdn', label: 'anlmdn 非局部均值（音质更好，慢很多）' },
        { v: 'both', label: '两者串联（最强，也最容易伤音质）' }
      ] },
      { k: 'nr', label: '降噪强度（dB）', type: 'number', def: 12, min: 0.01, max: 97, step: 0.5, col: 4,
        showIf: (v) => v.method !== 'anlmdn', hint: '默认 12；调到 20 以上人声会明显发闷。' },
      { k: 'nf', label: '噪声底（dB）', type: 'number', def: -50, min: -80, max: -20, step: 1, col: 4,
        showIf: (v) => v.method !== 'anlmdn', hint: '越接近实际底噪越干净。可用「音量检测与统计」看 mean_volume 估算。' },
      { k: 'tn', label: '自动跟踪噪声（tn=1）', type: 'bool', def: false, col: 4, showIf: (v) => v.method !== 'anlmdn' },
      { k: 'strength', label: 'anlmdn 降噪强度', type: 'number', def: 0.0001, min: 0.00001, max: 1, step: 0.00005, col: 8,
        showIf: (v) => v.method !== 'afftdn', hint: 'ffmpeg 默认 0.00001；数值越大降噪越强，也越容易把人声削掉。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const parts = [];
      if (v.method !== 'anlmdn') {
        parts.push(`afftdn=nr=${num(v.nr, 12)}:nf=${num(v.nf, -50)}${v.tn ? ':tn=1' : ''}`);
      }
      if (v.method !== 'afftdn') {
        parts.push(`anlmdn=s=${num(v.strength, 0.0001)}`);
      }
      const args = [...H.af(parts), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      const notes = [
        '降噪是「估算噪声再减掉」的过程，强度过高会把气息、齿音一起削掉，听起来发闷。',
        '如果只是低频轰鸣或高频嘶声，用「高通 / 低通滤波」更温和有效。'
      ];
      if (v.method === 'anlmdn' || v.method === 'both') notes.push('anlmdn 运算量很大，1 分钟音频可能需要几分钟，请耐心等待。');
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-loudness',
    cat: 'audio',
    name: '动态压缩与响度标准化',
    desc: '把人声压得更平均、整体响度统一到平台标准（如 -16 LUFS），上传到平台音量就不会忽大忽小。',
    tags: ['响度', 'loudnorm', '压缩', 'acompressor', 'LUFS'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'mode', label: '处理模式', type: 'select', def: 'loudnorm', col: 6, options: [
        { v: 'loudnorm', label: '只做响度标准化（loudnorm）' },
        { v: 'compressor', label: '只做动态压缩（acompressor）' },
        { v: 'both', label: '先压缩再标准化（推荐人声）' }
      ] },
      { k: 'I', label: '目标响度 I（LUFS）', type: 'number', def: -16, min: -70, max: -5, step: 0.5, col: 4,
        showIf: (v) => v.mode !== 'compressor', hint: '抖音/B站约 -14 ~ -16，YouTube 约 -14，播客 -16，电视 -23。' },
      { k: 'TP', label: '真峰值上限 TP（dBTP）', type: 'number', def: -1.5, min: -9, max: 0, step: 0.1, col: 4,
        showIf: (v) => v.mode !== 'compressor', hint: '-1.5 是流媒体常用值，留出余量防止转码削波。' },
      { k: 'LRA', label: '响度范围 LRA', type: 'number', def: 11, min: 1, max: 50, step: 0.5, col: 4,
        showIf: (v) => v.mode !== 'compressor', hint: '11 适合大多数内容；数值越小动态被压得越平。' },
      { k: 'outRate', label: '输出采样率', type: 'select', def: '48000', col: 4, showIf: (v) => v.mode !== 'compressor', options: [
        { v: 'keep', label: '不干预（loudnorm 会升到 96kHz）' },
        { v: '44100', label: '44100 Hz' },
        { v: '48000', label: '48000 Hz（推荐）' },
        { v: '96000', label: '96000 Hz' }
      ], hint: 'loudnorm 内部按 192kHz 计算，不加约束时输出采样率会被抬高、体积明显变大，建议固定成 48000。' },
      { k: 'threshold', label: '压缩阈值（dB）', type: 'number', def: -18, min: -60, max: 0, step: 0.5, col: 4,
        showIf: (v) => v.mode !== 'loudnorm', hint: '超过这个音量的部分才开始被压。人声一般 -18 ~ -24。' },
      { k: 'ratio', label: '压缩比', type: 'number', def: 3, min: 1, max: 20, step: 0.5, col: 4, showIf: (v) => v.mode !== 'loudnorm' },
      { k: 'attack', label: '启动时间（ms）', type: 'number', def: 20, min: 0.01, max: 2000, step: 1, col: 4, showIf: (v) => v.mode !== 'loudnorm' },
      { k: 'release', label: '释放时间（ms）', type: 'number', def: 250, min: 0.01, max: 9000, step: 10, col: 4, showIf: (v) => v.mode !== 'loudnorm' },
      { k: 'makeup', label: '补偿增益（dB，0 = 不加）', type: 'number', def: 0, min: 0, max: 30, step: 0.5, col: 4,
        showIf: (v) => v.mode !== 'loudnorm', hint: '压缩后整体变小的话用它补回来。' },
      { k: 'knee', label: '拐点 knee', type: 'number', def: 2.8, min: 1, max: 8, step: 0.1, col: 4, showIf: (v) => v.mode !== 'loudnorm' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const parts = [];
      if (v.mode !== 'loudnorm') {
        parts.push('acompressor=threshold=' + num(v.threshold, -18) + 'dB' +
          ':ratio=' + num(v.ratio, 3) +
          ':attack=' + num(v.attack, 20) +
          ':release=' + num(v.release, 250) +
          ':makeup=' + num(v.makeup, 0) + 'dB' +
          ':knee=' + num(v.knee, 2.8));
      }
      if (v.mode !== 'compressor') {
        parts.push('loudnorm=I=' + num(v.I, -16) + ':TP=' + num(v.TP, -1.5) + ':LRA=' + num(v.LRA, 11));
        // loudnorm 内部工作在 192kHz，不追加 aresample 的话输出采样率会被抬高
        if (v.outRate && v.outRate !== 'keep') parts.push('aresample=' + num(v.outRate, 48000));
      }
      const args = [...H.af(parts), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      const notes = [
        '单遍 loudnorm 是「动态模式」，它会边分析边调整，响度能对上但动态会有波动，音质不如两遍法。',
        '两遍法（先测量、再套用测量值，效果最好）用法：',
        '  第 1 步：ffmpeg -i 输入.mp4 -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -',
        '  在日志里找到 measured_I / measured_TP / measured_LRA / measured_thresh / target_offset 五个值；',
        '  第 2 步：把上面这些值填成 loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=...:measured_TP=...:measured_LRA=...:measured_thresh=...:offset=...:linear=true',
        '也可以用本分类的「音量检测与统计（模式选 loudnorm 分析）」直接拿到这几个测量值。'
      ];
      if (v.mode === 'both') notes.push('acompressor 在前、loudnorm 在后，先压动态再对标准，人声类素材最常用。');
      if (v.mode !== 'compressor' && v.outRate !== 'keep') {
        notes.splice(1, 0, `loudnorm 内部按 192kHz 计算，这里已在它后面追加 aresample 把输出拉回 ${v.outRate} Hz。`);
      }
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-highlowpass',
    cat: 'audio',
    name: '高通 / 低通滤波（去轰鸣与嘶声）',
    desc: '切掉 80Hz 以下的低频轰鸣或 12kHz 以上的高频嘶声，比降噪更温和、更不易伤音质。',
    tags: ['高通', '低通', 'highpass', 'lowpass', '滤波'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'hp', label: '启用高通（削掉低频）', type: 'bool', def: true, col: 6 },
      { k: 'hpF', label: '高通截止频率（Hz）', type: 'number', def: 80, min: 20, max: 2000, col: 6, showIf: (v) => v.hp,
        hint: '人声常用 80~120Hz；空调声、桌面震动、脚步声多在 100Hz 以下。' },
      { k: 'lp', label: '启用低通（削掉高频）', type: 'bool', def: true, col: 6 },
      { k: 'lpF', label: '低通截止频率（Hz）', type: 'number', def: 12000, min: 1000, max: 20000, col: 6, showIf: (v) => v.lp,
        hint: '人声保留 8k~12k 即可；再低会明显发闷，电流嘶声多在 14k 以上。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const parts = [];
      if (v.hp) parts.push(`highpass=f=${num(v.hpF, 80)}:poles=2`);
      if (v.lp) parts.push(`lowpass=f=${num(v.lpF, 12000)}:poles=2`);
      const warnings = [];
      if (!parts.length) warnings.push('高通与低通都没有启用，本次不会有任何变化。');
      if (v.lp && num(v.lpF, 12000) < 6000) warnings.push('低通低于 6kHz 会让人声明显发闷，建议 8kHz 以上。');
      const args = [...H.af(parts), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      return {
        args, warnings,
        notes: ['滤波器每倍频程衰减 12dB（poles=2），对音质影响很小，是做后期清理的第一步。']
      };
    }
  });

  defOp({
    id: 'audio-equalizer',
    cat: 'audio',
    name: '三段均衡器（低频 / 中频 / 高频）',
    desc: '分别提升或衰减低、中、高频：补足低音、突出人声或压掉刺耳的高频。',
    tags: ['均衡器', 'eq', 'equalizer', '音色', '增益'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'lowF', label: '低频中心频率（Hz）', type: 'number', def: 100, min: 20, max: 500, col: 6 },
      { k: 'lowG', label: '低频增益（dB）', type: 'number', def: 0, min: -20, max: 20, step: 0.5, col: 6,
        hint: '正数提升（更浑厚），负数衰减（去轰鸣）。' },
      { k: 'midF', label: '中频中心频率（Hz）', type: 'number', def: 1000, min: 200, max: 5000, col: 6 },
      { k: 'midG', label: '中频增益（dB）', type: 'number', def: 0, min: -20, max: 20, step: 0.5, col: 6,
        hint: '人声清晰度主要在这一段，2~4kHz 稍微提升会更「贴脸」。' },
      { k: 'highF', label: '高频中心频率（Hz）', type: 'number', def: 10000, min: 2000, max: 20000, col: 6 },
      { k: 'highG', label: '高频增益（dB）', type: 'number', def: 0, min: -20, max: 20, step: 0.5, col: 6 },
      { k: 'width', label: '每段带宽（倍频程）', type: 'number', def: 2, min: 0.1, max: 8, step: 0.1, col: 6,
        hint: '2 表示影响中心频率上下各约 1 个倍频程；越小越精准、越大越平缓。' },
      ...vstreamFields(''),
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const w = num(v.width, 2);
      const bands = [
        [num(v.lowF, 100), num(v.lowG, 0)],
        [num(v.midF, 1000), num(v.midG, 0)],
        [num(v.highF, 10000), num(v.highG, 0)]
      ].filter((b) => b[1] !== 0);
      const parts = bands.map(([f, g]) => `equalizer=f=${f}:width_type=o:width=${w}:g=${g}`);
      const warnings = [];
      if (!parts.length) warnings.push('三段增益都是 0dB，本次不会改变音色。请先把某一段调成非 0 的值。');
      const args = [...H.af(parts), ...vstreamArgs(v), ...aencArgs(v), ...H.parseExtra(v.extra)];
      const notes = [
        '对比原声时注意整体音量会变化，最好配「动态压缩与响度标准化」把响度拉平再比较。',
        'gain 的单位是 dB：+6 表示该频段提升约一倍响度，-6 表示衰减一半。'
      ];
      return { args, warnings, notes };
    }
  });

  /* ================================================================
   * 五、变速 · 变调
   * ================================================================ */

  defOp({
    id: 'audio-tempo',
    cat: 'audio',
    name: '音频变速不变调（atempo）',
    desc: '只改播放速度、音调不变；倍率超出 0.5~2 会自动串联多级 atempo。',
    tags: ['变速', 'atempo', '不变调', '倍速', '听书'],
    outExt: (v) => (v.vmode === 'none' ? 'm4a' : 'mp4'),
    fields: [
      { k: 'speed', label: '速度倍数', type: 'number', def: 1.5, min: 0.1, max: 100, step: 0.05, col: 6,
        hint: '大于 1 加速，小于 1 放慢。如 1.25 适合听书，0.9 适合核对语速。' },
      { k: 'vmode', label: '画面处理', type: 'select', def: 'sync', col: 6, options: [
        { v: 'sync', label: '画面同步变速（音画一致，需重编码视频）' },
        { v: 'keep', label: '画面保持原速（音画会逐渐错位）' },
        { v: 'none', label: '不要画面，只输出音频' }
      ] },
      { k: 'vcrf', label: '视频重编码质量 CRF', type: 'number', def: 23, min: 0, max: 51, col: 6, showIf: (v) => v.vmode === 'sync' },
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const sp = num(v.speed, 1.5);
      if (sp <= 0) {
        return { args: [...vstreamArgs(v), ...aencArgs(v)], warnings: ['速度倍数必须大于 0。'] };
      }
      const af = atempoFilter(sp);
      const chain = atempoChain(sp);
      const args = [];
      if (v.vmode === 'sync') {
        args.push('-filter_complex', `[0:v]setpts=${(1 / sp).toFixed(6)}*PTS[v];[0:a]${af}[a]`, '-map', '[v]', '-map', '[a]');
        args.push('-c:v', 'libx264', '-crf', String(num(v.vcrf, 23)), '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
        args.push(...aencArgs(v));
      } else {
        args.push(...H.af([af]));
        if (v.vmode === 'none') args.push('-vn');
        else args.push('-c:v', 'copy');
        args.push(...aencArgs(v));
      }
      args.push(...H.parseExtra(v.extra));
      const notes = [
        `atempo 单级只支持 0.5~2.0 倍，${sp} 倍被自动拆成 ${chain.length} 级：${chain.join(' x ')}。`,
        `输出时长约为原来的 ${(100 / sp).toFixed(1)}%。`
      ];
      const warnings = [];
      if (v.vmode === 'keep') warnings.push('画面保持原速而音频变速，两者会越来越不同步；需要一致请把画面处理改成「画面同步变速」。');
      return { args, notes, warnings };
    }
  });

  defOp({
    id: 'audio-pitch',
    cat: 'audio',
    name: '音频变调（升降半音）',
    desc: '按半音数升高或降低音调，例如 +3 个半音；可选是否同时改变时长。',
    tags: ['变调', '升降调', '半音', 'pitch', 'asetrate'],
    outExt: (v) => (v.vmode === 'none' ? 'm4a' : 'mp4'),
    fields: [
      { k: 'semitones', label: '半音数（负数降调）', type: 'number', def: 3, min: -24, max: 24, step: 0.5, col: 4,
        hint: '12 个半音 = 1 个八度；+3 大约是从男声变到略偏中性。' },
      { k: 'method', label: '算法', type: 'select', def: 'rate', col: 4, options: [
        { v: 'rate', label: 'asetrate + aresample（通用）' },
        { v: 'rubberband', label: 'rubberband（音质最好，需编译支持）' }
      ] },
      { k: 'tape', label: '同时改变时长（磁带效果）', type: 'bool', def: false, col: 4, showIf: (v) => v.method === 'rate',
        hint: '关闭时用 atempo 补偿回原时长（变调不变速）；开启则升调后变短、降调后变长。' },
      { k: 'base', label: '校准采样率（Hz）', type: 'select', def: '44100', col: 4, showIf: (v) => v.method === 'rate', options: [
        { v: '44100', label: '44100 Hz' }, { v: '48000', label: '48000 Hz' }, { v: '32000', label: '32000 Hz' }
      ], hint: '只影响 asetrate 的换算基准，先用 aresample 统一到该采样率，所以一般不需要改。' },
      { k: 'vmode', label: '画面处理', type: 'select', def: 'copy', col: 4, options: [
        { v: 'copy', label: '保留画面原速（推荐）' },
        { v: 'sync', label: '画面同步变速（仅磁带模式有意义）' },
        { v: 'none', label: '不要画面，只输出音频' }
      ] },
      { k: 'vcrf', label: '视频重编码质量 CRF', type: 'number', def: 23, min: 0, max: 51, col: 4, showIf: (v) => v.vmode === 'sync' },
      ...aencFields('', { list: ACODEC_MP4 }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const st = num(v.semitones, 3);
      const R = Math.pow(2, st / 12);
      const notes = [`${st} 个半音对应频率比 ${R.toFixed(4)}（每 +12 半音 = 1 个八度）。`];
      const warnings = [];
      let af;
      if (v.method === 'rubberband') {
        if (v.tape) warnings.push('rubberband 走的是「只变调」路径，磁带模式（同时改变时长）对它无效。');
        af = `rubberband=pitch=${R.toFixed(6)}`;
        notes.push('rubberband 需要 ffmpeg 编译时启用 librubberband，未启用会提示 No such filter: rubberband。');
      } else {
        const base = num(v.base, 44100);
        // 先把采样率统一到 base，再用 asetrate 改变「播放速率」从而变调
        af = `aresample=${base},asetrate=${Math.round(base * R)},aresample=${base}`;
        if (!v.tape) af += ',' + atempoFilter(1 / R);
        notes.push(`等价写法：asetrate=${base}*${R.toFixed(4)}，这里直接写成整数 ${Math.round(base * R)} 以免被命令行通配符影响。`);
      }
      const args = [];
      const sync = v.vmode === 'sync' && v.method === 'rate' && v.tape;
      if (sync) {
        args.push('-filter_complex', `[0:v]setpts=${(1 / R).toFixed(6)}*PTS[v];[0:a]${af}[a]`, '-map', '[v]', '-map', '[a]');
        args.push('-c:v', 'libx264', '-crf', String(num(v.vcrf, 23)), '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
      } else {
        args.push(...H.af([af]));
        if (v.vmode === 'none') args.push('-vn');
        else args.push('-c:v', 'copy');
      }
      args.push(...aencArgs(v), ...H.parseExtra(v.extra));
      if (v.method === 'rate' && v.tape && v.vmode !== 'sync') {
        warnings.push('磁带模式改变了音频时长，画面却保持原速，音画会逐渐错位；如需一致请把画面处理改成「画面同步变速」。');
      }
      if (v.vmode === 'sync' && !sync) {
        warnings.push('「画面同步变速」只在「算法=asetrate」且开启「磁带效果」时生效，本次已按保留画面原速处理。');
      }
      if (!v.tape && v.method === 'rate') notes.push('用 atempo 把时长补偿回原长度，所以是「变调不变速」。');
      return { args, notes, warnings };
    }
  });

  /* ================================================================
   * 六、导出 · 转码 · 拼接 · 裁剪
   * ================================================================ */

  defOp({
    id: 'audio-extract',
    cat: 'audio',
    name: '提取音轨为音频文件',
    desc: '把视频里的声音单独导出成 mp3 / wav / m4a / flac，只解音频、速度快，画面被丢弃。',
    tags: ['提取', '音轨', '导出音频', 'mp3', 'wav'],
    outExt: (v) => v.format || 'mp3',
    fields: [
      { k: 'format', label: '导出格式', type: 'select', def: 'mp3', col: 4, options: [
        { v: 'mp3', label: 'mp3（最通用）' },
        { v: 'm4a', label: 'm4a / aac（苹果与网页）' },
        { v: 'wav', label: 'wav（未压缩）' },
        { v: 'aac', label: 'aac（裸流 .aac）' },
        { v: 'flac', label: 'flac（无损压缩）' },
        { v: 'opus', label: 'opus（体积最小）' },
        { v: 'ogg', label: 'ogg vorbis' }
      ] },
      { k: 'trackMode', label: '音轨选择', type: 'select', def: 'auto', col: 4, options: [
        { v: 'auto', label: '自动（第一条可用音轨）' },
        { v: 'pick', label: '指定第 N 条音轨' }
      ] },
      { k: 'track', label: '音轨序号（从 0 开始）', type: 'number', def: 0, min: 0, max: 31, col: 4,
        showIf: (v) => v.trackMode === 'pick', hint: '第 1 条填 0，第 2 条填 1，对应 -map 0:a:N。' },
      { k: 'codec', label: '音频编码器', type: 'select', def: 'auto', col: 4, options: [{ v: 'auto', label: '自动匹配导出格式' }].concat(ACODEC_ALL) },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '192k', col: 4, options: ABITRATES,
        showIf: (v) => !['flac', 'pcm_s16le'].includes(v.codec === 'auto' ? (CODEC_BY_EXT[v.format] || 'aac') : v.codec) },
      { k: 'rate', label: '采样率', type: 'select', def: 'keep', col: 4, options: ARATE_KEEP },
      { k: 'channels', label: '声道', type: 'select', def: 'keep', col: 4, options: ACH_KEEP },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const codec = (v.codec && v.codec !== 'auto') ? v.codec : (CODEC_BY_EXT[v.format] || 'aac');
      const args = [];
      if (v.trackMode === 'pick') args.push('-map', '0:a:' + num(v.track, 0));
      args.push('-vn');
      args.push(...H.audioArgs(codec, v.abitrate));
      if (v.rate && v.rate !== 'keep') args.push('-ar', String(v.rate));
      if (v.channels && v.channels !== 'keep') args.push('-ac', String(v.channels));
      args.push(...H.parseExtra(v.extra));
      const notes = [
        '只解码音频流，速度远快于整体转码，画质与输出无关。',
        '如果提示「Output file does not contain any stream」，说明该文件没有音轨，或指定的音轨序号不存在（序号从 0 开始）。'
      ];
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-convert',
    cat: 'audio',
    name: '音频格式互转',
    desc: '在 mp3 / wav / m4a / flac / ogg 之间批量转换，可指定采样率、声道与码率。',
    tags: ['格式转换', '转码', 'mp3', 'flac', '批量'],
    inputKind: 'audio',
    outExt: (v) => v.format || 'mp3',
    fields: [
      { k: 'format', label: '目标格式', type: 'select', def: 'mp3', col: 4, options: AEXT_OPTIONS },
      { k: 'codec', label: '音频编码器', type: 'select', def: 'auto', col: 4, options: [{ v: 'auto', label: '自动匹配目标格式' }].concat(ACODEC_ALL) },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '192k', col: 4, options: ABITRATES,
        showIf: (v) => !['flac', 'pcm_s16le'].includes(v.codec === 'auto' ? (CODEC_BY_EXT[v.format] || 'aac') : v.codec) },
      { k: 'rate', label: '采样率', type: 'select', def: 'keep', col: 4, options: ARATE_KEEP },
      { k: 'channels', label: '声道', type: 'select', def: 'keep', col: 4, options: ACH_KEEP },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const codec = (v.codec && v.codec !== 'auto') ? v.codec : (CODEC_BY_EXT[v.format] || 'aac');
      const args = [...H.audioArgs(codec, v.abitrate)];
      if (v.rate && v.rate !== 'keep') args.push('-ar', String(v.rate));
      if (v.channels && v.channels !== 'keep') args.push('-ac', String(v.channels));
      args.push(...H.parseExtra(v.extra));
      const notes = ['有损格式之间互转会二次损失音质；需要反复处理时请保留一份 flac / wav 母版。'];
      if (v.format === 'wav' || v.format === 'flac') notes.push('无损格式忽略码率设置，文件体积会明显变大。');
      return { args, notes };
    }
  });

  defOp({
    id: 'audio-concat',
    cat: 'audio',
    name: '音频拼接（首尾相接）',
    desc: '把多个音频文件接成一条；直接复制流最快，但要求编码与采样率一致。',
    tags: ['拼接', '合并', 'concat', '音频合并'],
    scope: 'set',
    minInputs: 2,
    inputKind: 'audio',
    outExt: (v) => v.format || 'mp3',
    fields: [
      { k: 'format', label: '输出格式', type: 'select', def: 'mp3', col: 4, options: AEXT_OPTIONS },
      { k: 'mode', label: '处理方式', type: 'select', def: 'copy', col: 4, options: [
        { v: 'copy', label: '直接复制流（最快，要求参数一致）' },
        { v: 'encode', label: '重新编码（任意素材都能拼）' }
      ] },
      { k: 'listName', label: '临时列表文件名', type: 'text', def: '_audio_concat_list.txt', col: 4,
        hint: '会自动写入输出目录，可用「保存附属文件」按钮生成。' },
      { k: 'useAbs', label: '列表中使用绝对路径', type: 'bool', def: true, col: 4,
        hint: '强烈建议保持开启；关闭后 ffmpeg 会相对「列表文件所在目录」去找音频，只有列表和音频放在同一目录时才找得到。' },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '192k', col: 4, options: ABITRATES, showIf: (v) => v.mode === 'encode' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const listName = v.listName || '_audio_concat_list.txt';
      const listPath = U.join(ctx.outputDir, listName, ctx.platform);
      const lines = ctx.inputs.map((p) => {
        const file = v.useAbs ? p : U.base(p);
        return "file '" + String(file).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
      });
      const aux = [{ name: listName, path: listPath, content: lines.join('\n') + '\n', lang: 'text' }];
      let args;
      if (v.mode === 'encode') {
        const codec = CODEC_BY_EXT[v.format] || 'libmp3lame';
        args = H.audioArgs(codec, v.abitrate);
      } else {
        args = ['-c', 'copy'];
      }
      args.push(...H.parseExtra(v.extra));
      const notes = [
        `共 ${ctx.inputs.length} 个音频文件按列表顺序首尾相接。`,
        '列表文件由本方案自动生成，请用「保存附属文件」按钮写入输出目录后，再执行命令（或直接在生成的脚本里执行）。'
      ];
      if (v.mode === 'copy') notes.push('复制流模式要求所有文件编码格式、采样率、声道数一致，不一致会报错，此时请改用「重新编码」。');
      return {
        preArgs: ['-f', 'concat', '-safe', '0'],
        inputs: [listPath],
        args, aux, notes
      };
    }
  });

  defOp({
    id: 'audio-trim',
    cat: 'audio',
    name: '音频裁剪片段（按时间截取）',
    desc: '从指定时间开始截取一段，可无损复制或重新编码；对视频文件会连画面一起截取。',
    tags: ['裁剪', '截取', 'trim', '片段', 'cut'],
    outExt: (v) => outExtByVideo(v, 'm4a'),
    fields: [
      { k: 'start', label: '开始时间', type: 'time', def: '00:00:00', col: 3, placeholder: '00:00:10 或 10' },
      { k: 'dur', label: '持续时长（留空到结尾）', type: 'time', def: '00:00:30', col: 3 },
      { k: 'mode', label: '处理方式', type: 'select', def: 'encode', col: 6, options: [
        { v: 'encode', label: '重新编码（推荐，时间精确）' },
        { v: 'copy', label: '直接复制流（最快，切割点对齐关键帧）' }
      ] },
      ...vstreamFields(''),
      ...withShowIf(aencFields('', { list: ACODEC_MP4 }), (v) => v.mode === 'encode'),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const start = H.timeArg(v.start);
      const preArgs = [];
      if (start && num(U.toSec(start), 0) > 0) preArgs.push('-ss', start);
      const args = [];
      const dur = H.timeArg(v.dur);
      if (dur) args.push('-t', dur);
      const notes = [];
      const warnings = [];
      if (v.mode === 'copy') {
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
        // 复制流模式下音频不能重编码，但「不要画面」依然有效
        if (String(v.vkeep) === 'none') args.push('-vn');
        if (String(v.vkeep) === 'reencode') warnings.push('复制流模式不会重新编码视频，「视频画面 = 重新编码」这一项被忽略；需要重编码请把处理方式改成「重新编码」。');
        notes.push('复制流不重新编码，切割点会对齐到最近的关键帧，起止时间可能差几百毫秒。');
      } else {
        args.push(...vstreamArgs(v), ...aencArgs(v));
        notes.push('重新编码可以做到帧级精确，但耗时且会损失极少量画质。');
      }
      args.push(...H.parseExtra(v.extra));
      return {
        preArgs, args, notes, warnings,
      };
    }
  });

  /* ================================================================
   * 七、检测与分析
   * ================================================================ */

  defOp({
    id: 'audio-volumedetect',
    cat: 'audio',
    name: '音量检测与统计（不产生文件）',
    desc: '只分析不输出：查看最大/平均音量、削波情况或 EBU R128 响度，供前面几个操作调参用。',
    tags: ['分析', '音量检测', 'volumedetect', 'ebur128', '响度'],
    outExt: 'txt',
    fields: [
      { k: 'mode', label: '分析方式', type: 'select', def: 'volumedetect', col: 6, options: [
        { v: 'volumedetect', label: 'volumedetect：最大/平均音量（最常用）' },
        { v: 'ebur128', label: 'ebur128：EBU R128 响度（LUFS）' },
        { v: 'astats', label: 'astats：逐声道详细统计' },
        { v: 'loudnorm-json', label: 'loudnorm 测量值（JSON，两遍法第一步）' }
      ] },
      { k: 'I', label: 'loudnorm 目标响度 I（LUFS）', type: 'number', def: -16, min: -70, max: -5, step: 0.5, col: 6,
        showIf: (v) => v.mode === 'loudnorm-json', hint: '应与第二遍要用的目标值保持一致。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const afMap = {
        volumedetect: 'volumedetect',
        ebur128: 'ebur128=peak=true',
        astats: 'astats=metadata=1:reset=0',
        'loudnorm-json': 'loudnorm=I=' + num(v.I, -16) + ':TP=-1.5:LRA=11:print_format=json'
      };
      const af = afMap[v.mode] || 'volumedetect';
      const args = ['-vn', '-af', af, '-f', 'null', '-'];
      args.push(...H.parseExtra(v.extra));
      const notes = [
        '本操作不会生成任何输出文件，结果直接打印在运行日志里。',
        'volumedetect 关注 mean_volume（平均）与 max_volume（最大）：max_volume 贴近 0dB 说明已经削波；两者差距大说明动态范围大。',
        'ebur128 输出 Integrated loudness（整体响度，单位 LUFS）与 True peak，是判断「声音是不是太响」的标准方法。',
        'loudnorm 测量模式会输出 JSON 的 measured_I / measured_TP / measured_LRA / measured_thresh / target_offset，把这些值填进「动态压缩与响度标准化」，就是音质最好的两遍法。'
      ];
      return { args, output: '', notes };
    }
  });

})();
