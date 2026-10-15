-- 0012: 证明材料二选一——管理员实名审核模式
-- review_admin_id 非空 = 「管理员审核」模式：该帖仅由站长(owner)或该指定管理员审核，
-- 审核队列需特别提醒「未上传证明材料，请确认是否已通过其他渠道核实」；
-- NULL = 普通审核流（默认，全部管理员可审，found/rent_out 需上传 1~3 张证明材料）
ALTER TABLE posts ADD COLUMN review_admin_id TEXT REFERENCES users(id);
