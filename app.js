/* 金风6MW风机3D模型知识库 · 电脑端界面逻辑
   ------------------------------------------------------------------
   数据全部来自本机服务（同目录下的 server.py），浏览器只做展示与录入。
   数据就存在这台电脑上，手机通过同一个服务的 API 与之同步。
*/

'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let PARTS = [];          // 部件体系（60 条）
let REFS = { byPart: {}, categories: {}, sourceNote: '' };
let PHOTOS = {};         // 实物照片墙：部件ID -> [{file, cap}]
let CATALOG = {};        // 部件目录：部件ID -> {meshes, torque, materials}
let DOCS = [];           // 全部资料（含已删除，用于统计）
/* 等待挂照片的维修记录。点「记一条维修」后如果主人选了附照片，
   文件选择回调要靠它知道该挂到哪条记录上。 */
let RECORD_TARGET = null;
let BOOKS = [];          // 教材书库索引：每本书的章节 / 板块 / 页码
let BOOKPAGES = {};      // 书ID -> [ {i, project, section, text} ]（进书库时才加载）
let BOOKHITS = {};       // 书ID -> { kw, pages:[{i,...}] } 全局搜索的命中缓存
let bookCur = null;      // 当前在看的书对象
let bookChap = null;     // 当前章节 id（如 I1）
let bookOnlyConcept = false;  // 「只看概念」开关
let bookKw = '';         // 书库内搜索关键词
let bookJumpTo = null;   // 从全局搜索直接跳某页时带过来的一次性目标
let currentPart = null;  // 当前选中的部件 id
let expanded = new Set();
let pickerMode = false;

/* ---------------------------------------------------------- 工具 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function highlight(text, kw) {
  if (!kw) return esc(text);
  const t = String(text == null ? '' : text);
  const i = t.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + kw.length)) + '</mark>'
       + esc(t.slice(i + kw.length));
}

/**
 * 取「关键词附近」的一段正文并高亮它 —— 让主人一眼看到命中在哪儿。
 *
 * 为什么不是直接 slice(0, 60)：抽取出来的正文动辄上千字（图片识别的那份 1112 字），
 * 关键词常在第 500 字以后。只给开头，主人照样得自己翻半天——这正是他提的问题。
 * 命中的位置用 `…` 标出前文有省略，并去掉换行（OCR 的行是碎的，换行会撑高行高）。
 */
function hitSnippet(text, kw, before = 14, after = 46) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!kw) return esc(flat.slice(0, before + after));
  const i = flat.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return esc(flat.slice(0, before + after));
  const s = Math.max(0, i - before);
  const e = Math.min(flat.length, i + kw.length + after);
  return (s > 0 ? '…' : '') + highlight(flat.slice(s, e), kw)
       + (e < flat.length ? '…' : '');
}
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2000);
}
async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------- 接口 */
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}
async function loadAll() {
  const [parts, refs, docs, info, photos, catalog, books] = await Promise.all([
    api('/api/parts'), api('/api/refs'), api('/api/docs?since=0'), api('/api/info'),
    // 照片墙是静态文件，不是用户资料——拿不到就当没有，不影响其它功能
    fetch('photos/manifest.json').then((r) => (r.ok ? r.json() : { byPart: {} }))
      .catch(() => ({ byPart: {} })),
    // 部件目录（到小部件/物料）：同样是静态文件
    fetch('data/catalog.json').then((r) => (r.ok ? r.json() : { tree: [] }))
      .catch(() => ({ tree: [] })),
    // 教材书库索引：整本书按章节/板块登记，正文按页另存，用到时才拉
    fetch('books/books-index.json').then((r) => (r.ok ? r.json() : { books: [] }))
      .catch(() => ({ books: [] })),
  ]);
  PARTS = parts.parts || [];
  REFS = { byPart: refs.byPart || {}, categories: refs.categories || {}, sourceNote: refs.sourceNote || '' };
  PHOTOS = photos.byPart || {};
  CATALOG = indexCatalog(catalog);
  DOCS = docs.docs || [];
  BOOKS = books.books || [];
  $('#btnBooks').style.display = BOOKS.length ? '' : 'none';
  $('#serverInfo').textContent =
    `资料 ${info.docCount} 条 · 文件 ${info.fileCount} 个 · ${fmtBytes(info.totalBytes)}`;
}
function activeDocs(partId) {
  return DOCS.filter((d) => d.partId === partId && !d.deletedAt)
             .sort((a, b) => b.createdAt - a.createdAt);
}
function countUnder(partId) {
  return DOCS.filter((d) => !d.deletedAt && (d.partId === partId || d.partId.startsWith(partId) && partId.length === 1)).length;
}

/* ---------------------------------------------------------- 目录树 */
function renderTree() {
  const kw = $('#treeFilter').value.trim();
  const groups = PARTS.filter((p) => p.level === 1);
  const kids = PARTS.filter((p) => p.level === 2);
  let html = '';
  let shown = 0;
  for (const g of groups) {
    const children = kids.filter((k) => k.parent_id === g.id)
      .filter((k) => !kw || k.name.includes(kw) || k.id.toLowerCase().includes(kw.toLowerCase()));
    if (kw && children.length === 0) continue;
    const total = countUnder(g.id);
    const open = expanded.has(g.id) || !!kw;
    html += `<div class="tree-group" data-group="${g.id}">
      <span class="arrow">${open ? '▾' : '▸'}</span>
      <span class="id">${g.id}</span>
      <span class="nm">${esc(g.name)}</span>
      ${total ? `<span class="badge">${total}</span>` : ''}
      <span class="cnt">${children.length}</span>
    </div>`;
    if (open) {
      for (const c of children) {
        const n = activeDocs(c.id).length;
        html += `<div class="tree-child ${currentPart === c.id ? 'active' : ''}" data-part="${c.id}">
          <span class="id">${c.id}</span>
          <span class="nm">${esc(c.name)}</span>
          ${n ? `<span class="badge">${n}</span>` : ''}
        </div>`;
        shown++;
      }
    }
  }
  $('#tree').innerHTML = html || '<div class="empty"><p>没有匹配的部件</p></div>';
  $('#treeCount').textContent = `${PARTS.filter((p) => p.level === 2).length} 个二级系统`;
}
function partName(id) {
  const p = PARTS.find((x) => x.id === id);
  return p ? p.name : id;
}
function partParentName(id) {
  const p = PARTS.find((x) => x.id === id);
  if (!p || !p.parent_id) return '';
  return partName(p.parent_id);
}

/* ---------------------------------------------------------- 资料面板 */
function renderLibrary() {
  const box = $('#libBody');
  if (!currentPart) {
    box.innerHTML = `<div class="empty">
      <p>从左侧目录选一个部件，或用中间的三维模型点一个部位</p>
      <p class="muted">出厂参考参数与你自己录入的资料都会显示在这里</p></div>`;
    $('#libTitle').textContent = '资料库';
    $('#btnExportPart').disabled = true;
    $('#addBar').classList.add('hidden');
    return;
  }
  $('#libTitle').textContent = `${currentPart} ${partName(currentPart)}`;
  $('#btnExportPart').disabled = false;

  let html = '';
  // ---- 出厂参考 ----
  const refs = REFS.byPart[currentPart] || [];
  if (refs.length) {
    const cats = REFS.categories || {};
    const byCat = {};
    // 带上在 refs 数组里的原始下标：搜索结果点进来时要靠它滚到那一条
    refs.forEach((r, i) => (byCat[r.category] = byCat[r.category] || []).push({ r, i }));
    html += `<div class="refblock"><h4><span class="toggle" id="refToggle">▾</span>出厂参考
             <span class="badge">${refs.length}</span></h4><div id="refBody">`;
    for (const [cat, list] of Object.entries(byCat)) {
      html += `<div class="ref-cat">${esc(cats[cat] || cat)}</div>`;
      for (const { r, i } of list) {
        html += `<div class="ref-row" data-refi="${i}"><div class="lb">${esc(r.label)}</div>
                 <div class="vl">${esc(r.value)}</div></div>`;
        if (r.note) html += `<div class="ref-note">${esc(r.note)}</div>`;
      }
    }
    if (REFS.sourceNote) html += `<div class="ref-src">${esc(REFS.sourceNote)}</div>`;
    html += `</div></div>`;
  }

  // ---- 实物照片 ----
  const photos = PHOTOS[currentPart] || [];
  if (photos.length) {
    html += `<div class="refblock"><h4>实物照片 <span class="badge">${photos.length}</span></h4>`;
    for (const p of photos) {
      html += `<div class="photo"><img src="photos/${encodeURIComponent(p.file)}" loading="lazy" alt="">
               <div class="photo-cap">${esc(p.cap)}</div></div>`;
    }
    html += `</div>`;
  }

  // ---- 部件档案（维修记录）----
  html += renderRecords();

  // ---- 我的资料 ----
  const docs = activeDocs(currentPart).filter((d) => d.kind !== 'RECORD');
  html += `<div class="docsec-head"><span>我的资料</span><span class="muted">${docs.length} 条</span></div>`;
  if (!docs.length) {
    html += `<div class="empty"><p>还没有录入资料</p>
             <p class="muted">用下方按钮：导入文件 / 写笔记 / 记链接</p></div>`;
  } else {
    for (const d of docs) {
      const isImg = d.kind === 'PHOTO' || (d.mime || '').startsWith('image/');
      const thumb = isImg && d.sha256
        ? `<img class="thumb" src="/api/files/${d.sha256}" alt="">`
        : `<span class="kind ${d.kind}">${kindLabel(d.kind)}</span>`;
      const sub = d.kind === 'LINK' ? esc(d.textContent || '')
        : `${fmtTime(d.createdAt)}${d.sizeBytes ? ' · ' + fmtBytes(d.sizeBytes) : ''}`;
      html += `<div class="docrow" data-uuid="${d.uuid}">
        ${thumb}
        <div class="docmain">
          <div class="t">${esc(d.title)}</div>
          <div class="s">${sub}</div>
        </div>
        <div class="doc-actions">
          ${d.kind === 'LINK' ? `<button class="iconbtn" data-act="open">↗</button>` : ''}
          ${(d.kind === 'NOTE' || d.kind === 'LINK') ? `<button class="iconbtn" data-act="edit">✎</button>` : ''}
          <button class="iconbtn danger" data-act="del">✕</button>
        </div>
      </div>`;
    }
  }
  box.innerHTML = html;
  $('#addBar').classList.remove('hidden');
}

/**
 * 部件档案：这个部件下的维修记录，按**作业时间**倒序，按年月分组。
 *
 * 与「我的资料」分开显示是有意的：资料是「查到的东西」，记录是「我干过的活」，
 * 混在一起会把干活的痕迹淹掉——而留下痕迹正是这个功能存在的理由。
 */
