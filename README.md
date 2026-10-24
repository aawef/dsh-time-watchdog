# dsh-clock

给 DSH 加一只时钟：记录**本轮对话**从 `turn/start` 开始已经运行了多久，并通过 `clock_elapsed` 工具让模型随时读到。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 计时 | 折叠单元 `clock` 在 `turn/start` 记下时刻，在 `turn/end` 结算总耗时 |
| 读数 | 工具 `clock_elapsed` 返回本轮的已用时间（进行中则持续累计，已结束则冻结在结束时刻） |

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
| `package.json` | 重启；改了依赖还要 `pnpm install` |
| `cordis.patch.yml` | 重启 |

## 测试

```bash
node --test "tests/*.test.mjs"
```

测试只覆盖 `src/clock.js` 的纯逻辑，不 import 任何宿主包，所以在插件目录内就能跑。
