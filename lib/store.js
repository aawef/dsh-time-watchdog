// dsh-clock 的宿主侧配置存储：一份极小的 JSON 文件，够用就好。
//
// 为什么不走 storageDomain：那份 API 有两个陷阱（绝不能 import dsh-storage-domain，
// 见 dsh-plugin-persistence 技能），而这里只有一个数字要存。用 ~/.dsh/storages
// 下的一个 JSON 文件，与本机其它插件（my-run 等）的习惯一致，读写失败也只是退回默认值。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readConfig } from "../src/config.js";

const STORAGE_DIR = join(homedir(), ".dsh", "storages");
const CONFIG_FILE = join(STORAGE_DIR, "dsh-clock.json");

/**
 * 读当前配置。任何异常都退回「关闭」，不让一个坏文件打断插件加载。
 * @returns {{intervalSeconds: number | null}}
 */
export function loadConfig() {
	try {
		if (!existsSync(CONFIG_FILE)) return { intervalSeconds: null };
		return readConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		return { intervalSeconds: null };
	}
}

/**
 * 写配置。写盘失败只记一行日志，不改变内存里的返回值。
 * @param {{intervalSeconds: number | null}} config - 要保存的配置
 * @returns {{intervalSeconds: number | null}} 实际生效的配置
 */
export function saveConfig(config) {
	try {
		mkdirSync(STORAGE_DIR, { recursive: true });
		writeFileSync(CONFIG_FILE, JSON.stringify({ intervalSeconds: config.intervalSeconds }, null, 2), "utf8");
	} catch (error) {
		console.error("[dsh-clock] 写入配置失败:", error);
	}
	return config;
}

/** 配置文件路径，供诊断/README 引用。 */
export const CONFIG_PATH = CONFIG_FILE;
