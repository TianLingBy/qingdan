import type { TodoList } from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

/**
 * 工作台（`/workbench`）的 API 薄封装。
 *
 * 只包一个端点：`GET /api/v1/todos`（契约 `packages/contracts/src/todos.ts`，
 * operationId `workbench.todos.read`，domain=workbench，action=read，`audit.kind='none'`）。
 *
 * ## 这个页面为什么曾经全是假数据
 *
 * 页面骨架（#5）比待办接口（D89 / #289）先落地。当时为了先把版式与交互定下来，
 * 数据来自 `workbench-mock.ts`，注释里留了四条 `TODO(接口待做)`。四条现在都做完了：
 *
 * - `GET /api/v1/todos` —— D89，还带了第 7 类「低库存批次」（D104 / #378）
 * - `GET /api/v1/inventory/alerts` —— D104
 * - `GET /api/v1/companies` —— #319
 * - `GET /api/v1/sales-orders?handlerId=me` —— **只有这一条还没做**（#354 第 3 条）
 *
 * 所以本文件只能接第一项。「我负责的进行中单据」那一块撤掉了，原因写在
 * `WorkbenchPage.tsx` 的 `ActiveDocsPanel` 位置：宁可少一块，不留一块假的。
 *
 * ## 为什么封装成工厂
 *
 * 测试要注入假 fetch 断言请求形状。工厂模式让 `createWorkbenchApi(recorder)` 能单独测，
 * 不必渲染整页（这页还依赖 Router 上下文）。
 */
export function createWorkbenchApi(client: ApiClient = apiClient) {
  return {
    /**
     * 待办笔数。
     *
     * 返回的是**笔数**不是金额 —— 后端刻意只回 `count`（D89：避免绕过 `view_price`）。
     * 也**不保证覆盖全部 7 类**：后端按「该条目声明的动作」逐条判权限
     * （前 6 类要 `approve`、第 7 类要 `inventory_qty.read`），没权限的条目直接不返回。
     * 所以前端不要拿 `items.length` 当「一共有几类待办」用。
     */
    todos: () => client.get<TodoList>('/todos'),
  };
}

export const workbenchApi = createWorkbenchApi();

export const workbenchKeys = {
  todos: ['workbench', 'todos'] as const,
};
