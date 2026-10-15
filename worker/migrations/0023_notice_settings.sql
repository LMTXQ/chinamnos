-- 0023: 公告/警告弹窗设置键（内容在 settings 表，版本号 = content 行的 updated_at）
--   cardhub_warning_*  号卡中心用户警告（访客每日重弹；登录用户首次同意后仅内容变更重弹）
--   site_notice_*      全站公告（所有人每日首进弹，可勾选「今日不再弹出」）
INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES
  ('cardhub_warning_enabled', 'false', 'seed', 0),
  ('site_notice_enabled', 'false', 'seed', 0);
