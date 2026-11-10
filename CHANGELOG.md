# 变更记录

## 1.1.0 — 2026-11-10

- `continuationRouting` 扩到**无标记续写**：正文块以小写英文词起头、且上一段思考停在不能收句的位置（悬空功能词 / 中文短语中途）时整块改发 reasoning。修掉 feishu 会话第 22 轮 step 10「perhaps fully消缺?…」与 step 13「table with 8 steps…」两处泄漏；此前只认标点开头的续写，这两条被漏掉。
- 续写判定改用**实时思考尾部**而不是已闭合块：真实流的 block-end 会在下一个块开始之后才到，旧判据在多数轮次拿不到尾部。
- 单测 26 个；全库回放 78 个会话 / 6,779 条消息 → 修复 67 条、0 次块重排。

## 1.0.3 — 2026-11-10

- 测试命令改为 `node --test`（自动发现用例），修掉 Node 22 CI 上把 `test/` 当模块解析导致的失败；CI 已跑通 Node 22 / 24。
- README 安装示例改为跟随 `main`，固定版本改用 tag。

## 1.0.2 — 2026-11-10

- `guardVersion` 改为读取随包发布的 `package.json`，日志里的版本与本仓库/发布物永远一致（此前常量漏了一次升级）。
- 单测新增一条版本一致性断言。

## 1.0.1 — 2026-11-10

- 发布物内含 `scripts/`，安装后可直接 `node scripts/integrity.mjs --check` 校验自身每个文件的哈希；`integrity.json` 同步覆盖脚本。

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
