-- 0011: 证明材料（出让/出租审核照片，存 R2 对象，元数据落 D1）
-- posts.proof_public：发布者选择的证明材料公开开关（0=不公开，默认；1=公开，公众详情可见缩略图）
-- post_proofs：每帖 1~3 张；key 随机 base62（URL 不可枚举）；r2_key = proofs/{post_id}/{key}.jpg
-- 删除帖子时级联删除本表行与 R2 对象（应用层处理）
ALTER TABLE posts ADD COLUMN proof_public INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS post_proofs (
  id         TEXT PRIMARY KEY,              -- 8 位随机 base62（对外 key，不可枚举）
  post_id    TEXT NOT NULL REFERENCES posts(id),
  r2_key     TEXT NOT NULL,                 -- R2 对象键
  w          INTEGER NOT NULL,
  h          INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proofs_post ON post_proofs(post_id, created_at);
