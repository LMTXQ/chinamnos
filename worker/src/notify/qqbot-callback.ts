// QQ 官方机器人回调路由（增量 2）：POST /api/notify/qqbot/callback（公开路由，QQ 平台 → Worker）。
// 职责 = 获取 group_openid 的唯一途径 + 绑定码激活/追加群：
//   ① op=13 URL 验证握手：按 X-Bot-Appid 找 qqbot 绑定行 → AppSecret 派生私钥对
//      `event_ts + plain_token` 签名 → 返回 {plain_token, signature}；
//   ② op=0 事件派发：验签 X-Signature-Ed25519（hex，timestamp + body）→
//      GROUP_AT_MESSAGE_CREATE：content 中提取 6 位绑定码 → 按 verify_code_hash 匹配同 appid 的
//      未过期未消费行（pending = 首绑激活；active = 追加群）→ group_openid 追加进 cred.targets 回写
//      → 被动回复确认（引用 msg_id，5 分钟窗口内）；
//      GROUP_DEL_ROBOT：机器人被移出群 → 从对应行 targets 移除该群。
// 安全：op=0 一律先验签再处理；未匹配 appid / 验签失败 → 404/200 空响应（不喂平台重试风暴），
// 仅 console 记录。行级 id 寻址就绪：当前按 (user_id, channel_type) 唯一行语义，增量 3 后兼容多行。
import type { Env } from '../common/env';
import { sha256Hex } from '../common/crypto';
import { sealCred, openCred } from './channels';
import { qqbotSignValidation, qqbotVerifyEvent, qqbotSendGroup, type QqBotCred } from './qqbot';

interface CallbackPayload {
  op?: number;
  id?: string;
  t?: string;
  d?: Record<string, unknown>;
}

interface NchRow {
  id: string;
  user_id: string;
  status: string;
  cred_enc: string;
  verify_code_hash: string | null;
  verify_expires_at: number | null;
  cred: QqBotCred;
}

