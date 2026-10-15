// 图片外链信任判定（§聊天图片 / 头像图床共用）
// ▸ 背景：头像存储从 D1 base64 迁移到图床 URL（Worker CPU 优化）——图片字节流不经 Worker，
//   /api/auth/avatar 仅 302 跳转图床直链；聊天图片行识别沿用同一份图床清单
// ▸ 信任规则：https + 图片扩展名（任意外链直链）或命中已知图床域名（部分图床直链无扩展名）

export const IMG_URL_HOSTS = [
  '111666.best', 'graph.org', 'telegra.ph', 'i.ibb.co',
  'files.catbox.moe', 'i.imgur.com', 'i.loli.net',
];

const IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^\s]*)?$/i;

/** https URL 且为可信图片外链：图片扩展名结尾，或主机命中已知图床清单 */
export function isTrustedImageUrl(raw: string): boolean {
  if (!raw || raw.length > 500) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || !u.hostname) return false;
  if (IMG_EXT_RE.test(u.pathname)) return true;
  return IMG_URL_HOSTS.includes(u.hostname);
}
