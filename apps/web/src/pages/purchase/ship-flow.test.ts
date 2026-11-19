import type { PurchaseOrderDetail } from '@qingdan/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildShipInput,
  defaultDirections,
  receiveBlockedText,
  revokeReasonError,
  revokeShipBlockedText,
  shipBlockedText,
  validateDirections,
} from './ship-flow';

const ORDER: PurchaseOrderDetail = {
  id: 'o1',
  tenantId: 't1',
  companyId: '00000000-0000-4000-8000-000000000001',
  orderNo: 'A-BJ01-20261118-0001',
  supplierId: '00000000-0000-4000-8000-000000000201',
  supplierName: '宁波塑料厂',
  status: '进行中',
  handlerId: 'e1',
  lines: [
    { lineNo: 1, productId: 'p1', qty: '500', unitPrice: '8.6', amount: '4300' },
    { lineNo: 2, productId: 'p2', qty: '200', unitPrice: '3.2', amount: '640' },
  ],
  fees: [],
  goodsAmount: '4940',
  feeAmount: '0',
  totalAmount: '4940',
  version: 4,
  createdAt: '2026-11-18T02:00:00.000Z',
  updatedAt: '2026-11-18T03:00:00.000Z',
  cancelable: { allowed: true, reason: null },
};

describe('三个在途动作的可点判定', () => {
  it('发货：缺 purchase.ship 先说权限，再谈状态', () => {
    expect(shipBlockedText({ canShip: false, status: '进行中' })).toContain('purchase.ship');
    // 没权限的人换成「在途」也不该看到状态原因——他根本没有这个动作
    expect(shipBlockedText({ canShip: false, status: '在途' })).toContain('purchase.ship');
  });

  it('发货：有权限时只有「进行中」能发', () => {
    expect(shipBlockedText({ canShip: true, status: '进行中' })).toBeNull();
    expect(shipBlockedText({ canShip: true, status: '在途' })).toContain('已经在途');
    expect(shipBlockedText({ canShip: true, status: '已完成' })).toContain('只有「进行中」');
    expect(shipBlockedText({ canShip: true, status: '已取消' })).toContain('只有「进行中」');
  });

  it('撤销发货：与发货同一个权限点，状态必须是「在途」', () => {
    expect(revokeShipBlockedText({ canShip: false, status: '在途' })).toContain('purchase.ship');
    expect(revokeShipBlockedText({ canShip: true, status: '在途' })).toBeNull();
    expect(revokeShipBlockedText({ canShip: true, status: '进行中' })).toContain('只有「在途」');
    expect(revokeShipBlockedText({ canShip: true, status: '已完成' })).toContain('只有「在途」');
  });

  it('到货确认：权限是 purchase.approve（审批动作），不是 update', () => {
    const noPerm = receiveBlockedText({ canApprove: false, status: '在途' });
    expect(noPerm).toContain('purchase.approve');
    expect(noPerm).toContain('审批动作');
    expect(receiveBlockedText({ canApprove: true, status: '在途' })).toBeNull();
  });

  it('到货确认：进行中时给下一步（直接完成），不要只说状态不对', () => {
    expect(receiveBlockedText({ canApprove: true, status: '进行中' })).toContain('完成采购单');
    expect(receiveBlockedText({ canApprove: true, status: '已完成' })).toContain('只有「在途」');
  });
});

describe('撤销原因校验（契约要求必填，服务端只记审计）', () => {
  it('空白一律拒：空格、换行也不算原因', () => {
    expect(revokeReasonError('')).toContain('必须填写原因');
    expect(revokeReasonError('   ')).toContain('必须填写原因');
    expect(revokeReasonError('\n\t')).toContain('必须填写原因');
  });

  it('1–200 字可提交，超过 200 字拒', () => {
    expect(revokeReasonError('发错货')).toBeNull();
    expect(revokeReasonError('x'.repeat(200))).toBeNull();
    expect(revokeReasonError('x'.repeat(201))).toContain('不能超过 200 字');
  });
});

describe('发货去向草稿', () => {
  it('默认照单据上已有的 transitTo 预填，没填的按回仓库', () => {
    const directions = defaultDirections({
      ...ORDER,
      lines: [
        { ...ORDER.lines[0]!, transitTo: 'processor', processorId: 'proc-1' },
        ORDER.lines[1]!,
      ],
    });
    expect(directions[0]).toEqual({ transitTo: 'processor', processorId: 'proc-1' });
    expect(directions[1]).toEqual({ transitTo: 'warehouse', processorId: '' });
  });

  it('直发没选加工厂：逐行报错，指出是第几行', () => {
    const errors = validateDirections(ORDER, [
      { transitTo: 'warehouse', processorId: '' },
      { transitTo: 'processor', processorId: '   ' },
    ]);
    expect(errors).toEqual(['第 2 行选的是「直发加工厂」，请选具体加工厂。']);
  });

  it('看得到加工厂列表时才允许直发；看不到就说清是权限问题，不是没录加工厂', () => {
    const errors = validateDirections(
      ORDER,
      [
        { transitTo: 'warehouse', processorId: '' },
        { transitTo: 'processor', processorId: 'proc-1' },
      ],
      { processorReadable: false },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('processor.read');
    expect(errors[0]).toContain('回仓库');
  });

  it('行数对不上时拒绝提交（单据可能被别人改过）', () => {
    const errors = validateDirections(ORDER, [{ transitTo: 'warehouse', processorId: '' }]);
    expect(errors[0]).toContain('行数不一致');
  });

  it('全部回仓库时零报错', () => {
    expect(validateDirections(ORDER, defaultDirections(ORDER))).toHaveLength(0);
  });
});

describe('提交入参', () => {
  it('lineNo 取明细自带的行号，每行都显式发', () => {
    const input = buildShipInput(ORDER, [
      { transitTo: 'warehouse', processorId: '' },
      { transitTo: 'processor', processorId: '  proc-2  ' },
    ]);
    expect(input.lines).toEqual([
      { lineNo: 1, transitTo: 'warehouse' },
      { lineNo: 2, transitTo: 'processor', processorId: 'proc-2' },
    ]);
  });

  it('行号有空洞时照原样发，不按数组下标重排', () => {
    // 服务端建单时按顺序编号，但行可能被整行替换过；这里刻意造一个「3、7」的视图，
    // 证明前端发的是服务端给的行号，而不是自己数出来的 1、2。
    const gapped: PurchaseOrderDetail = {
      ...ORDER,
      lines: [
        { lineNo: 3, productId: 'p1', qty: '500', unitPrice: '8.6', amount: '4300' },
        { lineNo: 7, productId: 'p2', qty: '200', unitPrice: '3.2', amount: '640' },
      ],
    };
    const input = buildShipInput(gapped, [
      { transitTo: 'warehouse', processorId: '' },
      { transitTo: 'warehouse', processorId: '' },
    ]);
    expect(input.lines.map((line) => line.lineNo)).toEqual([3, 7]);
  });

  it('去仓库的行不带 processorId（契约里那是直发专用字段）', () => {
    const input = buildShipInput(ORDER, [
      // 传了加工厂但去向是仓库：不能把脏字段发出去
      { transitTo: 'warehouse', processorId: 'proc-1' },
      { transitTo: 'warehouse', processorId: '' },
    ]);
    expect(input.lines[0]).toEqual({ lineNo: 1, transitTo: 'warehouse' });
    expect(Object.keys(input.lines[0]!)).not.toContain('processorId');
  });
});
