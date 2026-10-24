// dsh-clock 的纯逻辑层：折叠状态 + 时长格式化。
//
// 这里刻意不 import 任何宿主包，也不碰 Date.now()：
// 所有时间由调用方传入，测试可以直接构造事件序列。

/** sessionProjections 的单元 key。 */
export const PROJECTION_KEY = "clock";

/** 折叠单元的版本。改了 state 形状必须 +1，否则同 key 共存会冲突。 */
export const STATE_VERSION = 1;

/**
 * 折叠单元的初始状态。
 * @returns {{turn: number, turnStartedAt: number | null, lastTurnElapsedMs: number | null}}
 */
export function createInitialState() {
	return {
		/** 当前（或最后一轮）的轮次号，0 表示还没开过轮。 */
		turn: 0,
		/** 本轮 turn/start 的时刻（epoch ms），没有进行中的轮时为 null。 */
		turnStartedAt: null,
		/** 上一轮的总耗时（epoch ms），没有结束过的轮时为 null。 */
		lastTurnElapsedMs: null
	};
}

/**
 * 把一个 session 事件折叠进状态。
 * 只认 turn/start 与 turn/end，其余事件原样返回（保持引用相等，宿主据此跳过重算）。
 * @param {object} state - 当前状态
 * @param {{type: string, time: number, data?: any}} event - session 事件
 * @returns {object} 新状态或原状态
 */
export function applyEvent(state, event) {
	switch (event.type) {
		case "turn/start":
			return {
				...state,
				turn: event.data.turn,
				turnStartedAt: event.time,
				lastTurnElapsedMs: null
			};
		case "turn/end": {
			const elapsed =
				state.turnStartedAt === null ? null : Math.max(0, event.time - state.turnStartedAt);
			return {
				...state,
				turnStartedAt: null,
				lastTurnElapsedMs: elapsed
			};
		}
		default:
			return state;
	}
}

/**
 * 把毫秒时长格式化成紧凑的整秒文本：`0s` / `42s` / `3m 07s` / `1h 02m 09s`。
 * 与客户端 Web 时钟的口径一致：向下取整到秒，不显示毫秒。
 * @param {number} elapsedMs - 毫秒数；负数按 0 处理
 * @returns {string}
 */
export function formatDuration(elapsedMs) {
	let seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	const pad = (value) => String(value).padStart(2, "0");
	if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
	if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
	return `${seconds}s`;
}

/**
 * 把折叠状态解释成一次读数。
 * 与客户端语义对齐：只有 turn 处于 open 状态才继续计时；轮结束后停在结束时刻的值。
 * @param {object} state - 折叠状态（可能是 undefined，表示投影未注册）
 * @param {number} now - 读取时刻（epoch ms）
 * @returns {{turn: number, running: boolean, elapsedMs: number, elapsedSeconds: number, elapsedText: string}}
 */
export function describeElapsed(state, now) {
	const safe = state ?? createInitialState();
	const running = safe.turnStartedAt !== null;
	const elapsedMs = running
		? Math.max(0, now - safe.turnStartedAt)
		: (safe.lastTurnElapsedMs ?? 0);
	return {
		turn: safe.turn,
		running,
		elapsedMs,
		elapsedSeconds: Math.floor(elapsedMs / 1000),
		elapsedText: formatDuration(elapsedMs)
	};
}

/**
 * 工具返回值 → 模型可见文本。
 * @param {{turn: number, running: boolean, elapsedMs: number, elapsedText: string}} value - 工具输出
 * @returns {string}
 */
export function renderElapsed(value) {
	const scope = value.running ? "本轮进行中，已运行" : "本轮已结束，共用时";
	const turnLabel = value.turn > 0 ? `第 ${value.turn} 轮` : "尚无进行中的轮次";
	return `${turnLabel}：${scope} ${value.elapsedText}（${value.elapsedMs} ms）。`;
}
