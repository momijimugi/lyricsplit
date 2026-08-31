/* ==========================================================================
   LYRICLAB — 歌詞コライトのスプリット管理
   SPLITAPP(SPLITLAB) と同じ考え方：作業の事実をログに残し、そのログから
   貢献パーセンテージを算出する。違いは「制作ログを手入力する」のではなく
   「アプリ内で作詞した操作そのものがログになる」点。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 定数 */

  const STORAGE_KEY = 'lyriclab_projects_v1';
  const THEME_KEY = 'lyriclab_theme';

  const MEMBER_COLORS = ['#8fadc7', '#9c7a54', '#7fa88b', '#b58fbf', '#c9a227', '#6f8fbf'];

  // セクション種別ごとの音楽的比重。サビ・大サビは同じ文字数でも重い。
  // en = 洋楽式、jp = J-POP式の呼び名。表示はヘッダーの「呼び名」で切り替える。
  const SECTION_KINDS = {
    intro:       { en: 'Intro',        jp: 'イントロ',   weight: 0.7 },
    verse:       { en: 'Verse',        jp: 'Aメロ',      weight: 1.0 },
    prechorus:   { en: 'Pre-chorus',   jp: 'Bメロ',      weight: 1.15 },
    chorus:      { en: 'Chorus',       jp: 'サビ',       weight: 1.5 },
    finalchorus: { en: 'Final chorus', jp: '大サビ',     weight: 1.6 },
    quietchorus: { en: 'Quiet chorus', jp: '落ちサビ',   weight: 1.4 },
    hook:        { en: 'Hook',         jp: 'フック',     weight: 1.4 },
    bridge:      { en: 'Bridge',       jp: 'Cメロ',      weight: 1.2 },
    interlude:   { en: 'Interlude',    jp: '間奏',       weight: 0.6 },
    rap:         { en: 'Rap',          jp: 'ラップ',     weight: 1.1 },
    outro:       { en: 'Outro',        jp: 'アウトロ',   weight: 0.8 },
    other:       { en: 'Other',        jp: 'その他',     weight: 1.0 }
  };

  const NAMING_KEY = 'lyriclab_naming';

  // 取り込み時にセクション名から種別を推定するための表記ゆれ辞書。
  const KIND_ALIASES = [
    ['finalchorus', /大サビ|last\s*chorus|final\s*chorus|chorus\s*(3|4)/i],
    ['quietchorus', /落ちサビ|落ちサビ|quiet\s*chorus|breakdown/i],
    ['prechorus',   /bメロ|b\s*melo|pre[\s-]*chorus|pre[\s-]*hook/i],
    ['bridge',      /cメロ|c\s*melo|bridge|dメロ/i],
    ['chorus',      /サビ|chorus|hook\s*chorus/i],
    ['hook',        /フック|hook/i],
    ['verse',       /aメロ|a\s*melo|verse/i],
    ['rap',         /ラップ|rap|verse\s*rap/i],
    ['interlude',   /間奏|interlude|inst/i],
    ['intro',       /イントロ|intro/i],
    ['outro',       /アウトロ|outro|ending|エンディング/i]
  ];

  // 作業ログの種類と「関与ポイント」。推敲・レビューの手数を評価する軸。
  const LOG_TYPES = {
    'line.add':        { label: '行を追加',       points: 2 },
    'line.edit':       { label: '行を推敲',       points: 1.5 },
    'line.delete':     { label: '行を削除',       points: 1 },
    'lyrics.import':   { label: '歌詞を取り込み', points: 2 },
    'section.add':     { label: 'セクション追加', points: 1 },
    'section.rename':  { label: 'セクション改名', points: 0.5 },
    'section.delete':  { label: 'セクション削除', points: 0.5 },
    'suggest.create':  { label: '修正を提案',     points: 2 },
    'suggest.accept':  { label: '提案を採用',     points: 1 },
    'suggest.reject':  { label: '提案を却下',     points: 0.5 },
    'suggest.comment': { label: '提案へコメント', points: 1 },
    'comment.create':  { label: 'コメント',       points: 1.5 },
    'comment.reply':   { label: '返信',           points: 1 },
    'comment.resolve': { label: 'コメント解決',   points: 0.5 },
    'agreement.set':   { label: 'スプリット合意', points: 0 },
    'ai.analyze':      { label: 'AI多段階分析',   points: 0 }
  };

  // 最終比率の配合。データが無い軸は自動的に他の軸へ按分される。
  const AXIS_WEIGHTS = { text: 0.55, adopted: 0.20, involvement: 0.25 };

  /* ---------------------------------------------------------------- 状態 */

  let projects = [];
  const ui = {
    view: 'dashboard',
    projectId: null,
    mode: 'edit',
    tab: 'suggestions',
    actorId: null,
    naming: 'jp',     // 'jp' = Aメロ/サビ方式、'en' = Verse/Chorus方式
    preview: 'clean', // 'clean' | 'authors' | 'suggested'
    previewOn: true,
    logsAll: false,   // 作業ログを全件表示するか
    composer: null,   // { sectionId, lineId|null, mode, kind }
    replyTo: null,    // comment id
    sugReplyTo: null, // suggestion id（提案へのコメント入力を開いている対象）
    exportTab: 'lyrics'
  };

  const $ = (id) => document.getElementById(id);
  const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const nowISO = () => new Date().toISOString();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* -------------------------------------------------------------- 保存 */

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      projects = raw ? JSON.parse(raw) : [];
    } catch (e) {
      projects = [];
    }
    if (!Array.isArray(projects)) projects = [];
    projects.forEach(normalizeProject);
    try {
      const n = localStorage.getItem(NAMING_KEY);
      if (n === 'jp' || n === 'en') ui.naming = n;
    } catch (e) {}
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch (e) {
      toast('保存に失敗しました（ストレージ容量）');
    }
  }

  // 同期で外から来たデータをそのまま属性へ差し込まないための検証パターン。
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

  /**
   * 受信した案件が構造的に安全か。
   * IDは data-* 属性や CSS 変数へ素で入るため、英数字とハイフンだけに限定する。
   * （自前で作ったIDは必ず通る。壊れた／細工されたデータだけを弾く。）
   */
  function isSafeProject(p) {
    if (!p || typeof p !== 'object' || !ID_RE.test(String(p.id || ''))) return false;
    const ids = [];
    (p.members || []).forEach((m) => ids.push(m && m.id));
    (p.sections || []).forEach((s) => {
      ids.push(s && s.id);
      (s && s.lines || []).forEach((l) => ids.push(l && l.id));
    });
    (p.suggestions || []).forEach((s) => {
      ids.push(s && s.id);
      (s && s.replies || []).forEach((r) => ids.push(r && r.id));
    });
    (p.comments || []).forEach((c) => {
      ids.push(c && c.id);
      (c && c.replies || []).forEach((r) => ids.push(r && r.id));
    });
    (p.logs || []).forEach((l) => ids.push(l && l.id));
    return ids.every((id) => ID_RE.test(String(id || '')));
  }

  function normalizeProject(p) {
    p.members = Array.isArray(p.members) ? p.members : [];
    // 色は style 属性へ素で入るので、16進カラー以外は既定色に落とす。
    p.members.forEach((m, i) => {
      if (!COLOR_RE.test(String(m.color || ''))) m.color = MEMBER_COLORS[i % MEMBER_COLORS.length];
    });
    p.sections = Array.isArray(p.sections) ? p.sections : [];
    p.suggestions = Array.isArray(p.suggestions) ? p.suggestions : [];
    p.suggestions.forEach((s) => { s.replies = Array.isArray(s.replies) ? s.replies : []; });
    p.comments = Array.isArray(p.comments) ? p.comments : [];
    p.logs = Array.isArray(p.logs) ? p.logs : [];
    p.agreement = p.agreement || null;
    p.ai = p.ai || null;
    p.sections.forEach((s) => {
      if (typeof s.autoName !== 'boolean') s.autoName = false; // 旧データは名前固定として扱う
      if (!SECTION_KINDS[s.kind]) s.kind = 'other';
      s.lines = Array.isArray(s.lines) ? s.lines : [];
      s.lines.forEach((l) => { l.credits = l.credits || {}; });
    });
    return p;
  }

  const project = () => projects.find((p) => p.id === ui.projectId) || null;
  const memberOf = (p, id) => (p ? p.members.find((m) => m.id === id) : null) || null;
  const memberName = (p, id) => { const m = memberOf(p, id); return m ? m.name : '不明'; };
  const memberColor = (p, id) => { const m = memberOf(p, id); return m ? m.color : 'var(--text-faint)'; };
  const sectionWeight = (s) => (SECTION_KINDS[s.kind] || SECTION_KINDS.other).weight;
  const kindLabel = (k) => {
    const def = SECTION_KINDS[k] || SECTION_KINDS.other;
    return ui.naming === 'jp' ? def.jp : def.en;
  };

  /**
   * セクションの表示名。
   * 自動命名（autoName）のセクションは呼び名の切り替えに追従し、
   * 同じ種別が複数あるときだけ連番を付ける。
   * ユーザーが手で名前を付けたセクションはその名前のまま。
   */
  function sectionName(p, s) {
    if (!s) return '—';
    if (!s.autoName) return s.name;
    const same = p.sections.filter((x) => x.autoName && x.kind === s.kind);
    const label = kindLabel(s.kind);
    if (same.length < 2) return label;
    return label + (ui.naming === 'jp' ? '' : ' ') + (same.indexOf(s) + 1);
  }

  function detectKind(name) {
    const hit = KIND_ALIASES.find((pair) => pair[1].test(name));
    return hit ? hit[0] : 'verse';
  }

  function actor() {
    const p = project();
    if (!p || !p.members.length) return null;
    let m = memberOf(p, ui.actorId);
    if (!m) { m = p.members[0]; ui.actorId = m.id; }
    return m;
  }

  /* ==================================================================
     端末ひも付けの本人確認
     ログインは持たず、「この端末は誰のものか」を一度だけ決めて覚える。
     案件ごとに共作者IDは別なので、端末側に案件→共作者の対応表を持つ。
     ================================================================== */

  const DEVICE_KEY = 'lyriclab_device';
  let device = null;

  function loadDevice() {
    try {
      device = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
    } catch (e) { device = null; }
    if (!device || typeof device !== 'object') device = {};
    if (!device.id) device.id = uid('dev');
    if (!device.memberByProject || typeof device.memberByProject !== 'object') device.memberByProject = {};
    saveDevice();
  }

  function saveDevice() {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(device)); } catch (e) {}
  }

  const deviceNamed = () => !!(device && device.name);

  /**
   * この端末の持ち主が、その案件のどの共作者にあたるかを返す。
   *  1. 案件→共作者の対応表（明示的に選んだもの）
   *  2. 同じ名前の共作者（別端末で作られた案件を開いたとき用）
   * どちらでも決まらなければ null（＝選択を促す）。
   */
  function deviceMemberOf(p) {
    if (!p || !deviceNamed()) return null;
    const mapped = memberOf(p, device.memberByProject[p.id]);
    if (mapped) return mapped;
    const byName = p.members.find((m) => m.name === device.name);
    if (byName) {
      device.memberByProject[p.id] = byName.id;
      saveDevice();
      return byName;
    }
    return null;
  }

  function bindDeviceTo(p, memberId) {
    device.memberByProject[p.id] = memberId;
    saveDevice();
    ui.actorId = memberId;
  }

  /** 案件を開いたときに作業者を自動で決める。決まらなければ false。 */
  function resolveActor(p) {
    const m = deviceMemberOf(p);
    if (m) { ui.actorId = m.id; return true; }
    return false;
  }

  function openIdentityModal(force) {
    const p = project();
    $('identity-name').value = (device && device.name) || '';
    $('identity-error').classList.add('hidden');
    $('identity-lead').textContent = force
      ? 'この案件でのあなたを選んでください。以降この端末では自動で選ばれます。'
      : '一度決めておけば、以降は自動でこの人として記録されます。ログインは不要です。';

    const wrap = $('identity-members-wrap');
    if (p && p.members.length) {
      wrap.classList.remove('hidden');
      const currentId = (deviceMemberOf(p) || {}).id;
      $('identity-members').innerHTML = p.members.map((m) =>
        '<button type="button" class="card flex w-full items-center gap-2 text-left' +
          (m.id === currentId ? ' is-picked' : '') + '" data-pick-member="' + m.id + '">' +
          '<span class="avatar" style="background:' + m.color + '">' + esc(m.name.slice(0, 1)) + '</span>' +
          '<b class="flex-1">' + esc(m.name) + '</b>' +
          (m.id === currentId ? '<span class="line-badge">これが自分</span>' : '') +
        '</button>').join('') +
        '<button type="button" class="card flex w-full items-center gap-2 text-left" data-pick-member="new">' +
          '<span class="avatar" style="background:var(--text-faint)">＋</span>' +
          '<b class="flex-1">新しい共作者として参加する</b></button>';
    } else {
      wrap.classList.add('hidden');
    }
    openModal('identity-modal');
  }

  /** 端末の持ち主と違う名義で作業しているときに知らせる。 */
  function renderActorAlias(p) {
    const own = deviceMemberOf(p);
    const alias = !!(own && ui.actorId !== own.id);
    $('actor-alias').classList.toggle('hidden', !alias);
    $('actor-alias').textContent = alias ? '別名義（本来は' + own.name + '）' : '別名義';
    $('identity-btn').classList.toggle('hidden', ui.view !== 'project');
  }

  /* ------------------------------------------------- 貢献クレジット計算 */

  /**
   * 行のテキストが oldText → newText に変わったときのクレジット配分。
   * 共通の先頭・末尾を除いた差分だけを見て、
   *  ・増えた文字数 → 編集者の取り分に加算
   *  ・減った文字数 → 既存クレジット全体から按分して削減
   * という単純で説明可能なルールで持ち分を更新する。
   */
  function applyCredits(oldCredits, oldText, newText, actorId) {
    const o = String(oldText || '');
    const n = String(newText || '');
    let pre = 0;
    while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
    let suf = 0;
    while (suf < o.length - pre && suf < n.length - pre && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++;

    const removed = o.length - pre - suf;
    const added = n.length - pre - suf;

    const credits = Object.assign({}, oldCredits || {});
    const total = Object.values(credits).reduce((a, b) => a + b, 0);
    if (removed > 0 && total > 0) {
      const ratio = Math.max(0, total - removed) / total;
      Object.keys(credits).forEach((k) => { credits[k] = Math.round(credits[k] * ratio * 100) / 100; });
    }
    if (added > 0) credits[actorId] = Math.round(((credits[actorId] || 0) + added) * 100) / 100;

    Object.keys(credits).forEach((k) => { if (credits[k] <= 0.01) delete credits[k]; });
    return credits;
  }

  /* -------------------------------------------------------------- ログ */

  function log(p, type, data) {
    const entry = Object.assign({
      id: uid('log'),
      ts: nowISO(),
      actorId: (actor() || {}).id || null,
      // どの端末から行われたかも残す（名義の取り違えを後から追えるように）
      deviceId: device ? device.id : null,
      deviceName: (device && device.name) || '',
      type: type
    }, data || {});
    p.logs.push(entry);
    p.updatedAt = entry.ts;
    return entry;
  }

  /* ------------------------------------------------------------ 分析 */

  function analyze(p) {
    const ids = p.members.map((m) => m.id);
    const zero = () => ids.reduce((a, id) => (a[id] = 0, a), {});

    const text = zero();       // 現存する歌詞の持ち分（文字数 × セクション比重）
    const adopted = zero();    // 採用された提案
    const involvement = zero();// 推敲・レビューの関与ポイント

    p.sections.forEach((s) => {
      const w = sectionWeight(s);
      s.lines.forEach((l) => {
        Object.keys(l.credits || {}).forEach((id) => {
          if (id in text) text[id] += l.credits[id] * w;
        });
      });
    });

    p.suggestions.filter((s) => s.status === 'accepted').forEach((s) => {
      const sec = p.sections.find((x) => x.id === s.sectionId);
      const w = sec ? sectionWeight(sec) : 1;
      if (s.authorId in adopted) adopted[s.authorId] += (s.text || '').length * w * 0.5 + 5;
    });

    p.logs.forEach((entry) => {
      const def = LOG_TYPES[entry.type];
      if (!def || !def.points) return;
      if (entry.actorId in involvement) involvement[entry.actorId] += def.points;
    });

    const axes = { text: text, adopted: adopted, involvement: involvement };
    const totals = {};
    let liveWeight = 0;
    Object.keys(axes).forEach((k) => {
      totals[k] = ids.reduce((a, id) => a + axes[k][id], 0);
      if (totals[k] > 0) liveWeight += AXIS_WEIGHTS[k];
    });

    const percent = zero();
    if (liveWeight === 0) {
      ids.forEach((id) => { percent[id] = ids.length ? 100 / ids.length : 0; });
    } else {
      Object.keys(axes).forEach((k) => {
        if (totals[k] <= 0) return;
        const w = AXIS_WEIGHTS[k] / liveWeight;
        ids.forEach((id) => { percent[id] += (axes[k][id] / totals[k]) * 100 * w; });
      });
    }

    return {
      ids: ids,
      axes: axes,
      totals: totals,
      percent: roundShares(percent, ids),
      hasData: liveWeight > 0
    };
  }

  // 合計がぴったり100.0になるように丸める（最大剰余法）。
  function roundShares(values, ids) {
    const out = {};
    let acc = 0;
    ids.forEach((id, i) => {
      if (i === ids.length - 1) out[id] = Math.round((100 - acc) * 10) / 10;
      else { out[id] = Math.round((values[id] || 0) * 10) / 10; acc += out[id]; }
    });
    ids.forEach((id) => { if (!isFinite(out[id]) || out[id] < 0) out[id] = 0; });
    return out;
  }

  /* ------------------------------------------------------------ 表示 */

  function renderAll() {
    document.body.dataset.appView = ui.view;
    $('dashboard-view').classList.toggle('hidden', ui.view !== 'dashboard');
    $('project-view').classList.toggle('hidden', ui.view !== 'project');
    $('actor-wrap').classList.toggle('hidden', ui.view !== 'project');
    if (ui.view === 'project') $('actor-wrap').classList.add('sm:flex');
    $('identity-btn').classList.toggle('hidden', ui.view !== 'project');
    if (ui.view === 'dashboard') renderDashboard();
    else { renderProject(); updateJumpCurrent(); }
  }

  function renderDashboard() {
    const lines = projects.reduce((a, p) => a + p.sections.reduce((b, s) => b + s.lines.length, 0), 0);
    const open = projects.reduce((a, p) => a + p.suggestions.filter((s) => s.status === 'open').length, 0);
    const logs = projects.reduce((a, p) => a + p.logs.length, 0);
    $('stat-projects').textContent = projects.length;
    $('stat-lines').textContent = lines;
    $('stat-suggestions').textContent = open;
    $('stat-logs').textContent = logs;

    const grid = $('project-grid');
    const sorted = projects.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    grid.innerHTML = sorted.map((p) => {
      const res = analyze(p);
      const shares = p.agreement || res.percent;
      const chips = p.members.map((m) => (
        '<span class="line-badge" style="border-color:' + m.color + ';color:' + m.color + '">' +
        esc(m.name) + ' ' + (shares[m.id] || 0).toFixed(1) + '%</span>'
      )).join(' ');
      const lineCount = p.sections.reduce((b, s) => b + s.lines.length, 0);
      return '<button type="button" class="project-row" data-open="' + p.id + '">' +
        '<div class="min-w-0">' +
          '<p class="truncate text-sm font-extrabold">' + esc(p.title || 'Untitled Lyric') + '</p>' +
          '<p class="mt-1 font-mono text-[10px] text-slate-500">' +
            esc(p.artist || 'アーティスト未設定') + ' · ' + lineCount + '行 · ログ' + p.logs.length + '件' +
            (p.agreement ? ' · <span class="text-acid">合意済み</span>' : '') +
          '</p>' +
        '</div>' +
        '<div class="flex flex-wrap items-center justify-end gap-1.5">' + chips +
          '<span class="line-badge">' + esc(p.status || '作詞中') + '</span></div>' +
      '</button>';
    }).join('');
    $('empty-projects').classList.toggle('hidden', projects.length > 0);
    grid.classList.toggle('hidden', projects.length === 0);
  }

  function renderProject() {
    const p = project();
    if (!p) { ui.view = 'dashboard'; renderAll(); return; }
    actor();

    $('project-header-title').textContent = p.title || 'Untitled Lyric';
    $('project-header-status').textContent = p.status || '作詞中';
    const lineCount = p.sections.reduce((b, s) => b + s.lines.length, 0);
    const charCount = p.sections.reduce((b, s) => b + s.lines.reduce((c, l) => c + l.text.length, 0), 0);
    $('project-header-meta').innerHTML = [
      p.artist ? 'アーティスト: ' + esc(p.artist) : null,
      p.note ? esc(p.note) : null,
      lineCount + '行 / ' + charCount + '字',
      p.deadline ? '締切 ' + esc(p.deadline) : null
    ].filter(Boolean).map((t) => '<span>' + t + '</span>').join('');

    const sel = $('actor-select');
    sel.innerHTML = p.members.map((m) => '<option value="' + m.id + '">' + esc(m.name) + '</option>').join('');
    sel.value = ui.actorId;
    renderActorAlias(p);

    renderSplitStrip(p);
    renderJumpBar(p);
    renderSections(p);
    renderPreview(p);
    renderPanels(p);
    Array.from($('mode-switch').children).forEach((b) => b.classList.toggle('is-active', b.dataset.mode === ui.mode));
    Array.from($('panel-tabs').children).forEach((b) => b.classList.toggle('is-active', b.dataset.tab === ui.tab));
  }

  function renderSplitStrip(p) {
    const res = analyze(p);
    const shares = p.agreement || res.percent;
    $('split-bar').innerHTML = p.members.map((m) =>
      '<div style="width:' + (shares[m.id] || 0) + '%;background:' + m.color + '" title="' + esc(m.name) + '"></div>'
    ).join('');
    $('split-legend').innerHTML =
      '<span class="split-caption">Split</span>' +
      p.members.map((m) =>
      '<span class="flex items-center gap-1.5"><span class="avatar" style="background:' + m.color + '">' + esc(m.name.slice(0, 1)) + '</span>' +
      esc(m.name) + ' <b>' + (shares[m.id] || 0).toFixed(1) + '%</b></span>'
    ).join('') + (p.agreement
      ? '<span class="line-badge is-suggest">合意値を表示中</span>'
      : (res.hasData ? '<span class="line-badge">ログ算出（参考値）</span>' : '<span class="line-badge">データなし・均等</span>')) +
      (p.ai ? '<span class="line-badge" title="多段階AI分析の統合値">AI統合 ' +
        p.members.map((m) => (p.ai.combined[m.id] || 0).toFixed(1) + '%').join(' / ') + '</span>' : '');
  }

  /* ------------------------------------------------------ カラム幅の調整 */

  // 既定の比率。プレビュー（中央）を主役に、パネルを最小にしてある。
  const COL_DEFAULTS = { editor: 1.15, preview: 1.6, panel: 0.85 };
  const COL_KEY = 'lyriclab_columns';
  const COL_MIN_PX = 220;

  let colWidths = Object.assign({}, COL_DEFAULTS);

  function loadColumns() {
    try {
      const v = JSON.parse(localStorage.getItem(COL_KEY) || 'null');
      if (v && ['editor', 'preview', 'panel'].every((k) => isFinite(v[k]) && v[k] > 0)) colWidths = v;
    } catch (e) {}
    applyColumns();
  }

  function applyColumns() {
    const root = document.documentElement;
    root.style.setProperty('--col-editor', colWidths.editor + 'fr');
    root.style.setProperty('--col-preview', colWidths.preview + 'fr');
    root.style.setProperty('--col-panel', colWidths.panel + 'fr');
  }

  function saveColumns() {
    try { localStorage.setItem(COL_KEY, JSON.stringify(colWidths)); } catch (e) {}
  }

  /**
   * ハンドルのドラッグで隣り合う2カラムの幅を振り分ける。
   * 掴んだ時点の実ピクセル幅を基準にし、2カラムの合計 fr は変えないので
   * 反対側のカラムは動かない。
   */
  function startResize(e, index) {
    const pair = index === 0 ? ['editor', 'preview'] : ['preview', 'panel'];
    const els = {
      editor: document.querySelector('.workspace-editor'),
      preview: document.querySelector('.workspace-preview'),
      panel: document.querySelector('.workspace-panel')
    };
    const leftEl = els[pair[0]];
    const rightEl = els[pair[1]];
    if (!leftEl || !rightEl) return;

    const startX = e.clientX;
    const startLeft = leftEl.getBoundingClientRect().width;
    const startRight = rightEl.getBoundingClientRect().width;
    const frSum = colWidths[pair[0]] + colWidths[pair[1]];
    const pxPerFr = (startLeft + startRight) / frSum;
    const handle = e.currentTarget;

    handle.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    handle.setPointerCapture && handle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      let dx = ev.clientX - startX;
      dx = Math.max(COL_MIN_PX - startLeft, Math.min(startRight - COL_MIN_PX, dx));
      colWidths[pair[0]] = (startLeft + dx) / pxPerFr;
      colWidths[pair[1]] = (startRight - dx) / pxPerFr;
      applyColumns();
    };
    const onUp = () => {
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      saveColumns();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function resetColumns() {
    colWidths = Object.assign({}, COL_DEFAULTS);
    applyColumns();
    saveColumns();
    toast('カラム幅を既定に戻しました');
  }

  /** 追従バー：現在の比率と、3ブロックへのジャンプ。 */
  function renderJumpBar(p) {
    const res = analyze(p);
    const shares = p.agreement || res.percent;
    $('jump-split').innerHTML = p.members.map((m) =>
      '<span style="color:' + m.color + '">●</span> ' + esc(m.name) + ' ' + (shares[m.id] || 0).toFixed(1) + '%'
    ).join(' <span style="opacity:.4">/</span> ');
    $('jump-bar').querySelector('[data-jump="preview"]').classList.toggle('hidden', !ui.previewOn);
    syncBarHeight();
  }

  /**
   * 追従バーの実際の高さを CSS 変数へ渡す。
   * 画面が狭いとバーが2段に折り返すため、その下に貼り付く見出しの位置も追従させる。
   */
  function syncBarHeight() {
    const h = $('jump-bar').getBoundingClientRect().height;
    if (h) document.documentElement.style.setProperty('--bar-h', Math.round(h) + 'px');
  }

  const JUMP_TARGETS = {
    editor: '.workspace-editor',
    preview: '.workspace-preview',
    panel: '.workspace-panel'
  };

  function jumpTo(key) {
    if (key === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const el = document.querySelector(JUMP_TARGETS[key]);
    if (!el) return;
    // 追従バーの下に隠れないよう、その高さぶん手前で止める。
    const offset = $('jump-bar').getBoundingClientRect().height + 12;
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - offset, behavior: 'smooth' });
  }

  /**
   * 今見ているブロックをバーで示す。
   * 画面の中央にかかっているブロックを「現在地」とする（最後のブロックは
   * ページ末尾までスクロールしても上端に来ないため、上端基準だと選ばれない）。
   */
  function updateJumpCurrent() {
    if (ui.view !== 'project') return;
    const mid = window.innerHeight / 2;
    let current = 'editor';
    Object.keys(JUMP_TARGETS).forEach((key) => {
      const el = document.querySelector(JUMP_TARGETS[key]);
      if (!el || getComputedStyle(el).display === 'none') return;
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) current = key;
    });
    $('jump-bar').querySelectorAll('[data-jump]').forEach((b) =>
      b.classList.toggle('is-current', b.dataset.jump === current));
  }

  function renderSections(p) {
    const host = $('section-list');
    if (!p.sections.length) {
      host.innerHTML = '<div class="empty-note">セクションがありません。「＋ セクション追加」か「歌詞を一括入力」から始めてください。</div>';
      return;
    }
    host.innerHTML = p.sections.map((s) => {
      const kindOpts = Object.keys(SECTION_KINDS).map((k) =>
        '<option value="' + k + '"' + (s.kind === k ? ' selected' : '') + '>' + kindLabel(k) + '</option>').join('');
      const lines = s.lines.map((l, i) => renderLine(p, s, l, i)).join('');
      const composerAtEnd = (ui.composer && ui.composer.sectionId === s.id && !ui.composer.lineId)
        ? '<div class="px-3 pb-3">' + renderComposer(p, s, null) + '</div>' : '';
      return '<div class="lyric-section" data-section="' + s.id + '">' +
        '<div class="lyric-section-head">' +
          '<input class="lyric-section-name" data-rename="' + s.id + '" value="' + esc(sectionName(p, s)) + '"' +
            (s.autoName ? ' title="呼び名の切り替えに追従します（手で書き換えると固定されます）"' : '') + '>' +
          '<select class="rounded border border-line bg-black/20 px-1.5 py-1 text-[10px]" data-kind="' + s.id + '">' + kindOpts + '</select>' +
          '<span class="section-weight">×' + sectionWeight(s).toFixed(2) + '</span>' +
          '<button type="button" class="icon-mini" data-del-section="' + s.id + '" title="セクションを削除">✕</button>' +
        '</div>' +
        (lines || '<p class="px-4 py-3 text-xs text-slate-500">行がありません。</p>') +
        composerAtEnd +
        '<div class="border-t border-line/70 px-3 py-2">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-addline="' + s.id + '">' +
            (ui.mode === 'suggest' ? '＋ 行の追加を提案' : ui.mode === 'comment' ? '＋ このセクションにコメント' : '＋ 行を追加') +
          '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderLine(p, s, l, i) {
    const owners = Object.keys(l.credits || {}).sort((a, b) => l.credits[b] - l.credits[a]);
    const top = owners[0];
    const openSug = p.suggestions.filter((x) => x.lineId === l.id && x.status === 'open').length;
    const openCom = p.comments.filter((x) => x.lineId === l.id && !x.resolved).length;
    const isOpen = ui.composer && ui.composer.lineId === l.id;
    const marks =
      (openSug ? '<span class="line-badge is-suggest">提案' + openSug + '</span>' : '') +
      (openCom ? '<span class="line-badge is-comment">コメント' + openCom + '</span>' : '') +
      (owners.length > 1 ? '<span class="line-badge is-co">共作</span>' : '');
    return '<div class="lyric-line' + (isOpen ? ' is-open' : '') + '" data-line="' + l.id + '" data-section="' + s.id + '"' +
        (top ? ' data-owner="1" style="--owner-color:' + memberColor(p, top) + '"' : '') + '>' +
      '<span class="lyric-line-no">' + (i + 1) + '</span>' +
      '<span class="lyric-line-text' + (l.text ? '' : ' is-empty') + '">' + (esc(l.text) || '（空行）') + '</span>' +
      '<span class="lyric-line-marks">' + marks + '</span>' +
      (isOpen ? renderComposer(p, s, l) : '') +
    '</div>';
  }

  function renderComposer(p, s, l) {
    const c = ui.composer;
    const val = c.mode === 'comment' ? '' : (l ? l.text : '');
    const label = c.mode === 'edit' ? (l ? '行を編集' : '行を追加')
      : c.mode === 'suggest' ? (l ? '書き換えを提案' : '行の追加を提案')
      : (l ? 'この行へコメント' : 'セクションへコメント');
    const actions = [];
    if (c.mode === 'edit') {
      actions.push('<button type="button" class="btn btn-primary btn-sm" data-composer="save">保存</button>');
      if (l) actions.push('<button type="button" class="btn btn-ghost btn-sm text-rose-400" data-composer="delete">行を削除</button>');
    } else if (c.mode === 'suggest') {
      actions.push('<button type="button" class="btn btn-primary btn-sm" data-composer="save">提案する</button>');
      if (l) actions.push('<button type="button" class="btn btn-ghost btn-sm text-rose-400" data-composer="suggest-delete">削除を提案</button>');
    } else {
      actions.push('<button type="button" class="btn btn-primary btn-sm" data-composer="save">コメントする</button>');
    }
    actions.push('<button type="button" class="btn btn-ghost btn-sm" data-composer="cancel">キャンセル</button>');
    return '<div class="composer" data-composer-root="1">' +
      '<span class="composer-label">' + label + ' · ' + esc((actor() || {}).name || '') + '</span>' +
      '<textarea id="composer-input" rows="' + (c.mode === 'comment' ? 3 : 2) + '" placeholder="' +
        (c.mode === 'comment' ? '例：ここは韻を踏みたい' : '歌詞を入力（改行で複数行）') + '">' + esc(val) + '</textarea>' +
      '<div class="composer-actions">' + actions.join('') + '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------- プレビュー列 */

  /**
   * プレビュー用のセクション配列を組み立てる。
   * clean … 今の歌詞そのまま / authors … 行の主著者で色分け
   * suggested … 未処理の提案をすべて反映したらどうなるかを差分表示
   */
  function buildPreview(p, mode) {
    const openSug = p.suggestions.filter((s) => s.status === 'open');
    const openCom = p.comments.filter((c) => !c.resolved);
    // 未解決コメントを行／セクションへぶら下げる形に整える。
    const notesFor = (lineId, sectionId) => openCom
      .filter((c) => (lineId ? c.lineId === lineId : !c.lineId && c.sectionId === sectionId))
      .map((c) => ({
        author: memberName(p, c.authorId),
        color: memberColor(p, c.authorId),
        text: c.text,
        replies: (c.replies || []).length
      }));
    return p.sections.map((s) => {
      const rows = [];
      s.lines.forEach((l) => {
        const owners = Object.keys(l.credits || {}).sort((a, b) => l.credits[b] - l.credits[a]);
        const base = {
          text: l.text,
          state: 'normal',
          color: owners[0] ? memberColor(p, owners[0]) : null,
          mark: mode === 'authors' && owners.length
            ? owners.map((id) => memberName(p, id)).join('+')
            : '',
          notes: notesFor(l.id, s.id)
        };
        if (mode !== 'suggested') { rows.push(base); return; }

        const edits = openSug.filter((x) => x.lineId === l.id && x.kind === 'edit');
        const dels = openSug.filter((x) => x.lineId === l.id && x.kind === 'delete');
        if (!edits.length && !dels.length) { rows.push(base); return; }
        rows.push(Object.assign({}, base, {
          notes: [],
          state: 'removed',
          mark: dels.length ? '削除案 ' + memberName(p, dels[0].authorId) : '元の行'
        }));
        edits.forEach((x) => rows.push({
          text: x.text, state: 'added', color: memberColor(p, x.authorId),
          mark: '提案 ' + memberName(p, x.authorId)
        }));
      });
      if (mode === 'suggested') {
        openSug.filter((x) => x.sectionId === s.id && x.kind === 'insert').forEach((x) => rows.push({
          text: x.text, state: 'added', color: memberColor(p, x.authorId),
          mark: '追加案 ' + memberName(p, x.authorId)
        }));
      }
      // 行に紐づかないセクション宛てのコメントはセクション末尾へ。
      return { name: sectionName(p, s), rows: rows, notes: notesFor(null, s.id) };
    });
  }

  function renderPreview(p) {
    $('workspace').classList.toggle('no-preview', !ui.previewOn);
    $('preview-show').classList.toggle('hidden', ui.previewOn);
    if (!ui.previewOn) return;
    Array.from($('preview-modes').children).forEach((b) => b.classList.toggle('is-active', b.dataset.preview === ui.preview));

    const doc = buildPreview(p, ui.preview);
    const noteHTML = (notes) => (notes || []).map((n) =>
      '<p class="preview-note" style="--owner-color:' + n.color + '">' +
        '<span class="preview-note-who">' + esc(n.author) + '</span>' + esc(n.text) +
        (n.replies ? '<span class="pv-mark">返信' + n.replies + '</span>' : '') +
      '</p>').join('');
    const body = doc.filter((s) => s.rows.length || (s.notes || []).length).map((s) =>
      '<div class="preview-section"><p class="preview-section-name">' + esc(s.name) + '</p>' +
      s.rows.map((r) => {
        const cls = 'preview-line' +
          (r.state === 'added' ? ' is-added' : r.state === 'removed' ? ' is-removed' : '') +
          (ui.preview === 'authors' && r.color ? ' is-authored' : '');
        const style = ui.preview === 'authors' && r.color ? ' style="--owner-color:' + r.color + '"' : '';
        return '<p class="' + cls + '"' + style + '>' + (esc(r.text) || '&nbsp;') +
          (r.mark ? '<span class="pv-mark">' + esc(r.mark) + '</span>' : '') + '</p>' +
          noteHTML(r.notes);
      }).join('') + noteHTML(s.notes) + '</div>').join('');

    $('preview-doc').innerHTML = body || '<div class="empty-note">まだ歌詞がありません。</div>';

    const lineCount = p.sections.reduce((a, s) => a + s.lines.length, 0);
    const charCount = p.sections.reduce((a, s) => a + s.lines.reduce((b, l) => b + l.text.length, 0), 0);
    const open = p.suggestions.filter((s) => s.status === 'open').length;
    const openCom = p.comments.filter((c) => !c.resolved).length;
    $('preview-stats').innerHTML = [
      p.sections.length + ' sections', lineCount + ' lines', charCount + ' chars',
      open ? '<span style="color:var(--warn)">未処理の提案 ' + open + '</span>' : '提案なし',
      openCom ? '<span style="color:var(--accent-b-text)">未解決コメント ' + openCom + '</span>' : 'コメントなし'
    ].map((t) => '<span>' + t + '</span>').join('');
  }

  function previewPlainText(p) {
    return buildPreview(p, ui.preview).filter((s) => s.rows.length).map((s) =>
      '[' + s.name + ']\n' + s.rows.map((r) =>
        (r.state === 'removed' ? '- ' : r.state === 'added' ? '+ ' : '') + r.text).join('\n')).join('\n\n');
  }

  /* --------------------------------------------------------- サイドパネル */

  function renderPanels(p) {
    const openSug = p.suggestions.filter((s) => s.status === 'open');
    const openCom = p.comments.filter((c) => !c.resolved);
    $('tab-count-suggestions').textContent = openSug.length;
    $('tab-count-comments').textContent = openCom.length;
    ['suggestions', 'comments', 'logs', 'analysis'].forEach((t) => {
      $('panel-' + t).classList.toggle('hidden', ui.tab !== t);
    });
    if (ui.tab === 'suggestions') renderSuggestions(p);
    else if (ui.tab === 'comments') renderComments(p);
    else if (ui.tab === 'logs') renderLogs(p);
    else renderAnalysis(p);
  }

  function lineTextOf(p, lineId) {
    for (const s of p.sections) {
      const l = s.lines.find((x) => x.id === lineId);
      if (l) return l.text;
    }
    return '';
  }
  function sectionNameOf(p, sectionId) {
    return sectionName(p, p.sections.find((x) => x.id === sectionId));
  }

  function avatarHTML(p, id) {
    const m = memberOf(p, id);
    if (!m) return '';
    return '<span class="avatar" style="background:' + m.color + '">' + esc(m.name.slice(0, 1)) + '</span><b>' + esc(m.name) + '</b>';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderSuggestions(p) {
    const list = p.suggestions.slice().sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1) || String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!list.length) { $('panel-suggestions').innerHTML = '<div class="empty-note">提案はまだありません。提案モードで行をクリックすると書き換え案を出せます。</div>'; return; }
    $('panel-suggestions').innerHTML = list.map((s) => {
      const badge = s.status === 'open' ? '<span class="line-badge is-suggest">未処理</span>'
        : s.status === 'accepted' ? '<span class="line-badge" style="border-color:var(--success);color:var(--success)">採用</span>'
        : '<span class="line-badge" style="border-color:var(--danger);color:var(--danger)">却下</span>';
      const body = s.kind === 'delete'
        ? '<p class="text-xs"><span class="diff-old">' + esc(s.baseText) + '</span></p>'
        : s.kind === 'insert'
          ? '<p class="text-xs"><span class="diff-new">＋ ' + esc(s.text) + '</span></p>'
          : '<p class="text-xs leading-6"><span class="diff-old">' + esc(s.baseText) + '</span><br><span class="diff-new">' + esc(s.text) + '</span></p>';
      // 提案そのものへのやりとり（採用前の質問・意見）。
      const notes = (s.replies || []).map((r) =>
        '<div class="thread-item"><div class="card-head">' + avatarHTML(p, r.authorId) +
        '<span class="card-time">' + fmtTime(r.createdAt) + '</span></div>' +
        '<p class="text-xs leading-5">' + esc(r.text) + '</p></div>').join('');
      const noteBox = ui.sugReplyTo === s.id
        ? '<div class="composer"><textarea id="sug-comment-input" rows="2" placeholder="この提案へのコメント"></textarea>' +
          '<div class="composer-actions"><button type="button" class="btn btn-primary btn-sm" data-sug-comment-send="' + s.id + '">コメントする</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-sug-comment-cancel="1">キャンセル</button></div></div>'
        : '';
      const actionBtns = [];
      if (s.status === 'open') {
        actionBtns.push('<button type="button" class="btn btn-primary btn-sm" data-sug-accept="' + s.id + '">採用</button>');
        actionBtns.push('<button type="button" class="btn btn-ghost btn-sm" data-sug-reject="' + s.id + '">却下</button>');
      }
      if (ui.sugReplyTo !== s.id) {
        actionBtns.push('<button type="button" class="btn btn-ghost btn-sm" data-sug-comment-open="' + s.id + '">コメント' +
          ((s.replies || []).length ? ' ' + s.replies.length : '') + '</button>');
      }
      const resolvedNote = s.status === 'open' ? ''
        : '<p class="mt-1.5 font-mono text-[9px] text-slate-500">' + esc(memberName(p, s.resolvedBy)) + ' が' + (s.status === 'accepted' ? '採用' : '却下') + '</p>';
      return '<div class="card">' +
        '<div class="card-head">' + avatarHTML(p, s.authorId) + badge +
        '<span class="card-time">' + fmtTime(s.createdAt) + '</span></div>' +
        '<p class="mb-1 font-mono text-[9px] text-slate-500">' + esc(sectionNameOf(p, s.sectionId)) + '</p>' +
        body + resolvedNote + notes + noteBox +
        '<div class="composer-actions">' + actionBtns.join('') + '</div>' +
      '</div>';
    }).join('');
  }

  function renderComments(p) {
    const list = p.comments.slice().sort((a, b) => (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!list.length) { $('panel-comments').innerHTML = '<div class="empty-note">コメントはまだありません。コメントモードで行をクリックすると指摘を残せます。</div>'; return; }
    $('panel-comments').innerHTML = list.map((c) => {
      const target = c.lineId ? lineTextOf(p, c.lineId) : sectionNameOf(p, c.sectionId);
      const replies = (c.replies || []).map((r) =>
        '<div class="mt-2 border-l-2 border-line pl-2.5"><div class="card-head">' + avatarHTML(p, r.authorId) +
        '<span class="card-time">' + fmtTime(r.createdAt) + '</span></div>' +
        '<p class="text-xs leading-5">' + esc(r.text) + '</p></div>').join('');
      const replyBox = ui.replyTo === c.id
        ? '<div class="composer"><textarea id="reply-input" rows="2" placeholder="返信"></textarea>' +
          '<div class="composer-actions"><button type="button" class="btn btn-primary btn-sm" data-reply-send="' + c.id + '">返信する</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-reply-cancel="1">キャンセル</button></div></div>'
        : '';
      return '<div class="card"' + (c.resolved ? ' style="opacity:.55"' : '') + '>' +
        '<div class="card-head">' + avatarHTML(p, c.authorId) +
          (c.resolved ? '<span class="line-badge">解決済み</span>' : '') +
          '<span class="card-time">' + fmtTime(c.createdAt) + '</span></div>' +
        '<p class="mb-1.5 rounded border-l-2 border-line bg-black/10 px-2 py-1 text-[11px] text-slate-500">' + esc(target || '（空行）') + '</p>' +
        '<p class="text-xs leading-5">' + esc(c.text) + '</p>' + replies + replyBox +
        (c.resolved ? '' : '<div class="composer-actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-reply-open="' + c.id + '">返信</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-comment-resolve="' + c.id + '">解決にする</button></div>') +
      '</div>';
    }).join('');
  }

  const LOG_PAGE = 25;

  function renderLogs(p) {
    if (!p.logs.length) { $('panel-logs').innerHTML = '<div class="empty-note">作業ログはまだありません。</div>'; return; }
    const all = p.logs.slice().reverse();
    const list = ui.logsAll ? all : all.slice(0, LOG_PAGE);
    $('panel-logs').innerHTML =
      '<p class="mb-2 font-mono text-[9px] uppercase tracking-[.16em] text-slate-500">Work log · ' + p.logs.length + ' 件' +
        (ui.logsAll || all.length <= LOG_PAGE ? '' : '（最新' + LOG_PAGE + '件を表示）') + '</p>' +
      list.map((e) => {
        const def = LOG_TYPES[e.type] || { label: e.type, points: 0 };
        const detail = e.after != null && e.after !== ''
          ? '<span class="diff-new">' + esc(String(e.after).slice(0, 60)) + '</span>'
          : (e.before ? '<span class="diff-old">' + esc(String(e.before).slice(0, 60)) + '</span>' : esc(e.note || ''));
        return '<div class="card">' +
          '<div class="card-head">' + avatarHTML(p, e.actorId) +
            '<span class="line-badge">' + esc(def.label) + '</span>' +
            '<span class="card-time">' + fmtTime(e.ts) + ' · ' + def.points + 'pt</span></div>' +
          '<p class="text-[11px] leading-5 text-slate-500">' +
            (e.sectionId ? esc(sectionNameOf(p, e.sectionId)) + ' · ' : '') + detail + '</p>' +
        '</div>';
      }).join('') +
      (all.length > LOG_PAGE
        ? '<div class="composer-actions"><button type="button" class="btn btn-ghost btn-sm" data-logs-toggle="1">' +
          (ui.logsAll ? '最新' + LOG_PAGE + '件だけ表示' : 'すべて表示（' + all.length + '件）') + '</button></div>'
        : '');
  }

  function renderAnalysis(p) {
    const res = analyze(p);
    const axisMeta = {
      text: { title: '現存する歌詞', note: '完成歌詞に今も残っている文字を、書いた人ごとに集計。セクション比重（サビ×1.5 など）を掛けています。' },
      adopted: { title: '採用された提案', note: '提案モードで出し、相手が採用した案。文字数とセクション比重で加点。' },
      involvement: { title: '推敲・レビュー関与', note: '編集・提案・コメント・レビューといった作業ログの手数。歌詞に残らない貢献を拾う軸。' }
    };
    const bar = (map, total) => '<div class="metric-bar">' + p.members.map((m) => {
      const pct = total > 0 ? (map[m.id] / total) * 100 : 100 / (p.members.length || 1);
      return '<div style="width:' + pct + '%;background:' + m.color + '"></div>';
    }).join('') + '</div>';
    const scoreLine = (map, total) => p.members.map((m) =>
      esc(m.name) + ' ' + (total > 0 ? ((map[m.id] / total) * 100).toFixed(1) : (100 / (p.members.length || 1)).toFixed(1)) + '%').join(' / ');

    const metrics = Object.keys(axisMeta).map((k) =>
      '<div class="metric">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<div><p class="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">' + k.toUpperCase() + ' / ' + Math.round(AXIS_WEIGHTS[k] * 100) + '%</p>' +
          '<h3 class="text-xs font-bold">' + axisMeta[k].title + '</h3></div>' +
          '<p class="font-mono text-[11px] font-bold">' + scoreLine(res.axes[k], res.totals[k]) + '</p></div>' +
        bar(res.axes[k], res.totals[k]) +
        '<p class="metric-note">' + axisMeta[k].note + '</p>' +
      '</div>').join('');

    $('panel-analysis').innerHTML = metrics +
      '<div class="metric" style="border-color:rgba(var(--accent-text-rgb),.35)">' +
        '<p class="font-mono text-[9px] uppercase tracking-[.14em] text-acid">Recommendation</p>' +
        '<p class="mt-1 text-lg font-extrabold">' + p.members.map((m) => esc(m.name) + ' ' + res.percent[m.id].toFixed(1) + '%').join(' / ') + '</p>' +
        '<p class="metric-note">' + (res.hasData
          ? '3軸を配合した算出値です。データのない軸は自動的に他の軸へ按分されます。最終比率は必ず話し合いで決めてください。'
          : 'まだ作業ログがないため均等割りを表示しています。') + '</p>' +
        '<div class="composer-actions"><button type="button" class="btn btn-secondary btn-sm" data-apply-analysis="1">合意の初期値にする</button></div>' +
      '</div>' +
      renderAiSection(p);
  }

  /* ------------------------------------------------------------ 操作 */

  function newProject() {
    const p = normalizeProject({
      id: uid('prj'),
      title: 'Untitled Lyric',
      artist: '',
      status: '作詞中',
      note: '',
      deadline: '',
      createdAt: nowISO(),
      updatedAt: nowISO(),
      // 端末の持ち主が分かっていれば、その人を1人目の共作者として置く。
      members: [
        { id: uid('m'), name: deviceNamed() ? device.name : '作詞者A', color: MEMBER_COLORS[0] },
        { id: uid('m'), name: '作詞者B', color: MEMBER_COLORS[1] }
      ],
      sections: [],
      suggestions: [],
      comments: [],
      logs: [],
      agreement: null
    });
    projects.push(p);
    ui.projectId = p.id;
    ui.actorId = p.members[0].id;
    if (deviceNamed()) bindDeviceTo(p, p.members[0].id);
    addSection(p, null, 'verse', true);
    save();
    ui.view = 'project';
    renderAll();
    if (!deviceNamed()) openIdentityModal(true);
    else openProjectModal(true);
  }

  // name を省略すると自動命名（呼び名の切り替えに追従するセクション）になる。
  function addSection(p, name, kind, silent) {
    const s = { id: uid('sec'), name: name || '', autoName: !name, kind: kind || 'verse', lines: [] };
    p.sections.push(s);
    if (!silent) log(p, 'section.add', { sectionId: s.id, after: sectionName(p, s) });
    return s;
  }

  function addLine(p, s, text, actorId, index) {
    const l = { id: uid('ln'), text: text, credits: {}, createdBy: actorId, createdAt: nowISO(), updatedAt: nowISO() };
    l.credits = applyCredits({}, '', text, actorId);
    if (typeof index === 'number') s.lines.splice(index, 0, l);
    else s.lines.push(l);
    return l;
  }

  function splitLines(text) {
    return String(text).split(/\r?\n/).map((t) => t.trim()).filter((t, i, arr) => t.length > 0 || arr.length === 1);
  }

  function commitComposer() {
    const p = project();
    const c = ui.composer;
    if (!p || !c) return;
    const input = $('composer-input');
    const raw = input ? input.value : '';
    const s = p.sections.find((x) => x.id === c.sectionId);
    if (!s) { ui.composer = null; renderProject(); return; }
    const line = c.lineId ? s.lines.find((x) => x.id === c.lineId) : null;
    const a = actor();

    if (c.mode === 'edit') {
      const parts = splitLines(raw);
      if (!parts.length || (parts.length === 1 && !parts[0])) { toast('内容が空です'); return; }
      if (line) {
        const before = line.text;
        line.credits = applyCredits(line.credits, before, parts[0], a.id);
        line.text = parts[0];
        line.updatedAt = nowISO();
        const at = s.lines.indexOf(line);
        parts.slice(1).forEach((t, i) => addLine(p, s, t, a.id, at + 1 + i));
        log(p, before === line.text && parts.length === 1 ? 'line.edit' : 'line.edit',
          { sectionId: s.id, lineId: line.id, before: before, after: line.text });
        if (parts.length > 1) log(p, 'line.add', { sectionId: s.id, after: parts.slice(1).join(' / ') });
      } else {
        parts.forEach((t) => {
          const l = addLine(p, s, t, a.id);
          log(p, 'line.add', { sectionId: s.id, lineId: l.id, after: t });
        });
      }
    } else if (c.mode === 'suggest') {
      const text = raw.trim();
      if (!text) { toast('提案内容が空です'); return; }
      if (line && text === line.text) { toast('元の行と同じ内容です'); return; }
      const sug = {
        id: uid('sug'), sectionId: s.id, lineId: line ? line.id : null,
        kind: line ? 'edit' : 'insert', text: text, baseText: line ? line.text : '',
        authorId: a.id, createdAt: nowISO(), status: 'open', resolvedBy: null, resolvedAt: null,
        replies: []
      };
      p.suggestions.push(sug);
      log(p, 'suggest.create', { sectionId: s.id, lineId: sug.lineId, before: sug.baseText, after: text });
    } else {
      const text = raw.trim();
      if (!text) { toast('コメントが空です'); return; }
      p.comments.push({
        id: uid('cm'), sectionId: s.id, lineId: line ? line.id : null,
        authorId: a.id, text: text, createdAt: nowISO(), resolved: false, replies: []
      });
      log(p, 'comment.create', { sectionId: s.id, lineId: line ? line.id : null, note: text });
    }

    ui.composer = null;
    save();
    renderProject();
  }

  function suggestDelete() {
    const p = project();
    const c = ui.composer;
    if (!p || !c || !c.lineId) return;
    const s = p.sections.find((x) => x.id === c.sectionId);
    const line = s.lines.find((x) => x.id === c.lineId);
    const a = actor();
    p.suggestions.push({
      id: uid('sug'), sectionId: s.id, lineId: line.id, kind: 'delete',
      text: '', baseText: line.text, authorId: a.id,
      createdAt: nowISO(), status: 'open', resolvedBy: null, resolvedAt: null,
      replies: []
    });
    log(p, 'suggest.create', { sectionId: s.id, lineId: line.id, before: line.text, note: '削除の提案' });
    ui.composer = null;
    save();
    renderProject();
  }

  function deleteLine() {
    const p = project();
    const c = ui.composer;
    if (!p || !c || !c.lineId) return;
    const s = p.sections.find((x) => x.id === c.sectionId);
    const idx = s.lines.findIndex((x) => x.id === c.lineId);
    if (idx < 0) return;
    const [removed] = s.lines.splice(idx, 1);
    log(p, 'line.delete', { sectionId: s.id, lineId: removed.id, before: removed.text });
    ui.composer = null;
    save();
    renderProject();
  }

  function resolveSuggestion(id, accept) {
    const p = project();
    const sug = p.suggestions.find((x) => x.id === id);
    if (!sug || sug.status !== 'open') return;
    const s = p.sections.find((x) => x.id === sug.sectionId);
    const a = actor();

    if (accept && s) {
      if (sug.kind === 'edit') {
        const line = s.lines.find((x) => x.id === sug.lineId);
        if (line) {
          const before = line.text;
          line.credits = applyCredits(line.credits, before, sug.text, sug.authorId);
          line.text = sug.text;
          line.updatedAt = nowISO();
          sug.baseText = before;
        }
      } else if (sug.kind === 'insert') {
        addLine(p, s, sug.text, sug.authorId);
      } else if (sug.kind === 'delete') {
        const idx = s.lines.findIndex((x) => x.id === sug.lineId);
        if (idx >= 0) s.lines.splice(idx, 1);
      }
    }
    sug.status = accept ? 'accepted' : 'rejected';
    sug.resolvedBy = a.id;
    sug.resolvedAt = nowISO();
    log(p, accept ? 'suggest.accept' : 'suggest.reject', {
      sectionId: sug.sectionId, lineId: sug.lineId,
      before: sug.baseText, after: accept ? sug.text : '', note: memberName(p, sug.authorId) + ' の提案'
    });
    save();
    renderProject();
  }

  /* ---------------------------------------------------------- モーダル */

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  function openProjectModal(isNew) {
    const p = project();
    if (!p) return;
    $('project-modal-title').textContent = isNew ? '新しい作詞案件' : '作詞案件を編集';
    $('pf-title').value = p.title || '';
    $('pf-artist').value = p.artist || '';
    $('pf-status').value = p.status || '作詞中';
    $('pf-note').value = p.note || '';
    $('pf-deadline').value = p.deadline || '';
    $('pf-naming').value = ui.naming;
    $('pf-delete').classList.toggle('hidden', !!isNew);
    openModal('project-modal');
  }

  function renderMembers() {
    const p = project();
    const res = analyze(p);
    $('members-list').innerHTML = p.members.map((m) => {
      const used = p.logs.some((l) => l.actorId === m.id) ||
        p.sections.some((s) => s.lines.some((l) => (l.credits || {})[m.id]));
      return '<div class="card flex items-center gap-2">' +
        '<span class="avatar" style="background:' + m.color + '">' + esc(m.name.slice(0, 1)) + '</span>' +
        '<input class="field flex-1" data-member-name="' + m.id + '" value="' + esc(m.name) + '">' +
        '<span class="font-mono text-[10px] text-slate-500">' + res.percent[m.id].toFixed(1) + '%</span>' +
        (used || p.members.length <= 2 ? '' : '<button type="button" class="icon-mini" data-member-del="' + m.id + '">✕</button>') +
      '</div>';
    }).join('');
  }

  function renderAgreement() {
    const p = project();
    const res = analyze(p);
    const cur = p.agreement || res.percent;
    $('agreement-fields').innerHTML = p.members.map((m) =>
      '<label class="flex items-center gap-3">' +
        '<span class="avatar" style="background:' + m.color + '">' + esc(m.name.slice(0, 1)) + '</span>' +
        '<span class="flex-1 text-sm font-bold">' + esc(m.name) + '</span>' +
        '<input type="number" step="0.1" min="0" max="100" class="field" style="width:7rem" data-agree="' + m.id + '" value="' + (cur[m.id] || 0).toFixed(1) + '">' +
        '<span class="text-xs text-slate-500">%</span>' +
      '</label>').join('');
    updateAgreementTotal();
  }

  function agreementValues() {
    const out = {};
    document.querySelectorAll('[data-agree]').forEach((el) => { out[el.dataset.agree] = parseFloat(el.value) || 0; });
    return out;
  }

  function updateAgreementTotal() {
    const v = agreementValues();
    const total = Object.values(v).reduce((a, b) => a + b, 0);
    const el = $('agreement-total');
    el.textContent = '合計 ' + total.toFixed(1) + '%';
    el.style.color = Math.abs(total - 100) < 0.05 ? 'var(--success)' : 'var(--danger)';
  }

  /* --------------------------------------------------------- 書き出し */

  function exportText(kind) {
    const p = project();
    if (!p) return '';
    if (kind === 'lyrics') {
      return p.sections.map((s) => '[' + sectionName(p, s) + ']\n' + s.lines.map((l) => l.text).join('\n')).join('\n\n');
    }
    if (kind === 'json') return JSON.stringify(p, null, 2);

    const res = analyze(p);
    const shares = p.agreement || res.percent;
    const lines = [];
    lines.push('# ' + (p.title || 'Untitled Lyric') + ' — 作詞貢献レポート');
    lines.push('生成: ' + new Date().toLocaleString('ja-JP'));
    if (p.artist) lines.push('アーティスト: ' + p.artist);
    lines.push('');
    lines.push('## 比率' + (p.agreement ? '（合意値）' : '（ログ算出・参考値）'));
    p.members.forEach((m) => lines.push('- ' + m.name + ': ' + (shares[m.id] || 0).toFixed(1) + '%'));
    lines.push('');
    lines.push('## 軸ごとの内訳');
    Object.keys(res.axes).forEach((k) => {
      const total = res.totals[k];
      lines.push('- ' + k + '（配合 ' + Math.round(AXIS_WEIGHTS[k] * 100) + '%）: ' +
        p.members.map((m) => m.name + ' ' + (total > 0 ? ((res.axes[k][m.id] / total) * 100).toFixed(1) : '—') + '%').join(' / '));
    });
    if (p.ai) {
      lines.push('');
      lines.push('## AI多段階分析（' + fmtTime(p.ai.at) + ' / ' + p.ai.model + '）');
      lines.push('- 1. 機械集計: ' + p.members.map((m) => m.name + ' ' + (p.ai.mechanical[m.id] || 0).toFixed(1) + '%').join(' / '));
      lines.push('- 2. 歌詞的比重: ' + p.members.map((m) => m.name + ' ' + p.ai.musical.shares[m.id].toFixed(1) + '%').join(' / '));
      lines.push('  ' + p.ai.musical.detail);
      p.ai.musical.evidence.forEach((x) => lines.push('  ・' + x));
      lines.push('- 3. 5軸評価:');
      AI_AXES.forEach((a) => {
        const row = p.ai.axes.axes[a.key];
        lines.push('  - ' + a.label + ': ' + p.members.map((m) => m.name + ' ' + row.shares[m.id].toFixed(1) + '%').join(' / '));
        if (row.comment) lines.push('    ' + row.comment);
      });
      if (p.ai.axes.summary) lines.push('  ' + p.ai.axes.summary);
      lines.push('- 4. 統合: ' + p.members.map((m) => m.name + ' ' + p.ai.combined[m.id].toFixed(1) + '%').join(' / '));
    }
    lines.push('');
    lines.push('## 作業ログ集計');
    p.members.forEach((m) => {
      const mine = p.logs.filter((l) => l.actorId === m.id);
      const byType = {};
      mine.forEach((l) => { byType[l.type] = (byType[l.type] || 0) + 1; });
      lines.push('- ' + m.name + '（' + mine.length + '件）: ' +
        Object.keys(byType).map((t) => (LOG_TYPES[t] ? LOG_TYPES[t].label : t) + '×' + byType[t]).join('、'));
    });
    lines.push('');
    lines.push('## 作業ログ全件');
    p.logs.forEach((e) => {
      const def = LOG_TYPES[e.type] || { label: e.type };
      lines.push([fmtTime(e.ts), memberName(p, e.actorId), def.label,
        e.sectionId ? sectionNameOf(p, e.sectionId) : '', (e.after || e.before || e.note || '').slice(0, 40)]
        .filter(Boolean).join(' | '));
    });
    return lines.join('\n');
  }

  function refreshExport() {
    $('export-text').value = exportText(ui.exportTab);
    Array.from($('export-tabs').children).forEach((b) => b.classList.toggle('is-active', b.dataset.export === ui.exportTab));
  }

  /* ====================================================================
     多段階AI判定
     SPLITAPP と同じ考え方で、機械集計 → AI判定 → 統合 の順に積み上げる。
     ステージ1は機械のみ（AI不要）。ステージ2・3だけがAIを呼ぶ。
     ==================================================================== */

  const AI_STAGES = [
    { key: 'mechanical', no: 1, title: '機械集計（AIなし）', note: '文字の持ち分・提案採用・作業ログの手数を集計します。' },
    { key: 'musical',    no: 2, title: '歌詞的比重（AI）',   note: '完成歌詞を読み、作品の核となる言葉を誰が書いたかを判定します。' },
    { key: 'axes',       no: 3, title: '5軸評価（AI）',       note: '同一性・影響範囲・役割・採用度・代替不可能性で個別に採点します。' },
    { key: 'combined',   no: 4, title: '統合',                 text: '3つの結果を配合して推奨比率を出します。' }
  ];

  const AI_AXES = [
    { key: 'identity',    label: '同一性',       note: 'その言葉が無いと別の曲になるか' },
    { key: 'reach',       label: '影響範囲',     note: '曲全体にどれだけ及ぶか' },
    { key: 'role',        label: '役割',         note: 'テーマ・物語をどれだけ進めたか' },
    { key: 'adoption',    label: '採用度',       note: '提案がどれだけ採用され定着したか' },
    { key: 'originality', label: '代替不可能性', note: '言い換えの難しい独自表現か' }
  ];

  // 統合の配合。機械集計を主軸に置き、AI判定は補正として乗せる。
  const AI_MIX = { mechanical: 0.45, musical: 0.40, axes: 0.15 };

  const AI_CFG_KEY = 'lyriclab_ai_cfg';
  const AI_SECRET_KEY = 'lyriclab_ai_secret';
  const AI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

  const aiRun = { active: false, stage: null, error: null };

  function aiConfig() {
    let cfg = { provider: 'gas', url: '', model: AI_DEFAULT_MODEL };
    try {
      const raw = localStorage.getItem(AI_CFG_KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) {}
    try {
      const raw = sessionStorage.getItem(AI_SECRET_KEY);
      if (raw) Object.assign(cfg, JSON.parse(raw));
    } catch (e) {}
    return cfg;
  }

  function saveAiConfig(cfg) {
    try {
      localStorage.setItem(AI_CFG_KEY, JSON.stringify({ provider: cfg.provider, url: cfg.url, model: cfg.model }));
      sessionStorage.setItem(AI_SECRET_KEY, JSON.stringify({ gasKey: cfg.gasKey || '', geminiKey: cfg.geminiKey || '' }));
    } catch (e) {}
  }

  function aiReady(cfg) {
    const c = cfg || aiConfig();
    return c.provider === 'gemini' ? !!c.geminiKey : !!(c.url && c.gasKey);
  }

  function extractJson(text) {
    const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('AIの応答をJSONとして読み取れませんでした。');
    return JSON.parse(t.slice(start, end + 1));
  }

  /** プロンプトを投げてJSONオブジェクトを受け取る。プロバイダの違いはここだけに閉じる。 */
  async function callModel(prompt, temperature) {
    const cfg = aiConfig();
    const model = cfg.model || AI_DEFAULT_MODEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      if (cfg.provider === 'gemini') {
        const res = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: temperature, responseMimeType: 'application/json' }
            })
          });
        const bodyText = await res.text();
        if (!res.ok) throw new Error('Gemini APIエラー ' + res.status + '：' + bodyText.slice(0, 200));
        const data = JSON.parse(bodyText);
        const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
        if (!text) throw new Error('AIが応答を返しませんでした。');
        return extractJson(text);
      }
      // Apps Script 経由（同期と同じウェブアプリ・同じ接続キー）
      const data = await gasPost('generate', { prompt: prompt, temperature: temperature, model: model }, 60000);
      return extractJson(data.text);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('AIの応答が60秒以内に返りませんでした。');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** AIへ渡す歌詞スナップショット。誰がどの行を書いたかまで含める。 */
  function lyricsSnapshot(p) {
    return {
      title: p.title || 'Untitled Lyric',
      note: p.note || '',
      writers: p.members.map((m) => m.name),
      sections: p.sections.map((s) => ({
        name: sectionName(p, s),
        kind: (SECTION_KINDS[s.kind] || SECTION_KINDS.other).en,
        weight: sectionWeight(s),
        lines: s.lines.map((l) => ({
          text: l.text,
          writtenBy: Object.keys(l.credits || {})
            .sort((a, b) => l.credits[b] - l.credits[a])
            .map((id) => memberName(p, id) + ':' + Math.round(l.credits[id]) + '字')
        }))
      })),
      suggestionHistory: p.suggestions.map((s) => ({
        by: memberName(p, s.authorId), status: s.status, kind: s.kind,
        from: s.baseText, to: s.text
      })).slice(0, 60),
      commentCount: p.comments.length
    };
  }

  /** AIが返した [{name, percent|score}] を memberId のマップへ寄せる。 */
  function mapByName(p, arr, field) {
    const out = {};
    p.members.forEach((m) => { out[m.id] = 0; });
    (Array.isArray(arr) ? arr : []).forEach((row, i) => {
      const name = String((row && row.name) || '').trim();
      const m = p.members.find((x) => x.name === name) ||
        p.members.find((x) => name && (x.name.indexOf(name) === 0 || name.indexOf(x.name) === 0)) ||
        p.members[i];
      if (!m) return;
      const v = Number(row[field]);
      out[m.id] = isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
    });
    return out;
  }

  function normalizeToShares(p, map) {
    const total = p.members.reduce((a, m) => a + (map[m.id] || 0), 0);
    const out = {};
    p.members.forEach((m) => { out[m.id] = total > 0 ? (map[m.id] / total) * 100 : 100 / p.members.length; });
    return out;
  }

  async function runMusicalStage(p) {
    const prompt = [
      'あなたは共同作詞（コライト）の貢献分析者です。文章の巧拙や人物の優劣ではなく、',
      '「完成した歌詞という作品の成立に対する中心性」だけを評価してください。',
      'サビ・タイトルに直結するフレーズ・作品のテーマを決定づけた言葉・繰り返される核のフレーズは比重が高い。',
      '接続表現や情景の補足、言い回しの微修正は、文字数が多くても中心性を過大評価しないでください。',
      '各行には writtenBy として実際に文字を書いた人と文字数が入っています。事実はここだけから取り、推測しないでください。',
      '作詞者名は writers の表記をそのまま使ってください。',
      'sharesは全員の合計が100になるようにしてください。',
      'detailには、誰のどのフレーズが作品の核にどう効いたかを、具体的な歌詞を引用しながら3〜5文で説明してください。',
      'evidenceには判断根拠となる具体的な行を最大5件、短く挙げてください。',
      'JSONのみを返してください。形式: {"shares":[{"name":"作詞者名","percent":number}],"detail":string,"evidence":[string]}',
      '歌詞データ: ' + JSON.stringify(lyricsSnapshot(p))
    ].join('\n');
    const parsed = await callModel(prompt, 0.15);
    return {
      shares: normalizeToShares(p, mapByName(p, parsed.shares, 'percent')),
      detail: String(parsed.detail || ''),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 5).map(String) : []
    };
  }

  async function runAxesStage(p, musical) {
    const prompt = [
      'あなたは共同作詞の貢献分析者です。以下の5軸で作詞者ごとに0〜100点を個別に採点してください。',
      AI_AXES.map((a) => '・' + a.key + '（' + a.label + '）：' + a.note).join('\n'),
      '各軸は独立して採点し、軸ごとに全員の合計が100になるようにしてください。',
      '採用度は suggestionHistory の status が accepted のものを重視し、rejected は加点しないでください。',
      '事実は与えられた歌詞データからのみ取り、推測しないでください。作詞者名は writers の表記をそのまま使ってください。',
      'commentには各軸の採点理由を、具体的な歌詞やセクション名に触れながら1〜2文で書いてください。',
      'summaryには5軸を通した総合所見を3文程度で書いてください。',
      'JSONのみを返してください。形式: {"axes":[{"key":"identity","scores":[{"name":"作詞者名","score":number}],"comment":string}],"summary":string}',
      '歌詞データ: ' + JSON.stringify(lyricsSnapshot(p)),
      '参考（前段の歌詞的比重の判定）: ' + JSON.stringify(
        p.members.map((m) => ({ name: m.name, percent: Math.round(musical.shares[m.id] * 10) / 10 })))
    ].join('\n');
    const parsed = await callModel(prompt, 0.15);
    const axes = {};
    AI_AXES.forEach((a) => {
      const row = (Array.isArray(parsed.axes) ? parsed.axes : []).find((x) => x && x.key === a.key);
      axes[a.key] = {
        shares: normalizeToShares(p, mapByName(p, row && row.scores, 'score')),
        comment: String((row && row.comment) || '')
      };
    });
    // 5軸の平均を、この段のスコアとする。
    const avg = {};
    p.members.forEach((m) => {
      avg[m.id] = AI_AXES.reduce((a, x) => a + axes[x.key].shares[m.id], 0) / AI_AXES.length;
    });
    return { axes: axes, shares: avg, summary: String(parsed.summary || '') };
  }

  function combineStages(p, mech, musical, axes) {
    const out = {};
    p.members.forEach((m) => {
      out[m.id] =
        mech[m.id] * AI_MIX.mechanical +
        musical.shares[m.id] * AI_MIX.musical +
        axes.shares[m.id] * AI_MIX.axes;
    });
    return roundShares(out, p.members.map((m) => m.id));
  }

  async function runAiAnalysis() {
    const p = project();
    if (!p) return;
    if (!aiReady()) { openAiModal(); toast('先にAIの接続設定を行ってください'); return; }
    if (!p.sections.some((s) => s.lines.length)) { toast('分析する歌詞がありません'); return; }

    aiRun.active = true; aiRun.error = null;
    const mech = analyze(p).percent;
    try {
      aiRun.stage = 'musical'; renderPanels(p);
      const musical = await runMusicalStage(p);

      aiRun.stage = 'axes'; renderPanels(p);
      const axesResult = await runAxesStage(p, musical);

      aiRun.stage = 'combined';
      const cfg = aiConfig();
      p.ai = {
        at: nowISO(),
        model: cfg.model || AI_DEFAULT_MODEL,
        provider: cfg.provider,
        mechanical: mech,
        musical: musical,
        axes: axesResult,
        combined: combineStages(p, mech, musical, axesResult)
      };
      log(p, 'ai.analyze', {
        note: p.members.map((m) => m.name + ' ' + p.ai.combined[m.id].toFixed(1) + '%').join(' / ')
      });
      save();
      toast('AI分析が完了しました');
    } catch (e) {
      aiRun.error = (e && e.message) || String(e);
      toast('AI分析に失敗しました');
    } finally {
      aiRun.active = false;
      aiRun.stage = null;
      renderProject();
    }
  }

  function renderAiSection(p) {
    const cfg = aiConfig();
    const ready = aiReady(cfg);
    const ai = p.ai;

    const stageState = (key) => {
      if (aiRun.active) {
        if (key === 'mechanical') return 'done';
        if (key === aiRun.stage) return 'running';
        const order = ['mechanical', 'musical', 'axes', 'combined'];
        return order.indexOf(key) < order.indexOf(aiRun.stage) ? 'done' : 'wait';
      }
      if (key === 'mechanical') return 'done';
      if (aiRun.error) return 'failed';
      return ai ? 'done' : 'wait';
    };
    const stateLabel = { done: '完了', running: '実行中', wait: '未実行', failed: '失敗' };

    const sharesLine = (map) => p.members.map((m) =>
      esc(m.name) + ' ' + (map && isFinite(map[m.id]) ? map[m.id].toFixed(1) : '—') + '%').join(' / ');
    const sharesBar = (map) => '<div class="axis-track">' + p.members.map((m) =>
      '<div style="width:' + ((map && map[m.id]) || 0) + '%;background:' + m.color + '"></div>').join('') + '</div>';

    const stages = AI_STAGES.map((st) => {
      const state = stageState(st.key);
      let body = '<p class="stage-body">' + esc(st.note || st.text || '') + '</p>';
      if (st.key === 'mechanical') {
        body = '<div class="stage-body">' + sharesBar(analyze(p).percent) +
          '<p class="mt-2">' + sharesLine(analyze(p).percent) + '</p></div>';
      } else if (st.key === 'musical' && ai) {
        body = '<div class="stage-body">' + sharesBar(ai.musical.shares) +
          '<p class="mt-2">' + sharesLine(ai.musical.shares) + '</p>' +
          '<p class="mt-2">' + esc(ai.musical.detail) + '</p>' +
          (ai.musical.evidence.length
            ? '<ul class="mt-2 space-y-1">' + ai.musical.evidence.map((x) => '<li>・' + esc(x) + '</li>').join('') + '</ul>'
            : '') + '</div>';
      } else if (st.key === 'axes' && ai) {
        body = '<div class="stage-body">' +
          AI_AXES.map((a) => {
            const row = ai.axes.axes[a.key];
            return '<div class="axis-row" title="' + esc(a.note + ' ／ ' + row.comment) + '">' +
              '<div class="axis-row-head"><b>' + a.label + '</b><span>' + sharesLine(row.shares) + '</span></div>' +
              sharesBar(row.shares) + '</div>';
          }).join('') +
          '<p class="mt-2">' + esc(ai.axes.summary) + '</p></div>';
      } else if (st.key === 'combined' && ai) {
        body = '<div class="stage-body">' + sharesBar(ai.combined) +
          '<p class="mt-2 text-sm font-extrabold" style="color:var(--text-strong)">' + sharesLine(ai.combined) + '</p>' +
          '<p class="mt-1">機械集計 ' + Math.round(AI_MIX.mechanical * 100) + '％ ＋ 歌詞的比重 ' +
          Math.round(AI_MIX.musical * 100) + '％ ＋ 5軸 ' + Math.round(AI_MIX.axes * 100) + '％</p>' +
          '<div class="composer-actions"><button type="button" class="btn btn-secondary btn-sm" data-apply-ai="1">合意の初期値にする</button></div></div>';
      }
      return '<div class="stage is-' + state + '">' +
        '<div class="stage-head"><span class="stage-no">' +
          (state === 'running' ? '<span class="stage-spinner"></span>' : st.no) + '</span>' +
        '<span class="stage-title">' + st.title + '</span>' +
        '<span class="stage-state">' + stateLabel[state] + '</span></div>' + body + '</div>';
    }).join('');

    return '<div class="mt-4">' +
      '<div class="mb-2 flex flex-wrap items-center justify-between gap-2">' +
        '<p class="font-mono text-[9px] uppercase tracking-[.16em] text-acid">Multi-stage AI</p>' +
        '<div class="flex gap-2">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-ai-settings="1">' + (ready ? '接続設定' : 'AIを接続') + '</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-ai-run="1"' + (aiRun.active ? ' disabled' : '') + '>' +
            (aiRun.active ? '分析中…' : ai ? 'AIで再分析' : 'AIで分析') + '</button>' +
        '</div>' +
      '</div>' +
      (aiRun.error ? '<p class="mb-2 text-xs text-rose-400">' + esc(aiRun.error) + '</p>' : '') +
      (!ready ? '<p class="mb-2 text-[11px] leading-5 text-slate-500">未接続です。Apps Script経由（SPLITAPPと同じ方式）か、Gemini APIキー直接のどちらかを設定してください。</p>' : '') +
      stages +
      (ai ? '<p class="mt-2 text-right font-mono text-[9px] text-slate-600">' +
        fmtTime(ai.at) + ' · ' + esc(ai.model) + '</p>' : '') +
    '</div>';
  }

  function openAiModal() {
    const cfg = aiConfig();
    $('ai-gas-url').value = cfg.url || '';
    $('ai-gas-key').value = cfg.gasKey || '';
    $('ai-gemini-key').value = cfg.geminiKey || '';
    $('ai-model').value = cfg.model || AI_DEFAULT_MODEL;
    setAiProvider(cfg.provider || 'gas');
    $('ai-modal-error').classList.add('hidden');
    openModal('ai-modal');
  }

  function setAiProvider(provider) {
    Array.from($('ai-provider-tabs').children).forEach((b) => b.classList.toggle('is-active', b.dataset.provider === provider));
    $('ai-gas-fields').classList.toggle('hidden', provider !== 'gas');
    $('ai-gemini-fields').classList.toggle('hidden', provider !== 'gemini');
  }

  function currentAiProvider() {
    const b = $('ai-provider-tabs').querySelector('.is-active');
    return b ? b.dataset.provider : 'gas';
  }

  /* ====================================================================
     スプレッドシート同期（SPLITAPP と同じ Apps Script + Sheets 方式）
     AI分析と同じウェブアプリ・同じ接続キーを使う。
     競合は updatedAt が新しい方を採用するだけの単純な規則。
     ==================================================================== */

  const LAST_SYNC_KEY = 'lyriclab_last_sync';
  const syncState = { busy: false, error: null, at: null };

  /** Apps Script へのPOST。プリフライトを避けるためform-encodedで送る。 */
  async function gasPost(action, payload, timeoutMs) {
    const cfg = aiConfig();
    if (!cfg.url || !cfg.gasKey) throw new Error('Apps ScriptのURLと接続キーが未設定です。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
    try {
      const body = new URLSearchParams({
        apiKey: cfg.gasKey,
        action: action,
        payload: JSON.stringify(payload == null ? null : payload)
      });
      const res = await fetch(cfg.url, { method: 'POST', body: body, signal: controller.signal });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch (e) {
        throw new Error('Apps Scriptの応答が不正です。/exec で終わるURLか、デプロイ設定を確認してください。');
      }
      if (!data.ok) throw new Error(data.error || 'Apps Scriptがエラーを返しました。');
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Apps Scriptへの接続がタイムアウトしました。');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function syncReady() {
    const cfg = aiConfig();
    return !!(cfg.url && cfg.gasKey);
  }

  function renderSyncPill() {
    const dot = $('sync-dot');
    const label = $('sync-label');
    let state = 'off';
    let text = '未接続';
    if (syncState.busy) { state = 'busy'; text = '同期中…'; }
    else if (syncState.error) { state = 'error'; text = '同期エラー'; }
    else if (syncReady()) { state = 'on'; text = syncState.at ? '同期 ' + fmtTime(syncState.at) : '接続済み'; }
    dot.className = 'sync-dot is-' + state;
    label.textContent = text;
    $('sync-pill').title = syncState.error || 'クリックで接続設定を開く';
    $('sync-btn').disabled = syncState.busy;
  }

  /**
   * 双方向同期。
   *  1. リモートの全案件を取得
   *  2. updatedAt が新しい方を採用してローカルへ反映
   *  3. ローカルが新しい／リモートに無いものを送信
   */
  async function syncNow() {
    if (syncState.busy) return;
    if (!syncReady()) { openAiModal(); toast('先に接続設定を行ってください'); return; }
    syncState.busy = true;
    syncState.error = null;
    renderSyncPill();
    try {
      const pulled = await gasPost('pull');
      const all = Array.isArray(pulled.projects) ? pulled.projects : [];
      // 細工された／壊れた案件は取り込まない（IDや色がそのまま画面に入るため）。
      const remote = all.filter(isSafeProject);
      const skipped = all.length - remote.length;
      const remoteById = {};
      remote.forEach((r) => { if (r && r.id) remoteById[r.id] = r; });

      let added = 0;
      let updated = 0;
      remote.forEach((r) => {
        const local = projects.find((p) => p.id === r.id);
        if (!local) { projects.push(normalizeProject(r)); added++; return; }
        if (String(r.updatedAt || '') > String(local.updatedAt || '')) {
          Object.assign(local, normalizeProject(r));
          updated++;
        }
      });

      const toPush = projects.filter((p) => {
        const r = remoteById[p.id];
        return !r || String(p.updatedAt || '') > String(r.updatedAt || '');
      });
      if (toPush.length) await gasPost('push', toPush, 45000);

      syncState.at = nowISO();
      try { localStorage.setItem(LAST_SYNC_KEY, syncState.at); } catch (e) {}
      save();
      renderAll();
      toast('同期しました（受信 ' + (added + updated) + ' / 送信 ' + toPush.length +
        (skipped ? ' / 不正な案件 ' + skipped + '件を除外' : '') + '）');
    } catch (e) {
      syncState.error = (e && e.message) || String(e);
      toast('同期に失敗しました');
    } finally {
      syncState.busy = false;
      renderSyncPill();
    }
  }

  /* ------------------------------------------------------------ toast */

  let toastTimer = null;
  /** テーマ切り替えボタンは「切り替え先」を文字で示す（絵文字は使わない）。 */
  function renderThemeToggle() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const btn = $('theme-toggle');
    btn.textContent = dark ? 'ライト' : 'ダーク';
    btn.title = dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え';
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  /* ------------------------------------------------------- イベント配線 */

  function bind() {
    $('theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      renderThemeToggle();
    });
    renderThemeToggle();

    $('sync-btn').addEventListener('click', syncNow);
    $('sync-pill').addEventListener('click', openAiModal);

    $('nav-dashboard').addEventListener('click', () => { ui.view = 'dashboard'; ui.composer = null; renderAll(); });
    $('logo-home').addEventListener('click', (e) => { e.preventDefault(); ui.view = 'dashboard'; ui.composer = null; renderAll(); });
    $('back-dashboard').addEventListener('click', () => { ui.view = 'dashboard'; ui.composer = null; renderAll(); });
    $('new-project-btn').addEventListener('click', newProject);
    $('edit-project-btn').addEventListener('click', () => openProjectModal(false));

    $('project-grid').addEventListener('click', (e) => {
      const row = e.target.closest('[data-open]');
      if (!row) return;
      ui.projectId = row.dataset.open;
      const p = project();
      ui.actorId = (p.members[0] || {}).id;
      const resolved = resolveActor(p);
      ui.view = 'project';
      ui.composer = null;
      renderAll();
      // 端末の持ち主が決まっていない／この案件での対応が不明なら選んでもらう。
      if (!resolved) openIdentityModal(true);
    });

    // 手動で切り替えたときは一時的な「別名義」扱いにし、端末のひも付けは変えない。
    $('actor-select').addEventListener('change', (e) => {
      ui.actorId = e.target.value;
      renderProject();
    });

    $('actor-alias').addEventListener('click', () => {
      const own = deviceMemberOf(project());
      if (!own) return;
      ui.actorId = own.id;
      renderProject();
      toast(own.name + 'に戻しました');
    });

    $('identity-btn').addEventListener('click', () => openIdentityModal(false));

    $('identity-members').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick-member]');
      if (!b) return;
      $('identity-members').querySelectorAll('[data-pick-member]').forEach((x) => x.classList.remove('is-picked'));
      b.classList.add('is-picked');
    });

    $('identity-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = project();
      const name = $('identity-name').value.trim();
      const err = $('identity-error');
      if (!name) { err.textContent = '名前を入力してください。'; err.classList.remove('hidden'); return; }

      const picked = $('identity-members').querySelector('.is-picked');
      if (p && p.members.length && !picked) {
        err.textContent = 'この案件でのあなたを選んでください。'; err.classList.remove('hidden'); return;
      }

      device.name = name;
      saveDevice();

      if (p && picked) {
        if (picked.dataset.pickMember === 'new') {
          const m = { id: uid('m'), name: name, color: MEMBER_COLORS[p.members.length % MEMBER_COLORS.length] };
          p.members.push(m);
          bindDeviceTo(p, m.id);
          save();
        } else {
          bindDeviceTo(p, picked.dataset.pickMember);
          // 選んだ共作者の名前が空欄同然なら、端末の名前で埋めておく。
          const m = memberOf(p, picked.dataset.pickMember);
          if (m && /^作詞者[A-Z]$/.test(m.name)) { m.name = name; save(); }
        }
      }
      closeModal('identity-modal');
      renderAll();
      toast('この端末の作業者を「' + name + '」にしました');
    });

    $('mode-switch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      ui.mode = b.dataset.mode;
      ui.composer = null;
      renderProject();
    });

    document.querySelectorAll('.col-resizer').forEach((el) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); startResize(e, Number(el.dataset.resizer)); });
      el.addEventListener('dblclick', resetColumns);
    });

    $('jump-bar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-jump]');
      if (b) jumpTo(b.dataset.jump);
    });
    window.addEventListener('scroll', updateJumpCurrent, { passive: true });
    window.addEventListener('resize', () => { syncBarHeight(); updateJumpCurrent(); });
    if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe($('jump-bar'));

    $('panel-logs').addEventListener('click', (e) => {
      if (!e.target.closest('[data-logs-toggle]')) return;
      ui.logsAll = !ui.logsAll;
      renderPanels(project());
    });

    $('panel-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      ui.tab = b.dataset.tab;
      renderProject();
    });

    $('add-section-btn').addEventListener('click', () => {
      const p = project();
      addSection(p, null, 'verse');
      save();
      renderProject();
    });

    // --- 歌詞エディタ（イベント委譲） ---
    const host = $('section-list');
    host.addEventListener('click', (e) => {
      const p = project();
      if (!p) return;

      const del = e.target.closest('[data-del-section]');
      if (del) {
        const id = del.dataset.delSection;
        const s = p.sections.find((x) => x.id === id);
        if (!s) return;
        const label = sectionName(p, s);
        if (s.lines.length && !confirm('「' + label + '」を' + s.lines.length + '行ごと削除します。よろしいですか？')) return;
        p.sections = p.sections.filter((x) => x.id !== id);
        log(p, 'section.delete', { before: label });
        ui.composer = null;
        save(); renderProject();
        return;
      }

      const addBtn = e.target.closest('[data-addline]');
      if (addBtn) {
        ui.composer = { sectionId: addBtn.dataset.addline, lineId: null, mode: ui.mode };
        renderProject();
        focusComposer();
        return;
      }

      const act = e.target.closest('[data-composer]');
      if (act) {
        const what = act.dataset.composer;
        if (what === 'cancel') { ui.composer = null; renderProject(); }
        else if (what === 'save') commitComposer();
        else if (what === 'delete') deleteLine();
        else if (what === 'suggest-delete') suggestDelete();
        return;
      }

      if (e.target.closest('[data-composer-root]')) return;

      const lineEl = e.target.closest('[data-line]');
      if (lineEl) {
        ui.composer = { sectionId: lineEl.dataset.section, lineId: lineEl.dataset.line, mode: ui.mode };
        renderProject();
        focusComposer();
      }
    });

    host.addEventListener('change', (e) => {
      const p = project();
      const kind = e.target.closest('[data-kind]');
      if (kind) {
        const s = p.sections.find((x) => x.id === kind.dataset.kind);
        s.kind = kind.value;
        save(); renderProject();
      }
    });

    host.addEventListener('blur', (e) => {
      const p = project();
      const rn = e.target.closest('[data-rename]');
      if (!rn || !p) return;
      const s = p.sections.find((x) => x.id === rn.dataset.rename);
      if (!s) return;
      const before = sectionName(p, s);
      const val = rn.value.trim();
      if (!val) {
        // 空にしたら自動命名に戻す（呼び名の切り替えに再び追従する）。
        if (s.autoName) { rn.value = before; return; }
        s.autoName = true; s.name = '';
      } else if (val === before) {
        return;
      } else {
        s.autoName = false;
        s.name = val;
      }
      log(p, 'section.rename', { sectionId: s.id, before: before, after: sectionName(p, s) });
      save(); renderProject();
    }, true);

    host.addEventListener('keydown', (e) => {
      if (e.target.id === 'composer-input') {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitComposer(); }
        if (e.key === 'Escape') { ui.composer = null; renderProject(); }
      }
      if (e.target.matches('[data-rename]') && e.key === 'Enter') e.target.blur();
    });

    // --- サイドパネル ---
    $('panel-suggestions').addEventListener('click', (e) => {
      const p = project();
      const acc = e.target.closest('[data-sug-accept]');
      if (acc) return resolveSuggestion(acc.dataset.sugAccept, true);
      const rej = e.target.closest('[data-sug-reject]');
      if (rej) return resolveSuggestion(rej.dataset.sugReject, false);

      const open = e.target.closest('[data-sug-comment-open]');
      if (open) {
        ui.sugReplyTo = open.dataset.sugCommentOpen;
        renderProject();
        const t = $('sug-comment-input'); if (t) t.focus();
        return;
      }
      if (e.target.closest('[data-sug-comment-cancel]')) { ui.sugReplyTo = null; renderProject(); return; }
      const send = e.target.closest('[data-sug-comment-send]');
      if (send) {
        const sug = p.suggestions.find((x) => x.id === send.dataset.sugCommentSend);
        const t = $('sug-comment-input');
        const text = t ? t.value.trim() : '';
        if (!sug) return;
        if (!text) { toast('コメントが空です'); return; }
        sug.replies = sug.replies || [];
        sug.replies.push({ id: uid('sc'), authorId: actor().id, text: text, createdAt: nowISO() });
        log(p, 'suggest.comment', { sectionId: sug.sectionId, lineId: sug.lineId, note: text });
        ui.sugReplyTo = null;
        save(); renderProject();
      }
    });

    // Ctrl+Enter で送信、Escape で閉じる（行内コンポーザーと同じ操作感）。
    $('panel-suggestions').addEventListener('keydown', (e) => {
      if (e.target.id !== 'sug-comment-input') return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const btn = $('panel-suggestions').querySelector('[data-sug-comment-send]');
        if (btn) btn.click();
      }
      if (e.key === 'Escape') { ui.sugReplyTo = null; renderProject(); }
    });

    $('panel-comments').addEventListener('click', (e) => {
      const p = project();
      const open = e.target.closest('[data-reply-open]');
      if (open) { ui.replyTo = open.dataset.replyOpen; renderProject(); const t = $('reply-input'); if (t) t.focus(); return; }
      if (e.target.closest('[data-reply-cancel]')) { ui.replyTo = null; renderProject(); return; }
      const send = e.target.closest('[data-reply-send]');
      if (send) {
        const c = p.comments.find((x) => x.id === send.dataset.replySend);
        const t = $('reply-input');
        const text = t ? t.value.trim() : '';
        if (!text) { toast('返信が空です'); return; }
        c.replies = c.replies || [];
        c.replies.push({ id: uid('rp'), authorId: actor().id, text: text, createdAt: nowISO() });
        log(p, 'comment.reply', { sectionId: c.sectionId, lineId: c.lineId, note: text });
        ui.replyTo = null;
        save(); renderProject();
        return;
      }
      const res = e.target.closest('[data-comment-resolve]');
      if (res) {
        const c = p.comments.find((x) => x.id === res.dataset.commentResolve);
        c.resolved = true;
        log(p, 'comment.resolve', { sectionId: c.sectionId, lineId: c.lineId, note: c.text });
        save(); renderProject();
      }
    });

    $('panel-analysis').addEventListener('click', (e) => {
      const p = project();
      if (e.target.closest('[data-ai-settings]')) { openAiModal(); return; }
      if (e.target.closest('[data-ai-run]')) { runAiAnalysis(); return; }

      const applyAi = e.target.closest('[data-apply-ai]');
      const applyMech = e.target.closest('[data-apply-analysis]');
      if (!applyAi && !applyMech) return;
      const shares = applyAi && p.ai ? p.ai.combined : analyze(p).percent;
      renderAgreement();
      document.querySelectorAll('[data-agree]').forEach((el) => { el.value = (shares[el.dataset.agree] || 0).toFixed(1); });
      updateAgreementTotal();
      openModal('agreement-modal');
    });

    // --- プレビュー列 ---
    $('preview-modes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preview]');
      if (!b) return;
      ui.preview = b.dataset.preview;
      renderPreview(project());
    });
    $('preview-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(previewPlainText(project()))
        .then(() => toast('プレビューをコピーしました'), () => toast('コピーできませんでした'));
    });
    $('preview-toggle').addEventListener('click', () => {
      ui.previewOn = false; renderPreview(project()); renderJumpBar(project()); updateJumpCurrent();
    });
    $('preview-show').addEventListener('click', () => {
      ui.previewOn = true; renderPreview(project()); renderJumpBar(project()); jumpTo('preview');
    });

    // --- AI接続設定 ---
    $('ai-provider-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-provider]');
      if (b) setAiProvider(b.dataset.provider);
    });
    $('ai-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const provider = currentAiProvider();
      const cfg = {
        provider: provider,
        url: $('ai-gas-url').value.trim(),
        model: $('ai-model').value.trim() || AI_DEFAULT_MODEL,
        gasKey: $('ai-gas-key').value,
        geminiKey: $('ai-gemini-key').value
      };
      const err = $('ai-modal-error');
      if (!aiReady(cfg)) {
        err.textContent = provider === 'gemini' ? 'Gemini APIキーを入力してください。' : 'Web App URLと接続キーの両方を入力してください。';
        err.classList.remove('hidden');
        return;
      }
      saveAiConfig(cfg);
      closeModal('ai-modal');
      renderSyncPill();
      renderAll();
      toast('接続設定を保存しました');
    });
    $('ai-clear').addEventListener('click', () => {
      try { localStorage.removeItem(AI_CFG_KEY); sessionStorage.removeItem(AI_SECRET_KEY); } catch (err) {}
      closeModal('ai-modal');
      renderSyncPill();
      renderAll();
      toast('接続設定を解除しました');
    });

    // --- モーダル共通 ---
    document.querySelectorAll('.modal-backdrop').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) { m.classList.add('hidden'); }
      });
    });

    $('project-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = project();
      p.title = $('pf-title').value.trim() || 'Untitled Lyric';
      p.artist = $('pf-artist').value.trim();
      p.status = $('pf-status').value;
      p.note = $('pf-note').value.trim();
      p.deadline = $('pf-deadline').value;
      const naming = $('pf-naming').value === 'en' ? 'en' : 'jp';
      if (naming !== ui.naming) {
        ui.naming = naming;
        try { localStorage.setItem(NAMING_KEY, ui.naming); } catch (err) {}
      }
      p.updatedAt = nowISO();
      save();
      closeModal('project-modal');
      renderProject();
    });

    $('pf-delete').addEventListener('click', () => {
      const p = project();
      if (!confirm('「' + p.title + '」を削除します。作業ログもすべて消えます。よろしいですか？')) return;
      projects = projects.filter((x) => x.id !== p.id);
      save();
      closeModal('project-modal');
      ui.view = 'dashboard';
      renderAll();
    });

    $('help-btn').addEventListener('click', () => openModal('help-modal'));

    $('open-members-btn').addEventListener('click', () => { renderMembers(); openModal('members-modal'); });

    $('members-list').addEventListener('change', (e) => {
      const p = project();
      const el = e.target.closest('[data-member-name]');
      if (!el) return;
      const m = memberOf(p, el.dataset.memberName);
      m.name = el.value.trim() || m.name;
      save(); renderMembers(); renderProject();
    });

    $('members-list').addEventListener('click', (e) => {
      const del = e.target.closest('[data-member-del]');
      if (!del) return;
      const p = project();
      p.members = p.members.filter((m) => m.id !== del.dataset.memberDel);
      if (!memberOf(p, ui.actorId)) ui.actorId = p.members[0].id;
      save(); renderMembers(); renderProject();
    });

    $('member-add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = project();
      const name = $('member-name').value.trim();
      if (!name) return;
      p.members.push({ id: uid('m'), name: name, color: MEMBER_COLORS[p.members.length % MEMBER_COLORS.length] });
      $('member-name').value = '';
      save(); renderMembers(); renderProject();
    });

    $('open-agreement-btn').addEventListener('click', () => { renderAgreement(); openModal('agreement-modal'); });
    $('agreement-fields').addEventListener('input', updateAgreementTotal);
    $('agreement-reset').addEventListener('click', () => {
      const res = analyze(project());
      document.querySelectorAll('[data-agree]').forEach((el) => { el.value = (res.percent[el.dataset.agree] || 0).toFixed(1); });
      updateAgreementTotal();
    });
    $('agreement-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = project();
      const v = agreementValues();
      const total = Object.values(v).reduce((a, b) => a + b, 0);
      if (Math.abs(total - 100) > 0.05) { toast('合計を100%にしてください（現在 ' + total.toFixed(1) + '%）'); return; }
      p.agreement = v;
      log(p, 'agreement.set', { note: p.members.map((m) => m.name + ' ' + v[m.id].toFixed(1) + '%').join(' / ') });
      save();
      closeModal('agreement-modal');
      renderProject();
      toast('スプリット合意を保存しました');
    });

    $('import-lyrics-btn').addEventListener('click', () => { $('import-text').value = ''; openModal('import-modal'); });
    $('import-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = project();
      const a = actor();
      const raw = $('import-text').value;
      if (!raw.trim()) { toast('歌詞が空です'); return; }
      // 新規作成時の空セクションが残っていたら取り込みで置き換える。
      if (p.sections.length === 1 && !p.sections[0].lines.length) p.sections = [];
      const blocks = raw.split(/\n\s*\n/);
      let added = 0;
      blocks.forEach((block, bi) => {
        const rows = block.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
        if (!rows.length) return;
        let name = null;
        let kind = 'verse';
        const head = rows[0].match(/^[\[【](.+)[\]】]$/);
        if (head) {
          const raw = head[1].trim();
          rows.shift();
          kind = detectKind(raw);
          // 「サビ」「Verse 1」のような定型名は自動命名に任せ（＝呼び名の切り替えに追従させ）、
          // 「回想」のような独自の見出しだけ名前として残す。
          const def = SECTION_KINDS[kind];
          const isStock = [def.jp, def.en].some((label) =>
            new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\d*$', 'i').test(raw));
          if (!isStock) name = raw;
        }
        const s = addSection(p, name, kind, true);
        rows.forEach((t) => { addLine(p, s, t, a.id); added++; });
      });
      log(p, 'lyrics.import', { after: added + '行を取り込み' });
      save();
      closeModal('import-modal');
      renderProject();
      toast(added + '行を取り込みました');
    });

    $('export-lyrics-btn').addEventListener('click', () => { refreshExport(); openModal('export-modal'); });
    $('export-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (!b) return;
      ui.exportTab = b.dataset.export;
      refreshExport();
    });
    $('export-copy').addEventListener('click', () => {
      const t = $('export-text');
      t.select();
      navigator.clipboard.writeText(t.value).then(() => toast('コピーしました'), () => toast('コピーできませんでした'));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((m) => m.classList.add('hidden'));
    });
  }

  function focusComposer() {
    const t = $('composer-input');
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }

  /* ------------------------------------------------------------ 起動 */

  load();
  loadDevice();
  loadColumns();
  try { syncState.at = localStorage.getItem(LAST_SYNC_KEY) || null; } catch (e) {}
  bind();
  renderAll();
  renderSyncPill();
})();
