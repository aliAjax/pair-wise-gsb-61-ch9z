# 汽车型式认证证据包审阅与补件平台

用于按车型、配置、法规项目和维护版本组织测试报告、部件清单、软件版本及豁免材料的本地认证工作台。

## 技术栈

- Nuxt 3 + TypeScript
- Nuxt UI
- Pinia
- Nuxt Router
- ofetch
- TanStack Query for Vue

## 主要工作区

- `/`：认证项目列表、关键词/状态/机构/风险筛选和项目统计（只读唯一有效批次）
- `/review-batches`：复核批次与离线回网控制台（导出/导回离线包、双版本裁定、写入故障演练、批次续作）
- `/projects/new`：建立车型、配置、维护版本和软件版本基线
- `/projects/[id]`：证据审阅、法规覆盖、状态流转、版本差异、批量补件和审计（冻结项目只读）
- `/regulations`：按法规分类查看项目证据覆盖
- `/supplements`：跨项目批量补件（含软件基线变更后的失效重算项）
- `/reminders`：证书和证据到期提醒
- `/audit`：跨项目审批时间线与提交包导出（只携带当前有效批次）

## 本地运行

```bash
npm install
npm run dev
```

访问 `http://localhost:18461`。

## 构建与检查

```bash
npm run typecheck
npm run build
```

项目没有后端服务，使用结构化模拟数据，并通过 Pinia 和浏览器 `localStorage` 持久化车型项目、证据状态、版本和审计记录。ofetch 由本地模拟 fetch 适配器承载，TanStack Query 负责项目索引查询和筛选缓存。

## 可续作复核批次

认证项目、证据文件、法规项目和审计记录同属一份**复核批次（review batch）**，持久化于批次文档 `vehicle-type-approval-batches-v2`：

- **唯一有效批次**：任一时刻只有一份 `active` 批次；列表、详情和提交包只读取它，旧批次 `superseded` 留档，可在批次台恢复续作。
- **离线回网三方合并**：离线复核包 JSON 内嵌导出时刻的项目基线快照与指纹；回网时按「基线 / 在线 / 离线」三方合并。在线窗口刚改而离线未动的状态、软件基线得以保留；离线单边改动按基线并入；离线审计记录以 `offline` 来源并入时间线。
- **同一证据两边改过**：保留在线、离线两条版本（共享 `conflictGroup`，均挂 `pendingReview`），在批次台裁定采用在线版 / 离线版 / 两版并存；未被采用的版本打 `superseded` 留档但不进列表、覆盖和提交包。
- **软件基线联动**：软件版本一改变，旧版本证据立即 `invalidated`、已接受证据打回 `resubmit`，受影响配置的法规覆盖重算为冲突/缺失，补件队列自动纳入；补件对齐基线后清除失效标记并重新计算覆盖。
- **冻结只读**：`approved` 项目对在线编辑与离线改动均只读，离线包中的冻结项目修改回网时被拒绝并登记冲突。
- **写入失败恢复**：每次写入先把完整批次落入恢复区（WAL）再提交主文档；写入失败时内存视图不前进，仍展示当前有效批次，待提交完整批次保留待「按完整批次重试」。批次台提供 `fail_once / fail_always` 故障注入。

## 引擎校验

纯数据层（`services/review-batch.ts`、`services/batch-storage.ts`、Pinia store）通过 Node 演练脚本覆盖双版本、冻结、失效重算、补件联动、写入恢复与批次续作：

```bash
node scripts/verify-batch.mjs
```
