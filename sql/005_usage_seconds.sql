-- 使用记录里累加「发出去的凭证总时长」（守护时长）。
--
-- 其余几个统计（toy 数 / 用户数 / toyServices / 发放次数）现有字段就够：
-- identity_usage 一行 = 一个「用户 × toy」，行数就是 toyServices，sum(uses)
-- 就是发放次数。只有「时长」得单独累 —— auth_code 是短命凭证，清掉之后
-- 每次签发的 TTL 就再也回不来了，所以只能落在长期保留的这张表上。
--
-- 历史部分没法回填（那时候的 auth_code 早被清理了），这列从本次迁移之后
-- 开始累计。
alter table identity_usage
  add column if not exists seconds bigint not null default 0;
