-- 换掉刷新令牌那套，改成「用户自选有效期 + 可手动失活」。
--
-- 用户在授权时自己决定这次管多久：3 / 6 / 12 / 24 小时，默认 6 小时。
-- 最长 24 小时意味着每天都要回中心 toy 续一次 —— 这是产品上想要的节奏，
-- 而不是靠刷新令牌把用户一直留在登录态里。
--
-- 刷新令牌（003）整个作废：两条长会话机制并存只会互相干扰，
-- 而且会让「token 有多久」这件事变得说不清。
-- 需要的话可以从 git 历史里捡回来（commit 5e50531）。

drop table if exists refresh_token;

-- 授权码上带着用户选的有效期，签发时按它算 exp
alter table auth_code add column if not exists ttl_seconds integer;

-- 手动失活。
--
-- 不追踪每一枚 token（那要为每个 jti 存一行、还要清理），
-- 而是记「某人在某个 toy 上、于某刻之前签发的全部 token 都作废」。
-- 判断时拿 token 的 iat 和这里的 revoked_at 比一下就行。
--
-- 按 toy_id 而不是 client_id 存：校验方手上只有 token，token 里带的
-- 是 aud（= toy_id），没有 client_id。按 client_id 存的话，校验时就
-- 得先反查一次，凭空多一步还可能查错。
--
-- 副作用是它也会挡掉失活之前签发、但还没到期的 token —— 这正是
-- 「退出这个游戏」该有的语义。
create table if not exists token_revocation (
  uid        bigint      not null references app_user(id) on delete cascade,
  toy_id     bigint      not null references toy(toy_id) on delete cascade,
  revoked_at timestamptz not null default now(),
  primary key (uid, toy_id)
);

create index if not exists token_revocation_uid_idx on token_revocation (uid);
