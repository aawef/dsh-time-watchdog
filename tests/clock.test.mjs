// dsh-clock 纯逻辑单元测试。只依赖 src/clock.js，不 import 宿主包，
// 因此在插件目录内直接 `node --test` 就能跑。
import assert from "node:assert/strict";
import test from "node:test";

import {
	applyEvent,
	createInitialState,
	describeElapsed,
	formatDuration,
	renderElapsed
} from "../src/clock.js";

test("初始状态：没有轮次、没有起点", () => {
	assert.deepEqual(createInitialState(), {
		turn: 0,
		turnStartedAt: null,
		lastTurnElapsedMs: null,
		injectSeq: 0,
		lastInjectionAt: null
	});
});

test("turn/start 记录起点与轮次", () => {
	const state = applyEvent(createInitialState(), {
		type: "turn/start",
		time: 1000,
		data: { turn: 1 }
	});
	assert.deepEqual(state, {
		turn: 1,
		turnStartedAt: 1000,
		lastTurnElapsedMs: null,
		injectSeq: 0,
		lastInjectionAt: null
	});
});

test("无关事件返回原引用，宿主据此跳过重算", () => {
	const state = applyEvent(createInitialState(), {
		type: "turn/start",
		time: 1000,
		data: { turn: 1 }
	});
	for (const type of ["assistant/message", "tool/result", "step/start"]) {
		assert.equal(applyEvent(state, { type, time: 4000, data: {} }), state);
	}
	// 真用户的发言（source.kind === "user"）不算注入，同样保持原引用。
	assert.equal(
		applyEvent(state, { type: "user/message", time: 4000, data: { source: { kind: "user" } } }),
		state
	);
});

test("本插件注入的提醒累加 injectSeq 并记时刻", () => {
	const state = applyEvent(createInitialState(), { type: "turn/start", time: 1000, data: { turn: 1 } });
	const once = applyEvent(state, {
		type: "user/message",
		time: 2000,
		data: { source: { kind: "dsh-clock", form: "notice" } }
	});
	assert.equal(once.injectSeq, 1);
	assert.equal(once.lastInjectionAt, 2000);
	const twice = applyEvent(once, {
		type: "user/message",
		time: 3000,
		data: { source: { kind: "dsh-clock", form: "notice" } }
	});
	assert.equal(twice.injectSeq, 2);
	assert.equal(twice.lastInjectionAt, 3000);
});

test("turn/end 结算耗时并清空起点", () => {
	const state = applyEvent(
		applyEvent(createInitialState(), { type: "turn/start", time: 1000, data: { turn: 1 } }),
		{ type: "turn/end", time: 61000, data: { turn: 1 } }
	);
	assert.deepEqual(state, {
		turn: 1,
		turnStartedAt: null,
		lastTurnElapsedMs: 60000,
		injectSeq: 0,
		lastInjectionAt: null
	});
});

test("下一轮开始时清掉上一轮的耗时", () => {
	const ended = applyEvent(
		applyEvent(createInitialState(), { type: "turn/start", time: 1000, data: { turn: 1 } }),
		{ type: "turn/end", time: 2000, data: { turn: 1 } }
	);
	const next = applyEvent(ended, { type: "turn/start", time: 5000, data: { turn: 2 } });
	assert.equal(next.lastTurnElapsedMs, null);
	assert.equal(next.turnStartedAt, 5000);
	assert.equal(next.turn, 2);
});

test("进行中的轮持续计时", () => {
	const state = applyEvent(createInitialState(), {
		type: "turn/start",
		time: 1000,
		data: { turn: 1 }
	});
	assert.deepEqual(describeElapsed(state, 11000), {
		turn: 1,
		running: true,
		elapsedMs: 10000,
		elapsedSeconds: 10,
		elapsedText: "10s"
	});
});

test("轮结束后读数冻结在结束时刻", () => {
	const state = applyEvent(
		applyEvent(createInitialState(), { type: "turn/start", time: 1000, data: { turn: 1 } }),
		{ type: "turn/end", time: 61000, data: { turn: 1 } }
	);
	const early = describeElapsed(state, 70000);
	const late = describeElapsed(state, 999999);
	assert.equal(early.elapsedMs, 60000);
	assert.deepEqual(early, late);
});

test("投影未注册时读数安全归零", () => {
	assert.deepEqual(describeElapsed(undefined, 5000), {
		turn: 0,
		running: false,
		elapsedMs: 0,
		elapsedSeconds: 0,
		elapsedText: "0s"
	});
});

test("时钟回拨不产生负数", () => {
	const state = applyEvent(createInitialState(), {
		type: "turn/start",
		time: 5000,
		data: { turn: 1 }
	});
	assert.equal(describeElapsed(state, 1000).elapsedMs, 0);
	assert.equal(formatDuration(-1), "0s");
});

test("时长格式化向下取整到秒", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(999), "0s");
	assert.equal(formatDuration(59999), "59s");
	assert.equal(formatDuration(60000), "1m 00s");
	assert.equal(formatDuration(3729000), "1h 02m 09s");
	assert.equal(formatDuration(3 * 3600000 + 2 * 60000 + 9000), "3h 02m 09s");
});

test("工具文本区分进行中与已结束", () => {
	const running = { turn: 2, running: true, elapsedMs: 5000, elapsedSeconds: 5, elapsedText: "5s" };
	const ended = { ...running, running: false };
	assert.match(renderElapsed(running), /本轮进行中/);
	assert.match(renderElapsed(ended), /本轮已结束/);
	assert.match(renderElapsed(running), /第 2 轮/);
	assert.match(renderElapsed({ ...running, turn: 0 }), /尚无进行中的轮次/);
});
