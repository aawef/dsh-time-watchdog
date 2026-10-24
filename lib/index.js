// dsh-clock —— 宿主侧入口。
//
// 组成：
//   1. 一个 sessionProjections 折叠单元 `clock`：只记录 turn/start 的时刻与轮次，
//      并提供「本轮已用时间」的读取口径。
//   2. 一个工具 `clock_elapsed`：让模型随时读到本轮已经运行了多久。
//
// 为什么自己折叠而不是读 turnBoundary：
//   turnBoundary 只存 seq 不存时刻，取时间还得回头 eventAt()（已标记 @deprecated，
//   注释写明 "new calls are prohibited"）。自己折叠存时刻，读数是 O(1) 且不碰废弃 API。

import { z } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";

import {
	PROJECTION_KEY,
	STATE_VERSION,
	applyEvent,
	createInitialState,
	describeElapsed,
	renderElapsed
} from "../src/clock.js";

/** Loader 诊断里显示的插件名。 */
export const name = "dsh-clock";

/** 需要的宿主服务：工具注册表 + 会话投影。 */
export const inject = ["tools", "sessionProjections"];

/** 折叠单元的状态形状。改动它必须同时提升 STATE_VERSION。 */
const clockStateSchema = z.object({
	turn: z.number().int().nonnegative(),
	turnStartedAt: z.number().nullable(),
	lastTurnElapsedMs: z.number().nullable()
});

const ELAPSED_DESCRIPTION =
	"Read how long the current conversation turn has been running. " +
	"Returns the elapsed wall-clock time of the open turn (it keeps counting while the turn is open), " +
	"or the total duration of the turn that just ended. Call it whenever you need to know how much time " +
	"the user has already spent waiting in this turn.";

const ELAPSED_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		turn: {
			type: "integer",
			required: true
		},
		running: {
			type: "boolean",
			required: true
		},
		elapsedMs: {
			type: "number",
			required: true
		},
		elapsedSeconds: {
			type: "integer",
			required: true
		},
		elapsedText: {
			type: "string",
			required: true
		}
	}
};

/** 工具结果 → 模型可见内容。表头给人看，JSON 给模型解析。 */
function renderValue(_args, value) {
	return [
		{ type: "text", text: renderElapsed(value) },
		{ type: "text", text: JSON.stringify(value) }
	];
}

/** 通用的 UI 卡片，避免在宿主 UI 里显示原始 JSON。 */
function presentCall(args) {
	return { card: "generic", title: "Read elapsed time", kind: "read", ...(args ? { rawInput: args } : {}) };
}

/**
 * 读数：本轮已用时间。
 * 折叠单元提供的是状态，`Date.now()` 只在真正被调用的那一刻取，
 * 因此同一个 state 在任意时刻读出的都是「到现在为止」的值。
 * @param {object} ctx - 已解析 tools / sessionProjections 的作用域
 * @param {object | undefined} session - 调用方 Agent 的 Session
 * @returns {object} 工具的返回值
 */
function readElapsed(ctx, session) {
	const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
	return describeElapsed(state, Date.now());
}

/**
 * 注册折叠单元。与插件生命周期绑定：卸载时 Cordis 自动回收注册。
 * @param {object} ctx - 插件上下文
 */
function registerProjection(ctx) {
	ctx.sessionProjections.register({
		key: PROJECTION_KEY,
		stateVersion: STATE_VERSION,
		stateSchema: clockStateSchema,
		init: () => createInitialState(),
		apply: (state, event) => applyEvent(state, event)
	});
}

/**
 * 注册 `clock_elapsed` 工具。
 * @param {object} ctx - 插件上下文
 */
function registerTools(ctx) {
	ctx.tools.register(
		defineTool({
			name: "clock_elapsed",
			description: ELAPSED_DESCRIPTION,
			parameters: {},
			output: {
				schema: ELAPSED_OUTPUT_SCHEMA,
				render: renderValue
			},
			async execute(_args, exec) {
				const agent = exec.agent;
				if (agent === undefined) {
					return {
						turn: 0,
						running: false,
						elapsedMs: 0,
						elapsedSeconds: 0,
						elapsedText: "0s"
					};
				}
				return readElapsed(ctx, agent.session);
			},
			presentCall
		})
	);
}

/**
 * 插件入口。任何同步抛出的异常都会让插件整体加载失败，所以这里只做注册，不做 I/O。
 * @param {object} ctx - 插件上下文
 */
export function apply(ctx) {
	registerProjection(ctx);
	registerTools(ctx);
}
