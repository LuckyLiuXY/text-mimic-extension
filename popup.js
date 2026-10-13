// 弹窗逻辑：文字填充 + 小说阅读两个模式

const statusEl = document.getElementById("status");

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}

// ---------- 标签页切换 ----------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("tab-fill").hidden = btn.dataset.tab !== "fill";
    document.getElementById("tab-novel").hidden = btn.dataset.tab !== "novel";
    setStatus("");
  });
});

// ---------- 通用：向当前标签页注入脚本并发消息 ----------

async function sendToPage(scriptFile, message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("找不到当前标签页");
  const url = tab.url || "";
  if (
    /^(chrome|edge|about|chrome-extension|devtools|view-source|file):/.test(url) ||
    /^(https?:\/\/)?(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com)/.test(url)
  ) {
    throw new Error("此页面受浏览器保护，无法注入。请在普通网站页面上使用");
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [scriptFile]
    });
  } catch (e) {
    throw new Error("无法访问此页面：" + (e.message || "") + "。可尝试刷新页面后重试");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

// ---------- 通用：按真实编码读取文本文件（UTF-8 优先，失败回退 GB18030） ----------

function readTextAuto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result);
      let text;
      try {
        // fatal 模式下一遇到非法 UTF-8 字节就抛错，据此判断真实编码
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder("gb18030").decode(buf);
      }
      resolve(text.replace(/^\uFEFF/, ""));
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsArrayBuffer(file);
  });
}

// ---------- 文字填充模式 ----------

const textInput = document.getElementById("textInput");
const fileInput = document.getElementById("fileInput");
const charCount = document.getElementById("charCount");
const loopFill = document.getElementById("loopFill");
const skipShort = document.getElementById("skipShort");
const fillBtn = document.getElementById("fillBtn");
const restoreBtn = document.getElementById("restoreBtn");

function updateCount() {
  charCount.textContent = textInput.value.length + " 字";
}

chrome.storage.local.get(["mimicText", "loopFill", "skipShort"], (data) => {
  if (typeof data.mimicText === "string") textInput.value = data.mimicText;
  if (typeof data.loopFill === "boolean") loopFill.checked = data.loopFill;
  if (typeof data.skipShort === "boolean") skipShort.checked = data.skipShort;
  updateCount();
});

textInput.addEventListener("input", () => {
  updateCount();
  chrome.storage.local.set({ mimicText: textInput.value });
});

loopFill.addEventListener("change", () => chrome.storage.local.set({ loopFill: loopFill.checked }));
skipShort.addEventListener("change", () => chrome.storage.local.set({ skipShort: skipShort.checked }));

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  readTextAuto(file)
    .then((text) => {
      textInput.value = text;
      updateCount();
      chrome.storage.local.set({ mimicText: textInput.value });
      setStatus("已载入文件：" + file.name, "ok");
    })
    .catch((e) => setStatus(e.message, "err"));
  fileInput.value = "";
});

fillBtn.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) {
    setStatus("请先粘贴或上传文本内容", "err");
    return;
  }
  fillBtn.disabled = true;
  setStatus("正在填充…");
  try {
    const res = await sendToPage("content.js", {
      type: "mimic:fill",
      text: textInput.value,
      loop: loopFill.checked,
      skipShort: skipShort.checked
    });
    if (res && res.ok) {
      setStatus(`已替换 ${res.replaced} 处文本节点，版式保持不变`, "ok");
    } else {
      setStatus((res && res.error) || "填充失败", "err");
    }
  } catch (e) {
    setStatus(e.message || "填充失败", "err");
  } finally {
    fillBtn.disabled = false;
  }
});

restoreBtn.addEventListener("click", async () => {
  restoreBtn.disabled = true;
  setStatus("正在还原…");
  try {
    const res = await sendToPage("content.js", { type: "mimic:restore" });
    if (res && res.ok) {
      setStatus(res.restored > 0 ? `已还原 ${res.restored} 处文本` : "页面没有被替换过，或已刷新自动还原", "ok");
    } else {
      setStatus((res && res.error) || "还原失败", "err");
    }
  } catch (e) {
    setStatus(e.message || "还原失败", "err");
  } finally {
    restoreBtn.disabled = false;
  }
});

// ---------- 小说阅读模式 ----------

const novelInput = document.getElementById("novelInput");
const novelInfo = document.getElementById("novelInfo");
const novelCount = document.getElementById("novelCount");
const openReaderBtn = document.getElementById("openReaderBtn");
const clearNovelBtn = document.getElementById("clearNovelBtn");

