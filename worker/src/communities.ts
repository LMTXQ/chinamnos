import type { Env } from './common/env';
import { ERR, fail, ok } from './common/envelope';
import { guard } from './common/auth';
import { hitLimit } from './common/ratelimit';
import { randomBase62 } from './common/crypto';
import { CARRIERS } from './cardhub/schema';
import { decodeDataUrl } from './cardhub/proofs';
import { getPublicProfiles } from './auth/public-profile';

/* 唠嗑聚落（activities 第三种形态 mode='chat'：社群收录）。
   复用 activities 表与审核链（pending→open、待审撤回、二维码 R2、范围匹配），
   仅前端展示与提交表单独立（资费页「唠嗑聚落」tab）。
   ▸ 范围三级：通用（carrier=''）/ 当前运营商（carrier=X, province=''）/ 当前运营商当前省份（carrier=X, province=Y）
     与攻略「全运营商通用」同模型——列表匹配 (carrier=?1 OR carrier='') AND province IN (?2,'') 零改动
   ▸ chat_type：社群种类（论坛/QQ群/微信群/贴吧/纸飞机/其他，单选）
   ▸ chat_id：群号/微信号/账号名（≤50 字；论坛类可空走 url）——url 与 chat_id 至少其一
   ▸ proof_key：授权凭证（群主/管理员身份截图，R2 私有对象，仅管理组可查；选填）
   ▸ 无匿名、无截止时间（社群长期有效） */

export const CHAT_TYPES = ['论坛', 'QQ群', '微信群', '贴吧', '纸飞机', '其他'];
export const CHAT_ID_MAX = 50; // 群号/账号上限（activities 管理编辑端点共用此常量）

const TITLE_MIN = 2, TITLE_MAX = 40;
const URL_MAX = 300;
const DESCR_MAX = 200;
const SUBMIT_LIMIT = 3;    // 提交限流：3 次/时（与情报酒馆同款）
const PENDING_QUOTA = 5;   // 同用户待审上限（activities 全 mode 共享）
const QR_MAX_DIM = 2500;   // 二维码/凭证图宽高上限

const PROVINCE_RE = /^[\u4e00-\u9fa5]{2,10}$/;

interface ChatRow {
  id: string;
  mode: string;
  carrier: string;
  province: string;
  title: string;
  url: string | null;
  descr: string | null;
  chat_type: string | null;
  chat_id: string | null;
  status: string;
  anon: number;
  submitted_by: string;
  created_at: number;
  reject_reason?: string | null;
  reviewed_at?: number | null;
  qr_key?: string | null;
  proof_key?: string | null;
}

// GET /api/communities?carrier=&province=：社群列表（open，范围匹配：本运营商本省 + 本运营商全国 + 通用）
export async function handleCommunityList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const carrier = url.searchParams.get('carrier') || '';
  const province = url.searchParams.get('province') || '';
  if (!CARRIERS.some((c) => c.id === carrier)) return ok({ items: [], mine_pending: [] });

  const rows = await env.DB.prepare(
    `SELECT id, mode, carrier, province, title, url, descr, chat_type, chat_id, status, anon, submitted_by, created_at, qr_key
     FROM activities
     WHERE mode = 'chat' AND status = 'open' AND (carrier = ?1 OR carrier = '') AND province IN (?2, '')
     ORDER BY created_at DESC LIMIT 50`,
  ).bind(carrier, province).all<ChatRow>();

  // 匿名（anon=1）公众侧不下发提交者 uid/昵称（同情报酒馆口径）
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

  // 我的投稿（三态区数据源）：待审 + 最近 30 天已审结（带 status/reject_reason）；
  // mine_pending 保留旧字段仅为部署过渡期旧前端的待审区兼容
  let minePending: Array<Record<string, unknown>> = [];
  let mineAll: Array<Record<string, unknown>> = [];
  const g = await guard(request, env, 'anon');
  if (!(g instanceof Response) && g.viewer.id) {
    const mine = await env.DB.prepare(
      `SELECT id, chat_type, province, title, url, descr, chat_id, anon, carrier, status, reject_reason, created_at, reviewed_at FROM activities
       WHERE mode = 'chat' AND submitted_by = ?1
         AND (status = 'pending' OR (status IN ('open', 'rejected') AND reviewed_at > ?2))
       ORDER BY created_at DESC LIMIT 50`,
    ).bind(g.viewer.id, Date.now() - 30 * 86400 * 1000).all<ChatRow>();
    mineAll = mine.results.map((r) => ({
      id: r.id, chat_type: r.chat_type || '其他', province: r.province,
      title: r.title, url: r.url || null, descr: r.descr || null, chat_id: r.chat_id || null,
      anon: !!r.anon, carrier: r.carrier, status: r.status, reject_reason: r.reject_reason,
      created_at: r.created_at, reviewed_at: r.reviewed_at,
    }));
    minePending = mineAll.filter((r) => r.status === 'pending');
  }
  return ok({ items, mine: mineAll, mine_pending: minePending });
}

