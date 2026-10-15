import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { hitLimit } from '../common/ratelimit';
import { isTrustedImageUrl } from '../common/img-hosts';
import { getPublicProfile } from './public-profile';

/** 联系方式类型白名单：每类至多一条 */
export const CONTACT_TYPES = ['qq', 'wechat', 'phone', 'email', 'other'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
const CONTACT_TYPE_SET = new Set<string>(CONTACT_TYPES);

const VALUE_MAX_USER = 15;  // 普通用户单条联系方式 ≤15 字
const VALUE_MAX_STAFF = 50; // admin/owner 豁免 15 字限制（仍设 50 上限防滥用）

/** 联系方式禁止中文（CJK 汉字一律拒绝） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const BIO_MAX = 25; // 个性签名 ≤25 字（资料卡展示）

export interface ContactItem { type: ContactType; value: string; pub: boolean }

/** admin/owner 豁免昵称 / 联系方式长度限制 */
export function isStaff(role: string): boolean {
  return role === 'admin' || role === 'owner';
}

/**
 * 解析并校验联系方式数组（设置写入口共用）：
 * type 必须在白名单且不重复；value 去首尾空白后非空才收录；
 * 普通用户 value ≤15 字，admin/owner 豁免。非法返回错误代码。
 */
export function parseContacts(raw: unknown, staff: boolean): { error?: string; items?: ContactItem[] } {
  if (raw == null) return { items: [] };
  if (!Array.isArray(raw)) return { error: 'CONTACTS_FORMAT' };
  if (raw.length > CONTACT_TYPES.length) return { error: 'CONTACTS_TOO_MANY' };

  const seen = new Set<string>();
  const items: ContactItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') return { error: 'CONTACTS_FORMAT' };
    const o = it as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : '';
    if (!CONTACT_TYPE_SET.has(type)) return { error: 'CONTACTS_TYPE' };
    if (seen.has(type)) return { error: 'CONTACTS_DUP' };
    seen.add(type);
    const value = typeof o.value === 'string' ? o.value.trim() : '';
    if (!value) continue; // 空值 = 未填，跳过（连同其公开标志，禁止空值公开）
    if (CJK_RE.test(value)) return { error: 'CONTACTS_CJK' };
    if (value.length > (staff ? VALUE_MAX_STAFF : VALUE_MAX_USER)) return { error: 'CONTACTS_TOO_LONG' };
    items.push({ type: type as ContactType, value, pub: !!o.pub });
  }
  return { items };
}

/** users.contacts（JSON 字符串）→ 数组；坏数据容错为空数组 */
export function readContacts(json: string | null | undefined): ContactItem[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((c): c is ContactItem =>
      !!c && typeof c === 'object'
      && typeof (c as ContactItem).type === 'string'
      && typeof (c as ContactItem).value === 'string');
  } catch {
    return [];
  }
}

// POST /api/auth/profile：登录用户设置多条联系方式（每条独立公开开关）
// 注意：此公开开关与发帖时的联系方式策略相互独立（各自控制）
export async function handleSetProfile(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const parsed = parseContacts(body.contacts, isStaff(g.viewer.role));
  if (parsed.error) return fail(ERR.VALIDATION_ERROR, parsed.error, 400, { field: 'contacts' });

  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
  if (bio.length > BIO_MAX) return fail(ERR.VALIDATION_ERROR, 'BIO_TOO_LONG', 400, { field: 'bio' });

  await env.DB.prepare('UPDATE users SET contacts = ?1, bio = ?2 WHERE id = ?3')
    .bind(JSON.stringify(parsed.items), bio || null, g.viewer.id).run();

  return ok({ contacts: parsed.items, bio: bio || null });
}

// GET /api/auth/profile/:uid：公开资料卡（点头像弹出）
// 公开资料（昵称/头衔/头像版本）走账号系统统一出口；contacts 仅返回用户逐条勾选「公开」的项
export async function handlePublicProfile(request: Request, env: Env, uid: string): Promise<Response> {
  const prof = await getPublicProfile(env, uid);
  if (!prof) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  const u = await env.DB.prepare(
    'SELECT contacts, bio FROM users WHERE id = ?1',
  ).bind(uid).first<{ contacts: string | null; bio: string | null }>();

  return ok({
    id: prof.id,
    nickname: prof.nickname,
    bio: u?.bio || null,
    title: prof.title, // 未设置时前端兜底显示默认头衔
    contacts: readContacts(u?.contacts).filter((c) => c.pub).map((c) => ({ type: c.type, value: c.value })),
    avatar_v: prof.avatar_v,
  });
}

// POST /api/auth/avatar：登录用户设置自己的头像（body { url }；空串 = 清除恢复首字默认）
// ▸ 图床化后仅存 URL 字符串、无图片字节流上传，滥用面可控：可信图片外链校验 + 5 次/时限流
// ▸ 内容治理走「先发后审」：立即生效，管理组在后台用户列表/资料卡可见，可随时代改或清除
export async function handleSetMyAvatar(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const rl = await hitLimit(env, `avatar:self:${g.viewer.id}`, 5, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const url = typeof body.url === 'string' ? body.url.trim() : '';

  if (url && !isTrustedImageUrl(url)) {
    return fail(ERR.VALIDATION_ERROR, 'INVALID_IMAGE_URL', 400, {
      field: 'url', message: '须为 https 图片直链（.png/.jpg/.webp/.gif 结尾或受信任图床域名）',
    });
  }

  const now = Date.now();
  await env.DB.prepare('UPDATE users SET avatar = ?1, avatar_updated_at = ?2 WHERE id = ?3')
    .bind(url || null, now, g.viewer.id).run();
  return ok({ avatar_v: url ? now : null });
}

// GET /api/auth/avatar/:uid：头像图片（无则 404，前端回退昵称首字圆形）
// ▸ 存图为图床 URL（新流程）→ 302 跳转图床直链：图片字节流不经 Worker，CPU 归零；
//   ?v= 版本参数变更即破缓存，302 可由浏览器长缓存
// ▸ 存图为 dataURL（存量兼容）→ 照旧 base64 解码返回
export async function handleAvatar(request: Request, env: Env, uid: string): Promise<Response> {
  const u = await env.DB.prepare('SELECT avatar FROM users WHERE id = ?1')
    .bind(uid).first<{ avatar: string | null }>();
  if (!u || !u.avatar) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // 图床 URL 分支：302 重定向（浏览器直接从图床加载，Worker 零字节传输）
  if (u.avatar.startsWith('https://')) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: u.avatar,
        // avatarUrl 自带 ?v= 版本参数，长缓存安全
        'Cache-Control': 'public, max-age=604800',
      },
    });
  }

  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(u.avatar);
  if (!m) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));

  return new Response(bytes.buffer as ArrayBuffer, {
    headers: {
      'Content-Type': m[1],
      // 头像更新频率极低且 URL 带版本参数，可放心长缓存
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
