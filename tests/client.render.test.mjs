// dsh-clock 客户端提醒卡片（ClockToast）的渲染级测试。
//
// client.js 没有 ESM 导出、第一行就是 `window.__ModuleLoader__.load(...)`，
// 所以这里在 vm 沙箱里求值它，并用一个「迷你 React」把组件真的渲染成 HTML 字符串：
// 这个替身实现了 createElement / useState / useRef / useEffect（含 deps 比较与 cleanup），
// 足以验证排程：什么时候弹、弹的是什么文本、5 秒后撤、轮结束后也能撤干净。
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

/**
 * 把 element 树渲染成 HTML 字符串（只为断言文本与结构）。
 * @param {object | null} element - createElement 的产物
 * @returns {string}
 */
function toHtml(element) {
	if (element === null || element === undefined) return "";
	if (typeof element === "string" || typeof element === "number") return String(element);
	const props = element.props ?? {};
	const attrs = Object.entries(props)
		.filter(([key, value]) => key !== "children" && typeof value !== "function" && typeof value !== "object")
		.map(([key, value]) => ` ${key}="${String(value)}"`)
		.join("");
	const children = [props.children ?? []].flat(4).map(toHtml).join("");
	return `<${element.type}${attrs}>${children}</${element.type}>`;
}

/**
 * 建一个迷你 React + 迷你宿主的沙箱，求值 lib/client.js。
 * @returns {Promise<object>} 测试用的控制器
 */
async function createHarness() {
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

	let captured = null;
	let fetched = { ok: true, intervalSeconds: null };
	const timers = [];
	let dirty = true;
	let hookIndex = 0;
	let hooks = [];
	let pendingEffects = [];
	let mounted = null;

	/** 假时钟：测试自己推进。 */
	const clock = { now: 1_700_000_000_000 };

	const react = {
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), children: children.length > 1 ? children : (children[0] ?? []) }
		}),
		useState(init) {
			const index = hookIndex++;
			if (!(index in hooks)) hooks[index] = { value: typeof init === "function" ? init() : init };
			const slot = hooks[index];
			return [
				slot.value,
				(next) => {
					const value = typeof next === "function" ? next(slot.value) : next;
					if (!Object.is(value, slot.value)) {
						slot.value = value;
						dirty = true;
					}
				}
			];
		},
		useRef(init) {
			const index = hookIndex++;
			if (!(index in hooks)) hooks[index] = { value: { current: init } };
			return hooks[index].value;
		},
		useEffect(effect, deps) {
			const index = hookIndex++;
			if (!(index in hooks)) hooks[index] = { deps: undefined, cleanup: undefined };
			pendingEffects.push({ index, effect, deps });
		}
	};

	const sandbox = {
		window: { __ModuleLoader__: { load: (registration) => { captured = registration; } } },
		document: {
			getElementById: () => null,
			createElement: () => ({ set id(v) {}, set textContent(v) {} }),
			head: { appendChild() {} },
			addEventListener() {},
			removeEventListener() {},
			visibilityState: "visible"
		},
		fetch: async () => ({ json: async () => fetched }),
		setInterval: (fn) => {
			const timer = { fn };
			timers.push(timer);
			return timer;
		},
		clearInterval: (timer) => {
			const at = timers.indexOf(timer);
			if (at >= 0) timers.splice(at, 1);
		},
		setTimeout,
		clearTimeout,
		Date: class extends Date {
			static now() {
				return clock.now;
			}
		},
		console
	};

	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "lib/client.js" });
	assert.ok(captured !== null, "client.js 应该调用 __ModuleLoader__.load");
	const exports = captured.factory((name) => {
		if (name === "react") return react;
		throw new Error(`unexpected require: ${name}`);
	});

	/**
	 * 跑一轮渲染 + effect flush，直到稳定。
	 * @param {number} rounds - 最大轮数，防止死循环
	 */
	function flush(rounds = 20) {
		for (let i = 0; i < rounds; i++) {
			if (!dirty) break;
			dirty = false;
			hookIndex = 0;
			pendingEffects = [];
			mounted = exports.__component({ useProjection: () => projection.current });
			// 比较 deps，决定哪些 effect 要重跑
			for (const { index, effect, deps } of pendingEffects) {
				const slot = hooks[index];
				const previous = slot?.deps;
				const changed =
					slot === undefined ||
					previous === undefined ||
					deps === undefined ||
					deps.some((value, at) => !Object.is(value, previous[at]));
				if (!changed) continue;
				if (typeof slot.cleanup === "function") slot.cleanup();
				slot.deps = deps;
				slot.cleanup = effect();
			}
		}
	}

	/** 让所有假 interval 各走一拍。 */
	function tick() {
		for (const timer of [...timers]) timer.fn();
		flush();
	}

	/**
	 * 模拟「宿主投影推送导致组件重渲染」。
	 * 真实 React 里 useProjection 变了会自动重渲染，迷你替身没有订阅，
	 * 所以测试要显式叫一声。
	 */
	function rerender() {
		dirty = true;
		flush();
	}

	const projection = { current: null };

	return {
		exports,
		clock,
		flush,
		tick,
		rerender,
		projection,
		setFetched: (next) => {
			fetched = next;
		},
		html: () => toHtml(mounted),
		/** 等一个微任务轮次，让 fetch 的 promise 落地。 */
		settle: () => new Promise((resolve) => setTimeout(resolve, 0))
	};
}

