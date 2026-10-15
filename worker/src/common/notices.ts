import type { Env } from './env';
import { ok } from './envelope';

// GET /api/notices：公告/推广弹窗内容（anon，无鉴权；HTTP 缓存 60s——站长改内容最多延迟 1 分钟生效）
//   读 settings 表 3+1 键；version = content 行的 updated_at（站长保存内容即自动变更版本，
//   前端据此判断登录用户「内容变更需重新同意」）。未启用时 enabled=false 且不返回内容。
//   响应统一返回实例，前端 NoticeGate（shell/notice.js）按各自策略消费：
//     site_notice      全站公告（所有人每日首进，可勾选「今日不再弹出」）
//     promos[]         推广（可多条，每条 mode=closable|must，前端按 scope 范围过滤后入队；
//                      scope.modules 非空 = 仅进入对应模块时判定弹出，空 = 全站任意页面。
//                      跳蚤市集用户警告已并入推广体系：migration 0030 迁为
//                      mode=must、scope.modules=["cardhub"] 的条目，专用键已删除）

interface NoticeSettingRow { key: string; value_json: string; updated_at: number | null }

interface PromoOut {
  id: string;
  version: number;
  title: string;
  content: string;
  mode: 'closable' | 'must';
  scope: { carriers: string[]; provinces: string[]; modules: string[] };
}

/** 规范化推广条目（设置端已校验，此处防御性过滤：仅输出 enabled 且内容非空的条目） */
function normalizePromos(raw: unknown, fallbackVersion: number): PromoOut[] {
  if (!Array.isArray(raw)) return [];
  const out: PromoOut[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.enabled === false) continue;
    const title = typeof o.title === 'string' ? o.title : '';
    const content = typeof o.content === 'string' ? o.content : '';
    if (!title.trim() || !content.trim()) continue;
    const scopeRaw = (o.scope && typeof o.scope === 'object' ? o.scope : {}) as Record<string, unknown>;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : '',
      version: typeof o.version === 'number' && o.version > 0 ? o.version : fallbackVersion,
      title,
      content,
      mode: o.mode === 'must' ? 'must' : 'closable',
      scope: {
        carriers: Array.isArray(scopeRaw.carriers) ? scopeRaw.carriers.map(String) : [],
        provinces: Array.isArray(scopeRaw.provinces) ? scopeRaw.provinces.map(String) : [],
        modules: Array.isArray(scopeRaw.modules) ? scopeRaw.modules.map(String) : [],
      },
    });
  }
  return out;
}

export async function handleNotices(env: Env): Promise<Response> {
  // 一次取全部相关键（5 行），version 取 content 行 updated_at（null = 从未保存过，按 0）
  const keys = [
    'site_notice_enabled', 'site_notice_title', 'site_notice_content',
    'promos', 'promo_reswitch_enabled',
  ];
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(',');
  const rows = await env.DB.prepare(
    `SELECT key, value_json, updated_at FROM settings WHERE key IN (${placeholders})`,
  ).bind(...keys).all<{ key: string; value_json: string; updated_at: number | null }>();

  const map = new Map<string, { value_json: string; updated_at: number | null }>();
  for (const r of rows.results || []) map.set(r.key, r);

  const pick = (key: string): { value: unknown; version: number } => {
    const row = map.get(key);
    let value: unknown;
    try { value = row ? JSON.parse(row.value_json) : undefined; } catch { value = undefined; }
    return { value, version: row?.updated_at ?? 0 };
  };

  const noticeEn = pick('site_notice_enabled');
  const noticeTitle = pick('site_notice_title');
  const noticeCt = pick('site_notice_content');
  const promosRaw = pick('promos');
  const reswitchRaw = pick('promo_reswitch_enabled');

  const noticeEnabled = noticeEn.value === true && typeof noticeCt.value === 'string' && noticeCt.value.trim() !== '';

  return ok(
    {
      site_notice: {
        enabled: noticeEnabled,
        version: noticeEnabled ? noticeCt.version : 0,
        title: typeof noticeTitle.value === 'string' && noticeTitle.value ? noticeTitle.value : '站点公告',
        content: noticeEnabled ? String(noticeCt.value) : '',
      },
      promos: normalizePromos(promosRaw.value, promosRaw.version),
      // 切换运营商/省份时重新弹推广（未保存过 = 默认开启）
      promo_reswitch: reswitchRaw.value !== false,
    },
    { 'Cache-Control': 'public, max-age=60' },
  );
}
