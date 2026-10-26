// dsh-clock —— client half：
//   1. 聊天气泡上方的两张卡片：
//      · 「本轮对话已运行」周期卡片（/clock 控制）
//      · 「提示词已发送」卡片（宿主每注入一条提醒弹一次，5 秒消失）
//   2. 设置页的一个标签页：编辑 4 种提示词模板 + Toast 开关。
//
// 协议事实（均已对着 app.asar 里的源码核过）：
//  - `window.__ModuleLoader__.load({ id, factory })`；factory(require) 返回 exports。
//  - `slots.inject(ownerKey, () => slots.register(options, Component))`，第二个参数是组件。
//  - `conversation.input.overlay`：kind=list、scope=session，标准 props 含
//    `sessionId` / `useProjection`；渲染位置是 composer 卡片顶部的零高锚点
//    （`data-composer-overlay`，`height:0;position:absolute;inset:0 0 auto`），
//    所以浮层子元素用 `bottom:100%` 就能浮在输入框上方。
//  - `settings.section`：kind=list、scope=root，注册项需要 `id` / `order` / `label`。
//  - 客户端拿不到宿主内存，配置只有同源 fetch 一条路。
//  - 不 require 任何 Harness Client 包（官方 practices.md 明令禁止），
//    样式只用主题变量，控件自己写。
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

		/** 配置轮询周期：命令改完，卡片最迟这么久就跟上。 */
		const CONFIG_POLL_MS = 3000;

		/** 提示词模板的字段名与展示顺序（与宿主 src/timing.js 的 TEMPLATE_KEYS 对齐）。 */
		const TEMPLATE_KEYS = ["start", "before", "firstOverdue", "afterOverdue"];

		/** 设置页里的分档标题。 */
		const TEMPLATE_LABELS = {
			start: "① 计时开始生效时",
			before: "② 未超时周期提醒（每 t1）",
			firstOverdue: "③ 首次超时（只发一次）",
			afterOverdue: "④ 超时后周期提醒（每 t3）"
		};

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
		 * 推进一格排程，决定这一拍要不要弹「已运行多久」卡片。
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

		/**
		 * 判断「提示词已发送」卡片这一拍要不要弹。
		 *
		 * 触发条件是投影里的 `injectSeq` 变大了（宿主每注入一条隐藏提醒 +1）。
		 * 首帧只记录基线不弹卡，否则页面一刷新就会误报一次。
		 *
		 * @param {{lastSeq: number | null, visibleUntil: number | null}} state - 上一格
		 * @param {{injectSeq: number | null | undefined, enabled: boolean, now: number}} input
		 * @returns {{state: {lastSeq: number | null, visibleUntil: number | null}, due: boolean}}
		 */
		function stepInjectionToast(state, input) {
			const { injectSeq, enabled, now } = input;
			const visibleUntil = state.visibleUntil;
			const seq = typeof injectSeq === "number" ? injectSeq : null;

			if (seq === null) return { state: { lastSeq: null, visibleUntil }, due: false };
			if (state.lastSeq === null) return { state: { lastSeq: seq, visibleUntil }, due: false };
			if (seq <= state.lastSeq) return { state: { lastSeq: seq, visibleUntil }, due: false };
			// 一次心跳里跨了多条注入也只弹一次（规范允许「避免堆叠」）。
			if (!enabled) return { state: { lastSeq: seq, visibleUntil }, due: false };
			return { state: { lastSeq: seq, visibleUntil: now + HOLD_MS }, due: true };
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
				flexDirection: "column",
				alignItems: "center",
				gap: "8px",
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
			dotSent: {
				flex: "none",
				width: "8px",
				height: "8px",
				borderRadius: "50%",
				background: "var(--dsw-alias-state-success-primary, #2ecc71)",
				boxShadow: "0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ecc71) 22%, transparent)"
			},
			title: { fontWeight: 600, whiteSpace: "nowrap" },
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

		// ── 组件：浮层卡片 ──────────────────────────────────────────────

		/**
		 * 一个 session 的提醒卡片（两种卡片共用一个浮层锚点）。
		 * @param {object} props - 槽位标准 props（这里只用 useProjection）
		 * @returns {object | null} 有卡片时返回节点，否则 null
		 */
		function ClockToast({ useProjection }) {
			// 槽位会给每个条目塞入标准 props；万一 useProjection 缺席（宿主降级），
			// 直接退化成「不显示」，而不是把整个 composer 一起炸掉。
			const projection = typeof useProjection === "function" ? useProjection("clock") : null;
			const [config, setConfig] = react.useState({ intervalSeconds: null, toastOnPrompt: true });
			const [now, setNow] = react.useState(() => Date.now());

			// 配置：先拉一次，之后低频轮询（命令/设置页改完要让页面跟上）。
			react.useEffect(() => {
				let alive = true;
				const pull = () => {
					fetch(API, { credentials: "same-origin" })
						.then((r) => r.json())
						.then((body) => {
							if (!alive || !body || body.ok !== true) return;
							setConfig({
								intervalSeconds: typeof body.intervalSeconds === "number" ? body.intervalSeconds : null,
								toastOnPrompt: body.toastOnPrompt !== false
							});
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
			const injectionRef = react.useRef({ lastSeq: null, visibleUntil: null });
			const [toast, setToast] = react.useState(null);
			const [sentToast, setSentToast] = react.useState(false);

			// 本地 tick：本轮在跑时跳秒（与宿主 Web 时钟同一口径）；
			// 卡片还挂着的时候也继续跳，否则 turn/end 一停表，
			// 最后一格 tick 就再也不会到，卡片会永远留在屏幕上。
			const running = projection != null && projection.turnStartedAt != null;
			const ticking = running || toast !== null || sentToast;
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
					intervalSeconds: config.intervalSeconds,
					now: tick
				});
				scheduleRef.current = stepped.state;
				if (stepped.due) {
					setToast({
						elapsedText: formatDuration(Math.max(0, tick - (projection.turnStartedAt ?? tick))),
						turn: projection.turn ?? 0
					});
					return;
				}
				// 到期：撤掉卡片。
				if (!isToastVisible(stepped.state, tick) && stepped.state.visibleUntil !== null) {
					scheduleRef.current = { lastShownAt: stepped.state.lastShownAt, visibleUntil: null };
					setToast(null);
				}
			}, [now, projection, config.intervalSeconds]);

			// 「提示词已发送」卡片：靠 injectSeq 的变化触发，与计时卡片互不干扰。
			react.useEffect(() => {
				const tick = Date.now();
				const stepped = stepInjectionToast(injectionRef.current, {
					injectSeq: projection?.injectSeq,
					enabled: config.toastOnPrompt !== false,
					now: tick
				});
				injectionRef.current = stepped.state;
				if (stepped.due) {
					setSentToast(true);
					return;
				}
				if (!isToastVisible(stepped.state, tick) && stepped.state.visibleUntil !== null) {
					injectionRef.current = { lastSeq: stepped.state.lastSeq, visibleUntil: null };
					setSentToast(false);
				}
			}, [now, projection, config.toastOnPrompt]);

			if (toast === null && !sentToast) return null;
			ensureKeyframes();
			return react.createElement(
				"div",
				{ style: styles.wrap, "aria-live": "polite" },
				sentToast
					? react.createElement(
							"div",
							{ key: "sent", style: styles.card, role: "status" },
							react.createElement("span", { style: styles.dotSent, "aria-hidden": "true" }),
							react.createElement("span", { style: styles.title }, "提示词已发送")
						)
					: null,
				toast !== null
					? react.createElement(
							"div",
							{ key: "elapsed", style: styles.card, role: "status" },
							react.createElement("span", { style: styles.dot, "aria-hidden": "true" }),
							react.createElement("span", { style: styles.title }, "本轮对话已运行"),
							react.createElement("span", { style: styles.elapsed }, toast.elapsedText),
							toast.turn > 0
								? react.createElement("span", { style: styles.turn }, `第 ${toast.turn} 轮`)
								: null
						)
					: null
			);
		}

		// ── 组件：设置页标签页 ──────────────────────────────────────────

		const sectionStyles = {
			page: {
				fontFamily: "ui-monospace, monospace",
				fontSize: "12px",
				padding: "14px 16px",
				maxWidth: "860px",
				lineHeight: "1.6"
			},
			row: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" },
			h3: { margin: "0", flex: "1" },
			button: {
				border: "1px solid var(--dsw-alias-border-l2, #444)",
				background: "transparent",
				borderRadius: "6px",
				cursor: "pointer",
				color: "inherit",
				padding: "3px 10px",
				fontSize: "12px"
			},
			primary: {
				border: "none",
				color: "#111",
				borderRadius: "6px",
				cursor: "pointer",
				padding: "4px 14px",
				fontWeight: "bold",
				fontSize: "12px"
			},
			label: { display: "block", marginTop: "10px", fontWeight: 600 },
			hint: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: "11px", margin: "2px 0 4px" },
			textarea: {
				width: "100%",
				minHeight: "62px",
				padding: "6px 8px",
				fontFamily: "ui-monospace, monospace",
				fontSize: "12px",
				lineHeight: "1.5",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2, #444)",
				background: "transparent",
				color: "inherit",
				resize: "vertical",
				boxSizing: "border-box"
			},
			notice: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: "11px" }
		};

		/** 带说明的模板编辑器。 */
		function TemplateField(props) {
			return react.createElement("div", null, [
				react.createElement("label", { key: "l", style: sectionStyles.label }, TEMPLATE_LABELS[props.name] ?? props.name),
				react.createElement(
					"div",
					{ key: "h", style: sectionStyles.hint },
					`占位符：&t1& &t2& &t3& 为本次参数，&t4& 为当前剩余/已超时时间；均渲染为紧凑时长（如 1h20m30s）。`
				),
				react.createElement("textarea", {
					key: "t",
					style: sectionStyles.textarea,
					value: props.value,
					onChange: (event) => props.onChange(event.target.value)
				})
			]);
		}

		/**
		 * 设置页标签页：编辑 4 种提示词模板、保存、恢复默认值、Toast 开关。
		 * @returns {object} 页面节点
		 */
		function ClockSettings() {
			const [state, setState] = react.useState({
				loading: true,
				error: null,
				templates: {},
				defaults: {},
				toastOnPrompt: true,
				dirty: false,
				saving: false,
				message: null
			});

			const reload = react.useCallback(() => {
				fetch(API, { credentials: "same-origin" })
					.then((r) => r.json())
					.then((body) => {
						if (!body || body.ok !== true) {
							setState((s) => ({ ...s, loading: false, error: JSON.stringify(body) }));
							return;
						}
						setState({
							loading: false,
							error: null,
							templates: body.templates ?? {},
							defaults: body.defaults ?? {},
							toastOnPrompt: body.toastOnPrompt !== false,
							dirty: false,
							saving: false,
							message: null
						});
					})
					.catch((error) => setState((s) => ({ ...s, loading: false, error: String(error) })));
			}, []);

			react.useEffect(() => {
				reload();
			}, [reload]);

			const edit = (key, value) => {
				setState((s) => ({ ...s, templates: { ...s.templates, [key]: value }, dirty: true, message: null }));
			};

			const save = () => {
				setState((s) => ({ ...s, saving: true, message: null }));
				fetch(API, {
					method: "PUT",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ templates: state.templates, toastOnPrompt: state.toastOnPrompt })
				})
					.then((r) => r.json())
					.then((body) => {
						if (!body || body.ok !== true) {
							setState((s) => ({ ...s, saving: false, message: { ok: false, text: `保存失败：${JSON.stringify(body)}` } }));
							return;
						}
						setState((s) => ({
							...s,
							saving: false,
							dirty: false,
							templates: body.templates ?? s.templates,
							message: { ok: true, text: "已保存，下一条提醒即按新模板渲染。" }
						}));
					})
					.catch((error) => setState((s) => ({ ...s, saving: false, message: { ok: false, text: String(error) } })));
			};

			const restoreDefaults = () => {
				setState((s) => ({ ...s, templates: { ...s.defaults }, dirty: true, message: null }));
			};

			if (state.loading) return react.createElement("div", { style: sectionStyles.page }, "加载中…");

			return react.createElement("div", { style: sectionStyles.page }, [
				react.createElement("div", { key: "head", style: sectionStyles.row }, [
					react.createElement("h3", { key: "h", style: sectionStyles.h3 }, "计时与收尾提醒"),
					react.createElement("button", { key: "reset", style: sectionStyles.button, onClick: restoreDefaults }, "恢复默认模板"),
					react.createElement("button", { key: "reload", style: sectionStyles.button, onClick: reload }, "重载"),
					react.createElement(
						"button",
						{
							key: "save",
							onClick: save,
							disabled: state.saving || !state.dirty,
							style: {
								...sectionStyles.primary,
								background: state.dirty ? "#2ecc71" : "var(--dsw-alias-border-l2, #444)",
								color: state.dirty ? "#111" : "inherit",
								cursor: state.dirty ? "pointer" : "default"
							}
						},
						state.saving ? "保存中…" : "保存"
					)
				]),
				react.createElement(
					"p",
					{ key: "intro", style: sectionStyles.notice },
					"指令：/set-time <t1> <t2> <t3>，可写 30、30s、2m、1h20m30s（顺序必须是 h→m→s）。" +
						"t1 = 到 t2 之前每隔多久提醒一次；t2 = 预期可工作时间；t3 = 超过 t2 后每隔多久提醒一次。" +
						"该配置只对一轮对话生效：没有进行中的对话时绑定到下一轮，正在进行时从指令发出时刻起算；" +
						"该轮结束即清理，不会沿用到后续轮次，要再次生效必须重新执行 /set-time。" +
						"t1 >= t2 时跳过未超时的周期提醒；t3 <= 0 时关闭超时后的周期提醒。"
				),
				react.createElement(
					"p",
					{ key: "ph", style: sectionStyles.notice },
					"占位符：&t1& &t2& &t3& 会被替换为本次配置的参数，&t4& 在未超时时替换为剩余时间、超时后替换为已超时时间；四个占位符都渲染成紧凑时长（30s / 1m30s / 1h20m30s），所以模板里不要再写「&t2& 秒」。保存前不校验，注入前统一替换，渲染后不会残留占位符。"
				),
				state.error !== null ? react.createElement("p", { key: "err", style: { color: "#e74c3c" } }, `加载失败：${state.error}`) : null,
				state.message !== null
					? react.createElement(
							"p",
							{ key: "msg", style: { color: state.message.ok ? "#2ecc71" : "#e74c3c" } },
							state.message.text
						)
					: null,
				react.createElement(
					"label",
					{ key: "toast", style: { ...sectionStyles.row, marginTop: "8px" } },
					[
						react.createElement("input", {
							key: "c",
							type: "checkbox",
							checked: state.toastOnPrompt,
							onChange: (event) => setState((s) => ({ ...s, toastOnPrompt: event.target.checked, dirty: true }))
						}),
						react.createElement(
							"span",
							{ key: "t" },
							"发送提示词时显示 Toast（关闭后不弹卡片，注入与计时逻辑不受影响）"
						)
					]
				),
				react.createElement(
					"div",
					{ key: "fields" },
					TEMPLATE_KEYS.map((key) =>
						react.createElement(TemplateField, {
							key,
							name: key,
							value: state.templates[key] ?? "",
							onChange: (value) => edit(key, value)
						})
					)
				)
			]);
		}

		// ── 插件入口 ────────────────────────────────────────────────────

		/**
		 * 插件入口：注册一个浮层条目 + 一个设置页标签页。
		 * @param {object} ctx - 客户端插件上下文
		 */
		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.overlay", () =>
						ctx.slots.register(
							{ name: "conversation.input.overlay", id: "dsh-clock-toast", order: 900 },
							ClockToast
						)
					),
				"dsh-clock: elapsed toast"
			);
			ctx.effect(
				() =>
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{
								name: "settings.section",
								id: "dsh-clock",
								order: 92,
								label: () => "计时与收尾提醒"
							},
							ClockSettings
						)
					),
				"dsh-clock: settings page"
			);
		}

		exports.apply = apply;
		exports.inject = inject;

		// 测试钩子：纯函数，不碰 DOM/React。
		exports.__test = {
			formatDuration,
			stepToast,
			isToastVisible,
			stepInjectionToast,
			HOLD_MS,
			TICK_MS,
			CONFIG_POLL_MS,
			TEMPLATE_KEYS
		};

		return module.exports;
	}
});
