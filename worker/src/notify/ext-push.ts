import type { Env } from '../common/env';
import { getSetting } from '../common/settings';
import { loadActiveBindings, SITE_NAME } from '../auth/notify-channels';
import { getChannel } from './channels';

/* ── 即时外推执行体（站外通知推送方案 B）──
   事件发生 → 校验 总开关/事件白名单 → 逐绑定直发已注册渠道。
   同类消息短期过滤在 pushNotification 上游闸门统一执行（铃铛与外推共用）。
   cron 分支（到期帖等）不走本模块——由方案 C 的青龙批量管线接管，避免双发。
   全程尽力而为：任何失败静默（仅 console 记录），绝不影响主流程。 */

/* 全部通知事件类型（与 common/notifications.ts 的 NotificationKind 一一对应；
   单列一份常量供 settings 校验与未来方案 C 批量组装复用） */
export const NOTIFY_KINDS = [
  'act_approved', 'act_rejected', 'chat_approved', 'chat_rejected',
  'act_retired', 'act_expired',
  'link_approved', 'link_rejected',
  'post_approved', 'post_rejected', 'post_closed', 'post_expired',
  'post_expiring', 'relay_request', 'dm_message',
] as const;

/* 管理后台白名单勾选项的中文标签 */
export const NOTIFY_KIND_LABELS: Record<string, string> = {
  act_approved: '情报投稿通过审核',
  act_rejected: '情报投稿被驳回',
  chat_approved: '社群投稿通过审核',
  chat_rejected: '社群投稿被驳回',
  act_retired: '情报/社群被管理组下架',
  act_expired: '情报/社群到期自动下展',
  link_approved: '工具提交通过审核',
  link_rejected: '工具提交被驳回',
  post_approved: '帖子审核通过',
  post_rejected: '帖子审核驳回',
  post_closed: '帖子被管理组关闭',
  post_expired: '帖子到期自动下架',
  post_expiring: '帖子临期提醒',
  relay_request: '收到站长中转意向',
  dm_message: '收到新私信',
};

/* 即时事件外推：由 pushNotification 钩子触发（fire-and-forget，调用方不 await）。
   同类过滤在上游闸门（notifications.ts）已完成——走到这里的事件均未命中过滤窗口。 */
export async function extPushInstant(env: Env, userId: string, kind: string, title: string, body: string): Promise<void> {
  try {
    const enabled = await getSetting<boolean>(env, 'notify_ext_enabled', false);
    if (!enabled) return;

    // 事件白名单：数组存在即视为权威清单（空数组 = 什么都不推）；键不存在 = 未配置，放行
    const kinds = await getSetting<unknown>(env, 'notify_ext_kinds', null);
    if (Array.isArray(kinds) && !kinds.includes(kind)) return;

    const bindings = await loadActiveBindings(env, userId);
    // 渠道级偏好过滤（kinds=null 未配置全收）+ bulkOnly 渠道（邮件）不参与即时分支
    const targets = bindings.filter((b) => {
      if (b.kinds && !b.kinds.includes(kind)) return false;
      const def = getChannel(b.channel_type);
      return !!def && !def.bulkOnly;
    });
    if (!targets.length) return;

    const text = (body || '').slice(0, 500);
    // 统一消息模板（站长定版）：站点标识 + 可点击网址 + 事件内容 + 关闭打扰指引
    const site = env.PUBLIC_BASE_URL || 'https://chinamnos.ftac.dpdns.org';
    const pushTitle = `【${SITE_NAME}】消息通知`;
    const content =
      `站点：[${site.replace(/^https:\/\//, '')}](${site})\n\n` +
      `正文：${title}${text ? `\n${text}` : ''}\n\n` +
      `若希望关闭打扰，请前往站点关闭外接消息通知或解绑通知渠道。`;
    // 多渠道并行发送：压缩请求内耗时（外推在请求生命周期内确定性执行，见 pushNotification）
    await Promise.allSettled(
      targets.map(async (b) => {
        const def = getChannel(b.channel_type);
        if (!def) return;
        try {
          const r = await def.send(b.cred, pushTitle, content);
          if (!r.ok) console.warn(`[ext-push] ${b.channel_type} failed: ${r.error}`);
        } catch (e) {
          console.warn(`[ext-push] ${b.channel_type} error: ${String(e)}`);
        }
      }),
    );
  } catch {
    /* 外推是主流程的附属动作，任何异常静默 */
  }
}
