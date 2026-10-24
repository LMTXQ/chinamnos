-- 0040: 采集播报订阅偏好（方案批次二，沿用 user_notify_channels 原表，不建新表）
-- 开关复用 0037 预留的 collect_report 列；省份偏好照抄 0039 kinds_json 先例加一列。
-- provinces_json = 省份代码数组（如 ["hun","gd"]）；NULL/空数组 = 不限省份（全收，与站长配置语义一致）。
-- 省份代码权威来源在采集端（PROVINCES 表），此处不做白名单——未知代码在分发 join 时自然失效。
ALTER TABLE user_notify_channels ADD COLUMN provinces_json TEXT;