// 该 appid 下的全部 qqbot 绑定行（解密 cred 匹配 appid；行数=用户数级别，逐行解密开销可忽略）
async function loadRowsByAppid(env: Env, appid: string): Promise<NchRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, status, cred_enc, verify_code_hash, verify_expires_at
     FROM user_notify_channels WHERE channel_type = 'qqbot' AND status IN ('pending', 'active')`,
  ).all<{ id: string; user_id: string; status: string; cred_enc: string; verify_code_hash: string | null; verify_expires_at: number | null }>();
  const out: NchRow[] = [];
  for (const r of rows.results || []) {
    try {
      const cred = await openCred(env, r.cred_enc) as unknown as QqBotCred;
      if (cred && cred.appid === appid && cred.secret) {
        out.push({ ...r, cred });
      }
    } catch { /* 单行解密失败跳过 */ }
  }
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function handleQqBotCallback(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const appid = request.headers.get('X-Bot-Appid') || '';
  let payload: CallbackPayload;
  try { payload = JSON.parse(rawBody) as CallbackPayload; } catch { return json({ err: 'bad json' }, 400); }

  // 按 appid 定位绑定行（验签与握手都需要 secret；无匹配 = 该机器人未绑定本站）
  if (!appid) return json({ err: 'missing appid' }, 400);
  const rows = await loadRowsByAppid(env, appid).catch(() => [] as NchRow[]);
  if (!rows.length) return json({ err: 'unknown appid' }, 404);
  const secret = rows[0].cred.secret;

  // ① URL 验证握手（op 13）：签名 event_ts + plain_token 原样返回
  if (payload.op === 13) {
    const d = payload.d || {};
    const plainToken = String(d.plain_token || '');
    const eventTs = String(d.event_ts || '');
    if (!plainToken || !eventTs) return json({ err: 'bad validation payload' }, 400);
    const signature = await qqbotSignValidation(secret, eventTs, plainToken);
    return json({ plain_token: plainToken, signature });
  }

  // ② 事件派发：先验签（timestamp + rawBody）
  const sig = request.headers.get('X-Signature-Ed25519') || '';
  const ts = request.headers.get('X-Signature-Timestamp') || '';
  if (!sig || !ts) return json({ err: 'missing signature' }, 401);
  const valid = await qqbotVerifyEvent(secret, ts, rawBody, sig);
  if (!valid) {
    console.warn(`[qqbot-callback] 签名校验失败 appid=${appid}`);
    return json({ err: 'invalid signature' }, 401);
  }

  try {
    if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
      await handleGroupMessage(env, rows, payload);
    } else if (payload.t === 'GROUP_DEL_ROBOT') {
      await handleGroupRemoved(env, rows, payload);
    }
    // 其他事件类型（GROUP_ADD_ROBOT 等）暂不处理，200 空响应即可
  } catch (e) {
    console.error('[qqbot-callback] 处理失败:', e); // 尽力而为：失败不影响给平台回 200
  }
  return json({ ok: true });
}

/** 群内 @机器人 消息：提取 6 位绑定码 → 按码寻行（未过期未消费）→ 追加 group_openid → 激活/回写 → 被动回复 */
async function handleGroupMessage(env: Env, rows: NchRow[], payload: CallbackPayload): Promise<void> {
  const d = payload.d || {};
  const groupOpenid = String(d.group_openid || '');
  const content = String(d.content || '');
  const msgId = String(d.id || '');
  if (!groupOpenid) return;
  const m = /(\d{6})/.exec(content.replace(/\s+/g, ''));
  const code = m ? m[1] : '';
  if (!code) return;

  const hash = await sha256Hex(code);
  const now = Date.now();
  const row = rows.find((r) => r.verify_code_hash === hash && (r.verify_expires_at ?? 0) > now);
  if (!row) {
    // 无匹配码：可能是闲聊/过期码/已消费码。仅在内容近似绑定码时提示，避免打扰
    if (/^\s*\d{6}\s*$/.test(content)) {
      await qqbotSendGroup(rows[0].cred, groupOpenid, {
        msg_type: 0,
        content: '未匹配到有效绑定码（已过期或已使用）。请回到站点通知配置重新获取，再在群内 @机器人 发送。',
        ...(msgId ? { msg_id: msgId, msg_seq: 1 } : {}),
      }).catch(() => undefined);
    }
    return;
  }

  const cred = row.cred;
  const targets = Array.isArray(cred.targets) ? cred.targets.filter(Boolean) : [];
  const already = targets.includes(groupOpenid);
  const nextTargets = already ? targets : [...targets, groupOpenid];
  // cred 含 targets 数组，超出 ChannelCred(Record<string,string>) 的窄类型——落库经 sealCred 时收窄断言
  const credEnc = await sealCred(env, { ...cred, targets: nextTargets } as unknown as Record<string, string>);

  if (row.status === 'pending') {
    await env.DB.prepare(
      `UPDATE user_notify_channels SET cred_enc = ?1, status = 'active', target_hint = ?2,
       verify_code_hash = NULL, verify_expires_at = NULL WHERE id = ?3 AND user_id = ?4`,
    ).bind(credEnc, `QQ机器人 ${cred.appid.slice(-4)} · ${nextTargets.length} 个群`, row.id, row.user_id).run();
  } else {
    // 已生效实例追加群：消费绑定码（清 hash），其余字段不动
    await env.DB.prepare(
      `UPDATE user_notify_channels SET cred_enc = ?1, target_hint = ?2,
       verify_code_hash = NULL, verify_expires_at = NULL WHERE id = ?3 AND user_id = ?4`,
    ).bind(credEnc, `QQ机器人 ${cred.appid.slice(-4)} · ${nextTargets.length} 个群`, row.id, row.user_id).run();
  }

  // 被动回复确认（引用 msg_id，5 分钟窗口内额度宽松）
  const reply = already
    ? '该群已在绑定列表中，无需重复绑定。'
    : `✅ 绑定成功（第 ${nextTargets.length} 个群）。站点通知将发送到本群；如需关闭请前往站点解绑。`;
  const r = await qqbotSendGroup(cred, groupOpenid, {
    msg_type: 0,
    content: reply,
    ...(msgId ? { msg_id: msgId, msg_seq: 1 } : {}),
  });
  if (!r.ok) console.warn(`[qqbot-callback] 确认回复失败: ${r.error}`);
}

/** 机器人被移出群：从所有含该群的行移除 target（保持 targets 与实际在群状态一致） */
async function handleGroupRemoved(env: Env, rows: NchRow[], payload: CallbackPayload): Promise<void> {
  const groupOpenid = String(payload.d?.group_openid || '');
  if (!groupOpenid) return;
  for (const row of rows) {
    const targets = Array.isArray(row.cred.targets) ? row.cred.targets.filter(Boolean) : [];
    if (!targets.includes(groupOpenid)) continue;
    const next = targets.filter((t) => t !== groupOpenid);
    const credEnc = await sealCred(env, { ...row.cred, targets: next } as unknown as Record<string, string>);
    await env.DB.prepare(
      `UPDATE user_notify_channels SET cred_enc = ?1, target_hint = ?2 WHERE id = ?3 AND user_id = ?4`,
    ).bind(credEnc, `QQ机器人 ${row.cred.appid.slice(-4)} · ${next.length} 个群`, row.id, row.user_id).run();
  }
}
