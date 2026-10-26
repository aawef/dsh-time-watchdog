# dsh-clock

给 DSH 加一只时钟：记录**本轮对话**从 `turn/start` 开始已经运行了多久，并据此做三件事：

- 模型侧：`clock_elapsed` 工具，随时读到本轮已用时间。
- 模型侧：`/set-time` 设定的**分段提醒**，在每步之前向模型注入一条隐藏提示词，催它收尾。
- 人侧：聊天气泡上方的**卡片**——周期显示「本轮已运行多久」，以及每条提示词发出时提示「提示词已发送」。
- 人侧：设置页里可编辑的 4 种提示词模板 + Toast 开关。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 计时 | 折叠单元 `clock` 在 `turn/start` 记下时刻，在 `turn/end` 结算总耗时 |
| 读数 | 工具 `clock_elapsed` 返回本轮已用时间（进行中持续累计，已结束冻结） |
| 周期卡片 | `/clock` 设的间隔，弹卡显示已运行时长 |
| 收尾提醒 | `/set-time <t1> <t2> <t3>` 三段式排程，到点注入提示词 |
| 提示词定制 | 4 种模板（开始 / 未超时周期 / 首次超时 / 超时后周期），设置页可改 |
| 配置 | `~/.dsh/storages/dsh-clock.json` |

## 计时口径

与 DSH Web 客户端右上角那个「深度求索中，用时 12s」**完全一致**：

- 起点 = `turn/start` 事件的时刻；
- **只有轮处于 open 状态才继续计时**，`turn/end` 之后读数冻结；
- 向下取整到秒。

区别只在于取数方式：客户端读的是浏览器内存里的 `timeline` 投影（宿主侧不存在等价物），
本插件自己折叠一个 session projection 存**时刻**，因此读数 O(1) 且不碰
`session.eventAt()`（该 API 已标 `@deprecated`，注释写明 "new calls are prohibited"）。

## 工具

### `clock_elapsed`

无参数。返回：

```json
{
  "turn": 7,
  "running": true,
  "elapsedMs": 93000,
  "elapsedSeconds": 93,
  "elapsedText": "1m 33s"
}
```

模型读到的正文是「第 7 轮：本轮进行中，已运行 1m 33s（93000 ms）。」，JSON 作为第二段附在后面供解析。

`running: false` 表示本轮已结束，`elapsedMs` 是这一轮的总耗时。

## 收尾提醒：`/set-time`

```
/set-time <t1> <t2> <t3>
```

每段可写裸秒数 `30`，也可写复合时长 `30s`、`2m`、`1h`、`1h20m30s`
（单位大小写不敏感，顺序必须 h→m→s，允许跳级如 `1h30s`）。

| 参数 | 含义 |
| --- | --- |
| `t1` | 到 `t2` 之前，每 `t1` 提醒一次 |
| `t2` | 预期可工作时间（截止点） |
| `t3` | 超过 `t2` 之后，每 `t3` 提醒一次；`t3 <= 0` 关闭这一档 |

示例：`/set-time 30s 5m 1m`（等价于 `/set-time 30 300 60`）= 预期 5 分钟，
期间每 30 秒提醒一次；到 5 分钟发一次「首次超时」，之后每 60 秒再催一次。
长跨度直接写 `/set-time 10s 1h20m30s 2m`。

参数上限 86400 秒（24 小时）。

### 生效规则（**只对一轮生效**）

| 下达时机 | 行为 |
| --- | --- |
| 当前没有进行中的对话 | 挂起，等**下一轮** `turn/start` 时才真正开始计时 |
| 当前有进行中的对话 | 从**指令发出时刻**起算，并立即注入「计时已生效」提示词 |
| 该轮 `turn/end` | 计划被清理，不会沿用到后续轮次；要再次生效必须重新执行 |

未指定的两份提醒（开始、首次超时）在每轮里各只发一次。

### 边界情况

