-- 0007: 个性签名（≤25 字，仅资料卡展示）；联系方式新增 email 类型、禁中文（写入时校验）
ALTER TABLE users ADD COLUMN bio TEXT;
