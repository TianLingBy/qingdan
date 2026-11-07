// 轻单 U12 spike：三条技术命门实测（Node 24）
// 1) Zod 4 -> JSON Schema 2020-12 -> OpenAPI 3.1 组件
// 2) PGlite（WASM PG）在 Windows 上可跑 + numeric(18,6) 读出类型 + RLS
// 3) Fastify 5 + Drizzle(PGlite) 组合
// 4) UUIDv7 可用性与时间有序
import { z } from 'zod';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { v7 } from 'uuid';
import zodPkg from './node_modules/zod/package.json' with { type: 'json' };
import fastifyPkg from './node_modules/fastify/package.json' with { type: 'json' };

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e?.message ?? String(e) });
  }
}

const LineSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().positive(),
  unitPrice: z.string().regex(/^\d+\.\d{1,6}$/),
});
const OrderSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['草稿', '已提交', '已完成']),
  lines: z.array(LineSchema).min(1),
  total: z.string(),
});

let orderJsonSchema = null;

await check('Zod4 z.toJSONSchema 可用', () => {
  if (typeof z.toJSONSchema !== 'function') throw new Error('z.toJSONSchema 不存在');
  orderJsonSchema = z.toJSONSchema(OrderSchema, { target: 'draft-2020-12' });
  return String(orderJsonSchema.$schema ?? '(无 $schema)');
});

await check('JSON Schema 为 2020-12 方言（OpenAPI 3.1 要求的方言）', () => {
  const s = String(orderJsonSchema.$schema ?? '');
  if (!s.includes('2020-12')) throw new Error('方言不是 2020-12: ' + s);
  return s;
});

await check('$defs 引用需重写为 #/components/schemas（关键工程发现）', () => {
  const txt = JSON.stringify(orderJsonSchema);
  const refs = txt.match(/"\$ref":"#\/\$defs\/[^"]+"/g) ?? [];
  return { refCount: refs.length, sample: refs[0] ?? '(全部内联)', mustRewrite: refs.length > 0 };
});

const pg = new PGlite();

await check('PGlite 启动（WASM Postgres，Windows）', async () => {
  const r = await pg.query('select version() as v');
  return String(r.rows[0].v).slice(0, 45);
});

await check('numeric(18,6) 读出为字符串（合契约金额传字符串）', async () => {
  await pg.query(`create table t_money (id uuid primary key, amount numeric(18,6) not null, qty numeric(18,6))`);
  await pg.query(`insert into t_money values ('00000000-0000-7000-8000-000000000001', 1234.567890, 1.5)`);
  const r = await pg.query('select amount, qty from t_money');
  const amount = r.rows[0].amount;
  if (typeof amount !== 'string') throw new Error('读出来不是 string: ' + typeof amount);
  return { amount, jsType: typeof amount };
});

await check('RLS 生效（需以非超级用户身份连接；superuser 会绕过 RLS）', async () => {
  await pg.query(`create table t_doc (id serial primary key, tenant_id text not null, note text)`);
  await pg.query(`alter table t_doc enable row level security`);
  await pg.query(`alter table t_doc force row level security`);
  await pg.query(`create policy p_doc on t_doc using (tenant_id = current_setting('app.tenant_id', true))`);
  await pg.query(`insert into t_doc (tenant_id, note) values ('A','a1'),('B','b1')`);
  // superuser（PGlite 默认连接）会绕过 RLS，必须切到普通角色才能验证
  await pg.query(`create role app_user nologin`);
  await pg.query(`grant usage on schema public to app_user`);
  await pg.query(`grant select on t_doc to app_user`);
  await pg.query(`set role app_user`);
  await pg.query(`set app.tenant_id = 'A'`);
  const r = await pg.query('select count(*)::int as c from t_doc');
  await pg.query(`reset role`);
  if (r.rows[0].c !== 1) throw new Error('RLS 未生效，看到 ' + r.rows[0].c + ' 行');
  return 'tenant=A 只看到 1 行（superuser 身份则绕过，见备注）';
});

await check('UUIDv7 生成且时间有序', () => {
  const a = v7();
  const b = v7();
  if (typeof a !== 'string' || a.length !== 36) throw new Error('格式异常: ' + a);
  if (!(a < b)) throw new Error('非时间有序: ' + a + ' / ' + b);
  return a;
});

await check('Drizzle(pglite) 查询可用', async () => {
  const db = drizzle(pg);
  const r = await db.execute(sql`select count(*)::int as c from t_doc`);
  return 'rows=' + JSON.stringify(r.rows);
});

await check('Fastify 5 起服务 + Zod 校验 + 422 返回', async () => {
  const app = Fastify({ logger: false });
  app.get('/api/v1/health', async () => ({ ok: true }));
  app.post('/api/v1/orders', async (req, reply) => {
    const parsed = OrderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ code: 'VALIDATION_FAILED', issues: parsed.error.issues.length });
    return reply.code(201).send({ id: parsed.data.id });
  });
  const okRes = await app.inject({ method: 'GET', url: '/api/v1/health' });
  const badRes = await app.inject({ method: 'POST', url: '/api/v1/orders', payload: { id: 'nope' } });
  const goodRes = await app.inject({
    method: 'POST', url: '/api/v1/orders',
    payload: { id: v7(), status: '草稿', lines: [{ productId: v7(), qty: 1, unitPrice: '12.500000' }], total: '12.500000' },
  });
  await app.close();
  if (okRes.statusCode !== 200) throw new Error('health ' + okRes.statusCode);
  if (badRes.statusCode !== 422) throw new Error('校验失败未回 422，实际 ' + badRes.statusCode);
  if (goodRes.statusCode !== 201) throw new Error('合法请求未回 201，实际 ' + goodRes.statusCode);
  return `health=${okRes.statusCode} bad=${badRes.statusCode} good=${goodRes.statusCode}`;
});

console.log('');
for (const r of results) {
  const d = typeof r.detail === 'object' ? JSON.stringify(r.detail) : String(r.detail);
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + '  ->  ' + d);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${results.length - failed}/${results.length} passed`);
console.log(`versions: node=${process.version} zod=${zodPkg.version} fastify=${fastifyPkg.version}`);
process.exit(failed ? 1 : 0);
