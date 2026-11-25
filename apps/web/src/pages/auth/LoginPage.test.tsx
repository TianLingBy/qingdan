import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { describeLoginError } from './auth-api';
import { LoginBrandShell, LoginErrorAlert, LoginForm, LoginNoCompany } from './LoginPage';

describe('登录页版式（v3.0）', () => {
  it('品牌区用「轻单」正名，含业务口径文案', () => {
    const html = renderToStaticMarkup(
      <LoginBrandShell>
        <span>表单占位</span>
      </LoginBrandShell>,
    );

    // v3.0 品牌区用「轻」字标 + 英文副标；产品名「轻单」在表单标题里
    expect(html).toContain('>轻<');
    expect(html).toContain('QINGDAN · INTERNAL LEDGER');
    expect(html).toContain('每一笔内部交易');
    expect(html).toContain('表单占位');
    // v3.0 版式：左品牌右表单，品牌区在窄屏由 app-v30.css 的 @media 隐藏（≤ 900px）
    expect(html).toContain('lg-wrap');
    expect(html).toContain('lg-brand');
    expect(html).toContain('lg-formpane');
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
    // 初始态：idle、不该出现错误提示
    expect(html).toContain('data-state="idle"');
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

describe('入企降级：未加入任何企业', () => {
  it('只做空态，不出现邀请码输入与「加入企业」按钮', () => {
    const html = renderToStaticMarkup(<LoginNoCompany />);

    expect(html).toContain('还没有加入任何企业');
    expect(html).toContain('请联系管理员开通');
    // 四态：空态挂在容器上，靠 CSS 显示（app-v013 的四态机制）
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('st-empty');
    // 后端没有邀请码端点，界面不许画（#435 拍板）
    expect(html).not.toContain('邀请码');
    // 没有自助入企入口：既没有邀请码输入框，也没有「加入企业」按钮
    expect(html).not.toContain('<input');
    expect(html).not.toContain('加入企业</button>');
  });
});
