// dsh-time-watchdog 的「定时提醒」纯逻辑层。
//
// 这里只放三件事，全部是纯函数，不 import 宿主包、不碰 Date.now()：
//   1. `/set-time <t1> <t2> <t3>` 的参数解析；
//   2. 4 种提示词模板的默认值与占位符替换；
//   3. 一次 pre-step 的排程决策（该不该提醒、提醒哪一档、下一个到期时刻）。
//
// 时间单位内部统一是「秒」，对外一律换算成毫秒。
// 用户输入与提示词输出都支持紧凑时长写法（`1h20m30s`），见 parseDurationToken
// 与 formatCompactDuration——两者必须互逆，否则「设进去的」和「说出来的」会不一致。


/** 参数下限（秒）。0/负数没有意义。 */
export const MIN_SECONDS = 1;

/** 参数上限（秒）：24 小时。防手滑写成 99999999。 */
export const MAX_SECONDS = 86400;

/** 提示词模板在配置文件里的字段名，顺序即设置页里的展示顺序。 */
export const TEMPLATE_KEYS = ["start", "before", "firstOverdue", "afterOverdue"];

/** 设置页里的中文标题，与 TEMPLATE_KEYS 一一对应。 */
export const TEMPLATE_LABELS = {
	start: "① 计时开始生效",
	before: "② 未超时周期提醒（每 t1）",
	firstOverdue: "③ 首次超时（只发一次）",
	afterOverdue: "④ 超时后周期提醒（每 t3）"
};

/**
 * 4 种提示词的默认模板。
 *
 * 占位符：`&t1&` `&t2&` `&t3&` 是本次配置的三个参数，
 * `&t4&` 是动态值——未超时是「还剩多久」，超时后是「已超时多久」。
 *
 * 四个占位符都渲染成**带单位的紧凑时长**（`30s` / `1m30s` / `1h20m30s`），
 * 所以模板里不要再写「&t2& 秒」——那会渲染成「1m30s 秒」。
 *
 * 默认文案刻意不写死 t1/t3 的数值关系：t1>=t2 时第 ② 档会被整段跳过，
 * 模板里若声称「每隔 t1 提醒」就成了假话。
 */
export const DEFAULT_TEMPLATES = {
	start:
		"【计时已生效】本轮对话的预期工作时间为 &t2&（约 &t2& 后到期）。" +
		"请据此安排节奏，时间用尽前我会提醒你收尾。",
	before:
		"【时间提醒】本轮对话还剩 &t4&（预期总时长 &t2&）。" +
		"请收拢目标，优先完成关键步骤，准备给出结论。",
	firstOverdue:
		"【已超时】本轮对话已超出预期时间 &t4&（预期 &t2&）。" +
		"请立即停止新增工作，马上收尾并输出结果。",
	afterOverdue:
		"【持续超时】本轮对话已超出预期时间 &t4&。请立刻结束当前工作，只给出最终结论。"
};

/** 模板里认得的占位符。渲染后若还残留别的 `&tN&` 会被清空。 */
const PLACEHOLDER_PATTERN = /&t([1-9]\d*)&/g;

/** 任何残留的占位符（防止模板里写了 &t9& 这类不存在的字段）。 */
const LEFTOVER_PATTERN = /&t[1-9]\d*&/g;

/**
 * 把用户写的时长解析成秒数。
 *
 * 接受的写法（大小写不敏感，数字可带小数）：
 *   `30`        → 30 秒（裸数字默认按秒）
 *   `30s`       → 30 秒
 *   `2m`        → 120 秒
 *   `1h`        → 3600 秒
 *   `1h20m30s`  → 4830 秒
 *   `1h30s`     → 3630 秒（允许跳级）
 *   `90m`       → 5400 秒（不限制单段上限）
 *
 * 顺序必须是 h → m → s，不允许 `30s20m` 这种倒序，也不允许重复同一单位。
 *
 * @param {string} token - 单个参数
 * @returns {number | null} 秒数（四舍五入到整数）；无法解析时 null
 */
