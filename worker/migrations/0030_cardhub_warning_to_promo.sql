-- 0030: 号卡中心用户警告迁移为推广条目（NoticeGate 统一化阶段二）
--   ▸ cardhub_warning_enabled/content → promos[] 中一条 mode=must、scope.modules=["cardhub"] 的条目
--     （id 固定 promo_cardhub_warning；enabled 沿用原开关状态；原内容为空则不生成条目）
--   ▸ 弹出链路切换：notice.js maybeCardhubWarning() 下线，改由 shell.js activate →
--     maybePromosOnModuleEnter('cardhub') 接管（同为本模块强制同意门控）
--   ▸ 同意记录命名空间由 chinamnos_ack_cardhub_warning* 变为 chinamnos_ack_promo_cardhub_warning*，
--     全员会重新看到一次弹窗（一次性，可接受）
--   ▸ 迁移完成后删除旧键（内容已保留在推广条目中；未迁移即部署新代码的窗口期，
--     新旧前端对缺失的 cardhub_warning 响应均为静默 no-op，无破坏）

INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES ('promos', '[]', 'seed', 0);

UPDATE settings
SET value_json = json_insert(
      value_json,
      '$[#]',
      json_object(
        'id', 'promo_cardhub_warning',
        'enabled', CASE WHEN COALESCE((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'cardhub_warning_enabled'), 0) = 1
                        THEN json('true') ELSE json('false') END,
        'title', '用户警告与使用须知',
        'content', (SELECT json_extract(value_json, '$') FROM settings WHERE key = 'cardhub_warning_content'),
        'version', COALESCE((SELECT updated_at FROM settings WHERE key = 'cardhub_warning_content'),
                            CAST(strftime('%s','now') AS INTEGER) * 1000),
        'mode', 'must',
        'scope', json_object('carriers', json_array(), 'provinces', json_array(), 'modules', json_array('cardhub'))
      )
    ),
    updated_by = 'migration',
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE key = 'promos'
  AND value_json NOT LIKE '%promo_cardhub_warning%'
  AND COALESCE((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'cardhub_warning_content'), '') != '';

DELETE FROM settings WHERE key IN ('cardhub_warning_enabled', 'cardhub_warning_content');
