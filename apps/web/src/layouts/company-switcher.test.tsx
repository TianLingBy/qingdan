import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ActiveCompanyProvider,
  CompanySwitcher,
  useActiveCompany,
  type CompanyDirectoryView,
} from './company-switcher';

/**
 * 公司切换下拉的渲染测试（页面级筛选，#240）。
 *
 * 为什么用 `renderToStaticMarkup`：与 `lib/employee-directory.render.test.tsx` 同口径，
 * 不引入 DOM 测试库，只断言下拉渲染出的选项与降级状态。
 */

function directoryOf(labels: Readonly<Record<string, string>>): CompanyDirectoryView {
  return { label: (id) => labels[id] ?? id, failed: false };
}

function renderSwitch(
  companyIds: readonly string[],
  directory: CompanyDirectoryView,
  allCompaniesLabel: string,
): string {
  return renderToStaticMarkup(
    <ActiveCompanyProvider>
      <CompanySwitcher
        companyIds={companyIds}
        directory={directory}
        allCompaniesLabel={allCompaniesLabel}
      />
    </ActiveCompanyProvider>,
  );
}

function optionCount(html: string): number {
  return (html.match(/<option/g) ?? []).length;
}

describe('公司切换下拉（页面级筛选）', () => {
  it('多公司：渲染「全部公司」+ 每个授权公司', () => {
    const html = renderSwitch(
      ['c1', 'c2', 'c3'],
      directoryOf({ c1: '演示公司（0001）', c2: '二号公司（0002）', c3: '三号公司（0003）' }),
      '全部公司（3 家）',
    );

    expect(html).toContain('全部公司（3 家）');
    expect(html).toContain('演示公司（0001）');
    expect(html).toContain('二号公司（0002）');
    expect(html).toContain('三号公司（0003）');
    expect(html).toContain('value=""');
    expect(html).toContain('value="c1"');
    expect(html).toContain('value="c2"');
    expect(html).toContain('value="c3"');
    expect(optionCount(html)).toBe(4);
  });

  it('单公司：仍可用，只有「全部公司 + 那 1 家」', () => {
    const html = renderSwitch(
      ['c1'],
      directoryOf({ c1: '演示公司（0001）' }),
      '全部公司（1 家）',
    );

    expect(html).toContain('全部公司（1 家）');
    expect(html).toContain('演示公司（0001）');
    expect(optionCount(html)).toBe(2);
  });

  it('请求失败：下拉禁用并显示「公司列表读取失败」，不露其余选项', () => {
    const html = renderSwitch(
      ['c1', 'c2'],
      { label: (id) => id, failed: true },
      '全部公司（2 家）',
    );

    expect(html).toContain('公司列表读取失败');
    expect(html).toContain('disabled');
    expect(html).not.toContain('全部公司（2 家）');
    expect(optionCount(html)).toBe(1);
  });

  it('无授权公司：下拉禁用，只显示「全部公司」', () => {
    const html = renderSwitch([], directoryOf({}), '全部公司');

    expect(html).toContain('全部公司');
    expect(html).toContain('disabled');
    expect(optionCount(html)).toBe(1);
  });

  it('useActiveCompany 在 Provider 外使用会报错，避免静默漏接', () => {
    function Probe() {
      useActiveCompany();
      return null;
    }

    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      'useActiveCompany 必须在 ActiveCompanyProvider 内使用',
    );
  });
});
