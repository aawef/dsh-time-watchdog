# CHANGELOG

## 1.0.0 — 2026-10-26

**首次开源发布**，同时**从 `dsh-clock` 改名为 `dsh-time-watchdog`**。

改名的原因很实际：npm 上 `dsh-clock` 已被另一个 DSH 插件占用（作者 trk23 的「省钱时钟」，
最新 0.1.2），而 npm 包名全局唯一、不能覆盖，所以只能用新名字发布。
既然要改名，就一次改彻底——包名、插件 id、配置文件名、HTTP 路径、`source.kind`、
投影 key 全部统一成 `dsh-time-watchdog`，不留两套名字互相将就。

### 破坏性变更（从 0.3.x 升级时看这里）

| 项目 | 旧值 | 新值 |
| --- | --- | --- |
| npm 包名 / 插件 id | `dsh-clock` | `dsh-time-watchdog` |
| 配置文件 | `~/.dsh/storages/dsh-clock.json` | `~/.dsh/storages/dsh-time-watchdog.json` |
| HTTP 端点 | `/dsh-clock/api/config` | `/dsh-time-watchdog/api/config` |
| 折叠单元 key | `"clock"` | `"watchdog"` |
| 注入消息 `source.kind` | `"dsh-clock"` | `"dsh-time-watchdog"` |
| 源文件 `src/clock.js` | — | `src/watchdog.js` |

**配置文件不会自动迁移**：新的路径下没有文件时会用默认值。旧配置里如果你改过
提示词模板或 `/clock` 间隔，请把 `~/.dsh/storages/dsh-clock.json` 复制成
`dsh-time-watchdog.json` 再重启，或直接在设置页重设一次。

**两个斜杠命令没有改名**：`/clock`（周期卡片间隔）与 `/set-time`（三段式提醒）保持原样，
已有的使用习惯不用改。工具名 `clock_elapsed` 也保持不变——它描述的是「本轮已用时间」
这件事，跟插件叫什么无关。

### 新增（开源相关）

- `LICENSE`（MIT）。
- `package.json` 补齐 `author` / `repository` / `homepage` / `bugs` / `dsh-plugin` 关键字，
  `files` 白名单加入 `LICENSE` 与 `docs`。
- `docs/发布说明.md`：npm / GitHub Release / awesome-dsh-plugin 三条发布通道的完整操作手册，
  含收录门槛、PR 模板、以及「市场卡片版本号滞后约一天」这类容易误判的现象。
- `.github/workflows/release.yml`：push `v*` 自动建 Release，校验 tag 与版本一致、
  语法自检、检查 `dsh.bundle.patch` 存在、从本 CHANGELOG 抽本节当 release notes、
  并把不带版本号的 `dsh-time-watchdog.tgz` 挂上去。
- `README.md` 重写：加 npm/license/topic 徽章、英文摘要、一句话安装命令。

### 修正

- `tests/host.test.mjs` 里「两条命令名字」的断言仍然只断言 `clock` / `set-time`——
  这是对的，命令确实没改名；但注释里写明原因，免得以后误以为漏改。

## 0.3.2 — 2026-10-26

「提示词已发送」卡片多了一个「显示详细内容」开关。

- 新增配置项 `toastDetail`（默认 `false`）：关闭时卡片只写「提示词已发送」，
  与之前一致；打开后卡片里追加本条提示词的**渲染后正文**，方便核对模板效果。
- 正文来源是折叠单元新增的 `lastNoticeText`：`user/message` 里只挑 `type === "text"`
  的块拼起来，取不到就退回简写，不会把 `undefined` 甩到界面上。
- 正文块限高 9em、内部滚动、`pre-wrap` 换行，长提示词不会把输入框顶飞。
- 设置页在 Toast 开关下面新增同名勾选项；关掉 Toast 时该勾选项禁用并置灰。
- 两个开关互相独立：`toastOnPrompt` 管弹不弹，`toastDetail` 管弹出来是否带正文。
- 开关改完靠 `CONFIG_POLL_MS`（3 秒）轮询同步，不用刷新页面。
- 测试：新增 `tests/config.test.mjs`（10 条，含 `toastDetail` 只认真布尔值），
  渲染测试补 3 条（详细模式开/关、切换后下一次注入即生效），`tests/clock.test.mjs` 补 2 条
  正文提取边界。双副本 89/89 通过。

## 0.3.1 — 2026-10-26