// ── client.js 需要一个可挂载的组件名；这里从 __test 之外拿到它 ─────────────
// （client.js 只在 apply 时把 ClockToast 交给 slots.register，所以测试里
//  先把 slots.register 的第二个参数抓出来，再直接渲染它。）

/**
 * 包一层：先跑 apply() 抓到被注册的组件，再交给渲染器。
 * @param {object} harness - createHarness 的返回值
 * @returns {object} 同一个 harness，但 exports.__component 已就位
 */
function installComponent(harness) {
	const registered = [];
	const ctx = {
		effect: (factory) => {
			factory();
		},
		slots: {
			inject: (_name, factory) => factory(),
			register: (options, component) => {
				registered.push({ options, component });
				return () => {};
			}
		}
	};
	harness.exports.apply(ctx);
	assert.equal(registered.length, 2, "应该注册两个槽位条目：浮层卡片 + 设置页");
	const overlay = registered.find((entry) => entry.options.name === "conversation.input.overlay");
	const settings = registered.find((entry) => entry.options.name === "settings.section");
	assert.ok(overlay !== undefined, "缺少 conversation.input.overlay 条目");
	assert.ok(settings !== undefined, "缺少 settings.section 条目");
	assert.equal(settings.options.id, "dsh-clock");
	harness.exports.__component = overlay.component;
	harness.exports.__settingsComponent = settings.component;
	return harness;
}

test("提醒卡片：到点弹出、显示已运行时长、5 秒后消失", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: 30 });
	harness.projection.current = { turn: 3, turnStartedAt: harness.clock.now - 31_000, lastTurnElapsedMs: null };

	harness.flush();
	await harness.settle();
	harness.flush();

	const html = harness.html();
	assert.match(html, /本轮对话已运行/);
	assert.match(html, /31s/);
	assert.match(html, /第 3 轮/);

	// 5 秒不到：还在
	harness.clock.now += 4_000;
	harness.tick();
	assert.match(harness.html(), /本轮对话已运行/);

	// 过了 5 秒：撤
	harness.clock.now += 2_000;
	harness.tick();
	assert.equal(harness.html(), "");
});

test("提醒卡片：间隔未到不弹", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: 30 });
	harness.projection.current = { turn: 1, turnStartedAt: harness.clock.now - 10_000, lastTurnElapsedMs: null };

	harness.flush();
	await harness.settle();
	harness.flush();

	assert.equal(harness.html(), "");
});

test("提醒卡片：t 为 null（/clock off）时完全不弹", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null });
	harness.projection.current = { turn: 1, turnStartedAt: harness.clock.now - 999_000, lastTurnElapsedMs: null };

	harness.flush();
	await harness.settle();
	harness.flush();

	assert.equal(harness.html(), "");
});

test("提醒卡片：轮结束时卡片仍会按时撤掉（停表不能卡住最后一格）", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: 30 });
	harness.projection.current = { turn: 2, turnStartedAt: harness.clock.now - 31_000, lastTurnElapsedMs: null };
	harness.flush();
	await harness.settle();
	harness.flush();
	assert.match(harness.html(), /本轮对话已运行/);

	// 卡片还挂着，轮结束了：turnStartedAt 归 null
	harness.projection.current = { turn: 2, turnStartedAt: null, lastTurnElapsedMs: 31_000 };
	harness.clock.now += 6_000;
	harness.tick();

	assert.equal(harness.html(), "");
});

test("提醒卡片：换到新一轮后从新起点重新算间隔", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: 30 });
	harness.projection.current = { turn: 1, turnStartedAt: harness.clock.now - 31_000, lastTurnElapsedMs: null };
	harness.flush();
	await harness.settle();
	harness.flush();
	assert.match(harness.html(), /31s/);

	// 5 秒后撤掉
	harness.clock.now += 5_500;
	harness.tick();
	assert.equal(harness.html(), "");

	// 新一轮开始，只过了 2 秒 → 不该弹（旧基线必须作废，否则会立刻弹）
	harness.projection.current = { turn: 2, turnStartedAt: harness.clock.now - 2_000, lastTurnElapsedMs: 31_000 };
	harness.tick();
	assert.equal(harness.html(), "");

	// 过 30 秒 → 弹，且显示的是新一轮的时间
	harness.clock.now += 29_000;
	harness.tick();
	assert.match(harness.html(), /第 2 轮/);
});

// ── 「提示词已发送」卡片 ────────────────────────────────────────────

