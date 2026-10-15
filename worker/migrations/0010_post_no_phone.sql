-- 0010: 帖子人类友好编号 + 出让/求购完整号码（隐私：公众接口不返回）
-- post_no：自增展示编号（起始 1001，INSERT 时 MAX+1 原子生成），方便沟通与查找
-- phone_plain：号码完整值（仅站点保存与发布者本人可见，公众投影永不返回；公众只见 extra_json.phone_masked）
ALTER TABLE posts ADD COLUMN post_no INTEGER;
ALTER TABLE posts ADD COLUMN phone_plain TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_no ON posts(post_no) WHERE post_no IS NOT NULL;

-- 存量帖回填编号（按 rowid 顺序，从 1001 起）
UPDATE posts SET post_no = 1000 + rowid WHERE post_no IS NULL;
