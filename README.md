# dsh-thinking-channel-guard

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的通道修复插件：**把漏进正文的思考收回思考通道，把整段写进思考里的回答显示为答复。**

思考与回答错位不是渲染问题。DSH 只按 provider 上报的 `blockType` 决定一段内容进"回答"还是进"思考"区，因此 provider 送错通道时，错的内容会原样入库、原样回放、原样显示。本插件挂在 `llm/stream` 瀑布最外层，改的是**流里的通道标记**，所以界面、会话记录和之后每一次 replay 看到的是同一份修好的数据。

> 状态：`v1.1.0`，本机回放 78 个会话 / 6,779 条已记录助手消息，修复 67 条、**0 次块重排**、其余逐字节一致。

## 它修的三类问题

| # | 现象 | 判据 |
| --- | --- | --- |
| 1 | 整段思考出现在回答区，通常以 `<thinking>` 之类标记开头 | 正文块以思考标记 / ` ```thinking ` 围栏开头 |
| 2 | 思考写到一半被掐断，同一句话在回答区接着写，**没有任何标记** | 上一块是 reasoning 且以非句末标点收尾，本正文块以不能起句的标点开头（``` ` ```、`,`、`)`、`"`…） |
| 3 | 回答整段写进思考区，折叠后看不到 | 以 `stop` 收尾、无正文、无工具调用，且思考正文 ≥ 40 字 |

第 2 类是真实案例里最隐蔽的一种：模型把 `reasoning` 通道关掉，把剩下的思考当正文继续输出，日志里只有两个块紧挨着，标点位置是唯一线索。

## 规则

| 规则 | 默认 | 作用 |
| --- | --- | --- |
| `tagRouting` | 开 | 以思考标记开头的正文块整块改发为 reasoning |
| `continuationRouting` | 开 | 接着上一段思考往下写的正文块整块改发为 reasoning（句末悬空在中英断句处、或正文以小写英文词起头续写） |
| `stripTags` | 开 | 只对**刚被改判**的块去掉标记；可见正文永不改写，哪怕正文里正在引用 `<thinking>` 字样 |
| `answerRescue` | 开 | 回答整段留在思考通道时补发一份正文；思考行保留原文，回答不会丢 |

健康流量逐字节转发：不重排块、不动原生 reasoning、不改正文、不合成新块。判定时最多暂扣一个正文块的前若干字节；`block-start` 的落定被严格限制在本块增量内完成，任何属于其它块、`usage` 或 `finish` 的 chunk 到来前必须先落定，因此**块顺序与 provider 产出一致**。

修复过的流会丢弃适配器的 `replayState`：那份元数据按 provider 原始块索引对齐，块被搬动后不再匹配。Harness 本就把它当"降级回放"处理（思考重放时不带签名），不是错误。

## 安装

插件市场（本机 profile）：

```text
github:laoyingfuhuole/dsh-thinking-channel-guard
```

默认跟随 `main`；要固定版本就加 tag，例如 `#v1.1.0`。

或用插件管理器指向工作区目录（开发时）：

```js
plugin_manager({ action: "install_bundle", target: "/path/to/dsh-thinking-channel-guard" })
```

安装后在「插件」页应出现 **思考通道纠偏**；`~/.dsh/thinking-channel-guard.log` 里出现一条 `guardVersion` 记录即表示已加载。卸载/重装会重载插件模块；宿主里**已经打开的旧会话**要等它下次启动才换新模块。

## 配置

`$DSH_HOME/thinking-channel-guard.json`，改完自动生效（按 mtime + size 重读）：

```json
{
  "version": 1,
  "rules": {
    "tagRouting": true,
    "continuationRouting": true,
    "stripTags": true,
    "answerRescue": true
  },
  "dryRun": false,
  "trace": false,
  "sessions": { "session-xxxx": { "tagRouting": false } }
}
```

- `dryRun`：只记录"本来会修什么"，原样转发，用来在不改变输出的前提下观察。
- `trace`：每次模型调用都写一行日志，用来确认插件确实在跑（默认关闭，只在真正修复时写）。
- `sessions[sessionId]`：按会话覆盖 `rules` 里的任意键，外加 `dryRun` / `trace`。

## 日志

`$DSH_HOME/thinking-channel-guard.log`，JSON Lines，追加写，超过 4 MiB 停止追加：

```json
{"guardVersion":"1.0.0","time":"…","sessionId":"session-…","provider":"hc-kimi","model":"kimi-k3.1-pro","dryRun":false,"blocks":4,"repairs":[{"kind":"reasoning-in-text-channel","index":0,"bytes":16}]}
```

`repairs[].kind` 取值：`reasoning-in-text-channel`、`reasoning-continuation`、`answer-rescue`、`markup-stripped`。

## 证据

- `node --test`：26 个用例，覆盖真实漏例（Kimi 两例、本会话中途翻转一例、feishu 会话小写续写两例）、健康 DeepSeek 轮次逐字节透传、仅工具调用轮次逐字节透传、四条规则的开关与边界、`dryRun`、流中断、未知 chunk 类型。
- 全库回放：`node scripts/audit.mjs <已解压的会话目录>`（需本机会话库）：6,779 条消息里修复 67 条（64 条标记整块改道 + 3 条无标记续写改道），0 次块重排，其余逐字节一致。
- 发布物校验：`npm run check:integrity` 对照 `integrity.json` 校验每个发布文件；CI 在 Node 22 / 24 上跑测试 + 校验 + `npm pack --dry-run`。

## 限制

- provider 完全不写标记、句子又自洽的泄漏无法判定（实测回放里 0 例；这类只能靠 provider 侧修）。
- 被搬动的块会以"思考"身份进入 provider 历史。若某 provider 在 replay 时拒收外来 thinking 块，请对该 provider / 会话关掉 `tagRouting`。
- 安装前的历史消息不会被追溯修改；只对之后新产生的流生效。

## 开发

```bash
node --test                # 26 个用例
npm run integrity          # 重新生成 integrity.json
npm run check              # 测试 + 完整性校验
npm pack --dry-run         # 查看发布物
```

目录：`index.js`（插件入口、配置与日志）、`lib/guard.js`（流修复算法）、`test/`（用例与真实样本）、`scripts/integrity.mjs`（发布物哈希）、`cordis.patch.yml`（bundle 插入行）。

## English

A DeepSeek Harness plugin that repairs channel mix-ups at the `llm/stream`
waterfall: reasoning that a provider delivers as ordinary `text` (with or
without `<thinking>` markup, including a flip that splits one sentence across
channels) goes back to the reasoning channel, and an answer that arrived as a
single `reasoning` block is additionally surfaced as the reply. Healthy traffic
is forwarded byte-for-byte; block order, native reasoning and visible prose are
never rewritten. Configuration and repair log live under `$DSH_HOME`. MIT.

## 许可

[MIT](LICENSE)。DeepSeek Harness 及其商标归其权利人所有；本项目为独立第三方插件，与官方无关。