- `t1 >= t2`：跳过「未超时周期提醒」这一档（否则它永远不触发，等于骗人）。
- `t3 <= 0`：「首次超时」照发，「超时后周期」关闭。
- 长工具执行期间不触发：提醒只在 `agent/pre-step` 发生，工具跑完进入下一步时才会到点。
- 到达截止点**只是注入提示词**，不会中止模型或强制结束本轮。

### 实现要点

- 通道是 `agent/pre-step`（与官方 `dsh-time-context` 同一条路）。`pre-step` 能替换进入该步的消息，
  所以注入的提醒会在**同一个模型请求**里被读到，而不是等到下一个请求。
- 注入用 `createUserMessage({ source: { kind: "dsh-clock", form: "notice", summary } })`。
  `source.kind !== "user"` 的 `user/message` 在客户端归为 `context` 节点、不渲染成聊天气泡——
  所以模型读得到、界面上看不到，正是「隐藏提示」要的效果。
- 计划（`t1/t2/t3`、`deadline`、已发档位）存在内存的 `Map<sessionId, plan>` 里，
  不写 session 事件：命令本身不改事件流，而计划的生命周期完全由 turn 边界决定。
- 排程是纯函数 `stepPlan(plan, now)`，输入当前时刻，输出「该不该提醒 + 新计划」，
  因此可以完全脱离时钟被测。
- 到达截止点后每 `t3` 秒一条，一轮最多十几条 `user/message`，是有意的取舍
  （要「每次提醒都进模型上下文」就不可能不落历史）。

## 提醒卡片（toast）

### 两张卡片

| 卡片 | 触发 | 内容 |
| --- | --- | --- |
| 已运行 | 本轮进行中，每 `/clock` 秒 | 本轮对话已运行 `Xm Ys`（+ 第 N 轮） |
| 已发送 | 宿主每注入一条提醒（投影 `injectSeq` +1） | 「提示词已发送」，可在设置页关掉 |

两张都停留 5 秒（`HOLD_MS`）后消失。

### 设间隔

| 命令 | 效果 |
| --- | --- |
| `/clock 30` | 每 30 秒弹一次 |
| `/clock 2m` | 每 2 分钟弹一次 |
| `/clock off` 或 `/clock 0` | 关闭 |
| `/clock` | 回显当前设置 |

允许 1–3600 秒。设为 `off` 时周期卡片完全不出现。

### 行为

- 只在本轮进行中计时；`turn/end` 之后不再弹。
- 第一次弹卡在「本轮开始后 t 秒」，之后每 t 秒一次，间隔从**上次弹卡时刻**算，不累积漂移。
- 换到新一轮时，弹卡基线清零，从新的 `turnStartedAt` 重新算。
- `/clock` 改完配置，页面最迟 3 秒（`CONFIG_POLL_MS`）跟上，不需要刷新。

### 实现要点

- 卡片挂在 `conversation.input.overlay`（composer 卡片顶部的零高锚点
  `data-composer-overlay`），子元素用 `bottom:100%` 浮在输入框上方。
- 客户端读的是 `useProjection("clock")`，所以 `clock` 折叠单元必须带 `wire` 块；
  没有 `wire` 的单元是 host-only，浏览器端读到 `undefined`。
- 客户端拿不到宿主内存，配置走同源 `/dsh-clock/api/config`。
- 样式只用 `--dsw-alias-*` 主题变量，不 `require` 任何 Harness Client 包。

## 设置页

设置 → 「计时与收尾提醒」（`settings.section` 槽位，id `dsh-clock`，order 92）。

- 编辑 4 种提示词模板，改动即时保存
- 「恢复默认模板」把四个文本框填回默认值（仍需点保存）
- 「发送提示词时显示 Toast」开关
- 说明区列出 `/set-time` 的参数语义与「只对一轮生效」的规则

### 占位符

