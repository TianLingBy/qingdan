import { describe, expect, it } from 'vitest';
import { normalizeDedupeName, normalizePhone, normalizeSpec } from './normalize.js';
import {
  PRODUCT_THRESHOLD,
  NAME_THRESHOLD,
  SAME_NAME_DIFF_SPEC_NOTE,
  judgeCandidate,
} from './thresholds.js';
import { similarity, trigrams } from './trigram.js';

/** 去重判定纯函数的单测（#302 块 C 前半段 / D100 设计 §四）。 */

describe('normalizeDedupeName', () => {
  it('抹平全角/空白/大小写，但保留括号备注', () => {
    expect(normalizeDedupeName('  张记（老店） 建材 ')).toBe('张记(老店) 建材');
    expect(normalizeDedupeName('ＡＢＣ　Ｔｒａｄｉｎｇ')).toBe('abc trading');
  });

  it('括号内容不抹平：分店必须能和总店区分开', () => {
    // 设计 §四：`张记（老店）` 与 `张记` 是两家店，抹平就等于把分店的账并进总店。
    expect(normalizeDedupeName('张记（老店）')).not.toBe(normalizeDedupeName('张记'));
  });

  it('电话只留数字，规格按名称口径规范化', () => {
    expect(normalizePhone('+86 138-0013-8000')).toBe('8613800138000');
    expect(normalizePhone('  ')).toBeNull();
    expect(normalizeSpec('500ML × 12')).toBe('500ml × 12');
  });
});

describe('trigram / similarity', () => {
  it('3 字符以上取三字滑窗，两字串退化成 bigram（否则两字店名永远 0 分）', () => {
    expect([...trigrams('张记建')]).toEqual(['张记建']);
    expect([...trigrams('张记')]).toEqual(['张记']);
    expect(similarity('张记', '张记')).toBe(1);
    expect(similarity('张记', '张记五金')).toBeLessThan(NAME_THRESHOLD);
  });

  it('长度 < 3 的串集合非空（兜底的核心）', () => {
    expect(trigrams('张记').size).toBeGreaterThan(0);
    expect(trigrams('张').size).toBe(1);
    expect(trigrams('').size).toBe(0);
  });

  it('Jaccard 对称、且对差异大小单调', () => {
    const samePrefix = similarity('张记建材', '张记建材店');
    const otherPrefix = similarity('张记建材', '李记建材');
    expect(similarity('张记建材店', '张记建材')).toBe(samePrefix);
    expect(samePrefix).toBeGreaterThan(otherPrefix);
  });
});

describe('judgeCandidate（设计 §四 判定顺序）', () => {
  const base = {
    kind: 'customer' as const,
    incomingName: '甲店',
    candidateName: '乙店',
  };

  it('电话相同优先命中 name_phone，与名字像不像无关', () => {
    expect(
      judgeCandidate({
        ...base,
        incomingPhone: '138-0013-8000',
        candidatePhone: '13800138000',
      }),
    ).toEqual({ score: 1, matchedBy: 'name_phone', note: null });
  });

  it('电话位数不足不参比（避免「1」这种脏数据互相命中）', () => {
    expect(
      judgeCandidate({ ...base, incomingPhone: '12', candidatePhone: '12' }),
    ).toBeNull();
  });

  it('名称完全相同 → 1.0 / name_only', () => {
    expect(
      judgeCandidate({
        kind: 'customer',
        incomingName: '张记建材',
        candidateName: ' 张记建材 ',
      }),
    ).toEqual({ score: 1, matchedBy: 'name_only', note: null });
  });

  it('只共享地名/前缀不够 0.85，不提示', () => {
    expect(
      judgeCandidate({
        kind: 'customer',
        incomingName: '张记五金',
        candidateName: '张记建材',
      }),
    ).toBeNull();
  });

  it('商品同名不同规格：进队列且带 note', () => {
    expect(
      judgeCandidate({
        kind: 'product',
        incomingName: '螺纹钢',
        incomingSpec: 'HRB400 φ20',
        candidateName: '螺纹钢',
        candidateSpec: 'HRB500 φ20',
      }),
    ).toEqual({ score: 1, matchedBy: 'name_only', note: SAME_NAME_DIFF_SPEC_NOTE });
  });

  it('商品同名同规格：进队列但无 note', () => {
    expect(
      judgeCandidate({
        kind: 'product',
        incomingName: '螺纹钢',
        incomingSpec: 'HRB400   φ20',
        candidateName: '螺纹钢',
        candidateSpec: 'hrb400 φ20',
      }),
    ).toEqual({ score: 1, matchedBy: 'name_only', note: null });
  });

  it('非商品不带「同名不同规格」备注', () => {
    expect(
      judgeCandidate({
        kind: 'supplier',
        incomingName: '华丰纸箱',
        incomingSpec: 'A',
        candidateName: '华丰纸箱',
        candidateSpec: 'B',
      }),
    ).toEqual({ score: 1, matchedBy: 'name_only', note: null });
  });

  it('商品阈值低于人名阈值（0.7 < 0.85）', () => {
    expect(PRODUCT_THRESHOLD).toBeLessThan(NAME_THRESHOLD);
  });
});
