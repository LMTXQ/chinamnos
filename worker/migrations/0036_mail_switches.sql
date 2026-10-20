-- 邮件通知分场景开关（管理后台「邮件通知」组独立设置；验证码与超限汇总不受影响，站内通知不受影响）：
-- 默认全部开启（保持既有行为），关闭对应场景后该动作不再发邮件（站内通知照常）。保存即时生效。
INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES
  ('mail_post_review_enabled', 'true', 'seed', 0),
  ('mail_conversation_enabled', 'true', 'seed', 0),
  ('mail_relay_request_enabled', 'true', 'seed', 0),
  ('mail_post_expiring_enabled', 'true', 'seed', 0);
