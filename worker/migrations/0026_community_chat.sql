-- 0026: 唠嗑聚落（activities 第三种形态 mode='chat'：社群收录）
--   chat_type：社群种类（论坛/QQ群/微信群/贴吧/纸飞机/其他，应用层校验）
--   chat_id：群号 / 微信号 / 账号名（≤50 字，卡片展示+复制；论坛类可空走 url）
--   proof_key：授权凭证（群主/管理员身份截图，R2 私有对象，仅管理组审核可见；选填）
ALTER TABLE activities ADD COLUMN chat_type TEXT;
ALTER TABLE activities ADD COLUMN chat_id TEXT;
ALTER TABLE activities ADD COLUMN proof_key TEXT;
