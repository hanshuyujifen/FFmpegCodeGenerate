/**
 * app.js —— 前端交互逻辑
 * 依赖：engine.js（FFGEN）+ recipes-*.js（注册好的分类与操作）
 */
(function () {
  'use strict';

  const ENGINE = window.FFGEN || { CATS: [], RECIPES: [], getRecipe: () => null, getCat: () => null, defaults: () => ({}), buildPlan: () => ({ ok: false, error: '操作库未加载' }), Quote: {}, U: {} };
  const { CATS, RECIPES, getRecipe, getCat, defaults, buildPlan, U } = ENGINE;

  /* ================================================================
   * 全局状态
   * ================================================================ */

  const S = {
    platform: 'win32',
    isWindows: true,
    apiOk: false,               // 本地服务是否可用
    ffmpegAvailable: null,
    ffmpegBin: 'ffmpeg',
    inputMode: 'folder',
    inputPath: '',
    inputFiles: [],             // 已勾选、参与处理的文件
    scannedFiles: [],           // 扫描出来的全部文件
    outputDir: '',
    suffix: '_out',
    overwrite: true,
    steps: [],                  // { uid, recipeId, values, open }
    activeCat: (CATS[0] && CATS[0].id) || 'trim',
    search: '',
    plan: null,
    scriptLang: 'bat',
    audioMode: 'auto',          // auto | yes | no
    hasAudio: null,             // 自动探测结果：true / false / null(未知)
    qualityMode: 'source',      // source | nearlossless | high | standard | small | off
    srcInfo: null,              // 首个输入的 ffprobe 摘要
    encoders: [],               // 本机 ffmpeg 支持的编码器
    probedSig: '',              // 已探测过的文件签名，避免重复探测
    running: false,
    abortCtl: null,
    uid: 0
  };

  let planTimer = null;

  /* ================================================================
   * 小工具
   * ================================================================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, kind, ms) {
    const wrap = $('#toastWrap');
    const t = el('div', 'toast ' + (kind || ''), msg);
    wrap.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 220);
    }, ms || 2600);
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = el('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      toast((label || '内容') + '已复制', 'ok', 1600);
      return true;
    } catch (e) {
      toast('复制失败，请手动选中复制', 'err');
      return false;
    }
  }

  /* ================================================================
   * 本地服务 API
   * ================================================================ */

  const API = {
    async get(p) {
      const r = await fetch(p, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
    async post(p, body) {
      const r = await fetch(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }
  };

  /* ================================================================
   * 初始化
   * ================================================================ */

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindStaticEvents();
    renderCategories();
    renderOps();
    renderPipeline();
    // 窄屏下默认收起右侧面板，避免遮住主内容
    if (window.innerWidth < 1360) $('.layout').classList.add('panel-hidden');
    detectEnv();
    regenerate();
  }

  async function detectEnv() {
    try {
      const env = await API.get('/api/env');
      S.apiOk = true;
      S.platform = env.platform === 'win32' ? 'win32' : 'linux';
      S.isWindows = !!env.isWindows;
      S.ffmpegAvailable = !!(env.ffmpeg && env.ffmpeg.available);
      S.encoders = Array.isArray(env.encoders) ? env.encoders : [];

      $('#envNode').textContent = env.node || '—';
      $('#envOs').textContent = S.isWindows ? 'Windows' : (env.platform === 'darwin' ? 'macOS' : 'Linux');

      const st = $('#ffStatus');
      if (S.ffmpegAvailable) {
        S.ffmpegBin = 'ffmpeg';
        st.className = 'badge badge-ok';
        st.title = env.ffmpeg.path + '\n' + env.ffmpeg.version;
        $('.badge-text', st).textContent = 'FFmpeg 可用';
        $('#envFf').textContent = (env.ffmpeg.version || '').replace(/^ffmpeg version\s*/i, '').slice(0, 22);
      } else {
        st.className = 'badge badge-warn';
        st.title = (env.ffmpeg && env.ffmpeg.error) || '未检测到 ffmpeg';
        $('.badge-text', st).textContent = '未检测到 FFmpeg';
        $('#envFf').textContent = '未安装';
        banner('未检测到可用的 ffmpeg：命令仍可正常生成和复制，但网页内「执行」会失败。请安装 ffmpeg 并加入 PATH，或把 ffmpeg.exe 放进项目 bin 目录。', 'warn');
      }
    } catch (e) {
      S.apiOk = false;
      S.platform = navigator.userAgent.indexOf('Windows') >= 0 ? 'win32' : 'linux';
      const st = $('#ffStatus');
      st.className = 'badge badge-warn';
      st.title = '未连接到本地服务，路径浏览与直接执行不可用';
      $('.badge-text', st).textContent = '离线模式';
      $('#envNode').textContent = '—';
      $('#envOs').textContent = S.platform === 'win32' ? 'Windows' : '其他';
      $('#envFf').textContent = '未知';
      banner('当前页面没有连上本地服务（请用「启动服务.bat」打开 http://127.0.0.1:8787）。你仍然可以手动填写输入/输出路径并生成、复制命令。', 'warn');
    }
    regenerate();
  }

  function banner(text, kind) {
    const b = $('#panelBanner');
    b.hidden = false;
    b.className = 'panel-banner ' + (kind || '');
    b.textContent = text;
  }
  function clearBanner() { $('#panelBanner').hidden = true; }

  /* ================================================================
   * 事件绑定
   * ================================================================ */

  function bindStaticEvents() {
    /* ---- 搜索 ---- */
    const search = $('#opSearch');
    search.addEventListener('input', () => {
      S.search = search.value.trim();
      if (S.search) { S.activeCat = null; }
      else if (!S.activeCat && CATS[0]) { S.activeCat = CATS[0].id; }
      renderCategories();
      renderOps();
    });

    /* ---- 输入方式 ---- */
    $$('#inputMode .seg').forEach((b) => {
      b.addEventListener('click', () => {
        $$('#inputMode .seg').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        S.inputMode = b.dataset.mode;
        updateInputHint();
        if (S.inputMode === 'folder') rescan();
        else { $('#fileListWrap').hidden = true; }
        regenerate();
      });
    });

    $('#inputPath').addEventListener('change', () => {
      S.inputPath = $('#inputPath').value.trim();
      if (S.inputMode === 'folder') rescan();
      else collectDirect();
      regenerate();
    });
    $('#inputPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#inputPath').blur(); });

    $('#outputDir').addEventListener('change', () => { S.outputDir = $('#outputDir').value.trim(); regenerate(); });
    $('#outputDir').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#outputDir').blur(); });

    $('#suffix').addEventListener('input', () => { S.suffix = $('#suffix').value; scheduleRegen(); });
    $('#optOverwrite').addEventListener('change', () => { S.overwrite = $('#optOverwrite').checked; regenerate(); });

    $('#btnPickInput').addEventListener('click', () => nativePick(S.inputMode === 'folder' ? 'dir' : (S.inputMode === 'single' ? 'file' : 'files'), (paths) => {
      if (S.inputMode === 'files') {
        S.inputPath = paths.join('; ');
        $('#inputPath').value = S.inputPath;
        collectDirect();
      } else {
        S.inputPath = paths[0] || '';
        $('#inputPath').value = S.inputPath;
        if (S.inputMode === 'folder') rescan(); else collectDirect();
      }
      regenerate();
    }));
    $('#btnPickOutput').addEventListener('click', () => nativePick('dir', (paths) => {
      S.outputDir = paths[0] || '';
      $('#outputDir').value = S.outputDir;
      regenerate();
    }));

    $('#btnBrowseInput').addEventListener('click', () => openFs(S.inputMode === 'folder' ? 'dir' : 'file', S.inputPath, (p) => {
      S.inputPath = p; $('#inputPath').value = p;
      if (S.inputMode === 'folder') rescan(); else collectDirect();
      regenerate();
    }));
    $('#btnBrowseOutput').addEventListener('click', () => openFs('dir', S.outputDir, (p) => {
      S.outputDir = p; $('#outputDir').value = p; regenerate();
    }));

    $('#btnPasteInput').addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (t) {
          S.inputPath = t.trim(); $('#inputPath').value = S.inputPath;
          if (S.inputMode === 'folder') rescan(); else collectDirect();
          regenerate();
        }
      } catch (e) { toast('浏览器不允许读取剪贴板，请用 Ctrl+V 粘贴', 'warn'); }
    });

    $('#btnRescan').addEventListener('click', rescan);
    $('#chkRecursive').addEventListener('change', rescan);
    $('#selFilter').addEventListener('change', rescan);
    $('#chkAll').addEventListener('change', () => {
      const on = $('#chkAll').checked;
      $$('#fileList input[type=checkbox]').forEach((c) => { c.checked = on; });
      collectChecked();
      regenerate();
    });

    $('#btnCheckPaths').addEventListener('click', checkPaths);
    $('#btnProbe').addEventListener('click', probeFirst);
    $('#selHasAudio').addEventListener('change', () => {
      S.audioMode = $('#selHasAudio').value;
      renderAudioBadge();
      regenerate();
    });
    $('#selQuality').addEventListener('change', () => {
      S.qualityMode = $('#selQuality').value;
      renderQualityBadge();
      // 「跟随源素材」需要知道源编码器，没探测过就补一次
      if (S.qualityMode === 'source') autoDetectAudio();
      regenerate();
    });

    /* ---- 折叠 ---- */
    $$('[data-collapse]').forEach((b) => {
      b.addEventListener('click', () => {
        const body = document.getElementById(b.dataset.collapse);
        const open = !body.classList.contains('collapsed');
        body.classList.toggle('collapsed', open);
        b.textContent = open ? '展开' : '收起';
      });
    });

    /* ---- 流水线 ---- */
    $('#btnClearPipe').addEventListener('click', () => {
      if (!S.steps.length) return;
      if (!confirm('确定清空流水线里的全部操作吗？')) return;
      S.steps = []; renderPipeline(); regenerate();
    });

    /* ---- 面板 ---- */
    $('#btnTogglePanel').addEventListener('click', () => {
      $('.layout').classList.toggle('panel-hidden');
      requestAnimationFrame(fitFilterInputWidths);
    });
    $('#btnClosePanel').addEventListener('click', () => $('.layout').classList.add('panel-hidden'));

    $$('#panelTabs .tab').forEach((t) => {
      t.addEventListener('click', () => {
        $$('#panelTabs .tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
      });
    });

    $$('#scriptLang .seg').forEach((b) => {
      b.addEventListener('click', () => {
        $$('#scriptLang .seg').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        S.scriptLang = b.dataset.lang;
        renderScript();
      });
    });

    /* ---- 命令操作 ---- */
    $('#btnCopyAll').addEventListener('click', () => {
      if (!S.plan || !S.plan.ok) return toast('还没有可复制的命令', 'warn');
      copyText(S.plan.scripts.txt, '命令清单');
    });
    $('#btnRunAll').addEventListener('click', runAll);
    $('#btnStopRun').addEventListener('click', () => { if (S.abortCtl) S.abortCtl.abort(); });
    $('#btnClearLog').addEventListener('click', () => { $('#logBox').textContent = ''; });

    $('#btnCopyScript').addEventListener('click', () => {
      const box = $('#scriptBox');
      copyText(box.textContent, '脚本');
    });
    $('#btnSaveScript').addEventListener('click', saveScript);
    $('#btnDownloadScript').addEventListener('click', downloadScript);
    $('#btnSaveAux').addEventListener('click', saveAllAux);

    /* ---- 弹窗 ---- */
    $('#fsClose').addEventListener('click', closeFs);
    $('#fsCancel').addEventListener('click', closeFs);
    $('#fsUp').addEventListener('click', () => fsLoad(fsParent(fsCurrent)));
    $('#fsGo').addEventListener('click', () => fsLoad($('#fsPath').value.trim()));
    $('#fsPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') fsLoad($('#fsPath').value.trim()); });
    $('#fsConfirm').addEventListener('click', fsConfirm);
    $('#fsModal').addEventListener('click', (e) => { if (e.target.id === 'fsModal') closeFs(); });

    $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });
    $('#helpClose').addEventListener('click', () => { $('#helpModal').hidden = true; });
    $('#helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') $('#helpModal').hidden = true; });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#fsModal').hidden) closeFs();
        else if (!$('#helpModal').hidden) $('#helpModal').hidden = true;
      }
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault(); $('#opSearch').focus();
      }
    });

    updateInputHint();
  }

  function updateInputHint() {
    const h = $('#inputPathHint');
    if (S.inputMode === 'folder') h.textContent = '把要处理的视频放在哪个文件夹（会自动扫描）';
    else if (S.inputMode === 'single') h.textContent = '直接填一个视频文件的完整路径';
    else h.textContent = '填多个文件路径，用分号 ; 或换行分隔';
    $('#inputPath').placeholder = S.inputMode === 'folder'
      ? '例如 C:\\Users\\你\\Videos'
      : '例如 C:\\Users\\你\\Videos\\a.mp4';
  }

  /* ================================================================
   * 分类 & 操作渲染
   * ================================================================ */

  function renderCategories() {
    const list = $('#catList');
    list.innerHTML = '';
    CATS.forEach((c) => {
      const n = RECIPES.filter((r) => r.cat === c.id).length;
      const li = el('li', 'cat-item' + (S.activeCat === c.id ? ' active' : ''));
      li.innerHTML = `<span class="cat-icon">${esc(c.icon || '•')}</span>
                      <span class="cat-name">${esc(c.name)}</span>
                      <span class="cat-num">${n}</span>`;
      li.title = c.desc || c.name;
      li.addEventListener('click', () => {
        S.activeCat = c.id;
        S.search = ''; $('#opSearch').value = '';
        renderCategories(); renderOps();
        $('#opBody').classList.remove('collapsed');
        $('[data-collapse="opBody"]').textContent = '收起';
      });
      list.appendChild(li);
    });
  }

  function currentRecipes() {
    if (S.search) {
      const q = S.search.toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      return RECIPES.filter((r) => {
        const hay = (r.name + ' ' + (r.desc || '') + ' ' + (r.tags || []).join(' ') + ' ' + r.id).toLowerCase();
        return words.every((w) => hay.indexOf(w) >= 0);
      });
    }
    return RECIPES.filter((r) => r.cat === S.activeCat);
  }

  function renderOps() {
    const box = $('#opList');
    const cats = $('#catCards');
    const list = currentRecipes();

    // 顶部分类快捷条
    cats.innerHTML = '';
    if (S.search) {
      const info = el('span', 'muted', `搜索「${S.search}」找到 ${list.length} 个操作`);
      cats.appendChild(info);
    } else {
      CATS.forEach((c) => {
        const chip = el('button', 'cat-card' + (S.activeCat === c.id ? ' active' : ''));
        chip.innerHTML = `<span>${esc(c.icon || '')}</span><span>${esc(c.name)}</span>`;
        chip.addEventListener('click', () => {
          S.activeCat = c.id; renderCategories(); renderOps();
        });
        cats.appendChild(chip);
      });
    }

    $('#opCountLabel').textContent = `（共 ${RECIPES.length} 个操作）`;

    box.innerHTML = '';
    $('#opEmpty').hidden = list.length > 0;

    list.forEach((r) => {
      const cat = getCat(r.cat) || { color: '#4f8cff', name: '' };
      const card = el('div', 'opcard');
      card.style.setProperty('--cat-color', cat.color || '#4f8cff');
      // 让用户一眼看出这个操作会不会重新编码
      let kind = '';
      try { kind = ENGINE.encodeKind ? ENGINE.encodeKind(r) : ''; } catch (_) { kind = ''; }
      const KIND_BADGE = {
        copy: '<span class="opkind opkind-copy" title="这个操作默认不重新编码，画质零损失">流复制</span>',
        encode: '<span class="opkind opkind-enc" title="这个操作需要重新编码，画质由上方「画质档位」决定">需重编码</span>',
        image: '<span class="opkind opkind-enc" title="导出为图片，与视频编码无关">导出图片</span>',
        analysis: '<span class="opkind" title="只做分析，不产生文件">只分析</span>'
      };
      const kindBadge = KIND_BADGE[kind] || '';
      card.innerHTML = `
        ${r.scope === 'set' ? '<span class="opbadge">多文件</span>' : ''}
        <div class="opname">${esc(r.name)}</div>
        <div class="opdesc">${esc(r.desc || '')}</div>
        <div class="optags">${kindBadge}${(r.tags || []).slice(0, 3).map((t) => `<span class="optag">${esc(t)}</span>`).join('')}</div>
        <div class="opadd">+ 加入流水线</div>`;
      card.title = (cat.name ? '【' + cat.name + '】' : '') + (r.desc || '');
      card.addEventListener('click', () => addStep(r.id));
      box.appendChild(card);
    });
  }

  /* ================================================================
   * 流水线
   * ================================================================ */

  function addStep(recipeId) {
    const r = getRecipe(recipeId);
    if (!r) return;
    S.steps.push({ uid: ++S.uid, recipeId, values: defaults(r), open: true });
    renderPipeline();
    regenerate();
    const item = $(`.pipeitem[data-uid="${S.uid}"]`);
    if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    toast('已加入：' + r.name, 'ok', 1500);
  }

  function renderPipeline() {
    const ol = $('#pipeline');
    const count = S.steps.length;
    $('#pipeCount').textContent = count ? `（${count} 个操作）` : '';
    $('#pipeEmpty').hidden = count > 0;
    ol.innerHTML = '';

    S.steps.forEach((step, idx) => {
      const r = getRecipe(step.recipeId);
      if (!r) return;
      const cat = getCat(r.cat) || {};
      const li = el('li', 'pipeitem' + (step.open ? ' open' : ''));
      li.dataset.uid = step.uid;
      li.draggable = true;

      const head = el('div', 'pipehead');
      head.innerHTML = `
        <span class="pipeorder">${idx + 1}</span>
        <div class="pipetitle">
          <div class="pname">${esc(r.name)}</div>
          <div class="psub">${esc(summaryOf(r, step.values))}</div>
        </div>
        <div class="pipebtns">
          <button class="iconbtn" data-act="up" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" data-act="down" title="下移" ${idx === count - 1 ? 'disabled' : ''}>↓</button>
          <button class="iconbtn" data-act="clone" title="复制一份">⧉</button>
          <button class="iconbtn danger" data-act="del" title="移除">✕</button>
          <button class="iconbtn" data-act="toggle" title="展开/收起参数">${step.open ? '▾' : '▸'}</button>
        </div>`;
      head.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (btn) {
          e.stopPropagation();
          handlePipeAction(btn.dataset.act, idx);
          return;
        }
        step.open = !step.open;
        renderPipeline();
      });
      li.appendChild(head);

      if (step.open) {
        const body = el('div', 'pipebody');
        const grid = el('div', 'grid12');
        (r.fields || []).forEach((f) => grid.appendChild(renderField(f, step, r)));
        body.appendChild(grid);

        const notes = (r.desc ? [{ t: 'info', m: r.desc }] : []);
        if (notes.length) {
          const nbox = el('div', 'pipenotes');
          notes.forEach((n) => nbox.appendChild(el('div', 'note', 'ℹ️ ' + n.m)));
          body.appendChild(nbox);
        }
        li.appendChild(body);
      }

      /* 拖拽排序 */
      li.addEventListener('dragstart', (e) => {
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop-target'); });
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop-target');
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (isNaN(from) || from === idx) return;
        const [m] = S.steps.splice(from, 1);
        S.steps.splice(idx, 0, m);
        renderPipeline(); regenerate();
      });

      ol.appendChild(li);
    });
  }

  function handlePipeAction(act, idx) {
    const step = S.steps[idx];
    if (!step) return;
    if (act === 'del') { S.steps.splice(idx, 1); renderPipeline(); regenerate(); return; }
    if (act === 'up' && idx > 0) { S.steps.splice(idx - 1, 0, S.steps.splice(idx, 1)[0]); renderPipeline(); regenerate(); return; }
    if (act === 'down' && idx < S.steps.length - 1) { S.steps.splice(idx + 1, 0, S.steps.splice(idx, 1)[0]); renderPipeline(); regenerate(); return; }
    if (act === 'clone') {
      const r = getRecipe(step.recipeId);
      S.steps.splice(idx + 1, 0, {
        uid: ++S.uid, recipeId: step.recipeId,
        values: JSON.parse(JSON.stringify(step.values)),
        open: true
      });
      renderPipeline(); regenerate(); return;
    }
    if (act === 'toggle') { step.open = !step.open; renderPipeline(); return; }
  }

  function summaryOf(r, v) {
    const bits = [];
    (r.fields || []).forEach((f) => {
      if (f.type === 'bool') { if (v[f.k]) bits.push(f.label.replace(/[（(].*?[)）]/g, '')); return; }
      const val = v[f.k];
      if (val === '' || val == null) return;
      if (f.type === 'select') {
        const opt = (f.options || []).find((o) => (o.v != null ? o.v : o) === val);
        const label = opt ? (opt.label || opt.v || opt) : val;
        bits.push(String(label).replace(/[（(].*?[)）]/g, '').slice(0, 18));
      } else if (f.type === 'number' || f.type === 'time' || f.type === 'text') {
        bits.push(f.label.replace(/[（(].*?[)）]/g, '').slice(0, 10) + '=' + String(val).slice(0, 20));
      }
    });
    return bits.slice(0, 5).join(' · ') || '使用默认参数';
  }

  /* ================================================================
   * 字段渲染
   * ================================================================ */

  function renderField(f, step, recipe) {
    const v = step.values;
    const wrap = el('div', 'field col-' + (f.col || 6));
    if (typeof f.showIf === 'function' && !f.showIf(v)) { wrap.hidden = true; return wrap; }

    const label = el('label', 'field-label');
    label.textContent = f.label;
    if (f.hint) {
      const h = el('span', 'hint', f.hint);
      label.appendChild(h);
    }

    let input;
    const commit = () => { scheduleRegen(); refreshSummary(step); };

    if (f.type === 'select') {
      input = el('select', 'select');
      (f.options || []).forEach((o) => {
        const val = o && typeof o === 'object' ? (o.v != null ? o.v : o) : o;
        const lab = o && typeof o === 'object' ? (o.label || o.v) : o;
        const op = el('option', null, String(lab));
        op.value = String(val);
        input.appendChild(op);
      });
      input.value = v[f.k] == null ? '' : String(v[f.k]);
      input.addEventListener('change', () => {
        v[f.k] = input.value;
        renderPipeline();
        regenerate();
      });
    } else if (f.type === 'bool') {
      const line = el('label', 'checkline');
      input = el('input'); input.type = 'checkbox';
      input.checked = !!v[f.k];
      input.addEventListener('change', () => { v[f.k] = input.checked; renderPipeline(); regenerate(); });
      line.appendChild(input);
      line.appendChild(el('span', null, f.on || '启用'));
      wrap.appendChild(label);
      wrap.appendChild(line);
      return wrap;
    } else if (f.type === 'textarea') {
      input = el('textarea', 'textarea');
      input.value = v[f.k] == null ? '' : v[f.k];
      input.placeholder = f.placeholder || '';
      input.rows = f.rows || 4;
      input.addEventListener('input', () => { v[f.k] = input.value; commit(); });
    } else if (f.type === 'number') {
      input = el('input', 'input');
      input.type = 'number';
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.step != null) input.step = f.step;
      input.value = v[f.k] == null ? '' : v[f.k];
      input.placeholder = f.placeholder || '';
      input.addEventListener('input', () => {
        v[f.k] = input.value === '' ? '' : Number(input.value);
        commit();
      });
    } else {
      input = el('input', 'input');
      input.type = f.type === 'path' ? 'text' : 'text';
      input.value = v[f.k] == null ? '' : v[f.k];
      input.placeholder = f.placeholder || (f.type === 'time' ? '00:01:30 或 90' : '');
      if (f.type === 'path' || f.type === 'dir') input.spellcheck = false;
      input.addEventListener('input', () => { v[f.k] = input.value; commit(); });

      if (f.type === 'path' || f.type === 'dir') {
        const row = el('div', 'pathrow');
        row.appendChild(input);
        const pb = el('button', 'btn btn-icon', '📂');
        pb.type = 'button'; pb.title = '选择';
        pb.addEventListener('click', () => {
          nativePick(f.type === 'dir' ? 'dir' : 'file', (paths) => {
            v[f.k] = paths[0]; input.value = paths[0];
            scheduleRegen(); refreshSummary(step);
          });
        });
        row.appendChild(pb);
        wrap.appendChild(label);
        wrap.appendChild(row);
        return wrap;
      }
    }

    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function refreshSummary(step) {
    const li = $(`.pipeitem[data-uid="${step.uid}"]`);
    if (!li) return;
    const r = getRecipe(step.recipeId);
    const sub = $('.psub', li);
    if (sub && r) sub.textContent = summaryOf(r, step.values);
  }

  function fitFilterInputWidths() { /* 预留：面板切换时的宽度修正 */ }

  /* ================================================================
   * 输入收集 / 扫描
   * ================================================================ */

  function collectDirect() {
    const raw = S.inputPath;
    const parts = raw.split(/\s*(?:;|\n|\|)\s*/).map((s) => s.trim()).filter(Boolean);
    S.inputFiles = parts;
    S.scannedFiles = parts.map((p) => ({ name: U.base(p), path: p, kind: 'video' }));
  }

  function collectChecked() {
    S.inputFiles = $$('#fileList input[type=checkbox]')
      .filter((c) => c.checked)
      .map((c) => c.dataset.path);
  }

  async function rescan() {
    if (S.inputMode !== 'folder') { collectDirect(); return; }
    if (!S.apiOk) { collectDirect(); return; }
    const p = ($('#inputPath').value || S.inputPath || '').trim();
    S.inputPath = p;
    if (!p) { $('#fileListWrap').hidden = true; S.scannedFiles = []; S.inputFiles = []; renderFileList(); return; }

    const use = ($('#selFilter').value || 'video').split(',');
    $('#fileCount').textContent = '扫描中…';
    $('#fileListWrap').hidden = false;
    try {
      const r = await API.post('/api/fs/scan', {
        path: p, recursive: $('#chkRecursive').checked, use, sort: 'name'
      });
      if (!r.ok) {
        toast(r.error || '扫描失败', 'err');
        $('#fileCount').textContent = '扫描失败';
        S.scannedFiles = []; S.inputFiles = []; renderFileList();
        return;
      }
      S.scannedFiles = r.files || [];
      renderFileList();
      collectChecked();
      regenerate();
    } catch (e) {
      toast('扫描失败：' + e.message, 'err');
      $('#fileCount').textContent = '扫描失败';
    }
  }

  function renderFileList() {
    const box = $('#fileList');
    box.innerHTML = '';
    const files = S.scannedFiles;
    $('#fileCount').textContent = `${files.length} 个文件`;
    if (!files.length) {
      box.appendChild(el('div', 'empty', '这个位置没有找到媒体文件'));
      return;
    }
    const icons = { video: '🎞️', audio: '🎵', image: '🖼️', subtitle: '💬', other: '📄' };
    files.forEach((f) => {
      const row = el('label', 'fileitem');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.path = f.path;
      cb.addEventListener('change', () => { collectChecked(); regenerate(); });
      row.appendChild(cb);
      row.appendChild(el('span', 'fkind', icons[f.kind] || '📄'));
      row.appendChild(el('span', 'fname', f.name));
      row.appendChild(el('span', 'fmeta', (f.ext || '').replace('.', '').toUpperCase()));
      box.appendChild(row);
    });
    $('#chkAll').checked = true;
  }

  async function checkPaths() {
    const st = $('#pathStatus');
    if (!S.apiOk) { st.className = 'err'; st.textContent = '未连接本地服务，无法校验'; return; }
    const inP = ($('#inputPath').value || '').trim();
    const outP = ($('#outputDir').value || '').trim();
    if (!inP) { st.className = 'err'; st.textContent = '请先填写输入位置'; return; }
    if (!outP) { st.className = 'err'; st.textContent = '请先填写输出文件夹'; return; }
    st.className = ''; st.textContent = '检查中…';
    try {
      const a = await API.post('/api/fs/stat', { path: inP });
      const b = await API.post('/api/fs/stat', { path: outP });
      const msgs = [];
      if (!a.ok) msgs.push('❌ 输入路径不可访问');
      else msgs.push(a.isDirectory ? `✅ 输入是一个文件夹` : `✅ 输入是文件（${U.base(a.path)}）`);
      if (b.ok && b.isDirectory) msgs.push('✅ 输出文件夹存在');
      else if (b.ok) msgs.push('❌ 输出路径是一个文件，不是文件夹');
      else {
        const mk = await API.post('/api/fs/mkdir', { path: outP });
        msgs.push(mk.ok ? '✅ 输出文件夹已自动创建' : '❌ 输出文件夹无法创建：' + mk.error);
      }
      st.className = msgs.some((m) => m.startsWith('❌')) ? 'err' : 'ok';
      st.textContent = msgs.join('　');
    } catch (e) {
      st.className = 'err';
      st.textContent = '检查失败：' + e.message;
    }
  }

  async function probeFirst() {
    const st = $('#pathStatus');
    if (!S.apiOk) { st.className = 'err'; st.textContent = '未连接本地服务，无法读取媒体信息'; return; }
    const f = (S.inputFiles && S.inputFiles[0]) || ($('#inputPath').value || '').trim();
    if (!f) { st.className = 'err'; st.textContent = '请先指定输入'; return; }
    st.className = ''; st.textContent = '正在读取媒体信息…';
    try {
      const r = await API.post('/api/probe', { path: f });
      if (!r.ok) { st.className = 'err'; st.textContent = '读取失败：' + (r.error || ''); return; }
      const s = r.summary;
      const bits = [
        U.base(f),
        s.duration != null ? '时长 ' + U.humanDur(s.duration) : null,
        s.width ? s.width + '×' + s.height : null,
        s.fps ? s.fps + 'fps' : null,
        s.vcodec ? '视频 ' + s.vcodec + (s.pixFmt ? '/' + s.pixFmt : '') : '无视频流',
        s.acodec ? '音频 ' + s.acodec + (s.sampleRate ? ' ' + s.sampleRate + 'Hz' : '') + (s.channels ? ' ' + s.channels + 'ch' : '') : '无音频流',
        s.size ? U.humanSize(s.size) : null,
        s.streamCount + ' 条流'
      ].filter(Boolean);
      st.className = 'ok';
      st.textContent = bits.join('　|　');
      toast('媒体信息已显示在「检查路径」旁边', 'ok', 2200);
    } catch (e) {
      st.className = 'err';
      st.textContent = '读取失败：' + e.message;
    }
  }

  /* ================================================================
   * 音轨检测
   *
   * 有些操作（剪辑多区间、变速、拼接）必须在滤镜里引用 [0:a]。
   * 如果素材根本没有音轨，ffmpeg 会报
   *   Stream specifier ':a' ... matches no streams
   * 所以这里用 ffprobe 探一下首个输入有没有音频流，并允许用户手动覆盖。
   * ================================================================ */

  function effHasAudio() {
    if (S.audioMode === 'yes') return true;
    if (S.audioMode === 'no') return false;
    return S.hasAudio; // true / false / null(未知)
  }

  function renderAudioBadge() {
    const b = $('#audioBadge');
    if (!b) return;
    const txt = $('.badge-text', b);
    if (S.audioMode !== 'auto') {
      b.className = 'badge';
      txt.textContent = S.audioMode === 'yes' ? '手动：有音轨' : '手动：无音轨';
      return;
    }
    const v = S.hasAudio;
    if (v === true) { b.className = 'badge badge-ok'; txt.textContent = '检测到音轨'; }
    else if (v === false) { b.className = 'badge badge-warn'; txt.textContent = '检测到无音轨'; }
    else { b.className = 'badge'; txt.textContent = '未检测'; }
  }

  let audioProbing = false;
  async function autoDetectAudio() {
    if (S.audioMode !== 'auto' && S.qualityMode !== 'source') { renderAudioBadge(); return; }
    if (!S.apiOk) { renderAudioBadge(); return; }
    const f = (S.inputFiles && S.inputFiles[0]) || '';
    if (!f) { S.hasAudio = null; S.srcInfo = null; S.probedSig = ''; renderAudioBadge(); renderQualityBadge(); return; }
    if (audioProbing || f === S.probedSig) { renderAudioBadge(); return; }
    audioProbing = true;
    S.probedSig = f;
    try {
      const r = await API.post('/api/probe', { path: f });
      if (r && r.ok && r.summary) {
        S.srcInfo = r.summary;
        if (S.audioMode === 'auto') S.hasAudio = !!r.summary.acodec;
      } else {
        S.srcInfo = null;
        S.hasAudio = null;
      }
    } catch (_) {
      S.srcInfo = null;
      S.hasAudio = null;
    }
    audioProbing = false;
    renderAudioBadge();
    renderQualityBadge();
    regenerate();
  }

  /* ---------------- 画质档位 ---------------- */

  const QUALITY_TABLE = {
    nearlossless: { crf: 16, preset: 'slow' },
    high: { crf: 18, preset: 'medium' },
    standard: { crf: 23, preset: 'medium' },
    small: { crf: 28, preset: 'fast' },
    source: { crf: 18, preset: 'medium' }
  };

  /**
   * 把「画质档位」解析成具体的编码参数。
   * 跟随源素材：源是 HEVC 就用 libx265、源是 10bit 就保持 10bit，
   * 这样重编码后看起来和原片一致，而不是把 HEVC 4K 硬转成 H.264 8bit。
   */
  function resolveQuality() {
    const mode = S.qualityMode;
    if (mode === 'off') return null;
    const base = QUALITY_TABLE[mode] || QUALITY_TABLE.high;
    const q = { mode: 'crf', crf: base.crf, preset: base.preset };
    if (mode !== 'source') return q;

    const src = S.srcInfo || {};
    const vc = String(src.vcodec || '').toLowerCase();
    const has = (n) => S.encoders.indexOf(n) >= 0;
    if (/hevc|h265/.test(vc) && has('libx265')) q.vcodec = 'libx265';
    else if (/h264/.test(vc) && has('libx264')) q.vcodec = 'libx264';
    else if (/av1/.test(vc) && has('libsvtav1')) q.vcodec = 'libsvtav1';
    else if (/prores/.test(vc) && has('prores_ks')) q.vcodec = 'prores_ks';

    // 10bit 源 + libx265 时保住位深，别压回 8bit
    if (q.vcodec === 'libx265' && /10le|10be/.test(String(src.pixFmt || ''))) q.pixFmt = src.pixFmt;
    return q;
  }

  function renderQualityBadge() {
    const b = $('#qualityBadge');
    if (!b) return;
    const t = $('.badge-text', b);
    if (S.qualityMode === 'off') {
      b.className = 'badge';
      t.textContent = '用各操作自己的参数';
      return;
    }
    const q = resolveQuality();
    if (!q) { b.className = 'badge'; t.textContent = '—'; return; }
    const parts = [];
    parts.push(q.vcodec ? q.vcodec : (S.qualityMode === 'source' ? '自动编码器' : '保持操作内编码器'));
    parts.push('CRF ' + q.crf);
    parts.push(q.preset);
    if (q.pixFmt) parts.push(q.pixFmt);
    b.className = 'badge badge-ok';
    t.textContent = parts.join(' · ');
    b.title = S.qualityMode === 'source' && S.srcInfo
      ? `源素材：${S.srcInfo.vcodec || '?'} ${S.srcInfo.width || '?'}x${S.srcInfo.height || '?'} ${S.srcInfo.pixFmt || ''}`
      : '仅对需要重新编码的操作生效；流复制类操作不会重编码';
  }

  /* ================================================================
   * 生成计划
   * ================================================================ */

  function scheduleRegen() {
    clearTimeout(planTimer);
    planTimer = setTimeout(regenerate, 180);
  }

  function regenerate() {
    // 文件夹模式下：以文件列表里的勾选状态为准
    if (S.inputMode === 'folder') {
      const boxes = $$('#fileList input[type=checkbox]');
      if (boxes.length) S.inputFiles = boxes.filter((c) => c.checked).map((c) => c.dataset.path);
    }

    S.outputDir = ($('#outputDir').value || '').trim();

    const plan = buildPlan({
      platform: S.platform,
      ffmpegBin: 'ffmpeg',
      inputMode: S.inputMode,
      inputPath: S.inputPath,
      inputFiles: S.inputFiles,
      outputDir: S.outputDir,
      suffix: S.suffix,
      overwrite: S.overwrite,
      hasAudio: effHasAudio(),
      quality: resolveQuality(),
      steps: S.steps.map((s) => ({ recipeId: s.recipeId, values: s.values }))
    });

    S.plan = plan;
    renderJobs(plan);
    renderScript();
    renderAux();
    renderAudioBadge();
    renderQualityBadge();
    // 输入变化后自动探一次音轨（内部有去重，不会重复请求）
    autoDetectAudio();
  }

  /* ================================================================
   * 渲染：命令预览
   * ================================================================ */

  function renderJobs(plan) {
    const box = $('#jobList');
    box.innerHTML = '';

    if (!plan.ok) {
      box.appendChild(el('div', 'empty', plan.error || '还没有可生成的命令'));
      $('#jobSummary').textContent = '';
      if (S.steps.length && S.inputFiles.length && S.outputDir && plan.error) {
        banner(plan.error, 'warn');
      } else {
        clearBanner();
      }
      return;
    }

    clearBanner();
    $('#jobSummary').textContent = `${plan.jobs.length} 条命令 · ${plan.inputCount} 个输入`;

    const warn = (plan.warnings || []).slice();
    if (!S.ffmpegAvailable && S.apiOk) {
      warn.push('本机未检测到 ffmpeg，「执行」会失败，但命令可以复制到别处运行。');
    }
    if (!S.apiOk) {
      warn.push('离线模式：无法调用本地 ffmpeg 执行命令，也不支持一键保存脚本。');
    }
    if (warn.length) banner(warn.join('　'), 'warn');

    plan.jobs.forEach((job, i) => {
      const card = el('div', 'jobcard');
      card.dataset.index = i;

      const head = el('div', 'jobhead');
      const toLabel = job.output ? esc(U.base(job.output)) : '<span class="muted">（准备步骤，不写文件）</span>';
      head.innerHTML = `
        <span class="jobstep">步骤 ${job.stepIndex + 1}${job.isPrep ? ' · 准备' : ''}</span>
        <span class="jobtitle" title="${esc(job.inputs[0])} → ${esc(job.output || '（不产生输出文件）')}">${esc(U.base(job.inputs[0]))} → ${toLabel}</span>
        <span class="jobstatus"></span>`;
      card.appendChild(head);

      const pre = el('pre', 'jobcmd');
      pre.textContent = job.text;
      card.appendChild(pre);

      const foot = el('div', 'jobfoot');
      const bCopy = el('button', 'btn btn-sm', '复制命令');
      bCopy.addEventListener('click', () => copyText(job.text, '命令'));
      const bRun = el('button', 'btn btn-sm', '▶ 执行这一条');
      bRun.addEventListener('click', () => runOne(i, card));
      const bOpenDir = el('button', 'btn btn-sm', '📁 打开输出目录');
      bOpenDir.addEventListener('click', () => API.post('/api/open', { path: S.outputDir }).catch(() => {}));
      foot.appendChild(bCopy); foot.appendChild(bRun);
      if (S.apiOk) foot.appendChild(bOpenDir);
      card.appendChild(foot);

      if (job.notes && job.notes.length) {
        const nb = el('div', 'pipenotes');
        nb.style.padding = '0 12px 10px';
        job.notes.forEach((n) => nb.appendChild(el('div', 'note', 'ℹ️ ' + n)));
        (job.warnings || []).forEach((n) => nb.appendChild(el('div', 'note warn', '⚠️ ' + n)));
        card.appendChild(nb);
      }
      box.appendChild(card);
    });
  }

  /* ================================================================
   * 渲染：脚本 / 附属文件
   * ================================================================ */

  function renderScript() {
    const box = $('#scriptBox');
    if (!S.plan || !S.plan.ok || !S.plan.scripts) {
      box.textContent = '（还没有可生成的脚本）';
      return;
    }
    box.textContent = S.plan.scripts[S.scriptLang] || '';
  }

  function renderAux() {
    const box = $('#auxList');
    box.innerHTML = '';
    const aux = (S.plan && S.plan.ok && S.plan.auxFiles) || [];
    if (!aux.length) {
      box.appendChild(el('div', 'empty', '当前方案不需要额外的附属文件。\n\n拼接、章节、两遍编码等操作会在这里列出需要预先写好的文件。'));
      return;
    }
    aux.forEach((a, i) => {
      const card = el('div', 'auxcard');
      const head = el('div', 'auxhead');
      head.innerHTML = `<span class="auxname">${esc(a.path || a.name)}</span>`;
      const bSave = el('button', 'btn btn-sm', '保存');
      bSave.addEventListener('click', () => saveOneAux(a));
      const bCopy = el('button', 'btn btn-sm', '复制内容');
      bCopy.addEventListener('click', () => copyText(a.content || '', '文件内容'));
      head.appendChild(bSave); head.appendChild(bCopy);
      const body = el('div', 'auxbody');
      body.textContent = String(a.content || '').slice(0, 1500);
      card.appendChild(head); card.appendChild(body);
      box.appendChild(card);
    });
  }

  async function saveOneAux(a) {
    if (!S.apiOk) return toast('离线模式无法保存文件', 'warn');
    try {
      const r = await API.post('/api/save', { path: a.path, content: a.content || '' });
      if (r.ok) toast('已保存：' + r.path, 'ok');
      else toast(r.error || '保存失败', 'err');
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  }

  async function saveAllAux() {
    const aux = (S.plan && S.plan.ok && S.plan.auxFiles) || [];
    if (!aux.length) return toast('没有附属文件需要保存', 'warn');
    if (!S.apiOk) return toast('离线模式无法保存文件', 'warn');
    let ok = 0;
    for (const a of aux) {
      try {
        const r = await API.post('/api/save', { path: a.path, content: a.content || '' });
        if (r.ok) ok++;
      } catch (_) {}
    }
    toast(`已保存 ${ok}/${aux.length} 个附属文件`, ok === aux.length ? 'ok' : 'warn');
  }

  async function saveScript() {
    if (!S.plan || !S.plan.ok) return toast('还没有可保存的脚本', 'warn');
    if (!S.apiOk) return toast('离线模式无法保存，请用「下载」', 'warn');
    const ext = S.scriptLang === 'bat' ? 'bat' : S.scriptLang === 'sh' ? 'sh' : 'txt';
    const name = '生成命令_' + stamp() + '.' + ext;
    const target = U.join(S.outputDir, name, S.platform);
    try {
      const r = await API.post('/api/save', { path: target, content: S.plan.scripts[S.scriptLang] });
      if (r.ok) {
        toast('脚本已保存到：' + r.path, 'ok', 4200);
        await saveAllAux();
      } else toast(r.error || '保存失败', 'err');
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  }

  function downloadScript() {
    if (!S.plan || !S.plan.ok) return toast('还没有可下载的脚本', 'warn');
    const ext = S.scriptLang === 'bat' ? 'bat' : S.scriptLang === 'sh' ? 'sh' : 'txt';
    // .bat / .sh 不能带 BOM，否则 cmd 会报“不是内部或外部命令”；纯文本清单带 BOM 方便记事本识别中文
    const head = S.scriptLang === 'txt' ? '\ufeff' : '';
    const blob = new Blob([head + S.plan.scripts[S.scriptLang]], { type: 'text/plain;charset=utf-8' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = '生成命令_' + stamp() + '.' + ext;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /* ================================================================
   * 执行
   * ================================================================ */

  function log(text, cls) {
    const box = $('#logBox');
    const span = el('span', cls || null, text);
    box.appendChild(span);
    box.scrollTop = box.scrollHeight;
  }

  function setRunStatus(text, cls) {
    const s = $('#runStatus');
    s.textContent = text;
    s.className = 'runstatus' + (cls ? ' ' + cls : '');
  }

  async function runOne(index, card) {
    if (!S.apiOk) return toast('离线模式无法执行，请复制命令到终端运行', 'warn');
    if (!S.plan || !S.plan.ok) return;
    const job = S.plan.jobs[index];
    if (!job) return;
    if (S.running) return toast('正在执行中，请先等待或停止', 'warn');

    switchPanel('log');
    S.running = true;
    $('#btnStopRun').disabled = false;
    setRunStatus('执行中…', 'running');
    if (card) { card.classList.add('running'); $('.jobstatus', card).textContent = '运行中'; $('.jobstatus', card).className = 'jobstatus run'; }
    log('\n' + '─'.repeat(48) + '\n', 'l-cmd');

    S.abortCtl = new AbortController();
    let code = null;
    try {
      code = await streamRun(job.argv, S.abortCtl.signal);
    } catch (e) {
      log('\n[中断] ' + (e.name === 'AbortError' ? '已被用户停止' : e.message) + '\n', 'l-err');
    }
    S.abortCtl = null;
    S.running = false;
    $('#btnStopRun').disabled = true;

    if (code === 0) {
      setRunStatus('完成', 'done');
      log('\n✅ 执行成功' + (job.output ? '：' + U.base(job.output) : '（本步不产生文件）') + '\n', 'l-ok');
      if (card) { card.classList.remove('running'); card.classList.add('done'); $('.jobstatus', card).textContent = '✅ 成功'; $('.jobstatus', card).className = 'jobstatus ok'; }
      toast('完成' + (job.output ? '：' + U.base(job.output) : ''), 'ok');
    } else if (code === null) {
      setRunStatus('已停止', 'fail');
      if (card) { card.classList.remove('running'); $('.jobstatus', card).textContent = '已停止'; $('.jobstatus', card).className = 'jobstatus err'; }
    } else {
      setRunStatus('失败（退出码 ' + code + '）', 'fail');
      log('\n❌ 执行失败，退出码 ' + code + '。常见原因：路径不存在、编码器不支持、参数冲突。\n', 'l-err');
      if (card) { card.classList.remove('running'); card.classList.add('fail'); $('.jobstatus', card).textContent = '❌ 失败'; $('.jobstatus', card).className = 'jobstatus err'; }
      toast('执行失败，详见日志', 'err');
    }
    return code;
  }

  async function runAll() {
    if (!S.apiOk) return toast('离线模式无法执行，请复制命令到终端运行', 'warn');
    if (!S.plan || !S.plan.ok) return toast('还没有可执行的命令', 'warn');
    if (S.running) return toast('正在执行中', 'warn');
    if (!confirm(`即将依次执行 ${S.plan.jobs.length} 条 ffmpeg 命令。\n输出目录：${S.outputDir}\n\n继续吗？`)) return;

    // 先确保输出目录与附属文件就绪
    try { await API.post('/api/fs/mkdir', { path: S.outputDir }); } catch (_) {}
    await saveAllAux();

    let ok = 0, fail = 0;
    for (let i = 0; i < S.plan.jobs.length; i++) {
      const card = $(`.jobcard[data-index="${i}"]`);
      // eslint-disable-next-line no-await-in-loop
      const code = await runOne(i, card);
      if (code === 0) ok++; else fail++;
      if (code === null) break; // 被用户停止
    }
    setRunStatus(`全部结束：成功 ${ok}，失败 ${fail}`, fail ? 'fail' : 'done');
    toast(`执行完毕：成功 ${ok} 条，失败 ${fail} 条`, fail ? 'warn' : 'ok', 4000);
    switchPanel('log');
  }

  async function streamRun(argv, signal) {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: argv }),
      signal
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let code = null;
    let sawCmd = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const chunk of chunks) {
        const line = chunk.replace(/^data:\s?/, '').trim();
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.event === 'log') {
          const text = msg.text || '';
          log(text, sawCmd ? null : 'l-cmd');
          if (!sawCmd && text.indexOf('$ ffmpeg') >= 0) sawCmd = true;
        } else if (msg.event === 'done') {
          code = msg.code;
        }
      }
    }
    return code;
  }

  function switchPanel(tab) {
    $('.layout').classList.remove('panel-hidden');
    const t = $(`#panelTabs .tab[data-tab="${tab}"]`);
    if (t) t.click();
  }

  /* ================================================================
   * 原生文件选择
   * ================================================================ */

  async function nativePick(mode, cb) {
    if (!S.apiOk) {
      toast('离线模式请手动填写路径', 'warn');
      return;
    }
    try {
      const r = await API.post('/api/pick', { mode });
      if (!r.ok) { toast(r.error || '无法打开系统选择器', 'warn', 3400); return; }
      if (r.canceled) return;
      const p = r.paths || [];
      if (p.length) cb(p);
    } catch (e) { toast('选择器调用失败：' + e.message, 'err'); }
  }

  /* ================================================================
   * 网页内目录浏览
   * ================================================================ */

  let fsState = { mode: 'dir', current: '', selected: null, cb: null, files: [], dirs: [] };

  function fsParent(p) {
    if (!p) return '';
    const m = String(p).match(/^(.*)[\\/][^\\/]+[\\/]?$/);
    if (!m) return p;
    return m[1] || (S.platform === 'win32' ? p.slice(0, 3) : '/');
  }

  async function openFs(mode, start, cb) {
    if (!S.apiOk) { toast('离线模式请手动填写路径', 'warn'); return; }
    fsState = { mode, current: start || '', selected: null, cb, files: [], dirs: [] };
    $('#fsTitle').textContent = mode === 'dir' ? '选择文件夹' : '选择文件';
    $('#fsConfirm').textContent = mode === 'dir' ? '选择当前文件夹' : '选择选中的文件';
    $('#fsModal').hidden = false;
    await fsLoad(start || '');
  }

  function closeFs() { $('#fsModal').hidden = true; fsState.cb = null; }

  async function fsLoad(p) {
    try {
      const r = await API.get('/api/fs/list?p=' + encodeURIComponent(p || ''));
      if (!r.ok) { toast(r.error || '无法读取目录', 'err'); return; }
      fsState.current = r.path;
      fsState.dirs = r.dirs || [];
      fsState.files = (r.files || []).filter((f) => ['video', 'audio', 'image', 'subtitle'].indexOf(f.kind) >= 0 || fsState.mode === 'file');
      $('#fsPath').value = r.path;
      fsState.selected = fsState.mode === 'dir' ? r.path : null;
      $('#fsSelected').textContent = fsState.mode === 'dir' ? '当前：' + r.path : '未选择文件';

      const quick = $('#fsQuick');
      quick.innerHTML = '';
      (r.drives || []).forEach((d) => {
        const b = el('button', 'btn btn-sm', d);
        b.addEventListener('click', () => fsLoad(d));
        quick.appendChild(b);
      });
      (r.quick || []).forEach((q) => {
        const b = el('button', 'btn btn-sm', '📌 ' + q.name);
        b.title = q.path;
        b.addEventListener('click', () => fsLoad(q.path));
        quick.appendChild(b);
      });

      const list = $('#fsList');
      list.innerHTML = '';
      fsState.dirs.forEach((d) => {
        const row = el('div', 'fsrow');
        row.innerHTML = `<span class="fsicon">📁</span><span class="fsname">${esc(d.name)}</span>`;
        row.addEventListener('dblclick', () => fsLoad(d.path));
        row.addEventListener('click', () => {
          $$('.fsrow', list).forEach((x) => x.classList.remove('sel'));
          row.classList.add('sel');
          fsState.selected = d.path;
          $('#fsSelected').textContent = '当前：' + d.path;
        });
        list.appendChild(row);
      });
      fsState.files.forEach((f) => {
        const row = el('div', 'fsrow');
        const icons = { video: '🎞️', audio: '🎵', image: '🖼️', subtitle: '💬', other: '📄' };
        row.innerHTML = `<span class="fsicon">${icons[f.kind] || '📄'}</span><span class="fsname">${esc(f.name)}</span>`;
        row.addEventListener('click', () => {
          $$('.fsrow', list).forEach((x) => x.classList.remove('sel'));
          row.classList.add('sel');
          fsState.selected = f.path;
          $('#fsSelected').textContent = '已选：' + f.path;
        });
        row.addEventListener('dblclick', () => {
          fsState.selected = f.path;
          fsConfirm();
        });
        list.appendChild(row);
      });

      if (!fsState.dirs.length && !fsState.files.length) {
        list.appendChild(el('div', 'empty', '这个文件夹是空的'));
      }
    } catch (e) {
      toast('读取目录失败：' + e.message, 'err');
    }
  }

  function fsConfirm() {
    const p = fsState.selected;
    if (!p) return toast('请先选择一个位置', 'warn');
    if (fsState.mode === 'dir') {
      // 文件夹模式下如果选中的是子文件夹，也可以直接进去
      const cb = fsState.cb;
      closeFs();
      if (cb) cb(p);
    } else {
      if (fsState.files.some((f) => f.path === p)) {
        const cb = fsState.cb;
        closeFs();
        if (cb) cb(p);
      } else {
        fsLoad(p);
      }
    }
  }

  /* ================================================================
   * 兜底：配方文件缺失时给出提示
   * ================================================================ */

  if (!RECIPES.length) {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        if (!RECIPES.length) {
          banner('操作库没有加载成功。请确认 public/js/ 下的 recipes-*.js 文件都存在，并用「启动服务.bat」以 http:// 方式打开。', 'err');
        }
      }, 600);
    });
  }

  window.__FFGEN_APP__ = { S, regenerate, API };

})();
