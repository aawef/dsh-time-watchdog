// dsh-clock 的配置解析层：把 `/clock` 后面那串人写的参数解析成「间隔秒数」。
//
// 纯函数，不碰文件系统、不碰宿主包，测试可以直接构造输入。

import { normalizeTemplates } from "./timing.js";

/** 允许的最小间隔（秒）。低于 1 秒没有意义：倒计时本身就是 1 秒一跳。 */
export const MIN_INTERVAL_SECONDS = 1;

/** 允许的最大间隔（秒）。上限只是防手滑写成 99999999。 */
export const MAX_INTERVAL_SECONDS = 3600;

/** toast 停留时长（毫秒）。需求写死 5 秒。 */
export const TOAST_HOLD_MS = 5000;

/**
 * 解析 `/clock` 的原始参数。
 *
 * 接受的写法：
 *   ``（空）      → 查询当前设置
 *   `off` / `0`  → 关闭（intervalSeconds 为 null）
 *   `30`         → 30 秒
 *   `30s` / `2m` → 秒/分后缀
 *
 * @param {string | undefined | null} rawInput - 斜杠命令后面的原文
 * @returns {{action: "query"}
 *   | {action: "disabled"}
 *   | {action: "set", intervalSeconds: number}
 *   | {action: "error", message: string}}
 */
export function parseClockInput(rawInput) {
	const text = String(rawInput ?? "").trim();
	if (text === "") return { action: "query" };

	const lower = text.toLowerCase();
	if (lower === "off" || lower === "关闭") return { action: "disabled" };

	const match = /^(\d+(?:\.\d+)?)\s*([sm]?)$/i.exec(text);
	if (match === null) {
		return {
			action: "error",
			message: `无法识别 "${text}"。用法：/clock <秒数>，可写 30、30s、2m，或 /clock off 关闭。`
		};
	}

	const value = Number(match[1]);
	const unit = match[2].toLowerCase();
	const seconds = Math.round(unit === "m" ? value * 60 : value);

	if (seconds === 0) return { action: "disabled" };
	if (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
		return {
			action: "error",
			message: `间隔要在 ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} 秒之间，收到 ${seconds} 秒。`
		};
	}
	return { action: "set", intervalSeconds: seconds };
}

/**
 * 把设置读成一句人话（命令回执用）。
 * @param {{intervalSeconds: number | null}} config - 当前设置
 * @returns {string}
 */
export function describeConfig(config) {
	const seconds = config?.intervalSeconds ?? null;
	if (seconds === null) return "提醒卡片已关闭（/clock 30 可重新开启）。";
	return `提醒卡片每 ${seconds} 秒弹出一次，显示本轮已运行时间，停留 5 秒。`;
}

/**
 * 「发送提示词时是否弹 Toast」的开关默认值。规范要求默认开启。
 */
export const DEFAULT_TOAST_ON_PROMPT = true;

/**
 * 从持久化载荷里恢复设置，任何脏数据都退回默认值。
 * @param {unknown} payload - 读到的 JSON
 * @returns {{intervalSeconds: number | null, toastOnPrompt: boolean, templates: object}}
 */
export function readConfig(payload) {
	const raw = payload?.intervalSeconds;
	const intervalSeconds =
		typeof raw === "number" && Number.isFinite(raw) && raw >= MIN_INTERVAL_SECONDS && raw <= MAX_INTERVAL_SECONDS
			? Math.round(raw)
			: null;
	const toastOnPrompt =
		typeof payload?.toastOnPrompt === "boolean" ? payload.toastOnPrompt : DEFAULT_TOAST_ON_PROMPT;
	return {
		intervalSeconds,
		toastOnPrompt,
		templates: normalizeTemplates(payload?.templates)
	};
}
