/**
 * 造一批联机数据的测试样本。
 *
 *   npm run seed:data                      # 默认挑第一个已认领的 toy
 *   npm run seed:data -- --toy=40017649195008
 *
 * 幂等：同一格重复跑是覆盖，不会堆数据。日志会重造（先清掉这几格的旧日志）。
 */
import { pool, query, queryOne } from '../db.js';

const arg = process.argv.find((a) => a.startsWith('--toy='));
const wantedToyId = arg ? arg.slice('--toy='.length) : null;

type Row = { toy_id: string; slug: string; title: string | null };

async function pickToy(): Promise<Row> {
  if (wantedToyId) {
    const one = await queryOne<Row>(
      `select toy_id, slug, title from toy where toy_id = $1`,
      [wantedToyId],
    );
    if (!one) throw new Error(`没有这个 toy：${wantedToyId}`);
    return one;
  }
  const one = await queryOne<Row>(
    `select toy_id, slug, title from toy where state = 'verified' order by verified_at limit 1`,
  );
  if (!one) throw new Error('库里还没有已认领的 toy —— 先在中心 toy 认领一个，或带 --toy=<toy_id>');
  return one;
}

/** 用别人玩过这个 toy 的人当样本；不够就补几个库里现成的 */
async function pickUsers(toyId: string, n: number): Promise<string[]> {
  const used = await query<{ uid: string }>(
    `select uid from identity_usage where toy_id = $1 order by last_used_at desc limit $2`,
    [toyId, n],
  );
  const uids = used.rows.map((r) => r.uid);
  if (uids.length >= n) return uids;
  const more = await query<{ id: string }>(
    `select id from app_user where id <> all($1::bigint[]) order by id limit $2`,
    [uids.length ? uids : ['0'], n - uids.length],
  );
  return [...uids, ...more.rows.map((r) => r.id)];
}

/** upsert 一格（更新优先，别白吃自增号） */
async function putRow(input: {
  toyId: string;
  uid: string;
  scope: string;
  isPublic: boolean;
  openEdit?: string[];
  ttlDays?: number;
  tagTinyint?: number | null;
  tagInt1?: number | null;
  tagInt2?: number | null;
  text1?: string | null;
  text2?: string | null;
  textLong?: string | null;
  extra?: unknown;
}): Promise<string> {
  const ttl = input.ttlDays ?? 7;
  const cols = {
    tag_tinyint: input.tagTinyint ?? null,
    tag_int1: input.tagInt1 ?? null,
    tag_int2: input.tagInt2 ?? null,
    tag_bigint: null,
    text_1: input.text1 ?? null,
    text_2: input.text2 ?? null,
    text_long: input.textLong ?? null,
    extra: input.extra === undefined ? null : JSON.stringify(input.extra),
  };

  const existing = await queryOne<{ id: string }>(
    `select id from toy_data where toy_id = $1 and scope = $2 and uid = $3`,
    [input.toyId, input.scope, input.uid],
  );

  if (existing) {
    await query(
      `update toy_data set
         tag_tinyint = $1, tag_int1 = $2, tag_int2 = $3, tag_bigint = $4,
         text_1 = $5, text_2 = $6, text_long = $7, extra = $8::jsonb,
         is_public = $9, open_edit = $10,
         expires_at = created_at + make_interval(days => $11),
         updated_at = now()
       where id = $12`,
      [
        cols.tag_tinyint, cols.tag_int1, cols.tag_int2, cols.tag_bigint,
        cols.text_1, cols.text_2, cols.text_long, cols.extra,
        input.isPublic, input.openEdit ?? [], ttl, existing.id,
      ],
    );
    return existing.id;
  }

  const row = await queryOne<{ id: string }>(
    `insert into toy_data (toy_id, uid, scope, is_public, open_edit,
                           tag_tinyint, tag_int1, tag_int2, tag_bigint,
                           text_1, text_2, text_long, extra, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
             now() + make_interval(days => $14))
     returning id`,
    [
      input.toyId, input.uid, input.scope, input.isPublic, input.openEdit ?? [],
      cols.tag_tinyint, cols.tag_int1, cols.tag_int2, cols.tag_bigint,
      cols.text_1, cols.text_2, cols.text_long, cols.extra, ttl,
    ],
  );
  return row!.id;
}