function renderRecords() {
  const all = activeDocs(currentPart).filter((d) => d.kind === 'RECORD');
  if (!all.length) {
    return `<div class="recblock"><h4>部件档案
      <span class="badge">0</span></h4>
      <div class="empty"><p>这个部件还没有维修记录</p>
      <p class="muted">记一条：干了什么、什么时候、附张照片。以后换人接手就能看到</p></div></div>`;
  }
  const rows = all.slice().sort((a, b) => (b.happenedAt || b.createdAt || 0) - (a.happenedAt || a.createdAt || 0));
  let html = `<div class="recblock"><h4>部件档案 <span class="badge">${rows.length}</span>
              <span class="muted rec-hint">共 ${rows.length} 次</span></h4><div class="timeline">`;
  let lastGroup = null;
  for (const d of rows) {
    const g = whenGroup(d.happenedAt || d.createdAt);
    if (g !== lastGroup) { html += `<div class="tl-group">${esc(g)}</div>`; lastGroup = g; }
    // 照片挂在记录下：用 note 存父记录的 uuid。
    // 这样不用改表结构、不用动同步协议——note 本来就会同步。
    const imgs = DOCS.filter((x) => x.note === d.uuid && !x.deletedAt);
    const photo = imgs.length
      ? `<div class="tl-photos">${imgs.map((x) => `<img class="tl-photo" data-uuid="${x.uuid}"
           src="/api/files/${x.sha256}" alt="${esc(x.title)}">`).join('')}</div>` : '';
    const late = d.createdAt && d.happenedAt && d.createdAt - d.happenedAt > 86400000;
    html += `<div class="tl-item docrow" data-uuid="${d.uuid}" data-rec="1">
      <div class="tl-time">${esc(fmtWhen(d.happenedAt || d.createdAt))}
        ${late ? '<span class="tl-late" title="事后补记">补记</span>' : ''}</div>
      <div class="tl-body">
        <div class="tl-title">${esc(d.title)}</div>
        ${d.textContent ? `<div class="tl-text">${esc(d.textContent)}</div>` : ''}
        ${photo}
      </div>
      <div class="doc-actions">
        <button class="iconbtn" data-act="recphoto" title="加照片">📷</button>
        <button class="iconbtn" data-act="edit" title="改">✎</button>
        <button class="iconbtn danger" data-act="del" title="删">✕</button>
      </div>
    </div>`;
  }
  html += `</div></div>`;
  return html;
}

/* 把目录树拍平成 部件ID -> 明细，供选择器显示 */
function indexCatalog(c) {
  const m = {};
  for (const g of (c.tree || [])) {
    for (const p of (g.children || [])) m[p.id] = p;
  }
  return m;
}

function kindLabel(k) {
  return { FILE: '文件', PHOTO: '照片', NOTE: '笔记', LINK: '链接',
           RECORD: '维修记录' }[k] || k;
}

/**
 * 解析主人手输的作业时间。
 *
 * 为什么不让主人选日期控件：现场补记时脑子里是「9月28号下午」，打字比点日历快；
 * 而日历控件在手机上还要滚半天。所以接受几种常见写法，认不出来就退回当前时间
 * **并告诉主人**（不能悄悄改成现在——那会让时间线骗人）。
 */
function parseWhen(txt) {
  const t = String(txt || '').trim();
  if (!t) return { ms: Date.now(), ok: true, fallback: true };
  // 2026-09-28 / 2026/9/28 / 2026.9.28，后面可跟 14:30 或 14:30:05
  const m = t.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return { ms: Date.now(), ok: false, fallback: true };
  const [, Y, Mo, D, hh, mi, ss] = m;
  const d = new Date(Number(Y), Number(Mo) - 1, Number(D),
                     Number(hh || 0), Number(mi || 0), Number(ss || 0));
  if (isNaN(d.getTime())) return { ms: Date.now(), ok: false, fallback: true };
  return { ms: d.getTime(), ok: true, fallback: false };
}

/** 作业时间的显示写法：现场看得懂的那种 */
function fmtWhen(ms) {
  if (!ms) return '时间未填';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 时间线分组标题：2026年9月 */
function whenGroup(ms) {
  const d = new Date(ms || 0);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/* ---------------------------------------------------------- 三维联动 */
function frameSend(cmd, value) {
  const f = $('#view3d');
  if (f && f.contentWindow) f.contentWindow.postMessage({ cmd, value }, '*');
}
function refresh3DCounts() {
  const m = {};
  for (const d of DOCS) if (!d.deletedAt) m[d.partId] = (m[d.partId] || 0) + 1;
  frameSend('setDocCounts', m);
}
function selectPart(id, fly) {
  currentPart = id;
  renderTree();
  renderLibrary();
  if (fly) frameSend('focusPart', id);
  frameSend('selectPart', id);
}

/**
 * 从搜索结果跳进资料库里的那一条：切部件 → 滚到它 → 闪一下底色。
 *
 * 只切部件是不够的：一个部件下可能有四百多条出厂参考卡片，
 * 不定位的话用户还得自己一条条翻。refi 是出厂参考的下标，uuid 是资料的 uuid。
 */
function jumpTo(partId, refi, uuid) {
  selectPart(partId, true);
  // selectPart 里的 renderLibrary() 是同步换 DOM 的，这里紧接着就能取到目标行，
  // 不需要等下一帧——等帧在无头/后台标签页里可能压根不来（实测踩过）。
  let el = null;
  if (refi != null && refi !== '') {
    const body = $('#refBody');
    if (body) body.style.display = '';                  // 万一被收起，先展开
    el = document.querySelector(`#libBody .ref-row[data-refi="${refi}"]`);
  } else if (uuid) {
    el = document.querySelector(`#libBody .docrow[data-uuid="${uuid}"]`);
  }
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2600);
}
function focusPartRemote(id) {
  frameSend('focusPart', id);
}

/* ---------------------------------------------------------- 录入 */
async function uploadFile(file, partId, recordUuid) {
  const buf = await file.arrayBuffer();
  const sha = await sha256Hex(buf);
  await api('/api/files/' + sha, { method: 'POST', body: buf });
  const now = Date.now();
  const isImg = (file.type || '').startsWith('image/');
  await api('/api/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docs: [{
        uuid: crypto.randomUUID(),
        partId,
        title: file.name,
        kind: isImg ? 'PHOTO' : 'FILE',
        origName: file.name,
        sha256: sha,
        mime: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        textContent: null,
        // 挂在某条维修记录下时，note 存那条记录的 uuid（见 renderRecords）
        note: recordUuid || null,
        createdAt: now,
        updatedAt: now,
        author: '电脑端',
        rev: 1,
        deletedAt: null,
      }],
    }),
  });
}
async function pushDoc(doc) {
  await api('/api/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docs: [doc] }),
  });
}
async function deleteDoc(uuid) {
  await api('/api/docs/' + encodeURIComponent(uuid), { method: 'DELETE' });
}

/* ---------------------------------------------------------- PT100 换算器

   PT100 是风机测温的标准元件（绕组/轴承/齿轮箱油温都用它）。
   库里 `data/facts/传感器.json` 本来就有「PT100 计算公式」这张卡片，
   但现场拿着万用表读到一个电阻值，还要自己按计算器——这里把它做成一步。

   分度关系用 IEC 60751 的 Callendar-Van Dusen 标准系数：
     t ≥ 0℃ : R = R0(1 + A·t + B·t²)
     t < 0℃ : R = R0(1 + A·t + B·t² + C·(t−100)·t³)     （多一个四次项 C）
   反查（R→t）没有闭式解，用牛顿迭代；PT100 在这个区间单调且曲率很小，收敛很快。

   ⚠️ 这是**分度表近似**，不是精密计量：标准本身是拟合式，工业铂电阻还有
      允差等级（A 级 ±0.15℃、B 级 ±0.3℃ @0℃）。界面上必须写明，别装成精确值。
*/
const PT100 = {
  R0: 100,
  A: 3.9083e-3,
  B: -5.775e-7,
  C: -4.183e-12,
  TMIN: -200,
  TMAX: 850,
};

/**
 * Callendar-Van Dusen 多项式本身：只做数学，**不做任何范围检查**。
 *
 * 必须和下面的对外函数分开，这是踩过坑的：
 * 求逆要用牛顿迭代，迭代过程中 t 会短暂踏出 [-200, 850]，
 * 若这里顺手判一下量程并返回 null，迭代拿到 NaN 就直接崩掉，
 * 结果是「量程端点附近（约 -200~-195℃）永远解不出来」。
 * 数学函数只管算，范围守卫放在对外入口。
 */
function pt100Cvd(t) {
  const { R0, A, B, C } = PT100;
  return t < 0
    ? R0 * (1 + A * t + B * t * t + C * (t - 100) * t * t * t)
    : R0 * (1 + A * t + B * t * t);
}

/** 温度（℃）→ 电阻（Ω）。超量程返回 null。 */
function pt100TofR(t) {
  if (t === null || t === undefined || t === '' || isNaN(t)) return null;
  const x = Number(t);
  if (!isFinite(x) || x < PT100.TMIN || x > PT100.TMAX) return null;
  return pt100Cvd(x);
}

/** 电阻（Ω）→ 温度（℃）。牛顿迭代，越界返回 null（宁可说不出，也不给个假温度）。 */
function pt100RtoT(r) {
  if (r === null || r === undefined || r === '' || isNaN(r)) return null;
  const x = Number(r);
  if (!isFinite(x)) return null;
  // 合理量程：-200℃ = 18.5201Ω，850℃ ≈ 390.48Ω。
  // 下限留一点余量（18.4）而不是卡死在 18.5201：现场万用表有读数误差，
  // 卡太死会让「刚好在端点」的读数被拒之门外，反而更不像人话。
  const RMIN = 18.4, RMAX = 390.6;
  if (x < RMIN || x > RMAX) return null;
  // 牛顿迭代（用导数解析式，比数值微分稳）
  let t = (x - PT100.R0) / (PT100.R0 * PT100.A);      // 线性起步，已很接近
  for (let i = 0; i < 30; i++) {
    const f = pt100Cvd(t) - x;
    const dRdt = PT100.R0 * (t < 0
      ? (PT100.A + 2 * PT100.B * t + PT100.C * (4 * t ** 3 - 300 * t * t))
      : (PT100.A + 2 * PT100.B * t));
    if (!isFinite(dRdt) || dRdt === 0) return null;
    const step = f / dRdt;
    t -= step;
    if (Math.abs(step) < 1e-9) break;
  }
  if (!isFinite(t) || t < PT100.TMIN - 0.5 || t > PT100.TMAX + 0.5) return null;
  // 夹到量程端点：数学上可能是 -200.0001，那是浮点误差，不是真实温度。
  // 这里夹是安全的——它落在端点附近，说明解本来就在端点。
  return Math.max(PT100.TMIN, Math.min(PT100.TMAX, t));
}

/** 按允差等级给一句「能信到什么程度」——现场要的是这个，不是一个裸数字 */
function pt100Tolerance(t) {
  const abs = Math.abs(t);
  // IEC 60751 允差：A 级 0.15+0.002|t|，B 级 0.30+0.005|t|，AA 级 0.10+0.0017|t|
  return {
    aa: 0.10 + 0.0017 * abs,
    a: 0.15 + 0.002 * abs,
    b: 0.30 + 0.005 * abs,
  };
}

