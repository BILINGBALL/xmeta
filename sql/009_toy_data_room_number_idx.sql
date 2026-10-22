-- 房间号精确查 / 房间池：
--   GET /api/kv/lobby/list?tagBigint=123456
-- 隐藏房间也是 is_public，只是不进 tagTinyint=1 的池子，所以这个索引对
-- 「按房间号找到隐藏房间」同样有用。
create index if not exists toy_data_scope_bigint_idx
  on toy_data (toy_id, scope, tag_bigint);
