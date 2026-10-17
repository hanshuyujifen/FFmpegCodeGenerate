/**
 * recipes-edit.js —— 配方库：剪辑 / 拼接 / 速度帧率 / 图片序列
 * 依赖 engine.js 暴露的全局函数 defCat / defOp 与 FFHELP / FFQ / FFU
 */
(function () {
  'use strict';
  const H = FFHELP, Q = FFQ, U = FFU;
  /** 滤镜参数里的时间一律用秒数（冒号会破坏滤镜选项解析） */
  const secs = H.secs;

  /**
   * 多区间的「无损」实现：每个区间先用 -c copy 切成一个片段（不重编码，秒级完成），
   * 再用 concat demuxer 拼起来。成品编码/画质/CRF 与源素材完全一致。
   * 代价是切点会对齐到最近的关键帧。
   */
  function buildLossless(ranges, v, ctx) {
    const stem = U.stem(ctx.input);
    const segPath = (i) => U.join(ctx.outputDir, `${stem}_seg${i + 1}.mp4`, ctx.platform);
    const before = ranges.map(([a, b], i) => ({
      name: `${stem} · 第 ${i + 1} 段（无损切 ${U.hms(a)}–${U.hms(b)}）`,
      preArgs: ['-ss', secs(a)],
      args: [
        '-t', secs(b - a),
        '-c', 'copy',
        '-map', '0:v:0', '-map', '0:a?'
        // ⚠️ 这里不要加 -avoid_negative_ts make_zero：实测它会破坏 -t 的时长限制
        //    （切 2 秒会产出 4 秒），而默认行为本身就是正确的。
      ],
      output: segPath(i),
      notes: [`截取 ${U.hms(a)} ~ ${U.hms(b)}（${U.humanDur(b - a)}），不重编码。`]
    }));

    const listName = `_concat_${stem}.txt`;
    const listPath = U.join(ctx.outputDir, listName, ctx.platform);
    const listContent = ranges
      .map((_, i) => `file '${segPath(i).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n') + '\n';

    return {
      preArgs: ['-f', 'concat', '-safe', '0'],
      inputs: [listPath],
      args: ['-c', 'copy', ...H.parseExtra(v.extra)],
      aux: [{ name: listName, path: listPath, content: listContent, lang: 'text' }],
      before,
      notes: [
        `无损模式：先把 ${ranges.length} 个区间各自切成片段（-c copy，不重编码），再用 concat 拼接。成品与源素材的编码、画质、CRF 完全一致。`,
        '⚠️ 流复制的切点受关键帧和时间戳限制，实际起止点与总时长可能有偏差；请检查成品。需要帧级精确请改用「帧级精确」模式。',
        '中间片段文件（文件名带 _seg）会留在输出目录，确认成品没问题后可以自行删除。'
      ]
    };
  }

  /* ================================================================
   * 分类
   * ================================================================ */
  defCat({ id: 'trim', name: '剪辑与切割', icon: '✂️', color: '#f97316', desc: '按时间裁剪、无损切割、分段、拼接保留区间' });
  defCat({ id: 'concat', name: '合并拼接', icon: '🔗', color: '#8b5cf6', desc: '多个视频合并成一条，支持无损与重编码两种方式' });
  defCat({ id: 'speed', name: '速度与帧率', icon: '⏱️', color: '#06b6d4', desc: '变速、慢动作、延时摄影、改帧率、补帧' });
  defCat({ id: 'image', name: '图片与序列帧', icon: '🖼️', color: '#ec4899', desc: '截图、封面、GIF、图片序列互转、缩略图网格' });

  const VCODECS = [
    { v: 'libx264', label: 'libx264（H.264 软件，通用）' },
    { v: 'libx265', label: 'libx265（H.265 软件，体积小）' },
    { v: 'h264_nvenc', label: 'h264_nvenc（NVIDIA 显卡加速）' },
    { v: 'hevc_nvenc', label: 'hevc_nvenc（NVIDIA H.265）' },
    { v: 'h264_qsv', label: 'h264_qsv（Intel 核显）' },
    { v: 'h264_amf', label: 'h264_amf（AMD 显卡）' },
    { v: 'h264_videotoolbox', label: 'h264_videotoolbox（Apple）' },
    { v: 'mpeg4', label: 'mpeg4（老设备兼容）' },
    { v: 'copy', label: 'copy（不重编码，直接复制流）' }
  ];

  function vencFields(prefix, labelPrefix) {
    const p = prefix || '';
    const lp = labelPrefix || '';
    return [
      { k: p + 'vcodec', label: lp + '视频编码器', type: 'select', def: 'libx264', options: VCODECS, col: 6 },
      { k: p + 'qmode', label: lp + '质量控制', type: 'select', def: 'crf', col: 6, options: [
        { v: 'crf', label: 'CRF 恒定质量（推荐）' },
        { v: 'bitrate', label: '指定码率' },
        { v: 'copy', label: '不指定（用编码器默认）' }
      ], showIf: (v) => v[p + 'vcodec'] !== 'copy' },
      { k: p + 'crf', label: lp + 'CRF 值（越小越清晰，18~28）', type: 'number', def: 23, min: 0, max: 51, col: 6,
        showIf: (v) => v[p + 'vcodec'] !== 'copy' && v[p + 'qmode'] === 'crf' },
      { k: p + 'bitrate', label: lp + '视频码率', type: 'text', def: '4M', col: 6, placeholder: '如 4M / 2500k',
        showIf: (v) => v[p + 'vcodec'] !== 'copy' && v[p + 'qmode'] === 'bitrate' },
      { k: p + 'preset', label: lp + '编码预设', type: 'select', def: 'medium', col: 6,
        options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((x) => ({ v: x, label: x })),
        showIf: (v) => v[p + 'vcodec'] !== 'copy' }
    ];
  }

  function vencArgs(v, prefix) {
    const p = prefix || '';
    const enc = v[p + 'vcodec'] || 'libx264';
    if (enc === 'copy') return ['-c:v', 'copy'];
    const a = ['-c:v', enc];
    if (v[p + 'qmode'] === 'bitrate') a.push(...H.videoQuality('bitrate', v[p + 'bitrate'], enc));
    else if (v[p + 'qmode'] === 'crf') a.push(...H.videoQuality('crf', v[p + 'crf'], enc));
    a.push(...H.preset(v[p + 'preset'], enc));
    if (/libx26[45]/.test(enc)) a.push('-pix_fmt', 'yuv420p');
    return a;
  }

  function aencFields(prefix) {
    const p = prefix || '';
    return [
      { k: p + 'acodec', label: '音频编码', type: 'select', def: 'aac', col: 6, options: [
        { v: 'aac', label: 'aac（通用）' },
        { v: 'libmp3lame', label: 'mp3' },
        { v: 'libopus', label: 'opus' },
        { v: 'ac3', label: 'ac3（DVD）' },
        { v: 'flac', label: 'flac（无损）' },
        { v: 'pcm_s16le', label: 'pcm（WAV 未压缩）' },
        { v: 'copy', label: 'copy（不重编码）' },
        { v: 'none', label: '不要音频' }
      ] },
      { k: p + 'abitrate', label: '音频码率', type: 'select', def: '192k', col: 6,
        options: ['96k', '128k', '160k', '192k', '256k', '320k', '512k'].map((x) => ({ v: x, label: x })),
        showIf: (v) => !['copy', 'none', 'flac', 'pcm_s16le'].includes(v[p + 'acodec']) }
    ];
  }

  const EXTRA_FIELD = { k: 'extra', label: '附加参数（高级）', type: 'text', def: '', col: 12, placeholder: '如 -movflags +faststart -threads 4', hint: '空格分隔；含空格的参数请用双引号包起来。将追加在输出文件之前。' };

  /* ================================================================
   * 剪辑与切割
   * ================================================================ */

  defOp({
    id: 'trim-accurate',
    cat: 'trim',
    name: '精确剪辑（重编码，较慢）',
    desc: '按开始时间 + 时长/结束时间剪出一段，重编码以换取帧级精度。只求快速剪切时优先使用「快速无损切割」。',
    tags: ['剪辑', '裁剪', 'trim', 'cut'],
    outExt: 'mp4',
    fields: [
      { k: 'start', label: '开始时间', type: 'time', def: '00:00:00', col: 4, placeholder: '00:00:10 或 10' },
      { k: 'mode', label: '结束方式', type: 'select', def: 'dur', col: 4, options: [
        { v: 'dur', label: '按时长（从开始往后 N 秒）' },
        { v: 'end', label: '按结束时间点' }
      ] },
      { k: 'dur', label: '持续时长', type: 'time', def: '00:00:30', col: 4, showIf: (v) => v.mode === 'dur' },
      { k: 'end', label: '结束时间', type: 'time', def: '00:00:30', col: 4, showIf: (v) => v.mode === 'end' },
      ...vencFields('', ''),
      ...aencFields(''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const start = H.timeArg(v.start);
      const preArgs = [];
      if (start && U.toSec(start) > 0) preArgs.push('-ss', start);
      const args = [];
      if (v.mode === 'end') {
        const end = H.timeArg(v.end);
        if (end) args.push('-to', end);
      } else {
        const dur = H.timeArg(v.dur);
        if (dur) args.push('-t', dur);
      }
      args.push(...vencArgs(v, ''));
      args.push(...aencArgs(v, ''));
      args.push('-movflags', '+faststart');
      args.push(...H.parseExtra(v.extra));
      return { preArgs, args, notes: ['使用 -ss 放在 -i 之前可快速定位，FFmpeg 会自动精确到帧。'] };
    }
  });

  defOp({
    id: 'trim-copy',
    cat: 'trim',
    name: '快速无损切割',
    desc: '不重新编码，秒级完成。缺点：切割点会对齐到关键帧，可能与设定时间差几百毫秒。',
    tags: ['无损', '切割', 'copy', '快速'],
    outExt: 'mp4',
    fields: [
      { k: 'start', label: '开始时间', type: 'time', def: '00:00:00', col: 4 },
      { k: 'dur', label: '持续时长（留空到结尾）', type: 'time', def: '00:01:00', col: 4 },
      { k: 'accurate', label: '强制精确切割', type: 'bool', def: false, col: 4, hint: '开启后会重新编码，等同于精确剪辑。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const start = H.timeArg(v.start);
      const preArgs = [];
      if (start && U.toSec(start) > 0) preArgs.push('-ss', start);
      const args = [];
      const dur = H.timeArg(v.dur);
      if (dur) args.push('-t', dur);
      if (v.accurate) {
        args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k');
      } else {
        args.push('-c', 'copy', '-map', '0', '-avoid_negative_ts', 'make_zero');
      }
      args.push(...H.parseExtra(v.extra));
      return {
        preArgs, args,
        notes: v.accurate ? [] : ['关键帧对齐模式：如需帧级精确，请改用「精确剪辑（重编码）」或勾选强制精确。']
      };
    }
  });

  defOp({
    id: 'trim-head',
    cat: 'trim',
    name: '截取开头 N 秒',
    desc: '只保留视频最前面的部分。',
    tags: ['开头', 'head'],
    outExt: 'mp4',
    fields: [
      { k: 'dur', label: '保留时长', type: 'time', def: '00:00:15', col: 6 },
      { k: 'reencode', label: '重新编码（精确）', type: 'bool', def: false, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-t', H.timeArg(v.dur) || '15'];
      args.push(...(v.reencode
        ? ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac']
        : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']));
      args.push(...H.parseExtra(v.extra));
      return { args };
    }
  });

  defOp({
    id: 'trim-tail',
    cat: 'trim',
    name: '截取最后 N 秒',
    desc: '只保留视频结尾部分（-sseof 从末尾倒推）。',
    tags: ['结尾', 'tail'],
    outExt: 'mp4',
    fields: [
      { k: 'dur', label: '保留时长', type: 'time', def: '00:00:15', col: 6 },
      { k: 'reencode', label: '重新编码（精确）', type: 'bool', def: false, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const preArgs = ['-sseof', '-' + (H.timeArg(v.dur) || '15')];
      const args = ['-t', H.timeArg(v.dur) || '15'];
      args.push(...(v.reencode
        ? ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac']
        : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']));
      args.push(...H.parseExtra(v.extra));
      return { preArgs, args };
    }
  });

  defOp({
    id: 'trim-segment',
    cat: 'trim',
    name: '平均切成多段',
    desc: '把一个视频按固定时长切成 part_001、part_002… 适合切片上传。',
    tags: ['分段', '切片', 'segment'],
    outExt: 'mp4',
    fields: [
      { k: 'segTime', label: '每段时长（秒）', type: 'number', def: 60, min: 1, col: 4 },
      { k: 'reencode', label: '重新编码（保证每段都以关键帧开头）', type: 'bool', def: false, col: 8,
        hint: '不重编码时切点会对齐最近的关键帧，段长不严格。' },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const pattern = U.join(ctx.outputDir, U.stem(ctx.input) + '_part_%03d.' + (ctx.platform === 'win32' ? 'mp4' : 'mp4'), ctx.platform);
      const args = [];
      args.push(...(v.reencode
        ? ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-force_key_frames', 'expr:gte(t,n_forced*' + v.segTime + ')']
        : ['-c', 'copy']));
      args.push('-map', '0', '-f', 'segment', '-segment_time', String(v.segTime), '-reset_timestamps', '1');
      args.push('-segment_format', 'mp4');
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        output: pattern,
        notes: ['%03d 会被 ffmpeg 自动替换成 001、002…，最终生成 ' + U.stem(ctx.input) + '_part_001.mp4 等文件。']
      };
    }
  });

  defOp({
    id: 'trim-keep-ranges',
    cat: 'trim',
    name: '保留多个区间并合成一条',
    desc: '例如只要 0:10-0:20 和 1:00-1:30 两段，自动剪掉中间不要的部分并接成一条。',
    tags: ['多段', '区间', 'trim', 'concat'],
    outExt: 'mp4',
    fields: [
      { k: 'mode', label: '处理方式', type: 'select', def: 'copy', col: 12, options: [
        { v: 'copy', label: '优先速度/无损 —— 分段 + 拼接，不重新编码（切点受关键帧限制）' },
        { v: 'precise', label: '帧级精确 —— 重新编码，处理较慢' }
      ], hint: '默认选择无损模式，尽量不占用 CPU。只有必须精确到帧时，才切换到重编码。' },
      { k: 'ranges', label: '保留区间（每行一个，格式 开始-结束）', type: 'textarea', def: '00:00:10-00:00:20\n00:01:00-00:01:30', col: 12,
        placeholder: '00:00:10-00:00:20', hint: '时间可用 00:01:30 或 90 表示秒。至少填 1 行。' },
      // 无损模式下不需要这些编码参数
      ...vencFields('', '').map((f) => Object.assign({}, f, {
        showIf: (vv) => vv.mode !== 'copy' && (!f.showIf || f.showIf(vv))
      })),
      ...aencFields('').map((f) => Object.assign({}, f, {
        showIf: (vv) => vv.mode !== 'copy' && (!f.showIf || f.showIf(vv))
      })),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const lines = String(v.ranges || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const ranges = [];
      for (const ln of lines) {
        const m = ln.split(/\s*[-~到]\s*/);
        if (m.length >= 2) {
          const a = U.toSec(m[0]), b = U.toSec(m[1]);
          if (a != null && b != null && b > a) ranges.push([a, b]);
        }
      }
      if (!ranges.length) {
        return { args: ['-c', 'copy'], notes: ['⚠️ 未解析到有效区间，已退化为直接复制。'] };
      }

      /* ---- 无损模式：每段单独切（-c copy），再 concat 拼接，全程不重编码 ---- */
      if (v.mode === 'copy') return buildLossless(ranges, v, ctx);

      const hasAudio = v.acodec !== 'none' && ctx.hasAudio !== false;
      const parts = [];
      const maps = [];
      const notes = [];
      if (!hasAudio && v.acodec !== 'none') {
        notes.push('检测到输入没有音轨，已自动只处理画面。');
      }
      ranges.forEach(([a, b], i) => {
        parts.push(`[0:v]trim=start=${secs(a)}:end=${secs(b)},setpts=PTS-STARTPTS[v${i}]`);
        if (hasAudio) parts.push(`[0:a]atrim=start=${secs(a)}:end=${secs(b)},asetpts=PTS-STARTPTS[a${i}]`);
        maps.push(`[v${i}]` + (hasAudio ? `[a${i}]` : ''));
      });
      const chain = maps.join('') + `concat=n=${ranges.length}:v=1:a=${hasAudio ? 1 : 0}[vout]` + (hasAudio ? '[aout]' : '');
      parts.push(chain);
      const args = ['-filter_complex', parts.join(';'), '-map', '[vout]'];
      if (hasAudio) args.push('-map', '[aout]');
      args.push(...vencArgs(v, ''));
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return {
        args,
        notes: [`共保留 ${ranges.length} 个区间，总时长约 ${U.humanDur(ranges.reduce((s, r) => s + (r[1] - r[0]), 0))}。`, ...notes]
      };
    }
  });

  defOp({
    id: 'trim-remove-middle',
    cat: 'trim',
    name: '删除中间一段（保留前后）',
    desc: '剪掉 A~B 之间的内容，把前后两段接起来。',
    tags: ['删除', '挖掉'],
    outExt: 'mp4',
    fields: [
      { k: 'from', label: '删除起点', type: 'time', def: '00:00:20', col: 6 },
      { k: 'to', label: '删除终点', type: 'time', def: '00:00:40', col: 6 },
      ...vencFields('', '').map((f) => f.k === 'vcodec' ? Object.assign({}, f, { options: f.options.filter((o) => o.v !== 'copy'), def: 'libx264' }) : f),
      ...aencFields(''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const a = U.toSec(v.from), b = U.toSec(v.to);
      if (a == null || b == null || b <= a) {
        return { args: ['-c', 'copy'], warnings: ['删除区间无效，请确认终点大于起点。'] };
      }
      const hasAudio = v.acodec !== 'none' && ctx.hasAudio !== false;
      const A = secs(a), B = secs(b);
      const parts = [
        `[0:v]trim=start=0:end=${A},setpts=PTS-STARTPTS[v0]`,
        `[0:v]trim=start=${B},setpts=PTS-STARTPTS[v1]`
      ];
      if (hasAudio) {
        parts.push(`[0:a]atrim=start=0:end=${A},asetpts=PTS-STARTPTS[a0]`);
        parts.push(`[0:a]atrim=start=${B},asetpts=PTS-STARTPTS[a1]`);
      }
      parts.push(`[v0]${hasAudio ? '[a0]' : ''}[v1]${hasAudio ? '[a1]' : ''}concat=n=2:v=1:a=${hasAudio ? 1 : 0}[vout]${hasAudio ? '[aout]' : ''}`);
      const args = ['-filter_complex', parts.join(';'), '-map', '[vout]'];
      if (hasAudio) args.push('-map', '[aout]');
      args.push(...vencArgs(v, ''));
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      const notes = [`删除 ${U.hms(a)} ~ ${U.hms(b)}（共 ${U.humanDur(b - a)}）。`];
      if (!hasAudio && v.acodec !== 'none') notes.push('检测到输入没有音轨，已自动只处理画面。');
      return { args, notes };
    }
  });

  defOp({
    id: 'trim-to-mp4-segments-hls',
    cat: 'trim',
    name: '切片为 HLS（m3u8 + ts）',
    desc: '生成 index.m3u8 与一堆 ts 分片，用于网页播放或直播点播。',
    tags: ['hls', 'm3u8', '切片'],
    outExt: 'm3u8',
    fields: [
      { k: 'segTime', label: '分片时长（秒）', type: 'number', def: 10, min: 1, col: 6 },
      ...vencFields('', ''),
      ...aencFields(''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const out = U.join(ctx.outputDir, U.stem(ctx.input) + '.m3u8', ctx.platform);
      const args = [...vencArgs(v, ''), ...aencArgs(v, '')];
      args.push('-f', 'hls', '-hls_time', String(v.segTime), '-hls_list_size', '0',
        '-hls_segment_filename', U.join(ctx.outputDir, U.stem(ctx.input) + '_%03d.ts', ctx.platform));
      args.push(...H.parseExtra(v.extra));
      return { args, output: out, notes: ['生成的 .ts 分片与 .m3u8 需放在同一目录。'] };
    }
  });

  /* ================================================================
   * 合并拼接
   * ================================================================ */

  defOp({
    id: 'concat-demuxer',
    cat: 'concat',
    name: '无损拼接（推荐）',
    desc: '速度极快、不损失画质。要求所有片段的编码格式、分辨率、帧率一致。',
    tags: ['拼接', '合并', 'concat'],
    scope: 'set',
    minInputs: 2,
    outExt: 'mp4',
    fields: [
      { k: 'listName', label: '临时列表文件名', type: 'text', def: '_concat_list.txt', col: 6,
        hint: '会自动写入输出目录，可用「保存附属文件」按钮生成。' },
      { k: 'useAbs', label: '列表中使用绝对路径', type: 'bool', def: true, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const listPath = U.join(ctx.outputDir, v.listName || '_concat_list.txt', ctx.platform);
      const lines = ctx.inputs.map((p) => {
        const file = v.useAbs ? p : U.base(p);
        return "file '" + String(file).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
      });
      const aux = [{ name: v.listName || '_concat_list.txt', path: listPath, content: lines.join('\n') + '\n', lang: 'text' }];
      const args = ['-c', 'copy', '-map', '0', '-avoid_negative_ts', 'make_zero'];
      args.push(...H.parseExtra(v.extra));
      return {
        preArgs: ['-f', 'concat', '-safe', '0'],
        inputs: [listPath],
        args, aux,
        notes: ['拼接前请先运行附带的列表文件生成步骤，或使用界面上的「保存附属文件」按钮。']
      };
    }
  });

  defOp({
    id: 'concat-filter',
    cat: 'concat',
    name: '重编码拼接（兼容任意片段）',
    desc: '分辨率/编码/帧率不同也能拼接，统一缩放到同一尺寸后合并。速度慢但最省心。',
    tags: ['拼接', '合并', '重编码'],
    scope: 'set',
    minInputs: 2,
    outExt: 'mp4',
    fields: [
      { k: 'width', label: '统一宽度', type: 'number', def: 1920, col: 4 },
      { k: 'height', label: '统一高度', type: 'number', def: 1080, col: 4 },
      { k: 'fps', label: '统一帧率', type: 'number', def: 30, col: 4 },
      { k: 'hasAudio', label: '输入包含音频', type: 'bool', def: true, col: 6 },
      { k: 'pad', label: '保持宽高比（黑边填充）', type: 'bool', def: true, col: 6 },
      ...vencFields('', ''),
      ...aencFields(''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const n = ctx.inputs.length;
      const W = v.width || 1920, Hh = v.height || 1080;
      const scale = v.pad
        ? `scale=${W}:${Hh}:force_original_aspect_ratio=decrease,pad=${W}:${Hh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${v.fps}`
        : `scale=${W}:${Hh}:force_original_aspect_ratio=decrease,setsar=1,fps=${v.fps}`;
      const parts = [];
      for (let i = 0; i < n; i++) {
        parts.push(`[${i}:v]${scale}[v${i}]`);
        if (v.hasAudio) parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      }
      const ins = [];
      for (let i = 0; i < n; i++) ins.push(`[v${i}]` + (v.hasAudio ? `[a${i}]` : ''));
      parts.push(`${ins.join('')}concat=n=${n}:v=1:a=${v.hasAudio ? 1 : 0}[vout]${v.hasAudio ? '[aout]' : ''}`);
      const args = ['-filter_complex', parts.join(';'), '-map', '[vout]'];
      if (v.hasAudio) args.push('-map', '[aout]');
      args.push(...vencArgs(v, ''));
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return { args, notes: [`共 ${n} 个片段，统一为 ${W}x${Hh} @${v.fps}fps。`] };
    }
  });

  defOp({
    id: 'concat-xfade',
    cat: 'concat',
    name: '带转场特效的拼接',
    desc: '两个片段之间加入淡入淡出 / 滑动 / 圆形等转场效果（xfade）。',
    tags: ['转场', 'xfade', '特效'],
    scope: 'set',
    minInputs: 2,
    outExt: 'mp4',
    fields: [
      { k: 'transition', label: '转场类型', type: 'select', def: 'fade', col: 6, options: [
        'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown',
        'circlecrop', 'rectcrop', 'distance', 'fadeblack', 'fadewhite', 'radial', 'smoothleft', 'smoothright',
        'circleopen', 'circleclose', 'vertopen', 'vertclose', 'horzopen', 'horzclose', 'dissolve', 'pixelize', 'hblur'
      ].map((x) => ({ v: x, label: x })) },
      { k: 'duration', label: '转场时长（秒）', type: 'number', def: 1, min: 0.1, step: 0.1, col: 3 },
      { k: 'offset', label: '第一段时长（秒，转场起点）', type: 'number', def: 5, min: 0, step: 0.1, col: 3,
        hint: '必须小于第一段视频的实际时长，可用输入区下方的「🔍 查看首个文件的信息」按钮查看。' },
      { k: 'width', label: '统一缩放到宽度', type: 'number', def: 1280, min: 64, col: 3,
        hint: 'xfade 要求两段画面尺寸、帧率一致，这里统一处理。' },
      { k: 'fps', label: '统一帧率', type: 'number', def: 30, min: 1, col: 3 },
      ...vencFields('', ''),
      { k: 'acodec', label: '音频处理', type: 'select', def: 'aac', col: 6, options: [
        { v: 'aac', label: '重新编码并交叉淡化' },
        { v: 'copy-first', label: '只保留第一段音频' },
        { v: 'none', label: '不要音频' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const n = ctx.inputs.length;
      const D = Number(v.duration) || 1;
      const parts = [];

      // 1) 先把每段画面统一成相同的帧率 / 尺寸 / 像素格式 / 时间基，否则 xfade 会报 Invalid argument
      for (let i = 0; i < n; i++) {
        parts.push(`[${i}:v]fps=${v.fps},scale=${v.width}:-2,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
      }
      // 2) 依次 xfade
      let cur = '[v0]';
      let off = Number(v.offset) || 0;
      for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? '[vout]' : `[vx${i}]`;
        parts.push(`${cur}[v${i}]xfade=transition=${v.transition}:duration=${D}:offset=${off.toFixed(3)}${out}`);
        cur = out;
        off += D + 1; // 多段时的粗略递推，需用户按实际时长微调
      }

      const maps = ['-map', '[vout]'];
      if (v.acodec === 'aac') {
        for (let i = 0; i < n; i++) {
          parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
        }
        let acur = '[a0]';
        for (let i = 1; i < n; i++) {
          const out = i === n - 1 ? '[aout]' : `[ax${i}]`;
          parts.push(`${acur}[a${i}]acrossfade=d=${D}:c1=tri:c2=tri${out}`);
          acur = out;
        }
        maps.push('-map', '[aout]');
      } else if (v.acodec === 'copy-first') {
        maps.push('-map', '0:a?');
      }

      const args = ['-filter_complex', parts.join(';'), ...maps];
      args.push(...vencArgs(v, ''));
      if (v.acodec === 'aac') args.push('-c:a', 'aac', '-b:a', '192k');
      else if (v.acodec === 'none') args.push('-an');
      args.push(...H.parseExtra(v.extra));

      return {
        args,
        notes: [
          `已把每段统一为 ${v.width}px 宽 / ${v.fps}fps 后再做转场，避免 xfade 因尺寸或时间基不一致而失败。`,
          'offset 表示「转场开始时前一段已播放的秒数」，必须小于第一段的实际时长，否则会报 Invalid argument。',
          n > 2 ? '超过两段时，后续 offset 是按「前一段时长 ≈ 上一段 offset + 转场时长 + 1 秒」估算的，请按实际时长核对。' : ''
        ].filter(Boolean)
      };
    }
  });

  defOp({
    id: 'concat-image-to-video',
    cat: 'image',
    name: '图片序列合成视频',
    desc: '把编号连续的图片（img001.jpg、img002.jpg…）合成为视频。',
    tags: ['序列', '图片转视频', 'timelapse'],
    scope: 'set',
    minInputs: 1,
    inputKind: 'image',
    outExt: 'mp4',
    fields: [
      { k: 'pattern', label: '图片文件名模板', type: 'text', def: 'img%03d.jpg', col: 6,
        hint: '需与目录中实际文件名一致，如 frame_%04d.png。' },
      { k: 'fps', label: '输入帧率（每秒几张图）', type: 'number', def: 25, min: 1, col: 3 },
      { k: 'startNumber', label: '起始编号', type: 'number', def: 1, min: 0, col: 3 },
      ...vencFields('', ''),
      { k: 'acodec', label: '音频', type: 'select', def: 'none', col: 6, options: [
        { v: 'none', label: '无音频' },
        { v: 'aac', label: '静音音轨' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const dir = ctx.inputKind === 'dir' ? ctx.input : U.dir(ctx.input);
      const pat = U.join(dir, v.pattern || 'img%03d.jpg', ctx.platform);
      const inputs = [{ path: pat, args: ['-framerate', String(v.fps), '-start_number', String(v.startNumber)] }];
      const args = [...vencArgs(v, '')];
      if (v.acodec === 'aac') {
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-c:a', 'aac', '-shortest');
      } else {
        args.push('-an');
      }
      args.push(...H.parseExtra(v.extra));
      return {
        inputs, args,
        notes: ['图片文件名模板需与文件夹中实际文件名一致，例如 img%03d.jpg 对应 img001.jpg、img002.jpg…']
      };
    }
  });

  /* ================================================================
   * 速度与帧率
   * ================================================================ */

  defOp({
    id: 'speed-change',
    cat: 'speed',
    name: '变速（画面+声音同步）',
    desc: '2 倍速、0.5 倍慢放等，声音一起变速且不会变调。',
    tags: ['变速', '倍速', '慢动作', 'setpts', 'atempo'],
    outExt: 'mp4',
    fields: [
      { k: 'speed', label: '速度倍数', type: 'number', def: 2, min: 0.1, max: 100, step: 0.1, col: 4,
        hint: '大于 1 加速，小于 1 慢放。如 0.5 表示半速。' },
      { k: 'keepAudio', label: '处理音频', type: 'bool', def: true, col: 4 },
      { k: 'keepPitch', label: '保持音调不变', type: 'bool', def: true, col: 4 },
      ...vencFields('', ''),
      ...aencFields(''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const sp = Number(v.speed) || 1;
      const vf = [`setpts=${(1 / sp).toFixed(6)}*PTS`];
      // 输入没有音轨时，[0:a] 会让 ffmpeg 报 "matches no streams"，直接按无音频处理
      const keepAudio = v.keepAudio && ctx.hasAudio !== false;
      const notes = [];
      if (v.keepAudio && !keepAudio) notes.push('检测到输入没有音轨，已自动按「只处理画面」生成。');
      const af = [];
      if (keepAudio) {
        if (v.keepPitch) {
          // atempo 单次只支持 0.5~100，用链式串联兼容任意倍数
          const chain = atempoChain(sp);
          af.push(`atempo=${chain.join(',atempo=')}`);
        } else {
          af.push(`asetrate=44100*${sp}`, 'aresample=44100');
        }
      }
      const args = [];
      if (keepAudio && af.length) args.push('-filter_complex', `[0:v]${vf.join(',')}[v];[0:a]${af.join(',')}[a]`, '-map', '[v]', '-map', '[a]');
      else { args.push('-vf', vf.join(',')); if (!keepAudio) args.push('-an'); }
      args.push(...vencArgs(v, ''));
      if (keepAudio) args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return { args, notes: [`速度 ${sp}x，输出时长约为原时长的 ${(100 / sp).toFixed(1)}%。`, ...notes] };
    }
  });

  defOp({
    id: 'speed-freeze',
    cat: 'speed',
    name: '定格画面（插入静止帧）',
    desc: '在指定时间点冻结画面 N 秒，常用于制作停顿强调效果。',
    tags: ['定格', 'freeze', 'loop'],
    outExt: 'mp4',
    fields: [
      { k: 'at', label: '定格时间点', type: 'time', def: '00:00:05', col: 4 },
      { k: 'hold', label: '定格时长（秒）', type: 'number', def: 3, min: 0.1, step: 0.1, col: 4 },
      ...vencFields('', ''),
      { k: 'acodec', label: '音频', type: 'select', def: 'aac', col: 4, options: [
        { v: 'aac', label: '保留原音频' }, { v: 'none', label: '不要音频' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const t = U.toSec(v.at) || 0;
      const hold = Number(v.hold) || 3;
      const fc = [
        `[0:v]trim=start=0:end=${t.toFixed(3)},setpts=PTS-STARTPTS[pre]`,
        `[0:v]trim=start=${t.toFixed(3)}:end=${(t + 0.04).toFixed(3)},setpts=PTS-STARTPTS,loop=loop=${Math.round(hold * 25)}:size=1:start=0,setpts=N/FRAME_RATE/TB[hold]`,
        `[0:v]trim=start=${t.toFixed(3)},setpts=PTS-STARTPTS[post]`,
        `[pre][hold][post]concat=n=3:v=1:a=0[vout]`
      ];
      const args = ['-filter_complex', fc.join(';'), '-map', '[vout]'];
      if (v.acodec === 'aac') args.push('-map', '0:a?');
      args.push(...vencArgs(v, ''));
      if (v.acodec === 'none') args.push('-an');
      args.push(...H.parseExtra(v.extra));
      return { args, notes: [`在 ${U.hms(t)} 处定格 ${hold} 秒。`] };
    }
  });

  defOp({
    id: 'speed-timelapse',
    cat: 'speed',
    name: '延时摄影（抽帧加速）',
    desc: '每隔 N 帧取 1 帧，快速浏览长视频，推荐配合「去除音频」。',
    tags: ['延时', '抽帧', 'timelapse'],
    outExt: 'mp4',
    fields: [
      { k: 'every', label: '每隔 N 帧取 1 帧', type: 'number', def: 30, min: 1, col: 4 },
      ...vencFields('', ''),
      { k: 'acodec', label: '音频', type: 'select', def: 'none', col: 4, options: [
        { v: 'none', label: '不要音频（推荐）' }, { v: 'aac', label: '保留音频' }
      ] },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const args = ['-vf', `select='not(mod(n\\,${v.every}))',setpts=N/FRAME_RATE/TB`];
      if (v.acodec === 'none') args.push('-an');
      args.push(...vencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return { args, notes: [`相当于 ${v.every} 倍速播放。`] };
    }
  });

  defOp({
    id: 'fps-change',
    cat: 'speed',
    name: '修改帧率',
    desc: '把视频帧率改成 24 / 25 / 30 / 60 等，解决音画不同步或平台要求。',
    tags: ['帧率', 'fps'],
    outExt: 'mp4',
    fields: [
      { k: 'fps', label: '目标帧率', type: 'number', def: 30, min: 1, max: 240, col: 4 },
      { k: 'mode', label: '处理方式', type: 'select', def: 'cfr', col: 8, options: [
        { v: 'cfr', label: '恒定帧率（复制/丢弃帧，推荐）' },
        { v: 'interp', label: '运动插值补帧（更流畅，很慢）' },
        { v: 'vfr', label: '可变帧率（仅调整时间戳）' }
      ] },
      ...vencFields('', ''),
      ...aencFields(''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const fps = v.fps || 30;
      const filters = [];
      if (v.mode === 'interp') filters.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`);
      else if (v.mode === 'cfr') filters.push(`fps=${fps}`);
      const args = [];
      if (filters.length) args.push('-vf', filters.join(','));
      if (v.mode === 'vfr') args.push('-r', String(fps));
      args.push(...vencArgs(v, ''));
      args.push(...aencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return { args, notes: v.mode === 'interp' ? ['运动插值非常消耗 CPU，建议先用短视频测试。'] : [] };
    }
  });

  defOp({
    id: 'fps-slow-motion-interp',
    cat: 'speed',
    name: '平滑慢动作（补帧）',
    desc: '先插值提升帧率再降速，得到顺滑的慢动作效果。',
    tags: ['慢动作', '补帧', 'slow motion'],
    outExt: 'mp4',
    fields: [
      { k: 'factor', label: '放慢倍数', type: 'number', def: 4, min: 1.1, step: 0.5, col: 4 },
      { k: 'srcFps', label: '源帧率', type: 'number', def: 30, min: 1, col: 4 },
      { k: 'keepAudio', label: '保留音频', type: 'bool', def: false, col: 4 },
      ...vencFields('', ''),
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const f = Number(v.factor) || 2;
      const srcFps = Number(v.srcFps) || 30;
      const targetFps = Math.min(240, Math.round(srcFps * f));
      const vf = `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1,setpts=${(1 / f).toFixed(4)}*PTS`;
      const args = ['-vf', vf];
      if (!v.keepAudio) args.push('-an');
      args.push(...vencArgs(v, ''));
      args.push(...H.parseExtra(v.extra));
      return { args, notes: [`补帧到 ${targetFps}fps 后放慢 ${f} 倍，运算量很大。`] };
    }
  });

  /* ================================================================
   * 图片与序列帧
   * ================================================================ */

  defOp({
    id: 'image-snapshot',
    cat: 'image',
    name: '单帧截图',
    desc: '在指定时间点截一张图，用于封面或预览。',
    tags: ['截图', '封面', 'thumbnail'],
    outExt: 'jpg',
    fields: [
      { k: 'at', label: '截图时间点', type: 'time', def: '00:00:03', col: 4 },
      { k: 'format', label: '图片格式', type: 'select', def: 'jpg', col: 4, options: [
        { v: 'jpg', label: 'JPG' }, { v: 'png', label: 'PNG（无损）' }, { v: 'webp', label: 'WebP' }
      ] },
      { k: 'quality', label: '质量 (1-31，越小越好)', type: 'number', def: 2, min: 1, max: 31, col: 4 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const t = H.timeArg(v.at) || '3';
      return {
        preArgs: ['-ss', t],
        args: [
          '-frames:v', '1', '-q:v', String(v.quality),
          ...H.parseExtra(v.extra)
        ],
        output: U.join(ctx.outputDir, U.stem(ctx.input) + '.' + v.format, ctx.platform),
        notes: ['-ss 放在 -i 前可快速定位；如截图偏黑请改用精确剪辑后再截图。']
      };
    }
  });

  defOp({
    id: 'image-thumbnail-grid',
    cat: 'image',
    name: '缩略图网格（雪碧图）',
    desc: '把整段视频抽成一张 N×M 的预览图，常用于视频网站的进度条预览。',
    tags: ['雪碧图', '预览图', 'sprite', 'tile'],
    outExt: 'jpg',
    fields: [
      { k: 'cols', label: '列数', type: 'number', def: 5, min: 1, col: 3 },
      { k: 'rows', label: '行数', type: 'number', def: 5, min: 1, col: 3 },
      { k: 'thumbW', label: '每格宽', type: 'number', def: 240, min: 16, col: 3 },
      { k: 'interval', label: '取样间隔（秒，0=自动均分）', type: 'number', def: 0, min: 0, col: 3 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const n = (v.cols || 5) * (v.rows || 5);
      const fps = v.interval > 0 ? (1 / v.interval).toFixed(6) : null;
      const vf = [
        fps ? `fps=${fps}` : `thumbnail=${n}`,
        `scale=${v.thumbW}:-1`,
        `tile=${v.cols}x${v.rows}`
      ];
      return {
        args: ['-vf', vf.join(','), '-frames:v', '1', ...H.parseExtra(v.extra)],
        notes: ['interval 为 0 时使用 thumbnail 滤镜自动挑选最具代表性的 ' + n + ' 帧。']
      };
    }
  });

  defOp({
    id: 'image-video-to-frames',
    cat: 'image',
    name: '视频拆成图片序列',
    desc: '按固定间隔导出 PNG/JPG 帧，用于训练数据或逐帧查看。',
    tags: ['拆帧', '序列', 'frames'],
    outExt: 'png',
    fields: [
      { k: 'fps', label: '每秒导出帧数', type: 'number', def: 1, min: 0.01, step: 0.5, col: 4,
        hint: '1 表示每秒 1 张；填 25 表示导出全部帧。' },
      { k: 'format', label: '图片格式', type: 'select', def: 'png', col: 4, options: [
        { v: 'png', label: 'PNG' }, { v: 'jpg', label: 'JPG' }
      ] },
      { k: 'scale', label: '缩放宽度（0=原始）', type: 'number', def: 0, min: 0, col: 4 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const out = U.join(ctx.outputDir, U.stem(ctx.input) + '_%05d.' + v.format, ctx.platform);
      const vf = [];
      if (v.scale > 0) vf.push(`scale=${v.scale}:-2`);
      const args = [];
      if (vf.length) args.push('-vf', vf.join(','));
      args.push('-q:v', '2', ...H.parseExtra(v.extra));
      return { args, output: out, notes: ['输出文件名中的 %05d 会自动编号：' + U.stem(ctx.input) + '_00001.png …'] };
    }
  });

  defOp({
    id: 'image-gif',
    cat: 'image',
    name: '视频转 GIF（高质量调色板）',
    desc: '先生成专属调色板再编码，颜色比默认方式好得多。',
    tags: ['gif', '动图'],
    outExt: 'gif',
    fields: [
      { k: 'start', label: '开始时间', type: 'time', def: '00:00:00', col: 3 },
      { k: 'dur', label: '持续时长', type: 'time', def: '00:00:05', col: 3 },
      { k: 'width', label: '宽度（高度自动）', type: 'number', def: 480, min: 32, col: 3 },
      { k: 'fps', label: '帧率', type: 'number', def: 15, min: 1, max: 50, col: 3 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const out = ctx.output;
      const palette = U.join(ctx.outputDir, '_palette_' + U.stem(ctx.input) + '.png', ctx.platform);
      const filter = `fps=${v.fps},scale=${v.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=sierra2_4a`;
      const preArgs = [];
      const s = H.timeArg(v.start);
      if (s && U.toSec(s) > 0) preArgs.push('-ss', s);
      const args = ['-t', H.timeArg(v.dur) || '5', '-vf', filter, '-loop', '0', ...H.parseExtra(v.extra)];
      return { preArgs, args, notes: ['使用 split + palettegen 单次生成调色板，画质最佳。'] };
    }
  });

  defOp({
    id: 'image-from-frames-clean',
    cat: 'image',
    name: '视频转 WebP 动图',
    desc: '体积比 GIF 小很多、色彩更丰富，现代浏览器与聊天软件都支持。',
    tags: ['webp', '动图'],
    outExt: 'webp',
    fields: [
      { k: 'start', label: '开始时间', type: 'time', def: '00:00:00', col: 4 },
      { k: 'dur', label: '持续时长', type: 'time', def: '00:00:05', col: 4 },
      { k: 'width', label: '宽度', type: 'number', def: 640, min: 32, col: 4 },
      { k: 'fps', label: '帧率', type: 'number', def: 20, min: 1, max: 50, col: 6 },
      { k: 'quality', label: '质量 0-100', type: 'number', def: 80, min: 0, max: 100, col: 6 },
      EXTRA_FIELD
    ],
    build(v, ctx) {
      const preArgs = [];
      const s = H.timeArg(v.start);
      if (s && U.toSec(s) > 0) preArgs.push('-ss', s);
      const args = [
        '-t', H.timeArg(v.dur) || '5',
        '-vf', `fps=${v.fps},scale=${v.width}:-1:flags=lanczos`,
        '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(v.quality), '-loop', '0',
        '-an', '-vsync', '0', ...H.parseExtra(v.extra)
      ];
      return { preArgs, args };
    }
  });

  /* ================================================================
   * 内部小工具
   * ================================================================ */

  function atempoChain(speed) {    const out = [];
    let s = Number(speed);
    if (!isFinite(s) || s <= 0) return ['1.0'];
    while (s > 2.0) { out.push('2.0'); s /= 2.0; }
    while (s < 0.5) { out.push('0.5'); s /= 0.5; }
    out.push(s.toFixed(6));
    return out;
  }

  function aencArgs(v, prefix) {
    const p = prefix || '';
    return H.audioArgs(v[p + 'acodec'], v[p + 'abitrate'], null, null);
  }

})();