function renderPt100() {
  const body = $('#pt100Body');
  if (!body) return;
  const rt = $('#pt100R').value.trim();
  const tr = $('#pt100T').value.trim();
  const tFromR = rt === '' ? null : pt100RtoT(rt);
  const rFromT = tr === '' ? null : pt100TofR(tr);

  const line = (label, val, unit, tol) => {
    if (val === null) {
      return `<div class="pt-row"><div class="pt-k">${label}</div>
              <div class="pt-v pt-bad">——</div>
              <div class="pt-n">${tol || '超出量程，不作推算'}</div></div>`;
    }
    return `<div class="pt-row"><div class="pt-k">${label}</div>
            <div class="pt-v">${val.toFixed(2)}<span class="pt-u">${unit}</span></div>
            <div class="pt-n">${tol || ''}</div></div>`;
  };

  let html = '';
  if (rt !== '') {
    html += line('读到的电阻', Number(rt) === Number(rt) ? Number(rt) : null, ' Ω', '');
    html += line('对应温度', tFromR, ' ℃',
      tFromR === null ? '' :
      `铂电阻允差 A 级 ±${pt100Tolerance(tFromR).a.toFixed(2)}℃ · B 级 ±${pt100Tolerance(tFromR).b.toFixed(2)}℃`);
  } else if (tr !== '') {
    html += line('设定温度', Number(tr) === Number(tr) ? Number(tr) : null, ' ℃', '');
    html += line('对应电阻', rFromT, ' Ω', rFromT === null ? '' : 'R0 = 100 Ω（IEC 60751 分度）');
  } else {
    html = `<div class="pt-empty">在上面任一行输入一个数——<b>读到电阻</b>填左边，
            <b>想核温度</b>填右边，另一个自动算出来。</div>`;
  }
  html += `<div class="pt-foot">分度按 IEC 60751（R0=100Ω，α=0.00385）。
           这是分度表近似，不是精密计量；实际读数还受引线电阻、自热与仪表精度影响。</div>`;
  body.innerHTML = html;
}

function openPt100() {
  $('#pt100Mask').classList.remove('hidden');
  $('#pt100R').value = '';
  $('#pt100T').value = '';
  renderPt100();
  setTimeout(() => $('#pt100R').focus(), 30);
}

/* ---------------------------------------------------------- 弹层：通用表单 */
function openDialog(title, fields, onSave) {
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = fields.map((f) => f.type === 'textarea'
    ? `<label>${esc(f.label)}</label><textarea id="f_${f.key}" placeholder="${esc(f.ph || '')}">${esc(f.value || '')}</textarea>`
    : `<label>${esc(f.label)}</label><input id="f_${f.key}" value="${esc(f.value || '')}" placeholder="${esc(f.ph || '')}">`
  ).join('');
  $('#dlgMask').classList.remove('hidden');
  const ok = $('#dlgOk'), cancel = $('#dlgCancel');
  const close = () => { $('#dlgMask').classList.add('hidden'); ok.onclick = null; cancel.onclick = null; };
  cancel.onclick = close;
  ok.onclick = async () => {
    const vals = {};
    for (const f of fields) vals[f.key] = $('#f_' + f.key).value;
    close();
    try { await onSave(vals); } catch (e) { toast('保存失败：' + e.message); }
  };
  const first = fields[0] && document.getElementById('f_' + fields[0].key);
  if (first) first.focus();
}

