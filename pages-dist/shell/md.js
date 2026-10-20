/* ═══════════════════════════════════════════════════════════════
   md.js — 站内 mini Markdown 共享模块（渲染下沉 + 编辑器组件）
   ───────────────────────────────────────────────────────────────
   ▸ mdToSafeHtml(src, opts)：先全文 HTML 转义再套 md 语法，天然防 XSS
     语法：#~#### 标题 / **粗** / *斜* / `行内码` / [文字](链接) /
       > 引用 / --- 分隔线 / - 与 1. 列表 / | 表格 |（GFM 管道式，支持 :--- 对齐，
       空表头自动省略 thead）/ 独立成行图片外链 / ![alt](url)
     链接仅允许 http/https/相对/#；opts.nofollow 时外链附 nofollow
   ▸ 图片外链走 isMdImageUrl 白名单（图片扩展名或已知图床域名，
     与在线沟通 isImageUrlLine 同一策略）；白名单内渲染
     <img loading="lazy" referrerpolicy="no-referrer">，白名单外按普通链接文字展示
   ▸ mdCreateEditor(container, opts)：工具栏（插入语法）+ textarea +
     预览切换 + 字数统计 + 草稿暂存（opts.draftKey → localStorage）
     返回 { getValue, setValue, focus, destroy }
   ▸ 本模块为 shell 共享模块：入口严禁带 ?v=（双实例问题，见 index.html 注释）
   ═══════════════════════════════════════════════════════════════ */
"use strict";

/* ── 图片外链白名单（扩展名或已知图床域名；与在线沟通 isImageUrlLine 同策略） ── */
const MD_IMG_EXT_RE = /^https:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s<>"']*)?$/i;
const MD_IMG_HOSTS = new Set(["111666.best", "graph.org", "telegra.ph", "i.ibb.co", "files.catbox.moe", "i.imgur.com", "i.loli.net"]);

export function isMdImageUrl(u) {
  const s = String(u || "").trim();
  if (!s.startsWith("https://") || /[\s<>"']/.test(s.slice(8))) return false;
  if (MD_IMG_EXT_RE.test(s)) return true;
  try { return MD_IMG_HOSTS.has(new URL(s).hostname); } catch { return false; }
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 行内语法（输入已转义）；nofollow 为 " nofollow" 或 "" */
function mdInline(s, nofollow) {
  return String(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      const href = /^(https?:\/\/|\/|#)/i.test(u) ? u : "#";
      return `<a href="${href}" target="_blank" rel="noopener noreferrer${nofollow}">${t}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/* ── GFM 管道式表格 ──
   分隔行判定：|---|---|（冒号标注对齐 :--- / :---: / ---:；须含竖线，裸 --- 仍走分隔线） */
function isTableDelim(line) {
  if (!line.includes("|")) return false;
  const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  return cells.length >= 1 && cells.every((c) => /^:?-+:?$/.test(c));
}

/* 表行拆单元格：去首尾竖线后按 | 切分；\| 先换占位符再切分（escHtml 后原文不含 \x00，安全），
   切分后还原为字面竖线，避免「x \| y」这类写法被误拆 */
function splitTableRow(line) {
  return line.replace(/^\|/, "").replace(/\|$/, "")
    .replace(/\\\|/g, "\x00")
    .split("|")
    .map((c) => c.replace(/\x00/g, "|").trim());
}

/* 分隔行单元格 → 对齐方式（"" = 默认左对齐） */
function tableAlign(c) {
  const l = c.startsWith(":"), r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "";
}

/* 图片渲染：白名单内 → <img>（懒加载 + 不带 referer）；白名单外 → 降级为普通链接 */
function mdImgHtml(url, alt, nofollow) {
  if (isMdImageUrl(url)) {
    return `<p class="md-img"><img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer"></p>`;
  }
  return `<p>${mdInline(`[${alt || "图片"}](${url})`, nofollow)}</p>`;
}

/* mini Markdown → 安全 HTML（先全文转义再套语法；输入任意用户内容均安全） */
export function mdToSafeHtml(src, opts) {
  const nofollow = opts && opts.nofollow ? " nofollow" : "";
  const lines = escHtml(src).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let list = null;   // null | "ul" | "ol"
  let quote = false; // 引用块开启中
  const closeList = () => { if (list) { html += "</" + list + ">"; list = null; } };
  const closeQuote = () => { if (quote) { html += "</blockquote>"; quote = false; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { closeList(); closeQuote(); continue; }
    let m;
    /* 图片独立行：![alt](url) 或整行仅为白名单图片外链 */
    if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) {
      closeList(); closeQuote();
      html += mdImgHtml(m[2], m[1], nofollow);
      continue;
    }
    if (isMdImageUrl(line)) {
      closeList(); closeQuote();
      html += mdImgHtml(line, "", nofollow);
      continue;
    }
    /* 表格块：| 开头行 + 下一行分隔行 → 吞整个块渲染 <table>；
       空表头（如「| | |」）自动省略 thead，适配「项目 | 说明」两列说明表 */
    if (line.startsWith("|") && i + 1 < lines.length && isTableDelim(lines[i + 1].trim())) {
      closeList(); closeQuote();
      const aligns = splitTableRow(lines[i + 1].trim()).map(tableAlign);
      const cell = (c, k, tag) => {
        const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
        return `<${tag}${a}>${mdInline(c, nofollow)}</${tag}>`;
      };
      const head = splitTableRow(line);
      let tbl = '<table class="md-tbl">';
      if (head.some((c) => c !== "")) {
        tbl += "<thead><tr>" + head.map((c, k) => cell(c, k, "th")).join("") + "</tr></thead>";
      }
      let body = "";
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        body += "<tr>" + splitTableRow(lines[i].trim()).map((c, k) => cell(c, k, "td")).join("") + "</tr>";
        i++;
      }
      i--; // 抵消 for 的 i++，让外层从表格块后一行继续
      html += tbl + "<tbody>" + body + "</tbody></table>";
      continue;
    }
    /* 引用（全文转义后 > 为 &gt;） */
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      if (!quote) { html += "<blockquote>"; quote = true; }
      html += "<p>" + mdInline(m[1], nofollow) + "</p>";
      continue;
    }
    /* 分隔线 */
    if (/^(?:-{3,}|\*{3,})$/.test(line)) {
      closeList(); closeQuote();
      html += "<hr>";
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.+)$/))) {
      closeList(); closeQuote();
      html += "<h" + (m[1].length + 2) + ">" + mdInline(m[2], nofollow) + "</h" + (m[1].length + 2) + ">";
      continue;
    }
    if ((m = line.match(/^[-*]\s+(.+)$/))) {
      closeQuote();
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += "<li>" + mdInline(m[1], nofollow) + "</li>";
      continue;
    }
    if ((m = line.match(/^\d+[.．、]\s+(.+)$/))) {
      closeQuote();
      if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += "<li>" + mdInline(m[1], nofollow) + "</li>";
      continue;
    }
    closeList(); closeQuote();
    html += "<p>" + mdInline(line, nofollow) + "</p>";
  }
  closeList(); closeQuote();
  return html;
}

