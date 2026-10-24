# CHANGELOG

## 0.2.1 — 2026-10-24

真机上暴露的两个接线缺陷，都不影响离线测试（26 条测试全绿却仍然不可用）。

- 修：`/clock 30` 这类带参数的命令完全无效，会被当成普通聊天消息发给模型。
  根因在客户端 `dsh-client-ui-commands` 的 `matchEnter`：命令描述符没有 `input`
  时，带空格的写法直接 `return void 0`（不认领），只有声明了 `input.hint`
  才走 `leadingClaim` 把参数当 `rawInput` 传下来。给 `/clock` 补上
  `input: { hint: "秒数或 off，例如 30、2m、off" }`。
- 修：`GET /dsh-clock/api/config` 一直 404，浏览器端拿不到 t，卡片永不弹。
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
- 新增 HTTP 端点 `GET /dsh-clock/api/config`：把 t 交给浏览器端（客户端拿不到宿主内存，
  只有同源 fetch 一条路）。
- 配置持久化到 `~/.dsh/storages/dsh-clock.json`（`{ "intervalSeconds": number | null }`），
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
