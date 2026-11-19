import { ROUTES, type Action, type DomainKey } from '@qingdan/contracts';

/**
 * 出厂预设的权限覆盖护栏（#414）。
 *
 * ## 这张表解决什么问题
 *
 * `seed.ts` 里七个预设的授权是手工写的。契约新增一个 action 时（比如 D94 把「发货」
 * 从 `update` 拆成 `ship`），很容易只改了老板那一格 —— 因为老板是
 * `ALL_DOMAINS.flatMap(domain => perms(domain, ALL_ACTIONS))`，自动全量，
 * 永远不会漏；而其余六个预设是一个个 domain + action 手写，漏了不报错。
 *
 * 漏掉的后果是**按钮消失**：
 *   - 类型检查看不见（`perms()` 返回 `Perm[]`，少一格不报错）；
 *   - 现有测试看不见（只验「七套岗位齐全」「重复执行幂等」，不验每格）；
 *   - 接口 403 也看不见（对使用者是「我没有权限」，对开发者是「本来就不该有」）。
 *
 * 只有真人用某个身份登录、点到那个按钮、发现它是灰的，才知道漏了。而那时已经上线。
 *
 * 历史证据：`ship`（D94）、`merge`（D98）、`view_handler`（D90）、`export`、`view_price`
 * 全都漏过。
 *
 * ## 这条护栏的判据
 *
 * 对契约里**实际存在的**每个 `(domain, action)` 组合：
 *
 *   - 要么至少被**一个非 owner 预设**授予 —— 说明有人能干活；
 *   - 要么在下面 `OWNER_ONLY` 里出现 —— 说明「只给老板」是**写下来的决定**。
 *
 * 两者都不是 → 测试失败，并指出是哪个组合。**这就是漏。**
 *
 * ## 为什么用「从 ROUTES 抽」而不是硬编码清单
 *
 * 硬编码的 83 个组合会漂移：加了端点忘了更新清单，护栏就成了一纸空文。
 * `ROUTES` 是契约唯一真源，`RouteDef.domain` / `.action` 直接可读。
 */

/**
 * 契约里有端点、但**有意只让老板拿到**的组合。
 *
 * 每一条都要写理由。写不出理由就说明它是漏的，该去补授权而不是加进这张表。
 */
export interface OwnerOnlyEntry {
  readonly scope: `${DomainKey}.${Action}`;
  readonly reason: string;
  /**
   * `true` = 我拿不准「是否该只给老板」，需要负责人裁定。
   * 这类条目**不妨碍护栏通过**（护栏的职责是防新增漏，不是逼人立刻拍板），
   * 但会在 PR 与 issue 里单独列出来。
   */
  readonly pendingDecision?: boolean;
}