/* ── 编辑器组件：工具栏（插入语法）+ textarea + 预览切换 + 字数 + 草稿 ──
   opts: { placeholder, maxlength, draftKey, initial, rows, onImage, nofollow }
   onImage(editor)：工具栏「图片」按钮回调（缺省插入 ![图片](https://) 模板）；
   draftKey：localStorage 草稿键（自动加 chinamnos_md_draft_ 前缀，长文防丢）；
   返回 { getValue, setValue, focus, destroy }；容器 innerHTML 重建后需重新创建 */
/* ── 编辑器组件样式：组件自带（任意页面引入即可用，不依赖具体页面的 css）。
   tariff/style.css 内有一份同款定义（历史原因保留，规则一致无害重复） ── */
let _editorCssDone = false;
function ensureEditorCSS() {
  if (_editorCssDone) return;
  _editorCssDone = true;
  const s = document.createElement("style");
  s.setAttribute("data-md-editor-css", "");
  s.textContent = `
.md-editor { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); overflow: hidden; }
.md-tools { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.md-tool {
  min-width: 28px; height: 26px; padding: 0 8px; border: 0; border-radius: 6px; cursor: pointer;
  font-size: 12px; font-weight: 700; color: var(--sub); background: transparent;
}
.md-tool:hover { background: var(--surface); color: var(--acc); }
.md-tool.active { background: color-mix(in oklab, var(--acc) 14%, transparent); color: var(--acc); }
.md-tool-preview { margin-left: auto; }
.md-input {
  width: 100%; border: 0; outline: none; resize: vertical; padding: 10px 12px;
  font: 13px/1.8 var(--font); color: var(--txt); background: var(--surface); min-height: 180px;
}
.md-preview { padding: 10px 12px; min-height: 120px; max-height: 420px; overflow: auto; border-bottom: 1px solid var(--line); }
.md-foot { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; font-size: 11.5px; color: var(--sub); background: var(--surface-2); }
.md-count { font-variant-numeric: tabular-nums; }`;
  document.head.appendChild(s);
}