| 占位符 | 替换成 |
| --- | --- |
| `&t1&` `&t2&` `&t3&` | 本次配置的三个参数，渲染成紧凑时长（`30s` / `1m30s` / `1h20m30s`） |
| `&t4&` | 未超时时 = 剩余时间；超时后 = 已超时时间，格式同上 |

四个占位符都自带单位，**模板里不要再写「&t2& 秒」**，否则会渲染成「1m30s 秒」。

保存前不校验；注入前统一替换。渲染后会再扫一遍清掉残留的 `&tN&`，
所以就算模板里写了不存在的 `&t9&` 也不会把占位符漏给模型。

## HTTP 端点

`/dsh-clock/api/config`

| 方法 | 行为 |
| --- | --- |
| `GET` / `POST` | 返回 `{ ok, intervalSeconds, toastOnPrompt, templates, defaults, templateKeys }` |
| `PUT` | 局部更新（body 里给哪些字段就改哪些），返回更新后的完整配置 |

`webServer` 缺席（CLI / 无 UI 组合）时端点不注册，插件其余功能照常。

## 安装

```bash
# 1. 接到 profile（junction，不需要管理员权限）
powershell -Command "New-Item -ItemType Junction -Path \"$env:USERPROFILE\.dsh\profiles\desktop\my-plugins\dsh-clock\" -Target \"<本目录绝对路径>\""

# 2. 在 ~/.dsh/profiles/desktop 里加依赖并装
#    package.json → dependencies:  "dsh-clock": "file:../web/my-plugins/dsh-clock"
#    package.json → dsh.profile.bundles:  追加 "dsh-clock"
pnpm install
```

重启桌面进程后生效（宿主侧 `lib/index.js` 是 ESM，刷新页面不够）。

## 生效规则

| 文件 | 改完之后 |
| --- | --- |
| `lib/index.js` / `src/*` | **重启桌面进程** |
| `lib/client.js` | 刷新页面（客户端资源是 no-cache 的） |
| `package.json` | 重启；改了依赖还要 `pnpm install` |
| `cordis.patch.yml` | 重启 |

注意：`~/.dsh/profiles/desktop/node_modules/dsh-clock` 是 pnpm 装出来的**副本**，
不是软链。改完源目录要重新 `pnpm install`（或手 copy）才会进宿主。

## 配置文件

`~/.dsh/storages/dsh-clock.json`

```json
{
  "intervalSeconds": 30,
  "toastOnPrompt": true,
  "templates": {
    "start": "…",
    "before": "…",
    "firstOverdue": "…",
    "afterOverdue": "…"
  }
}
```

`intervalSeconds: null` = 周期卡片关闭。文件坏了/读不到时一律退回默认值，不影响插件加载。
设置页保存时会写全四个模板，所以文件里看到的一定是完整形状。

## 测试

```bash
node --test "tests/*.test.mjs" "tests/*.mjs"
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/clock.test.mjs` | 折叠单元与读数口径 |
| `tests/timing.test.mjs` | `/set-time` 解析、模板渲染、`stepPlan` 排程决策 |
| `tests/client.test.mjs` | 客户端纯函数（vm 沙箱里求值 `lib/client.js`） |
| `tests/client.render.test.mjs` | 迷你 React 渲染卡片，验证弹/不弹/撤/换轮 |
| `tests/host.test.mjs` | 假 ctx 跑 `apply()`，验证注册、折叠、命令回执、pre-step 注入 |

前四个都不 import 宿主包，在插件目录内即可跑；`host.test.mjs` 需要能解析
`@deepseek-ai/dsh-llm` 与 `dsh-tools`（只在 profile 的 node_modules 下成立），
解析不到时整组 skip 而不是报错。

当前共 **71 条**：安装副本（`~/.dsh/profiles/desktop/node_modules/dsh-clock`）跑满 71 条全绿；
源目录跑 60 条（59 pass + 1 skip），差额都是 `host.test.mjs` 需要宿主包的那部分。