export const OWNER_ONLY: readonly OwnerOnlyEntry[] = [
  // ─── 组织治理：开公司、进出人、建删岗位 ───────────────────────────────
  { scope: 'company.create', reason: '开新公司是组织级动作，出厂预设里只有老板代表组织' },
  { scope: 'company.update', reason: '改公司名/公司码会影响历史单号的可读性，只给老板' },
  { scope: 'employee.create', reason: '加人是组织级动作；经理只有 employee.read（能看名册不等于能招人）' },
  { scope: 'employee.update', reason: '改员工资料（含岗位、手机号）只给老板 —— 改岗位等于改权限' },
  { scope: 'employee.delete', reason: '删人是不可逆动作，只给老板' },
  { scope: 'permission.create', reason: '建岗位是授权行为本身，只给老板' },
  { scope: 'permission.delete', reason: '删岗位会让上面的人瞬间失去权限，只给老板' },

  // ─── 外部集成与提成规则：配置类，改一次影响全员 ──────────────────────
  { scope: 'api_integration.create', reason: 'API 密钥是凭据，只给老板（财务/采购都看不到）' },
  { scope: 'api_integration.read', reason: '同上 —— 能读就等于能拿到密钥' },
  { scope: 'api_integration.delete', reason: '吊销密钥会影响所有集成调用，只给老板' },
  { scope: 'commission.create', reason: '提成规则决定谁拿多少钱，只给老板' },
  { scope: 'commission.read', reason: '提成规则里含费率，等同薪酬信息' },
  { scope: 'commission.delete', reason: '删规则会让历史提成无法重算，只给老板' },

  // ─── 破坏性动作：删除单据与主数据 ──────────────────────────────────
  { scope: 'customer.delete', reason: '删客户档案会影响挂在它上面的一切单据，只给老板' },
  { scope: 'supplier.delete', reason: '删供应商会让历史采购单的单价来源失去出处，只给老板' },
  { scope: 'processor.delete', reason: '删加工厂会让历史加工单的材料去向无法追溯，只给老板' },
  { scope: 'product.delete', reason: '删商品会让历史单据的明细失去名称，只给老板' },
  { scope: 'purchase.delete', reason: '采购单作废会影响在途与结算，只给老板' },
  { scope: 'sales.delete', reason: '销售单作废会影响收入确认，只给老板' },
  { scope: 'processing.delete', reason: '加工单作废会丢材料与产出的对应关系，只给老板' },
  { scope: 'supplier_return.delete', reason: '退货单作废会导致应付对不上，只给老板' },

  // ─── 待裁定：下面是真判断不了「该给谁」的 ────────────────────────────
  {
    scope: 'sales.approve',
    reason:
      'D94 把「发货」与「签收」拆开，理由是「能发货的人不一定能确认收入」；但**谁该确认收入**没有拍板。' +
      '财务预设只有 settlement/sales.read，销售预设连 approve 都没有 —— 现在只有老板能签收。',
    pendingDecision: true,
  },
  {
    scope: 'processing.approve',
    reason:
      '加工到货确认（在途 → 已完成）。采购预设没有 processing 域任何权限，仓管只有 read+update。' +
      '按「到货确认走 approve 与改单 update 分离」（D94 ④）的口径，仓管现在确认不了到货。',
    pendingDecision: true,
  },
  {
    scope: 'processing.ship',
    reason:
      '加工发货（进行中 → 在途，分料段/成品段）。仓管只有 processing.read+update，没有 ship。' +
      '若加工发货实际由仓管做，这是漏的；若由采购跟单，采购预设也没有 processing 域。',
    pendingDecision: true,
  },
  {
    scope: 'internal_trade.create',
    reason: '内部交易（公司之间调货）整块只有老板能做 —— 是「业务量少所以先不派」还是「本来就只该老板」，未定',
    pendingDecision: true,
  },
  {
    scope: 'internal_trade.update',
    reason:
      '内部交易单的修改。内贸整块只有老板能做 —— 「业务量少所以先不派」还是「本来就只该老板」未定，' +
      '所以这张表里内贸五格都标了待裁定，而不是当成「有意只给老板」',
    pendingDecision: true,
  },
  {
    scope: 'internal_trade.approve',
    reason: '内部交易到货确认，同上',
    pendingDecision: true,
  },
  {
    scope: 'internal_trade.ship',
    reason: '内部交易发货/撤销发货，同上',
    pendingDecision: true,
  },
  {
    scope: 'internal_trade.delete',
    reason:
      '内部交易的作废。内贸整块只有老板能做，是否该派给谁未定；' +
      '作废会影响两家公司的库存与结算，即便派出去也该比普通单据更严',
    pendingDecision: true,
  },
  {
    scope: 'customer_return.create',
    reason: '客户退货单由谁发起没定：销售（对客）还是仓管（实际收货）都说得通，两边现在都没有',
    pendingDecision: true,
  },
  {
    scope: 'supplier_return.create',
    reason: '供应商退货单由谁发起没定：采购（对供应商）还是仓管（实际出货）都说得通，两边现在都没有',
    pendingDecision: true,
  },
  {
    scope: 'inventory_qty.approve',
    reason:
      '成本更正审批。经理有 inventory_qty.read 但没有 approve —— 而 D47 定的「老板或经理审批」是盘点单，' +
      '成本更正是否同口径未明确。',
    pendingDecision: true,
  },
  {
    scope: 'inventory_qty.export',
    reason: '库存导出。财务预设已有 profit_report.export（能导利润），但导不了库存 —— 是有意的还是漏的未定',
    pendingDecision: true,
  },
  {
    scope: 'purchase.export',
    reason: '采购单导出。财务有 profit_report.export，采购预设自己没有 export',
    pendingDecision: true,
  },
  {
    scope: 'sales.export',
    reason: '销售单导出。销售预设自己有 read/create/update/view_price，但没有 export',
    pendingDecision: true,
  },

  // ─── 护栏第一次跑出来的：这五格是真漏，不是「有意只给老板」 ──────────
  // 它们的共同点是「业务上明明有人该做，但那个预设整块没有这个域」。
  // 按 #414 的规矩本单不改授权（一类一单，别混），先收进这里并标待裁定，
  // 补授权的活另开单。
  {
    scope: 'processing.create',
    reason:
      '建加工单。采购预设整块没有 processing 域（只有 purchase/product/supplier/inventory_qty/stocktake/settlement），' +
      '但找加工厂下单本来就是采购跟单的活 —— **这是漏的**，只是补授权要单独一单',
    pendingDecision: true,
  },
  {
    scope: 'processor.create',
    reason:
      '建加工厂档案。采购能建供应商（supplier.create），但建不了加工厂 —— ' +
      '而加工厂是采购去找的，**这是漏的**',
    pendingDecision: true,
  },
  {
    scope: 'processor.update',
    reason: '改加工厂档案（联系人、地址、报价）。与 processor.create 同源，**这是漏的**',
    pendingDecision: true,
  },
  {
    scope: 'customer_return.approve',
    reason:
      '客户退货完成（R 单：进行中 → 已完成）。销售只有 sales 域的 approve 都没有，' +
      '客户退货谁来确认收货与退款未定 —— 可能是仓管（实际收货）也可能是财务（退款）',
    pendingDecision: true,
  },
  {
    scope: 'supplier_return.approve',
    reason:
      '供应商退货完成（S 单：进行中 → 已完成）。采购预设没有 supplier_return 域任何一格 —— ' +
      '发起与确认都做不了，**这是漏的**',
    pendingDecision: true,
  },
];

