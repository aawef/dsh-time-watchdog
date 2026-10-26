// dsh-clock 的宿主侧配置存储：一份极小的 JSON 文件，够用就好。
//
// 为什么不走 storageDomain：那份 API 有两个陷阱（绝不能 import dsh-storage-domain，
// 见 dsh-plugin-persistence 技能），而这里只有几个数字和几段文案要存。用
// ~/.dsh/storages 下的一个 JSON 文件，与本机其它插件（my-run 等）的习惯一致，
// 读写失败也只是退回默认值。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readConfig } from "../src/config.js";
import { TEMPLATE_KEYS } from "../src/timing.js";

const STORAGE_DIR = join(homedir(), ".dsh", "storages");
const CONFIG_FILE = join(STORAGE_DIR, "dsh-clock.json");

/**
 * 读当前配置。任何异常都退回默认值，不让一个坏文件打断插件加载。
 * @returns {{intervalSeconds: number | null, toastOnPrompt: boolean, templates: object}}
 */
export function loadConfig() {
	try {
		if (!existsSync(CONFIG_FILE)) return readConfig({});
		return readConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		return readConfig({});
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
		templates: config?.templates
	});
	try {
		mkdirSync(STORAGE_DIR, { recursive: true });
		const templates = {};
		for (const key of TEMPLATE_KEYS) templates[key] = normalized.templates[key];
		writeFileSync(
			CONFIG_FILE,
			JSON.stringify(
				{
					intervalSeconds: normalized.intervalSeconds,
					toastOnPrompt: normalized.toastOnPrompt,
					templates
				},
				null,
				2
			),
			"utf8"
		);
	} catch (error) {
		console.error("[dsh-clock] 写入配置失败:", error);
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
		templates:
			patch !== null && Object.hasOwn(patch, "templates")
				? { ...current.templates, ...patch.templates }
				: current.templates
	});
}

/** 配置文件路径，供诊断/README 引用。 */
export const CONFIG_PATH = CONFIG_FILE;