`/set-time` 的三个参数支持复合时长，注入的提示词也不再把数字裸甩成秒。

- 参数解析支持 `1h20m30s` 这种写法：`10s 1h20m30s 2m` 等价于 `10 4830 120`。
  单位大小写不敏感，数字可带小数，允许跳级（`1h30s`），但顺序必须是 h→m→s，
  倒序（`30s20m`）和重复单位（`1h1h`）会被明确拒绝并指出是哪个参数。
- 新增 `formatCompactDuration(seconds)`：`45s` / `1m` / `1m30s` / `1h` / `1h20m30s`，
  中间为 0 的段省略（`1h30s` 而不是 `1h0m30s`）。不足一分钟只给秒。
- 模板占位符 `&t1&` `&t2&` `&t3&` `&t4&` **全部**改用它渲染。之前 `&t2&` 输出
  `300`、`&t4&` 输出 `4m 00s`，现在统一成 `5m` / `4m`，模板里不用再自己补单位。
- 默认模板去掉尾随的「秒」字（否则会渲染成「1m30s 秒」）。**若你改过模板，
  而模板里写了「&t2& 秒」，请手动删掉那个「秒」。**
- `/set-time`、`describePlan`、命令帮助、设置页说明同步改成新写法示例。

## 0.3.0 — 2026-10-26

新增「按时间收尾提醒」：一条 `/set-time` 命令让模型在对话超时时被提示收尾，
外加设置页可定制的提示词模板与「提示词已发送」卡片。

- 新增 `src/timing.js`：`/set-time <t1> <t2> <t3>` 的解析、4 档模板渲染（占位符
  `&t1&` `&t2&` `&t3&` `&t4&`）、以及纯函数排程 `stepPlan(plan, now)`。
- 新增 `agent/pre-step` 监听：每步之前判断该不该提醒，到期就用
  `createUserMessage({ source: { kind: "dsh-time-watchdog", form: "notice" } })` 把提示词
  加进这一步的 `messages`。因为 `pre-step` 能替换进入该步的消息，提示词与工具结果
  在同一个模型请求里被读到，不必等到下一轮。
- 新增 `/set-time` 命令：`/set-time 30 300 60` = 预期 5 分钟、期间每 30 秒提醒、
  超时后每 60 秒提醒；空参数查询；`t3 <= 0` 关闭超时后周期；`t1 >= t2` 跳过未超时周期。
- 新增「只对一轮生效」的生命周期：没有进行中的对话时挂起给下一轮，有则从指令发出
  时刻起算并立即注入开始提示词，该轮 `turn/end` 即清理（`pending` 的计划例外——
  它是给下一轮的，必须活过这一轮的 `turn/end`）。
- 折叠单元 `clock` 升到 `stateVersion: 2`：新增 `injectSeq` / `lastInjectionAt`，
  客户端据此知道「宿主刚注入了一条提醒」。
- 新增「提示词已发送」卡片：投影 `injectSeq` 变大就弹 5 秒，可在设置页关闭。
- 新建设置页标签页（`settings.section`，id `dsh-time-watchdog`，order 92）：编辑 4 种模板、
  恢复默认、保存、Toast 开关、参数语义说明。
- 配置形状扩展为 `{ intervalSeconds, toastOnPrompt, templates }`，读不到一律退回默认值；
  `PUT /dsh-time-watchdog/api/config` 支持局部更新。
- 新增测试：`tests/timing.test.mjs`（21 条）、`tests/host.test.mjs`（12 条，
  用假 ctx 跑 `apply()`）。客户端 `__test` 补 `stepInjectionToast`。

### 事实更正（写在这里免得以后又踩）

- **`billion-context` 并不走 `agent/pre-step`**：它的 `dist/agent/dsh-native.js`
  里 `agent/pre-step` / `createUserMessage` / `systemPrompt` / `sessionProjections`
  的引用数全是 0，它是在 `llm/stream` 水位线上改请求。把它当作「注入通道样板」是错的。
- **`runtime-context` 注入会落历史**（`dsh-agent-loop/lib/index.js:1062-1066`
  用 `surfaceOp: "append"`）。想让一条提醒能被模型读到，就必然要落一条 `user/message`，
  「既进模型上下文又完全不进历史」不存在。本插件选择落历史，接受这个代价。

## 0.2.1 — 2026-10-24

真机上暴露的两个接线缺陷，都不影响离线测试（26 条测试全绿却仍然不可用）。

