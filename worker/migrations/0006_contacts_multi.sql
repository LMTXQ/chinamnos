-- 0006: 联系方式多类型化——users.contacts 存 JSON 数组 [{"type","value","pub"}]
-- 每类（qq/wechat/phone/other）至多一条；单条 ≤15 字（admin/owner 豁免，写入时校验）
-- 旧单值 contact + contact_public 迁移为 type=other 的 JSON 条目，保留公开状态
ALTER TABLE users ADD COLUMN contacts TEXT;

UPDATE users SET contacts = json_array(json_object('type','other','value',contact,'pub',COALESCE(contact_public,0)))
WHERE contact IS NOT NULL AND contact <> '' AND contact NOT LIKE '[%';
