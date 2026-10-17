import type { Env } from './common/env';
import { ok } from './common/envelope';
import { getPublicProfiles } from './auth/public-profile';
import { safeLinks, mdExcerpt } from './activities';

/* 公开数据导出端点：供采集端烘焙为静态 JSON 随三线部署
   （data/{carrier}/acts.json、data/{carrier}/chats.json、data/tools.json）。
   与各公开列表端点同投影、同脱敏（anon 不下发 uid/昵称）、同排序——
   前端切换静态源后按当前 carrier/province 过滤即可零漂移还原 API 视图。
   favorited 恒 false：收藏是登录用户私有数据，由前端经 /api/activities/me/favorites 合并。 */

interface ExportActRow {
  id: string;
  mode: string;
  carrier: string;
  province: string;
  title: string;
  url: string | null;
  descr: string | null;
  links: string | null;
  content_md: string | null;
  ends_at: number | null;
  anon: number;
  submitted_by: string;
  created_at: number;
  qr_key?: string | null;
  pinned_at?: number | null;
}

interface ExportChatRow {
  id: string;
  carrier: string;
  province: string;
  title: string;
  url: string | null;
  descr: string | null;
  chat_type: string | null;
  chat_id: string | null;
  anon: number;
  submitted_by: string;
  created_at: number;
  qr_key?: string | null;
}

// GET /api/export/acts：全运营商全省份公开情报（mode != 'chat'，open 且未到期，≤1000 条）
// 排序键与 handleActivityList 一致：置顶优先 → 全国通用优先 → 时间倒序（前端过滤后保持同序）
export async function handleExportActs(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, mode, carrier, province, title, url, descr, links, content_md, ends_at, anon, submitted_by, created_at, qr_key, pinned_at
     FROM activities
     WHERE mode != 'chat' AND status = 'open' AND (ends_at IS NULL OR ends_at > ?1)
     ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, (province = '') DESC, created_at DESC LIMIT 1000`,
  ).bind(Date.now()).all<ExportActRow>();

  const uids = [...new Set(rows.results.filter((r) => !r.anon).map((r) => r.submitted_by))];
  const authorMap = await getPublicProfiles(env, uids);

  const items = rows.results.map((r) => {
    const anon = !!r.anon;
    return {
      id: r.id, mode: r.mode || 'official', carrier: r.carrier, province: r.province, title: r.title,
      url: r.url || null,
      descr: r.descr,
      links: safeLinks(r.links),
      excerpt: r.mode === 'guide' ? mdExcerpt(r.content_md || '') : r.descr,
      ends_at: r.ends_at, created_at: r.created_at,
      has_qr: !!r.qr_key,
      anon,
      submitted_by: anon ? null : r.submitted_by,
      submitter_nickname: anon ? null : (authorMap.get(r.submitted_by)?.nickname ?? null),
      favorited: false,
      pinned: !!r.pinned_at,
    };
  });

  return ok({ items, exported_at: Date.now() });
}

// GET /api/export/chats：全运营商全省份公开社群（mode='chat'，open，≤1000 条）
export async function handleExportChats(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, carrier, province, title, url, descr, chat_type, chat_id, anon, submitted_by, created_at, qr_key
     FROM activities
     WHERE mode = 'chat' AND status = 'open'
     ORDER BY created_at DESC LIMIT 1000`,
  ).all<ExportChatRow>();

  const uids = [...new Set(rows.results.filter((r) => !r.anon).map((r) => r.submitted_by))];
  const authorMap = await getPublicProfiles(env, uids);

  const items = rows.results.map((r) => {
    const anon = !!r.anon;
    return {
      id: r.id, chat_type: r.chat_type || '其他', carrier: r.carrier, province: r.province,
      title: r.title, url: r.url || null, descr: r.descr, chat_id: r.chat_id || null,
      has_qr: !!r.qr_key, created_at: r.created_at,
      anon,
      submitted_by: anon ? null : r.submitted_by,
      submitter_nickname: anon ? null : (authorMap.get(r.submitted_by)?.nickname ?? null),
    };
  });

  return ok({ items, exported_at: Date.now() });
}

// GET /api/export/navlinks：全部集合公开导航链接（open，≤1000 条）
export async function handleExportNavlinks(_request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, collection, group_name, title, url, icon_url, descr
     FROM nav_links WHERE status = 'open'
     ORDER BY collection ASC, group_name ASC, sort ASC, created_at ASC LIMIT 1000`,
  ).all();

  return ok({ items: results || [], exported_at: Date.now() });
}
