-- xmeta: B站 Toy 跨 toy 身份桥 —— 初始 schema
-- 约定：toy_id / mid 一律用 bigint；代码里当字符串传递，避免 JS number 精度问题。

-- 身份表。唯一的身份源是「我的 toy 内的 toyOpenId」。
-- 作者和玩家是同一张表：作者 = 一个验证过自己拥有某个 toy 的普通用户。
create table if not exists app_user (
  id           bigserial   primary key,
  home_toy_id  bigint      not null,
  toy_open_id  text        not null,
  nickname     text,
  avatar       text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  constraint app_user_identity_uk unique (home_toy_id, toy_open_id)
);

-- 已登记 / 已被认领的 toy
create table if not exists toy (
  toy_id       bigint      primary key,
  slug         text        not null unique,
  title        text,
  icon_url     text,
  author_mid   bigint,               -- 仅作展示，不参与鉴权
  author_name  text,
  author_face  text,
  bili_version integer,
  state        text        not null default 'unclaimed',
  owner_uid    bigint      references app_user(id),
  verified_at  timestamptz,
  synced_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint toy_state_ck check (state in ('unclaimed', 'pending', 'verified', 'disabled'))
);

create index if not exists toy_author_mid_idx on toy (author_mid);

-- 认领 nonce 状态机。nonce 一次性消费。
create table if not exists toy_claim (
  id           bigserial   primary key,
  toy_id       bigint      not null references toy(toy_id) on delete cascade,
  claimant_uid bigint      not null references app_user(id),
  nonce        text        not null unique,
  state        text        not null default 'pending',
  attempts     integer     not null default 0,
  last_error   text,
  consumed_at  timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint toy_claim_state_ck check (state in ('pending', 'verified', 'failed', 'expired'))
);

create index if not exists toy_claim_lookup_idx on toy_claim (toy_id, claimant_uid, state);

-- 下发给接入方的 client_id
create table if not exists toy_client (
  client_id  text        primary key,
  toy_id     bigint      not null unique references toy(toy_id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- 一次性授权码（60s，用完即焚）
create table if not exists auth_code (
  code                  text        primary key,
  uid                   bigint      not null references app_user(id),
  client_id             text        not null references toy_client(client_id),
  code_challenge        text,
  code_challenge_method text,
  state                 text,
  expires_at            timestamptz not null,
  used_at               timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists auth_code_expires_idx on auth_code (expires_at);

-- ES256 签名密钥（只存 JWK，签发时 import）
create table if not exists jwt_signing_key (
  kid         text        primary key,
  alg         text        not null default 'ES256',
  private_jwk jsonb       not null,
  public_jwk  jsonb       not null,
  created_at  timestamptz not null default now(),
  retired_at  timestamptz
);

-- 迁移记账
create table if not exists schema_migration (
  name       text        primary key,
  applied_at timestamptz not null default now()
);
