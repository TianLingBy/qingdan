import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_WORDS,
  DENY_REASON_MESSAGES,
  DOMAIN_WORDS,
  describeDeny,
  hasFullScope,
} from './domain-words';

/**
 * 词表与文案的守护测试：
 * - 与契约 `packages/contracts/src/domains.ts` 的数量/键序对齐（文本级对账，web 不引包）；
 * - 403 的四种 details.reason 必须都有人话文案（#6 验收）。
 */

const CONTRACT_PATH = fileURLToPath(
  new URL('../../../../../packages/contracts/src/domains.ts', import.meta.url),
);

function contractKeys(source: string, objectName: string): string[] {
  const start = source.indexOf(`export const ${objectName} = {`);
  expect(start, `contracts 里应存在 ${objectName}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('} as const', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]!);
}

describe('domain-words（页面本地词表）', () => {
  it('功能域与 contracts/domains.ts 完全一致（键 + 数量）', () => {
    const contractDomains = contractKeys(readFileSync(CONTRACT_PATH, 'utf8'), 'DOMAINS');
    expect(DOMAIN_WORDS.map((w) => w.key)).toEqual(contractDomains);
  });

  it('动作与 contracts/domains.ts 完全一致（键 + 数量）', () => {
    const contractActions = contractKeys(readFileSync(CONTRACT_PATH, 'utf8'), 'ACTIONS');
    expect(ACTION_WORDS.map((w) => w.key)).toEqual(contractActions);
  });

  it('403 的四种 details.reason 都有对应文案（#6 验收）', () => {
    for (const reason of [
      'TARGET_IS_OWNER',
      'TARGET_IS_MANAGER',
      'TARGET_IS_FINANCE',
      'SELF_ESCALATION_DENIED',
    ]) {
      const text = DENY_REASON_MESSAGES[reason];
      expect(text, `${reason} 应有文案`).toBeTruthy();
      expect(text!.length).toBeGreaterThan(6);
    }
  });

  it('describeDeny：reason 优先；denied 列表拼接领域·动作；兜底文案', () => {
    expect(describeDeny({ reason: 'SELF_ESCALATION_DENIED' })).toContain('自我提权');
    expect(describeDeny({ denied: [{ domain: 'sales', action: 'approve' }] })).toBe(
      '以下授权超出你自己的权限范围，已被拒绝：E 销售单·审。',
    );
    expect(describeDeny({})).toContain('403');
    expect(describeDeny(null)).toContain('403');
  });

  it('hasFullScope：全量（老板）为 true，缺一个动作即为 false', () => {
    const full = DOMAIN_WORDS.map((d) => ({
      domain: d.key,
      actions: ACTION_WORDS.map((a) => a.key),
    }));
    expect(hasFullScope(full)).toBe(true);

    const almost = full.map((entry) =>
      entry.domain === 'company'
        ? { domain: entry.domain, actions: entry.actions.filter((a) => a !== 'create') }
        : entry,
    );
    expect(hasFullScope(almost)).toBe(false);
  });
});
