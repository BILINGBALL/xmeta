-- 排行榜：列表可以按数字标签排序（?sort=tagInt2&order=desc），
-- 一页拿前 100 条就够了，不用把所有人的行翻出来在客户端排。
--
-- 这两个索引只覆盖最常用的两个数字列；tag_bigint 排行很大时再加。
create index if not exists toy_data_scope_int2_idx
  on toy_data (toy_id, scope, tag_int2 desc);

create index if not exists toy_data_scope_int1_idx
  on toy_data (toy_id, scope, tag_int1 desc);