function parseDurationToken(token) {
	const text = String(token ?? "").trim();
	if (text === "") return null;

	// 裸数字：按秒处理。
	if (/^\d+(?:\.\d+)?$/.test(text)) {
		const bare = Number(text);
		return Number.isFinite(bare) ? Math.round(bare) : null;
	}

	// 复合写法：必须从 h 开始、按 h→m→s 顺序，且至少有一段。
	const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(text);
	if (match === null) return null;
	const [, hours, minutes, seconds] = match;
	if (hours === undefined && minutes === undefined && seconds === undefined) return null;

	const total =
		(hours === undefined ? 0 : Number(hours) * 3600) +
		(minutes === undefined ? 0 : Number(minutes) * 60) +
		(seconds === undefined ? 0 : Number(seconds));
	if (!Number.isFinite(total)) return null;
	return Math.round(total);
}

/**
 * 把秒数格式化成紧凑时长，与 `parseDurationToken` 互逆。
 *
 * 规则（照需求「够小时/分钟量级就转，否则别转」）：
 *   45     → `45s`
 *   60     → `1m`
 *   90     → `1m30s`
 *   3600   → `1h`
 *   3630   → `1h30s`
 *   4830   → `1h20m30s`
 *
 * 不足一分钟只给秒；中间为 0 的段直接省略，不写 `1h0m30s`。
 *
 * @param {number} totalSeconds - 秒数
 * @returns {string}
 */
