-- 0029: 号卡中心「站点担保」交易方式显示开关
--   true  = 发布表单显示「站点担保」选项（默认）
--   false = 发布表单不再显示该选项（schema 接口同步剔除，互动渠道「站长中转」一并隐藏）
--   已发布帖子不受影响：存量 trade_methods 照常展示，编辑旧帖时保留原勾选
INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES
  ('cardhub_trade_site_guarantee', 'true', 'seed', 0);