// POST /api/communities：提交社群（→ pending，管理组审核）
export async function handleCommunityCreate(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const chatType = typeof body.chat_type === 'string' ? body.chat_type.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const chatId = typeof body.chat_id === 'string' ? body.chat_id.trim() : '';
  const descr = typeof body.descr === 'string' ? body.descr.trim() : '';
  // 范围三选：all=通用 | carrier=当前运营商 | prov=当前运营商当前省份
  const scope = body.scope === 'carrier' || body.scope === 'prov' ? body.scope : 'all';
  const anon = body.anon === true || body.anon === 1 ? 1 : 0; // 匿名展示（公众侧不下发 uid/昵称；管理组审核可见）

  const fieldErr = (field: string, message: string) => fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field, message });

  if (!CHAT_TYPES.includes(chatType)) return fieldErr('chat_type', '社群种类无效');
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) return fieldErr('title', `名称需 ${TITLE_MIN}~${TITLE_MAX} 字`);
  if (url && !/^https:\/\/.+/i.test(url)) return fieldErr('url', '加入链接必须为 https:// 地址');
  if (url.length > URL_MAX) return fieldErr('url', `链接不超过 ${URL_MAX} 字`);
  if (chatId.length > CHAT_ID_MAX) return fieldErr('chat_id', `群号/账号不超过 ${CHAT_ID_MAX} 字`);
  if (!url && !chatId) return fieldErr('url', '加入方式至少提供其一：链接或群号/账号');
  if (descr.length > DESCR_MAX) return fieldErr('descr', `说明介绍不超过 ${DESCR_MAX} 字`);

  // 范围映射：all → carrier=''/province=''；carrier → 运营商+全国；prov → 运营商+省份
  const carrier = scope === 'all' ? '' : String(body.carrier || '');
  const province = scope === 'prov' ? String(body.province || '').trim() : '';
  if (carrier && !CARRIERS.some((c) => c.id === carrier)) return fieldErr('carrier', '运营商无效');
  if (province && !PROVINCE_RE.test(province)) return fieldErr('province', '省份无效');
  if (province && !carrier) return fieldErr('scope', '指定省份必须同时指定运营商');

  const rl = await hitLimit(env, `chat:submit:${g.viewer.id}`, SUBMIT_LIMIT, 3600);
  if (!rl) return fail(40904, 'RATE_LIMITED', 429);

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM activities WHERE submitted_by = ?1 AND status = 'pending'`,
  ).bind(g.viewer.id).first<{ c: number }>();
  if ((pending?.c ?? 0) >= PENDING_QUOTA) return fail(40906, 'ACTIVITY_QUOTA_EXCEEDED', 409);

  // 查重：同提交者 + 同名称的待审/展示中社群
  const dup = await env.DB.prepare(
    `SELECT id FROM activities WHERE mode = 'chat' AND submitted_by = ?1 AND status IN ('pending', 'open') AND title = ?2 LIMIT 1`,
  ).bind(g.viewer.id, title).first<{ id: string }>();
  if (dup) return fail(40905, 'ACTIVITY_EXISTS', 409);

  // 二维码 / 授权凭证：dataURL 解码 + 魔数嗅探（复用证明材料 decodeDataUrl，≤300KB）
  const dec = (key: 'qr' | 'proof') => {
    const o = (body[key] && typeof body[key] === 'object') ? body[key] as Record<string, unknown> : null;
    if (!o) return null;
    const d = decodeDataUrl(typeof o.data === 'string' ? o.data : '');
    const w = Number(o.w), h = Number(o.h);
    if (!d) return 'invalid';
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > QR_MAX_DIM || h > QR_MAX_DIM) return 'invalid';
    return { bytes: d.bytes, mime: d.mime };
  };
  const qr = dec('qr');
  if (qr === 'invalid') return fieldErr('qr', '二维码图片无效（仅支持 PNG / JPG / WebP，≤300KB）');
  const proof = dec('proof');
  if (proof === 'invalid') return fieldErr('proof', '授权凭证图片无效（仅支持 PNG / JPG / WebP，≤300KB）');

  const id = randomBase62(8);
  const now = Date.now();

  // R2 先传后落库：落库失败清理已传对象（同情报酒馆模式）
  const put = async (name: 'qr' | 'proof', d: { bytes: Uint8Array; mime: string }): Promise<string | null> => {
    const ext = d.mime === 'image/png' ? 'png' : d.mime === 'image/webp' ? 'webp' : 'jpg';
    const key = `activities/${id}/${name}.${ext}`;
    try {
      await env.PROOFS!.put(key, d.bytes, {
        httpMetadata: { contentType: d.mime },
        customMetadata: { activityId: id },
      });
      return key;
    } catch {
      return null;
    }
  };
  const qrKey = qr ? await put('qr', qr) : null;
  if (qr && !qrKey) return fail(ERR.INTERNAL_ERROR, 'QR_UPLOAD_FAILED', 500);
  const proofKey = proof ? await put('proof', proof) : null;
  if (proof && !proofKey) {
    if (qrKey) { try { await env.PROOFS!.delete(qrKey); } catch { /* */ } }
    return fail(ERR.INTERNAL_ERROR, 'QR_UPLOAD_FAILED', 500);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO activities (id, mode, carrier, province, title, url, descr, chat_type, chat_id, status, anon, ends_at, submitted_by, created_at, qr_key, proof_key)
       VALUES (?1, 'chat', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, NULL, ?10, ?11, ?12, ?13)`,
    ).bind(
      id, carrier, province, title, url, descr,
      chatType, chatId || null, anon, g.viewer.id, now, qrKey, proofKey,
    ).run();
  } catch (e) {
    for (const k of [qrKey, proofKey]) { if (k) { try { await env.PROOFS!.delete(k); } catch { /* */ } } }
    throw e;
  }

  return ok({ id, status: 'pending', mode: 'chat' });
}

