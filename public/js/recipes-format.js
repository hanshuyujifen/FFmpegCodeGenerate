/**
 * recipes-format.js —— 配方库：格式与编码转换 / 编码质量与性能 / 流与元数据 / 高级与自定义
 * 依赖 engine.js 暴露的全局函数 defCat / defOp 与 FFHELP / FFQ / FFU
 */
(function () {
  'use strict';
  const H = FFHELP, Q = FFQ, U = FFU;

  /* ================================================================
   * 分类
   * ================================================================ */
  defCat({ id: 'format', name: '格式与编码转换', icon: '🔄', color: '#3b82f6', desc: '容器格式、编码器、音频提取、无损转封装' });
  defCat({ id: 'quality', name: '编码质量与性能', icon: '🎚️', color: '#eab308', desc: 'CRF/码率/预设/两遍编码/硬件加速/线程' });
  defCat({ id: 'stream', name: '流与元数据', icon: '🧩', color: '#14b8a6', desc: '轨道选择与增删、元数据、章节、faststart' });
  defCat({ id: 'advanced', name: '高级与自定义', icon: '🛠️', color: '#64748b', desc: '自定义参数、日志、性能分析、复杂滤镜' });

  /* ================================================================
   * 公共选项表
   * ================================================================ */

  /** 全量视频编码器（含硬件加速） */
  const VCODECS = [
    { v: 'libx264', label: 'libx264（H.264 软件，最通用）' },
    { v: 'libx265', label: 'libx265（H.265 软件，体积更小）' },
    { v: 'h264_nvenc', label: 'h264_nvenc（NVIDIA 显卡加速）' },
    { v: 'hevc_nvenc', label: 'hevc_nvenc（NVIDIA H.265）' },
    { v: 'h264_qsv', label: 'h264_qsv（Intel 核显加速）' },
    { v: 'hevc_qsv', label: 'hevc_qsv（Intel H.265）' },
    { v: 'h264_amf', label: 'h264_amf（AMD 显卡加速）' },
    { v: 'hevc_amf', label: 'hevc_amf（AMD H.265）' },
    { v: 'h264_videotoolbox', label: 'h264_videotoolbox（Apple 硬件）' },
    { v: 'h264_vaapi', label: 'h264_vaapi（Linux VA-API）' },
    { v: 'mpeg4', label: 'mpeg4（老设备兼容）' },
    { v: 'copy', label: 'copy（不重编码，直接复制流）' }
  ];

  const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']
    .map((x) => ({ v: x, label: x }));
  const PRESET_RE = /^(libx26[45]|h264_nvenc|hevc_nvenc|h264_qsv|hevc_qsv)$/;

  const ACODECS = [
    { v: 'aac', label: 'aac（通用）' },
    { v: 'libmp3lame', label: 'mp3' },
    { v: 'libopus', label: 'opus（体积小）' },
    { v: 'libvorbis', label: 'vorbis（ogg）' },
    { v: 'ac3', label: 'ac3（DVD/电视）' },
    { v: 'flac', label: 'flac（无损）' },
    { v: 'pcm_s16le', label: 'pcm（WAV 未压缩）' },
    { v: 'copy', label: 'copy（不重编码）' },
    { v: 'none', label: '不要音频' }
  ];
  const ABITRATES = ['96k', '128k', '160k', '192k', '256k', '320k', '512k'].map((x) => ({ v: x, label: x }));
  const NO_BITRATE = ['copy', 'none', 'flac', 'pcm_s16le'];

  const EXTRA_FIELD = {
    k: 'extra', label: '附加参数（高级）', type: 'text', def: '', col: 12,
    placeholder: '如 -movflags +faststart -threads 4',
    hint: '空格分隔；含空格的参数请用双引号包起来。将追加在输出文件之前。'
  };

  /* ================================================================
   * 公共字段片段 / 参数片段
   * ================================================================ */

  /** 视频编码通用字段：编码器 + 质量控制 + CRF + 码率 + 预设 */
  function vencFields(prefix, opts) {
    const p = prefix || '', o = opts || {};
    return [
      { k: p + 'vcodec', label: (o.label || '') + '视频编码器', type: 'select', def: o.defCodec || 'libx264', options: o.codecs || VCODECS, col: 6 },
      { k: p + 'qmode', label: '质量控制方式', type: 'select', def: o.defQmode || 'crf', col: 6, options: [
        { v: 'crf', label: 'CRF/CQ 恒定质量（推荐）' },
        { v: 'bitrate', label: '指定平均码率' },
        { v: 'none', label: '不指定（用编码器默认）' }
      ], showIf: (v) => v[p + 'vcodec'] !== 'copy' },
      { k: p + 'crf', label: 'CRF 值（越小越清晰，18~28）', type: 'number', def: o.defCrf == null ? 23 : o.defCrf, min: 0, max: 51, col: 4,
        hint: '硬件编码器会自动换算成对应的 CQ / QP / 质量值。',
        showIf: (v) => v[p + 'vcodec'] !== 'copy' && v[p + 'qmode'] === 'crf' },
      { k: p + 'bitrate', label: '视频码率', type: 'text', def: o.defBitrate || '4M', col: 4, placeholder: '如 4M / 2500k',
        showIf: (v) => v[p + 'vcodec'] !== 'copy' && v[p + 'qmode'] === 'bitrate' },
      { k: p + 'preset', label: '编码预设（越慢越小）', type: 'select', def: o.defPreset || 'medium', options: PRESETS, col: 4,
        showIf: (v) => PRESET_RE.test(v[p + 'vcodec'] || '') }
    ];
  }

  /** 视频编码参数。enc 为 copy 时退化为流复制，none 时剔除视频 */
  function vencArgs(v, prefix) {
    const p = prefix || '';
    const enc = v[p + 'vcodec'] || 'libx264';
    if (enc === 'none') return ['-vn'];
    if (enc === 'copy') return ['-c:v', 'copy'];
    const a = ['-c:v', enc];
    const qm = v[p + 'qmode'] || 'crf';
    if (qm === 'bitrate') a.push(...H.videoQuality('bitrate', v[p + 'bitrate'], enc));
    else if (qm === 'crf') a.push(...H.videoQuality('crf', v[p + 'crf'], enc));
    if (PRESET_RE.test(enc)) a.push(...H.preset(v[p + 'preset'], enc));
    // AMF 没有 -preset，用 -quality 表达同样的「快 / 均衡 / 好」三档
    if (/amf$/.test(enc) && v[p + 'preset']) a.push('-quality', amfQuality(v[p + 'preset']));
    // 软件 H.264/H.265 默认输出 yuv420p，避免 QuickTime / 浏览器不认 yuv444
    if (/libx26[45]/.test(enc)) a.push('-pix_fmt', 'yuv420p');
    return a;
  }

  function amfQuality(preset) {
    if (/ultrafast|superfast|veryfast|faster|fast/.test(preset)) return 'speed';
    if (/slow|slower|veryslow/.test(preset)) return 'quality';
    return 'balanced';
  }

  /** 音频编码通用字段 */
  function aencFields(prefix, opts) {
    const p = prefix || '', o = opts || {};
    return [
      { k: p + 'acodec', label: '音频编码', type: 'select', def: o.defCodec || 'aac', options: o.codecs || ACODECS, col: 6 },
      { k: p + 'abitrate', label: '音频码率', type: 'select', def: o.defBitrate || '192k', options: ABITRATES, col: 6,
        showIf: (v) => !NO_BITRATE.includes(v[p + 'acodec']) }
    ];
  }

  function aencArgs(v, prefix) {
    const p = prefix || '';
    return H.audioArgs(v[p + 'acodec'], v[p + 'abitrate'], null, null);
  }

  /** 硬件编码的额外提示 */
  function hwWarnings(enc, ctx) {
    const w = [];
    if (/vaapi/.test(enc || '')) {
      if (ctx && ctx.platform === 'win32') w.push('VA-API 只存在于 Linux，Windows 上请改用 nvenc / qsv / amf。');
      else w.push('使用 VA-API 需要 /dev/dri/renderD128 可访问，且输入需先 hwupload。');
    }
    if (/nvenc/.test(enc || '')) w.push('NVENC 需要 NVIDIA 显卡与较新驱动；若报错请退回 libx264。');
    if (/qsv/.test(enc || '')) w.push('QSV 需要 Intel 核显与已安装的驱动/运行库。');
    if (/amf/.test(enc || '')) w.push('AMF 需要 AMD 显卡与较新驱动。');
    if (/videotoolbox/.test(enc || '')) w.push('VideoToolbox 只能在 macOS 上使用。');
    return w;
  }

  /** 纯音频输出格式 -> 编码参数 */
  function audioFmtArgs(fmt, bitrate) {
    const br = bitrate || '192k';
    switch (fmt) {
      case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br, '-id3v2_version', '3'];
      case 'wav': return ['-c:a', 'pcm_s16le'];
      case 'aac': return ['-c:a', 'aac', '-b:a', br];
      case 'flac': return ['-c:a', 'flac', '-compression_level', '8'];
      case 'm4a': return ['-c:a', 'aac', '-b:a', br, '-movflags', '+faststart'];
      case 'ogg': return ['-c:a', 'libvorbis', '-q:a', '5'];
      case 'opus': return ['-c:a', 'libopus', '-b:a', bitrate || '128k'];
      case 'copy': return ['-c:a', 'copy'];
      default: return ['-c:a', 'aac', '-b:a', br];
    }
  }

  const AUDIO_FORMATS = [
    { v: 'mp3', label: 'MP3（最通用）' },
    { v: 'wav', label: 'WAV（未压缩）' },
    { v: 'aac', label: 'AAC（裸流 .aac）' },
    { v: 'flac', label: 'FLAC（无损压缩）' },
    { v: 'm4a', label: 'M4A（AAC 容器）' },
    { v: 'ogg', label: 'OGG Vorbis' },
    { v: 'opus', label: 'Opus（体积最小）' }
  ];

  /* ================================================================
   * 格式与编码转换
   * ================================================================ */

  defOp({
    id: 'format-mp4-h264',
    cat: 'format',
    name: '转成 MP4（H.264 + AAC）',
    desc: '把任意视频转成兼容性最好的 MP4，网页、手机、播放器、剪辑软件通吃。',
    tags: ['mp4', 'h264', '转换', '通用'],
    outExt: 'mp4',
    fields: [
      ...vencFields('', {}),
      ...aencFields('', {}),
      { k: 'faststart', label: '把索引移到文件头（网络秒开）', type: 'bool', def: true, col: 6 },
      { k: 'hvc1', label: 'H.265 打上 hvc1 标记（Apple 设备必需）', type: 'bool', def: true, col: 6, showIf: (v) => /265|hevc/.test(v.vcodec) },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [...vencArgs(v, ''), ...aencArgs(v, '')];
      if (v.faststart) args.push('-movflags', '+faststart');
      if (v.hvc1 && /265|hevc/.test(v.vcodec)) args.push('-tag:v', 'hvc1');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['H.264 + AAC + yuv420p 是兼容性最好的组合；如果原视频本来就是这个格式，请改用「无损转封装」以免白白掉画质。'],
        warnings: hwWarnings(v.vcodec, ctx)
      };
    }
  });

  defOp({
    id: 'format-mkv',
    cat: 'format',
    name: '转成 MKV（全能容器）',
    desc: 'MKV 几乎能装下任何编码和多条音轨字幕，适合做本地收藏的母版。',
    tags: ['mkv', 'matroska', '封装', '多轨'],
    outExt: 'mkv',
    fields: [
      ...vencFields('', {}),
      ...aencFields('', { defCodec: 'copy' }),
      { k: 'keepSubs', label: '原样保留字幕轨', type: 'bool', def: true, col: 6 },
      { k: 'keepAttach', label: '保留附件与字体', type: 'bool', def: true, col: 6, hint: 'ASS 字幕依赖字体附件，需要保留。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [...vencArgs(v, ''), ...aencArgs(v, '')];
      args.push(...(v.keepSubs ? ['-c:s', 'copy'] : ['-sn']));
      if (v.keepAttach) args.push('-map', '0:t?');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['MKV 没有 faststart 的概念，索引放在文件里由播放器自行定位。'],
        warnings: hwWarnings(v.vcodec, ctx)
      };
    }
  });

  defOp({
    id: 'format-webm',
    cat: 'format',
    name: '转成 WebM（VP9 + Opus）',
    desc: '网页 <video> 免插件播放的格式，同画质体积比 H.264 小，但编码很慢。',
    tags: ['webm', 'vp9', 'opus', '网页'],
    outExt: 'webm',
    fields: [
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'libvpx-vp9', col: 6, options: [
        { v: 'libvpx-vp9', label: 'libvpx-vp9（推荐，压缩率高）' },
        { v: 'libvpx', label: 'libvpx（VP8，兼容更老但画质差）' }
      ] },
      { k: 'qmode', label: '质量控制方式', type: 'select', def: 'crf', col: 6, options: [
        { v: 'crf', label: 'CRF 恒定质量（推荐）' },
        { v: 'bitrate', label: '指定平均码率' }
      ] },
      { k: 'crf', label: 'CRF 值（VP9 建议 30~36）', type: 'number', def: 32, min: 0, max: 63, col: 4, showIf: (v) => v.qmode === 'crf' },
      { k: 'bitrate', label: '目标码率', type: 'text', def: '1M', col: 4, showIf: (v) => v.qmode === 'bitrate' },
      { k: 'deadline', label: '编码速度策略', type: 'select', def: 'good', col: 4, options: [
        { v: 'good', label: 'good（质量与速度平衡）' },
        { v: 'best', label: 'best（最慢最好）' },
        { v: 'realtime', label: 'realtime（最快最差）' }
      ] },
      { k: 'cpuUsed', label: 'CPU 占用档位 0~8（越大越快越糙）', type: 'number', def: 2, min: 0, max: 8, col: 4 },
      { k: 'rowMt', label: '开启多线程行编码（-row-mt，明显加速）', type: 'bool', def: true, col: 8 },
      ...aencFields('', { defCodec: 'libopus', defBitrate: '128k', codecs: [
        { v: 'libopus', label: 'libopus（WebM 标准）' },
        { v: 'libvorbis', label: 'libvorbis（老播放器）' },
        { v: 'none', label: '不要音频' }
      ] }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const enc = v.vcodec || 'libvpx-vp9';
      const args = ['-c:v', enc];
      if (v.qmode === 'bitrate') args.push('-b:v', v.bitrate || '1M');
      else if (enc === 'libvpx-vp9') args.push('-crf', String(v.crf), '-b:v', '0');
      else args.push('-crf', String(v.crf), '-b:v', v.bitrate || '1M');
      args.push('-deadline', v.deadline || 'good', '-cpu-used', String(v.cpuUsed));
      if (v.rowMt && enc === 'libvpx-vp9') args.push('-row-mt', '1');
      if (v.acodec === 'libvorbis') args.push('-c:a', 'libvorbis', '-q:a', '5');
      else args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['VP9 的 -b:v 0 表示「完全按 CRF 控制质量」，不设上限码率。', '-row-mt 1 可显著加快 VP9 编码，画质几乎无损。'],
        warnings: ['VP9 编码速度大约只有 x264 的 1/5~1/10，长视频请先剪片段试跑。']
      };
    }
  });

  defOp({
    id: 'format-mov-prores',
    cat: 'format',
    name: '转成 MOV / ProRes（剪辑中间格式）',
    desc: '给 Final Cut / Premiere 用的高质量中间码，编码快、剪辑流畅，代价是体积巨大。',
    tags: ['prores', 'mov', '剪辑', '中间格式'],
    outExt: 'mov',
    fields: [
      { k: 'profile', label: 'ProRes 档次', type: 'select', def: '3', col: 6, options: [
        { v: '0', label: 'proxy（代理，体积最小）' },
        { v: '1', label: 'LT（轻量）' },
        { v: '2', label: 'standard（标准）' },
        { v: '3', label: 'HQ（高质量，常用）' },
        { v: '4', label: '4444（带 Alpha 通道）' },
        { v: '5', label: '4444 XQ（最高）' }
      ] },
      { k: 'aacodec', label: '音频编码', type: 'select', def: 'pcm_s16le', col: 6, options: [
        { v: 'pcm_s16le', label: 'PCM 16bit（剪辑标准）' },
        { v: 'pcm_s24le', label: 'PCM 24bit' },
        { v: 'aac', label: 'AAC（体积小）' },
        { v: 'copy', label: 'copy（原样保留）' },
        { v: 'none', label: '不要音频' }
      ] },
      { k: 'abitrate', label: '音频码率（仅 AAC）', type: 'select', def: '192k', options: ABITRATES, col: 6, showIf: (v) => v.aacodec === 'aac' },
      { k: 'sr', label: '强制采样率', type: 'select', def: '', col: 6, options: [
        { v: '', label: '不修改' }, { v: '48000', label: '48000 Hz' }, { v: '44100', label: '44100 Hz' }
      ], hint: '部分剪辑软件要求 48kHz。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const prof = String(v.profile || '3');
      const alpha = prof === '4' || prof === '5';
      const args = ['-c:v', 'prores_ks', '-profile:v', prof, '-vendor', 'apl0',
        '-pix_fmt', alpha ? 'yuva444p10le' : 'yuv422p10le'];
      if (v.aacodec === 'copy') args.push('-c:a', 'copy');
      else if (v.aacodec === 'none') args.push('-an');
      else args.push('-c:a', v.aacodec);
      if (v.aacodec === 'aac' && v.abitrate) args.push('-b:a', v.abitrate);
      if (v.sr) args.push('-ar', v.sr);
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-vendor apl0 让文件被识别为 Apple 官方 ProRes，兼容性最好。'],
        warnings: ['ProRes HQ 1080p25 约 220 Mbps，1 小时素材接近 100 GB，只建议做为剪辑中间格式。']
      };
    }
  });

  defOp({
    id: 'format-avi',
    cat: 'format',
    name: '转成 AVI（老设备 / 老软件）',
    desc: '给十几年前的播放器、车载机、老剪辑软件用的老式容器，体积大且限制多。',
    tags: ['avi', '老设备', '兼容', 'xvid'],
    outExt: 'avi',
    fields: [
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'mpeg4', col: 6, options: [
        { v: 'mpeg4', label: 'mpeg4（可打 XVID 标记）' },
        { v: 'libx264', label: 'libx264（新播放器才认）' },
        { v: 'mjpeg', label: 'mjpeg（逐帧压缩，体积大）' },
        { v: 'copy', label: 'copy（原样复制视频流）' }
      ] },
      { k: 'qscale', label: '画质 1~31（越小越好）', type: 'number', def: 4, min: 1, max: 31, col: 3, showIf: (v) => v.vcodec === 'mpeg4' || v.vcodec === 'mjpeg' },
      { k: 'xvid', label: '打上 XVID 标记（提高识别率）', type: 'bool', def: true, col: 3, showIf: (v) => v.vcodec === 'mpeg4' },
      ...aencFields('', { defCodec: 'libmp3lame', codecs: [
        { v: 'libmp3lame', label: 'mp3（AVI 标准搭配）' },
        { v: 'pcm_s16le', label: 'PCM（未压缩）' },
        { v: 'ac3', label: 'ac3' },
        { v: 'copy', label: 'copy（原样保留）' },
        { v: 'none', label: '不要音频' }
      ] }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.vcodec === 'copy') args.push('-c:v', 'copy');
      else if (v.vcodec === 'libx264') args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p');
      else {
        args.push('-c:v', v.vcodec, '-q:v', String(v.qscale || 4));
        if (v.vcodec === 'mpeg4' && v.xvid) args.push('-tag:v', 'XVID');
      }
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['AVI 不支持 faststart 与章节；-tag:v XVID 只是打标记，编码仍是 FFmpeg 的 mpeg4。'],
        warnings: ['AVI 单文件超过 2GB 时很多老设备会读不全，长视频建议先切片。']
      };
    }
  });

  defOp({
    id: 'format-remux-copy',
    cat: 'format',
    name: '无损转封装（remux，-c copy）',
    desc: '只换外壳不重编码，几秒完成、画质零损失。前提是目标容器支持源文件的编码。',
    tags: ['remux', '无损', '转封装', 'copy'],
    outExt: (v) => v.container || 'mkv',
    fields: [
      { k: 'container', label: '目标容器', type: 'select', def: 'mp4', col: 6, options: [
        { v: 'mp4', label: 'MP4' },
        { v: 'mkv', label: 'MKV（最宽容）' },
        { v: 'mov', label: 'MOV' },
        { v: 'ts', label: 'MPEG-TS' },
        { v: 'flv', label: 'FLV' }
      ] },
      { k: 'faststart', label: '把索引移到文件头', type: 'bool', def: true, col: 6, showIf: (v) => v.container === 'mp4' || v.container === 'mov' },
      { k: 'trackMode', label: '轨道选择', type: 'select', def: 'auto', col: 6, options: [
        { v: 'auto', label: '自动（MKV 保留全部，MP4/TS 只留视频+音频）' },
        { v: 'va', label: '只留视频与音频（最保险）' },
        { v: 'all', label: '全部轨道（-map 0）' }
      ], hint: 'MP4/TS 装不下 subrip、PGS 等字幕轨，全部映射会直接报错。' },
      { k: 'fixTs', label: '同时修正负时间戳', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const c = v.container || 'mkv';
      const keepAll = v.trackMode === 'all' || (v.trackMode === 'auto' && c === 'mkv');
      const args = ['-c', 'copy'];
      args.push(...(keepAll ? ['-map', '0'] : ['-map', '0:v', '-map', '0:a']));
      if (v.fixTs) args.push('-avoid_negative_ts', 'make_zero');
      if (v.faststart && (c === 'mp4' || c === 'mov')) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      const warnings = ['如果源文件的编码不被目标容器支持，ffmpeg 会直接报错而不会自动转码。'];
      if (keepAll && c !== 'mkv') warnings.push('MP4/MOV/TS/FLV 不支持 subrip、PGS 等字幕轨，选择「全部轨道」可能报 “codec not currently supported in container”。');
      return {
        args,
        notes: ['判断能否 remux：H.264/H.265 + AAC 进 MP4 没问题；HEVC/FLAC/PCM 进 MP4 会失败，请改用 MKV。'],
        warnings
      };
    }
  });

  defOp({
    id: 'format-extract-audio',
    cat: 'format',
    name: '只提取音频（顺手转成 MP3/WAV/FLAC…）',
    desc: '把视频里的声音单独存成音频文件，可选是否保留标签与全部音轨。',
    tags: ['提取音频', 'mp3', 'wav', '抽音轨'],
    outExt: (v) => v.format || 'mp3',
    fields: [
      { k: 'format', label: '输出音频格式', type: 'select', def: 'mp3', col: 6, options: AUDIO_FORMATS },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '192k', options: ABITRATES, col: 6,
        showIf: (v) => ['mp3', 'aac', 'm4a', 'opus'].includes(v.format) },
      { k: 'trackMode', label: '提取哪些音轨', type: 'select', def: 'all', col: 6, options: [
        { v: 'all', label: '全部音轨（-map 0:a）' },
        { v: 'first', label: '只提取第一条（-map 0:a:0）' }
      ] },
      { k: 'keepMeta', label: '保留原有元数据标签', type: 'bool', def: true, col: 6 },
      { k: 'useVn', label: '显式剔除视频（-vn）', type: 'bool', def: true, col: 6, hint: '取消后视频流会被保留，等于转封装而不是提取音频。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const fmt = v.format || 'mp3';
      // MP3/WAV/AAC/FLAC/OGG/Opus 这些容器只能装一条音轨，映射多条会让整个输出为空
      const singleTrack = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'opus'].includes(fmt);
      const wantAll = v.trackMode === 'all';
      const mapAll = wantAll && !singleTrack;
      const args = [];
      if (v.useVn) args.push('-vn');
      args.push('-map', mapAll ? '0:a' : '0:a:0');
      if (v.keepMeta) args.push('-map_metadata', '0');
      args.push(...audioFmtArgs(fmt, v.abitrate));
      args.push(...H.parseExtra(v.extra));
      const warnings = [];
      if (wantAll && singleTrack) warnings.push(`${fmt.toUpperCase()} 容器只能容纳一条音轨，已自动改为只提取第一条；需要多轨请选择 M4A，或改用「提取指定轨道到新文件」。`);
      if (fmt === 'mp3') warnings.push('MP3 只能存 ID3 标签，视频里的其它元数据（如 MP4 的 udta）不会保留。');
      return {
        args,
        notes: ['-vn 表示不要视频流，-map 决定取哪些音轨，两者一起用最稳妥。'],
        warnings
      };
    }
  });

  defOp({
    id: 'format-video-to-audio-keepmeta',
    cat: 'format',
    name: '视频转纯音频（完整保留标签与章节）',
    desc: '抽出音轨的同时把标题、艺术家、专辑、章节一并搬过去，适合做音乐收藏。',
    tags: ['提取音频', '元数据', '章节', 'm4a'],
    outExt: (v) => v.format || 'm4a',
    fields: [
      { k: 'format', label: '输出格式', type: 'select', def: 'm4a', col: 4, options: [
        { v: 'm4a', label: 'M4A（AAC，标签支持最好）' },
        { v: 'mp3', label: 'MP3' },
        { v: 'flac', label: 'FLAC（无损）' },
        { v: 'opus', label: 'Opus' }
      ] },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '256k', options: ABITRATES, col: 4, showIf: (v) => ['m4a', 'mp3', 'opus'].includes(v.format) },
      { k: 'channels', label: '声道数', type: 'select', def: '', col: 4, options: [
        { v: '', label: '保持原样' }, { v: '1', label: '单声道' }, { v: '2', label: '立体声' }
      ] },
      { k: 'keepMeta', label: '搬运全局标签', type: 'bool', def: true, col: 6 },
      { k: 'keepChapters', label: '搬运章节', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const fmt = v.format || 'm4a';
      // M4A 能装多条音轨，MP3/FLAC/Opus 只能装一条
      const singleTrack = ['mp3', 'flac', 'opus'].includes(fmt);
      const args = ['-vn', '-map', singleTrack ? '0:a:0' : '0:a'];
      args.push(...(v.keepMeta ? ['-map_metadata', '0'] : ['-map_metadata', '-1']));
      args.push(...(v.keepChapters ? ['-map_chapters', '0'] : ['-map_chapters', '-1']));
      args.push(...audioFmtArgs(fmt, v.abitrate));
      if (v.channels) args.push('-ac', v.channels);
      args.push(...H.parseExtra(v.extra));
      const warnings = ['MP3 章节支持依赖播放器，主流做法是 M4A + 章节。'];
      if (singleTrack) warnings.push(`${fmt.toUpperCase()} 只能容纳一条音轨，本命令只搬运第一条音轨。`);
      return {
        args,
        notes: ['-map_metadata 0 把输入文件的全局标签复制到输出；-map_chapters 0 复制章节。'],
        warnings
      };
    }
  });

  defOp({
    id: 'format-audio-convert',
    cat: 'format',
    name: '音频格式互转',
    desc: 'MP3 / WAV / FLAC / M4A / OGG 之间互相转换，可顺带统一采样率、声道与响度。',
    tags: ['音频转换', 'mp3', 'flac', '采样率'],
    inputKind: 'audio',
    outExt: (v) => v.format || 'mp3',
    fields: [
      { k: 'format', label: '输出格式', type: 'select', def: 'mp3', col: 4, options: AUDIO_FORMATS },
      { k: 'abitrate', label: '码率', type: 'select', def: '192k', options: ABITRATES, col: 4,
        showIf: (v) => ['mp3', 'aac', 'm4a', 'opus'].includes(v.format) },
      { k: 'channels', label: '声道', type: 'select', def: '', col: 4, options: [
        { v: '', label: '保持原样' }, { v: '1', label: '单声道' }, { v: '2', label: '立体声' }
      ] },
      { k: 'sr', label: '采样率', type: 'select', def: '', col: 4, options: [
        { v: '', label: '保持原样' }, { v: '22050', label: '22050 Hz' },
        { v: '44100', label: '44100 Hz' }, { v: '48000', label: '48000 Hz' }
      ] },
      { k: 'norm', label: '响度标准化（loudnorm，统一音量）', type: 'bool', def: false, col: 8,
        hint: '按 EBU R128 标准把音量拉到 -16 LUFS，适合播客与短视频批量处理。' },
      { k: 'copyTags', label: '保留标签', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-vn'];
      args.push(...(v.copyTags ? ['-map_metadata', '0'] : ['-map_metadata', '-1']));
      if (v.norm) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
      args.push(...audioFmtArgs(v.format, v.abitrate));
      if (v.channels) args.push('-ac', v.channels);
      if (v.sr) args.push('-ar', v.sr);
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['loudnorm 单遍模式速度较快，精度略低于两遍分析，日常够用。'],
        warnings: v.norm ? ['loudnorm 会重采样音频，必要时请用两遍模式（先 -af loudnorm=print_format=json 分析）。'] : []
      };
    }
  });

  defOp({
    id: 'format-strip-audio',
    cat: 'format',
    name: '只保留画面（去掉音频）',
    desc: '做素材、做静音预览、上传到需要无声文件的平台时用。',
    tags: ['去音频', '静音', 'an', '无声音'],
    outExt: (v) => (v.vcodec === 'copy' ? 'mkv' : 'mp4'),
    fields: [
      ...vencFields('', { defQmode: 'crf' }),
      { k: 'dropSubs', label: '顺带去掉字幕与数据轨', type: 'bool', def: true, col: 12 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-an', ...vencArgs(v, '')];
      if (v.dropSubs) args.push('-sn', '-dn');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['选择 copy 时视频流原样复制，只丢掉音频，几秒完成。'],
        warnings: hwWarnings(v.vcodec, ctx)
      };
    }
  });

  defOp({
    id: 'format-dvd-vcd',
    cat: 'format',
    name: '转电视 / 老设备格式（DVD、VCD、SVCD）',
    desc: '输出 MPEG-2/MPEG-1 的老式光盘格式，能塞进 U 盘给老电视或车载机播放。',
    tags: ['dvd', 'vcd', 'mpeg2', '老电视'],
    outExt: 'mpg',
    fields: [
      { k: 'target', label: '目标规格', type: 'select', def: 'pal-dvd', col: 6, options: [
        { v: 'pal-dvd', label: 'PAL DVD（720x576 25fps）' },
        { v: 'ntsc-dvd', label: 'NTSC DVD（720x480 29.97fps）' },
        { v: 'pal-svcd', label: 'PAL SVCD（480x576）' },
        { v: 'ntsc-svcd', label: 'NTSC SVCD（480x480）' },
        { v: 'pal-vcd', label: 'PAL VCD（352x288）' },
        { v: 'ntsc-vcd', label: 'NTSC VCD（352x240）' }
      ] },
      { k: 'autoScale', label: '自动缩放并加黑边到标准分辨率', type: 'bool', def: true, col: 6,
        hint: '关闭后使用 FFmpeg 内置的 -target 预设（分辨率交给编码器决定，可能被拉伸）。' },
      { k: 'aspect', label: '画面比例标记', type: 'select', def: '16:9', col: 6, options: [
        { v: '16:9', label: '16:9 宽屏' }, { v: '4:3', label: '4:3 传统电视' }
      ] },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '448k', col: 6, options: [
        { v: '224k', label: '224k' }, { v: '384k', label: '384k' }, { v: '448k', label: '448k' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const T = {
        'pal-dvd': { w: 720, h: 576, r: 25, vbr: '6000k', max: '8000k', buf: '1835k', a: 'ac3' },
        'ntsc-dvd': { w: 720, h: 480, r: 30000 / 1001, vbr: '6000k', max: '8000k', buf: '1835k', a: 'ac3' },
        'pal-svcd': { w: 480, h: 576, r: 25, vbr: '2500k', max: '2600k', buf: '917k', a: 'mp2' },
        'ntsc-svcd': { w: 480, h: 480, r: 30000 / 1001, vbr: '2500k', max: '2600k', buf: '917k', a: 'mp2' },
        'pal-vcd': { w: 352, h: 288, r: 25, vbr: '1150k', max: '1150k', buf: '327k', a: 'mp2' },
        'ntsc-vcd': { w: 352, h: 240, r: 30000 / 1001, vbr: '1150k', max: '1150k', buf: '327k', a: 'mp2' }
      };
      const t = T[v.target] || T['pal-dvd'];
      const args = [];
      if (v.autoScale) {
        const isMpeg1 = /vcd/.test(v.target) && !/svcd/.test(v.target);
        args.push('-vf', `scale=${t.w}:${t.h}:force_original_aspect_ratio=decrease,pad=${t.w}:${t.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
        args.push('-c:v', isMpeg1 ? 'mpeg1video' : 'mpeg2video');
        args.push('-b:v', t.vbr, '-maxrate', t.max, '-bufsize', t.buf);
        args.push('-r', String(Math.round(t.r * 100) / 100));
        args.push('-aspect', v.aspect || '16:9');
        args.push('-c:a', t.a, '-b:a', v.abitrate || '448k', '-ar', t.a === 'ac3' ? '48000' : '44100', '-ac', '2');
        args.push('-g', '15');
      } else {
        args.push('-target', v.target || 'pal-dvd');
        args.push('-aspect', v.aspect || '16:9');
      }
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          '-target 是 FFmpeg 内置的光盘规格预设，会自动设置编码器、分辨率、帧率与码率。',
          'autoScale 与 -target 互斥：自行缩放时必须手写编码参数，否则 -s 与 -vf 会打架。'
        ],
        warnings: ['老式光盘格式码率低、分辨率小，画面会有明显损失；VCD 尤其严重。']
      };
    }
  });

  defOp({
    id: 'format-phone-vertical',
    cat: 'format',
    name: '转手机竖屏兼容格式（9:16）',
    desc: '统一成抖音/小红书/朋友圈的竖屏规格，补齐黑边或裁剪铺满，并保证播放器都能识别。',
    tags: ['竖屏', '9:16', '手机', '抖音'],
    outExt: 'mp4',
    fields: [
      { k: 'size', label: '目标分辨率', type: 'select', def: '1080x1920', col: 4, options: [
        { v: '1080x1920', label: '1080x1920 竖屏 9:16' },
        { v: '720x1280', label: '720x1280 竖屏 9:16' },
        { v: '1080x1080', label: '1080x1080 方形 1:1' },
        { v: '1920x1080', label: '1920x1080 横屏 16:9' },
        { v: 'custom', label: '自定义' }
      ] },
      { k: 'cw', label: '自定义宽', type: 'number', def: 1080, min: 16, col: 4, showIf: (v) => v.size === 'custom' },
      { k: 'ch', label: '自定义高', type: 'number', def: 1920, min: 16, col: 4, showIf: (v) => v.size === 'custom' },
      { k: 'fit', label: '适配方式', type: 'select', def: 'pad', col: 6, options: [
        { v: 'pad', label: '保持比例 + 黑边填充（不丢画面）' },
        { v: 'crop', label: '放大裁剪铺满（可能切掉边缘）' }
      ] },
      { k: 'fps', label: '帧率', type: 'select', def: '30', col: 6, options: [
        { v: '', label: '保持原样' }, { v: '24', label: '24' }, { v: '25', label: '25' },
        { v: '30', label: '30' }, { v: '60', label: '60' }
      ] },
      { k: 'crf', label: 'CRF 质量值', type: 'number', def: 21, min: 0, max: 51, col: 4 },
      { k: 'preset', label: '编码预设', type: 'select', def: 'fast', options: PRESETS, col: 4 },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '128k', options: ABITRATES, col: 4 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const parts = (v.size === 'custom' ? `${v.cw || 1080}x${v.ch || 1920}` : (v.size || '1080x1920')).split('x');
      const W = Number(parts[0]) || 1080, Hh = Number(parts[1]) || 1920;
      const vf = v.fit === 'crop'
        ? `scale=${W}:${Hh}:force_original_aspect_ratio=increase,crop=${W}:${Hh},setsar=1`
        : `scale=${W}:${Hh}:force_original_aspect_ratio=decrease,pad=${W}:${Hh}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      const args = ['-vf', vf];
      if (v.fps) args.push('-r', v.fps);
      args.push('-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p');
      args.push(...H.videoQuality('crf', v.crf, 'libx264'));
      args.push(...H.preset(v.preset, 'libx264'));
      args.push('-c:a', 'aac', '-b:a', v.abitrate || '128k', '-ac', '2');
      args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          `输出统一为 ${W}x${Hh}，setsar=1 保证播放器不出现奇怪比例。`,
          'profile main + level 4.0 + yuv420p 是目前手机端兼容性最好的组合。'
        ]
      };
    }
  });

  defOp({
    id: 'format-multi-output',
    cat: 'format',
    name: '一次导出多个文件（MP4 + 音频）',
    desc: '同一条命令里同时导出 MP4 视频和一份音频文件，省一次解码时间。',
    tags: ['多输出', '同时导出', 'mp3', '批量'],
    outExt: 'mp4',
    fields: [
      { k: 'aformat', label: '同时导出的音频格式', type: 'select', def: 'mp3', col: 4, options: [
        { v: 'mp3', label: 'MP3' }, { v: 'm4a', label: 'M4A' }, { v: 'wav', label: 'WAV' }, { v: 'flac', label: 'FLAC' }
      ] },
      { k: 'afmtBitrate', label: '音频文件码率', type: 'select', def: '192k', options: ABITRATES, col: 4,
        showIf: (v) => ['mp3', 'm4a', 'opus'].includes(v.aformat) },
      { k: 'suffixAudio', label: '音频文件名后缀', type: 'text', def: '_audio', col: 4, hint: '视频文件用界面上的统一后缀，音频文件用这个后缀。' },
      ...vencFields('', {}),
      ...aencFields('', {}),
      { k: 'faststart', label: 'MP4 索引放到文件头', type: 'bool', def: true, col: 12 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const fmt = v.aformat || 'mp3';
      const aout = U.join(ctx.outputDir, U.stem(ctx.input) + (v.suffixAudio || '_audio') + '.' + fmt, ctx.platform);
      // 先写音频输出（-vn 只作用于它自己那一组参数），再写视频输出，顺序不能颠倒
      const args = [...audioFmtArgs(fmt, v.afmtBitrate), '-vn', aout];
      args.push(...vencArgs(v, ''), ...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          'FFmpeg 支持一条命令多个输出：参数是「一组一组的」，写在一个输出文件名之前的参数只对它生效。',
          '同时生成：' + U.base(aout) + '（音频） 与 ' + U.base(ctx.output) + '（视频）。'
        ],
        warnings: ['音频文件不会出现在界面的产物列表里，请到输出目录自行确认。']
      };
    }
  });

  defOp({
    id: 'format-audio-cover-video',
    cat: 'format',
    name: '音频 + 封面图合成视频',
    desc: '把一首歌或一段录音配上一张静态封面，做成能在视频平台播放的 MP4。',
    tags: ['封面', '音频转视频', '配图', '静态图'],
    inputKind: 'any',
    outExt: 'mp4',
    fields: [
      { k: 'cover', label: '封面图片路径', type: 'path', def: '', col: 8, placeholder: '如 C:\\图片\\cover.jpg' },
      { k: 'size', label: '输出分辨率', type: 'select', def: '1920x1080', col: 4, options: [
        { v: '1920x1080', label: '1920x1080' }, { v: '1280x720', label: '1280x720' }, { v: '1080x1080', label: '1080x1080' }
      ] },
      { k: 'crf', label: 'CRF 质量值', type: 'number', def: 20, min: 0, max: 51, col: 4 },
      { k: 'fps', label: '输出帧率', type: 'number', def: 2, min: 1, max: 30, col: 4, hint: '静态画面 2fps 足够，越小文件越小。' },
      { k: 'acopy', label: '音频原样复制', type: 'bool', def: true, col: 4 },
      { k: 'abitrate', label: '音频码率（重编码时）', type: 'select', def: '192k', options: ABITRATES, col: 4, showIf: (v) => !v.acopy },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const p = (v.size || '1920x1080').split('x');
      const W = Number(p[0]) || 1920, Hh = Number(p[1]) || 1080;
      const args = ['-map', '0:a', '-map', '1:v'];
      args.push('-vf', `scale=${W}:${Hh}:force_original_aspect_ratio=decrease,pad=${W}:${Hh}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
      args.push('-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p');
      args.push(...H.videoQuality('crf', v.crf, 'libx264'));
      args.push('-r', String(v.fps || 2));
      args.push(...(v.acopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', v.abitrate || '192k']));
      args.push('-shortest', '-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, { path: v.cover || '', args: ['-loop', '1', '-framerate', String(v.fps || 2)] }],
        args,
        notes: [
          '封面图用 -loop 1 反复读取，-shortest 让视频在音频结束时一起结束。',
          '输入框里请填音频文件（或任意文件），封面图在下面的字段里单独指定。'
        ],
        warnings: v.cover ? [] : ['还没有填写封面图路径，生成前必须补上。']
      };
    }
  });

  /* ================================================================
   * 编码质量与性能
   * ================================================================ */

  defOp({
    id: 'quality-crf',
    cat: 'quality',
    name: 'CRF 恒定质量压缩',
    desc: '最常用的压片方式：画质固定、体积自适应，比指定码率省心得多。',
    tags: ['crf', '压缩', '画质', '预设'],
    outExt: 'mp4',
    fields: [
      ...vencFields('', {}),
      { k: 'tune', label: '画质取向（tune）', type: 'select', def: 'none', col: 6, options: [
        { v: 'none', label: '不指定' },
        { v: 'film', label: 'film（实拍影片）' },
        { v: 'animation', label: 'animation（动画/卡通）' },
        { v: 'grain', label: 'grain（保留胶片噪点）' },
        { v: 'stillimage', label: 'stillimage（静态画面）' },
        { v: 'fastdecode', label: 'fastdecode（降低解码负担）' },
        { v: 'zerolatency', label: 'zerolatency（低延迟直播）' }
      ], showIf: (v) => /libx26[45]/.test(v.vcodec) },
      ...aencFields('', { defCodec: 'copy' }),
      { k: 'faststart', label: '索引放到文件头', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [...vencArgs(v, '')];
      if (v.tune && v.tune !== 'none' && /libx26[45]/.test(v.vcodec)) args.push('-tune', v.tune);
      args.push(...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          'CRF 参考值：18 接近无损、23 默认、28 明显压缩、32 只求能看。',
          '音频默认 copy 不重编码，避免为了压片反而二次损失音质。'
        ],
        warnings: hwWarnings(v.vcodec, ctx)
      };
    }
  });

  defOp({
    id: 'quality-bitrate',
    cat: 'quality',
    name: '目标码率压缩（单遍）',
    desc: '按“每分钟多少 MB”反推码率，输出体积可预测；代价是复杂画面会糊。',
    tags: ['码率', '体积', '单遍', 'bitrate'],
    outExt: 'mp4',
    fields: [
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'libx264', options: VCODECS, col: 6 },
      { k: 'bitrate', label: '目标平均码率', type: 'text', def: '2M', col: 6, placeholder: '如 2M / 1500k',
        hint: '1080p 建议 3M~6M，720p 建议 1.5M~3M。' },
      { k: 'preset', label: '编码预设', type: 'select', def: 'medium', options: PRESETS, col: 6, showIf: (v) => PRESET_RE.test(v.vcodec) },
      ...aencFields('', { defCodec: 'copy' }),
      { k: 'faststart', label: '索引放到文件头', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [...vencArgs({ vcodec: v.vcodec, qmode: 'bitrate', bitrate: v.bitrate, preset: v.preset }, '')];
      args.push(...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['单遍平均码率（ABR）由编码器自行分配码率，简单镜头会浪费、复杂镜头会糊。'],
        warnings: ['码率是平均值，实际文件大小会有 ±10% 浮动。', ...hwWarnings(v.vcodec, ctx)]
      };
    }
  });

  defOp({
    id: 'quality-two-pass',
    cat: 'quality',
    name: '两遍编码（自动先跑分析遍）',
    desc: '第一遍分析全片、第二遍按统计分配码率，同体积下画质明显优于单遍。耗时约为单遍的 2 倍。',
    tags: ['两遍', '2pass', '码率', '画质'],
    outExt: 'mp4',
    fields: [
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'libx264', options: [
        { v: 'libx264', label: 'libx264（H.264，-pass/-passlogfile）' },
        { v: 'libx265', label: 'libx265（H.265，-x265-params pass/stats）' }
      ], col: 6, hint: '两遍编码依赖统计日志，只有软件编码器支持；硬件编码请用单遍 + CQ。' },
      { k: 'bitrate', label: '目标平均码率', type: 'text', def: '3M', col: 6 },
      { k: 'preset', label: '编码预设（两遍保持一致）', type: 'select', def: 'medium', options: PRESETS, col: 6 },
      { k: 'passlog', label: '统计日志文件名前缀', type: 'text', def: '_passlog', col: 6,
        hint: 'x264 会生成 <前缀>-0.log 等文件；x265 的 stats 文件必须放在当前工作目录（路径里不能有冒号）。' },
      ...aencFields('', { defCodec: 'aac' }),
      { k: 'faststart', label: '索引放到文件头', type: 'bool', def: true, col: 6 },
      { k: 'fpsPassthrough', label: '两遍帧率直通（-fps_mode passthrough）', type: 'bool', def: true, col: 6,
        hint: '两遍帧序列一致时才不会出现 “2nd pass has more frames than 1st pass”。需要 FFmpeg 5.1 以上，老版本可关闭。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const isX265 = v.vcodec === 'libx265';
      const stem = U.slug(U.stem(ctx.input));
      const presetArg = H.preset(v.preset, v.vcodec || 'libx264');
      // -fps_mode passthrough 让两遍的帧序列完全一致，避免第二遍出现
      // “2nd pass has more frames than 1st pass” 后 libx264 崩溃
      const fpsArgs = v.fpsPassthrough ? ['-fps_mode', 'passthrough'] : [];
      const base = ['-c:v', isX265 ? 'libx265' : 'libx264', '-b:v', String(v.bitrate || '3M'), ...presetArg, ...fpsArgs];
      let pass1, pass2args, logNote;

      if (isX265) {
        // x265 的 stats 参数用冒号分隔，绝对路径里的 C: 会把参数串截断，
        // 因此这里只写文件名（相对当前工作目录），两遍都在同一个目录下执行。
        const stats = '_x265stats_' + stem + '.log';
        pass1 = [...base, '-x265-params', 'pass=1:stats=' + stats, '-an', '-f', 'null', '-'];
        pass2args = [...base, '-x265-params', 'pass=2:stats=' + stats];
        logNote = '统计文件：' + stats + '（生成在当前工作目录，两遍必须同一目录执行）与 ' + stats + '.cutree。';
      } else {
        const log = U.join(ctx.outputDir, (v.passlog || '_passlog') + '_' + stem, ctx.platform);
        pass1 = [...base, '-pass', '1', '-passlogfile', log, '-an', '-f', 'null', '-'];
        pass2args = [...base, '-pass', '2', '-passlogfile', log];
        logNote = '统计日志：' + log + '（以及 -0.log、-0.log.mbtree）由第一遍自动生成，第二遍读取。';
      }

      const args = [...pass2args];
      args.push(...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));

      return {
        args,
        before: [{
          name: '两遍编码 · 第一遍（只生成统计日志）',
          args: pass1,
          output: '',
          notes: ['第一遍只分析画面并写统计日志，不产生成品文件，跑完自动接第二遍。']
        }],
        notes: [
          '第一遍命令已作为「准备命令」排在前面，一键执行即可完成两遍编码。',
          logNote,
          isX265 ? 'x265 两遍采用 -x265-params pass=1/2:stats=… 的写法。' : 'x264 两遍采用 -pass 1/2 与 -passlogfile 的写法。'
        ],
        warnings: [
          '两遍必须使用完全相同的输入处理参数（预设、fps_mode），否则会报帧数不一致。',
          '如果只单独执行第二遍，会因为没有统计日志而失败——请让脚本从第一遍开始跑。'
        ]
      };
    }
  });

  defOp({
    id: 'quality-maxrate-bufsize',
    cat: 'quality',
    name: '限制最大码率与缓冲区（VBV）',
    desc: '防止码率尖峰导致卡顿或超出平台上限，直播推流、平台投稿前的必备设置。',
    tags: ['maxrate', 'bufsize', 'vbv', '推流'],
    outExt: 'mp4',
    fields: [
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'libx264', options: VCODECS, col: 4 },
      { k: 'bitrate', label: '平均码率', type: 'text', def: '4M', col: 3 },
      { k: 'maxrate', label: '最大码率', type: 'text', def: '6M', col: 3, hint: '一般取平均码率的 1.5~2 倍。' },
      { k: 'bufsize', label: '缓冲区大小', type: 'text', def: '8M', col: 3, hint: '越小码率越平稳、画质波动越大。' },
      { k: 'preset', label: '编码预设', type: 'select', def: 'medium', options: PRESETS, col: 3, showIf: (v) => PRESET_RE.test(v.vcodec) },
      { k: 'cbr', label: '强制恒定码率（CBR）', type: 'bool', def: false, col: 6,
        hint: '把 minrate 设为与平均码率相同，并写入 nal-hrd=cbr，用于严格带宽受限的推流。' },
      ...aencFields('', { defCodec: 'copy' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-c:v', v.vcodec];
      args.push('-b:v', String(v.bitrate || '4M'), '-maxrate', String(v.maxrate || '6M'), '-bufsize', String(v.bufsize || '8M'));
      if (v.cbr) {
        args.push('-minrate', String(v.bitrate || '4M'));
        if (/libx264/.test(v.vcodec)) args.push('-x264-params', 'nal-hrd=cbr');
      }
      if (PRESET_RE.test(v.vcodec)) args.push(...H.preset(v.preset, v.vcodec));
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['VBV（-maxrate/-bufsize）限制的是「任意 bufsize 窗口内的瞬时码率」，而不是平均码率。'],
        warnings: [
          'CBR 适合推流，不适合存档：固定码率会浪费简单镜头的体积。',
          ...hwWarnings(v.vcodec, ctx)
        ]
      };
    }
  });

  defOp({
    id: 'quality-gop',
    cat: 'quality',
    name: '设定 GOP 与关键帧间隔',
    desc: '控制关键帧密度，影响拖动定位速度、切片上传与直播延迟。',
    tags: ['gop', '关键帧', 'keyint', '切片'],
    outExt: 'mp4',
    fields: [
      { k: 'g', label: 'GOP 长度（每 N 帧一个关键帧）', type: 'number', def: 250, min: 1, col: 4,
        hint: '常用「帧率 × 2」：30fps 用 60，25fps 用 50；太小会显著增大体积。' },
      { k: 'keyintMin', label: '最小关键帧间隔', type: 'number', def: 25, min: 0, col: 4, hint: '防止场景切换过于频繁地插入关键帧。' },
      { k: 'scThreshold', label: '场景切换阈值', type: 'number', def: 0, min: -1, max: 100, col: 4,
        hint: '0 = 关闭场景切换检测（固定 GOP，适合 HLS/直播切片）。' },
      { k: 'forceKey', label: '强制按时间间隔插入关键帧', type: 'bool', def: false, col: 6 },
      { k: 'forceSec', label: '强制间隔（秒）', type: 'number', def: 2, min: 0.1, step: 0.1, col: 6, showIf: (v) => v.forceKey },
      ...vencFields('', { defQmode: 'crf' }),
      ...aencFields('', { defCodec: 'copy' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-g', String(v.g || 250), '-keyint_min', String(v.keyintMin || 0), '-sc_threshold', String(v.scThreshold || 0)];
      if (v.forceKey) args.push('-force_key_frames', `expr:gte(t,n_forced*${Number(v.forceSec) || 2})`);
      args.push(...vencArgs(v, ''), ...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          '-sc_threshold 0 会关闭场景切换检测，GOP 长度严格固定，是 HLS / DASH 切片的标准做法。',
          '关键帧越多，拖进度条越快、切片越规整，但体积也会变大。'
        ],
        warnings: hwWarnings(v.vcodec, ctx)
      };
    }
  });

  defOp({
    id: 'quality-hw-accel',
    cat: 'quality',
    name: '硬件加速编码（NVIDIA / Intel / AMD / Apple / VA-API）',
    desc: '用显卡编码，速度可达软件的 5~20 倍，代价是同码率画质略差、兼容性依赖驱动。',
    tags: ['硬件加速', 'nvenc', 'qsv', 'amf', 'vaapi'],
    outExt: 'mp4',
    fields: [
      { k: 'accel', label: '加速方案', type: 'select', def: 'nvenc', col: 4, options: [
        { v: 'nvenc', label: 'NVIDIA NVENC' },
        { v: 'qsv', label: 'Intel Quick Sync (QSV)' },
        { v: 'amf', label: 'AMD AMF' },
        { v: 'videotoolbox', label: 'Apple VideoToolbox' },
        { v: 'vaapi', label: 'Linux VA-API' }
      ] },
      { k: 'codec', label: '编码格式', type: 'select', def: 'h264', col: 4, options: [
        { v: 'h264', label: 'H.264' }, { v: 'hevc', label: 'H.265' }
      ] },
      { k: 'quality', label: '质量值（CQ/QP，越小越好）', type: 'number', def: 23, min: 0, max: 51, col: 4 },
      { k: 'preset', label: '速度档位', type: 'select', def: 'medium', options: PRESETS, col: 4, showIf: (v) => v.accel === 'nvenc' || v.accel === 'qsv' },
      { k: 'lookahead', label: '开启前瞻码率控制', type: 'bool', def: true, col: 4, showIf: (v) => v.accel === 'nvenc' || v.accel === 'qsv' },
      { k: 'aq', label: '开启空间/时间自适应量化', type: 'bool', def: true, col: 4, showIf: (v) => v.accel === 'nvenc' },
      { k: 'allowSw', label: '允许回退到软件编码', type: 'bool', def: true, col: 4, showIf: (v) => v.accel === 'videotoolbox' },
      { k: 'device', label: 'VA-API 设备节点', type: 'text', def: '/dev/dri/renderD128', col: 8, showIf: (v) => v.accel === 'vaapi' },
      ...aencFields('', { defCodec: 'copy' }),
      { k: 'faststart', label: '索引放到文件头', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const MAP = {
        nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' },
        qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv' },
        amf: { h264: 'h264_amf', hevc: 'hevc_amf' },
        videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
        vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi' }
      };
      const enc = (MAP[v.accel] || MAP.nvenc)[v.codec || 'h264'];
      const q = Number(v.quality);
      const preArgs = [];
      const args = ['-c:v', enc];
      if (v.accel === 'nvenc') {
        args.push('-rc', 'vbr', '-cq', String(q), '-b:v', '0');
        if (v.preset) args.push(...H.preset(v.preset, enc));
        args.push('-tune', 'hq');
        if (v.lookahead) args.push('-rc-lookahead', '32');
        if (v.aq) args.push('-spatial_aq', '1', '-temporal_aq', '1');
        args.push('-pix_fmt', 'yuv420p');
      } else if (v.accel === 'qsv') {
        args.push('-global_quality', String(q));
        if (v.preset) args.push(...H.preset(v.preset, enc));
        if (v.lookahead) args.push('-look_ahead', '1');
        args.push('-pix_fmt', 'nv12');
      } else if (v.accel === 'amf') {
        args.push('-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q), '-quality', 'balanced', '-pix_fmt', 'yuv420p');
      } else if (v.accel === 'videotoolbox') {
        args.push(...H.videoQuality('crf', q, enc));
        if (v.allowSw) args.push('-allow_sw', '1');
        args.push('-pix_fmt', 'yuv420p');
      } else {
        preArgs.push('-vaapi_device', v.device || '/dev/dri/renderD128');
        args.push('-vf', 'format=nv12,hwupload', '-qp', String(q));
      }
      args.push(...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        preArgs, args,
        notes: [
          '硬件编码用「恒定质量」模式（CQ/QP/QP 值）而不是 CRF，不同驱动的数值含义略有差别。',
          'VA-API 需要先把画面 hwupload 到显存，所以多了一个 -vf format=nv12,hwupload。'
        ],
        warnings: ['同码率下硬件编码画质普遍略低于软件编码，追求画质请用 libx264/libx265。', ...hwWarnings(enc, ctx)]
      };
    }
  });

  defOp({
    id: 'quality-threads',
    cat: 'quality',
    name: '多线程与性能调节',
    desc: '手工指定编码线程数与滤镜线程数，避免编码器吃满 CPU 导致机器卡死。',
    tags: ['线程', 'threads', '性能', '多核'],
    outExt: 'mp4',
    fields: [
      { k: 'threads', label: '编码线程数（0 = 自动）', type: 'number', def: 0, min: 0, col: 4, hint: 'x264 一般留 0 自动；要和其它程序抢 CPU 时再限制。' },
      { k: 'threadType', label: '线程类型', type: 'select', def: 'auto', col: 4, options: [
        { v: 'auto', label: '自动（推荐）' },
        { v: 'frame', label: 'frame（帧级并行，压缩率更高）' },
        { v: 'slice', label: 'slice（片级并行，延迟更低）' }
      ] },
      { k: 'filterThreads', label: '滤镜线程数（0 = 自动）', type: 'number', def: 0, min: 0, col: 4 },
      ...vencFields('', {}),
      ...aencFields('', { defCodec: 'copy' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const preArgs = [];
      if (Number(v.filterThreads) > 0) preArgs.push('-filter_threads', String(v.filterThreads));
      const args = [];
      if (Number(v.threads) > 0) args.push('-threads', String(v.threads));
      if (v.threadType && v.threadType !== 'auto') args.push('-thread_type', v.threadType);
      args.push(...vencArgs(v, ''), ...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args, preArgs,
        notes: [
          '-threads 0 表示由 FFmpeg 根据 CPU 核心数自动决定，绝大多数情况是最优的。',
          '帧级并行（frame）压缩率更好；需要低延迟时用片级并行（slice）。'
        ],
        warnings: ['线程数并非越大越快，超过物理核心数反而会因为调度开销变慢。']
      };
    }
  });

  defOp({
    id: 'quality-fs-limit',
    cat: 'quality',
    name: '限制输出文件大小（-fs）',
    desc: '写到指定体积就自动停止，用于「必须小于 N MB」的投稿或传输场景。',
    tags: ['文件大小', 'fs', '限制', '体积'],
    outExt: 'mkv',
    fields: [
      { k: 'maxMB', label: '最大体积（MB）', type: 'number', def: 100, min: 1, col: 4 },
      { k: 'vcodec', label: '视频编码器', type: 'select', def: 'libx264', options: VCODECS, col: 4 },
      { k: 'bitrate', label: '预估平均码率（用于尽量压满体积）', type: 'text', def: '2M', col: 4,
        hint: '可按「目标 MB × 8 ÷ 时长秒」估算，例如 100MB / 10 分钟 ≈ 1.3M。' },
      { k: 'preset', label: '编码预设', type: 'select', def: 'medium', options: PRESETS, col: 6, showIf: (v) => PRESET_RE.test(v.vcodec) },
      ...aencFields('', { defCodec: 'aac' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const bytes = Math.round((Number(v.maxMB) || 100) * 1024 * 1024);
      const args = ['-fs', String(bytes), '-c:v', v.vcodec, '-b:v', String(v.bitrate || '2M')];
      if (PRESET_RE.test(v.vcodec)) args.push(...H.preset(v.preset, v.vcodec));
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-fs 的单位是字节，这里已按 MB 换算好；到达上限时 FFmpeg 会立即停止写入。'],
        warnings: [
          '被 -fs 截断的文件缺少结尾索引，MP4 可能无法播放或无法拖动；推荐输出 MKV。',
          '更稳妥的做法是用两遍编码精确命中目标体积。'
        ]
      };
    }
  });

  defOp({
    id: 'quality-compress-optimize',
    cat: 'quality',
    name: '极致压缩（慢速预设 + tune 优化）',
    desc: '用 veryslow 预设与 x264 高级参数把体积压到最小，用时间换体积。',
    tags: ['压缩', 'veryslow', '体积', 'x264 参数'],
    outExt: 'mp4',
    fields: [
      { k: 'crf', label: 'CRF 值', type: 'number', def: 20, min: 0, max: 51, col: 3 },
      { k: 'preset', label: '编码预设', type: 'select', def: 'veryslow', options: PRESETS, col: 3 },
      { k: 'tune', label: '画质取向', type: 'select', def: 'film', col: 3, options: [
        { v: 'film', label: 'film（实拍）' }, { v: 'animation', label: 'animation（动画）' },
        { v: 'grain', label: 'grain（保留噪点）' }, { v: 'none', label: '不指定' }
      ] },
      { k: 'profile', label: 'H.264 Profile', type: 'select', def: 'high', col: 3, options: [
        { v: 'high', label: 'high（推荐）' }, { v: 'main', label: 'main' }, { v: 'baseline', label: 'baseline（兼容最老设备）' }
      ] },
      { k: 'x264params', label: 'x264 高级参数', type: 'text', def: 'ref=5:bframes=8:subme=10:me=umh:trellis=2', col: 12,
        hint: '形如 key=value:key=value。不确定就保持默认，写错会导致编码失败。' },
      ...aencFields('', { defCodec: 'copy' }),
      { k: 'faststart', label: '索引放到文件头', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-c:v', 'libx264', '-crf', String(v.crf), '-preset', v.preset || 'veryslow'];
      if (v.tune && v.tune !== 'none') args.push('-tune', v.tune);
      if (v.profile) args.push('-profile:v', v.profile);
      if (String(v.x264params || '').trim()) args.push('-x264-params', String(v.x264params).trim());
      args.push('-pix_fmt', 'yuv420p');
      args.push(...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          'veryslow 相比 medium 体积一般只小 5%~10%，耗时却是 3~5 倍，请权衡后再用。',
          'ref/bframes/subme 等参数受 profile 与 level 限制，编码器会自动下调。'
        ],
        warnings: ['x264 高级参数写错会让整个编码失败，建议先用 10 秒短片验证。']
      };
    }
  });

  defOp({
    id: 'quality-hevc',
    cat: 'quality',
    name: 'H.265 高压缩转码',
    desc: '同画质比 H.264 省 30%~50% 体积，适合长期存档；老设备与浏览器可能放不出来。',
    tags: ['h265', 'hevc', '压缩', '归档'],
    outExt: 'mp4',
    fields: [
      { k: 'vcodec', label: 'H.265 编码器', type: 'select', def: 'libx265', col: 6, options: [
        { v: 'libx265', label: 'libx265（软件，压缩率最高）' },
        { v: 'hevc_nvenc', label: 'hevc_nvenc（NVIDIA）' },
        { v: 'hevc_qsv', label: 'hevc_qsv（Intel）' },
        { v: 'hevc_amf', label: 'hevc_amf（AMD）' },
        { v: 'hevc_videotoolbox', label: 'hevc_videotoolbox（Apple）' },
        { v: 'copy', label: 'copy（源本来就是 H.265，仅换壳）' }
      ] },
      { k: 'crf', label: 'CRF 值（H.265 建议 24~30）', type: 'number', def: 26, min: 0, max: 51, col: 6 },
      { k: 'preset', label: '编码预设', type: 'select', def: 'medium', options: PRESETS, col: 6, showIf: (v) => PRESET_RE.test(v.vcodec) },
      { k: 'tagHvc1', label: '打上 hvc1 标记（Apple / Safari 必需）', type: 'bool', def: true, col: 6 },
      { k: 'x265params', label: 'x265 高级参数（可选）', type: 'text', def: '', col: 12,
        placeholder: '如 aq-mode=3:rd=4:log-level=error',
        hint: '仅 libx265 有效；参数用冒号分隔，注意不要写进含冒号的 Windows 路径。' },
      ...aencFields('', { defCodec: 'copy' }),
      { k: 'faststart', label: '索引放到文件头', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.vcodec === 'copy') args.push('-c:v', 'copy');
      else {
        args.push('-c:v', v.vcodec);
        args.push(...H.videoQuality('crf', v.crf, v.vcodec));
        if (PRESET_RE.test(v.vcodec)) args.push(...H.preset(v.preset, v.vcodec));
        if (/amf$/.test(v.vcodec)) args.push('-quality', 'balanced');
        if (/libx265/.test(v.vcodec) && String(v.x265params || '').trim()) args.push('-x265-params', String(v.x265params).trim());
        args.push('-pix_fmt', 'yuv420p');
      }
      if (v.tagHvc1 && v.vcodec !== 'copy') args.push('-tag:v', 'hvc1');
      args.push(...aencArgs(v, ''));
      if (v.faststart) args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          'hvc1 与 hev1 的区别只在容器标记：hvc1 把参数集放进 moov，Apple 设备只认 hvc1。',
          'H.265 在浏览器里的支持仍然有限，网页播放请优先选 H.264。'
        ],
        warnings: hwWarnings(v.vcodec, ctx)
      };
    }
  });

  /* ================================================================
   * 流与元数据
   * ================================================================ */

  defOp({
    id: 'stream-remove-audio',
    cat: 'stream',
    name: '删除所有音频（-an）',
    desc: '生成纯画面文件，用于素材、静音预览或二次配音。',
    tags: ['删除音频', '静音', 'an'],
    outExt: (v) => (v.mode === 'copy' ? 'mkv' : 'mp4'),
    fields: [
      { k: 'mode', label: '视频处理方式', type: 'select', def: 'copy', col: 6, options: [
        { v: 'copy', label: '不重编码（秒完成，推荐）' },
        { v: 'reencode', label: '重新编码（可顺带调画质）' }
      ] },
      { k: 'crf', label: 'CRF 质量值', type: 'number', def: 20, min: 0, max: 51, col: 6, showIf: (v) => v.mode === 'reencode' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-an'];
      if (v.mode === 'reencode') args.push('-c:v', 'libx264', ...H.videoQuality('crf', v.crf, 'libx264'), '-preset', 'medium', '-pix_fmt', 'yuv420p');
      else args.push('-c:v', 'copy');
      args.push(...H.parseExtra(v.extra));
      return { args, notes: ['-an 是输出选项，写在输出文件之前即可。'] };
    }
  });

  defOp({
    id: 'stream-remove-video',
    cat: 'stream',
    name: '删除所有视频（-vn，只留声音）',
    desc: '只要音轨时的一种偷懒写法，输出通常是 M4A 或 MKV。',
    tags: ['删除视频', 'vn', '只要音频'],
    outExt: (v) => ({ copy: 'mka', none: 'mka', libmp3lame: 'mp3', flac: 'flac', aac: 'm4a' }[v.acodec] || 'm4a'),
    fields: [
      { k: 'acodec', label: '音频编码', type: 'select', def: 'aac', col: 6, options: [
        { v: 'aac', label: 'aac（输出 M4A）' },
        { v: 'libmp3lame', label: 'mp3' },
        { v: 'flac', label: 'flac（无损）' },
        { v: 'copy', label: 'copy（原样保留，输出 MKA）' },
        { v: 'none', label: '连音频也不要（空壳，慎用）' }
      ] },
      { k: 'abitrate', label: '音频码率', type: 'select', def: '192k', options: ABITRATES, col: 6, showIf: (v) => !NO_BITRATE.includes(v.acodec) },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-vn', ...aencArgs(v, '')];
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['使用 -vn 时容器必须只装音频，因此输出扩展名会随编码自动变化。'],
        warnings: v.acodec === 'none' ? ['同时去掉视频和音频会生成一个没有任何流的空文件。'] : []
      };
    }
  });

  defOp({
    id: 'stream-keep-audio-track',
    cat: 'stream',
    name: '只保留指定音轨',
    desc: '多语言影片只留下想要的那条音轨，或把某一条音轨单独抽出来。',
    tags: ['音轨', 'map', '多语言', '选择'],
    outExt: (v) => (v.copyAll ? 'mkv' : 'mp4'),
    fields: [
      { k: 'index', label: '音轨编号（从 0 开始）', type: 'number', def: 0, min: 0, col: 4,
        hint: '第 1 条音轨是 0，第 2 条是 1。可用界面上的「媒体信息」查看。' },
      { k: 'keep', label: '除了这条音轨还要保留', type: 'select', def: 'audio', col: 4, options: [
        { v: 'audio', label: '只保留这条音轨' },
        { v: 'av', label: '视频 + 这条音轨' },
        { v: 'avs', label: '视频 + 这条音轨 + 全部字幕' }
      ] },
      { k: 'optional', label: '编号不存在时忽略而不是报错（?）', type: 'bool', def: true, col: 4 },
      { k: 'copyAll', label: '全部流原样复制（-c copy）', type: 'bool', def: true, col: 6 },
      { k: 'abitrate', label: '重编码时的音频码率', type: 'select', def: '192k', options: ABITRATES, col: 6, showIf: (v) => !v.copyAll },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const i = Number(v.index) || 0;
      const q = v.optional ? '?' : '';
      const args = [];
      if (v.keep === 'audio') args.push('-map', `0:a:${i}${q}`);
      else if (v.keep === 'av') args.push('-map', '0:v', '-map', `0:a:${i}${q}`);
      else args.push('-map', '0:v', '-map', `0:a:${i}${q}`, '-map', '0:s?');
      if (v.copyAll) args.push('-c', 'copy');
      else args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', v.abitrate || '192k');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-map 后面的 ? 表示「该轨道不存在时忽略」，多语言素材上用它最保险。'],
        warnings: v.copyAll ? ['某些容器（如 MP4）不接受部分音频编码，若报错请改输出 MKV。'] : []
      };
    }
  });

  defOp({
    id: 'stream-keep-subtitle-track',
    cat: 'stream',
    name: '只保留指定字幕轨',
    desc: '抽取某一条字幕，转换格式或连同画面一起带走。',
    tags: ['字幕', 'map', 'subtitle', '抽取'],
    outExt: (v) => (v.subFormat === 'copy' ? 'mkv' : (v.subFormat === 'mov_text' ? 'mp4' : v.subFormat)),
    fields: [
      { k: 'index', label: '字幕轨编号（从 0 开始）', type: 'number', def: 0, min: 0, col: 4 },
      { k: 'subFormat', label: '字幕输出格式', type: 'select', def: 'mov_text', col: 8, options: [
        { v: 'mov_text', label: 'mov_text（MP4 内嵌文本字幕）' },
        { v: 'srt', label: 'srt（独立字幕文件）' },
        { v: 'ass', label: 'ass（带样式）' },
        { v: 'webvtt', label: 'webvtt（网页字幕）' },
        { v: 'copy', label: 'copy（原样复制，输出 MKV）' }
      ] },
      { k: 'keepVideo', label: '同时保留视频', type: 'bool', def: false, col: 6 },
      { k: 'keepAudio', label: '同时保留音频', type: 'bool', def: false, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const textOnly = ['srt', 'ass', 'webvtt'].includes(v.subFormat);
      const args = [];
      // 纯文本字幕文件装不下视频轨，此时强制只输出字幕
      if (!textOnly && v.keepVideo) args.push('-map', '0:v');
      if (!textOnly && v.keepAudio) args.push('-map', '0:a?');
      args.push('-map', `0:s:${Number(v.index) || 0}?`);
      if (v.subFormat === 'copy') args.push('-c', 'copy');
      else {
        if (!textOnly && v.keepVideo) args.push('-c:v', 'copy');
        if (!textOnly && v.keepAudio) args.push('-c:a', 'copy');
        args.push('-c:s', v.subFormat);
      }
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: textOnly
          ? ['输出的是独立的字幕文本文件，所以忽略了「同时保留视频/音频」选项。']
          : ['mov_text 是 MP4 的内置文本字幕格式，播放器可开关字幕。'],
        warnings: [
          '图像型字幕（PGS / VOBSUB / DVB）无法转成 srt/ass，只能选择 copy。',
          '若目标容器不支持所选字幕格式，FFmpeg 会报错，请改输出 MKV。'
        ]
      };
    }
  });

  defOp({
    id: 'stream-swap-tracks',
    cat: 'stream',
    name: '交换音视频轨道顺序',
    desc: '让播放器默认选中另一条轨道，比如把国语放到第 1 条，或把字幕排到最前。',
    tags: ['轨道顺序', 'map', '重排', '默认轨'],
    outExt: 'mkv',
    fields: [
      { k: 'order', label: '轨道顺序', type: 'select', def: 'av', col: 6, options: [
        { v: 'av', label: '音频在前，视频在后' },
        { v: 'va', label: '视频在前，音频在后' },
        { v: 'custom', label: '自定义 -map 顺序' }
      ] },
      { k: 'maps', label: '自定义 map（每行一个）', type: 'textarea', def: '0:a:0\n0:v:0\n0:s?', col: 6, showIf: (v) => v.order === 'custom',
        hint: '每行一个流选择器，如 0:v:0、0:a:1、0:s?。' },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.order === 'custom') {
        const list = String(v.maps || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (list.length) list.forEach((m) => args.push('-map', m));
        else args.push('-map', '0');
      } else if (v.order === 'av') {
        args.push('-map', '0:a', '-map', '0:v', '-map', '0:s?', '-map', '0:d?');
      } else {
        args.push('-map', '0:v', '-map', '0:a', '-map', '0:s?', '-map', '0:d?');
      }
      args.push(...(v.copyAll ? ['-c', 'copy'] : ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k']));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-map 的书写顺序就是输出文件的轨道顺序，播放器默认选第一条。'],
        warnings: ['重排轨道不会改变编码，但会让输出与原始文件不再逐字节一致。']
      };
    }
  });

  defOp({
    id: 'stream-default-track',
    cat: 'stream',
    name: '把第 N 条音轨设为默认',
    desc: '多语言视频时指定播放器优先播放哪条音轨，并清除其它轨道的默认标记。',
    tags: ['默认音轨', 'disposition', '多语言'],
    outExt: 'mkv',
    fields: [
      { k: 'index', label: '要设为默认的音轨编号（从 0 开始）', type: 'number', def: 1, min: 0, col: 6 },
      { k: 'clearOthers', label: '清除其它音轨的默认标记', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const idx = Number(v.index) || 0;
      const args = ['-map', '0', '-c', 'copy'];
      if (v.clearOthers) {
        for (let i = 0; i < idx; i++) args.push(`-disposition:a:${i}`, '0');
      }
      args.push(`-disposition:a:${idx}`, 'default');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-disposition:a:N 里的 N 是「输出文件中的第 N 条音频轨」，与 -map 的顺序有关。', 'default 表示播放器优先选择，0 表示不做任何标记。'],
        warnings: ['同一条流被标记为多条默认音轨时，播放器的选择是不确定的，所以建议同时清除其它默认标记。']
      };
    }
  });

  defOp({
    id: 'stream-add-language',
    cat: 'stream',
    name: '添加多语言音轨标记',
    desc: '给音轨打上语言与名称标签，播放器会显示「English / 中文」之类的轨道名。',
    tags: ['语言', 'metadata', '音轨名', '多语言'],
    outExt: 'mkv',
    fields: [
      { k: 'marks', label: '轨道标记（每行一条：轨道 键=值）', type: 'textarea', def: 'a:0 language=eng\na:0 title=English\na:1 language=chi\na:1 title=中文',
        col: 12, hint: '轨道写法 v/a/s + 序号，例如 a:0 表示第 1 条音轨。语言用 ISO 639-2 三字母代码：eng、chi、jpn、kor、fra…' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const lines = String(v.marks || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const args = ['-map', '0', '-c', 'copy'];
      const bad = [];
      lines.forEach((ln) => {
        const m = ln.match(/^(\S+)\s+(\S+?)=(.*)$/);
        if (!m) { bad.push(ln); return; }
        const spec = /^s:/.test(m[1]) ? m[1] : 's:' + m[1];
        args.push('-metadata:' + spec, m[2] + '=' + m[3]);
      });
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-metadata:s:a:0 language=eng 里的 s: 表示 stream 级别，a:0 是第 1 条音轨。'],
        warnings: bad.length ? ['这些行格式不对，已忽略（正确写法：a:0 language=eng）：' + bad.join(' / ')] : []
      };
    }
  });

  defOp({
    id: 'stream-clear-metadata',
    cat: 'stream',
    name: '清除所有元数据',
    desc: '抹掉标题、作者、拍摄设备、GPS 等信息，上传前保护隐私或避免平台误判。',
    tags: ['元数据', '隐私', '清除', 'map_metadata'],
    outExt: 'mkv',
    fields: [
      { k: 'clearChapters', label: '同时清除章节', type: 'bool', def: true, col: 6 },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.copyAll) args.push('-c', 'copy', '-map', '0');
      args.push('-map_metadata', '-1');
      if (v.clearChapters) args.push('-map_chapters', '-1');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['-1 表示「不复制任何元数据」，这是清空的官方写法。'],
        warnings: ['清除后无法恢复，建议先保留原始文件。']
      };
    }
  });

  defOp({
    id: 'stream-set-metadata',
    cat: 'stream',
    name: '设置标题 / 作者 / 注释等元数据',
    desc: '给片子补上标题、作者、专辑、年份、备注等信息，也能写自定义字段。',
    tags: ['元数据', '标题', '作者', '标签'],
    outExt: (v) => (v.container || 'mkv'),
    fields: [
      { k: 'title', label: '标题', type: 'text', def: '', col: 6 },
      { k: 'artist', label: '作者 / 艺术家', type: 'text', def: '', col: 6 },
      { k: 'album', label: '专辑 / 系列', type: 'text', def: '', col: 6 },
      { k: 'date', label: '日期 / 年份', type: 'text', def: '', col: 6, placeholder: '如 2025' },
      { k: 'genre', label: '类型', type: 'text', def: '', col: 6 },
      { k: 'comment', label: '注释', type: 'text', def: '', col: 6 },
      { k: 'custom', label: '自定义字段（每行 key=value）', type: 'textarea', def: '', col: 8,
        placeholder: 'description=我的视频说明\nescape=示例' },
      { k: 'keepExisting', label: '保留原有元数据', type: 'bool', def: true, col: 4 },
      { k: 'container', label: '输出容器', type: 'select', def: 'mkv', col: 6, options: [
        { v: 'mkv', label: 'MKV' }, { v: 'mp4', label: 'MP4' }
      ] },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.copyAll) args.push('-c', 'copy', '-map', '0');
      if (!v.keepExisting) args.push('-map_metadata', '-1');
      const set = { title: v.title, artist: v.artist, album: v.album, date: v.date, genre: v.genre, comment: v.comment };
      Object.keys(set).forEach((k) => { if (String(set[k] || '').trim()) args.push('-metadata', k + '=' + String(set[k]).trim()); });
      String(v.custom || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((ln) => {
        const i = ln.indexOf('=');
        if (i > 0) args.push('-metadata', ln.slice(0, i).trim() + '=' + ln.slice(i + 1).trim());
      });
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          'MP4 的全局标签写在 moov 里，用 -movflags +faststart 时可随文件头一起前置。',
          'MKV 的字段名更自由，未知的 key 也能被写入。'
        ],
        warnings: ['不同播放器对字段名的支持不一致，title / artist / comment 是最通用的三个。']
      };
    }
  });

  defOp({
    id: 'stream-chapters',
    cat: 'stream',
    name: '添加章节（可跳转的目录）',
    desc: '给视频写入章节，播放器进度条上会出现分段标记，可按章节跳转。',
    tags: ['章节', 'chapters', '目录', '跳转'],
    outExt: 'mkv',
    fields: [
      { k: 'chapters', label: '章节列表（每行：时间 标题）', type: 'textarea', def: '00:00:00 开场\n00:01:30 第一部分\n00:03:00 结尾',
        col: 12, hint: '时间支持 00:01:30 或 90（秒），必须按时间递增排列。' },
      { k: 'endAt', label: '最后一个章节的结束时间（留空则到文件末尾）', type: 'time', def: '', col: 6 },
      { k: 'fileName', label: '章节文件名', type: 'text', def: '_chapters.txt', col: 6,
        hint: '会作为附属文件写入输出目录，命令行执行前必须保证它存在。' },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const name = v.fileName || '_chapters.txt';
      const path = U.join(ctx.outputDir, name, ctx.platform);
      const text = buildChapterFile(v.chapters, v.endAt);
      const args = ['-map', '0'];
      args.push(...(v.copyAll ? ['-c', 'copy'] : ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k']));
      args.push('-map_metadata', '1', '-map_chapters', '1');
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, path],
        args,
        aux: [{ name, path, content: text, lang: 'text' }],
        notes: [
          '章节文件采用 FFMETADATA1 格式，已按你填的时间自动生成。',
          '-map_metadata 1 -map_chapters 1 表示从第 2 个输入（章节文件）读取章节信息。'
        ],
        warnings: [
          '命令行执行前必须先把章节文件写到 ' + path + '，否则会报找不到输入文件。',
          'AVI 容器不支持章节，请输出 MP4 或 MKV。'
        ]
      };
    }
  });

  defOp({
    id: 'stream-faststart',
    cat: 'stream',
    name: '把 moov 移到文件头（faststart）',
    desc: '让网页播放器与手机可以边下边播，不用先下载完整文件。这是网站投稿的必做一步。',
    tags: ['faststart', 'moov', '网页播放', '秒开'],
    outExt: (v) => (v.container || 'mp4'),
    fields: [
      { k: 'container', label: '输出容器', type: 'select', def: 'mp4', col: 6, options: [
        { v: 'mp4', label: 'MP4' }, { v: 'mov', label: 'MOV' }
      ] },
      { k: 'streams', label: '轨道选择', type: 'select', def: 'va', col: 6, options: [
        { v: 'va', label: '只留视频与音频（推荐）' },
        { v: 'all', label: '全部轨道（-map 0）' }
      ], hint: 'MP4 不支持 subrip/PGS 等字幕轨，选「全部轨道」时可能报容器不支持该编码。' },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.copyAll) {
        args.push('-c', 'copy');
        args.push(...(v.streams === 'all' ? ['-map', '0'] : ['-map', '0:v', '-map', '0:a']));
      }
      args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: ['只是重新排布 moov 与 mdat 的位置，不碰任何编码数据，几秒完成、画质零损失。'],
        warnings: [
          'FFmpeg 需要额外的临时空间与一次完整写入，超大文件请确保磁盘充足。',
          ...(v.streams === 'all' ? ['若源包含 subrip/PGS 等字幕轨，MP4 容器会拒绝写入，请改用「只留视频与音频」。'] : [])
        ]
      };
    }
  });

  defOp({
    id: 'stream-fix-timestamps',
    cat: 'stream',
    name: '修复时间戳问题（进度条乱跳 / 音画不同步）',
    desc: '重新生成 PTS、修正负时间戳，解决拖不动进度条、时长显示错误等毛病。',
    tags: ['时间戳', 'genpts', '音画同步', '修复'],
    outExt: (v) => (v.mode === 'copy' ? 'mkv' : 'mp4'),
    fields: [
      { k: 'fflags', label: '输入文件标志', type: 'select', def: '+genpts', col: 6, options: [
        { v: '+genpts', label: '+genpts（缺失时间戳时自动生成）' },
        { v: '+genpts+igndts', label: '+genpts+igndts（忽略原有 DTS，最常用）' },
        { v: '+genpts+igndts+discardcorrupt', label: '+genpts+igndts+discardcorrupt（顺带丢弃损坏帧）' },
        { v: '+discardcorrupt', label: '+discardcorrupt（只丢弃损坏帧）' },
        { v: '', label: '不设置' }
      ] },
      { k: 'avoidNeg', label: '负时间戳处理', type: 'select', def: 'make_zero', col: 6, options: [
        { v: 'make_zero', label: 'make_zero（把负时间戳整体平移到 0）' },
        { v: 'make_non_negative', label: 'make_non_negative（只保证不为负）' },
        { v: 'auto', label: 'auto（由 FFmpeg 判断）' },
        { v: 'disabled', label: 'disabled（不动）' }
      ] },
      { k: 'maxInterleave', label: '关闭交错缓冲限制（-max_interleave_delta 0）', type: 'bool', def: true, col: 6,
        hint: '某些损坏文件不加这个参数会报 “Too many packets buffered”。' },
      { k: 'mode', label: '处理强度', type: 'select', def: 'copy', col: 6, options: [
        { v: 'copy', label: '只改时间戳，不重编码（推荐先试）' },
        { v: 'reencode', label: '重新编码（彻底重建时间轴，慢）' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const preArgs = [];
      if (v.fflags) preArgs.push('-fflags', v.fflags);
      const args = [];
      if (v.avoidNeg && v.avoidNeg !== 'disabled') args.push('-avoid_negative_ts', v.avoidNeg);
      if (v.maxInterleave) args.push('-max_interleave_delta', '0');
      if (v.mode === 'reencode') args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-fflags', '+genpts');
      else args.push('-c', 'copy', '-map', '0');
      args.push(...H.parseExtra(v.extra));
      return {
        args, preArgs,
        notes: [
          '-fflags +genpts 放在第一个 -i 之前才对输入生效。',
          '大多数「进度条乱跳 / 时长显示 0」的问题，用 igndts + make_zero 就能解决。'
        ],
        warnings: ['remux 修复不了的坏文件，请改用「重新编码」模式重建时间轴。']
      };
    }
  });

  defOp({
    id: 'stream-copy-track',
    cat: 'stream',
    name: '提取指定轨道到新文件',
    desc: '把某一条视频轨、音频轨或字幕轨单独拿出来，不重编码、不损画质。',
    tags: ['提取轨道', '抽取', 'map', '分离'],
    outExt: (v) => (v.trackType === 's' ? (v.subFormat === 'copy' ? 'mkv' : v.subFormat) : (v.trackType === 'v' ? 'mkv' : 'mka')),
    fields: [
      { k: 'trackType', label: '轨道类型', type: 'select', def: 'a', col: 4, options: [
        { v: 'v', label: '视频轨（输出 MKV）' },
        { v: 'a', label: '音频轨（输出 MKA）' },
        { v: 's', label: '字幕轨（可转文本格式）' }
      ] },
      { k: 'index', label: '同类轨道内的编号（从 0 开始）', type: 'number', def: 0, min: 0, col: 4 },
      { k: 'subFormat', label: '字幕格式', type: 'select', def: 'copy', col: 4, showIf: (v) => v.trackType === 's', options: [
        { v: 'copy', label: 'copy（原样，输出 MKV）' },
        { v: 'srt', label: 'srt' }, { v: 'ass', label: 'ass' }, { v: 'webvtt', label: 'webvtt' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const t = v.trackType || 'a';
      const idx = Number(v.index) || 0;
      const args = ['-map', `0:${t}:${idx}?`];
      if (t === 's' && v.subFormat && v.subFormat !== 'copy') args.push('-c:s', v.subFormat);
      else args.push('-c', 'copy');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          '-c copy 表示流原样复制，速度取决于磁盘而不是 CPU。',
          '视频轨与任意编码混装的场景默认放进 MKV，兼容性最好。'
        ],
        warnings: ['如果该编号并不存在，加 ? 之后 FFmpeg 仍然会因为「输出里没有任何流」而报错，请先用媒体信息确认轨道数量。']
      };
    }
  });

  defOp({
    id: 'stream-remove-subtitle',
    cat: 'stream',
    name: '删除所有字幕轨（-sn）',
    desc: '去掉硬塞进去的字幕轨与数据轨，避免播放器自动弹出字幕。',
    tags: ['删除字幕', 'sn', '去掉字幕'],
    outExt: (v) => (v.copyAll ? 'mkv' : 'mp4'),
    fields: [
      { k: 'dropData', label: '同时删除数据轨（-dn）', type: 'bool', def: true, col: 6 },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-sn'];
      if (v.dropData) args.push('-dn');
      args.push(...(v.copyAll ? ['-c', 'copy', '-map', '0'] : ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k']));
      args.push(...H.parseExtra(v.extra));
      return { args, notes: ['-sn / -dn 与 -an / -vn 是同一组输出开关，可自由组合。'] };
    }
  });

  defOp({
    id: 'stream-embed-subtitle',
    cat: 'stream',
    name: '给视频加字幕（内嵌轨道 / 烧进画面）',
    desc: '把 SRT/ASS 字幕做成可开关的字幕轨，或直接烧录到画面上（无法关闭）。',
    tags: ['字幕', '内嵌', '烧字幕', 'srt', 'ass'],
    outExt: (v) => (v.mode === 'burn' ? 'mp4' : (v.subFormat === 'mov_text' ? 'mp4' : 'mkv')),
    fields: [
      { k: 'subPath', label: '字幕文件路径', type: 'path', def: '', col: 8, placeholder: '如 C:\\视频\\movie.srt' },
      { k: 'mode', label: '处理方式', type: 'select', def: 'mux', col: 4, options: [
        { v: 'mux', label: '内嵌字幕轨（可开关，速度极快）' },
        { v: 'burn', label: '烧录到画面（永久显示，需重编码）' }
      ] },
      { k: 'subFormat', label: '字幕轨格式', type: 'select', def: 'mov_text', col: 4, showIf: (v) => v.mode === 'mux', options: [
        { v: 'mov_text', label: 'mov_text（MP4 用）' },
        { v: 'copy', label: 'copy（MKV 原样）' },
        { v: 'srt', label: 'srt（MKV 用）' },
        { v: 'ass', label: 'ass（MKV 带样式）' }
      ] },
      { k: 'lang', label: '字幕语言代码', type: 'text', def: 'chi', col: 4, showIf: (v) => v.mode === 'mux' },
      { k: 'title', label: '字幕显示名称', type: 'text', def: '中文', col: 4, showIf: (v) => v.mode === 'mux' },
      { k: 'crf', label: '烧录时的 CRF', type: 'number', def: 20, min: 0, max: 51, col: 6, showIf: (v) => v.mode === 'burn' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      if (v.mode === 'burn') {
        const args = ['-vf', 'subtitles=' + Q.filterPath(v.subPath || '', ctx.platform)];
        args.push('-c:v', 'libx264', ...H.videoQuality('crf', v.crf, 'libx264'), '-preset', 'medium', '-pix_fmt', 'yuv420p');
        args.push('-c:a', 'copy', '-movflags', '+faststart');
        args.push(...H.parseExtra(v.extra));
        return {
          args,
          notes: [
            'subtitles 滤镜的路径在 Windows 下必须写成 C\\:/a/b.srt（冒号前加反斜杠），本命令已自动处理。',
            '烧录会重编码整段视频，速度取决于视频长度与分辨率。'
          ],
          warnings: ['烧进画面后字幕无法关闭，也无法再抽取出来。', ...(v.subPath ? [] : ['还没有填写字幕文件路径。'])]
        };
      }
      const args = ['-map', '0', '-map', '1:0', '-c', 'copy'];
      if (v.subFormat && v.subFormat !== 'copy') args.push('-c:s', v.subFormat);
      if (v.lang) args.push('-metadata:s:s:0', 'language=' + v.lang);
      if (v.title) args.push('-metadata:s:s:0', 'title=' + v.title);
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [ctx.input, v.subPath || ''],
        args,
        notes: ['内嵌只是把字幕作为一条轨道放进容器，视频与音频原样复制，几乎瞬间完成。'],
        warnings: [
          'MP4 只能内嵌 mov_text 文本字幕，且源必须是 srt/ass/vtt 纯文本字幕。',
          '图像型字幕（PGS/VOBSUB）只能内嵌到 MKV 并选择 copy。',
          ...(v.subPath ? [] : ['还没有填写字幕文件路径。'])
        ]
      };
    }
  });

  /* ================================================================
   * 高级与自定义
   * ================================================================ */

  defOp({
    id: 'advanced-custom-args',
    cat: 'advanced',
    name: '自定义参数（完全接管）',
    desc: '直接写 ffmpeg 参数，引擎只负责补上输入文件和输出文件名，适合没有现成配方的需求。',
    tags: ['自定义', '高级', '手动', 'raw'],
    outExt: (v) => v.ext || 'mp4',
    fields: [
      { k: 'raw', label: 'ffmpeg 参数（写在输入之后、输出文件名之前）', type: 'textarea',
        def: '-c:v libx264 -crf 23 -preset fast -c:a aac -b:a 192k -movflags +faststart', col: 12,
        placeholder: '-c:v libx264 -crf 23 …',
        hint: '这里不要写输入文件名和输出文件名，它们由引擎自动补上。含空格的参数请用双引号包起来。' },
      { k: 'ext', label: '输出扩展名', type: 'text', def: 'mp4', col: 6, hint: '决定输出文件名后缀，如 mkv、webm、gif、flac。' },
      { k: 'note', label: '备注（会显示在命令说明里）', type: 'text', def: '', col: 6 }
    ],
    build(v, ctx) {
      const args = H.parseExtra(v.raw);
      return {
        args,
        notes: [v.note || '本条命令由「自定义参数」生成，参数是否合法由你负责。'],
        warnings: ['写错参数会导致整条命令失败；建议先用「仅输出媒体信息」确认 ffmpeg 能读到输入文件。']
      };
    }
  });

  defOp({
    id: 'advanced-custom-filter',
    cat: 'advanced',
    name: '自定义滤镜链',
    desc: '自己写 -vf / -af / -filter_complex 的内容，用来组合滤镜或调试特殊效果。',
    tags: ['滤镜', 'filter', 'vf', '自定义'],
    outExt: 'mp4',
    fields: [
      { k: 'ftype', label: '滤镜类型', type: 'select', def: 'vf', col: 4, options: [
        { v: 'vf', label: '-vf 视频滤镜' },
        { v: 'af', label: '-af 音频滤镜' },
        { v: 'fc', label: '-filter_complex 复杂滤镜' }
      ] },
      { k: 'filter', label: '滤镜内容', type: 'textarea', def: 'scale=1280:-2', col: 8,
        placeholder: 'scale=1280:-2,fps=30',
        hint: '同一路滤镜用英文逗号连接；涉及文件路径的滤镜（subtitles/drawtext）在 Windows 下要把 C:\\ 写成 C\\:/。' },
      { k: 'maps', label: '输出映射（每行一个，如 [vout]）', type: 'textarea', def: '[vout]', col: 12, showIf: (v) => v.ftype === 'fc' },
      ...vencFields('', {}),
      ...aencFields('', {}),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = String(v.filter || '').trim();
      const args = [];
      const warnings = [];
      if (!f && v.ftype !== 'fc') warnings.push('滤镜内容为空，本步只会做一次普通转码。');
      if (f) {
        if (v.ftype === 'af') args.push('-af', f);
        else if (v.ftype === 'fc') {
          args.push('-filter_complex', f);
          const ms = String(v.maps || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (ms.length) ms.forEach((m) => args.push('-map', m));
          else warnings.push('-filter_complex 通常需要配合 -map 指定输出，请在「输出映射」里填写。');
        } else args.push('-vf', f);
      }
      args.push(...vencArgs(v, ''), ...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args, warnings,
        notes: [
          '滤镜参数中的特殊字符需要转义：逗号 \\, 、冒号 \\: 、方括号 \\[ \\] 。',
          '复杂滤镜里的每条链路用分号分隔，输出标签要用 [名字] 结尾。'
        ]
      };
    }
  });

  defOp({
    id: 'advanced-probe',
    cat: 'advanced',
    name: '仅输出媒体信息（不写文件）',
    desc: '打印分辨率、编码格式、码率、时长、音轨数量等信息，相当于 ffmpeg -i 输入文件。',
    tags: ['媒体信息', 'probe', '查看', '分析'],
    outExt: 'txt',
    fields: [
      { k: 'hideBanner', label: '隐藏 FFmpeg 版本横幅', type: 'bool', def: true, col: 6 },
      { k: 'nullSink', label: '用空设备收尾（-f null -，退出码为 0）', type: 'bool', def: true, col: 6,
        hint: '开启后命令是 ffmpeg -i 输入 -f null -，信息照常打印且退出码为 0；关掉则只剩 ffmpeg -i 输入，FFmpeg 会因为没有输出文件而返回错误码。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      // 不产生输出文件：engine 约定 output 为空字符串时不在命令末尾追加输出路径
      const args = [];
      if (v.hideBanner) args.push('-hide_banner');
      if (v.nullSink) args.push('-f', 'null');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        output: v.nullSink ? '-' : '',
        notes: [
          '输出的信息来自 FFmpeg 读取输入文件时的分析日志：分辨率、编码格式、码率、时长、轨道数量。',
          '默认的 -f null - 表示把解码结果丢进空设备，不写任何文件，退出码为 0，批量脚本里不会误报失败。'
        ],
        warnings: [
          '关掉「用空设备收尾」后命令就是纯 ffmpeg -i 输入，FFmpeg 会以非 0 退出码结束（信息仍然会打印完），脚本会把它标成「失败」。',
          '结果只打印在终端，不会保存成文件；需要留档请把终端输出重定向到文本文件。'
        ]
      };
    }
  });

  defOp({
    id: 'advanced-loglevel',
    cat: 'advanced',
    name: '日志级别控制',
    desc: '调整 FFmpeg 输出的啰嗦程度，批量跑脚本时让日志更干净或更详细。',
    tags: ['日志', 'loglevel', '调试', '安静'],
    outExt: 'mkv',
    fields: [
      { k: 'level', label: '日志级别', type: 'select', def: 'info', col: 4, options: [
        'quiet', 'panic', 'fatal', 'error', 'warning', 'info', 'verbose', 'debug', 'trace'
      ].map((x) => ({ v: x, label: x })) },
      { k: 'stats', label: '显示实时进度统计', type: 'bool', def: true, col: 4 },
      { k: 'report', label: '生成调试报告文件（ffmpeg-*.log）', type: 'bool', def: false, col: 4,
        hint: '报告写在当前工作目录，适合排查崩溃与参数错误。' },
      { k: 'copyAll', label: '不重新编码（-c copy，仅做日志演示）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const preArgs = ['-loglevel', v.level || 'info'];
      if (v.stats) preArgs.push('-stats'); else preArgs.push('-nostats');
      if (v.report) preArgs.push('-report');
      const args = [];
      if (v.copyAll) args.push('-c', 'copy', '-map', '0');
      args.push(...H.parseExtra(v.extra));
      return {
        args, preArgs,
        notes: [
          '日志级别（由安静到啰嗦）：quiet < panic < fatal < error < warning < info < verbose < debug < trace。',
          '这些是全局选项，必须写在输入文件之前，因此放在了命令开头。'
        ],
        warnings: ['日志设置只作用于本条命令；每个操作步骤都会单独执行一次 FFmpeg，互不影响。']
      };
    }
  });

  defOp({
    id: 'advanced-overwrite',
    cat: 'advanced',
    name: '覆盖 / 不覆盖输出（-y / -n）',
    desc: '控制同名文件的行为：批处理时用 -n 跳过已处理文件，重跑时用 -y 直接覆盖。',
    tags: ['覆盖', 'y', 'n', '覆盖开关'],
    outExt: 'mkv',
    fields: [
      { k: 'mode', label: '同名文件时的行为', type: 'select', def: 'y', col: 6, options: [
        { v: 'y', label: '-y 直接覆盖（不询问）' },
        { v: 'n', label: '-n 跳过已有文件（不覆盖）' }
      ], hint: 'FFmpeg 不允许同一条命令里同时出现 -y 和 -n；要看方案顶部的「覆盖输出」开关是否勾选。' },
      { k: 'nostdin', label: '禁止读取键盘输入（-nostdin）', type: 'bool', def: true, col: 6,
        hint: '脚本里非常有用，避免 FFmpeg 卡在交互提示上。' },
      { k: 'copyAll', label: '仅调整行为，不重新编码（-c copy）', type: 'bool', def: true, col: 12 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      // 本操作自己写 -y / -n，必须告诉引擎不要再插一个 -y，
      // 否则 FFmpeg 会直接报 "Error, both -y and -n supplied. Exiting."
      const preArgs = [v.mode === 'n' ? '-n' : '-y'];
      if (v.nostdin) preArgs.push('-nostdin');
      const args = v.copyAll ? ['-c', 'copy', '-map', '0'] : [];
      args.push(...H.parseExtra(v.extra));
      return {
        args, preArgs,
        noAutoOverwrite: true,
        notes: [
          '-y / -n 是全局选项，写在输入文件之前；本操作已接管覆盖行为，引擎不会再自动加 -y。',
          '配合 -nostdin 一起用，脚本里就不会因为等待交互而卡住。'
        ],
        warnings: v.mode === 'n'
          ? ['被 -n 跳过的文件不会写入任何内容，但 FFmpeg 仍以退出码 0 结束，脚本里不会标红，请自行核对产物是否齐全。']
          : ['-y 会直接覆盖同名文件，原始文件无法找回，执行前请确认输出目录。']
      };
    }
  });

  defOp({
    id: 'advanced-benchmark',
    cat: 'advanced',
    name: '性能测试（-benchmark）',
    desc: '测量编解码与滤镜的耗时，判断瓶颈在 CPU、显卡还是磁盘。',
    tags: ['性能', 'benchmark', '测速', '耗时'],
    outExt: 'mp4',
    fields: [
      { k: 'all', label: '统计每个环节的耗时（-benchmark_all）', type: 'bool', def: false, col: 6 },
      { k: 'nullOut', label: '只测速不写文件（-f null）', type: 'bool', def: false, col: 6,
        hint: '测量纯解码/编码速度时用，避免磁盘成为瓶颈。' },
      ...vencFields('', {}),
      ...aencFields('', { defCodec: 'copy' }),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const preArgs = ['-benchmark'];
      if (v.all) preArgs.push('-benchmark_all');
      const args = [...vencArgs(v, ''), ...aencArgs(v, '')];
      if (v.nullOut) args.push('-f', 'null');
      args.push(...H.parseExtra(v.extra));
      return {
        args, preArgs,
        notes: [
          'utime 是用户态 CPU 耗时，stime 是内核态耗时，rtime 是实际经过的时间。',
          'ffmpeg 输出的速度倍数（speed=8.3x）比耗时更直观，可用来对比不同编码器。'
        ],
        warnings: v.nullOut ? ['-f null 不写文件，因此测不出磁盘写入速度。'] : hwWarnings(v.vcodec, ctx)
      };
    }
  });

  defOp({
    id: 'advanced-mpegts',
    cat: 'advanced',
    name: '封装成 MPEG-TS（电视 / 广播用）',
    desc: '生成 .ts 文件，用于电视广播、IPTV、U 盘播放器和部分机顶盒。',
    tags: ['ts', 'mpegts', '电视', '广播'],
    outExt: 'ts',
    fields: [
      { k: 'annexb', label: '码流格式转换（bsf）', type: 'select', def: 'h264_mp4toannexb', col: 6, options: [
        { v: 'h264_mp4toannexb', label: 'h264_mp4toannexb（源是 H.264 MP4 时必选）' },
        { v: 'hevc_mp4toannexb', label: 'hevc_mp4toannexb（源是 H.265 时选这个）' },
        { v: '', label: '不转换（源本来就是 TS 码流）' }
      ], hint: 'MP4 用长度前缀记录 NAL，TS 用起始码，不转换会出现黑屏或花屏。' },
      { k: 'muxrate', label: '复用码率（留空 = 自动）', type: 'text', def: '', col: 3, placeholder: '如 8M' },
      { k: 'resend', label: '周期性重发节目信息', type: 'bool', def: false, col: 3 },
      { k: 'copyAll', label: '不重新编码（-c copy）', type: 'bool', def: true, col: 6 },
      { k: 'pcrPeriod', label: 'PCR 周期（毫秒，留空 = 默认）', type: 'number', def: 0, min: 0, col: 6, hint: '部分机顶盒对 PCR 周期敏感，常用 20~40ms。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = [];
      if (v.copyAll) {
        args.push('-c', 'copy', '-map', '0');
        if (v.annexb) args.push('-bsf:v', v.annexb);
      }
      args.push('-f', 'mpegts');
      if (v.muxrate) args.push('-muxrate', v.muxrate);
      if (v.resend) args.push('-mpegts_flags', 'resend_headers');
      if (Number(v.pcrPeriod) > 0) args.push('-pcr_period', String(v.pcrPeriod));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [
          'H.264 MP4 里的 NAL 使用长度前缀，TS 要求起始码（Annex-B），所以要过一遍 bsf。',
          '封装本身不重编码，速度取决于磁盘读写。'
        ],
        warnings: ['TS 不支持 faststart，也不要用于长期存档（体积比 MP4 略大）。']
      };
    }
  });

  defOp({
    id: 'advanced-test-source',
    cat: 'advanced',
    name: '生成测试视频（彩条 / 测试图）',
    desc: '不读取任何素材，直接用 lavfi 生成标准测试画面（可带 1kHz 测试音），用于验证播放链路。',
    tags: ['测试源', '彩条', 'smptebars', 'testsrc', 'lavfi'],
    outExt: 'mp4',
    fields: [
      { k: 'source', label: '测试图源', type: 'select', def: 'smptebars', col: 4, options: [
        { v: 'smptebars', label: 'smptebars（标准彩条）' },
        { v: 'smptehdbars', label: 'smptehdbars（高清彩条）' },
        { v: 'testsrc', label: 'testsrc（带计数器的测试图）' },
        { v: 'testsrc2', label: 'testsrc2（彩色测试图）' },
        { v: 'rgbtestsrc', label: 'rgbtestsrc（RGB 三色检验）' },
        { v: 'color', label: 'color（纯色画面）' },
        { v: 'mandelbrot', label: 'mandelbrot（曼德博集合动画）' }
      ] },
      { k: 'size', label: '分辨率', type: 'text', def: '1280x720', col: 4, placeholder: '如 1920x1080' },
      { k: 'rate', label: '帧率', type: 'number', def: 25, min: 1, max: 240, col: 4 },
      { k: 'duration', label: '时长（秒）', type: 'number', def: 10, min: 1, col: 4 },
      { k: 'colorVal', label: '纯色值（color 源用）', type: 'text', def: 'black', col: 4, showIf: (v) => v.source === 'color' },
      { k: 'addTone', label: '同时生成 1kHz 正弦测试音', type: 'bool', def: true, col: 4 },
      { k: 'toneFreq', label: '测试音频率（Hz）', type: 'number', def: 1000, min: 20, col: 4, showIf: (v) => v.addTone },
      ...vencFields('', {}),
      ...aencFields('', {}),
      { k: 'fileName', label: '输出文件名', type: 'text', def: 'test_pattern.mp4', col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const size = v.size || '1280x720';
      const rate = Number(v.rate) || 25;
      const src = v.source === 'color'
        ? `color=c=${v.colorVal || 'black'}:size=${size}:rate=${rate}`
        : `${v.source || 'smptebars'}=size=${size}:rate=${rate}`;
      const args = ['-f', 'lavfi', '-i', src];
      if (v.addTone) args.push('-f', 'lavfi', '-i', `sine=frequency=${Number(v.toneFreq) || 1000}:sample_rate=44100`);
      args.push('-t', String(Number(v.duration) || 10));
      if (v.addTone) args.push('-map', '0:v', '-map', '1:a', '-shortest');
      args.push(...vencArgs(v, ''));
      if (v.addTone) args.push(...aencArgs(v, ''));
      else args.push('-an');
      args.push('-pix_fmt', 'yuv420p');
      args.push(...H.parseExtra(v.extra));
      return {
        inputs: [],
        args,
        output: U.join(ctx.outputDir, v.fileName || 'test_pattern.mp4', ctx.platform),
        notes: [
          '本操作不读取任何输入文件，为让方案完整，界面里仍需选择一个输入（它不会被使用）。',
          'lavfi 是 FFmpeg 内置的虚拟设备，可以凭空造出测试画面与声音。'
        ],
        warnings: ['输出文件名是固定值，批量生成时会互相覆盖。']
      };
    }
  });

  defOp({
    id: 'advanced-null-analyze',
    cat: 'advanced',
    name: '空跑分析（-f null，不写文件）',
    desc: '完整解码一遍但不输出文件，用来批量体检素材：黑场、卡帧、黑边、静音段一次看清。',
    tags: ['分析', 'null', '体检', '黑场', '检测'],
    outExt: 'txt',
    fields: [
      { k: 'probe', label: '附加分析滤镜', type: 'select', def: 'none', col: 6, options: [
        { v: 'none', label: '不附加（只看整体统计与报错）' },
        { v: 'blackdetect', label: 'blackdetect（黑场检测）' },
        { v: 'freezedetect', label: 'freezedetect（卡帧检测）' },
        { v: 'cropdetect', label: 'cropdetect（自动探测黑边）' },
        { v: 'signalstats', label: 'signalstats（亮度/色度统计）' },
        { v: 'silencedetect', label: 'silencedetect（静音段检测）' }
      ] },
      { k: 'nostats', label: '不显示实时进度（-nostats）', type: 'bool', def: false, col: 6 },
      { k: 'decodeAudio', label: '同时解码音频（detect 类滤镜需要）', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const F = {
        blackdetect: 'blackdetect=d=0.5:pix_th=0.10',
        freezedetect: 'freezedetect=n=-60dB:d=2',
        cropdetect: 'cropdetect=24:16:0',
        signalstats: 'signalstats,metadata=print',
        silencedetect: 'silencedetect=n=-50dB:d=1'
      };
      const p = v.probe || 'none';
      const args = [];
      if (p !== 'none') {
        if (p === 'silencedetect') args.push('-af', F[p]);
        else args.push('-vf', F[p]);
      }
      if (p === 'silencedetect') { /* 需要保留音频 */ }
      else if (!v.decodeAudio) args.push('-an');
      if (v.nostats) args.push('-nostats');
      // 末尾的 '-' 由 engine 通过 output:'-' 追加，这里只写复用器
      args.push('-f', 'null');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        output: '-',
        notes: [
          '检测结果会以 [blackdetect] / [freezedetect] 这样的日志行打印在终端里。',
          '-f null - 表示把解码结果丢到空设备，不占用磁盘空间。'
        ],
        warnings: ['检测滤镜输出的是日志而不是文件，批量运行时请把终端输出重定向到文本文件保存。']
      };
    }
  });

  /* ================================================================
   * 内部小工具
   * ================================================================ */

  /** 由「时间 标题」文本生成 FFMETADATA1 章节文件内容 */
  function buildChapterFile(text, endAt) {
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const rows = [];
    lines.forEach((ln) => {
      const m = ln.match(/^(\S+)\s*(.*)$/);
      if (!m) return;
      const t = U.toSec(m[1]);
      if (t == null || !isFinite(t)) return;
      rows.push({ t, title: (m[2] || '').trim() || ('章节 ' + (rows.length + 1)) });
    });
    rows.sort((a, b) => a.t - b.t);
    const total = U.toSec(endAt);
    const ms = (x) => String(Math.round(x * 1000));
    const out = [';FFMETADATA1', ''];
    rows.forEach((r, i) => {
      out.push('[CHAPTER]');
      out.push('TIMEBASE=1/1000');
      out.push('START=' + ms(r.t));
      const end = i < rows.length - 1 ? rows[i + 1].t : (total != null ? total : null);
      if (end != null && end > r.t) out.push('END=' + ms(end));
      out.push('title=' + r.title);
      out.push('');
    });
    if (!rows.length) out.push('; 未能解析到章节，请按「00:00:00 标题」的格式填写');
    return out.join('\n');
  }

})();
