// dsh-clock 的定时提醒逻辑测试：参数解析、模板渲染、排程决策。
import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_TEMPLATES,
	TEMPLATE_KEYS,
	armPlan,
	createPlan,
	describePlan,
	normalizeTemplates,
	parseSetTime,
	renderTemplate,
	stepPlan,
	templateT4
} from "../src/timing.js";

test("parseSetTime：空参数是查询", () => {
	assert.deepEqual(parseSetTime(""), { action: "query" });
	assert.deepEqual(parseSetTime("   "), { action: "query" });
	assert.deepEqual(parseSetTime(undefined), { action: "query" });
});

test("parseSetTime：三个秒数", () => {
	assert.deepEqual(parseSetTime("30 300 60"), { action: "set", t1: 30, t2: 300, t3: 60 });
	// 单位后缀
	assert.deepEqual(parseSetTime("30s 5m 1m"), { action: "set", t1: 30, t2: 300, t3: 60 });
	// 小数会被四舍五入到整秒
	assert.deepEqual(parseSetTime("1.4 2.6 3"), { action: "set", t1: 1, t2: 3, t3: 3 });
});

test("parseSetTime：参数个数不对是错误", () => {
	const two = parseSetTime("30 300");
	assert.equal(two.action, "error");
	assert.match(two.message, /需要 3 个参数，收到 2 个/);
	assert.equal(parseSetTime("1 2 3 4").action, "error");
});

test("parseSetTime：无法识别的值给出具体字段名", () => {
	const bad = parseSetTime("30 abc 60");
	assert.equal(bad.action, "error");
	assert.match(bad.message, /t2 无法识别 "abc"/);
	assert.equal(parseSetTime("-5 300 60").action, "error");
	assert.equal(parseSetTime("30 300 60x").action, "error");
});

test("parseSetTime：t1/t2 的范围校验，t3 允许非正数", () => {
	assert.equal(parseSetTime("0 300 60").action, "error");
	assert.match(parseSetTime("0 300 60").message, /t1 要在 1–86400 秒之间/);
	assert.equal(parseSetTime("30 999999 60").action, "error");
	assert.match(parseSetTime("30 999999 60").message, /t2 要在/);
	assert.equal(parseSetTime("30 300 999999").action, "error");
	// t3 = 0 表示关掉超时后的周期提醒，合法
	assert.deepEqual(parseSetTime("30 300 0"), { action: "set", t1: 30, t2: 300, t3: 0 });
});

test("renderTemplate：四个占位符都替换", () => {
	const text = renderTemplate("a=&t1& b=&t2& c=&t3& d=&t4&", { t1: 1, t2: 2, t3: 3, t4: "9s" });
	assert.equal(text, "a=1 b=2 c=3 d=9s");
});

test("renderTemplate：不认识的占位符被清空、不残留 &tN&", () => {
	const text = renderTemplate("x&t9&y &t1& end", { t1: 5, t2: 0, t3: 0, t4: "" });
	assert.doesNotMatch(text, /&t\d+&/);
	assert.equal(text, "xy 5 end");
});

test("renderTemplate：空模板返回空串", () => {
	assert.equal(renderTemplate("", { t1: 1, t2: 2, t3: 3 }), "");
	assert.equal(renderTemplate(null, { t1: 1, t2: 2, t3: 3 }), "");
});

test("templateT4：开始档没有时长，before 是剩余，超时后是已超时", () => {
	assert.equal(templateT4("start", 10000, 5000), "");
	assert.equal(templateT4("before", 10000, 5000), "5s");
	assert.equal(templateT4("firstOverdue", 10000, 15000), "5s");
	assert.equal(templateT4("afterOverdue", 10000, 9000), "0s");
});

test("createPlan：current 模式立刻生效，next 模式挂起", () => {
	const current = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "current", now: 1000, turn: 7 });
	assert.equal(current.pending, false);
	assert.equal(current.turn, 7);
	assert.equal(current.deadline, 1000 + 300000);
	assert.equal(current.startSent, false);
	assert.equal(current.nextDueAt, null);

	const next = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "next", now: 1000, turn: 0 });
	assert.equal(next.pending, true);
	assert.equal(next.deadline, 0);
});

test("armPlan：下一轮开始时改成待生效并从那一刻起算", () => {
	const pending = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "next", now: 1000, turn: 0 });
	const armed = armPlan(pending, 3, 50000);
	assert.equal(armed.pending, false);
	assert.equal(armed.turn, 3);
	assert.equal(armed.deadline, 50000 + 300000);
	assert.equal(armed.armedAt, 50000);
});

