-- 0044: 通知渠道同类型多实例绑定（增量 3）
-- 拆除 (user_id, channel_type) 唯一索引：同渠道可并存多个生效实例（名额改按总行数计，MAX_BINDINGS 维持 3）。
-- 防重改业务层软提示（target_hint 尾号碰撞不硬拦）；email 凭证即账号邮箱，单绑定由业务层保证。
-- 执行后必须立即 SELECT 验证索引已拆（D1 migration 偶发静默失败为已知坑）。
DROP INDEX IF EXISTS idx_nch_user_type;
