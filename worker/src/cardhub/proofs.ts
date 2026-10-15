import type { Env } from '../common/env';
import { fail, ok, ERR } from '../common/envelope';
import { guard } from '../common/auth';
import { randomBase62 } from '../common/crypto';

// 证明材料（出让/出租审核照片）：R2 存对象，D1 存元数据。
// 安全设计（前后端双验证的后端权威层）：
//   ① 无独立上传端点——照片随 createPost 请求体走，刷图必须先刷帖（受 pending<3 + 邮箱验证 + 登录态三重门槛）
//   ② 服务端二次校验：张数 ≤3、单张 ≤300KB、魔数嗅探（防伪装图片的可执行文件）、宽高上限
//   ③ R2 走 Worker binding 内网上传，密钥零暴露
//   ④ 访问鉴权：proof_public=0（默认）仅发布者本人与管理员可读；=1 公众可读；key 随机 base62 不可枚举

const MAX_PROOFS = 3;
const MAX_BYTES = 300 * 1024;          // 单张解码后字节数上限
const MAX_DIM = 5000;                  // 宽/高上限（前端压缩后一般 ≤1280）

/** dataURL 解码 + 魔数嗅探（JPEG/PNG/WebP），返回字节与 MIME；非法返回 null（活动二维码复用） */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  let bytes: Uint8Array;
  try {
    const bin = atob(m[2]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length < 12 || bytes.length > MAX_BYTES) return null;
  let mime: string | null = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
  else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = 'image/png';
  else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) mime = 'image/webp';
  if (!mime) return null;
  return { bytes, mime };
}

export interface ProofRow { id: string; w: number; h: number }

/** 发布时保存证明材料：校验 → PUT R2 → INSERT 行；任一失败清理已上传对象 */
export async function saveProofs(
  env: Env, postId: string, raw: unknown,
): Promise<{ ok: true; items: ProofRow[] } | { ok: false; field: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, field: 'proofs' };
  }
  if (raw.length > MAX_PROOFS) return { ok: false, field: 'proofs' };

  const uploaded: string[] = [];
  const items: ProofRow[] = [];
  try {
    for (const item of raw) {
      const o = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
      const data = typeof o.data === 'string' ? o.data : '';
      const w = Number(o.w), h = Number(o.h);
      const dec = decodeDataUrl(data);
      if (!dec) return { ok: false, field: 'proofs' };
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > MAX_DIM || h > MAX_DIM) {
        return { ok: false, field: 'proofs' };
      }
      const key = randomBase62(8);
      const r2Key = `proofs/${postId}/${key}.jpg`;
      await env.PROOFS!.put(r2Key, dec.bytes, {
        httpMetadata: { contentType: dec.mime },
        customMetadata: { postId },
      });
      uploaded.push(r2Key);
      items.push({ id: key, w: Math.round(w), h: Math.round(h) });
    }
    const now = Date.now();
    const stmts = items.map((it, i) => env.DB.prepare(
      'INSERT INTO post_proofs (id, post_id, r2_key, w, h, created_at) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(it.id, postId, uploaded[i], it.w, it.h, now));
    await env.DB.batch(stmts);
    return { ok: true, items };
  } catch {
    for (const r2Key of uploaded) { try { await env.PROOFS!.delete(r2Key); } catch { /* */ } }
    return { ok: false, field: 'proofs' };
  }
}

/** 帖子的证明材料列表 */
export async function proofRows(env: Env, postId: string): Promise<ProofRow[]> {
  const rows = await env.DB.prepare(
    'SELECT id, w, h FROM post_proofs WHERE post_id = ?1 ORDER BY created_at ASC',
  ).bind(postId).all<{ id: string; w: number; h: number }>();
  return (rows.results || []).map((r) => ({ id: r.id, w: r.w, h: r.h }));
}

/** 级联删除帖子的证明材料（R2 对象 + 元数据行）：删帖与 cron 成交清理时调用 */
export async function deleteProofs(env: Env, postId: string): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      'SELECT r2_key FROM post_proofs WHERE post_id = ?1',
    ).bind(postId).all<{ r2_key: string }>();
    if (rows.results?.length) {
      await env.PROOFS!.delete(rows.results.map((r) => r.r2_key));
      await env.DB.prepare('DELETE FROM post_proofs WHERE post_id = ?1').bind(postId).run();
    }
  } catch { /* 级联清理失败不阻塞主流程 */ }
}

// GET /api/cardhub/posts/:id/proof/:key：证明材料图片
// 鉴权：proof_public=1 公众可读；否则仅发布者本人 / 管理员及以上
export async function handleProofImage(request: Request, env: Env, postId: string, key: string): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  if (!/^[A-Za-z0-9]{4,16}$/.test(key)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  const post = await env.DB.prepare('SELECT id, user_id, status, proof_public FROM posts WHERE id = ?1')
    .bind(postId).first<{ id: string; user_id: string; status: string; proof_public: number }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const isOwner = viewer && viewer.id === post.user_id;
  const isAdmin = viewer && (viewer.role === 'admin' || viewer.role === 'owner');
  const allowed = post.proof_public === 1 || isOwner || isAdmin;
  if (!allowed) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  // 非公开帖子（未过审/已下架）的照片仅本人与管理员可见
  if (post.status !== 'open' && !isOwner && !isAdmin) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const meta = await env.DB.prepare(
    'SELECT r2_key FROM post_proofs WHERE post_id = ?1 AND id = ?2',
  ).bind(postId, key).first<{ r2_key: string }>();
  if (!meta) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const obj = await env.PROOFS!.get(meta.r2_key);
  if (!obj) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const headers = new Headers({
    'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
    'Cache-Control': post.proof_public === 1 ? 'public, max-age=86400' : 'private, no-store',
  });
  return new Response(obj.body, { headers });
}
