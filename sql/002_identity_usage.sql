-- 身份使用记录。
--
-- 原来这份统计是从 auth_code 聚合出来的，但 auth_code 是短命凭证
-- （60 秒有效期，过期就该清）。拿它当历史数据源，等于把统计建在
-- 会被定期删掉的表上 —— 「我用过哪些玩具」会随清理缩水到只剩最近一天。
--
-- 所以拆开：
--   auth_code       只保留还活着的码，过期即清，不再承担历史职责
--   identity_usage  使用记录，一行 = 一个用户 × 一款玩具，长期保留
create table if not exists identity_usage (
  uid           bigint      not null references app_user(id) on delete cascade,
  toy_id        bigint      not null references toy(toy_id) on delete cascade,
  uses          integer     not null default 0,
  first_used_at timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  primary key (uid, toy_id)
);

create index if not exists identity_usage_recent_idx
  on identity_usage (uid, last_used_at desc);

-- 把已有的 auth_code 回填进来，别丢历史
insert into identity_usage (uid, toy_id, uses, first_used_at, last_used_at)
select a.uid, c.toy_id, count(*)::int, min(a.created_at), max(a.created_at)
  from auth_code a
  join toy_client c on c.client_id = a.client_id
 group by a.uid, c.toy_id
on conflict (uid, toy_id) do nothing;