// 按常见网文章节规律切分目录。
// 支持两套标题体系：第X章/卷/回/节 与 Chapter N（A 类），以及 起点系"数字、标题"（B 类）；
// 楔子/序章/番外作为补充。两候选集取匹配多的一套为主，避免正文中编号列表造成误判。
function parseChapters(text) {
  const HEAD_A = /^[ \t]*(第[零〇一二三四五六七八九十百千万两\d]+[章回卷节部篇][^\n]{0,40}|Chapter\s+\d+[^\n]{0,40})[ \t]*$/gim;
  const HEAD_NUM = /^[ \t]*(\d{1,4})、[^\n]{0,40}[ \t]*$/gm;
  const HEAD_EXTRA = /^[ \t]*(楔子[^\n]{0,30}|序[章言幕曲][^\n]{0,30}|番外[^\n]{0,30})[ \t]*$/gim;

  const collect = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push({ title: m[0].trim(), start: m.index });
    return out;
  };

  const aHeads = collect(HEAD_A);

  // B 类序号过滤：首个序号不超过 10，之后每个都比上一章大且跳跃不超过 30，
  // 以此接受缺章、滤掉正文里重新起头的编号列表
  const numHeads = [];
  let prevNum = 0;
  for (const m of text.matchAll(HEAD_NUM)) {
    const n = parseInt(m[1], 10);
    if (numHeads.length === 0) {
      if (n <= 10) {
        numHeads.push({ title: m[0].trim(), start: m.index });
        prevNum = n;
      }
    } else if (n > prevNum && n - prevNum <= 30) {
      numHeads.push({ title: m[0].trim(), start: m.index });
      prevNum = n;
    }
  }

  // B 类需形成至少 5 章的连续链条才参与竞争，防止短篇正文里的编号列表篡位
  const main = numHeads.length >= 5 && numHeads.length > aHeads.length ? numHeads : aHeads;
  // 合并补充标题（楔子/序章/番外），同位置去重后按偏移排序
  const byStart = new Map();
  for (const h of main.concat(collect(HEAD_EXTRA))) {
    if (!byStart.has(h.start)) byStart.set(h.start, h);
  }
  const heads = [...byStart.values()].sort((x, y) => x.start - y.start);

  if (heads.length === 0) {
    return [{ title: "全文", start: 0, end: text.length }];
  }
  // 第一个章节标题之前的内容作为"前言"
  if (heads[0].start > 200) {
    heads.unshift({ title: "前言", start: 0 });
  }
  const chapters = [];
  for (let i = 0; i < heads.length; i++) {
    chapters.push({
      title: heads[i].title,
      start: heads[i].start,
      end: i + 1 < heads.length ? heads[i + 1].start : text.length
    });
  }
  return chapters;
}

