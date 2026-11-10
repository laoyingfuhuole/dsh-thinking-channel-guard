# 变更记录

## 1.0.0 — 2026-11-10

首个对外发布版本。相对开发期 `0.1.x`：

- 三条缺陷、四条规则定型：`tagRouting`（整块思考漏进正文）、`continuationRouting`（思考块与正文块在同一句话中途翻转）、`answerRescue`（回答整段留在思考通道）、`stripTags`（只对已改判的块去标记）。
- 顺序保证：被暂扣的正文块在任何属于其它块的 chunk、`usage` 或 `finish` 之前必须落定，块顺序与 provider 产出一致。
- `stripTags` 收紧：可见正文永不被改写（此前会把正文里引用的 `<thinking>` 字样删掉）。
- 安装后以 `integrity.json` + GitHub Actions 校验仓库内容与测试。
- 仓库迁移到 `VSCode/dsh-thinking-channel-guard`，以 GitHub 源安装：`github:laoyingfuhuole/dsh-thinking-channel-guard`。

## 0.1.4 — 2026-11-10

- 新增 `continuationRouting`；`stripTags` 只在已改判块上生效；本机 5,834 条消息回放修复 51 条、0 次块重排。

## 0.1.3 — 2026-11-10

- 首次加入中途翻转判定，修复会话内 `turn 1 step 97` 的真实漏例。

## 0.1.2 — 2026-11-10

- 修复 `block-start` 暂扣导致的块重排；`answerRescue` 索引改为 `maxIndex + 1 + n`。

## 0.1.1 — 2026-11-10

- 以块索引 `Map` 跟踪状态，修复工具调用增量穿插时 `block-end` 未被改写的问题。

## 0.1.0 — 2026-11-10

- 首版：`tagRouting`、`stripTags`、`answerRescue` 三条规则，配置与修复日志。