export function mdCreateEditor(container, opts = {}) {
  ensureEditorCSS();
  const maxlen = Number(opts.maxlength) > 0 ? Number(opts.maxlength) : 10000;
  const draftKey = opts.draftKey ? "chinamnos_md_draft_" + opts.draftKey : "";
  let value = "";
  if (typeof opts.initial === "string" && opts.initial) value = opts.initial;
  else if (draftKey) { try { value = localStorage.getItem(draftKey) || ""; } catch { /* 隐私模式等忽略 */ } }

  const TOOLS = [
    ["h", "标题", "H"], ["b", "粗体", "B"], ["i", "斜体", "I"], ["code", "行内代码", "码"],
    ["link", "插入链接", "链"], ["ul", "无序列表", "•"], ["ol", "有序列表", "1."],
    ["quote", "引用", "❝"], ["hr", "分隔线", "—"], ["tbl", "插入表格", "表格"], ["img", "插入图片（图床外链）", "图"],
  ];
  const root = document.createElement("div");
  root.className = "md-editor";
  root.innerHTML = `
    <div class="md-tools">${TOOLS.map(([k, title, label]) =>
      `<button type="button" class="md-tool" data-md="${k}" title="${title}">${label}</button>`).join("")}
      <button type="button" class="md-tool md-tool-preview" data-md="preview" title="预览渲染效果">预览</button>
    </div>
    <textarea class="md-input"${opts.inputId ? ` id="${escHtml(opts.inputId)}"` : ""} rows="${opts.rows || 10}" maxlength="${maxlen}" placeholder="${escHtml(opts.placeholder || "支持 Markdown：标题 / 粗斜体 / 链接 / 列表 / 引用 / 表格 / 图片外链")}"></textarea>
    <div class="md-preview" hidden></div>
    <div class="md-foot"><span class="md-count"></span><span class="md-hint">Markdown · 图片支持图床外链</span></div>`;
  container.appendChild(root);
  const ta = root.querySelector(".md-input");
  const pv = root.querySelector(".md-preview");
  const count = root.querySelector(".md-count");
  ta.value = value;
  const paint = () => { count.textContent = `${ta.value.length} / ${maxlen}`; };
  paint();

  let draftTimer = 0;
  ta.addEventListener("input", () => {
    paint();
    if (draftKey) {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { try { localStorage.setItem(draftKey, ta.value); } catch { /* */ } }, 400);
    }
  });

  const fire = () => ta.dispatchEvent(new Event("input", { bubbles: true }));
  /* 选区包裹（粗体/斜体/行内码/链接） */
  const wrapSel = (before, after, placeholder) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder || "";
    ta.setRangeText(before + sel + after, s, e, "end");
    ta.focus();
    fire();
  };
  /* 行首插入（标题/列表/引用/分隔线） */
  const linePrefix = (prefix, placeholder) => {
    const s = ta.selectionStart;
    const ls = ta.value.lastIndexOf("\n", s - 1) + 1;
    ta.setRangeText(prefix + (placeholder || ""), ls, ls, "end");
    ta.focus();
    fire();
  };

  root.querySelector(".md-tools").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-md]");
    if (!btn) return;
    const k = btn.dataset.md;
    if (k === "h") linePrefix("## ", "标题");
    else if (k === "b") wrapSel("**", "**", "粗体");
    else if (k === "i") wrapSel("*", "*", "斜体");
    else if (k === "code") wrapSel("`", "`", "代码");
    else if (k === "link") wrapSel("[", "](https://)", "链接文字");
    else if (k === "ul") linePrefix("- ", "列表项");
    else if (k === "ol") linePrefix("1. ", "列表项");
    else if (k === "quote") linePrefix("> ", "引用内容");
    else if (k === "hr") linePrefix("---", "");
    else if (k === "tbl") linePrefix("| 表头 | 表头 |\n|---|---|\n| 内容 | 内容 |\n", "");
    else if (k === "img") {
      if (typeof opts.onImage === "function") opts.onImage(handle);
      else wrapSel("![", "](https://)", "图片说明");
    } else if (k === "preview") {
      const on = !pv.hidden;
      if (on) { pv.hidden = true; ta.hidden = false; btn.classList.remove("active"); }
      else {
        pv.innerHTML = mdToSafeHtml(ta.value, { nofollow: !!opts.nofollow });
        pv.hidden = false; ta.hidden = true; btn.classList.add("active");
      }
    }
  });

  const handle = {
    getValue: () => ta.value,
    setValue: (v) => { ta.value = String(v || ""); paint(); },
    focus: () => ta.focus(),
    destroy: () => { clearTimeout(draftTimer); root.remove(); },
  };
  return handle;
}
