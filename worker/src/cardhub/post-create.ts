import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { randomBase62 } from '../common/crypto';
import { sanitizeContacts, parseContactChannels } from './contacts';
import { saveProofs } from './proofs';
import { BOARDS, CARRIERS, TTL_OPTIONS, TRADE_METHODS, validateBoardFields, validateTradeGuarantors } from './schema';

const VALID_BOARDS = new Set<string>(BOARDS.map((b) => b.id));
const VALID_CARRIERS = new Set(CARRIERS.map((c) => c.id));
const VALID_TRADES = new Set(TRADE_METHODS.map((t) => t.id));

// POST /api/cardhub/posts：发布帖子（pending 配额 <3，§8.1）
export async function handleCreatePost(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const board = typeof body.board === 'string' ? body.board : '';
  const carrier = typeof body.carrier === 'string' ? body.carrier : '';
  const province = typeof body.province === 'string' ? body.province.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const descr = typeof body.descr === 'string' ? body.descr.trim() : '';
  /* 多渠道模型：contact_visibility/allow_chat/allow_relay 优先，旧单选策略推导兜底 */
  const channels = parseContactChannels(body);
  if (channels.error || !channels.value) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: channels.error || 'contact' });
  const ttlDays = Number(body.ttl_days);
  const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
  const tags = Array.isArray(body.tags) ? body.tags.slice(0, 5) : [];

  if (!VALID_BOARDS.has(board)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'board' });
  /* 市集（权益回收）与运营商/省份无关：carrier/province/city 允许为空（列 NOT NULL，空串合法）；
     descr 允许为空（图文介绍为主体），仅保留长度上限 */
  const isMarket = board === 'market';
  if (!isMarket && !VALID_CARRIERS.has(carrier)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'carrier' });
  if (!isMarket && (!province || !city)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'province' });
  if (title.length < 2 || title.length > 60) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'title' });
  if (isMarket ? descr.length > 2000 : (descr.length < 5 || descr.length > 2000)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'descr' });
  if (!TTL_OPTIONS.includes(ttlDays)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'ttl_days' });
  /* 联系渠道校验由 parseContactChannels 统一承担（新字段优先 / 旧单选推导，枚举外即 error） */

  // 交易方式（多选，选填）：值 ∈ TRADE_METHODS、去重；选「站长中转」必须同时选「站点担保」
  const rawTrades = Array.isArray(body.trade_methods) ? body.trade_methods : [];
  const tradeMethods: string[] = [];
  for (const t of rawTrades) {
    const ts = typeof t === 'string' ? t.trim() : '';
    if (!VALID_TRADES.has(ts)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'trade_methods' });
    if (!tradeMethods.includes(ts)) tradeMethods.push(ts);
  }
  if (tradeMethods.length > TRADE_METHODS.length) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'trade_methods' });
  if (channels.value.allowRelay && !tradeMethods.includes('site')) {
    return fail(ERR.VALIDATION_ERROR, 'TRADE_SITE_REQUIRED', 400, { field: 'trade_methods' });
  }
  if (tradeMethods.length) (extra as Record<string, unknown>).trade_methods = tradeMethods;

  // 发帖担保人（选填）：从站长推荐卡商候选池中选择 ≤3 位；不勾选「圈内卡商担保」不能选担保人。
  // 恒以服务端校验结果为准写入/清除，防客户端在 extra 里伪造 trade_guarantors 刷统计
  const guarantors = await validateTradeGuarantors(env, body.trade_guarantors, tradeMethods);
  if (guarantors.error) return fail(ERR.VALIDATION_ERROR, guarantors.error, 400, { field: 'trade_guarantors' });
  const extraRec = extra as Record<string, unknown>;
  if (guarantors.names.length) extraRec.trade_guarantors = guarantors.names;
  else delete extraRec.trade_guarantors;

  // 证明材料：出让(found)/出租(rent_out) 必须二选一——上传 1~3 张照片，或指定管理员实名审核
  // 选「管理员审核」时：该帖仅由站长或该管理员审核，队列特别提醒未上传资料
  const needProof = board === 'found' || board === 'rent_out';
  const proofPublic = body.proof_public === true ? 1 : 0;
  const rawProofs = Array.isArray(body.proofs) ? body.proofs : [];
  const reviewAdminId = typeof body.review_admin_id === 'string' ? body.review_admin_id.trim() : '';
  if (rawProofs.length && reviewAdminId) {
    return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'proofs' });
  }
  if (needProof && rawProofs.length === 0 && !reviewAdminId) {
    return fail(ERR.VALIDATION_ERROR, 'PROOFS_REQUIRED', 400, { field: 'proofs' });
  }
  if (!needProof && (rawProofs.length > 0 || reviewAdminId)) {
    return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'proofs' });
  }
  if (reviewAdminId) {
    const admin = await env.DB.prepare(
      `SELECT id, role, status FROM users WHERE id = ?1`,
    ).bind(reviewAdminId).first<{ id: string; role: string; status: string }>();
    if (!admin || !['admin', 'owner'].includes(admin.role) || admin.status !== 'active') {
      return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'review_admin_id' });
    }
  }

  // 号码隐私拦截（必须先于 validateBoardFields：phone_masked required 字段依赖此处的自动打码）：
  // extra.phone_num（完整号码）→ posts.phone_plain 独立列（公众投影永不返回）；公众仅见 extra.phone_masked。
  // masked 缺省时自动生成（前3 + * + 后4）；found 出让号码必填
  const extraRec0 = extra as Record<string, unknown>;
  const phonePlain = typeof extraRec0.phone_num === 'string' ? extraRec0.phone_num.trim() : '';
  delete extraRec0.phone_num;
  if (board === 'found' && !phonePlain) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'phone_num' });
  if (phonePlain) {
    if (!/^\d{4,20}$/.test(phonePlain)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'phone_num' });
    let masked = typeof extraRec0.phone_masked === 'string' ? extraRec0.phone_masked.trim() : '';
    if (!masked) {
      masked = phonePlain.length >= 8
        ? phonePlain.slice(0, 3) + '*'.repeat(phonePlain.length - 7) + phonePlain.slice(-4)
        : phonePlain.slice(0, 1) + '*'.repeat(Math.max(phonePlain.length - 2, 1)) + (phonePlain.length > 1 ? phonePlain.slice(-1) : '');
      extraRec0.phone_masked = masked;
    }
    if (masked.length > 24) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'phone_masked' });
  } else if (!extraRec0.phone_masked) {
    delete extraRec0.phone_masked;
  }

  // 板块字段校验（§9 配置驱动，与 post-update 共用 validateBoardFields）
  const extraRec = extra as Record<string, unknown>;
  const badField = validateBoardFields(board, extraRec);
  if (badField) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: badField });

  // 联系方式校验+加密
  const contacts = await sanitizeContacts(body.contacts, env);
  if (!contacts.ok) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: contacts.field });

  // pending 配额：同账号 pending < 3
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM posts WHERE user_id = ?1 AND status = 'pending'`,
  ).bind(viewer.id).first<{ c: number }>();
  if ((pending?.c ?? 0) >= 3) return fail(40901, 'PENDING_QUOTA_EXCEEDED', 409);

  // 价格解析（分，仅排序用）：车队按上车车费（司机收入），其余沿用月租/预算
  const priceKeys = board === 'fleet' ? ['car_fee'] : ['monthly_fee', 'budget'];
  let priceNum: number | null = null;
  for (const k of priceKeys) {
    const v = Number(extraRec[k]);
    if (Number.isFinite(v) && v > 0) { priceNum = Math.round(v * 100); break; }
  }

  const now = Date.now();
  const id = randomBase62(12);

  await env.DB.prepare(
    `INSERT INTO posts (id, user_id, board, status, carrier, province, city, title, descr,
       extra_json, images_json, contacts_json, contact_policy, contact_visibility, allow_chat, allow_relay,
       ttl_days, price_num, tags_json,
       phone_plain, post_no, proof_public, review_admin_id,
       submitted_at, created_at, updated_at)
     VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8,?9,'[]',?10,?11,?12,?13,?14,?15,
       ?16,?17,?18,
       (SELECT COALESCE(MAX(post_no), 1000) + 1 FROM posts),
       ?19,?20,?21,?22,?23)`,
  ).bind(
    id, viewer.id, board, carrier, province, city, title, descr,
    JSON.stringify(extra), JSON.stringify(contacts.items), channels.value.legacyPolicy,
    channels.value.visibility, channels.value.allowChat, channels.value.allowRelay,
    ttlDays,
    priceNum, JSON.stringify(tags), phonePlain || null, proofPublic,
    reviewAdminId || null, now, now, now,
  ).run();

  // 证明材料（R2 上传 + 元数据落库）；失败则整单回滚语义：删帖返回错误
  if (rawProofs.length) {
    const saved = await saveProofs(env, id, rawProofs);
    if (!saved.ok) {
      await env.DB.prepare('DELETE FROM posts WHERE id = ?1').bind(id).run();
      return fail(ERR.VALIDATION_ERROR, 'PROOFS_INVALID', 400, { field: 'proofs' });
    }
  }

  return ok({ id, status: 'pending' });
}
