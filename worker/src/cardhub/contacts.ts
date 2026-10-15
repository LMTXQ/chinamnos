import type { Env } from '../common/env';
import { aesGcmEncrypt } from '../common/crypto';

const NOTIFY_CHANNELS = new Set(['wecom_bot', 'qmsg']);
/* 帖子联系方式渠道：与账号设置的 5 种联系方式类型保持一致 */
const CHAT_CHANNELS = new Set(['qq', 'wechat', 'phone', 'email', 'other']);

export interface ContactItem {
  purpose: 'notify' | 'chat';
  channel: string;
  value: string;
}

// 校验并加密 contacts（§9.1）：notify 值 AES-GCM 加密，chat 明文
export async function sanitizeContacts(
  raw: unknown,
  env: Env,
): Promise<{ ok: true; items: ContactItem[] } | { ok: false; field: string }> {
  if (!Array.isArray(raw)) return { ok: true, items: [] };
  const items: ContactItem[] = [];
  const seenNotify = new Set<string>();
  const seenChat = new Set<string>();

  for (const c of raw) {
    if (!c || typeof c !== 'object') return { ok: false, field: 'contacts' };
    const { purpose, channel, value } = c as Record<string, unknown>;
    if (typeof purpose !== 'string' || typeof channel !== 'string' || typeof value !== 'string') {
      return { ok: false, field: 'contacts' };
    }
    const v = value.replace(/[\r\n\x00-\x1f]/g, '').trim().slice(0, 200);
    if (!v) continue;

    if (purpose === 'notify') {
      if (!NOTIFY_CHANNELS.has(channel)) return { ok: false, field: 'contacts' };
      if (seenNotify.has(channel)) continue;
      seenNotify.add(channel);
      if (seenNotify.size > 2) return { ok: false, field: 'contacts' };
      const enc = await aesGcmEncrypt(env.CARDHUB_SECRET || 'fallback', v);
      items.push({ purpose: 'notify', channel, value: enc });
    } else if (purpose === 'chat') {
      if (!CHAT_CHANNELS.has(channel)) return { ok: false, field: 'contacts' };
      // 每种渠道至多一条（同渠道去重）；5 种渠道天然上限 5 条
      if (seenChat.has(channel)) continue;
      seenChat.add(channel);
      if (seenChat.size > 5) return { ok: false, field: 'contacts' };
      items.push({ purpose: 'chat', channel, value: v });
    } else {
      return { ok: false, field: 'contacts' };
    }
  }
  return { ok: true, items };
}

export interface ContactChannels {
  visibility: 'public' | 'users' | 'hidden';
  allowChat: 0 | 1;
  allowRelay: 0 | 1;
  legacyPolicy: string; // 兼容冗余：同步维护旧 contact_policy 列
}

/* 解析+校验联系渠道（§9.1 多渠道模型）：
   新字段 contact_visibility/allow_chat/allow_relay 优先；
   缺省时从旧单选策略 contact_policy 推导（兼容旧前端/青龙推送窗口期）。
   校验：visibility 枚举；hidden 时至少开一个渠道。返回错误 field 或解析结果 */
export function parseContactChannels(body: Record<string, unknown>): { error?: string; value?: ContactChannels } {
  const legacy = typeof body.contact_policy === 'string' ? body.contact_policy : '';
  const hasNew = body.contact_visibility !== undefined || body.allow_chat !== undefined || body.allow_relay !== undefined;
  let visibility: string;
  let allowChat = false;
  let allowRelay = false;
  if (hasNew) {
    visibility = typeof body.contact_visibility === 'string' && body.contact_visibility
      ? body.contact_visibility
      : (legacy === 'relay_online' || legacy === 'relay_owner' ? 'hidden' : (legacy || 'public'));
    allowChat = body.allow_chat === true || body.allow_chat === 1;
    allowRelay = body.allow_relay === true || body.allow_relay === 1;
  } else if (legacy === 'public') {
    visibility = 'public';
  } else if (legacy === 'users') {
    visibility = 'users';
  } else if (legacy === 'relay_online') {
    visibility = 'hidden'; allowChat = true;
  } else if (legacy === 'relay_owner') {
    visibility = 'hidden'; allowRelay = true;
  } else {
    return { error: 'contact' };
  }
  if (visibility !== 'public' && visibility !== 'users' && visibility !== 'hidden') return { error: 'contact_visibility' };
  if (visibility === 'hidden' && !allowChat && !allowRelay) return { error: 'contact' };
  const legacyPolicy = visibility === 'public' ? 'public'
    : visibility === 'users' ? 'users'
    : (allowChat ? 'relay_online' : 'relay_owner');
  return { value: { visibility, allowChat: allowChat ? 1 : 0, allowRelay: allowRelay ? 1 : 0, legacyPolicy } };
}
