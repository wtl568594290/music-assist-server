-- 文档列表：position 保留请求中的原始顺序，imgs 为 ImgBrief 数组的 JSON
CREATE TABLE IF NOT EXISTS docs (
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  imgs TEXT NOT NULL
);

-- 图片映射：img_key = hash + name，filename = hash + ext（对应 R2 对象 key）
CREATE TABLE IF NOT EXISTS images (
  img_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  ext TEXT NOT NULL,
  filename TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_filename ON images (filename);
