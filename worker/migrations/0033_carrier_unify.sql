-- 运营商命名统一到资费口径：cardhub 体系值(unicom/telecom) → 资费口径(cucc/ctcc)
-- activities 表承载情报酒馆(official/guide)与唠嗑聚落(chat)；posts 为号卡库存
UPDATE activities SET carrier = 'ctcc' WHERE carrier = 'telecom';
UPDATE activities SET carrier = 'cucc' WHERE carrier = 'unicom';
UPDATE posts SET carrier = 'ctcc' WHERE carrier = 'telecom';
UPDATE posts SET carrier = 'cucc' WHERE carrier = 'unicom';
-- 推广条目运营范围（settings.promos JSON 内带引号的 "telecom"/"unicom" 范围值）
UPDATE settings SET value_json = REPLACE(REPLACE(value_json, '"telecom"', '"ctcc"'), '"unicom"', '"cucc"') WHERE key = 'promos';
