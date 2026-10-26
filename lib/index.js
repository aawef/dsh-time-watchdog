// dsh-clock —— 宿主侧入口。
//
// 组成：
//   1. 一个 sessionProjections 折叠单元 `clock`：记录 turn/start 的时刻、
//      轮次，以及本插件注入过几条提醒。带 wire.view，客户端能实时读到。
//   2. 一个工具 `clock_elapsed`：让模型随时读到本轮已经运行了多久。
//   3. 两条斜杠命令：`/clock`（旧的周期卡片间隔）与 `/set-time`（定时收尾提醒）。
//   4. 一个 HTTP 端点 `/dsh-clock/api/config`：把配置交给浏览器端。
//   5. 一个 `agent/pre-step` 监听器：按 `/set-time` 的排程在每步之前注入收尾提示词。
//
// 为什么自己折叠而不是读 turnBoundary：
//   turnBoundary 只存 seq 不存时刻，取时间还得回头 eventAt()（已标记 @deprecated，
//   注释写明 "new calls are prohibited"）。自己折叠存时刻，读数是 O(1) 且不碰废弃 API。

import { z } from "zod";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

import {
	NOTICE_SOURCE_KIND,
	PROJECTION_KEY,
	STATE_VERSION,
	applyEvent,
	createInitialState,
	describeElapsed,
	formatDuration,
	renderElapsed
} from "../src/clock.js";
import { describeConfig, parseClockInput } from "../src/config.js";
import {
	DEFAULT_TEMPLATES,
	TEMPLATE_KEYS,
	armPlan,
	createPlan,
	describePlan,
	parseSetTime,
	renderTemplate,
	stepPlan,
	templateT4
} from "../src/timing.js";
import { loadConfig, patchConfig, saveConfig } from "./store.js";

/** Loader 诊断里显示的插件名。 */
export const name = "dsh-clock";

/**
 * 需要的宿主服务：工具注册表 + 会话投影 + 斜杠命令 + agent 事件总线。
 *
 * `webServer` 故意不写进声明式 inject：它缺席时（CLI / 无 UI 组合）插件本体
 * 依然应该可用，只是没有给浏览器端读配置的端点。缺了它就让整只插件 pending
 * 是不划算的，所以改成运行时探测后 `ctx.inject` 等它就绪。
 */
export const inject = ["tools", "sessionProjections", "commands"];

/** 折叠单元的状态形状。改动它必须同时提升 STATE_VERSION。 */
const clockStateSchema = z.object({
	turn: z.number().int().nonnegative(),
	turnStartedAt: z.number().nullable(),
	lastTurnElapsedMs: z.number().nullable(),
	injectSeq: z.number().int().nonnegative(),
	lastInjectionAt: z.number().nullable()
});

/** 客户端可见的视图。字段与 state 一一对应，但单独声明以便将来收紧。 */
const clockViewSchema = z.object({
	turn: z.number().int().nonnegative(),
	turnStartedAt: z.number().nullable(),
	lastTurnElapsedMs: z.number().nullable(),
	injectSeq: z.number().int().nonnegative(),
	lastInjectionAt: z.number().nullable()
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
		turn: { type: "integer", required: true },
		running: { type: "boolean", required: true },
		elapsedMs: { type: "number", required: true },
		elapsedSeconds: { type: "integer", required: true },
		elapsedText: { type: "string", required: true }
	}
};

/**
 * 已生效的计时计划，按 session id 存。
 *
 * 为什么不塞进投影：`/set-time` 是命令，不改 session 事件；折叠单元只能从事件
 * 折叠出状态，写不进去。计划的生命周期完全由 turn 边界决定（turn/start 激活、
 * turn/end 清空），内存里放一份就够了——进程重启时那一轮也早就没了。
 * @type {Map<string, object>}
 */
const plans = new Map();

/** 取 session 的稳定标识。 */
function sessionKey(session) {
	return session?.id ?? "";
}

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
 */
function readElapsed(ctx, session) {
	const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
	return describeElapsed(state, Date.now());
}

/**
 * 注册折叠单元。与插件生命周期绑定：卸载时 Cordis 自动回收注册。
 */
function registerProjection(ctx) {
	ctx.sessionProjections.register({
		key: PROJECTION_KEY,
		stateVersion: STATE_VERSION,
		stateSchema: clockStateSchema,
		init: () => createInitialState(),
		apply: (state, event) => applyEvent(state, event),
		// 客户端（toast）需要 turnStartedAt 才能本地跳秒、需要 injectSeq 才能
		// 「每注入一条就弹一次卡」，所以必须有 wire 块，否则该单元是 host-only，
		// 浏览器端 useProjection("clock") 永远读到 undefined。
		wire: {
			viewSchema: clockViewSchema,
			view: (state) => ({
				turn: state.turn,
				turnStartedAt: state.turnStartedAt,
				lastTurnElapsedMs: state.lastTurnElapsedMs,
				injectSeq: state.injectSeq,
				lastInjectionAt: state.lastInjectionAt
			})
		}
	});
}

