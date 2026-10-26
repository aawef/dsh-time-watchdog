// dsh-clock 的配置归一化测试：/set-time 参数、toast 开关、模板缺项。
import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_TOAST_DETAIL,
	DEFAULT_TOAST_ON_PROMPT,
	MAX_INTERVAL_SECONDS,
	MIN_INTERVAL_SECONDS,
	describeConfig,
	parseClockInput,
	readConfig
} from "../src/config.js";

test("parseClockInput：空参数是查询", () => {
	assert.deepEqual(parseClockInput(""), { action: "query" });
	assert.deepEqual(parseClockInput("   "), { action: "query" });
});

test("parseClockInput：off / 关闭 / 0 都能清掉", () => {
	assert.equal(parseClockInput("off").action, "disabled");
	assert.equal(parseClockInput("关闭").action, "disabled");
	assert.equal(parseClockInput("0").action, "disabled");
});

test("parseClockInput：秒与分钟后缀", () => {
	assert.deepEqual(parseClockInput("30"), { action: "set", intervalSeconds: 30 });
	assert.deepEqual(parseClockInput("30s"), { action: "set", intervalSeconds: 30 });
	assert.deepEqual(parseClockInput("2m"), { action: "set", intervalSeconds: 120 });
});

test("parseClockInput：超出范围报错并夹住", () => {
	const tooSmall = parseClockInput("0.4");
	assert.equal(tooSmall.action, "disabled", "四舍五入到 0 就是关闭");
	const tooBig = parseClockInput("99999");
	assert.equal(tooBig.action, "error");
	assert.match(tooBig.message, new RegExp(String(MAX_INTERVAL_SECONDS)));
});

test("parseClockInput：无法识别时给出原值", () => {
	const bad = parseClockInput("abc");
	assert.equal(bad.action, "error");
	assert.match(bad.message, /abc/);
});

test("readConfig：缺字段时全部落默认值", () => {
	const config = readConfig(undefined);
	assert.equal(config.intervalSeconds, null);
	assert.equal(config.toastOnPrompt, DEFAULT_TOAST_ON_PROMPT);
	assert.equal(config.toastDetail, DEFAULT_TOAST_DETAIL);
	assert.equal(DEFAULT_TOAST_ON_PROMPT, true);
	assert.equal(DEFAULT_TOAST_DETAIL, false);
});

test("readConfig：toastDetail 只认真正的布尔值", () => {
	assert.equal(readConfig({ toastDetail: true }).toastDetail, true);
	assert.equal(readConfig({ toastDetail: false }).toastDetail, false);
	// 字符串 / 数字一律当没给，落回默认（默认是关）。
	assert.equal(readConfig({ toastDetail: "true" }).toastDetail, DEFAULT_TOAST_DETAIL);
	assert.equal(readConfig({ toastDetail: 1 }).toastDetail, DEFAULT_TOAST_DETAIL);
	assert.equal(readConfig({ toastDetail: null }).toastDetail, DEFAULT_TOAST_DETAIL);
});

test("readConfig：两个 toast 开关互相独立", () => {
	assert.deepEqual(
		[readConfig({ toastOnPrompt: false, toastDetail: true }).toastOnPrompt,
		 readConfig({ toastOnPrompt: false, toastDetail: true }).toastDetail],
		[false, true]
	);
});

test("readConfig：intervalSeconds 允许 null 与非正数被拒", () => {
	assert.equal(readConfig({ intervalSeconds: null }).intervalSeconds, null);
	assert.equal(readConfig({ intervalSeconds: 45 }).intervalSeconds, 45);
	assert.equal(readConfig({ intervalSeconds: -1 }).intervalSeconds, null);
	assert.equal(readConfig({ intervalSeconds: "45" }).intervalSeconds, null);
});

test("describeConfig：没设置时的说法", () => {
	assert.match(describeConfig({ intervalSeconds: null }), /已关闭/);
	assert.match(describeConfig({ intervalSeconds: 90 }), /每 90 秒/);
});
