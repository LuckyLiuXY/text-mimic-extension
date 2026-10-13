// 小说阅读器：在当前页面挂载 Shadow DOM 悬浮窗，从 chrome.storage 读取小说。
// 功能：目录跳转、上一章/下一章、字号调节、拖拽移动、进度记忆、老板键一键隐藏（可在弹窗自定义）。

(function () {
  if (window.__novelReader && window.__novelReader.ready) return;
  window.__novelReader = { ready: true };

  const HOST_ID = "__novel_reader_host__";
  const FONT_KEY = "novelFontSize";
  const POS_KEY = "novelProgress";

  let host = null; // 挂载节点（关闭时从 DOM 移除，状态保留在闭包）
  let shadow = null;
  let els = {};
  let meta = null; // 目录元数据：{name, count, titles, totalChars}
  let cur = 0;
  let fontSize = 16;
  let saveTimer = null;
  // 老板键绑定（默认 ` 键），可在扩展弹窗中修改
  const DEFAULT_BOSS_KEY = { code: "Backquote", ctrl: false, alt: false, shift: false, label: "`" };
  let bossKey = DEFAULT_BOSS_KEY;

  // 伪装相关状态：固定菜单栏、融入模式、窗口几何记忆
  const WIN_KEY = "novelWin";
  let pinned = false;
  let blend = false;
  let minTimer = null;

  // 内嵌模式：小说正文作为真实 <p> 节点插入页面 DOM，完全继承页面样式
  const INLINE_KEY = "novelInline";
  const INLINE_SEL_KEY = "novelInlineSel";
  const INLINE_ID = "__novel_inline__";
  let inlineOn = false;
  let inlineEl = null;
  let pickCleanup = null; // 选点模式清理函数
  let allHidden = false; // 老板键的全局隐藏态

  function bossKeyLabel(b) {
    const parts = [];
    if (b.ctrl) parts.push("Ctrl");
    if (b.alt) parts.push("Alt");
    if (b.shift) parts.push("Shift");
    parts.push(b.label);
    return parts.join("+");
  }

  function applyBossKey(b) {
    bossKey = b && b.code ? b : DEFAULT_BOSS_KEY;
    // 同步隐藏按钮的悬停提示
    if (els.wrap) {
      const btn = els.wrap.querySelector('[data-act="hide"]');
      if (btn) btn.title = `隐藏（${bossKeyLabel(bossKey)} 恢复）`;
    }
  }

  function isBossKey(e) {
    return (
      e.code === bossKey.code &&
      e.ctrlKey === !!bossKey.ctrl &&
      e.altKey === !!bossKey.alt &&
      e.shiftKey === !!bossKey.shift
    );
  }
  // 章节正文内存缓存：同一页面关掉重开、来回翻章都直接命中，不再读存储
  const chapterCache = new Map();

  async function loadChapterText(i) {
    if (chapterCache.has(i)) return chapterCache.get(i);
    const key = "nov_" + i;
    const data = await chrome.storage.local.get(key);
    const text = data[key] || "";
    chapterCache.set(i, text);
    return text;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .wrap {
      position: fixed; top: 56px; right: 36px;
      width: 720px; max-width: 94vw; height: 80vh;
      background: #fdfdfb; border: 1px solid #d4d7dc;
      border-radius: 8px; box-shadow: 0 14px 44px rgba(0,0,0,.22);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      color: #26262a; z-index: 2147483647;
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 0 10px; height: 38px; flex: none;
      background: #f3f4f6; border-bottom: 1px solid #e2e4e8;
      cursor: move; user-select: none;
    }
    .title {
      flex: 1; font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .hbtn {
      flex: none; min-width: 26px; height: 24px; padding: 0 6px;
      border: 1px solid #d4d7dc; border-radius: 5px;
      background: #fff; color: #4e5563; font-size: 12px;
      cursor: pointer; line-height: 1;
    }
    .hbtn:hover { background: #eceef1; }
    .body { flex: 1; display: flex; min-height: 0; }
    .toc {
      width: 190px; flex: none; overflow-y: auto;
      border-right: 1px solid #ececef; background: #fafafa;
      display: none;
    }
    .toc.open { display: block; }
    .toc-item {
      padding: 7px 10px; font-size: 12px; color: #4e5563;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      cursor: pointer; border-left: 2px solid transparent;
    }
    .toc-item:hover { background: #f0f1f3; }
    .toc-item.active {
      color: #1664d9; background: #eef4fd; border-left-color: #1664d9;
    }
    .content {
      flex: 1; overflow-y: auto; padding: 22px 30px 40px;
      line-height: 1.9; letter-spacing: 0.02em;
    }
    .content h2 {
      font-size: 1.15em; margin-bottom: 18px; color: #1f2329;
    }
    .content p { margin-bottom: 1em; text-indent: 2em; }
    .nav {
      display: flex; justify-content: space-between; margin-top: 26px;
    }
    .nav button {
      padding: 6px 18px; border: 1px solid #d4d7dc; border-radius: 6px;
      background: #fff; color: #4e5563; font-size: 13px; cursor: pointer;
    }
    .nav button:hover:not(:disabled) { background: #f0f1f3; }
    .nav button:disabled { opacity: .4; cursor: not-allowed; }
    .foot {
      flex: none; height: 26px; display: flex; align-items: center;
      justify-content: space-between; padding: 0 12px;
      background: #f3f4f6; border-top: 1px solid #e2e4e8;
      font-size: 11px; color: #8a8f99;
    }
    .empty { padding: 40px; font-size: 13px; color: #8a8f99; }

    /* 菜单栏自动最小化：鼠标离开后收成一条细缝 */
    .head { transition: height .18s ease, opacity .18s ease; }
    .wrap.min .head { height: 8px; padding: 0; opacity: .22; }
    .wrap.min .head > * { display: none; }

    /* 固定按钮高亮态 */
    .hbtn.active { background: #dce7f8; border-color: #1664d9; color: #1664d9; }

    /* 右下角缩放手柄 */
    .resize {
      position: absolute; right: 0; bottom: 0;
      width: 16px; height: 16px; cursor: nwse-resize; opacity: .4;
    }
    .resize::before {
      content: ''; position: absolute; right: 3px; bottom: 3px;
      width: 8px; height: 8px;
      border-right: 2px solid #8a8f99; border-bottom: 2px solid #8a8f99;
    }

    /* 融入模式：采样页面配色，去掉窗口感，文字即段落 */
    .wrap.blend {
      background: var(--page-bg, #fff);
      border-color: transparent;
      box-shadow: none;
    }
    .wrap.blend .head { background: transparent; border-bottom-color: transparent; }
    .wrap.blend .foot { display: none; }
    .wrap.blend .toc { background: transparent; border-right-color: transparent; }
    .wrap.blend .toc-item { color: var(--page-fg, #4e5563); }
    .wrap.blend .content {
      color: var(--page-fg, #26262a);
      font-family: var(--page-font, inherit);
    }
    .wrap.blend .content h2 { color: var(--page-fg, #1f2329); }
    .wrap.blend .resize { opacity: .12; }
    .wrap.blend.min .head { opacity: .08; }
  `;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function buildUI() {
    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="head">
        <span class="title"></span>
        <button class="hbtn" data-act="toc" title="目录">☰</button>
        <button class="hbtn" data-act="font-" title="缩小字号">A-</button>
        <button class="hbtn" data-act="font+" title="放大字号">A+</button>
        <button class="hbtn" data-act="blend" title="融入模式：跟随页面配色，伪装成页面段落">融</button>
        <button class="hbtn" data-act="inline" title="内嵌模式：把正文插进页面段落中，点击页面选择位置">嵌</button>
        <button class="hbtn" data-act="pin" title="固定菜单栏；取消后鼠标离开自动最小化">钉</button>
        <button class="hbtn" data-act="hide" title="隐藏（\` 键恢复）">—</button>
        <button class="hbtn" data-act="close" title="关闭">×</button>
      </div>
      <div class="body">
        <div class="toc"></div>
        <div class="content"></div>
      </div>
      <div class="foot">
        <span class="chap-pos"></span>
        <span class="chap-pct"></span>
      </div>
      <div class="resize" title="拖拽调整大小"></div>
    `;
    shadow.appendChild(wrap);

    els = {
      wrap,
      title: wrap.querySelector(".title"),
      toc: wrap.querySelector(".toc"),
      content: wrap.querySelector(".content"),
      chapPos: wrap.querySelector(".chap-pos"),
      chapPct: wrap.querySelector(".chap-pct")
    };

    // 头部按钮
    wrap.querySelector(".head").addEventListener("click", (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "toc") els.toc.classList.toggle("open");
      if (act === "font-") setFont(fontSize - 1);
      if (act === "font+") setFont(fontSize + 1);
      if (act === "blend") toggleBlend();
      if (act === "inline") toggleInline();
      if (act === "pin") togglePin();
      if (act === "hide") hidePanel();
      if (act === "close") closeReader();
    });

    // 拖拽移动窗口
    const head = wrap.querySelector(".head");
    head.addEventListener("mousedown", (e) => {
      if (e.target.dataset && e.target.dataset.act) return; // 点按钮不触发拖拽
      const rect = wrap.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      function onMove(ev) {
        const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 80);
        const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
        wrap.style.left = x + "px";
        wrap.style.top = y + "px";
        wrap.style.right = "auto";
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        saveWin();
      }
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      e.preventDefault();
    });

    // 右下角缩放手柄
    wrap.querySelector(".resize").addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = wrap.getBoundingClientRect();
      function onMove(ev) {
        const w = Math.min(Math.max(280, rect.width + ev.clientX - startX), window.innerWidth * 0.95);
        const h = Math.min(Math.max(160, rect.height + ev.clientY - startY), window.innerHeight * 0.92);
        wrap.style.width = w + "px";
        wrap.style.height = h + "px";
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        saveWin();
      }
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });

    // 菜单栏自动最小化：悬停展开并取消计时，离开后 1.5 秒收起
    wrap.addEventListener("mouseenter", () => {
      clearTimeout(minTimer);
      setMinimized(false);
    });
    wrap.addEventListener("mouseleave", scheduleMin);

    // 滚动时防抖保存进度
    els.content.addEventListener("scroll", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveProgress, 600);
    });

    document.documentElement.appendChild(host);

    // 反映持久化状态：固定按钮高亮、融入模式、窗口几何
    updatePinUI();
    if (blend) applyBlend();
    restoreWin();
  }

  // ---------- 伪装：自动最小化 / 固定 / 融入模式 / 几何记忆 ----------

  function setMinimized(min) {
    if (els.wrap) els.wrap.classList.toggle("min", min);
  }

  function scheduleMin() {
    if (pinned) return;
    clearTimeout(minTimer);
    minTimer = setTimeout(() => setMinimized(true), 1500);
  }

  function togglePin() {
    pinned = !pinned;
    chrome.storage.local.set({ novelPin: pinned });
    updatePinUI();
    if (pinned) {
      clearTimeout(minTimer);
      setMinimized(false);
    } else {
      scheduleMin();
    }
  }

  function updatePinUI() {
    const btn = els.wrap && els.wrap.querySelector('[data-act="pin"]');
    if (btn) btn.classList.toggle("active", pinned);
  }

  function toggleBlend() {
    blend = !blend;
    chrome.storage.local.set({ novelBlend: blend });
    applyBlend();
  }

  // 采样页面 body 的字体与配色，让容器和文字看起来像原生段落
  function applyBlend() {
    if (blend) {
      const cs = window.getComputedStyle(document.body);
      let bg = cs.backgroundColor;
      // 页面背景透明时兜底白色，避免文字浮在杂乱内容上
      if (!bg || bg === "transparent" || /rgba?\([^)]*,\s*0\s*\)$/.test(bg)) bg = "#ffffff";
      els.wrap.style.setProperty("--page-bg", bg);
      els.wrap.style.setProperty("--page-fg", cs.color || "#26262a");
      els.wrap.style.setProperty("--page-font", cs.fontFamily || "inherit");
      // 融入模式下顺带把菜单收起来
      if (!pinned) setMinimized(true);
    }
    els.wrap.classList.toggle("blend", blend);
    const btn = els.wrap.querySelector('[data-act="blend"]');
    if (btn) btn.classList.toggle("active", blend);
  }

  // 记录/恢复窗口位置与尺寸
  function saveWin() {
    if (!els.wrap) return;
    const r = els.wrap.getBoundingClientRect();
    chrome.storage.local.set({
      [WIN_KEY]: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    });
  }

  async function restoreWin() {
    const data = await chrome.storage.local.get([WIN_KEY]);
    const win = data[WIN_KEY];
    if (!win || !els.wrap) return;
    // 防止旧分辨率下保存的位置跑出屏幕
    const w = Math.min(Math.max(280, win.w || 720), window.innerWidth * 0.95);
    const h = Math.min(Math.max(160, win.h || 400), window.innerHeight * 0.92);
    const x = Math.min(Math.max(0, win.x || 0), window.innerWidth - 80);
    const y = Math.min(Math.max(0, win.y || 0), window.innerHeight - 40);
    els.wrap.style.width = w + "px";
    els.wrap.style.height = h + "px";
    els.wrap.style.left = x + "px";
    els.wrap.style.top = y + "px";
    els.wrap.style.right = "auto";
  }

  function setFont(size) {
    fontSize = Math.min(24, Math.max(12, size));
    els.content.style.fontSize = fontSize + "px";
    chrome.storage.local.set({ [FONT_KEY]: fontSize });
  }

  function saveProgress() {
    if (!meta) return;
    chrome.storage.local.set({
      [POS_KEY]: { name: meta.name, chapter: cur, scroll: els.content.scrollTop }
    });
  }

  // 当前章节的标题与段落（去掉首行章节标题；兜底模式保留全文）
  function currentParas() {
    const raw = chapterCache.get(cur) || "";
    const title = meta.titles[cur];
    const isFallback = meta.count === 1 && title === "全文";
    const bodyText = isFallback ? raw : raw.replace(/^[ \t]*\S[^\n]*\n/, "");
    const paras = bodyText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return { title, isFallback, paras };
  }

  // 渲染当前章节正文与上下章导航
  function renderChapter(raw, scrollTo) {
    const { title, isFallback, paras } = currentParas();
    els.content.innerHTML =
      (isFallback ? "" : `<h2>${escapeHtml(title)}</h2>`) +
      paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
      `<div class="nav">
         <button data-nav="prev" ${cur === 0 ? "disabled" : ""}>上一章</button>
         <button data-nav="next" ${cur === meta.count - 1 ? "disabled" : ""}>下一章</button>
       </div>`;

    els.content.querySelector('[data-nav="prev"]').addEventListener("click", () => goto(cur - 1));
    els.content.querySelector('[data-nav="next"]').addEventListener("click", () => goto(cur + 1));

    els.content.scrollTop = typeof scrollTo === "number" ? scrollTo : 0;
    els.chapPos.textContent = `${cur + 1} / ${meta.count} 章`;
    els.chapPct.textContent = Math.round(((cur + 1) / meta.count) * 100) + "%";

    // 同步目录高亮
    els.toc.querySelectorAll(".toc-item").forEach((item, i) => {
      item.classList.toggle("active", i === cur);
    });
    const active = els.toc.querySelector(".toc-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function renderToc() {
    els.toc.innerHTML = meta.titles
      .map((t, i) => `<div class="toc-item" data-i="${i}" title="${escapeHtml(t)}">${escapeHtml(t)}</div>`)
      .join("");
    els.toc.addEventListener("click", (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i != null) goto(Number(i));
    });
  }

  async function goto(i, scrollTo) {
    if (!meta || i < 0 || i >= meta.count) return;
    cur = i;
    const text = await loadChapterText(i);
    renderChapter(text, typeof scrollTo === "number" ? scrollTo : 0);
    if (inlineOn) renderInline();
    syncMini();
    saveProgress();
    // 预取相邻章节，翻页几乎零等待
    if (i + 1 < meta.count) loadChapterText(i + 1);
    if (i - 1 >= 0) loadChapterText(i - 1);
  }

  // ---------- 内嵌模式：正文插进页面 DOM，样式完全由页面决定 ----------

  function updateInlineUI() {
    const btn = els.wrap && els.wrap.querySelector('[data-act="inline"]');
    if (btn) btn.classList.toggle("active", inlineOn);
  }

  // 用页面原生 <p> 节点渲染当前章，不加任何样式
  function renderInline() {
    if (!inlineEl) return;
    const { title, isFallback, paras } = currentParas();
    inlineEl.textContent = "";
    if (!isFallback) {
      const h = document.createElement("p");
      h.textContent = title;
      inlineEl.appendChild(h);
    }
    for (const p of paras) {
      const el = document.createElement("p");
      el.textContent = p;
      inlineEl.appendChild(el);
    }
  }

  function removeInline() {
    if (inlineEl && inlineEl.parentNode) inlineEl.parentNode.removeChild(inlineEl);
    inlineEl = null;
  }

  // 为插入点生成尽力而为的 CSS 选择器，供下次同站自动找回
  function cssPath(el) {
    // 个别环境没有 CSS.escape，退化为简单转义
    const esc = window.CSS && typeof CSS.escape === "function"
      ? CSS.escape
      : (s) => String(s).replace(/[^\w-]/g, "\\$&");
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + esc(node.id);
        parts.unshift(part);
        break;
      }
      const cls = [...node.classList].filter((c) => /^[\w-]+$/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      if (node.parentElement) {
        part += `:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(">");
  }

  function insertInlineAfter(target) {
    removeInline();
    inlineEl = document.createElement("div");
    inlineEl.id = INLINE_ID;
    if (target && target.parentNode) {
      target.after(inlineEl);
    } else {
      document.body.appendChild(inlineEl);
    }
    inlineOn = true;
    // 选择器保存失败不阻塞插入
    let sel = "";
    try {
      sel = cssPath(target);
    } catch {
      sel = "";
    }
    chrome.storage.local.set({ [INLINE_KEY]: true, [INLINE_SEL_KEY]: sel });
    renderInline();
    updateInlineUI();
    // 内嵌完成后：主面板收起，页面只留迷你控制条
    buildMini();
    hidePanel();
  }

  // 选点模式：悬停高亮候选元素，点击确定插入位置，Esc 取消
  function startPicker() {
    if (pickCleanup) pickCleanup();
    setMinimized(true);
    let last = null;
    let lastOutline = "";

    // 阅读器自身与已内嵌内容不参与选点（Shadow DOM 点击会重定向到 host）
    function isOurs(t) {
      return t === host || t === inlineEl || (inlineEl && inlineEl.contains(t));
    }
    function onMove(e) {
      if (isOurs(e.target)) return;
      if (last) last.style.outline = lastOutline;
      last = e.target;
      lastOutline = last.style.outline;
      last.style.outline = "2px dashed #1664d9";
    }
    function onClick(e) {
      if (isOurs(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      cleanup();
      insertInlineAfter(target);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    }
    function cleanup() {
      if (last) last.style.outline = lastOutline;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      pickCleanup = null;
    }
    pickCleanup = cleanup;

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
  }

  function toggleInline() {
    if (inlineOn) {
      inlineOn = false;
      removeInline();
      removeMini();
      chrome.storage.local.set({ [INLINE_KEY]: false });
      updateInlineUI();
      if (host) host.style.display = "";
    } else {
      startPicker();
    }
  }

  // 打开阅读器时按持久化的选择器自动找回插入点；找不到则等用户重新选点
  async function tryRestoreInline() {
    const data = await chrome.storage.local.get([INLINE_SEL_KEY]);
    let target = null;
    try {
      target = data[INLINE_SEL_KEY] ? document.querySelector(data[INLINE_SEL_KEY]) : null;
    } catch {
      target = null;
    }
    if (target) {
      insertInlineAfter(target);
    } else {
      inlineOn = false;
      chrome.storage.local.set({ [INLINE_KEY]: false });
    }
  }

  // 「—」按钮：只收起主面板，不影响内嵌文字与迷你条
  function hidePanel() {
    if (host) host.style.display = "none";
  }

  // 老板键：面板、内嵌文字、迷你条一起全隐/全显
  function hideAll() {
    allHidden = true;
    if (host) host.style.display = "none";
    if (inlineEl) inlineEl.style.display = "none";
    if (miniHost) miniHost.style.display = "none";
  }

  function showAll() {
    allHidden = false;
    if (host) host.style.display = "";
    if (inlineEl) inlineEl.style.display = "";
    if (miniHost) miniHost.style.display = "";
  }

  // ---------- 迷你控制条：内嵌模式下的翻章/目录入口，平时近乎隐形 ----------

  const MINI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .bar {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 3px;
      padding: 4px 6px; border-radius: 14px;
      background: rgba(30,32,36,.72); opacity: .26;
      transition: opacity .15s ease;
      font-family: "Microsoft YaHei", system-ui, sans-serif;
    }
    .bar:hover { opacity: .96; }
    .b {
      min-width: 22px; height: 22px; padding: 0 5px;
      border: none; border-radius: 8px;
      background: transparent; color: #e8eaee;
      font-size: 12px; cursor: pointer; line-height: 1;
    }
    .b:hover { background: rgba(255,255,255,.16); }
    .pos { color: #c8ccd4; font-size: 11px; padding: 0 2px; }
    .toc {
      position: fixed; right: 16px; bottom: 48px; z-index: 2147483647;
      width: 220px; max-height: 50vh; overflow-y: auto;
      background: rgba(28,30,34,.96); border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
      display: none; padding: 4px 0;
      font-family: "Microsoft YaHei", system-ui, sans-serif;
    }
    .toc.open { display: block; }
    .t {
      padding: 6px 12px; font-size: 12px; color: #d4d8de;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
    }
    .t:hover { background: rgba(255,255,255,.1); }
    .t.active { color: #7cb3ff; }
  `;

  let miniHost = null;
  let miniShadow = null;
  let miniEls = {};

  function buildMini() {
    if (miniHost) return;
    miniHost = document.createElement("div");
    miniHost.id = "__novel_mini__";
    miniShadow = miniHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = MINI_CSS;
    miniShadow.appendChild(style);

    const bar = document.createElement("div");
    bar.className = "bar";
    bar.innerHTML = `
      <button class="b" data-m="prev" title="上一章">‹</button>
      <span class="pos"></span>
      <button class="b" data-m="next" title="下一章">›</button>
      <button class="b" data-m="toc" title="目录">☰</button>
      <button class="b" data-m="panel" title="打开阅读面板">▣</button>
      <button class="b" data-m="exit" title="退出内嵌模式">×</button>
    `;
    const toc = document.createElement("div");
    toc.className = "toc";
    miniShadow.appendChild(toc);
    miniShadow.appendChild(bar);
    miniEls = { bar, toc, pos: bar.querySelector(".pos") };

    bar.addEventListener("click", (e) => {
      const m = e.target.dataset && e.target.dataset.m;
      if (!m) return;
      if (m === "prev") goto(cur - 1);
      if (m === "next") goto(cur + 1);
      if (m === "toc") {
        renderMiniToc();
        miniEls.toc.classList.toggle("open");
      }
      if (m === "panel") {
        miniEls.toc.classList.remove("open");
        if (host) host.style.display = "";
      }
      if (m === "exit") toggleInline();
    });

    document.documentElement.appendChild(miniHost);
    syncMini();
    bindMiniToc();
  }

  function removeMini() {
    if (miniHost && miniHost.parentNode) miniHost.parentNode.removeChild(miniHost);
    miniHost = null;
    miniShadow = null;
    miniEls = {};
  }

  // 同步迷你条的章节位置
  function syncMini() {
    if (miniEls.pos && meta) miniEls.pos.textContent = `${cur + 1}/${meta.count}`;
  }

  function renderMiniToc() {
    if (!miniEls.toc || !meta) return;
    miniEls.toc.innerHTML = meta.titles
      .map((t, i) => `<div class="t${i === cur ? " active" : ""}" data-i="${i}">${escapeHtml(t)}</div>`)
      .join("");
    const active = miniEls.toc.querySelector(".t.active");
    if (active) active.scrollIntoView({ block: "center" });
  }

  // 迷你条目录点击（事件委托，只绑定一次）
  function bindMiniToc() {
    miniEls.toc.addEventListener("click", (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i != null) {
        miniEls.toc.classList.remove("open");
        goto(Number(i));
      }
    });
  }

  function closeReader() {
    saveProgress();
    if (pickCleanup) pickCleanup();
    removeInline();
    removeMini();
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  async function open() {
    const data = await chrome.storage.local.get(["novelMeta", POS_KEY, FONT_KEY, "bossKey", "novelPin", "novelBlend", INLINE_KEY]);
    if (!data.novelMeta || !data.novelMeta.count) return { ok: true, empty: true };

    meta = data.novelMeta;
    pinned = !!data.novelPin;
    blend = !!data.novelBlend;
    inlineOn = !!data[INLINE_KEY];

    // 恢复上次的章节与滚动位置（按书名匹配）
    cur = 0;
    let scroll = 0;
    const pos = data[POS_KEY];
    if (pos && pos.name === meta.name && typeof pos.chapter === "number") {
      cur = Math.min(pos.chapter, meta.count - 1);
      scroll = pos.scroll || 0;
    }

    buildUI();
    els.title.textContent = meta.name;
    setFont(typeof data[FONT_KEY] === "number" ? data[FONT_KEY] : 16);
    applyBossKey(data.bossKey);
    renderToc();
    await goto(cur, scroll);
    updateInlineUI();
    // 内嵌模式开着的话，按记忆中的选择器找回插入点
    if (inlineOn) await tryRestoreInline();
    // 未固定时，打开后给几秒操作时间再自动收起菜单
    if (!pinned) {
      clearTimeout(minTimer);
      minTimer = setTimeout(() => setMinimized(true), 3000);
    }
    return { ok: true };
  }

  // 弹窗里修改老板键后实时生效，无需重开阅读器
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bossKey) applyBossKey(changes.bossKey.newValue);
  });

  // 老板键：一键全隐/全显
  window.addEventListener("keydown", (e) => {
    if (host && isBossKey(e)) {
      e.preventDefault();
      if (allHidden) showAll(); else hideAll();
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "reader:open") {
      // 已打开过则只恢复显示，避免重复加载丢失当前位置
      if (host && host.parentNode) {
        showAll();
        sendResponse({ ok: true });
        return true;
      }
      open().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // 异步响应
    }
  });
})();