function renderNovelInfo(novel, progress) {
  if (!novel || !novel.count) {
    novelInfo.className = "novel-info empty";
    novelInfo.textContent = "尚未载入小说";
    novelCount.textContent = "";
    return;
  }
  novelInfo.className = "novel-info";
  let progressHtml = "";
  if (progress && progress.name === novel.name && typeof progress.chapter === "number") {
    const pct = Math.round(((progress.chapter + 1) / novel.count) * 100);
    progressHtml = `<br><span class="progress">上次读到：${escapeHtml(novel.titles[progress.chapter] || "")}（${pct}%）</span>`;
  }
  novelInfo.innerHTML =
    `<span class="name">${escapeHtml(novel.name)}</span><br>` +
    `共 ${novel.count} 章 · ${novel.totalChars.toLocaleString()} 字` + progressHtml;
  novelCount.textContent = (novel.totalChars / 10000).toFixed(1) + " 万字";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// 初始化时展示已保存的小说信息；清理旧版整本存储格式（需重新上传）
chrome.storage.local.get(["novelMeta", "novelProgress", "novel"], (data) => {
  if (data.novel) chrome.storage.local.remove("novel");
  renderNovelInfo(data.novelMeta, data.novelProgress);
});

// 小说按章分存：novelMeta 存目录元数据，nov_<i> 存每章正文。
// 弹窗/阅读器打开时只需读元数据和当前一章，大书也能秒开。
const NOVEL_KEY = /^nov_\d+$/;

novelInput.addEventListener("change", async () => {
  const file = novelInput.files[0];
  if (!file) return;
  novelInput.value = "";
  setStatus("正在解析小说…");
  try {
    const raw = await readTextAuto(file);
    const text = raw.replace(/\r\n?/g, "\n");
    if (!text.trim()) {
      setStatus("文件内容为空", "err");
      return;
    }
    const chapters = parseChapters(text);
    const meta = {
      name: file.name.replace(/\.(txt|text)$/i, ""),
      totalChars: text.length,
      count: chapters.length,
      titles: chapters.map((c) => c.title)
    };

    // 清掉上一本书的分章数据，避免残留
    const keys = await chrome.storage.local.getKeys();
    const stale = keys.filter((k) => NOVEL_KEY.test(k) || k === "novel");
    if (stale.length) await chrome.storage.local.remove(stale);

    // 分批写入章节正文，每批 100 章并汇报进度
    const BATCH = 100;
    for (let s = 0; s < chapters.length; s += BATCH) {
      const entries = {};
      const end = Math.min(s + BATCH, chapters.length);
      for (let i = s; i < end; i++) {
        entries["nov_" + i] = text.slice(chapters[i].start, chapters[i].end);
      }
      await chrome.storage.local.set(entries);
      setStatus(`正在保存 ${Math.round((end / chapters.length) * 100)}%…`);
    }
    await chrome.storage.local.set({ novelMeta: meta });

    const data = await chrome.storage.local.get(["novelProgress"]);
    renderNovelInfo(meta, data.novelProgress);
    setStatus(`已载入《${meta.name}》，识别出 ${meta.count} 章`, "ok");
  } catch (e) {
    setStatus("载入失败：" + (e.message || e), "err");
  }
});

openReaderBtn.addEventListener("click", async () => {
  openReaderBtn.disabled = true;
  setStatus("正在打开阅读器…");
  try {
    const res = await sendToPage("reader.js", { type: "reader:open" });
    if (res && res.ok) {
      setStatus(res.empty ? "还没有上传小说，请先选择 .txt 文件" : "阅读器已打开，按 ` 键可隐藏", res.empty ? "err" : "ok");
    } else {
      setStatus((res && res.error) || "打开失败", "err");
    }
  } catch (e) {
    setStatus(e.message || "打开失败", "err");
  } finally {
    openReaderBtn.disabled = false;
  }
});

clearNovelBtn.addEventListener("click", () => {
  chrome.storage.local.getKeys((keys) => {
    const targets = keys.filter(
      (k) => NOVEL_KEY.test(k) || k === "novel" || k === "novelMeta" || k === "novelProgress"
    );
    chrome.storage.local.remove(targets, () => {
      renderNovelInfo(null, null);
      setStatus("已移除小说和阅读进度", "ok");
    });
  });
});

// ---------- 老板键自定义 ----------

const bossKeyInput = document.getElementById("bossKeyInput");
const DEFAULT_BOSS_KEY = { code: "Backquote", ctrl: false, alt: false, shift: false, label: "`" };

function bossKeyLabel(b) {
  const parts = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(b.label);
  return parts.join("+");
}

chrome.storage.local.get(["bossKey"], (data) => {
  const b = data.bossKey && data.bossKey.code ? data.bossKey : DEFAULT_BOSS_KEY;
  bossKeyInput.value = bossKeyLabel(b);
});

// 点击进入录入状态，按下的下一个键（含组合键）即保存为新老板键
bossKeyInput.addEventListener("focus", () => {
  bossKeyInput.classList.add("capturing");
  bossKeyInput.value = "请按键…";
});

bossKeyInput.addEventListener("blur", () => {
  bossKeyInput.classList.remove("capturing");
  chrome.storage.local.get(["bossKey"], (data) => {
    const b = data.bossKey && data.bossKey.code ? data.bossKey : DEFAULT_BOSS_KEY;
    bossKeyInput.value = bossKeyLabel(b);
  });
});

bossKeyInput.addEventListener("keydown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  // 单独按修饰键时继续等待，直到按下真正的键
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  // 避免与弹窗自身操作冲突：裸 Escape 仅用于取消录入
  if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    bossKeyInput.blur();
    return;
  }
  let keyLabel = e.key;
  if (keyLabel === " ") keyLabel = "Space";
  if (keyLabel.length === 1 && /[a-z]/i.test(keyLabel)) keyLabel = keyLabel.toUpperCase();
  const binding = {
    code: e.code,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    label: keyLabel
  };
  chrome.storage.local.set({ bossKey: binding }, () => {
    bossKeyInput.value = bossKeyLabel(binding);
    bossKeyInput.blur();
    setStatus("老板键已改为：" + bossKeyLabel(binding), "ok");
  });
});
