-- 刷新令牌。
--
-- access_token 短命（默认 15 分钟），过期后由第三方玩具拿 refresh_token
-- 静默换一对新的，用户无感 —— 不需要再跳回中心玩具重新授权。
--
-- 三条安全约束：
--   1. 只存 sha256，不存明文。库被读走也不能直接拿去用。
--   2. 每次使用都轮换：发新的、废旧的。
--   3. family_id 串起同一条轮换链。已经用过的令牌再出现，
--      说明它被复制走了 —— 整条链立即作废，两边都得重新授权。
--
-- 另外 client_id 是绑定的一部分：给玩具 A 的令牌只能换出 aud=A 的
-- access_token，换个玩具用不了。
create table if not exists refresh_token (
  token_hash text        primary key,
  uid        bigint      not null references app_user(id) on delete cascade,
  client_id  text        not null references toy_client(client_id) on delete cascade,
  family_id  text        not null,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  revoked_at timestamptz
);

create index if not exists refresh_token_family_idx on refresh_token (family_id);
create index if not exists refresh_token_expires_idx on refresh_token (expires_at);
create index if not exists refresh_token_uid_idx on refresh_token (uid, client_id);