export function formatCompactDuration(totalSeconds) {
	let seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	if (hours > 0) {
		const rest = minutes > 0 ? `${minutes}m${seconds > 0 ? `${seconds}s` : ""}` : seconds > 0 ? `${seconds}s` : "";
		return `${hours}h${rest}`;
	}
	if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

/**
 * 解析 `/set-time` 的原始参数。
 *
 * 用法：`/set-time <t1> <t2> <t3>`，每段可写 `30`、`30s`、`2m`、`1h20m30s`。
 *   t1：到 t2 之前，每隔 t1 提醒一次
 *   t2：预期可工作时间（进行中的对话从「指令发出时刻」起算）
 *   t3：超过 t2 后，每隔 t3 提醒一次；t3 <= 0 表示关掉这一档
 *
 * 空参数 = 查询当前设置。
 *
 * @param {string | undefined | null} rawInput - 斜杠命令后面的原文
 * @returns {{action: "query"}
 *   | {action: "set", t1: number, t2: number, t3: number}
 *   | {action: "error", message: string}}
 */
export function parseSetTime(rawInput) {
	const text = String(rawInput ?? "").trim();
	if (text === "") return { action: "query" };

	const tokens = text.split(/\s+/);
	if (tokens.length !== 3) {
		return {
			action: "error",
			message: `需要 3 个参数，收到 ${tokens.length} 个。用法：/set-time <t1> <t2> <t3>，例如 /set-time 30s 5m 1m，或 /set-time 10s 1h20m30s 2m。`
		};
	}

	const values = tokens.map((token) => parseDurationToken(token));
	const names = ["t1", "t2", "t3"];
	for (let index = 0; index < 3; index += 1) {
		if (values[index] === null) {
			return {
				action: "error",
				message: `${names[index]} 无法识别 "${tokens[index]}"。可写 30、30s、2m、1h20m30s（顺序必须是 h→m→s）。`
			};
		}
	}

	const [t1, t2, t3] = values;
	for (const [name, value] of [["t1", t1], ["t2", t2]]) {
		if (value < MIN_SECONDS || value > MAX_SECONDS) {
			return {
				action: "error",
				message: `${name} 要在 ${MIN_SECONDS}–${MAX_SECONDS} 秒之间，收到 ${formatCompactDuration(value)}（${value} 秒）。`
			};
		}
	}
	// t3 允许非正数：含义是「关掉超时后周期提醒」，不是错误。
	if (t3 > MAX_SECONDS) {
		return {
			action: "error",
			message: `t3 不能超过 ${MAX_SECONDS} 秒，收到 ${formatCompactDuration(t3)}（${t3} 秒）。`
		};
	}

	return { action: "set", t1, t2, t3 };
}

/**
 * 把模板里的占位符替换成实际值。
 *
 * `&t1&` `&t2&` `&t3&` 渲染成紧凑时长（`30s` / `1m30s` / `1h20m30s`），
 * `&t4&` 是动态时长（未超时=剩余，超时后=已超时），格式相同。
 * 渲染完再扫一遍残留占位符并清空，保证「不能残留占位符」这条要求在任何模板内容下都成立。
 *
 * @param {string} template - 模板原文
 * @param {{t1: number, t2: number, t3: number, t4?: string}} values - 替换值
 * @returns {string}
 */
export function renderTemplate(template, values) {
	const text = String(template ?? "");
	if (text === "") return "";
	const table = {
		1: formatCompactDuration(values.t1),
		2: formatCompactDuration(values.t2),
		3: formatCompactDuration(values.t3),
		4: values.t4 ?? ""
	};
	const rendered = text.replace(PLACEHOLDER_PATTERN, (whole, key) => {
		const replacement = table[key];
		return replacement === undefined ? whole : replacement;
	});
	return rendered.replace(LEFTOVER_PATTERN, "");
}

/**
 * 计算一条提醒的 `&t4&` 值。
 * @param {"start" | "before" | "firstOverdue" | "afterOverdue"} phase - 提醒档位
 * @param {number} deadline - 截止时刻（epoch ms）
 * @param {number} now - 当前时刻
 * @returns {string} 格式化后的时长；开始档不需要时长，返回空串
 */
export function templateT4(phase, deadline, now) {
	if (phase === "start") return "";
	const remaining = phase === "before";
	return formatCompactDuration(Math.max(0, (remaining ? deadline - now : now - deadline) / 1000));
}

/**
 * 建一份「绑定到某一轮」的计时计划。
 * @param {{t1: number, t2: number, t3: number}} params - 三个参数
 * @param {{mode: "current" | "next", now: number, turn: number}} bind - 绑定方式
 * @returns {object} 计划对象
 */
export function createPlan(params, bind) {
	return {
		t1: params.t1,
		t2: params.t2,
		t3: params.t3,
		mode: bind.mode,
		/** 待生效：等下一轮 turn/start 才真正开始计时。 */
		pending: bind.mode === "next",
		/** 绑定到的轮次号；next 模式在轮开始时才写入。 */
		turn: bind.mode === "current" ? bind.turn : 0,
		/** 截止时刻（epoch ms）；next 模式在轮开始时才写入。 */
		deadline: bind.mode === "current" ? bind.now + params.t2 * 1000 : 0,
		/** 生效时刻，用于诊断。 */
		armedAt: bind.mode === "current" ? bind.now : 0,
		/** ① 是否已注入。 */
		startSent: false,
		/** ③ 是否已注入（只此一次）。 */
		firstOverSent: false,
		/** 下一档周期提醒的到期时刻；null 表示周期档未启用。 */
		nextDueAt: null
	};
}

/**
 * 新一轮开始时，把待生效的计划激活。
 * @param {object} plan - `mode === "next"` 的计划
 * @param {number} turn - 新轮次号
 * @param {number} startedAt - 该轮 turn/start 的时刻
 * @returns {object} 激活后的计划
 */
export function armPlan(plan, turn, startedAt) {
	return {
		...plan,
		pending: false,
		turn,
		deadline: startedAt + plan.t2 * 1000,
		armedAt: startedAt,
		startSent: false,
		firstOverSent: false,
		nextDueAt: null
	};
}

/**
 * 一次 pre-step 的排程决策。
 *
 * 优先级（同一时刻只出一条）：① 开始 > ② 未超时周期 > ③ 首次超时 > ④ 超时后周期。
 * 其中 ① 只在第一次；③ 只发一次；②④ 靠 `nextDueAt` 限频。
 *
 * @param {object | null | undefined} plan - 当前计划
 * @param {number} now - 当前时刻
 * @returns {{plan: object, phase: "start" | "before" | "firstOverdue" | "afterOverdue"} | null}
 *   该提醒时返回新计划与档位；不该提醒时返回 null
 */
export function stepPlan(plan, now) {
	if (plan === null || plan === undefined) return null;
	if (plan.pending === true) return null;

	// ① 开始生效：优先且只发一次。
	if (!plan.startSent) {
		return {
			phase: "start",
			plan: {
				...plan,
				startSent: true,
				// 未超时周期档从「开始」起算；t1 >= t2 时该档整段跳过。
				nextDueAt: plan.t1 < plan.t2 ? now + plan.t1 * 1000 : null
			}
		};
	}

	if (now < plan.deadline) {
		// ② 未超时周期：t1 >= t2 表示不启用。
		if (plan.t1 >= plan.t2) return null;
		if (plan.nextDueAt === null) {
			return { phase: "before", plan: { ...plan, nextDueAt: now + plan.t1 * 1000 } };
		}
		if (now < plan.nextDueAt) return null;
		return { phase: "before", plan: { ...plan, nextDueAt: now + plan.t1 * 1000 } };
	}

	// ③ 首次超时：不管 t3 如何都要发，且只发一次。
	if (!plan.firstOverSent) {
		return {
			phase: "firstOverdue",
			plan: {
				...plan,
				firstOverSent: true,
				nextDueAt: plan.t3 > 0 ? now + plan.t3 * 1000 : null
			}
		};
	}

	// ④ 超时后周期：t3 <= 0 表示不启用。
	if (plan.t3 <= 0) return null;
	if (plan.nextDueAt === null) {
		return { phase: "afterOverdue", plan: { ...plan, nextDueAt: now + plan.t3 * 1000 } };
	}
	if (now < plan.nextDueAt) return null;
	return { phase: "afterOverdue", plan: { ...plan, nextDueAt: now + plan.t3 * 1000 } };
}

/**
 * 把计划读成一句人话（`/set-time` 无参数时回执用）。
 * @param {object | null | undefined} plan - 当前计划
 * @param {number} now - 当前时刻
 * @returns {string}
 */
export function describePlan(plan, now) {
	if (plan === null || plan === undefined) {
		return "当前没有生效中的计时。用法：/set-time <t1> <t2> <t3>，例如 /set-time 30s 5m 1m。";
	}
	const base = `t1=${formatCompactDuration(plan.t1)}，t2=${formatCompactDuration(plan.t2)}，t3=${plan.t3 > 0 ? formatCompactDuration(plan.t3) : "已关闭（不重复提醒）"}`;
	if (plan.pending === true) return `${base}。等待下一轮对话开始时生效。`;
	if (now >= plan.deadline) {
		return `${base}。已超过预期时间 ${formatCompactDuration((now - plan.deadline) / 1000)}（第 ${plan.turn} 轮）。`;
	}
	return `${base}。第 ${plan.turn} 轮还剩 ${formatCompactDuration((plan.deadline - now) / 1000)}。`;
}

/**
 * 规范化一份从配置文件读到的模板集合：缺项补默认值，非字符串也退回默认值。
 * @param {unknown} raw - 配置里的 templates 字段
 * @returns {{start: string, before: string, firstOverdue: string, afterOverdue: string}}
 */
export function normalizeTemplates(raw) {
	const out = {};
	for (const key of TEMPLATE_KEYS) {
		const value = raw?.[key];
		out[key] = typeof value === "string" ? value : DEFAULT_TEMPLATES[key];
	}
	return out;
}
