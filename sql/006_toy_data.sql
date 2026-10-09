-- 联机数据交换容器。
--
-- 一行 = 一个用户在某个 scope 下的一格。这里**不是长期存储** —— 作者那边
-- 该有自己的持久化（toy 云存储 / 本地），xmeta 只负责「把数据从 A 交换到 B」。
-- 所以有两条硬约束：额度（普通用户每 toy 64 行，作者 256 行）和强制过期。
--
-- 权限模型（全部在 src/routes/data.ts 里实现）：
--   读    is_public 的 + 自己的；作者能读本 toy 全部（含别人的私有行）
--   写    自己的行全字段；别人的行只能改 open_edit 里列的字段；作者全字段
--   建    admin* 开头的 scope 只有作者能建；其余任何人可建（uid 只能是自己）
--   删    只有作者（删一行 / 删掉整个 scope，日志级联跟着走）

create table if not exists toy_data (
  id          bigserial   primary key,

  -- 归属。两列都不接受客户端传值：toy_id 取自 JWT 的 aud，uid 取自 sub
  -- （唯一的例外是作者可以显式指定 uid，替玩家建行）
  uid         bigint      not null references app_user(id) on delete cascade,
  toy_id      bigint      not null references toy(toy_id) on delete cascade,
  scope       varchar(16) not null,

  -- 可见性。false = 只有属主和作者看得见（注意：作者始终看得见）
  is_public   boolean     not null default false,

  -- 别人能改哪些字段。空数组 = 谁都不能改（即所谓 public_read 状态）。
  -- 永远不包含 extra —— 这一列别人只能看，不能改。
  open_edit   text[]      not null default '{}',

  -- 数字标签，语义由 toy 自己定（作者用它做筛选）
  tag_tinyint smallint,
  tag_int1    smallint,
  tag_int2    integer,
  tag_bigint  bigint,

  -- 文本：短 / 中 / 长三档，超长请放 extra
  text_1      varchar(128),
  text_2      varchar(512),
  text_long   text        check (text_long is null or length(text_long) <= 1024),

  -- 容器：里面放什么由作者定。API 限制序列化后 2048 字节，这里留 2 字节容错
  extra       jsonb       check (extra is null or octet_length(extra::text) <= 2050),

  -- 强制过期：创建时定 1~30 天（任意整数，默认 7）；之后最多改到「创建时刻 + 30 天」；
  -- 任何编辑都不续期。到点由清理任务删掉。
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint toy_data_scope_ck check (scope ~ '^[a-z][a-z0-9_]{0,15}$'),

  -- 白名单里没有 extra / scope / uid / is_public / open_edit / expires_at ——
  -- 敏感字段物理上写不进 open_edit，API 就算写错也越不了权
  constraint toy_data_open_edit_ck check (
    open_edit <@ array['tag_tinyint','tag_int1','tag_int2','tag_bigint',
                       'text_1','text_2','text_long']::text[]
  ),

  -- 私有行谈「别人能改」没有意义（别人根本看不到）
  constraint toy_data_open_edit_public_ck check (open_edit = '{}' or is_public),

  constraint toy_data_expires_ck check (
    expires_at > created_at and expires_at <= created_at + interval '30 days'
  ),

  -- 一格一行
  unique (toy_id, scope, uid)
);

comment on table toy_data is '联机数据交换容器：一行 = 一个用户在一个 scope 下的一格';
comment on column toy_data.uid        is '用户 id（JWT 的 sub）。作者可替玩家指定';
comment on column toy_data.scope      is '业务分类，如 package/bag/roles/weapon；admin* 保留给作者';
comment on column toy_data.is_public  is 'false = 只有属主和作者可见';
comment on column toy_data.open_edit  is '允许他人编辑的字段名；空数组 = 只读';
comment on column toy_data.extra      is '自定义容器，永远不参与 open_edit';
comment on column toy_data.expires_at is '强制过期时刻，不因编辑而续期';

-- 按人捞（几万人里查某个人）：唯一键里 scope 卡在中间，用不上这一条
create index if not exists toy_data_by_uid_idx on toy_data (toy_id, uid);
-- 过期清理
create index if not exists toy_data_expire_idx on toy_data (expires_at);
-- 按 tag 筛选。「所有人的 package」走唯一键的前两列就够了
create index if not exists toy_data_filter_idx on toy_data (toy_id, scope, tag_tinyint);

-- ---------------------------------------------------------------- 改动日志
--
-- 只追加，不修改不删除。随记录一起删（on delete cascade）。
-- 有额度、有强制过期，所以这张表不会无界增长。

create table if not exists toy_data_log (
  id         bigserial   primary key,
  data_id    bigint      not null references toy_data(id) on delete cascade,
  actor_uid  bigint      references app_user(id) on delete cascade,
  -- 没有 delete 这种动作：日志随记录级联删除，记了也立刻没
  action     text        not null check (action in ('create', 'update')),
  /** 这次改了哪些字段；delete 时为空 */
  changed    text[]      not null default '{}',
  /** 只存被改字段的旧值 / 新值，不是整行 —— 否则改一次 extra 就存两份 2KB */
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);

comment on table toy_data_log is '数据改动日志：只追加，权限跟着记录走';
comment on column toy_data_log.actor_uid is '真正动手的人（作者替玩家改时是作者）';

create index if not exists toy_data_log_page_idx on toy_data_log (data_id, id desc);
