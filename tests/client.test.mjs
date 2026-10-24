// dsh-clock 客户端半边（lib/client.js）的单元测试。
//
// client.js 的第一行就是 `window.__ModuleLoader__.load(...)`，没有 ESM 导出，
// 所以这里用一个最小的宿主替身：先抓下 factory，再给它一个假的 `react`
// 去求值。这样 `exports.__test` 里的纯函数就能像普通模块一样被测。
//
// 只测纯函数（formatDuration / stepToast / isToastVisible），不碰 DOM。
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** 极简 react 替身：只需要让 factory 求值时不炸。 */
const reactStub = {
	createElement: () => null,
	useState: (init) => [typeof init === "function" ? init() : init, () => {}],
	useRef: (init) => ({ current: init }),
	useEffect: () => {},
	useMemo: (fn) => fn()
};

/**
 * 在沙箱里求值 lib/client.js，取回它注册的导出。
 * @returns {Promise<object>} client 模块的 exports
 */
async function loadClient() {
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	let captured = null;
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load: (registration) => {
					captured = registration;
				}
			}
		},
		document: { getElementById: () => null, createElement: () => ({ set textContent(v) {}, set id(v) {} }), head: { appendChild() {} } },
		fetch: async () => ({ json: async () => ({ ok: false }) }),
		setInterval: () => 0,
		clearInterval: () => {},
		Date,
		Math,
		Object,
		String,
		Symbol
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: fileURLToPath(new URL("../lib/client.js", import.meta.url)) });
	assert.notEqual(captured, null, "client.js 必须调用 __ModuleLoader__.load");
	assert.equal(captured.id, "dsh-clock");
	const exports = captured.factory((id) => {
		assert.equal(id, "react");
		return reactStub;
	});
	return exports;
}

const client = await loadClient();
const { formatDuration, stepToast, isToastVisible, HOLD_MS } = client.__test;

test("客户端拿到的注入声明只有 slots", () => {
	assert.deepEqual([...client.inject], ["slots"]);
});

test("formatDuration 与宿主口径一致（分秒两位补零）", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(999), "0s");
	assert.equal(formatDuration(1000), "1s");
	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(60_000), "1m 00s");
	assert.equal(formatDuration(61_500), "1m 01s");
	assert.equal(formatDuration(3_600_000), "1h 00m 00s");
	assert.equal(formatDuration(3_723_000), "1h 02m 03s");
});

test("formatDuration 对负数与非法值不产生怪字符串", () => {
	assert.equal(formatDuration(-5_000), "0s");
});

test("客户端 formatDuration 与 src/clock.js 的实现逐点一致（避免两份口径漂移）", async () => {
	const { formatDuration: hostFormat } = await import("../src/clock.js");
	for (const ms of [0, 999, 1000, 59_999, 60_000, 61_500, 3_599_000, 3_600_000, 3_723_000, 86_400_000]) {
		assert.equal(formatDuration(ms), hostFormat(ms), `不一致于 ${ms}ms`);
	}
});

test("没有进行中的轮次时永不弹卡", () => {
	const out = stepToast(
		{ lastShownAt: null, visibleUntil: null },
		{ turnStartedAt: null, intervalSeconds: 30, now: 10_000_000 }
	);
	assert.equal(out.due, false);
});

test("t 为 null（/clock off）时永不弹卡", () => {
	const out = stepToast(
		{ lastShownAt: null, visibleUntil: null },
		{ turnStartedAt: 1_000, intervalSeconds: null, now: 10_000_000 }
	);
	assert.equal(out.due, false);
});

test("本轮开始后满 t 秒弹第一张卡，并记下弹出时刻", () => {
	const start = 1_000_000;
	const early = stepToast(
		{ lastShownAt: null, visibleUntil: null },
		{ turnStartedAt: start, intervalSeconds: 30, now: start + 29_500 }
	);
	assert.equal(early.due, false);

	const due = stepToast(
		{ lastShownAt: null, visibleUntil: null },
		{ turnStartedAt: start, intervalSeconds: 30, now: start + 30_000 }
	);
	assert.equal(due.due, true);
	assert.equal(due.state.lastShownAt, start + 30_000);
	assert.equal(due.state.visibleUntil, start + 30_000 + HOLD_MS);
});

test("之后每隔 t 秒再弹一次（间隔从上次弹出算）", () => {
	const start = 1_000_000;
	let state = { lastShownAt: start + 30_000, visibleUntil: start + 35_000 };

	const stillWaiting = stepToast(state, { turnStartedAt: start, intervalSeconds: 30, now: start + 59_000 });
	assert.equal(stillWaiting.due, false);

	const again = stepToast(state, { turnStartedAt: start, intervalSeconds: 30, now: start + 60_000 });
	assert.equal(again.due, true);
	assert.equal(again.state.lastShownAt, start + 60_000);
});

test("换到新一轮时旧基线作废，从新一轮起点重新计时", () => {
	const firstTurn = 1_000_000;
	const secondTurn = 5_000_000;
	const state = { lastShownAt: firstTurn + 30_000, visibleUntil: firstTurn + 35_000 };

	// 第二轮刚开 5 秒：不该因为是「上一轮弹过」就立刻再弹。
	const out = stepToast(state, { turnStartedAt: secondTurn, intervalSeconds: 30, now: secondTurn + 5_000 });
	assert.equal(out.due, false);
	assert.equal(out.state.lastShownAt, null);
});

test("卡片只在自己的 5 秒窗口内可见", () => {
	const state = { lastShownAt: 1_000, visibleUntil: 6_000 };
	assert.equal(isToastVisible(state, 1_000), true);
	assert.equal(isToastVisible(state, 5_999), true);
	assert.equal(isToastVisible(state, 6_000), false);
	assert.equal(isToastVisible({ lastShownAt: null, visibleUntil: null }, 0), false);
});
