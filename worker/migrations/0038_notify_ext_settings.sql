-- 0038: 站外通知推送（方案 B）设置项
-- 总开关默认关（功能上线后由站长在管理后台「站外通知推送」组开启）；
-- 事件白名单默认全部 15 种（到期帖等 cron 类事件在方案 B 阶段不会外推——即时分支跳过 cron 挂点，
-- 方案 C 青龙批量管线接管时按本白名单过滤）。
-- 同类过滤窗口默认 10 分钟（铃铛与外推共用闸门：同用户同事件类型同事件对象窗口内只写一条铃铛且只推一次，
-- 防私信刷屏刷爆铃铛与外部机器人；0 = 关闭过滤，上限 1440 = 24 小时）。
-- 保存即时生效（getSetting 30s isolate 缓存）。仅站长可修改（与邮件开关同档）。
INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES
  ('notify_ext_enabled', 'false', 'seed', 0),
  ('notify_ext_kinds', '["act_approved","act_rejected","chat_approved","chat_rejected","act_retired","act_expired","link_approved","link_rejected","post_approved","post_rejected","post_closed","post_expired","post_expiring","relay_request","dm_message"]', 'seed', 0),
  ('notify_throttle_minutes', '10', 'seed', 0);
