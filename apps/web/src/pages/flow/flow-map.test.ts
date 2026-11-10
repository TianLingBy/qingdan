import { ROUTES } from '@qingdan/contracts';
import { describe, expect, it } from 'vitest';
import { ROUTE_TABLE } from '../../router/routes';
import {
  FLOW_DOCS,
  MAIN_DOC_ORDER,
  MAIN_FLOW,
  MAIN_LINKS,
  SIDE_FLOW,
  maturityOf,
} from './flow-map';

/**
 * 流程图的数据守卫（#141 验收第 1 条：不画未落地的流程）。
 *
 * 这里能自动盯住的只有「名字对不对」——节点指向的页面是否存在、operationId 是否真在
 * contracts 注册表里。至于「这条链到底通没通」是人工判断，写在 `gaps` 里，
 * 补完接口时记得把对应 gap 删掉（否则徽标会一直显示「缺动作」）。
 */

const CONTRACT_OPERATION_IDS = new Set(ROUTES.map((route) => route.operationId));
const ROUTE_IDS = new Set(ROUTE_TABLE.map((entry) => entry.id));

describe('节点与路由表对齐', () => {
  it('每个节点都指向路由表里真实存在的页面', () => {
    for (const node of FLOW_DOCS) {
      expect(ROUTE_IDS.has(node.routeId), `${node.code} ${node.name} → ${node.routeId}`).toBe(true);
    }
  });

  it('节点 id 与单据代号都不重复', () => {
    const ids = FLOW_DOCS.map((node) => node.id);
    const codes = FLOW_DOCS.map((node) => node.code);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('主线是 A → B → E → C，辅助是 N / R / S / I', () => {
    expect(MAIN_DOC_ORDER).toEqual(['A', 'B', 'E', 'C']);
    expect(SIDE_FLOW.map((node) => node.code)).toEqual(['N', 'R', 'S', 'I']);
  });

  it('三段连接首尾相接，前两段断在「还没人做的动作」上', () => {
    expect(MAIN_LINKS).toHaveLength(MAIN_FLOW.length - 1);
    MAIN_LINKS.forEach((link, index) => {
      expect(link.from).toBe(MAIN_FLOW[index]?.id);
      expect(link.to).toBe(MAIN_FLOW[index + 1]?.id);
    });
    expect(MAIN_LINKS.filter((link) => link.gap).map((link) => link.gap?.label)).toEqual([
      '原料入库',
      '产出结转',
    ]);
    // 断点的说明要写出「为什么断」，不是复述标题
    for (const link of MAIN_LINKS) {
      if (!link.gap) continue;
      expect(link.gap.detail.length).toBeGreaterThan(20);
    }
  });
});

describe('接口名必须真实存在', () => {
  it('已通的 operationId 全部在 contracts 注册表里', () => {
    for (const node of FLOW_DOCS) {
      for (const operationId of node.done) {
        expect(
          CONTRACT_OPERATION_IDS.has(operationId),
          `${node.code} ${node.name} 写了不存在的接口 ${operationId}`,
        ).toBe(true);
      }
    }
  });

  it('「签名已登记、实现未接」的 operationId 也在注册表里，且不能同时算作已通', () => {
    for (const node of FLOW_DOCS) {
      for (const operationId of node.pendingOperationIds ?? []) {
        expect(
          CONTRACT_OPERATION_IDS.has(operationId),
          `${node.code} 的待接接口 ${operationId} 没有在 contracts 登记`,
        ).toBe(true);
        expect(node.done, `${operationId} 同时出现在 done 与 pendingOperationIds`).not.toContain(
          operationId,
        );
      }
    }
  });

  it('同一个接口不会挂到两个单据上', () => {
    const seen = new Map<string, string>();
    for (const node of FLOW_DOCS) {
      for (const operationId of node.done) {
        const owner = seen.get(operationId);
        expect(owner ?? node.code, `${operationId} 同时出现在 ${owner} 与 ${node.code}`).toBe(
          node.code,
        );
        seen.set(operationId, node.code);
      }
    }
  });
});

describe('成熟度由缺口派生', () => {
  it('E / C / I 自身接口齐全，标「已通」', () => {
    const ready = FLOW_DOCS.filter((node) => maturityOf(node) === 'ready').map((node) => node.code);
    expect(ready).toEqual(['E', 'C', 'I']);
  });

  it('能开单但有缺口的标「缺动作」', () => {
    const partial = FLOW_DOCS.filter((node) => maturityOf(node) === 'partial').map((node) => node.code);
    expect(partial).toEqual(['A', 'B', 'N', 'R', 'S']);
  });

  it('「有意不做」与「别人欠的账」都不算这张单自己的缺口', () => {
    const settlement = FLOW_DOCS.find((node) => node.code === 'C');
    // 没有创建端点是 D19 / D29 的设计取舍，写在 limits 里，不该把 C 标成「缺动作」。
    expect(settlement?.limits?.join()).toContain('没有创建端点');
    expect(settlement?.gaps).toEqual([]);
    // N 单完成未接导致的草稿缺源，记在 note 里并指回 N。
    expect(settlement?.note).toContain('N');
  });

  it('每个节点至少接通了一条接口，且缺口说明不是空话', () => {
    for (const node of FLOW_DOCS) {
      expect(node.done.length, `${node.code} 没有任何已通接口`).toBeGreaterThan(0);
      for (const gap of node.gaps) {
        expect(gap.length, `${node.code} 的缺口说明太短`).toBeGreaterThan(6);
      }
    }
  });
});
