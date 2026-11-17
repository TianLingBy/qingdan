import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { describeLoginError } from './auth-api';
import { LoginBrandShell, LoginErrorAlert, LoginForm } from './LoginPage';

describe('登录页版式', () => {
  it('品牌区用「轻单」正名，含业务口径文案', () => {
    const html = renderToStaticMarkup(
      <LoginBrandShell>
        <span>表单占位</span>
      </LoginBrandShell>,
    );

    expect(html).toContain('轻单');
    expect(html).toContain('QINGDAN');
    expect(html).toContain('每一笔内部交易');
    expect(html).toContain('表单占位');
    // 品牌区在窄屏隐藏（≤ 768px），保证 400px 下只留表单
    expect(html).toContain('hidden w-[42%]');
  });

  it('表单字段、可访问性与演示账号提示齐全', () => {
    const html = renderToStaticMarkup(<LoginForm onLogin={async () => {}} />);

    expect(html).toContain('手机号');
    expect(html).toContain('验证码');
    expect(html).toContain('id="phone"');
    expect(html).toContain('id="code"');
    // SSR 输出保留 React 的驼峰属性名（浏览器解析后依然是 standard 属性）
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('登 录');
    expect(html).toContain('10000000001');
    expect(html).toContain('000000');
    // 初始态不该出现错误提示
    expect(html).not.toContain('role="alert"');
  });
});

describe('登录失败提示', () => {
  it('渲染文案与请求编号', () => {
    const view = describeLoginError(
      new ApiError({ code: 'UNAUTHENTICATED', message: '未登录', status: 401, requestId: 'req-9' }),
    );
    const html = renderToStaticMarkup(<LoginErrorAlert error={view} />);

    expect(html).toContain('role="alert"');
    expect(html).toContain('手机号或验证码不正确');
    expect(html).toContain('req-9');
    expect(html).not.toContain('不存在');
  });

  it('501 兜底文案不白屏（production 未接短信）', () => {
    const view = describeLoginError(
      new ApiError({ code: 'NOT_IMPLEMENTED', message: '未接短信', status: 501 }),
    );
    const html = renderToStaticMarkup(<LoginErrorAlert error={view} />);

    expect(html).toContain('未开通短信服务');
    expect(html).not.toContain('请求编号');
  });
});
