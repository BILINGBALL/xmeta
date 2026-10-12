-- 有效期从「创建时定死、编辑不续期」改成「每次写可以带 ttl（秒），从当前时刻重算」。
--
-- 原设计：expires_at = created_at + ttlDays，并用下面这条 CHECK 钉死在 30 天以内
--   expires_at <= created_at + interval '30 days'
-- 一条数据能活多久，创建那一刻就定了，之后改多少次都不动。
--
-- 现在：写的时候带 ttl（秒）就把 expires_at 重算成 now() + ttl；**不带就一动不动**
-- （顺手改个字段不该把有效期也改掉）。单次最多 30 天，由应用层
-- （src/http.ts 的 ttlSchema）把关，但**续期本身不封顶** —— 一直写就能一直活着。
--
-- CHECK 里不能用 now()（不是 immutable 函数），「不超过 30 天」这条在数据库层
-- 没法表达了，只能留在应用层。这里退化成一条列间比较当兜底。
alter table toy_data drop constraint if exists toy_data_expires_ck;

alter table toy_data
  add constraint toy_data_expires_ck check (expires_at > created_at);

comment on column toy_data.expires_at is
  '过期时刻。写入带 ttl（秒）时从当前时刻重算，不带就不变；单次最长 30 天';
