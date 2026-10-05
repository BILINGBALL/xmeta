-- 换掉刷新令牌那套，改成「用户自选有效期」。
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

-- 手动失活功能已下线，清理遗留表。
drop table if exists token_revocation;