/** 注册 `clock_elapsed` 工具。 */
function registerTools(ctx) {
	ctx.tools.register(
		defineTool({
			name: "clock_elapsed",
			description: ELAPSED_DESCRIPTION,
			parameters: {},
			output: { schema: ELAPSED_OUTPUT_SCHEMA, render: renderValue },
			async execute(_args, exec) {
				const agent = exec.agent;
				if (agent === undefined) {
					return { turn: 0, running: false, elapsedMs: 0, elapsedSeconds: 0, elapsedText: "0s" };
				}
				return readElapsed(ctx, agent.session);
			},
			presentCall
		})
	);
}

/**
 * 造一条本插件的隐藏提醒消息。
 *
 * `source.kind` 必须是 `"dsh-clock"`（不是 `"user"`）：客户端的 messageDefinition
 * 把 `source.kind !== "user"` 的 user/message 归为 `kind: "context"`，而 Chat 的
 * 可见性判定会排除普通 context 节点——于是这条提醒**模型读得到、界面上看不到**，
 * 正是规范要的「隐藏提示，不干扰普通用户可见消息」。
 * @param {string} text - 渲染后的提示词
 * @param {string} summary - 折叠摘要（120 字以内，超出截断）
 * @returns {object} 冻结好的 message
 */
function noticeMessage(text, summary) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: {
			kind: NOTICE_SOURCE_KIND,
			form: "notice",
			summary: boundContextSummary(summary)
		}
	});
}

/**
 * 按档位渲染一条提醒文案。
 * @param {object} plan - 生效中的计划
 * @param {"start" | "before" | "firstOverdue" | "afterOverdue"} phase - 档位
 * @param {number} now - 当前时刻
 * @returns {{text: string, summary: string}}
 */
function renderNotice(plan, phase, now) {
	const templates = loadConfig().templates;
	const template = templates?.[phase] ?? DEFAULT_TEMPLATES[phase];
	const text = renderTemplate(template, {
		t1: plan.t1,
		t2: plan.t2,
		t3: plan.t3,
		t4: templateT4(phase, plan.deadline, now)
	});
	const summary =
		phase === "start"
			? `计时生效：预期 ${formatDuration(plan.t2 * 1000)}`
			: phase === "before"
				? `还剩 ${templateT4(phase, plan.deadline, now)}`
				: `已超时 ${templateT4(phase, plan.deadline, now)}`;
	return { text, summary };
}

/**
 * 注册 `agent/pre-step` 监听器：每步之前看一次排程，到期就注入一条提醒。
 *
 * 为什么选这条通道（而不是系统提示词）：4 种提示词都是**离散事件**，
 * `agent/pre-step` 是唯一「这一刻真的发生了一次注入」的地方，客户端据
 * user/message 的到达即可弹 toast，也是官方 dsh-time-context 走的路。
 *
 * 代价：每条提醒落一条 user/message。因为配置只对一轮生效、且 t1/t3 有下限，
 * 一轮最多十几条，可以接受。
 */
