// dsh-time-watchdog 宿主侧（lib/index.js）的集成测试。
//
// 不 import 真宿主，而是搭一个假 ctx：把 tools / sessionProjections / commands /
// events / inject 都做成可观测的桩。这样可以验证：
//   · apply() 不抛异常、注册了该注册的东西；
//   · 折叠单元真的把 turn/start、turn/end 折叠成时钟状态；
//   · /set-time 的三种情况（无对话/对话中/查询）都给出正确回执；
//   · pre-step 排程到点真的产出一条隐藏提醒（source.kind === "dsh-time-watchdog"）。
//
// 注意：这个文件需要 import 真宿主包（@deepseek-ai/dsh-llm / dsh-tools），
// 只有在 profile 的 node_modules 下才解析得到。所以测试里做了能力探测，
// 解析不到就整组 skip，不会把插件目录下的 `npm test` 弄红。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 探测宿主包是否可解析。 */
async function hostAvailable() {
	try {
		await import("@deepseek-ai/dsh-llm");
		await import("@deepseek-ai/dsh-tools");
		return true;
	} catch {
		return false;
	}
}

const AVAILABLE = await hostAvailable();

/**
 * 把 HOME 指到包内的一个临时目录，避免测试碰真实的 ~/.dsh/storages/dsh-time-watchdog.json。
 * 用包内而不是系统 temp：Windows 上 os.tmpdir() 在某些受限环境里 mkdtemp 会 EPERM。
 * 必须在 import lib/store.js 之前设好——它在模块加载时就把路径算死了。
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxHome = join(packageRoot, ".test-home");
mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

test.after(() => {
	rmSync(sandboxHome, { recursive: true, force: true });
});

/**
 * 搭一个假宿主 ctx。
 * @returns {object} 收集注册物的桩
 */
function createCtx() {
	const record = {
		tools: [],
		projections: [],
		commands: [],
		listeners: new Map(),
		api: null,
		effects: []
	};
	const ctx = {
		tools: {
			register(tool) {
				record.tools.push(tool);
				return () => {};
			}
		},
		sessionProjections: {
			register(definition) {
				record.projections.push(definition);
				return () => {};
			},
			stateOf(session, key) {
				const definition = record.projections.find((entry) => entry.key === key);
				if (definition === undefined) return undefined;
				let state = definition.init();
				for (const event of session.events) state = definition.apply(state, event);
				return state;
			}
		},
		commands: {
			register(definition) {
				record.commands.push(definition);
				return () => {};
			}
		},
		on(name, listener) {
			const list = record.listeners.get(name) ?? [];
			list.push(listener);
			record.listeners.set(name, list);
			return () => {};
		},
		inject(_names, factory) {
			// webServer 在测试里缺席：模拟「CLI 组合」下 webCtx.get 返回 undefined。
			factory({ get: () => undefined, effect: (fn) => record.effects.push(fn) });
			return () => {};
		}
	};
	return { ctx, record };
}

/** 造一个只有 id 与 events 的假 session。 */
function createSession(id) {
	return { id, events: [] };
}

/** 把事件推进假 session。 */
function emit(record, session, event) {
	session.events.push(event);
	for (const listener of record.listeners.get("session/event") ?? []) listener(session, event);
}

/** 跑一次 pre-step，返回新增的 messages。 */
async function runPreStep(record, agent, signal = { aborted: false }) {
	const chain = record.listeners.get("agent/pre-step") ?? [];
	const base = { kind: "enter", messages: [] };
	// 按注册顺序组一条 next 链（本插件用 prepend，测试里等价）。
	const run = async (index, payload) => {
		if (index >= chain.length) return base;
		return chain[index](payload, () => run(index + 1, payload));
	};
	return run(0, { agent, messages: [], turn: 1, step: 1, signal });
}

