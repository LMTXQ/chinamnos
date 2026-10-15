import type { Viewer } from '../common/auth';

// 帖子投影器（§9.3：唯一出口，视图永不自行判权）

export interface PostRow {
  id: string;
  user_id: string;
  board: string;
  carrier: string;
  province: string;
  city: string;
  title: string;
  descr: string;
  extra_json: string;
  images_json: string;
  contacts_json: string;
  contact_policy: string;
  contact_visibility: string;
  allow_chat: number;
  allow_relay: number;
  ttl_days: number;
  price_num: number | null;
  tags_json: string;
  status: string;
  post_no: number | null;
  phone_plain: string | null;
  proof_public: number;
  review_admin_id: string | null;
  pinned_at: number | null;
  created_at: number;
  expires_at: number | null;
  closed_at: number | null;
  reject_reason: string | null;
  submitted_at: number;
}

type Scope = 'public/list' | 'public/detail' | 'self';

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// 提取 chat 类联系方式（明文）
function plainChats(contacts: unknown): Array<{ channel: string; value: string }> {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .filter((c) => c && typeof c === 'object' && (c as { purpose?: string }).purpose === 'chat')
    .map((c) => ({ channel: (c as { channel: string }).channel, value: (c as { value: string }).value }));
}

export function serializePost(post: PostRow, viewer: Viewer | null, scope: Scope): Record<string, unknown> | null {
  // 公开视图：非 open 一律 null（上层转 404，不区分不存在/下架）
  if (scope.startsWith('public') && post.status !== 'open') return null;

  if (scope === 'public/list') {
    return {
      id: post.id,
      post_no: post.post_no,
      contact_policy: post.contact_policy, // 兼容冗余；列表卡徽章改用 contact_visibility
      contact_visibility: post.contact_visibility,
      allow_chat: post.allow_chat,
      allow_relay: post.allow_relay,
      pinned_at: post.pinned_at, // 精华置顶时间戳（前端据此渲染「精华」徽章；排序在 SQL 层完成）
      board: post.board,
      carrier: post.carrier,
      province: post.province,
      city: post.city,
      title: post.title,
      status: post.status, // 公开列表恒为 open；显式下发供前端过滤与角标使用
      extra: safeJson(post.extra_json, {}), // 板块规格字段（通话/流量/宽带/短信等），列表卡片直接展示
      tags: safeJson(post.tags_json, []),
      price_num: post.price_num,
      created_at: post.created_at,
      expires_at: post.expires_at,
    };
  }

  if (scope === 'public/detail') {
    const contacts = safeJson(post.contacts_json, []);
    const out: Record<string, unknown> = {
      id: post.id,
      post_no: post.post_no,
      board: post.board,
      carrier: post.carrier,
      province: post.province,
      city: post.city,
      title: post.title,
      status: post.status, // 公开详情恒为 open；显式下发供前端存在性判定
      descr: post.descr,
      extra: safeJson(post.extra_json, {}),
      images: safeJson(post.images_json, []),
      pinned_at: post.pinned_at, // 置顶帖的详情工具条据此渲染「取消置顶/置顶排序」
      ttl_days: post.ttl_days,
      created_at: post.created_at,
      expires_at: post.expires_at,
    };
    // 联系方式投影（§9.2 多渠道模型）：可见性决定 chats 是否下发；渠道开关恒下发供前端渲染入口
    //   visibility=public → 所有人可见；users → 仅登录可见；hidden → 不下发
    //   chatsVisible 区分「登录后可见」与「发布者未填写」
    const chatsAll = plainChats(contacts);
    const chatsVisible = post.contact_visibility === 'public' || (post.contact_visibility === 'users' && !!viewer?.id);
    out.contact = {
      visibility: post.contact_visibility,
      chats: chatsVisible ? chatsAll : [],
      chatsVisible,
      allowChat: !!post.allow_chat,
      allowRelay: !!post.allow_relay,
    };
    return out;
  }

  // self：本人视图，全部业务字段（notify 渠道在管理台才解密，此处整体 omit notify）
  // phone_plain（完整号码）仅本人可见：公众投影（public/*）永不返回该值
  const contacts = safeJson(post.contacts_json, []);
  const chats = plainChats(contacts);
  const selfExtra = safeJson<Record<string, unknown>>(post.extra_json, {});
  if (post.phone_plain) selfExtra.phone_num = post.phone_plain;
  return {
    id: post.id,
    post_no: post.post_no,
    board: post.board,
    carrier: post.carrier,
    province: post.province,
    city: post.city,
    title: post.title,
    descr: post.descr,
    extra: selfExtra,
    images: safeJson(post.images_json, []),
    contact_policy: post.contact_policy,
    contact_visibility: post.contact_visibility,
    allow_chat: post.allow_chat,
    allow_relay: post.allow_relay,
    contact: { type: 'self', chats, policy: post.contact_visibility, allowChat: !!post.allow_chat, allowRelay: !!post.allow_relay },
    pinned_at: post.pinned_at, // 本人视角同样下发：置顶帖详情工具条渲染「取消置顶/置顶排序」依赖此值
    ttl_days: post.ttl_days,
    price_num: post.price_num,
    tags: safeJson(post.tags_json, []),
    status: post.status,
    reject_reason: post.reject_reason,
    created_at: post.created_at,
    expires_at: post.expires_at,
    closed_at: post.closed_at,
    submitted_at: post.submitted_at,
  };
}