function registerScheduler(ctx) {
	ctx.on(
		"agent/pre-step",
		async ({ agent, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject" || signal?.aborted) return decision;

			const key = sessionKey(agent?.session);
			const plan = plans.get(key);
			if (plan === undefined) return decision;

			const now = Date.now();
			const step = stepPlan(plan, now);
			if (step === null) return decision;

			// 先落计划再注入：注入本身会经 steer/append 触发新的事件折叠，
			// 顺序反了会让同一条提醒被算两次。
			plans.set(key, step.plan);
			const notice = renderNotice(plan, step.phase, now);
			return {
				...decision,
				messages: [...decision.messages, noticeMessage(notice.text, notice.summary)]
			};
		},
		{ prepend: true }
	);
}

/**
 * 跟踪 turn 边界：下一轮开始时激活待生效配置，本轮结束时清空计划。
 *
 * 规范 §1.3 与 §2.6 要求「只对一轮生效，轮结束必须清理」，所以 turn/end
 * 一到就把计划删掉，绝不沿用到下一轮。
 */
function registerTurnTracker(ctx) {
	ctx.on("session/event", (session, event) => {
		const key = sessionKey(session);
		if (event?.type === "turn/start") {
			const plan = plans.get(key);
			if (plan !== undefined && plan.pending === true) {
				plans.set(key, armPlan(plan, event.data?.turn ?? 0, event.time));
			}
			return;
		}
		// 轮结束即清理：规范要求「只对一轮生效」。但 pending 的计划是给**下一轮**
		// 准备的（用户在没有进行中的对话时下的指令），它必须活过这次 turn/end，
		// 否则「先设好、再开始对话」这条最基本的用法就废了。
		if (event?.type === "turn/end") {
			const plan = plans.get(key);
			if (plan !== undefined && plan.pending !== true) plans.delete(key);
		}
	});
}

/**
 * 注册 `/clock` 与 `/set-time` 两条斜杠命令。
 *
 * `input` 声明是可带参数的**唯一**开关：客户端 `dsh-client-ui-commands` 的
 * `matchEnter` 里，`desc.input === undefined` 时对 `/clock 30` 这种带空格的写法
 * 直接 `return void 0`（即「不归我管」），于是在浏览器端被当成普通聊天消息发给模型。
 * 声明了 `input.hint` 之后才会走 `leadingClaim`，把 `30` 作为 rawInput 交给 handler。
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
					? saveConfig({ ...current, intervalSeconds: null })
					: saveConfig({ ...current, intervalSeconds: parsed.intervalSeconds });
			return { kind: "success", text: describeConfig(next) };
		}
	});

	ctx.commands.register({
		name: "set-time",
		description:
			"设定本轮收尾计时：/set-time <t1> <t2> <t3>，" +
			"可写 30、30s、2m、1h20m30s。t1=到点前每多久提醒，t2=预期可工作时间，t3=超时后每多久提醒。",
		input: { hint: "三个时长，例如 30s 5m 1m 或 10s 1h20m30s 2m（无参数=查询当前设置）" },
		handler: (invocation) => {
			const parsed = parseSetTime(invocation.rawInput);
			const key = sessionKey(invocation.agent?.session ?? {});
			if (parsed.action === "error") return { kind: "error", text: parsed.message };
			if (parsed.action === "query") {
				return { kind: "success", text: describePlan(plans.get(key), Date.now()) };
			}

			const params = { t1: parsed.t1, t2: parsed.t2, t3: parsed.t3 };
			const now = Date.now();
			const state = invocation.agent
				? ctx.sessionProjections.stateOf(invocation.agent.session, PROJECTION_KEY)
				: undefined;
			const running = state?.turnStartedAt != null;

			if (!running) {
				// 没有进行中的对话：保存给下一轮用，轮开始时才真正计时。
				plans.set(key, createPlan(params, { mode: "next", now, turn: 0 }));
				const warn =
					parsed.t1 >= parsed.t2 ? "（t1 >= t2，未超时的周期提醒已跳过）" : "";
				const warn3 = parsed.t3 <= 0 ? "（t3 <= 0，超时后的周期提醒已关闭）" : "";
				return {
					kind: "success",
					text: `已设定：t1=${parsed.t1}s、t2=${parsed.t2}s、t3=${parsed.t3}s${warn}${warn3}。将在下一轮对话开始时生效。`
				};
			}

			// 有进行中的对话：从「指令发出时刻」起算，并立刻注入开始提示词。
			const plan = createPlan(params, { mode: "current", now, turn: state?.turn ?? 0 });
			const armed = stepPlan(plan, now);
			const nextPlan = armed === null ? plan : armed.plan;
			plans.set(key, nextPlan);

			const notice = renderNotice(nextPlan, "start", now);
			try {
				// steer = 放进 next-step 收件箱并唤醒驱动器。当前轮正在进行，
				// 因此模型在下一个 step 就一定会读到，这就是能拿到的最「立即」。
				invocation.agent?.steer?.(noticeMessage(notice.text, notice.summary));
			} catch (error) {
				console.error("[dsh-clock] 立即注入开始提示词失败:", error);
			}
			return {
				kind: "success",
				text: `已生效：t1=${parsed.t1}s、t2=${parsed.t2}s、t3=${parsed.t3}s。本轮剩余可用时间 ${parsed.t2} 秒。`
			};
		}
	});
}

/** 读请求体（小 JSON），失败返回空串。 */
function readBody(req) {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", () => resolve(""));
	});
}

/**
 * 注册给浏览器端的 HTTP 端点：读/写配置（含 4 个提示词模板与 toast 开关）。
 *
 * 客户端插件拿不到宿主内存，只有同源 fetch 这一条路。
 *
 * 为什么用 `ctx.inject(["webServer"], …)` 而不是 `ctx.get("webServer")`：
 * cordis 的 `get()` 默认 `strict = true`，只在「提供该服务的 fiber 已经 active」
 * 时才返回实现。`dsh-host-webserver` 的 `[Service.init]` 是 async（要等 socket
 * bind 完成），所以在它启动期间加载的插件读到的都是 `undefined`。用 `ctx.inject`
 * 会等依赖就绪后再回调，且不拖慢插件本体。
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
						const method = req.method ?? "GET";
						try {
							if (method === "GET" || method === "POST") {
								return send(200, { ok: true, ...loadConfig(), defaults: DEFAULT_TEMPLATES, templateKeys: TEMPLATE_KEYS });
							}
							if (method === "PUT") {
								const body = JSON.parse((await readBody(req)) || "{}");
								const next = patchConfig(body ?? {});
								return send(200, { ok: true, ...next });
							}
							return send(405, { ok: false, error: "method not allowed" });
						} catch (error) {
							return send(500, { ok: false, error: String(error?.message ?? error) });
						}
					}
				}),
			"dsh-clock: config api"
		);
	});
}

/**
 * 插件入口。任何同步抛出的异常都会让插件整体加载失败，所以这里只做注册，不做 I/O。
 */
export function apply(ctx) {
	registerProjection(ctx);
	registerTools(ctx);
	registerCommands(ctx);
	registerScheduler(ctx);
	registerTurnTracker(ctx);
	registerApi(ctx);
}
