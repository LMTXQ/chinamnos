/* ═══════════════════════════════════════════════════════════════
   share.js — 站内统一分享工具
   ───────────────────────────────────────────────────────────────
   ▸ shareLink({ title, text, hash })：优先 navigator.share（移动端唤起
     系统分享面板），不支持/取消 → 回退复制「标题 + 摘要 + 链接」到剪贴板
   ▸ deepLink(hash)：拼站内深链（origin + pathname + #hash）
   ▸ 深链格式与解析约定见 shell.js DEEP_LINK_ROUTES 与各页面 onEnter
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { toast } from "./ui.js";

export function deepLink(hash) {
  return location.origin + location.pathname + "#" + String(hash || "").replace(/^#/, "");
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    /* 非安全上下文/拒绝授权：execCommand 兜底 */
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export async function shareLink({ title, text = "", hash = "" }) {
  const url = deepLink(hash || location.hash);
  const titleText = String(title || "ChinaMNOs 讯览台").trim();
  const summary = String(text || "").trim().slice(0, 80);
  const full = `「${titleText}」${summary ? " " + summary : ""}\n${url}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: titleText, text: summary, url });
      return; // 系统面板完成或用户取消（AbortError）均结束
    } catch (e) {
      if (e && e.name === "AbortError") return;
      /* 其他失败走复制兜底 */
    }
  }
  toast((await copyText(full)) ? "分享内容已复制，去粘贴吧" : "复制失败，请手动复制地址栏链接");
}
