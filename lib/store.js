// dsh-time-watchdog 的宿主侧配置存储：一份极小的 JSON 文件，够用就好。
//
// 为什么不走 storageDomain：那份 API 有两个陷阱（绝不能 import dsh-storage-domain，
// 见 dsh-plugin-persistence 技能），而这里只有几个数字和几段文案要存。用
// ~/.dsh/storages 下的一个 JSON 文件，与本机其它插件（my-run 等）的习惯一致，
// 读写失败也只是退回默认值。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readConfig } from "../src/config.js";
import { TEMPLATE_KEYS } from "../src/timing.js";

const STORAGE_DIR = join(homedir(), ".dsh", "storages");
const CONFIG_FILE = join(STORAGE_DIR, "dsh-time-watchdog.json");

/**
 * 进程内缓存。
 *
 * 原实现每次 loadConfig() 都同步读盘，而 renderNotice 每条提醒读一次、命令每次
 * 读一次——注入提醒的路径上白白付一次磁盘 I/O。配置只在 saveConfig 里变，
 * 缓存在那里同步更新即可；外部手改文件不会被感知（可接受：这个文件属于插件）。
 * @type {object|null}
 */
let cache = null;

/** 清空缓存（测试用）。 */
export function resetConfigCache() {
	cache = null;
}

/**
 * 读当前配置。任何异常都退回默认值，不让一个坏文件打断插件加载。
 * @returns {{intervalSeconds: number | null, toastOnPrompt: boolean, toastDetail: boolean, templates: object}}
 */
export function loadConfig() {
	if (cache !== null) return cache;
	try {
		if (!existsSync(CONFIG_FILE)) {
			cache = readConfig({});
			return cache;
		}
		cache = readConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
		return cache;
	} catch (error) {
		// 不静默：配置文件坏掉时用户有权知道为什么设置回到默认值。
		console.error("[dsh-time-watchdog] 读取配置失败，使用默认值:", error?.message ?? error);
		cache = readConfig({});
		return cache;
	}
}

/**
 * 写配置。写盘失败只记一行日志，不改变内存里的返回值。
 * 写入前统一过一遍 `readConfig`，保证落盘的永远是规范形状（缺项补默认值）。
 * @param {{intervalSeconds?: number | null, toastOnPrompt?: boolean, templates?: object}} config - 要保存的配置
 * @returns {object} 实际生效的配置
 */
export function saveConfig(config) {
	const normalized = readConfig({
		intervalSeconds: config?.intervalSeconds ?? null,
		toastOnPrompt: config?.toastOnPrompt,
		toastDetail: config?.toastDetail,
		templates: config?.templates
	});
	try {
		mkdirSync(STORAGE_DIR, { recursive: true });
		const templates = {};
		for (const key of TEMPLATE_KEYS) templates[key] = normalized.templates[key];
		const text = JSON.stringify(
			{
				intervalSeconds: normalized.intervalSeconds,
				toastOnPrompt: normalized.toastOnPrompt,
				toastDetail: normalized.toastDetail,
				templates
			},
			null,
			2
		);
		// 先写临时文件再 rename：writeFileSync 直写目标时，崩溃/断电可能留下
		// 被截断的半个 JSON，而 loadConfig 又会静默退回默认值 —— 用户的模板就
		// 无声无息地没了。rename 在同一卷上是原子的。
		const temp = CONFIG_FILE + ".tmp";
		writeFileSync(temp, text, "utf8");
		renameSync(temp, CONFIG_FILE);
		cache = normalized;
	} catch (error) {
		console.error("[dsh-time-watchdog] 写入配置失败:", error);
	}
	return normalized;
}

/**
 * 局部更新配置：只覆盖传入的字段，其余保持原样。
 * @param {object} patch - 要改的字段
 * @returns {object} 更新后的完整配置
 */
export function patchConfig(patch) {
	const current = loadConfig();
	return saveConfig({
		intervalSeconds:
			patch !== null && Object.hasOwn(patch, "intervalSeconds") ? patch.intervalSeconds : current.intervalSeconds,
		toastOnPrompt:
			patch !== null && Object.hasOwn(patch, "toastOnPrompt") ? patch.toastOnPrompt : current.toastOnPrompt,
		toastDetail:
			patch !== null && Object.hasOwn(patch, "toastDetail") ? patch.toastDetail : current.toastDetail,
		templates:
			patch !== null && Object.hasOwn(patch, "templates")
				? { ...current.templates, ...patch.templates }
				: current.templates
	});
}

/** 配置文件路径，供诊断/README 引用。 */
export const CONFIG_PATH = CONFIG_FILE;