/**
 * 契约里有端点、但**整个域不该出现在预设里**的组合。
 *
 * `billing` 是 D100 / #302 明确「不做」的域（订阅计费不在本期范围），
 * 但契约与 `ALL_DOMAINS` 的差集会让它落进护栏的检查范围。这里显式排除，
 * 免得每次跑测试都看到两条无关失败。
 */
export const NOT_A_DOMAIN: readonly { scope: `${DomainKey}.${Action}`; reason: string }[] = [
  {
    scope: 'billing.read',
    reason: 'billing 域明确不做（订阅计费不在本期），前端也不该有入口',
  },
  {
    scope: 'billing.update',
    reason: '同上',
  },
];

/** 契约里实际被端点用到的 `domain.action` 组合（去重、排序）。 */
export function contractScopes(): readonly `${DomainKey}.${Action}`[] {
  const set = new Set<string>();
  for (const route of ROUTES) {
    set.add(`${route.domain}.${route.action}`);
  }
  return [...set].sort() as `${DomainKey}.${Action}`[];
}

/** 一个预设的授权集合。`permissions` 就是 `seed.ts` 里那个数组。 */
export interface PresetGrants {
  readonly presetKey: string;
  readonly name: string;
  readonly permissions: readonly (readonly [string, string])[];
}

/**
 * 找出「契约里有端点、但既没有非 owner 预设授予、也不在 OWNER_ONLY 里」的组合。
 *
 * 返回空数组 = 护栏通过。非空 = 有人新增了端点却忘了给任何人授权。
 */
export function uncoveredScopes(
  presets: readonly PresetGrants[],
  options: { readonly ownerPresetKey?: string } = {},
): readonly { scope: string; suggestion: string }[] {
  const ownerKey = options.ownerPresetKey ?? 'owner';
  const granted = new Set<string>();
  for (const preset of presets) {
    if (preset.presetKey === ownerKey) continue; // 老板全量，不参与「有人能干活」的判断
    for (const [domain, action] of preset.permissions) {
      granted.add(`${domain}.${action}`);
    }
  }

  const exempt = new Set<string>([
    ...OWNER_ONLY.map((entry) => entry.scope),
    ...NOT_A_DOMAIN.map((entry) => entry.scope),
  ]);

  const missing: { scope: string; suggestion: string }[] = [];
  for (const scope of contractScopes()) {
    if (granted.has(scope) || exempt.has(scope)) continue;
    missing.push({
      scope,
      suggestion:
        `契约里有端点用 ${scope}，但没有一个非老板预设持有它，也没在 OWNER_ONLY 里声明「有意只给老板」。` +
        `要么在 seed.ts 给合适预设补一格，要么把它加进 OWNER_ONLY 并写清理由。`,
    });
  }
  return missing;
}

/** `OWNER_ONLY` 里标了 `pendingDecision` 的条目（PR / issue 里要单独列）。 */
export function pendingDecisions(): readonly OwnerOnlyEntry[] {
  return OWNER_ONLY.filter((entry) => entry.pendingDecision === true);
}