/* ---------------------------------------------------------- 事件绑定 */
function bind() {
  // 目录树
  $('#tree').addEventListener('click', (e) => {
    const g = e.target.closest('.tree-group');
    if (g) {
      const id = g.dataset.group;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      renderTree();
      return;
    }
    const c = e.target.closest('.tree-child');
    if (c) { selectPart(c.dataset.part, true); }
  });
  $('#treeFilter').addEventListener('input', renderTree);

  // 三维事件
  window.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d.type === 'ready') refresh3DCounts();
    else if (d.type === 'partSelected') {
      currentPart = d.partId;
      renderTree(); renderLibrary();
    } else if (d.type === 'error') {
      toast('三维加载失败：' + d.msg);
    }
  });

  // 视图切换
  $$('.viewbar .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.cmd === 'reset') { frameSend('resetCamera'); return; }
      if (btn.dataset.cmd === 'picker') { openPicker(); return; }
      $$('.viewbar .chip[data-view]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      frameSend('setView', btn.dataset.view);
    });
  });

  // 资料行操作
  $('#libBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.docrow');
    if (!row) {
      if (e.target.id === 'refToggle') {
        const b = $('#refBody');
        b.style.display = b.style.display === 'none' ? '' : 'none';
        $('#refToggle').textContent = b.style.display === 'none' ? '▸' : '▾';
      }
      return;
    }
    const uuid = row.dataset.uuid;
    const doc = DOCS.find((d) => d.uuid === uuid);
    if (!doc) return;

    if (!btn) {
      // 点行本身：文件用系统方式打开，其余弹详情
      if (doc.kind === 'RECORD') editRecord(doc);          // 记录：点一下就能改
      else if (doc.kind === 'LINK') window.open(doc.textContent, '_blank');
      else if (doc.sha256) window.open('/api/files/' + doc.sha256, '_blank');
      else showNote(doc);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'open') window.open(doc.textContent, '_blank');
    else if (act === 'record') editRecord(doc);
    else if (act === 'recphoto') {
      // 给这条维修记录补一张照片。走的是原来导入文件那条路，
      // 只多传一个「挂到哪条记录」——不新增接口、不新增表。
      RECORD_TARGET = { uuid: doc.uuid, title: doc.title };
      $('#filePicker').click();
    }
    else if (act === 'edit') (doc.kind === 'RECORD' ? editRecord : editNote)(doc);
    else if (act === 'del') {
      if (!confirm(`删除「${doc.title}」？此操作不可撤销。`)) return;
      try {
        await deleteDoc(doc.uuid);
        await loadAll();
        renderTree(); renderLibrary(); refresh3DCounts();
        toast('已删除');
      } catch (err) { toast('删除失败：' + err.message); }
    }
  });

  function showNote(doc) {
    openDialog('笔记：' + doc.title,
      [{ key: 'body', label: '正文', type: 'textarea', value: doc.textContent || '' }],
      async () => {});
    $('#dlgOk').style.display = 'none';
    setTimeout(() => { $('#dlgOk').style.display = ''; }, 0);
  }

  // 添加资料
  $('#addBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b || !currentPart) return;
    const kind = b.dataset.add;
    if (kind === 'file') { $('#filePicker').click(); return; }
    if (kind === 'record') {
      // 默认就是现在——多数情况是刚干完活顺手记，只补记时才改时间
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const defWhen = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      openDialog('记一条维修', [
        { key: 'title', label: '干了什么（一句话）', ph: '例如：更换 3 号机组塔筒法兰螺栓' },
        { key: 'when', label: '什么时候干的', value: defWhen,
          ph: '2026-09-28 14:30（补记就改这里）' },
        { key: 'body', label: '详细情况', type: 'textarea',
          ph: '例如：M48 力矩 5100 N·m 复紧 20 颗，发现 2 颗预紧力不足已更换' },
      ], async (v) => {
        if (!v.title && !v.body) return;
        const w = parseWhen(v.when);
        if (!w.ok) toast('时间「' + v.when + '」没认出来，先按现在记下，可以再编辑');
        const now = Date.now();
        const uuid = crypto.randomUUID();
        await pushDoc({
          uuid, partId: currentPart,
          title: v.title || '维修记录', kind: 'RECORD',
          origName: null, sha256: null, mime: 'text/plain',
          sizeBytes: new Blob([v.body || '']).size, textContent: v.body || '',
          note: null, createdAt: now, updatedAt: now, happenedAt: w.ms,
          author: '电脑端', rev: 1, deletedAt: null,
        });
        await loadAll(); renderTree(); renderLibrary(); refresh3DCounts();
        // 不在保存流程里弹「要不要附照片」的确认框：
        //   · 它会阻塞页面（无头浏览器里直接卡死，实测踩过）；
        //   · 时间线上每条记录已经有 📷 按钮，想加照片点一下就行，更省事。
        toast('维修记录已保存');
      });
      return;
    }
    if (kind === 'note') {
      openDialog('写笔记', [
        { key: 'title', label: '标题', ph: '例如：塔筒法兰力矩复检' },
        { key: 'body', label: '正文', type: 'textarea', ph: '记录内容…' },
      ], async (v) => {
        if (!v.title && !v.body) return;
        const now = Date.now();
        await pushDoc({
          uuid: crypto.randomUUID(), partId: currentPart,
          title: v.title || '未命名笔记', kind: 'NOTE',
          origName: null, sha256: null, mime: 'text/plain',
          sizeBytes: new Blob([v.body]).size, textContent: v.body, note: null,
          createdAt: now, updatedAt: now, author: '电脑端', rev: 1, deletedAt: null,
        });
        await loadAll(); renderTree(); renderLibrary(); refresh3DCounts();
        toast('笔记已保存');
      });
      return;
    }
    if (kind === 'link') {
      openDialog('记链接', [
        { key: 'url', label: '网址', ph: 'https://' },
        { key: 'title', label: '标题（可留空）' },
        { key: 'note', label: '备注（可留空）' },
      ], async (v) => {
        if (!v.url) return;
        const now = Date.now();
        await pushDoc({
          uuid: crypto.randomUUID(), partId: currentPart,
          title: v.title || v.url, kind: 'LINK',
          origName: null, sha256: null, mime: 'text/uri-list',
          sizeBytes: 0, textContent: v.url, note: v.note || null,
          createdAt: now, updatedAt: now, author: '电脑端', rev: 1, deletedAt: null,
        });
        await loadAll(); renderTree(); renderLibrary(); refresh3DCounts();
        toast('链接已保存');
      });
    }
  });

  function editRecord(doc) {
    openDialog('改这条维修记录', [
      { key: 'title', label: '干了什么', value: doc.title },
      { key: 'when', label: '什么时候干的', value: fmtWhen(doc.happenedAt || doc.createdAt) },
      { key: 'body', label: '详细情况', type: 'textarea', value: doc.textContent || '' },
    ], async (v) => {
      const w = parseWhen(v.when);
      if (!w.ok) toast('时间「' + v.when + '」没认出来，保持原值');
      await pushDoc(Object.assign({}, doc, {
        title: v.title || doc.title,
        textContent: v.body,
        happenedAt: w.ok ? w.ms : (doc.happenedAt || doc.createdAt),
        updatedAt: Date.now(), rev: (doc.rev || 1) + 1,
      }));
      await loadAll(); renderLibrary(); toast('记录已更新');
    });
  }

  function editNote(doc) {
    openDialog('编辑笔记', [
      { key: 'title', label: '标题', value: doc.title },
      { key: 'body', label: '正文', type: 'textarea', value: doc.textContent || '' },
    ], async (v) => {
      await pushDoc(Object.assign({}, doc, {
        title: v.title || doc.title, textContent: v.body,
        updatedAt: Date.now(), rev: (doc.rev || 1) + 1,
      }));
      await loadAll(); renderLibrary(); toast('已更新');
    });
  }

  // 文件选择
  $('#filePicker').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !currentPart) return;
    const part = currentPart;
    const rec = RECORD_TARGET ? RECORD_TARGET.uuid : null;
    RECORD_TARGET = null;                 // 用完即清，免得下一批文件也挂上去
    let ok = 0;
    for (const f of files) {
      try { await uploadFile(f, part, rec); ok++; }
      catch (err) { toast(`${f.name} 导入失败：${err.message}`); }
    }
    e.target.value = '';
    await loadAll(); renderTree(); renderLibrary(); refresh3DCounts();
    if (ok) toast(`已导入 ${ok} 个文件`);
  });

  // PT100 换算器
  $('#btnTools').addEventListener('click', openPt100);
  $('#pt100Close').addEventListener('click', () => $('#pt100Mask').classList.add('hidden'));
  $('#pt100Mask').addEventListener('click', (e) => {
    if (e.target.id === 'pt100Mask') $('#pt100Mask').classList.add('hidden');
  });
  // 两个框互为输入：改哪个就用哪个算，另一个只显示结果（不回填，免得互相打架）
  $('#pt100R').addEventListener('input', () => { $('#pt100T').value = ''; renderPt100(); });
  $('#pt100T').addEventListener('input', () => { $('#pt100R').value = ''; renderPt100(); });

  // 导出
  $('#btnExport').addEventListener('click', () => {
    window.location.href = '/api/export';
  });
  $('#btnExportPart').addEventListener('click', () => {
    if (currentPart) window.location.href = '/api/export?part=' + encodeURIComponent(currentPart);
  });

  // 部件选择器
  $('#pickerClose').addEventListener('click', () => $('#pickerMask').classList.add('hidden'));
  $('#pickerMask').addEventListener('click', (e) => {
    if (e.target.id === 'pickerMask') $('#pickerMask').classList.add('hidden');
  });
  $('#pickerFilter').addEventListener('input', renderPicker);
  $('#pickerList').addEventListener('click', (e) => {
    const row = e.target.closest('.picker-row');
    if (!row) return;
    $('#pickerMask').classList.add('hidden');
    selectPart(row.dataset.part, true);
  });

  // 搜索
  let searchTimer = null;
  $('#globalSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 220);
  });
  // 点进空搜索框 → 先给「最近搜索」，不用凭记忆重打一遍
  $('#globalSearch').addEventListener('focus', () => {
    if (!$('#globalSearch').value.trim()) {
      renderHistory();
      $('#searchMask').classList.remove('hidden');
    }
  });
  $('#globalSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      histPush($('#globalSearch').value);
      runSearch();
    }
  });
  $('#searchClose').addEventListener('click', () => $('#searchMask').classList.add('hidden'));
  $('#searchMask').addEventListener('click', (e) => {
    if (e.target.id === 'searchMask') $('#searchMask').classList.add('hidden');
  });
  $('#searchList').addEventListener('click', (e) => {
    if (e.target.id === 'histClear') { histClear(); renderHistory(); return; }
    const del = e.target.closest('.hist-del');
    if (del) { histRemove(+del.dataset.del); renderHistory(); return; }
    // 教材（整本行或命中页胶囊）：胶囊不在 .picker-row 里，所以先判它
    const bk = e.target.closest('[data-book]');
    if (bk) {
      $('#searchMask').classList.add('hidden');
      histPush($('#globalSearch').value);
      if (bk.dataset.bookpage) bookJumpTo = Number(bk.dataset.bookpage);
      openBooks(null, bk.dataset.bkw, bk.dataset.book);
      return;
    }
    const row = e.target.closest('.picker-row');
    if (!row) return;
    if (row.dataset.hi != null) {            // 点了历史里的一条：拿它再搜一遍
      $('#globalSearch').value = histRead()[+row.dataset.hi] || '';
      runSearch();
      return;
    }
    $('#searchMask').classList.add('hidden');
    if (row.dataset.part) {
      histPush($('#globalSearch').value);    // 真点了结果才算「用过这个词」，避免把半截前缀也记下来
      jumpTo(row.dataset.part, row.dataset.refi, row.dataset.uuid);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#pickerMask').classList.add('hidden');
      $('#searchMask').classList.add('hidden');
      $('#dlgMask').classList.add('hidden');
      if (!$('#bookMask').classList.contains('hidden')) closeBooks();
    }
  });

  // ---- 教材书库 ----
  $('#btnBooks').addEventListener('click', () => openBooks(null, ''));
  $('#bookClose').addEventListener('click', closeBooks);
  $('#bookMask').addEventListener('click', (e) => {
    if (e.target.id === 'bookMask') closeBooks();
  });
  // 换书：搜索词保留，在新书里继续搜；章节目录则回到第一章（由 openBooks 决定）
  $('#bookPick').addEventListener('change', (e) => {
    const kw = bookKw;
    bookOnlyConcept = false;
    openBooks(null, kw, e.target.value);
  });
  $('#btnBookPdf').addEventListener('click', () => openBookPdf(null));
  $('#btnBookOpenPdf').addEventListener('click', () => {
    const chap = bookCur && bookCur.chapters.find((c) => c.id === bookChap);
    openBookPdf(chap ? chap.startPage : null);
  });
  $('#bookFilter').addEventListener('input', () => {
    // 章节筛选框不搜正文——正文检索走顶栏那个搜索框，两边职责不重叠
    renderBook();
  });
  $('#btnBookMode').addEventListener('click', () => {
    bookOnlyConcept = !bookOnlyConcept;
    if (bookKw) renderBookSearch(); else renderBook();
  });
  $('#bookTree').addEventListener('click', (e) => {
    const sec = e.target.closest('.bk-sec');
    if (sec) {
      bookChap = sec.dataset.chap;
      bookKw = '';
      renderBook();
      // 滚到点的那个板块，而不是从章首重读
      const target = Array.from(document.querySelectorAll('#bookText .bk-pg'))
        .find((n) => n.textContent.trim() === 'p' + sec.dataset.pg);
      if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const chap = e.target.closest('.bk-chap');
    if (chap) {
      bookChap = chap.dataset.chap;
      bookKw = '';
      renderBook();
      $('#bookText').scrollTop = 0;
    }
  });
  // 正文里点：命中胶囊 → 滚到那一页；放大 → 图片全屏；看文字 → 展开 OCR；
  // PDF 原页 → 打开原件并跳到该页（「搜索直达 PDF 内容位置」的兜底通道）
  $('#bookText').addEventListener('click', (e) => {
    const zoom = e.target.closest('[data-imgzoom]');
    if (zoom) {
      const pg = Number(zoom.dataset.imgzoom);
      const hkw = zoom.dataset.hitkw || '';
      const hb = (bookCur && hkw) ? bookHitBoxes(bookCur.id, pg, hkw) : [];
      openImageZoom(pg, hb);
      return;
    }
    const fold = e.target.closest('[data-ocrfold]');
    if (fold) {
      const box = document.getElementById('bkocr-' + fold.dataset.ocrfold);
      if (box) {
        box.classList.toggle('hidden');
        fold.textContent = box.classList.contains('hidden') ? '看文字' : '收起文字';
      }
      return;
    }
    const pdf = e.target.closest('[data-pdf]');
    if (pdf) { openBookPdf(Number(pdf.dataset.pdf)); return; }
    const hit = e.target.closest('[data-hp]');
    if (hit) {
      const target = document.getElementById('bkpage-' + hit.dataset.hp);
      if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
}

/* 图片放大：盖一层可**真缩放**的看图器（图纸上的小字要能一直放大 + 拖动看）。
   操作：滚轮/双指缩放、拖动平移、双击复位，另有 ➖/➕/复位 按钮兜底。
   命中高亮：搜索进来时把命中处框在页图上，并支持「上一处/下一处」逐一看。 */
const IMGZOOM = { scale: 1, x: 0, y: 0, min: 1, max: 8, dragging: false,
                  lx: 0, ly: 0, pinch: 0,
                  hits: [], hitIdx: 0, hlEls: [], dims: null,
                  // 按「处」分组的框元素：groups[i] = 第 i 处命中的全部矩形。
                  // 一处在同一行内只有 1 个矩形，跨行时有 2 个。
                  // 「第N处」计数与「当前处」高亮都按它算，不按矩形算。
                  groups: [] };

/** 每次打开看图器时把 stage 定到「图片实际显示尺寸」。
    这样图片和高亮层都按百分比铺满 stage，两者永远严格对齐。 */
function imgLayoutStage() {
  const stage = document.getElementById('imgStage');
  const img = document.getElementById('imgBig');
  if (!stage || !img) return;
  const wrap = document.getElementById('imgWrap');
  if (!wrap) return;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  const aw = wrap.clientWidth, ah = wrap.clientHeight;
  if (!aw || !ah) return;
  const k = Math.min(aw / nw, ah / nh);      // 与旧版 max-width/height:100% 等价
  stage.style.width = (nw * k) + 'px';
  stage.style.height = (nh * k) + 'px';
}

function imgApply() {
  const stage = document.getElementById('imgStage');
  if (!stage) return;
  const z = IMGZOOM;
  stage.style.transform =
    `translate(-50%, -50%) translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
  stage.style.cursor = z.scale > 1 ? (z.dragging ? 'grabbing' : 'grab') : 'zoom-in';
  const ind = document.getElementById('imgScale');
  if (ind) ind.textContent = Math.round(z.scale * 100) + '%';
}

/** 以视口某点为中心缩放：保证手指/鼠标下的那块内容不跑掉。 */
function imgZoomAt(cx, cy, factor) {
  const z = IMGZOOM;
  const next = Math.min(z.max, Math.max(z.min, z.scale * factor));
  const k = next / z.scale;
  const stage = document.getElementById('imgStage');
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  const ox = cx - (r.left + r.width / 2);
  const oy = cy - (r.top + r.height / 2);
  z.x -= ox * (k - 1);
  z.y -= oy * (k - 1);
  z.scale = next;
  if (z.scale <= 1.001) { z.x = 0; z.y = 0; }   // 回到 1× 就居中
  imgApply();
}

function imgReset() {
  IMGZOOM.scale = 1; IMGZOOM.x = 0; IMGZOOM.y = 0;
  imgApply();
}

/* ---- 命中高亮 ---- */

/** 把某个高亮框滚到视口中间（配合放大，让用户一眼看到命中的那几个字）。 */
function imgFocusHit(idx) {
  const stage = document.getElementById('imgStage');
  const el = ((IMGZOOM.groups || [])[idx] || [])[0];
  if (!stage || !el) return;
  const img = document.getElementById('imgBig');
  const bw = stage.offsetWidth, bh = stage.offsetHeight;
  if (!bw || !bh) return;
  // 用百分比反推该框中心的像素位置（stage 内），再算需要平移多少让它居中
  const cxRel = (parseFloat(el.style.left) + parseFloat(el.style.width) / 2) / 100;
  const cyRel = (parseFloat(el.style.top) + parseFloat(el.style.height) / 2) / 100;
  const z = IMGZOOM;
  z.x = (0.5 - cxRel) * bw * z.scale;
  z.y = (0.5 - cyRel) * bh * z.scale;
  imgApply();
}

function imgShowHit(idx, scroll) {
  // ⚠️ 这里数的是**处**（groups），不是**矩形**（hlEls）。
  // 跨行的一处命中会拆成 2 个矩形，若按矩形计数会变成"两处"，
  // 而且只有其中一个变成「当前处」颜色 —— 看上去就是半个命中被高亮。
  const groups = IMGZOOM.groups || [];
  const n = groups.length;
  if (!n) return;
  IMGZOOM.hitIdx = ((idx % n) + n) % n;
  const curEls = groups[IMGZOOM.hitIdx];
  IMGZOOM.hlEls.forEach((el) => el.classList.toggle('cur', curEls.indexOf(el) >= 0));
  const lab = document.getElementById('imgHitNav');
  if (lab) lab.textContent = `命中第 ${IMGZOOM.hitIdx + 1} / ${n} 处`;
  const nav = document.getElementById('imgHitBar');
  if (nav) nav.classList.remove('hidden');
  if (scroll) imgFocusHit(IMGZOOM.hitIdx);
}

/** 在页图上画出命中框。hits 来自 pages.json 的 lineboxes，坐标是原图像素。 */
function imgRenderHits(hits, dim) {
  const hl = document.getElementById('imgHl');
  IMGZOOM.hits = hits || [];
  IMGZOOM.hitIdx = 0;
  IMGZOOM.hlEls = [];
  IMGZOOM.groups = [];
  if (hl) hl.innerHTML = '';
  const bar = document.getElementById('imgHitBar');
  if (bar) bar.classList.add('hidden');
  if (!hl || !IMGZOOM.hits.length) return;
  // 百分比一律按**索引声明的原图尺寸**算（不是 stage 的渲染尺寸）。
  // 这样框严格落在图内，也不受容器/缩略图宽度的影响——两处高亮共用同一口径。
  const bw = (dim && dim.w) || 0, bh = (dim && dim.h) || 0;
  if (!bw || !bh) return;

  IMGZOOM.hits.forEach((h, i) => {
    const el = document.createElement('i');
    const pad = Math.max(h.w * 0.02, 1.5);
    el.style.left = Math.max(0, (h.x - pad) / bw * 100) + '%';
    el.style.top = Math.max(0, (h.y - pad) / bh * 100) + '%';
    el.style.width = ((h.w + pad * 2) / bw * 100) + '%';
    el.style.height = ((h.h + pad * 2) / bh * 100) + '%';
    el.dataset.i = i;
    el.dataset.g = (h && h.g != null) ? h.g : i;
    hl.appendChild(el);
    IMGZOOM.hlEls.push(el);
    const g = (h && h.g != null) ? h.g : i;   // 老数据没有组号时按「一框一处」兜底
    (IMGZOOM.groups[g] || (IMGZOOM.groups[g] = [])).push(el);
  });
  if (IMGZOOM.groups.length) imgShowHit(0, true);
}

/** 页图放大时若图片较大，等它解码完再定位/绘画（拿得到 naturalWidth 才准）。 */

function openImageZoom(page, hits) {
  const src = bookImageSrc(Number(page));
  let mask = document.getElementById('imgMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'imgMask';
    mask.className = 'img-mask hidden';
    mask.innerHTML = `<div class="img-shell">
      <div class="img-head"><span id="imgTitle"></span>
        <span class="img-tools">
          <span id="imgHitBar" class="img-nav hidden">
            <span id="imgHitNav"></span>
            <button class="btn" id="imgHitPrev">上一处</button>
            <button class="btn" id="imgHitNext">下一处</button>
          </span>
          <span id="imgScale" class="img-scale">100%</span>
          <button class="btn" id="imgOut">➖</button>
          <button class="btn" id="imgIn">➕</button>
          <button class="btn" id="imgReset">复位</button>
          <button class="btn" id="imgClose">关闭</button>
        </span></div>
      <div class="img-wrap" id="imgWrap">
        <div class="img-stage" id="imgStage">
          <img id="imgBig" alt="">
          <div class="img-hl" id="imgHl"></div>
        </div>
      </div></div>`;
    document.body.appendChild(mask);

    const wrap = mask.querySelector('.img-wrap');
    const imgEl = mask.querySelector('#imgBig');
    // 图片解码完再定 stage 尺寸（stage 尺寸必须等于图片显示尺寸）
    imgEl.addEventListener('load', () => {
      imgLayoutStage();
      imgApply();
      const st = document.getElementById('imgStage');
      if (st && st.offsetWidth) imgRenderHits(IMGZOOM.hits, IMGZOOM.dims);
    });
    window.addEventListener('resize', () => {
      if (mask.classList.contains('hidden')) return;
      imgLayoutStage();
      imgApply();
      imgRenderHits(IMGZOOM.hits, IMGZOOM.dims);
    });

    // 滚轮缩放（以鼠标位置为中心）
    wrap.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      imgZoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    // 拖动平移（鼠标 + 单指）；点在按钮上不算拖动
    wrap.addEventListener('pointerdown', (ev) => {
      if (IMGZOOM.scale <= 1) return;
      if (ev.target.closest && ev.target.closest('.btn')) return;
      IMGZOOM.dragging = true; IMGZOOM.lx = ev.clientX; IMGZOOM.ly = ev.clientY;
      wrap.setPointerCapture(ev.pointerId);
      imgApply();
    });
    wrap.addEventListener('pointermove', (ev) => {
      if (!IMGZOOM.dragging) return;
      IMGZOOM.x += ev.clientX - IMGZOOM.lx;
      IMGZOOM.y += ev.clientY - IMGZOOM.ly;
      IMGZOOM.lx = ev.clientX; IMGZOOM.ly = ev.clientY;
      imgApply();
    });
    const stopDrag = (ev) => {
      if (!IMGZOOM.dragging) return;
      IMGZOOM.dragging = false;
      runCatchingPointer(wrap, ev);
      imgApply();
    };
    wrap.addEventListener('pointerup', stopDrag);
    wrap.addEventListener('pointercancel', stopDrag);

    // 双指捏合（触屏电脑/平板）
    wrap.addEventListener('touchmove', (ev) => {
      if (ev.touches.length !== 2) return;
      ev.preventDefault();
      const [a, b] = ev.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      if (IMGZOOM.pinch > 0) imgZoomAt(cx, cy, d / IMGZOOM.pinch);
      IMGZOOM.pinch = d;
    }, { passive: false });
    wrap.addEventListener('touchend', () => { IMGZOOM.pinch = 0; });

    // 双击复位
    wrap.addEventListener('dblclick', (ev) => { ev.preventDefault(); imgReset(); });

    mask.addEventListener('click', (ev) => {
      const id = ev.target.id;
      if (id === 'imgClose' || ev.target === mask) { mask.classList.add('hidden'); return; }
      if (id === 'imgIn') { imgZoomAt(innerWidth / 2, innerHeight / 2, 1.25); return; }
      if (id === 'imgOut') { imgZoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.25); return; }
      if (id === 'imgReset') { imgReset(); if ((IMGZOOM.groups || []).length) imgShowHit(IMGZOOM.hitIdx, true); return; }
      if (id === 'imgHitPrev') { imgShowHit(IMGZOOM.hitIdx - 1, true); return; }
      if (id === 'imgHitNext') { imgShowHit(IMGZOOM.hitIdx + 1, true); return; }
      // 点图片：没放大时放大，已放大则不动（避免误触打断看图）
      if (ev.target.id === 'imgBig' && IMGZOOM.scale <= 1) {
        imgZoomAt(ev.clientX, ev.clientY, 2);
      }
    });
  }
  document.getElementById('imgTitle').textContent = `第 ${page} 页`;
  const img = document.getElementById('imgBig');
  IMGZOOM.hits = hits || [];
  // 高亮百分比按索引声明的原图尺寸算（与缩略图同一口径）。
  // 注意：缩略图那条 `.book-text .bk-img { width:100% }` 也会命中这里的 img，
  // 把它的固有宽度压掉——所以尺寸**不能**从 img 上量，只认索引里的 w/h。
  const pg = (BOOKPAGES[bookCur && bookCur.id] || [])
    .find((x) => Number(x.i) === Number(page));
  IMGZOOM.dims = (pg && pg.lineboxes) ? { w: pg.lineboxes.w, h: pg.lineboxes.h } : null;
  img.src = encodeURI(src);
  imgReset();
  // stage 尺寸要等图片解码后才有意义（要用 naturalWidth）。
  // 上面挂的 load 监听负责这一步；图片已在缓存里时 load 不一定再触发，这里兜一次。
  if (img.complete && img.naturalWidth) {
    imgLayoutStage(); imgApply(); imgRenderHits(IMGZOOM.hits, IMGZOOM.dims);
  }
  mask.classList.remove('hidden');
}

/** pointer capture 释放可能抛错（元素已移除等），吞掉即可。 */
function runCatchingPointer(el, ev) {
  try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
}

/* ---------------------------------------------------------- 部件选择器 */
function openPicker() {
  $('#pickerMask').classList.remove('hidden');
  $('#pickerFilter').value = '';
  renderPicker();
  $('#pickerFilter').focus();
}
function renderPicker() {
  const kw = $('#pickerFilter').value.trim().toLowerCase();
  const groups = PARTS.filter((p) => p.level === 1);
  const kids = PARTS.filter((p) => p.level === 2);
  let html = '';
  let n = 0;
  for (const g of groups) {
    const list = kids.filter((k) => k.parent_id === g.id)
      .filter((k) => !kw || k.name.toLowerCase().includes(kw) || k.id.toLowerCase().includes(kw));
    if (!list.length) continue;
    html += `<div class="picker-group">${g.id} ${esc(g.name)}</div>`;
    for (const k of list) {
      const c = activeDocs(k.id).length;
      html += `<div class="picker-row" data-part="${k.id}">
        <span class="id">${k.id}</span><span class="nm">${esc(k.name)}</span>
        ${c ? `<span class="badge">${c}</span>` : ''}</div>`;
      const cat = CATALOG[k.id];
      if (cat) {
        const bits = [];
        if (cat.meshes && cat.meshes.length) bits.push('组件 ' + cat.meshes.length);
        if (cat.materials && cat.materials.length) bits.push('小部件/物料 ' + cat.materials.length);
        if (cat.torque && cat.torque.length) bits.push('力矩连接 ' + cat.torque.length);
        if (bits.length) html += `<div class="picker-sub">${bits.join(' · ')}</div>`;
      }
      n++;
    }
  }
  $('#pickerSub').textContent = `共 ${n} 个二级系统 · 点一下镜头飞过去`;
  $('#pickerList').innerHTML = html;
}

/* ---------------------------------------------------------- 搜索 */

// 最近搜过的关键词。存在浏览器本地，换设备各存各的——它只是"我刚才找过什么"，
// 不是资料，没必要跟同步扯上关系。
const HIST_KEY = 'gw_search_history';
function histRead() {
  try {
    const a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch (e) { return []; }
}
function histPush(kw) {
  kw = (kw || '').trim();
  if (!kw) return;
  const h = histRead().filter((x) => x !== kw);
  h.unshift(kw);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 12))); } catch (e) { /* 隐私模式下写不了，忽略 */ }
}
function histRemove(i) {
  const h = histRead(); h.splice(i, 1);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { }
}
function histClear() {
  try { localStorage.removeItem(HIST_KEY); } catch (e) { }
}

/** 空查询时显示最近搜索，点一条直接再搜一遍 */
function renderHistory() {
  const h = histRead();
  $('#searchTitle').textContent = '最近搜索';
  $('#searchSub').textContent = h.length ? `${h.length} 条` : '';
  if (!h.length) {
    $('#searchList').innerHTML = `<div class="empty">
      <p>输入关键词开始搜索</p>
      <p class="muted">出厂参考与你自己录的资料会一起搜，搜过的关键词会留在这里</p></div>`;
    return;
  }
  let html = `<div class="picker-group"><span>最近搜索</span>
              <span id="histClear" class="hist-clear">清空</span></div>`;
  h.forEach((k, i) => {
    html += `<div class="picker-row hist" data-hi="${i}">
      <span class="nm">${esc(k)}</span>
      <span class="hist-del" data-del="${i}" title="从历史里删掉">×</span></div>`;
  });
  $('#searchList').innerHTML = html;
}

/**
 * 精确搜索没结果时，找「大概是这个」的内容。
 *
 * 为什么不做「字形混淆表」：我试过从教材 OCR 结果里统计错字，
 * 得到的候选全是「所示、能够、如图」这类**完全正常的词**——
 * 凭那种表去猜近似，只会满屏乱推荐，比不推荐更烦人。
 * 所以这里不猜字，改用**你自己库里的文本**做证据：
 * 把关键词和候选文本都切成相邻两字（二元组），比重合度。
 * OCR 把「振动」认成「报动」时，前后文的二元组仍然大量重合，能捞回来。
 *
 * 两条纪律：
 *   · 只在**精确搜不到**时启用，绝不混进精确结果；
 *   · 结果区**明确标注是近似**，让主人知道「这不是你说的那个词」。
 */
function bigrams(s) {
  const t = String(s || '').replace(/[\s，。、：；！？（）()【】《》"'·,.:;!?]/g, '');
  const out = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** 二元组重合度（Jaccard），0~1。1 = 完全同一批相邻字对。 */
function bigramScore(a, b) {
  const A = new Set(bigrams(a)), B = new Set(bigrams(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function fuzzySearch(kw, limit) {
  const q = flatText(kw).toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  // 卡片（label / value / note）
  for (const [pid, list] of Object.entries(REFS.byPart)) {
    list.forEach((r, i) => {
      const hay = `${r.label || ''} ${r.value || ''} ${r.note || ''}`;
      const sc = bigramScore(q, hay);
      if (sc >= 0.28) out.push({ kind: 'ref', pid, r, i, sc, text: hay });
    });
  }
  // 我的资料 / 维修记录
  for (const d of DOCS) {
    if (d.deletedAt) continue;
    const hay = `${d.title || ''} ${d.textContent || ''} ${d.note || ''} ${d.origName || ''}`;
    const sc = bigramScore(q, hay);
    if (sc >= 0.28) out.push({ kind: 'doc', d, sc, text: hay });
  }
  out.sort((a, b) => b.sc - a.sc);
  return out.slice(0, limit || 12);
}

/** 精确搜不到时的那一块：说清楚「没找到」，再给「大概是」 */
function renderFuzzy(kw) {
  const hits = fuzzySearch(kw, 12);
  if (!hits.length) {
    return `<div class="empty"><p>没有找到「${esc(kw)}」</p>
      <p class="muted">换个说法试试：只打关键词（例如「偏航」而不是整句）；
      教材是扫描件，个别字可能被识别错，可以少打一个字再试</p></div>`;
  }
  let html = `<div class="fuzzy-hint">精确匹配没有结果。下面是<b>近似</b>内容
    ——可能相关，也可能不相关，请自己判断：</div>`;
  for (const h of hits) {
    const pct = Math.round(h.sc * 100);
    if (h.kind === 'ref') {
      html += `<div class="picker-row fuzzy" data-part="${esc(h.pid)}" data-refi="${h.i}">
        <span class="badge">≈${pct}%</span>
        <span class="nm">${esc(h.r.label || '')}
          <span class="muted">${esc(String(h.r.value || '').slice(0, 70))}</span></span></div>`;
    } else {
      const d = h.d;
      html += `<div class="picker-row fuzzy" data-part="${esc(d.partId)}" data-uuid="${esc(d.uuid)}">
        <span class="badge">≈${pct}%</span>
        <span class="nm">${esc(d.title)}
          <span class="muted">${hitSnippet(h.text, kw)}</span></span></div>`;
    }
  }
  return html;
}

async function runSearch() {
  const kw = $('#globalSearch').value.trim();
  // 清空输入框时回到「最近搜索」，而不是把面板关掉——关掉的话用户想找回刚才那个词就没入口了
  if (!kw) { renderHistory(); $('#searchMask').classList.remove('hidden'); return; }
  $('#searchTitle').textContent = '搜索结果';
  const q = kw.toLowerCase();

  // 出厂参考（在客户端过滤，数据量小）
  const refHits = [];
  for (const [pid, list] of Object.entries(REFS.byPart)) {
    list.forEach((r, i) => {
      if ((r.label || '').toLowerCase().includes(q)
        || (r.value || '').toLowerCase().includes(q)
        || (r.note || '').toLowerCase().includes(q)) {
        refHits.push({ pid, r, i });    // i = 该条在本部件 refs 里的下标，用于跳转定位
      }
    });
  }
  const docHits = DOCS.filter((d) => !d.deletedAt && (
    (d.title || '').toLowerCase().includes(q)
    || (d.textContent || '').toLowerCase().includes(q)
    || (d.note || '').toLowerCase().includes(q)
    || (d.origName || '').toLowerCase().includes(q)));

  // 部件名 / 编号也纳入：现场人记的是「那个轮毂」「C13」，不是某条卡片
  const partHits = PARTS.filter((p) =>
    (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q))
    .slice(0, 10);

  // 教材：正文合计 27 万字，首次检索时后台载入两本书的逐页索引（各约 350KB，本地读很快），
  // 载入后直接在搜索面板里给出「命中 N 页」，不再只丢一个「点开检索」的入口
  // —— 之前那样用户搜不到内容会以为是没搜到。
  const bookHits = BOOKS.map((b) => ({ book: b }));

  let html = '';
  if (bookHits.length) {
    html += `<div class="picker-group">教材 ${bookHits.length} 本</div>`;
    for (const h of bookHits) {
      const bh = BOOKHITS[h.book.id];
      if (bh && bh.kw === q) {
        // 索引已就绪：给出页数 + 命中页前 6 个，点一下直达那一页
        html += `<div class="picker-row" data-book="${h.book.id}" data-bkw="${esc(kw)}">
          <span class="badge">📖 教材</span>
          <span class="nm">${highlight(h.book.title, kw)}
            <span class="muted">${bh.pages.length} 页命中 · 点开看原页</span></span></div>`;
        if (bh.pages.length) {
          html += '<div class="pick-sub">' + bh.pages.slice(0, 6).map(
            (p) => `<span class="bk-jump" data-book="${h.book.id}" data-bkw="${esc(kw)}"
              data-bookpage="${p.i}">p${p.i}</span>`).join('')
            + (bh.pages.length > 6
               ? `<span class="muted"> 等 ${bh.pages.length} 页</span>` : '')
            + '</div>';
        }
      } else {
        html += `<div class="picker-row" data-book="${h.book.id}" data-bkw="${esc(kw)}">
          <span class="badge">📖 教材</span>
          <span class="nm">${highlight(h.book.title, kw)}
            <span class="muted">${h.book.totalPages} 页 · 正在检索…</span></span></div>`;
      }
    }
  }
  if (partHits.length) {
    html += `<div class="picker-group">部件 ${partHits.length} 个</div>`;
    for (const p of partHits) {
      html += `<div class="picker-row" data-part="${p.id}">
        <span class="id">${p.id}</span><span class="nm">${highlight(p.name, kw)}</span>
        ${p.level === 1 ? '<span class="badge">一级系统</span>' : ''}</div>`;
    }
  }
  if (refHits.length) {
    html += `<div class="picker-group">出厂参考 ${refHits.length} 条</div>`;
    for (const h of refHits.slice(0, 60)) {
      html += `<div class="picker-row" data-part="${h.pid}" data-refi="${h.i}">
        <span class="badge">${h.pid} ${esc(partName(h.pid))}</span>
        <span class="nm">${highlight(h.r.label, kw)} · <b>${highlight(h.r.value, kw)}</b>
          ${h.r.note ? '<span class="muted">' + highlight(h.r.note, kw) + '</span>' : ''}</span></div>`;
    }
  }
  if (docHits.length) {
    html += `<div class="picker-group">我的资料 ${docHits.length} 条</div>`;
    for (const d of docHits.slice(0, 60)) {
      const body = d.kind === 'LINK' ? d.textContent : (d.textContent || d.origName || '');
      html += `<div class="picker-row" data-part="${d.partId}" data-uuid="${d.uuid}">
        <span class="badge">${d.partId} ${esc(partName(d.partId))}</span>
        <span class="nm">${highlight(d.title, kw)}
          ${body ? '<span class="muted">' + hitSnippet(String(body), kw) + '</span>' : ''}</span></div>`;
    }
  }
  const bookHitCount = BOOKS.reduce((n, b) => {
    const bh = BOOKHITS[b.id];
    return n + (bh && bh.kw === q ? bh.pages.length : 0);
  }, 0);
  const exactTotal = partHits.length + refHits.length + docHits.length + bookHitCount;
  if (exactTotal === 0) {
    // 精确零命中：明确说没找到 + 给近似。**不把近似混进精确结果里**冒充命中。
    $('#searchList').innerHTML = renderFuzzy(kw);
    $('#searchSub').textContent = '精确匹配 0 条 · 下面是近似内容';
    $('#searchMask').classList.remove('hidden');
    return;                              // 不触发教材索引补画（搜不到就是不搜了）
  }
  $('#searchSub').textContent =
    `部件 ${partHits.length} · 出厂参考 ${refHits.length} 条 · 我的资料 ${docHits.length} 条`
    + (bookHits.length ? ` · 教材 ${bookHits.length} 本` : '');
  $('#searchList').innerHTML = html || '<div class="empty"><p>没有匹配的内容</p></div>';
  $('#searchMask').classList.remove('hidden');
  // 后台把两本书的索引拉起来，补上「命中 N 页」；只补这一次，失败就算了。
  // 守卫：runSearch → ensureBookHits → runSearch 是回环，补一次就不再递归。
  if (!ensureBookHits._busy) ensureBookHits(q, kw);
}

/** 载入书页索引并在搜索面板里补出「命中 N 页」+ 命中页快捷入口。 */
async function ensureBookHits(q, kw) {
  if (!BOOKS.length || ensureBookHits._busy) return;
  // 归一化一次就缓存到页对象上。之前每次搜索都对 509 页重跑正则，
  // 首次搜索要算两遍（自己一遍 + 补画后的 runSearch 再一遍），界面会卡住。
  const scan = (pages) => {
    for (const p of pages) {
      if (p._flat === undefined) p._flat = flatText(p.text).toLowerCase();
    }
    return pages.filter((p) => p._flat.includes(q));
  };
  // 索引已就绪且已算过这个词 → 直接收工，不再触发一次重画
  if (BOOKPAGES[BOOKS[0].id] && BOOKHITS[BOOKS[0].id]
      && BOOKHITS[BOOKS[0].id].kw === q) return;
  ensureBookHits._busy = true;
  try {
    for (const b of BOOKS) {
      if (!BOOKPAGES[b.id]) await loadBookPages(b.id);
      BOOKHITS[b.id] = { kw: q, pages: scan(BOOKPAGES[b.id] || []) };
    }
  } catch (e) {
    ensureBookHits._busy = false;
    return;                             // 索引拿不到就保持「点开检索」的旧样子
  }
  ensureBookHits._busy = false;
  // 只有用户还停在这个词上时才重画，避免他改词后结果被顶掉
  if ($('#globalSearch').value.trim().toLowerCase() === q
      && !$('#searchMask').classList.contains('hidden')) {
    runSearch();
  }
}

/* ---------------------------------------------------------- 教材书库
   整本教材单独成库：不进三维模型、不属于任何一个部件，但和部件资料共用同一个搜索框。
   数据分两层载入——索引（章节/板块/页码）开机就拉，正文（284 页文字）等真正点进书库才拉。
*/

/**
 * OCR 文本归一化 —— **教材能不能搜到的关键**。
 *
 * Windows OCR 对中文是**逐字**输出的（"液 压 系 统"），而这里是连续子串匹配，
 * 所以用户输入正常写法的「液压系统」命中 0 页（实测：20 个常用词原样命中全是 0，
 * 去空格后能命中 1517 页）。因此匹配前必须把汉字之间的空格抹掉。
 * 只抹「汉字↔汉字」「数字↔汉字」之间的空格，英文单词内部的空格保留。
 */
function flatText(t) {
  return String(t || '')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff0-9])/g, '')
    .replace(/(?<=[0-9])\s+(?=[\u4e00-\u9fff])/g, '');
}

/* 命中定位：把关键词映射回 OCR 的词框，得到「在页面图上的位置」。

   坑（必须按这个做法）：OCR 的中文是逐字带空格的（「液 压 系 统」），
   而检索用的是去掉空格后的连续串。**归一化文本的下标不能拿去索引原文**，
   否则命中处会错行。

   数据格式（pages.json 的 lineboxes，为省体积压过）：
     每行 = [行文字, x, y, w, h, 词表]
     每词 = "x,y,w,h,n"，n 是该词的字数——词文本不存，靠 n 从行文字里切回来。

   为什么按**整页**拼流再找、而不是逐行找：关键词会被换行切开
   （「偏航」在行尾、「系统」在下一行行首），逐行搜会漏掉这些命中。
   实测「偏航系统」28 个命中页里有 2 页正是这种情况。 */
function _nospace(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

function bookHitBoxes(bookId, pageNo, kwRaw) {
  const pages = BOOKPAGES[bookId];
  if (!pages) return [];
  const p = pages.find((x) => Number(x.i) === Number(pageNo));
  if (!p || !p.lineboxes || !p.lineboxes.lines) return [];
  const kw = _nospace(flatText(String(kwRaw || ''))).toLowerCase();
  if (!kw) return [];

  // 1) 把整页的行文字按字数切回各词，拼成一条流；
  //    同时记下每个字符归属的框**和它属于哪一行**（跨行命中要按行拆框）
  let stream = '';
  const chars = [];
  const charLine = [];
  let li = -1;
  for (const L of p.lineboxes.lines) {
    li++;
    const parts = L[5];
    if (!parts || !parts.length) continue;
    const flat = _nospace(flatText(L[0])).toLowerCase();
    let seek = 0;
    for (let k = 0; k < parts.length; k++) {
      const c = parts[k].split(',');
      const box = { x: Number(c[0]), y: Number(c[1]), w: Number(c[2]), h: Number(c[3]) };
      const n = Number(c[4]);
      const last = (k === parts.length - 1);
      const piece = last ? flat.slice(seek) : flat.slice(seek, seek + n);
      if (!last) seek = Math.min(flat.length, seek + n);
      for (let i = 0; i < piece.length; i++) { chars.push(box); charLine.push(li); }
      stream += piece;
    }
  }
  if (!stream) return [];

  // 2) 在整页流里找关键词，**按行拆成矩形**再输出。
  //
  // ⚠️ 这里原先是把命中覆盖到的所有字符框并成**一个外接矩形**。
  // 关键词被换行切开时（行末「…风力发电」+ 行首「机组中…」），外接矩形必然
  // 从上一行行尾横跨到下一行行首 → 变成一条 800+px 的大黄条，盖住几十个无关的字。
  // 实测（2026-10-03）：2169 个框里有 46 个是这种跨行大框，最宽 876px，
  // 而该页字框才 22px 高 —— 屏幕上看就是整两行被涂黄。
  // 现在**每行一个矩形**；同一处命中的所有矩形打同一个组号 g，
  // 好让「第N处」的计数和「当前处」的高亮仍按**处**算而不是按矩形算。
  const out = [];
  let from = 0;
  let occ = 0;
  while (true) {
    const at = stream.indexOf(kw, from);
    if (at < 0) break;
    const end = Math.min(at + kw.length, chars.length);
    const spans = [];                       // 每行一个 [行号, x0, y0, x1, y1]
    for (let i = at; i < end; i++) {
      const b = chars[i];
      if (!b) continue;
      const gl = charLine[i];
      let sp = spans.length ? spans[spans.length - 1] : null;
      if (!sp || sp[0] !== gl) { sp = [gl, Infinity, Infinity, -Infinity, -Infinity]; spans.push(sp); }
      if (b.x < sp[1]) sp[1] = b.x;
      if (b.y < sp[2]) sp[2] = b.y;
      if (b.x + b.w > sp[3]) sp[3] = b.x + b.w;
      if (b.y + b.h > sp[4]) sp[4] = b.y + b.h;
    }
    const txt = stream.slice(at, end);
    for (const sp of spans) {
      if (isFinite(sp[1])) {
        out.push({ x: sp[1], y: sp[2], w: sp[3] - sp[1], h: sp[4] - sp[2], t: txt, g: occ });
      }
    }
    occ++;
    from = at + 1;
    if (occ >= 60) break;   // 一页命中过多时不再逐处显示，避免糊成一片
  }
  return out;
}

const SEC_CLASS = { '格物致知': 's-gw', '知行合一': 's-zx', '学以致用': 's-xz' };
const SEC_HEAD_CLASS = { '格物致知': '', '知行合一': 'op', '学以致用': 'ex' };

/** 载入某本书的逐页正文（284 页约 14 万字，只在真正用到时拉一次）。 */
async function loadBookPages(id) {
  if (BOOKPAGES[id]) return BOOKPAGES[id];
  const d = await fetch(`books/${id}/pages.json`).then((r) => r.json());
  BOOKPAGES[id] = d.pages || [];
  return BOOKPAGES[id];
}

/** 书架下拉框：有多本书时才显示。 */
function fillBookPick() {
  const sel = $('#bookPick');
  sel.innerHTML = BOOKS.map(
    (b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('');
  sel.style.display = BOOKS.length > 1 ? '' : 'none';
  if (bookCur) sel.value = bookCur.id;
}

async function openBooks(chapId, kw, bookId) {
  if (!BOOKS.length) { toast('书库数据未就绪'); return; }
  $('#bookMask').classList.remove('hidden');
  fillBookPick();

  // 换书：保留搜索词则在新书里继续搜，否则回到章节目录第一项
  const want = bookId || (bookCur ? bookCur.id : BOOKS[0].id);
  const target = BOOKS.find((b) => b.id === want) || BOOKS[0];
  if (!bookCur || bookCur.id !== target.id) {
    bookCur = target;
    // 换书后必须落到「第一章」，不能留 empty。
    // 章节树是**折叠式**的：只有 bookChap 命中的那一章才会展开二级节点，
    // 置 null 会让树看起来是空的（踩过）。
    bookChap = chapId || (bookCur.chapters[0] && bookCur.chapters[0].id) || null;
    $('#bookPick').value = bookCur.id;
    $('#bookText').innerHTML = '<div class="empty"><p>正在载入教材正文…</p></div>';
    try {
      await loadBookPages(bookCur.id);
    } catch (e) {
      BOOKPAGES[bookCur.id] = [];
      toast('教材正文载入失败：' + e.message);
    }
  } else if (!BOOKPAGES[bookCur.id]) {
    try { await loadBookPages(bookCur.id); } catch (e) { BOOKPAGES[bookCur.id] = []; }
  }
  bookKw = kw || '';
  if (chapId) bookChap = chapId;
  if (bookKw) renderBookSearch();       // 搜索进来：先给命中清单
  else renderBook();
}

/** 书库里「页码」用 OCR 序，和 PDF 的页号一一对应（第 1 页 = PDF 第 1 页）。 */
function bookPages() { return BOOKPAGES[bookCur.id] || []; }
function bookPagesOf(chap) {
  const all = bookPages();
  return all.filter((p) => p.i >= chap.startPage && p.i <= chap.endPage);
}

function renderBook() {
  if (!bookCur) return;
  const b = bookCur;
  const isConcept = b.chapterMode !== 'tasks';   // 只有初级书有「概念/操作/练习」三分
  // 「只看概念」只对初级书有意义；中级书是故障处理任务，把它藏起来免得点了没反应
  $('#btnBookMode').style.display = isConcept ? '' : 'none';
  if (!isConcept) { bookOnlyConcept = false; $('#btnBookMode').classList.remove('active'); }
  $('#bookTitle').textContent = b.title;
  const sub = isConcept
    ? `${b.subtitle || ''} · 全 ${b.totalPages} 页 · 共 ${b.chapters.length} 个项目 · PDF ${b.pdfSizeMB} MB`
    : `${b.subtitle || ''} · 全 ${b.totalPages} 页 · 共 ${b.chapters.length} 个项目` +
      ` · ${b.chapters.reduce((a, c) => a + c.sections.length, 0)} 个任务 · PDF ${b.pdfSizeMB} MB`;
  $('#bookSub').textContent = sub;
  $('#btnBookMode').textContent = bookOnlyConcept ? '看全部内容' : '只看概念';
  $('#btnBookMode').classList.toggle('active', bookOnlyConcept);

  // ---- 左：章节树（两级：项目 → 任务 / 板块）----
  const kw = $('#bookFilter').value.trim();
  let nav = '';
  for (const c of b.chapters) {
    const open = bookChap === c.id || !!kw;
    nav += `<div class="bk-chap ${open ? 'open' : ''}" data-chap="${c.id}">
      <span class="id">${c.id}</span><span class="nm">${esc(c.name)}</span>
      <span class="cnt">${c.pageCount}p</span></div>`;
    if (!open) continue;
    for (const s of c.sections) {
      // 「只看概念」时把操作/练习两个板块从目录里隐掉，正文也随之收窄
      if (bookOnlyConcept && s.name !== '格物致知') continue;
      const cls = isConcept ? (SEC_CLASS[s.name] || '') : 's-task';
      const label = s.desc ? `${s.name} ${s.desc}` : s.name;
      nav += `<div class="bk-sec ${cls}" data-chap="${c.id}"
        data-pg="${s.startPage}" data-sec="${esc(s.name)}">
        <span class="dot"></span><span>${esc(label)}</span>
        <span class="pg">p${s.startPage}${s.endPage > s.startPage ? '-' + s.endPage : ''}</span></div>`;
    }
  }
  $('#bookTree').innerHTML = nav || '<div class="empty"><p>没有匹配的章节</p></div>';

  // ---- 右：正文 ----
  const chap = b.chapters.find((c) => c.id === bookChap) || b.chapters[0];
  bookChap = chap.id;
  $('#bookCrumb').textContent = `${chap.id} ${chap.name} · p${chap.startPage}-${chap.endPage}`;
  $('#bookText').innerHTML = renderChapter(chap);
}

/**
 * 正文以「原页图片」为主。
 *
 * 为什么不用 OCR 文字当正文：这两本教材是纯扫描件，OCR 会漏字、错字
 * （「西门子」→「西 n 子」、「振动」→「报动」），拿它当正文必然缺内容。
 * 图片是原书本身，一个字不缺；OCR 文字退居其次，只做**搜索索引**用，
 * 并折叠在每页图片下方，需要时展开对照。
 */
function renderChapter(chap) {
  const list = bookPagesOf(chap);
  if (!list.length) return '<div class="empty"><p>这一章没有可读的内容</p></div>';
  let html = '';
  let lastSec = null;
  for (const p of list) {
    // 「只看概念」：非概念页整页跳过。这一步必须在打板块标题之前，
    // 否则标题已经打出去了、内容却没了，会看到一排空标题（踩过）。
    if (bookOnlyConcept && p.section !== '格物致知') continue;
    // 板块标题：每进一个新板块打一条分隔，读的时候知道自己在概念篇还是操作篇
    if (p.section && p.section !== lastSec) {
      html += `<div class="bk-sechd ${SEC_HEAD_CLASS[p.section] || ''}">${esc(p.section)}</div>`;
      lastSec = p.section;
    }
    html += renderPageImage(p);
  }
  return html || '<div class="empty"><p>这一章没有概念类内容</p></div>';
}

/** 一页 = 原页图片 + 页码浮标 + 可折叠的 OCR 文字。 */
function renderPageImage(p, kw) {
  const src = bookImageSrc(p.i);
  // 命中页在缩略图上也直接框出位置（不用点开放大就能看到「在哪」）；
  // data-hitkw 交给放大视图用同一套坐标画大图。
  const hits = kw ? bookHitBoxes(bookCur.id, p.i, kw) : [];
  let hl = '';
  if (hits.length) {
    const bw = (p.lineboxes && p.lineboxes.w) || 1;
    const bh = (p.lineboxes && p.lineboxes.h) || 1;
    hl = '<div class="bk-hl">' + hits.map((h) => {
      const pad = Math.max(h.w * 0.02, 1.5);
      return `<i style="left:${((h.x - pad) / bw * 100).toFixed(3)}%;` +
        `top:${((h.y - pad) / bh * 100).toFixed(3)}%;` +
        `width:${((h.w + pad * 2) / bw * 100).toFixed(3)}%;` +
        `height:${((h.h + pad * 2) / bh * 100).toFixed(3)}%"></i>`;
    }).join('') + '</div>';
  }
  return `<div class="bk-page" data-pg="${p.i}" id="bkpage-${p.i}">
    <div class="bk-imgwrap">
      <img class="bk-img" src="${encodeURI(src)}" alt="第 ${p.i} 页"
           loading="lazy" data-pg="${p.i}">
      ${hl}
    </div>
    <div class="bk-pgbar">
      <span class="bk-pg">第 ${p.i} 页</span>
      ${hits.length ? `<span class="bk-hitn">命中 ${hits.length} 处</span>` : ''}
      <span class="bk-spacer"></span>
      <button class="bk-mini" data-imgzoom="${p.i}" data-hitkw="${esc(kw || '')}">放大</button>
      <button class="bk-mini" data-ocrfold="${p.i}">看文字</button>
      <button class="bk-mini bk-mini-pdf" data-pdf="${p.i}">PDF 原页</button>
    </div>
    <div class="bk-ocr hidden" id="bkocr-${p.i}">${paragraphize(p.text || '', kw || '')}</div>
  </div>`;
}

