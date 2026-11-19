import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { ApiIntegrationPage } from './ApiIntegrationPage';

/**
 * #396：API 与集成页补首屏四态（其余交互已由 CompaniesPage.test.tsx 的 #144 用例覆盖）。
 */
describe('API 与集成页（#396）', () => {
  it('首屏未取数：data-state=loading 且不含数据行', () => {
    const client = createQueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ApiIntegrationPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain('r-row');
  });
});
