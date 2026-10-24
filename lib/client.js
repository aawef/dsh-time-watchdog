// dsh-clock —— client half：聊天气泡上方的「已运行多久」提醒卡片（toast）。
//
// 协议事实（均已对着 app.asar 里的源码核过）：
//  - `window.__ModuleLoader__.load({ id, factory })`；factory(require) 返回 exports。
//  - `slots.inject(ownerKey, () => slots.register(options, Component))`，第二个参数是组件。
//  - `conversation.input.overlay`：kind=list、scope=session，标准 props 含
//    `sessionId` / `useProjection`；渲染位置是 composer 卡片顶部的零高锚点
//    （`data-composer-overlay`，`height:0;position:absolute;inset:0 0 auto`），
//    所以浮层子元素用 `bottom:100%` 就能浮在输入框上方。
//  - 客户端拿不到宿主内存，配置只有同源 fetch 一条路：GET /dsh-clock/api/config。
//  - 不 require 任何 Harness Client 包（官方 practices.md 明令禁止），
//    样式只用 `--dsw-alias-*` 主题变量，控件自己写。
//  - client.js 是 no-cache 的：改完刷新页面即可，不必重启桌面进程。

window.__ModuleLoader__.load({
	id: "dsh-clock",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/** 需要的贡献位。 */
		const inject = ["slots"];

		/** 宿主 HTTP 端点（lib/index.js 里注册）。 */
		const API = "/dsh-clock/api/config";

		/** 卡片停留时长，与需求一致：5 秒。 */
		const HOLD_MS = 5000;

		/** 本地 tick 周期。1 秒够用，取 500ms 让出现时刻更准。 */
		const TICK_MS = 500;

		/** 配置轮询周期：`/clock 30` 改完，卡片最迟这么久就跟上。 */
		const CONFIG_POLL_MS = 3000;

		// ── 纯函数（不依赖 React，便于单测） ─────────────────────────────

		/**
		 * 把毫秒格式化成与宿主 `formatDuration` 一致的紧凑文本。
		 * @param {number} elapsedMs - 毫秒
		 * @returns {string}
		 */
		function formatDuration(elapsedMs) {
			let seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
			const hours = Math.floor(seconds / 3600);
			seconds %= 3600;
			const minutes = Math.floor(seconds / 60);
			seconds %= 60;
			const pad = (value) => String(value).padStart(2, "0");
			if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
			if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
			return `${seconds}s`;
		}

		/**
		 * 推进一格排程，决定这一拍要不要弹卡片。
		 *
		 * 规则：本轮进行中才计时；第一次弹在本轮开始后 t 秒；之后每 t 秒再弹一次
		 * （间隔从「上次弹」算，不累计漂移）；卡片停留 5 秒后自行消失。
		 *
		 * @param {{lastShownAt: number | null, visibleUntil: number | null}} state - 上一格
		 * @param {{turnStartedAt: number | null, intervalSeconds: number | null, now: number}} input
		 * @returns {{state: {lastShownAt: number | null, visibleUntil: number | null}, due: boolean}}
		 */
		function stepToast(state, input) {
			const { turnStartedAt, intervalSeconds, now } = input;
			const visibleUntil = state.visibleUntil;

			if (turnStartedAt === null || intervalSeconds === null) {
				return { state: { lastShownAt: null, visibleUntil }, due: false };
			}

			let lastShownAt = state.lastShownAt;
			// 换了新一轮：上一轮的弹卡基线作废，否则会拿旧时刻继续算间隔。
			if (lastShownAt !== null && lastShownAt < turnStartedAt) lastShownAt = null;

			const intervalMs = intervalSeconds * 1000;
			const baseline = lastShownAt === null ? turnStartedAt : lastShownAt;
			if (now - baseline < intervalMs) {
				return { state: { lastShownAt, visibleUntil }, due: false };
			}
			return { state: { lastShownAt: now, visibleUntil: now + HOLD_MS }, due: true };
		}

		/**
		 * 当前是否有卡片应显示。
		 * @param {{visibleUntil: number | null}} state - 排程状态
		 * @param {number} now - 当前时刻
		 * @returns {boolean}
		 */
		function isToastVisible(state, now) {
			return state.visibleUntil !== null && now < state.visibleUntil;
		}

		// ── 样式（只用主题变量） ────────────────────────────────────────

		const styles = {
			// 锚点高 0、宽满：子元素绝对定位时以它为参照系。
			wrap: {
				position: "absolute",
				left: 0,
				right: 0,
				bottom: "100%",
				display: "flex",
				justifyContent: "center",
				paddingBottom: "10px",
				pointerEvents: "none"
			},
			card: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				maxWidth: "min(420px, calc(100% - 24px))",
				padding: "10px 14px",
				borderRadius: "var(--dsw-radius-panel, 12px)",
				background: "var(--dsw-alias-bg-layer-2, #23252b)",
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))",
				boxShadow: "var(--dsw-elevation-soft, 0 8px 24px rgba(0,0,0,.35))",
				color: "var(--dsw-alias-label-primary, inherit)",
				fontSize: "13px",
				lineHeight: "20px",
				animation: "dsh-clock-rise .18s ease-out"
			},
			dot: {
				flex: "none",
				width: "8px",
				height: "8px",
				borderRadius: "50%",
				background: "var(--dsw-alias-state-business-primary, #4a9eff)",
				boxShadow: "0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a9eff) 22%, transparent)"
			},
			title: {
				fontWeight: 600,
				whiteSpace: "nowrap"
			},
			elapsed: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				color: "var(--dsw-alias-label-secondary, rgba(255,255,255,.72))",
				whiteSpace: "nowrap"
			},
			turn: {
				color: "var(--dsw-alias-label-tertiary, rgba(255,255,255,.5))",
				fontSize: "12px",
				whiteSpace: "nowrap"
			}
		};

		/** 关键帧只注入一次（插进 <head>，不碰宿主 DOM 的其它部分）。 */
		function ensureKeyframes() {
			const id = "dsh-clock-keyframes";
			if (document.getElementById(id) !== null) return;
			const style = document.createElement("style");
			style.id = id;
			style.textContent =
				"@keyframes dsh-clock-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}";
			document.head.appendChild(style);
		}

		// ── 组件 ────────────────────────────────────────────────────────

		/**
		 * 一个 session 的提醒卡片。
		 * @param {object} props - 槽位标准 props（这里只用 useProjection）
		 * @returns {object | null} 有卡片时返回节点，否则 null
		 */
		function ClockToast({ useProjection }) {
			// 槽位会给每个条目塞入标准 props；万一 useProjection 缺席（宿主降级），
			// 直接退化成「不显示」，而不是把整个 composer 一起炸掉。
			const projection =
				typeof useProjection === "function" ? useProjection("clock") : null;
			const [intervalSeconds, setIntervalSeconds] = react.useState(null);
			const [now, setNow] = react.useState(() => Date.now());

			// 配置：先拉一次，之后低频轮询（`/clock` 改完要让页面跟上）。
			react.useEffect(() => {
				let alive = true;
				const pull = () => {
					fetch(API, { credentials: "same-origin" })
						.then((r) => r.json())
						.then((body) => {
							if (!alive || !body || body.ok !== true) return;
							setIntervalSeconds(typeof body.intervalSeconds === "number" ? body.intervalSeconds : null);
						})
						.catch(() => {
							/* 宿端没起或端点缺席：静默按「关闭」处理 */
						});
				};
				pull();
				const timer = setInterval(pull, CONFIG_POLL_MS);
				const onVisible = () => {
					if (document.visibilityState === "visible") pull();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					alive = false;
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, []);

			// 排程状态放在 ref 里：tick 每次读最新值，避免闭包拿到旧数。
			const scheduleRef = react.useRef({ lastShownAt: null, visibleUntil: null });
			const [toast, setToast] = react.useState(null);

			// 本地 tick：本轮在跑时跳秒（与宿主 Web 时钟同一口径）；
			// 卡片还挂着的时候也继续跳，否则 turn/end 一停表，
			// 最后一格 tick 就再也不会到，卡片会永远留在屏幕上。
			const running = projection != null && projection.turnStartedAt != null;
			const ticking = running || toast !== null;
			react.useEffect(() => {
				if (!ticking) return undefined;
				const timer = setInterval(() => setNow(Date.now()), TICK_MS);
				return () => clearInterval(timer);
			}, [ticking]);

			react.useEffect(() => {
				if (projection == null) {
					scheduleRef.current = { lastShownAt: null, visibleUntil: null };
					setToast(null);
					return;
				}
				const tick = Date.now();
				const stepped = stepToast(scheduleRef.current, {
					turnStartedAt: projection.turnStartedAt ?? null,
					intervalSeconds,
					now: tick
				});
				scheduleRef.current = stepped.state;
				if (stepped.due) {
					setToast({
						elapsedText: formatDuration(
							Math.max(0, tick - (projection.turnStartedAt ?? tick))
						),
						turn: projection.turn ?? 0
					});
					return;
				}
				// 到期：撤掉卡片。
				if (!isToastVisible(stepped.state, tick) && stepped.state.visibleUntil !== null) {
					scheduleRef.current = { lastShownAt: stepped.state.lastShownAt, visibleUntil: null };
					setToast(null);
				}
			}, [now, projection, intervalSeconds]);

			if (toast === null) return null;
			ensureKeyframes();
			return react.createElement(
				"div",
				{ style: styles.wrap, "aria-live": "polite" },
				react.createElement(
					"div",
					{ style: styles.card, role: "status" },
					react.createElement("span", { style: styles.dot, "aria-hidden": "true" }),
					react.createElement("span", { style: styles.title }, "本轮对话已运行"),
					react.createElement("span", { style: styles.elapsed }, toast.elapsedText),
					toast.turn > 0
						? react.createElement("span", { style: styles.turn }, `第 ${toast.turn} 轮`)
						: null
				)
			);
		}

		/**
		 * 插件入口：只注册一个槽位条目。
		 * @param {object} ctx - 客户端插件上下文
		 */
		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.overlay", () =>
						ctx.slots.register(
							{
								name: "conversation.input.overlay",
								id: "dsh-clock-toast",
								order: 900
							},
							ClockToast
						)
					),
				"dsh-clock: elapsed toast"
			);
		}

		exports.apply = apply;
		exports.inject = inject;

		// 测试钩子：纯函数，不碰 DOM/React。
		exports.__test = { formatDuration, stepToast, isToastVisible, HOLD_MS, TICK_MS, CONFIG_POLL_MS };

		return module.exports;
	}
});