/** 图片路径：books/<bookId>/pages/pNNN.jpg（图片是书库的阅读主体）。 */
function bookImageSrc(i) {
  if (!bookCur) return '';
  return `books/${bookCur.id}/pages/p${String(i).padStart(3, '0')}.jpg`;
}

/** 把 OCR 的整页文字切成段落；kw 非空时高亮命中处。 */
function paragraphize(text, kw) {
  if (!text) return '';
  const paras = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return paras.map((s) => `<p>${highlight(s, kw)}</p>`).join('');
}

/**
 * 书内搜索：命中哪几页 → **直接铺那一页的原图**（这就是「搜索直达 PDF 原内容位置」）。
 *
 * 命中页的 OCR 文字里含关键词的那几行单独列在图片下方并高亮，
 * 便于快速定位；但内容以图为准——OCR 漏掉的字在图上一个都不少。
 */
function renderBookSearch() {
  const b = bookCur;
  const q = bookKw.toLowerCase();
  const isConcept = b.chapterMode !== 'tasks';
  const hits = [];
  for (const c of b.chapters) {
    for (const p of bookPagesOf(c)) {
      if (bookOnlyConcept && isConcept && p.section !== '格物致知') continue;
      if (flatText(p.text).toLowerCase().includes(q)) hits.push({ chap: c, p });
    }
  }
  $('#bookPick').value = b.id;
  $('#bookTitle').textContent = `${b.title}`;
  $('#bookSub').textContent = `检索「${bookKw}」· ${hits.length} 页命中 · 显示原页图片（OCR 可能漏字，以图为准）`;
  $('#bookCrumb').textContent = hits.length ? `共 ${hits.length} 页含「${bookKw}」` : `没有找到「${bookKw}」`;
  $('#bookTree').innerHTML = '<div class="empty"><p>点「关闭检索」回到章节目录</p></div>';
  if (!hits.length) {
    $('#bookText').innerHTML = `<div class="empty"><p>OCR 文字里没有找到「${esc(bookKw)}」</p>
      <p class="muted">扫描件的字可能有识别误差（比如「振动」被认成「报动」）。<br>
      换个词试试，或关掉「只看概念」再搜；也可以直接翻 PDF 原件用阅读器搜。</p></div>`;
    return;
  }
  let bar = '<div class="book-hits" id="bookHits">';
  hits.forEach((h) => {
    bar += `<span class="bk-hit" data-hp="${h.p.i}">${h.chap.id} p${h.p.i}</span>`;
  });
  bar += '</div>';
  // 命中页按顺序铺开：先原页图片，再列出该页含关键词的文字行
  let html = bar;
  let lastSec = null;
  for (const h of hits) {
    if (isConcept && h.p.section && h.p.section !== lastSec) {
      html += `<div class="bk-sechd ${SEC_HEAD_CLASS[h.p.section] || ''}">${h.chap.id} ${esc(h.chap.name)} · ${esc(h.p.section)}</div>`;
      lastSec = h.p.section;
    }
    html += renderPageImage(h.p, bookKw);
    // 命中行摘要：贴在图片下方，方便一眼看到命中的是哪句
    const lines = String(h.p.text || '').split(/\n+/).map((s) => s.trim())
      .filter((s) => s && flatText(s).toLowerCase().includes(q));
    if (lines.length) {
      html += `<div class="bk-hitlines">${lines.slice(0, 6).map(
        (s) => `<p>${highlight(s, bookKw)}</p>`).join('')}</div>`;
    }
  }
  $('#bookText').innerHTML = html;
  // 从全局搜索点「p123」进来：渲染完直接滚到那一页
  if (bookJumpTo != null) {
    const t = document.getElementById('bkpage-' + bookJumpTo);
    bookJumpTo = null;
    if (t) t.scrollIntoView({ block: 'start' });
  }
}

