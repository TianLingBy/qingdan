-- 0031_returns_status_update_grant.sql
-- R 单 / S 单的「确认完成」要能改 status，但 0011 / 0014 对 qingdan_app 做了全表 REVOKE UPDATE。
--
-- 现状（P0-04）：
--   * 0014_sales_receipts_returns.sql:135-136   REVOKE UPDATE, DELETE, TRUNCATE ON customer_return FROM qingdan_app;
--   * 0011_supplier_returns.sql:89-90           REVOKE UPDATE, DELETE, TRUNCATE ON supplier_return FROM qingdan_app;
--   * 而 customer-returns / supplier-returns 的 complete 用例执行
--     UPDATE customer_return SET status = '已完成', version = version + 1 WHERE ...
--   * 测试跑在 PGlite 的超级用户下不受影响，换成真实应用角色 qingdan_app 就会被 PG 拒绝。
--
-- 处理口径：
--   「只追加」这条约束针对的是明细、金额、批次引用——这些列一旦写入就是历史，改了就是错账。
--   单据自身的 status / version 是状态机字段，本来就要推进，不属于历史事实。
--   所以这里放开**列级** UPDATE，只给 status 与 version 两列；
--   其余列对 qingdan_app 仍然不可写，DELETE / TRUNCATE 仍然全禁。
--
-- 为什么用列级 GRANT 而不是给整表 UPDATE + 触发器：
--   触发器方案要在每次 UPDATE 里判断改动了哪些列，出错时是运行期错误；
--   列级授权由 PG 在语句解析阶段就拒掉越权列，更早、更硬，也少一段维护代码。

GRANT UPDATE (status, version) ON customer_return TO qingdan_app;
GRANT UPDATE (status, version) ON supplier_return TO qingdan_app;
