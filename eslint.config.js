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
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts', 'prototype.html'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: { 'no-restricted-imports': crossModuleBan },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
);