/**
 * 在 PDF 原件里打开并跳到指定页。
 *
 * 「搜索直达 PDF 内容位置」：搜索结果点一下就能翻到原书那一页，
 * 用系统/浏览器的阅读器看，绕开 OCR 的漏字问题。
 *
 * 跳到指定页靠 #page=N 片段。主流浏览器（Chrome/Edge/Firefox 新版）都认，
 * 个别阅读器忽略它只会停在第一页——所以书库里**同时保留了原页图片**，
 * 不依赖 PDF 阅读器也能看到原内容。
 */
function openBookPdf(page) {
  if (!bookCur || !bookCur.pdf) { toast('这本书没有 PDF 原件'); return; }
  const url = bookCur.pdf + (page ? `#page=${page}` : '');
  window.open(encodeURI(url), '_blank');
}

function closeBooks() {
  $('#bookMask').classList.add('hidden');
  bookKw = '';
  bookOnlyConcept = false;
  $('#btnBookMode').classList.remove('active');
  if (bookCur) renderBook();
}

/* ---------------------------------------------------------- 启动 */
(async function boot() {
  bind();
  try {
    await loadAll();
    renderTree();
    refresh3DCounts();
  } catch (e) {
    $('#serverInfo').textContent = '服务未连接';
    toast('读取数据失败：' + e.message);
  }
  // 三维就绪后同步一次角标
  $('#view3d').addEventListener('load', () => setTimeout(refresh3DCounts, 1200));
})();
