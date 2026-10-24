// dsh-clock —— 宿主侧入口。
//
// 组成：
//   1. 一个 sessionProjections 折叠单元 `clock`：只记录 turn/start 的时刻与轮次，
//      并提供「本轮已用时间」的读取口径。带 wire.view，所以客户端也能读到。
//   2. 一个工具 `clock_elapsed`：让模型随时读到本轮已经运行了多久。
//   3. 一条 `/clock` 斜杠命令：设定 toast 提醒间隔 t（秒），0/off 关闭。
//   4. 一个 HTTP 端点 `/dsh-clock/api/config`：把 t 交给浏览器端 toast。
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
import { describeConfig, parseClockInput } from "../src/config.js";
import { loadConfig, saveConfig } from "./store.js";

/** Loader 诊断里显示的插件名。 */
export const name = "dsh-clock";

/**
 * 需要的宿主服务：工具注册表 + 会话投影 + 斜杠命令。
 *
 * `webServer` 故意不写进声明式 inject：它缺席时（CLI / 无 UI 组合）插件本体
 * 依然应该可用，只是没有给浏览器端读配置的端点。缺了它就让整只插件 pending
 * 是不划算的，所以改成运行时 `ctx.get("webServer")` 探测。
 */
export const inject = ["tools", "sessionProjections", "commands"];

/** 折叠单元的状态形状。改动它必须同时提升 STATE_VERSION。 */
const clockStateSchema = z.object({
	turn: z.number().int().nonnegative(),
	turnStartedAt: z.number().nullable(),
	lastTurnElapsedMs: z.number().nullable()
});

/** 客户端可见的视图。字段与 state 一一对应，但单独声明以便将来收紧。 */
const clockViewSchema = z.object({
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
		apply: (state, event) => applyEvent(state, event),
		// 客户端（toast）需要 turnStartedAt 才能本地跳秒，所以必须有 wire 块，
		// 否则该单元是 host-only，浏览器端 useProjection("clock") 永远读到 undefined。
		wire: {
			viewSchema: clockViewSchema,
			view: (state) => ({
				turn: state.turn,
				turnStartedAt: state.turnStartedAt,
				lastTurnElapsedMs: state.lastTurnElapsedMs
			})
		}
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
 * 注册 `/clock` 斜杠命令。
 *
 * 这条命令只写配置、不碰模型历史：`dsh-commands` 的命令面本身不产生模型消息，
 * 所以「测试阶段先不提醒模型」这条约束天然成立。
 *
 * `input` 声明是可带参数的**唯一**开关：客户端 `dsh-client-ui-commands` 的
 * `matchEnter` 里，`desc.input === undefined` 时对 `/clock 30` 这种带空格的写法
 * 直接 `return void 0`（即「不归我管」），于是在浏览器端被当成普通聊天消息发给模型。
 * 声明了 `input.hint` 之后才会走 `leadingClaim`，把 `30` 作为 rawInput 交给 handler。
 * @param {object} ctx - 插件上下文
 */
function registerCommands(ctx) {
	ctx.commands.register({
		name: "clock",
		description: "设定时钟提醒卡片的间隔：/clock 30 每 30 秒弹一次，/clock off 关闭",
		input: { hint: "秒数或 off，例如 30、2m、off" },
		handler: (invocation) => {
			const parsed = parseClockInput(invocation.rawInput);
			if (parsed.action === "error") return { kind: "error", text: parsed.message };

			const current = loadConfig();
			if (parsed.action === "query") {
				return { kind: "success", text: describeConfig(current) };
			}
			const next =
				parsed.action === "disabled"
					? saveConfig({ intervalSeconds: null })
					: saveConfig({ intervalSeconds: parsed.intervalSeconds });
			return { kind: "success", text: describeConfig(next) };
		}
	});
}

/**
 * 注册给浏览器端读配置的 HTTP 端点。
 *
 * 客户端插件拿不到宿主内存，只有同源 fetch 这一条路。
 *
 * 为什么用 `ctx.inject(["webServer"], …)` 而不是 `ctx.get("webServer")`：
 * cordis 的 `get()` 默认 `strict = true`，只在「提供该服务的 fiber 已经 active
 * （state === 2）」时才返回实现。`dsh-host-webserver` 的 `[Service.init]` 是 async
 * （要等 socket bind 完成），所以在它启动期间加载的插件读到的都是 `undefined`。
 * 之前的写法在这里静默 return，于是路由从头到尾没注册上，浏览器端永远 404。
 * `ctx.inject` 会等依赖就绪后再回调，且不拖慢插件本体——工具/命令/投影照常先起。
 * @param {object} ctx - 插件上下文
 */
function registerApi(ctx) {
	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.get("webServer");
		if (webServer === undefined || typeof webServer.register !== "function") return;
		webCtx.effect(
			() =>
				webServer.register({
					kind: "prefix",
					path: "/dsh-clock/api",
					handler: async (req, res) => {
						const send = (code, body) => {
							res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify(body));
						};
						// GET 与 POST 都放行：不同客户端/手敲 URL 的习惯不同，
						// 只认 GET 会在某些路径上变成难查的 405。
						if (req.method !== "GET" && req.method !== "POST") {
							return send(405, { ok: false, error: "method not allowed" });
						}
						return send(200, { ok: true, ...loadConfig() });
					}
				}),
			"dsh-clock: config api"
		);
	});
}

/**
 * 插件入口。任何同步抛出的异常都会让插件整体加载失败，所以这里只做注册，不做 I/O。
 * @param {object} ctx - 插件上下文
 */
export function apply(ctx) {
	registerProjection(ctx);
	registerTools(ctx);
	registerCommands(ctx);
	registerApi(ctx);
}