if (!AVAILABLE) {
	test("宿主包不可解析：跳过集成测试", { skip: "需要 @deepseek-ai/dsh-llm 与 dsh-tools" }, () => {});
} else {
	const plugin = await import("../lib/index.js");
	test("apply() 注册了折叠单元 / 工具 / 两条命令 / pre-step", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		assert.equal(record.projections.length, 1, "应注册一个投影");
		assert.equal(record.projections[0].key, "watchdog");
		assert.equal(record.projections[0].stateVersion, 3);
		assert.ok(typeof record.projections[0].wire?.view === "function", "必须有 wire 块，否则客户端读不到");

		assert.equal(record.tools.length, 1);
		assert.equal(record.tools[0].name, "clock_elapsed");

		const names = record.commands.map((c) => c.name).sort();
		assert.deepEqual(names, ["clock", "set-time"]);
		for (const command of record.commands) {
			assert.ok(command.input?.hint?.length > 0, `${command.name} 必须声明 input.hint，否则带参数不被认领`);
		}

		assert.ok((record.listeners.get("agent/pre-step") ?? []).length === 1, "应监听 agent/pre-step");
		assert.ok((record.listeners.get("session/event") ?? []).length === 1, "应监听 session/event");
	});

	test("wire.view 把 state 原样暴露给客户端", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const definition = record.projections[0];
		const state = definition.init();
		const view = definition.wire.view(state);
		assert.deepEqual(Object.keys(view).sort(), Object.keys(state).sort());
	});

	test("折叠：turn/start 记起点，turn/end 结算", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const session = createSession("s-fold");
		emit(record, session, { type: "turn/start", time: 1000, data: { turn: 1 } });
		assert.equal(ctx.sessionProjections.stateOf(session, "watchdog").turnStartedAt, 1000);
		emit(record, session, { type: "turn/end", time: 5000, data: { turn: 1 } });
		const state = ctx.sessionProjections.stateOf(session, "watchdog");
		assert.equal(state.turnStartedAt, null);
		assert.equal(state.lastTurnElapsedMs, 4000);
	});

	test("工具：读到本轮已用时间", async () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const session = createSession("s-tool");
		const now = Date.now();
		emit(record, session, { type: "turn/start", time: now - 3000, data: { turn: 4 } });
		const tool = record.tools[0];
		const value = await tool.execute({}, { agent: { session } });
		assert.equal(value.turn, 4);
		assert.equal(value.running, true);
		assert.ok(value.elapsedMs >= 3000);
		assert.match(value.elapsedText, /^\d+s$/);
	});

	test("/set-time：无参数是查询", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const command = record.commands.find((c) => c.name === "set-time");
		const session = createSession("s-query");
		const result = command.handler({ rawInput: "", agent: { session } });
		assert.equal(result.kind, "success");
		assert.match(result.text, /当前没有生效中的计时/);
	});

	test("/set-time：参数错误给具体字段", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const command = record.commands.find((c) => c.name === "set-time");
		const result = command.handler({ rawInput: "30 abc", agent: { session: createSession("s-err") } });
		assert.equal(result.kind, "error");
		assert.match(result.text, /需要 3 个参数/);
	});

	test("/set-time：没有进行中的对话时挂给下一轮，且不会被 turn/end 清掉", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const command = record.commands.find((c) => c.name === "set-time");
		const session = createSession("s-pending");
		const result = command.handler({ rawInput: "30 300 60", agent: { session } });
		assert.equal(result.kind, "success");
		assert.match(result.text, /下一轮对话开始时生效/);

		// 一个没有任何 turn 的会话先收到 turn/end（异常情况）也不该把计划丢掉
		emit(record, session, { type: "turn/end", time: 2000, data: { turn: 1 } });
		const query = command.handler({ rawInput: "", agent: { session } });
		assert.match(query.text, /等待下一轮/, "pending 计划必须活过 turn/end");
	});

	test("/set-time：有进行中的对话时立即注入开始提示词（source.kind 为 dsh-time-watchdog）", async () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const command = record.commands.find((c) => c.name === "set-time");
		const session = createSession("s-live");
		emit(record, session, { type: "turn/start", time: Date.now() - 1000, data: { turn: 2 } });

		const steered = [];
		const agent = { session, steer: (message) => steered.push(message) };
		const result = command.handler({ rawInput: "30 300 60", agent });
		assert.equal(result.kind, "success");
		assert.match(result.text, /已生效/);
		assert.equal(steered.length, 1, "应立即 steer 一条开始提示词");
		assert.equal(steered[0].role, "user");
		assert.equal(steered[0].source.kind, "dsh-time-watchdog");
		assert.equal(steered[0].source.form, "notice");
		assert.match(steered[0].content[0].text, /计时已生效/);
		assert.match(steered[0].content[0].text, /5m/, "&t2& 应被替换成紧凑时长 5m（300 秒）");
		assert.doesNotMatch(steered[0].content[0].text, /&t\d+&/);
	});

	test("pre-step：t1 到期后注入一条未超时提醒，且按 t1 限频", async () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const command = record.commands.find((c) => c.name === "set-time");
		const session = createSession("s-sched");
		emit(record, session, { type: "turn/start", time: Date.now() - 5000, data: { turn: 1 } });

		const steered = [];
		const agent = { session, steer: (m) => steered.push(m) };
		// t1 = 1 秒，让「周期提醒」在一秒后就能到期，测试不必等 30 秒。
		command.handler({ rawInput: "1 300 60", agent });
		assert.equal(steered.length, 1, "开始提示词由 /set-time 立即 steer");

		// 紧接着的第一步：周期档还没到期（nextDueAt = 开始 + 1s），不该有额外提醒。
		const immediate = await runPreStep(record, agent);
		assert.equal(immediate.messages.length, 0);

		await new Promise((resolve) => setTimeout(resolve, 1100));
		const decision = await runPreStep(record, agent);
		assert.equal(decision.kind, "enter");
		assert.equal(decision.messages.length, 1, "t1 到期应注入一条提醒");
		assert.equal(decision.messages[0].source.kind, "dsh-time-watchdog");
		assert.match(decision.messages[0].content[0].text, /时间提醒/);

		// 立刻再来一次：未到下一个 t1，不该再提醒。
		const again = await runPreStep(record, agent);
		assert.equal(again.messages.length, 0);
	});

	test("pre-step：turn 结束后不再提醒", async () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const command = record.commands.find((c) => c.name === "set-time");
		const session = createSession("s-ended");
		emit(record, session, { type: "turn/start", time: Date.now() - 31000, data: { turn: 1 } });
		const agent = { session, steer: () => {} };
		command.handler({ rawInput: "30 300 60", agent });
		emit(record, session, { type: "turn/end", time: Date.now(), data: { turn: 1 } });

		const decision = await runPreStep(record, agent);
		assert.equal(decision.messages.length, 0);
	});

	test("pre-step：reject 决策原样透传", async () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const session = createSession("s-reject");
		const agent = { session, steer: () => {} };
		// 手动替换下游：让 pre-step 链返回 reject
		const listeners = record.listeners.get("agent/pre-step");
		record.listeners.set("agent/pre-step", []);
		const out = await listeners[0]({ agent, messages: [], turn: 1, step: 1, signal: { aborted: false } }, () => ({
			kind: "reject"
		}));
		assert.equal(out.kind, "reject");
	});

	test("投影的 stateSchema 与 wire.viewSchema 都接受 init 出来的状态", () => {
		const { ctx, record } = createCtx();
		plugin.apply(ctx);
		const definition = record.projections[0];
		const state = definition.init();
		assert.doesNotThrow(() => definition.stateSchema.parse(state));
		assert.doesNotThrow(() => definition.wire.viewSchema.parse(definition.wire.view(state)));
	});
}
