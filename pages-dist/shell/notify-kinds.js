/* ═══════════════════════════════════════════════════════════════
   通知事件类型全量清单（前端唯一副本）
   ───────────────────────────────────────────────────────────────
   ▸ 与 Worker worker/src/common/notifications.ts 的 NOTIFY_KINDS /
     NOTIFY_KIND_LABELS 同源维护——两份各自收敛（前端一份、Worker 一份），
     不做接口下发（省一次前端请求）；新增/调整事件时两处同步修改
   ▸ 消费方：shell/auth.js（渠道级偏好勾选）、modules/admin/admin.js（站点白名单勾选）
   ▸ shell/notify.js 的 KIND_META 为纯表现层映射（图标/来源/跳转），
     渲染对未知 kind 有兜底，不属本清单收敛范围
   ═══════════════════════════════════════════════════════════════ */
"use strict";

export const NOTIFY_KINDS = [
  "act_approved", "act_rejected", "chat_approved", "chat_rejected",
  "act_retired", "act_expired",
  "link_approved", "link_rejected",
  "post_approved", "post_rejected", "post_closed", "post_expired",
  "post_expiring", "relay_request", "dm_message",
];

export const NOTIFY_KIND_LABELS = {
  act_approved: "情报投稿通过审核",
  act_rejected: "情报投稿被驳回",
  chat_approved: "社群投稿通过审核",
  chat_rejected: "社群投稿被驳回",
  act_retired: "情报/社群被管理组下架",
  act_expired: "情报/社群到期自动下展",
  link_approved: "工具提交通过审核",
  link_rejected: "工具提交被驳回",
  post_approved: "帖子审核通过",
  post_rejected: "帖子审核驳回",
  post_closed: "帖子被管理组关闭",
  post_expired: "帖子到期自动下架",
  post_expiring: "帖子临期提醒",
  relay_request: "收到站长中转意向",
  dm_message: "收到新私信",
};
