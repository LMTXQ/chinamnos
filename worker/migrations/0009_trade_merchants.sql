-- 0009: 交易方式配套设置——站长推荐的圈内卡商（JSON 字符串数组，仅展示参考，站点不为其担保）
-- 空数组时前端不显示推荐栏，只显示免责提示
INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES
  ('cardhub_trade_merchants', '[]', 'seed', 0);