- 修：`/clock 30` 这类带参数的命令完全无效，会被当成普通聊天消息发给模型。
  根因在客户端 `dsh-client-ui-commands` 的 `matchEnter`：命令描述符没有 `input`
  时，带空格的写法直接 `return void 0`（不认领），只有声明了 `input.hint`
  才走 `leadingClaim` 把参数当 `rawInput` 传下来。给 `/clock` 补上
  `input: { hint: "秒数或 off，例如 30、2m、off" }`。
- 修：`GET /dsh-time-watchdog/api/config` 一直 404，浏览器端拿不到 t，卡片永不弹。
  根因是 `ctx.get("webServer")` 的 cordis 语义：`get()` 默认 `strict = true`，
  只返回「提供方 fiber 已 active」的服务，而 `dsh-host-webserver` 的
  `[Service.init]` 是 async（等 socket bind），插件加载时它还没就绪 → 读到
  `undefined` → 早退 → 路由从未注册。改用 `ctx.inject(["webServer"], …)`，
  依赖就绪后再注册；工具/命令/投影仍在 `apply()` 里同步先起，不被拖慢。
- 顺带：该端点现在 GET 与 POST 都放行，避免不同客户端方法不匹配变成 405。

## 0.2.0 — 2026-10-24

新增「提醒卡片」（toast）与配置入口，用于测试计时链路。

- 新增客户端半边 `lib/client.js`：注册到 `conversation.input.overlay`（composer 顶部零高锚点），
  本轮对话运行期间，每 t 秒弹一张卡片显示「本轮已运行 Xm Ys」，停留 5 秒后自行消失。
  排程从 `turnStartedAt` 起算，间隔按「上次弹卡时刻」推进，不累积漂移；`turn/end` 后不再弹。
- 新增 `/clock` 斜杠命令：`/clock 30` 设 30 秒，`/clock 2m` 用分钟，`/clock off`（或 `0`）关闭，
  空参数回显当前设置。命令只写配置、不产生模型消息。
- 新增 HTTP 端点 `GET /dsh-time-watchdog/api/config`：把 t 交给浏览器端（客户端拿不到宿主内存，
  只有同源 fetch 一条路）。
- 配置持久化到 `~/.dsh/storages/dsh-time-watchdog.json`（`{ "intervalSeconds": number | null }`），
  不走 `storageDomain`：只有一个数字，且那块 API 有「绝不能 import 内核包」的坑。
- `clock` 折叠单元补上 `wire` 块（`viewSchema` + `view`），否则是 host-only，
  浏览器端 `useProjection("clock")` 永远读到 `undefined`，卡片无从计时。
- `inject` 收窄为 `["tools", "sessionProjections", "commands"]`：`webServer` 改成运行时
  `ctx.get()` 探测，它在 CLI / 无 UI 组合里缺席时插件本体依然可用。
- 测试增至 26 条：`tests/clock.test.mjs` 覆盖折叠与读数，`tests/client.test.mjs` 覆盖
  `formatDuration` / `stepToast` / `isToastVisible`（在 vm 沙箱里求值 client.js，不碰 DOM），
  `tests/client.render.test.mjs` 用迷你 React 把卡片真渲染成 HTML，验证「到点弹 / 间隔未到不弹 /
  off 不弹 / 5 秒撤 / 换轮重置」。
- 修：本轮 `turn/end` 时停表会连带停掉本地 tick，若卡片正挂在屏幕上就再也不会消失。
  改为「本轮在跑 **或** 卡片还挂着」都继续 tick。

## 0.1.0 — 2026-10-24

首个版本：时钟本体。

- 新增 session projection `clock`（`stateVersion: 1`），折叠 `turn/start` / `turn/end`，
  记录 `turn`、`turnStartedAt`、`lastTurnElapsedMs`。
  选自有折叠而非读 `turnBoundary`：后者只存 seq，取时刻仍需 `eventAt()`（已废弃）。
- 新增工具 `clock_elapsed`：返回本轮已用时间（`turn` / `running` / `elapsedMs` /
  `elapsedSeconds` / `elapsedText`）。
  计时口径与 Web 客户端实时时钟一致：起点 `turn/start`、只在轮 open 时计时、向下取整到秒。
- 纯逻辑抽到 `src/clock.js`，附带 11 条 `node --test` 单元测试（不依赖宿主包）。
- 超时提醒模型（每 t 秒的提示词注入）**未实现**，留待下一版；当前用 toast 卡片代替以便测试。
