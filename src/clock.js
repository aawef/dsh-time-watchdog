// dsh-clock 的纯逻辑层：折叠状态 + 时长格式化。
//
// 这里刻意不 import 任何宿主包，也不碰 Date.now()：
// 所有时间由调用方传入，测试可以直接构造事件序列。

/** sessionProjections 的单元 key。 */
export const PROJECTION_KEY = "clock";

/** 折叠单元的版本。改了 state 形状必须 +1，否则同 key 共存会冲突。 */
export const STATE_VERSION = 3;

/**
 * 提醒消息的来源标记。客户端与宿主都靠它区分「自己注入的隐藏提示」
 * 与真正的用户发言——`source.kind !== "user"` 的 user/message 在 UI 里
 * 归为 context 节点，不渲染成聊天气泡。
 */
export const NOTICE_SOURCE_KIND = "dsh-clock";

/**
 * 折叠单元的初始状态。
 * @returns {{
 *   turn: number,
 *   turnStartedAt: number | null,
 *   lastTurnElapsedMs: number | null,
 *   injectSeq: number,
 *   lastInjectionAt: number | null,
 *   lastNoticeText: string | null
 * }}
 */
export function createInitialState() {
	return {
		/** 当前（或最后一轮）的轮次号，0 表示还没开过轮。 */
		turn: 0,
		/** 本轮 turn/start 的时刻（epoch ms），没有进行中的轮时为 null。 */
		turnStartedAt: null,
		/** 上一轮的总耗时（epoch ms），没有结束过的轮时为 null。 */
		lastTurnElapsedMs: null,
		/** 已注入的提醒条数，客户端靠它变化弹「提示词已发送」。 */
		injectSeq: 0,
		/** 最后一条提醒的注入时刻。 */
		lastInjectionAt: null,
		/**
		 * 最后一条提醒的正文。给客户端「详细模式」的卡片用——
		 * 客户端拿不到宿主内存，只能靠投影把这段文字带下去。
		 * 只留最后一条：卡片只显示最新那一次，留历史没有意义还会把投影撑大。
		 */
		lastNoticeText: null
	};
}

/**
 * 把一个 session 事件折叠进状态。
 * 只认 turn/start、turn/end 与本插件自己注入的 user/message，
 * 其余事件原样返回（保持引用相等，宿主据此跳过重算）。
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
		case "user/message": {
			// 只有本插件注入的提醒算数：普通用户发言的 source.kind 是 "user"。
			if (event.data?.source?.kind !== NOTICE_SOURCE_KIND) return state;
			return {
				...state,
				injectSeq: state.injectSeq + 1,
				lastInjectionAt: event.time,
				lastNoticeText: extractNoticeText(event.data)
			};
		}
		default:
			return state;
	}
}

/**
 * 从一条 user/message 里取出可以展示给用户的纯文本。
 *
 * 消息的 `content` 是分块数组（本插件只发一个 text 块），但为了不假设形状，
 * 这里挑所有 `type === "text"` 的块拼起来。取不到就返回 null，
 * 客户端据此退化成「不显示详情」而不是显示 `undefined`。
 *
 * @param {any} data - user/message 的 event.data
 * @returns {string | null}
 */
function extractNoticeText(data) {
	const content = data?.content;
	if (!Array.isArray(content)) return null;
	const parts = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	const text = parts.join(String.fromCharCode(10, 10)).trim();
	return text === "" ? null : text;
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