async function main(): Promise<void> {
  const toy = await pickToy();
  const users = await pickUsers(toy.toy_id, 4);
  if (users.length === 0) throw new Error('库里没有用户，先用一个 toyOpenId 走一遍过桥');

  console.log(`toy：${toy.slug}（${toy.toy_id}）${toy.title ? '· ' + toy.title : ''}`);
  console.log(`用户：${users.join(', ')}\n`);

  const ownerRow = await queryOne<{ owner_uid: string | null }>(
    `select owner_uid from toy where toy_id = $1`,
    [toy.toy_id],
  );
  const authorUid = ownerRow?.owner_uid ?? users[0]!;

  // ① 背包：每人一格，私有
  for (const [i, uid] of users.entries()) {
    await putRow({
      toyId: toy.toy_id,
      uid,
      scope: 'package',
      isPublic: false,
      tagInt1: 100 + i * 10,
      text1: `玩家 ${uid} 的背包`,
      extra: { items: [`道具-${i}-a`, `道具-${i}-b`], gold: 1000 + i * 137 },
    });
    console.log(`  背包 package   uid=${uid}  私有`);
  }

  // ② 角色池：公开，用 tag 筛选
  for (const [i, uid] of users.entries()) {
    await putRow({
      toyId: toy.toy_id,
      uid,
      scope: 'roles',
      isPublic: true,
      ttlDays: 30,
      tagTinyint: i % 2, // 0/1 当 boolean 用
      tagInt1: [12, 30, 45, 60][i] ?? 1, // 等级
      text1: `角色-${uid}`,
      text2: '一个测试角色，tag_int1 是等级，tag_tinyint 是是否出战',
    });
    console.log(`  角色池 roles   uid=${uid}  公开`);
  }

  // ③ 公共板：给**别人**（不是作者）一格公开的，开放 tag_int1 和 text_1，
  // 这样「作者去改别人的格」才演示得出来
  const boardOwner = users[1] ?? users[0]!;
  const board = await putRow({
    toyId: toy.toy_id,
    uid: boardOwner,
    scope: 'board',
    isPublic: true,
    openEdit: ['tag_int1', 'text_1'],
    tagInt1: 1,
    text1: '大家好，这是公共板',
    text2: '别人只能改 tag_int1 和 text_1，extra 永远改不了',
    extra: { ownerOnly: '只有属主和作者能改这个' },
  });
  console.log(`  公共板 board   uid=${boardOwner}  公开，开放 tag_int1/text_1`);

  // ④ 世界 boss：作者那一格，公开 + 开放血量给所有人打
  await putRow({
    toyId: toy.toy_id,
    uid: authorUid,
    scope: 'admin_world',
    isPublic: true,
    openEdit: ['tag_int1'],
    ttlDays: 30,
    tagInt1: 1000,
    text1: '世界 Boss',
    text2: 'tag_int1 是剩余血量，谁都能打',
    extra: { respawn: '每天 20:00' },
  });
  console.log(`  世界 boss admin_world  uid=${authorUid}  公开，开放 tag_int1`);

  // ⑤ 给公共板造两条日志，好让「看改动日志」有东西看
  await query(`delete from toy_data_log where data_id = $1`, [board]);
  await query(
    `insert into toy_data_log (data_id, actor_uid, action, changed, before, after)
     values ($1, $2, 'create', array['tag_int1','text_1'],
             null, '{"tag_int1":1,"text_1":"大家好，这是公共板"}'::jsonb),
            ($1, $3, 'update', array['tag_int1'],
             '{"tag_int1":1}'::jsonb, '{"tag_int1":5}'::jsonb)`,
    [board, boardOwner, users[0]!],
  );
  await query(`update toy_data set tag_int1 = 5 where id = $1`, [board]);
  console.log('  公共板补了 2 条日志（create + update）');

  const total = await queryOne<{ n: string }>(
    `select count(*) as n from toy_data where toy_id = $1`,
    [toy.toy_id],
  );
  console.log(`\n这个 toy 现在有 ${total?.n ?? 0} 格数据。`);
  console.log('打开测试台，快捷填充 ③ 列 package / roles 的 list，就能看到它们。');
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('造数据失败：', e.message ?? e);
    void pool.end();
    process.exit(1);
  });
