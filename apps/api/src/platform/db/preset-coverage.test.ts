import { describe, expect, it } from 'vitest';
import { ROUTES } from '@qingdan/contracts';
import { POSITIONS } from './seed.js';
import {
  contractScopes,
  NOT_A_DOMAIN,
  OWNER_ONLY,
  pendingDecisions,
  uncoveredScopes,
} from './preset-coverage.js';

/**
 * 出厂预设的权限覆盖护栏（#414）。
 *
 * 这些用例守的是「以后还会漏」，不是「已经漏了一个」。
 * 每新增一个 action（比如 D94 的 `ship`），若只改了老板那一格，
 * 第一条用例会立刻红并指出是哪个 `domain.action`。
 */

const presets = POSITIONS.map((position) => ({
  presetKey: position.presetKey ?? '',
  name: position.name,
  permissions: position.permissions,
}));

describe('出厂预设的权限覆盖（#414 护栏）', () => {
  it('契约里每个 domain.action 都有人能做 —— 要么被某个非老板预设授予，要么显式声明「只给老板」', () => {
    const missing = uncoveredScopes(presets);

    // 失败时要看得懂是哪一格，不是一句「1 个用例失败」
    expect(missing.map((item) => item.scope)).toEqual([]);
  });

  it('OWNER_ONLY 与 NOT_A_DOMAIN 里不出现重复条目', () => {
    const all = [...OWNER_ONLY.map((entry) => entry.scope), ...NOT_A_DOMAIN.map((entry) => entry.scope)];
    const dupes = all.filter((scope, index) => all.indexOf(scope) !== index);
    expect(dupes).toEqual([]);
  });

  it('OWNER_ONLY 里每一条都真的只有一个预设持有（否则它是过时的）', () => {
    // 反向校验：如果某个 scope 已经被补给了别人，这条 OWNER_ONLY 就成了谎话，
    // 会让人误以为「这里只给老板」而不敢动。让它红，逼着删掉。
    const stale: string[] = [];
    for (const entry of OWNER_ONLY) {
      const holders = new Set<string>();
      for (const preset of presets) {
        const has = preset.permissions.some(
          ([domain, action]) => `${domain}.${action}` === entry.scope,
        );
        if (has) holders.add(preset.name);
      }
      // 老板 + 另一个预设 → 过时
      if (holders.size > 1) {
        stale.push(`${entry.scope} 已被 ${[...holders].join(' / ')} 持有`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('OWNER_ONLY 的每一条都写清了理由（不是一句「老板专属」凑数）', () => {
    const weak = OWNER_ONLY.filter(
      (entry) => entry.reason.trim().length < 10,
    ).map((entry) => entry.scope);
    expect(weak).toEqual([]);
  });

  it('每个预设都至少持有一格 —— 空壳岗位等于「按钮全灰」', () => {
    const empty = presets
      .filter((preset) => preset.permissions.length === 0)
      .map((preset) => preset.name);
    expect(empty).toEqual([]);
  });

  it('契约里有端点但整块没人能做的组合数为零（不含待裁定的）', () => {
    // 与第一条同源，但把「待裁定」的那批单独数出来，方便一眼看到还剩多少没拍板。
    const granted = new Set<string>();
    for (const preset of presets) {
      if (preset.presetKey === 'owner') continue;
      for (const [domain, action] of preset.permissions) granted.add(`${domain}.${action}`);
    }
    const undecided = contractScopes().filter(
      (scope) => !granted.has(scope) && pendingDecisions().some((entry) => entry.scope === scope),
    );
    // 只断言「这些都在 OWNER_ONLY 里」，具体条数不锁死 —— 补一格就少一条，不该因此红。
    expect(undecided.every((scope) => OWNER_ONLY.some((entry) => entry.scope === scope))).toBe(true);
  });

  it('护栏本身能红：临时抽掉所有非老板预设的某一格授权，uncoveredScopes 必须报出来', () => {
    // 反向验证。没有这一条，前面几条「看起来通过」也可能是因为判据写错了。
    //
    // 注意要抽**所有**非老板预设 —— `purchase.ship` 现在同时被采购与纯仓管持有
    // （#402 补的），只抽一个的话另一个还在，不会只剩老板，护栏当然不报。
    const broken = presets.map((preset) =>
      preset.presetKey === 'owner'
        ? preset
        : {
            ...preset,
            permissions: preset.permissions.filter(
              ([domain, action]) => !(domain === 'purchase' && action === 'ship'),
            ),
          },
    );
    // 抽掉之后 purchase.ship 就只剩老板能做了 —— 而它不在 OWNER_ONLY 里
    // （历史上就是这一格漏过，PR #413 才补上），所以必须被报出来。
    expect(uncoveredScopes(broken).map((item) => item.scope)).toContain('purchase.ship');
  });

  it('护栏不吃空表：一个预设都不给时，所有非豁免组合都要报出来', () => {
    const missing = uncoveredScopes([], { ownerPresetKey: 'owner' });
    const expected = contractScopes().filter(
      (scope) =>
        !OWNER_ONLY.some((entry) => entry.scope === scope) &&
        !NOT_A_DOMAIN.some((entry) => entry.scope === scope),
    );
    expect(missing.map((item) => item.scope)).toEqual([...expected]);
    // 保底：这条用例自身不能因为契约变空而变成永真
    expect(expected.length).toBeGreaterThan(0);
  });

  it('ROUTES 里的 domain.action 与 contractScopes() 一致（防止清理时漏域）', () => {
    const fromRoutes = new Set(ROUTES.map((route) => `${route.domain}.${route.action}`));
    expect([...contractScopes()].sort()).toEqual([...fromRoutes].sort());
  });
});
