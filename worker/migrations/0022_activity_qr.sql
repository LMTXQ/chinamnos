-- 0022: 活动集锦二维码（选填，随提交上传）
--   R2 存对象（PROOFS 桶 activities/<id>/qr.<ext>），D1 只存对象键；NULL = 无二维码
--   展示走 GET /api/activities/:id/qr（open 状态公开可读，其余仅提交者与管理组）
ALTER TABLE activities ADD COLUMN qr_key TEXT;
