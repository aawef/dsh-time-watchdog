# dsh-clock

给 DSH 加一只时钟：记录**本轮对话**从 `turn/start` 开始已经运行了多久。

- 模型侧：`clock_elapsed` 工具，随时读到本轮的已用时间。
- 人侧：聊天气泡上方的**提醒卡片**（toast），本轮进行中每 `t` 秒弹一次，显示「本轮已运行 Xm Ys」，停留 5 秒后消失。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 计时 | 折叠单元 `clock` 在 `turn/start` 记下时刻，在 `turn/end` 结算总耗时 |
| 读数 | 工具 `clock_elapsed` 返回本轮的已用时间（进行中则持续累计，已结束则冻结在结束时刻） |
| 提醒卡片 | 客户端槽位 `conversation.input.overlay`，按 `/clock` 设的间隔弹卡 |
| 配置 | `/clock 30` 设间隔，`/clock off` 关闭 |

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

## 提醒卡片（toast）

### 设间隔

在输入框里发斜杠命令（不产生模型消息）：

| 命令 | 效果 |
| --- | --- |
| `/clock 30` | 每 30 秒弹一次 |
| `/clock 2m` | 每 2 分钟弹一次 |
| `/clock off` 或 `/clock 0` | 关闭 |
| `/clock` | 回显当前设置 |

允许 1–3600 秒。设为 `off` 时卡片完全不出现。

### 行为

- 只在本轮进行中计时；`turn/end` 之后不再弹。
- 第一次弹卡在「本轮开始后 t 秒」，之后每 t 秒一次，间隔从**上次弹卡时刻**算，不累积漂移。
- 卡片停留 5 秒（`HOLD_MS`）后自动消失。
- 换到新一轮时，弹卡基线清零，从新的 `turnStartedAt` 重新算。
- `/clock` 改完配置，页面最迟 3 秒（`CONFIG_POLL_MS`）跟上，不需要刷新。

### 实现要点

- 卡片挂在 `conversation.input.overlay`（composer 卡片顶部的零高锚点
  `data-composer-overlay`），子元素用 `bottom:100%` 浮在输入框上方。
- 客户端读的是 `useProjection("clock")`，所以 `clock` 折叠单元必须带 `wire` 块；
  没有 `wire` 的单元是 host-only，浏览器端读到 `undefined`。
- 客户端拿不到宿主内存，配置走同源 `GET /dsh-clock/api/config`；
  该端点在宿主侧注册，`webServer` 缺席时（CLI / 无 UI 组合）静默跳过。
- 样式只用 `--dsw-alias-*` 主题变量，不 `require` 任何 Harness Client 包。

## 安装

```bash
# 1. 接到 web profile（junction，不需要管理员权限）
powershell -Command "New-Item -ItemType Junction -Path \"$env:USERPROFILE\.dsh\profiles\web\my-plugins\dsh-clock\" -Target \"<本目录绝对路径>\""

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
{ "intervalSeconds": 30 }
```

`null` = 关闭。文件坏了/读不到时一律按「关闭」处理，不影响插件加载。

## 测试

```bash
node --test "tests/*.test.mjs" "tests/*.mjs"
```

- `tests/clock.test.mjs`：折叠单元与读数口径（纯逻辑）。
- `tests/client.test.mjs`：`formatDuration` / `stepToast` / `isToastVisible`
  （在 vm 沙箱里求值 `lib/client.js`，不碰 DOM）。
- `tests/client.render.test.mjs`：用迷你 React 把卡片真渲染成 HTML，验证
  「到点弹 / 间隔未到不弹 / off 不弹 / 5 秒撤 / 换轮重置 / 轮结束也能撤干净」。

三套都不 import 宿主包，所以在插件目录内就能跑。当前共 26 条。
