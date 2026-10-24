# CHANGELOG

## 0.1.0 — 2026-10-24

首个版本：时钟本体。

- 新增 session projection `clock`（`stateVersion: 1`），折叠 `turn/start` / `turn/end`，
  记录 `turn`、`turnStartedAt`、`lastTurnElapsedMs`。
  选自有折叠而非读 `turnBoundary`：后者只存 seq，取时刻仍需 `eventAt()`（已废弃）。
- 新增工具 `clock_elapsed`：返回本轮已用时间（`turn` / `running` / `elapsedMs` /
  `elapsedSeconds` / `elapsedText`）。
  计时口径与 Web 客户端实时时钟一致：起点 `turn/start`、只在轮 open 时计时、向下取整到秒。
- 纯逻辑抽到 `src/clock.js`，附带 11 条 `node --test` 单元测试（不依赖宿主包）。
- 超时提醒（每 t 秒一次的注入）与设置项**未实现**，留待下一版。
