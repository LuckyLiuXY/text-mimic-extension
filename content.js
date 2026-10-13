// 内容脚本：收集页面可见文本节点，按原有长度用用户文本逐段替换，版式不变。
// 用 window.__textMimic 挂载状态，保证重复注入幂等。

(function () {
  if (window.__textMimic && window.__textMimic.ready) return;

  // 原始文本备份：Map<Text节点, 原始文本>
  const backup = new Map();

  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION|IFRAME|SVG|CANVAS|VIDEO|AUDIO|TEMPLATE)$/;

  // 判断元素是否在视口渲染树中可见
  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  // 收集 body 下所有可见、非空白的文本节点
  function collectTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el || SKIP_TAGS.test(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // 把用户文本切成句子片段（保留中英文句读符号），供逐段分配
  function splitSentences(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const parts = clean.match(/[^。！？!?.；;]+[。！？!?.；;]*\s*/g);
    return parts && parts.length ? parts : [clean];
  }

  // 按目标长度从句子流里取出一段文本；loop 为 true 时文本用完则循环
  function createFeeder(sentences, loop) {
    let idx = 0;
    let offset = 0; // 当前句子内的消费位置
    const total = sentences.length;

    return function take(targetLen) {
      if (total === 0 || targetLen <= 0) return "";
      let out = "";
      let guard = 0;
      const maxChars = loop ? targetLen : Infinity;

      while (out.length < targetLen && guard < total * 4) {
        if (!loop && idx >= total) break;
        const s = sentences[idx % total];
        const remain = s.length - offset;
        if (remain <= 0) {
          idx++;
          offset = 0;
          guard++;
          continue;
        }
        const need = Math.min(remain, targetLen - out.length);
        out += s.substr(offset, need);
        offset += need;
        if (offset >= s.length) {
          idx++;
          offset = 0;
        }
        guard++;
        if (!loop && idx >= total) break;
        if (out.length >= maxChars) break;
      }
      return out.trim();
    };
  }

  function fill({ text, loop, skipShort }) {
    const nodes = collectTextNodes();
    const sentences = splitSentences(text);
    if (!sentences.length) return { ok: false, error: "文本为空" };

    const take = createFeeder(sentences, loop !== false);
    let replaced = 0;

    for (const node of nodes) {
      const original = node.nodeValue;
      const originalLen = original.trim().length;
      // 导航、按钮等超短文字按需跳过，避免菜单变成散文
      if (skipShort && originalLen > 0 && originalLen < 8) continue;

      const chunk = take(originalLen);
      if (!chunk) break; // 非循环模式下文本用完，保留其余原文

      if (!backup.has(node)) backup.set(node, original);
      // 保留原节点首尾空白，避免挤掉布局中的空格
      const lead = original.match(/^\s*/)[0];
      const tail = original.match(/\s*$/)[0];
      node.nodeValue = lead + chunk + tail;
      replaced++;
    }

    return { ok: true, replaced };
  }

  function restore() {
    let restored = 0;
    for (const [node, value] of backup) {
      // 节点可能已被前端框架移除，nodeValue 赋值对游离节点无副作用
      if (node.nodeValue !== value) {
        node.nodeValue = value;
        restored++;
      }
    }
    backup.clear();
    return { ok: true, restored };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg && msg.type === "mimic:fill") {
        sendResponse(fill(msg));
      } else if (msg && msg.type === "mimic:restore") {
        sendResponse(restore());
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || "执行出错" });
    }
    return true;
  });

  window.__textMimic = { ready: true };
})();