// DELETE /api/communities/:id：提交者撤回自己的待审社群（硬删 + R2 清理，同情报酒馆撤回）
export async function handleCommunityDelete(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const row = await env.DB.prepare(
    `SELECT id, status, submitted_by, qr_key, proof_key FROM activities WHERE id = ?1 AND mode = 'chat'`,
  ).bind(id).first<ChatRow>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (row.submitted_by !== g.viewer.id) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  // pending=撤回；rejected=清理后重投（编辑=删旧重提的回退路径）；open 不可自删
  if (row.status !== 'pending' && row.status !== 'rejected') return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);

  await env.DB.prepare('DELETE FROM activities WHERE id = ?1').bind(id).run();
  for (const k of [row.qr_key, row.proof_key]) { if (k) { try { await env.PROOFS!.delete(k); } catch { /* */ } } }
  return ok({ deleted: true });
}

// GET /api/admin/communities/:id/proof：查看授权凭证（仅管理组；R2 私有对象流式返回）
export async function handleCommunityProof(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  if (!/^[A-Za-z0-9]{4,16}$/.test(id)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  const row = await env.DB.prepare(
    `SELECT id, title, proof_key FROM activities WHERE id = ?1 AND mode = 'chat'`,
  ).bind(id).first<ChatRow>();
  if (!row || !row.proof_key) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const obj = await env.PROOFS!.get(row.proof_key);
  if (!obj) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, no-store',
    },
  });
}
