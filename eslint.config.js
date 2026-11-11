import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 模块边界（ADR-0001 / AGENTS.md「开发约定」）：
 * 业务模块只能从 `@qingdan/contracts` 与 `apps/api/src/platform` 的公开入口 import，
 * 禁止 modules/a → modules/b 直接 import（要数据调对方服务层函数或只读视图）。
 * 这里用相对路径越级（`../../modules/…`）兜底拦截；ESM 包名引用由 code review 兜住。
 */
const crossModuleBan = [
  'error',
  {
    patterns: [
      {
        group: ['../../modules/*', '../../modules/**', '../../../modules/**'],
        message: '禁止跨业务模块直接 import：走对方服务层函数或只读视图（AGENTS.md 开发约定）。',
      },
    ],
  },
];

export default tseslint.config(
  {
    // design/ 是静态设计稿（浏览器脚本，不进构建），与 prototype.html 同性质：不参与 lint。
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts', 'prototype.html', 'design/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: { 'no-restricted-imports': crossModuleBan },
  },
  {
    // tools/ 下是独立 Node 脚本（不参与 tsconfig），需要显式声明所用全局。
    files: ['tools/**/*.mjs', 'tools/**/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
);
