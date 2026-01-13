/**
 * Fallback JSON storage for when SQLite is unavailable
 * Uses simple JSON files in ~/.cc-obsidian-mem/fallback/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type {
	FallbackData,
	FallbackSession,
	UserPrompt,
	ToolUse,
	FileRead,
} from "../shared/types.js";
import { getConfigDir } from "../shared/config.js";

const FALLBACK_DIR = join(getConfigDir(), "fallback");

/**
 * Ensure fallback directory exists
 */
function ensureFallbackDir(): void {
	if (!existsSync(FALLBACK_DIR)) {
		mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
	}
}

/**
 * Get path to fallback session file
 */
function getSessionFilePath(sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
	return join(FALLBACK_DIR, `${safeId}.json`);
}

/**
 * Initialize fallback session
 */
export function initFallbackSession(
	sessionId: string,
	project: string
): void {
	ensureFallbackDir();

	const sessionFile = getSessionFilePath(sessionId);

	// Don't overwrite if exists
	if (existsSync(sessionFile)) {
		return;
	}

	const now = new Date().toISOString();
	const data: FallbackData = {
		session: {
			session_id: sessionId,
			project,
			started_at: now,
			started_at_epoch: Date.now(),
			status: "active",
		},
		prompts: [],
		tool_uses: [],
		file_reads: [],
	};

	writeFileSync(sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Read fallback session data
 */
export function readFallbackSession(sessionId: string): FallbackData | null {
	const sessionFile = getSessionFilePath(sessionId);

	if (!existsSync(sessionFile)) {
		return null;
	}

	try {
		const content = readFileSync(sessionFile, "utf-8");
		return JSON.parse(content) as FallbackData;
	} catch (error) {
		console.error("Failed to read fallback session:", error);
		return null;
	}
}

/**
 * Add user prompt to fallback storage
 */
export function addFallbackPrompt(
	sessionId: string,
	promptNumber: number,
	promptText: string
): void {
	const data = readFallbackSession(sessionId);
	if (!data) {
		return;
	}

	const now = new Date().toISOString();
	const prompt: Omit<UserPrompt, "id"> = {
		session_id: sessionId,
		prompt_number: promptNumber,
		prompt_text: promptText,
		created_at: now,
		created_at_epoch: Date.now(),
	};

	data.prompts.push(prompt);

	const sessionFile = getSessionFilePath(sessionId);
	writeFileSync(sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Add tool use to fallback storage
 */
export function addFallbackToolUse(
	sessionId: string,
	promptNumber: number,
	toolName: string,
	toolInput: string,
	toolOutput: string,
	durationMs?: number,
	cwd?: string
): void {
	const data = readFallbackSession(sessionId);
	if (!data) {
		return;
	}

	const now = new Date().toISOString();
	const toolUse: Omit<ToolUse, "id"> = {
		session_id: sessionId,
		prompt_number: promptNumber,
		tool_name: toolName,
		tool_input: toolInput,
		tool_output: toolOutput,
		tool_output_truncated: 0,
		tool_output_hash: null,
		duration_ms: durationMs ?? null,
		cwd: cwd ?? null,
		created_at: now,
		created_at_epoch: Date.now(),
	};

	data.tool_uses.push(toolUse);

	const sessionFile = getSessionFilePath(sessionId);
	writeFileSync(sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Add file read to fallback storage
 */
export function addFallbackFileRead(
	sessionId: string,
	filePath: string,
	contentHash: string,
	contentSnippet: string | null,
	lineCount: number | null
): void {
	const data = readFallbackSession(sessionId);
	if (!data) {
		return;
	}

	const now = new Date().toISOString();
	const fileRead: Omit<FileRead, "id"> = {
		session_id: sessionId,
		file_path: filePath,
		content_hash: contentHash,
		content_snippet: contentSnippet,
		line_count: lineCount,
		created_at: now,
		created_at_epoch: Date.now(),
	};

	data.file_reads.push(fileRead);

	const sessionFile = getSessionFilePath(sessionId);
	writeFileSync(sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Update fallback session status
 */
export function updateFallbackSessionStatus(
	sessionId: string,
	status: "active" | "completed" | "failed"
): void {
	const data = readFallbackSession(sessionId);
	if (!data) {
		return;
	}

	data.session.status = status;

	const sessionFile = getSessionFilePath(sessionId);
	writeFileSync(sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Check if fallback session exists
 */
export function fallbackSessionExists(sessionId: string): boolean {
	return existsSync(getSessionFilePath(sessionId));
}