test("stepPlan：没计划 / 计划挂起时不提醒", () => {
	assert.equal(stepPlan(undefined, 1000), null);
	assert.equal(stepPlan(null, 1000), null);
	const pending = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "next", now: 0, turn: 0 });
	assert.equal(stepPlan(pending, 1000), null);
});

test("stepPlan：第一条永远是开始提示", () => {
	const plan = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "current", now: 0, turn: 1 });
	const first = stepPlan(plan, 10);
	assert.equal(first.phase, "start");
	assert.equal(first.plan.startSent, true);
	// t1 < t2，未超时周期档已排期
	assert.equal(first.plan.nextDueAt, 10 + 30000);
});

test("stepPlan：t1 >= t2 时跳过未超时周期档", () => {
	const plan = { ...createPlan({ t1: 300, t2: 300, t3: 60 }, { mode: "current", now: 0, turn: 1 }) };
	const started = stepPlan(plan, 0);
	assert.equal(started.phase, "start");
	assert.equal(started.plan.nextDueAt, null);
	// 未超时但周期档未启用：一直不提醒
	assert.equal(stepPlan(started.plan, 100000), null);
});

test("stepPlan：未超时按 t1 节流", () => {
	let plan = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "current", now: 0, turn: 1 });
	plan = stepPlan(plan, 0).plan; // start，nextDueAt = 30000
	assert.equal(stepPlan(plan, 29999), null);
	const due = stepPlan(plan, 30000);
	assert.equal(due.phase, "before");
	assert.equal(due.plan.nextDueAt, 60000);
	// 再次限频
	assert.equal(stepPlan(due.plan, 59999), null);
});

test("stepPlan：首次超时只发一次，随后按 t3 节流", () => {
	let plan = { ...createPlan({ t1: 30, t2: 100, t3: 20 }, { mode: "current", now: 0, turn: 1 }) };
	plan = stepPlan(plan, 0).plan; // start
	// 直接跨过 deadline
	const over = stepPlan(plan, 150000);
	assert.equal(over.phase, "firstOverdue");
	assert.equal(over.plan.firstOverSent, true);
	assert.equal(over.plan.nextDueAt, 150000 + 20000);
	// 已经发过首次超时，不会重复
	assert.equal(stepPlan(over.plan, 160000), null);
	const again = stepPlan(over.plan, 170000);
	assert.equal(again.phase, "afterOverdue");
	assert.equal(again.plan.nextDueAt, 190000);
});

test("stepPlan：t3 <= 0 时首次超时照发，但不重复", () => {
	let plan = createPlan({ t1: 30, t2: 100, t3: 0 }, { mode: "current", now: 0, turn: 1 });
	plan = stepPlan(plan, 0).plan;
	const over = stepPlan(plan, 150000);
	assert.equal(over.phase, "firstOverdue");
	assert.equal(over.plan.nextDueAt, null);
	assert.equal(stepPlan(over.plan, 999999), null);
});

test("describePlan：没配置时给用法", () => {
	assert.match(describePlan(undefined, 0), /当前没有生效中的计时/);
	assert.match(describePlan(undefined, 0), /\/set-time/);
});

test("describePlan：挂起 / 剩余 / 已超时三种说法", () => {
	const pending = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "next", now: 0, turn: 0 });
	assert.match(describePlan(pending, 0), /等待下一轮/);

	const active = createPlan({ t1: 30, t2: 300, t3: 60 }, { mode: "current", now: 0, turn: 2 });
	assert.match(describePlan(active, 60000), /第 2 轮还剩 4m 00s/);

	const zero3 = createPlan({ t1: 30, t2: 100, t3: 0 }, { mode: "current", now: 0, turn: 2 });
	assert.match(describePlan(zero3, 150000), /已超过预期时间 50s/);
	assert.match(describePlan(zero3, 150000), /t3=已关闭/);
});

test("normalizeTemplates：缺项补默认值，非字符串也退回默认值", () => {
	const out = normalizeTemplates({ start: "自定义", before: 123 });
	assert.equal(out.start, "自定义");
	assert.equal(out.before, DEFAULT_TEMPLATES.before);
	assert.equal(out.firstOverdue, DEFAULT_TEMPLATES.firstOverdue);
	assert.deepEqual(Object.keys(out), TEMPLATE_KEYS);
	// 完全没数据时四个都是默认值
	assert.deepEqual(normalizeTemplates(undefined), DEFAULT_TEMPLATES);
});

test("默认模板本身渲染后没有残留占位符", () => {
	for (const key of TEMPLATE_KEYS) {
		const text = renderTemplate(DEFAULT_TEMPLATES[key], { t1: 30, t2: 300, t3: 60, t4: "1m 00s" });
		assert.doesNotMatch(text, /&t\d+&/, key);
		assert.ok(text.length > 0, key);
	}
});