test("已发送卡片：injectSeq 变大就弹，5 秒后消失", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: true });
	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 0 };
	harness.flush();
	await harness.settle();
	harness.flush();
	assert.equal(harness.html(), "", "首帧只对基线，不该弹");

	// 宿主注入了一条提醒
	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 1 };
	harness.clock.now += 500;
	harness.rerender();
	assert.match(harness.html(), /提示词已发送/);

	// 4 秒后还在
	harness.clock.now += 4_000;
	harness.tick();
	assert.match(harness.html(), /提示词已发送/);

	// 再过 2 秒：撤
	harness.clock.now += 2_000;
	harness.tick();
	assert.equal(harness.html(), "");
});

test("已发送卡片：设置页关掉开关后不弹", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: false });
	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 0 };
	harness.flush();
	await harness.settle();
	harness.flush();

	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 1 };
	harness.clock.now += 500;
	harness.rerender();
	assert.equal(harness.html(), "");
});

test("已发送卡片：详细开关关闭时只显示简写，不带正文", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: true, toastDetail: false });
	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 0 };
	harness.flush();
	await harness.settle();
	harness.flush();

	harness.projection.current = {
		turn: 1,
		turnStartedAt: null,
		lastTurnElapsedMs: 0,
		injectSeq: 1,
		lastNoticeText: "收尾提示词第八版"
	};
	harness.clock.now += 500;
	harness.rerender();
	assert.match(harness.html(), /提示词已发送/);
	assert.doesNotMatch(harness.html(), /收尾提示词第八版/);
});

test("已发送卡片：详细开关打开后显示本条提示词正文", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: true, toastDetail: true });
	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 0 };
	harness.flush();
	await harness.settle();
	harness.flush();

	harness.projection.current = {
		turn: 1,
		turnStartedAt: null,
		lastTurnElapsedMs: 0,
		injectSeq: 1,
		lastNoticeText: "收尾提示词第八版"
	};
	harness.clock.now += 500;
	harness.rerender();
	assert.match(harness.html(), /提示词已发送/);
	assert.match(harness.html(), /收尾提示词第八版/);
});

test("已发送卡片：切换详细开关不需要重弹，下一次注入即生效", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: true, toastDetail: false });
	harness.projection.current = { turn: 1, turnStartedAt: null, lastTurnElapsedMs: 0, injectSeq: 0 };
	harness.flush();
	await harness.settle();
	harness.flush();

	harness.projection.current = {
		turn: 1,
		turnStartedAt: null,
		lastTurnElapsedMs: 0,
		injectSeq: 1,
		lastNoticeText: "第一条"
	};
	harness.clock.now += 500;
	harness.rerender();
	assert.doesNotMatch(harness.html(), /第一条/);

	// 5 秒后撤卡
	harness.clock.now += 5_000;
	harness.tick();
	assert.equal(harness.html(), "");

	// 用户这时才在设置页打开详细开关（靠轮询同步，不用刷新）
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: true, toastDetail: true });
	await harness.settle();
	harness.flush();

	harness.projection.current = {
		turn: 1,
		turnStartedAt: null,
		lastTurnElapsedMs: 0,
		injectSeq: 2,
		lastNoticeText: "第二条"
	};
	harness.clock.now += 500;
	harness.rerender();
	assert.match(harness.html(), /第二条/);
});

test("已发送卡片：页面刷新后 injectSeq 已有值也不补弹", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: null, toastOnPrompt: true });
	// 一进来就有 5 条历史注入
	harness.projection.current = { turn: 3, turnStartedAt: null, lastTurnElapsedMs: 1000, injectSeq: 5 };
	harness.flush();
	await harness.settle();
	harness.flush();
	assert.equal(harness.html(), "");
});

test("两张卡片可以同时挂着", async () => {
	const harness = installComponent(await createHarness());
	harness.setFetched({ ok: true, intervalSeconds: 30, toastOnPrompt: true });
	harness.projection.current = {
		turn: 2,
		turnStartedAt: harness.clock.now - 31_000,
		lastTurnElapsedMs: null,
		injectSeq: 0
	};
	harness.flush();
	await harness.settle();
	harness.flush();
	assert.match(harness.html(), /本轮对话已运行/);

	// 同一时刻注入一条
	harness.projection.current = {
		turn: 2,
		turnStartedAt: harness.clock.now - 31_000,
		lastTurnElapsedMs: null,
		injectSeq: 1
	};
	harness.rerender();
	const html = harness.html();
	assert.match(html, /本轮对话已运行/);
	assert.match(html, /提示词已发送/);
});

test("设置页：注册项带 id / label / order", async () => {
	const registered = [];
	const ctx = {
		effect: (factory) => factory(),
		slots: {
			inject: (_name, factory) => factory(),
			register: (options, component) => {
				registered.push({ options, component });
				return () => {};
			}
		}
	};
	(await createHarness()).exports.apply(ctx);
	const settings = registered.find((entry) => entry.options.name === "settings.section");
	assert.ok(settings !== undefined);
	assert.equal(settings.options.id, "dsh-clock");
	assert.equal(settings.options.label(), "计时与收尾提醒");
	assert.ok(Number.isFinite(settings.options.order));
});
