#!/usr/bin/env bun

/**
 * PostToolUse Hook
 *
 * Records tool uses to SQLite with redaction and truncation
 * Also tracks file reads separately for better context
 */

import { loadConfig, isAgentSession } from "../../src/shared/config.js";
import { createLogger } from "../../src/shared/logger.js";
import { initDatabase } from "../../src/sqlite/database.js";
import { addToolUse, addFileRead, getSession, getCurrentPromptNumber } from "../../src/sqlite/session-store.js";
import { enqueueMessage } from "../../src/sqlite/pending-store.js";
import {
	addFallbackToolUse,
	addFallbackFileRead,
	fallbackSessionExists,
	getFallbackCurrentPromptNumber,
} from "../../src/fallback/fallback-store.js";
import { validate, PostToolUsePayloadSchema } from "../../src/shared/validation.js";
import { createHash } from "crypto";

// Claude Code sends snake_case fields
interface PostToolUseInput {
	session_id: string;
	tool_name: string;
	tool_input: unknown;
	tool_response: unknown;
	duration_ms?: number;
	cwd?: string;
}

/**
 * Read JSON from stdin
 */
async function readStdinJson<T>(): Promise<T> {
	const stdin = Bun.stdin.stream();
	const reader = stdin.getReader();
	const chunks: Uint8Array[] = [];

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}

		const text = new TextDecoder().decode(Buffer.concat(chunks));
		return JSON.parse(text) as T;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Extract file path and content from Read tool input/output
 */
function extractReadToolData(
	toolInput: string,
	toolOutput: string,
	logger?: ReturnType<typeof createLogger>
): { filePath: string; content: string } | null {
	try {
		const input = JSON.parse(toolInput);
		const output = JSON.parse(toolOutput);

		logger?.debug("extractReadToolData: parsed input/output", {
			inputKeys: Object.keys(input),
			outputKeys: Object.keys(output),
			hasFileKey: "file" in output,
			hasContentKey: "content" in output,
			outputType: output.type,
		});

		// Handle Claude Code's Read tool output format: { type: "text", file: { filePath, content } }
		const content = output.file?.content ?? output.content;
		const filePath = input.file_path;

		logger?.debug("extractReadToolData: extracted values", {
			filePath: filePath ? filePath.substring(0, 50) : null,
			contentLength: content?.length ?? 0,
			contentSource: output.file?.content ? "output.file.content" : output.content ? "output.content" : "none",
		});

		if (filePath && content) {
			return {
				filePath,
				content,
			};
		}

		logger?.warn("extractReadToolData: missing required fields", {
			hasFilePath: !!filePath,
			hasContent: !!content,
		});
	} catch (error) {
		logger?.warn("extractReadToolData: parse error", {
			error: (error as Error).message,
			inputPreview: toolInput.substring(0, 100),
			outputPreview: toolOutput.substring(0, 100),
		});
	}

	return null;
}

async function main() {
	let logger: ReturnType<typeof createLogger> | null = null;

	// Step 1: Read stdin with dedicated error handling
	let input: PostToolUseInput;
	try {
		input = await readStdinJson<PostToolUseInput>();
	} catch (error) {
		console.error("[cc-obsidian-mem] Failed to parse stdin in post-tool-use hook:", error);
		return;
	}

	// Step 2: Check if this is an agent session - skip hooks for agent-spawned sessions
	if (isAgentSession()) {
		console.error("[cc-obsidian-mem] Skipping post-tool-use hook - agent session");
		return;
	}

	// Step 3: Normal processing with its own try-catch
	try {
		const config = loadConfig();
		logger = createLogger({
			logDir: config.logging?.logDir,
			sessionId: input.session_id,
			verbose: config.logging?.verbose,
		});

		logger.debug("PostToolUse hook triggered", {
			sessionId: input.session_id,
			toolName: input.tool_name,
		});

		// Validate input
		const validated = validate(PostToolUsePayloadSchema, input);

		// Try SQLite first
		try {
			const db = initDatabase(config.sqlite.path!, logger);

			// Check session exists
			const session = getSession(db, validated.sessionId);
			if (!session) {
				logger.warn("Session not found, skipping tool use recording");
				db.close();
				return;
			}

			// Get current prompt number (tool uses belong to most recent prompt)
			const promptNumber = getCurrentPromptNumber(db, validated.sessionId);

			// Add tool use with automatic redaction and truncation
			addToolUse(
				db,
				validated.sessionId,
				promptNumber,
				validated.toolName,
				validated.toolInput,
				validated.toolOutput,
				config.sqlite.max_output_size!,
				validated.durationMs,
				validated.cwd
			);

			// Enqueue for SDK agent processing
			enqueueMessage(db, validated.sessionId, "tool_use", {
				tool_name: validated.toolName,
				tool_input: validated.toolInput,
				tool_output: validated.toolOutput,
				duration_ms: validated.durationMs,
				cwd: validated.cwd,
				created_at_epoch: Date.now(),
			});

			logger.info("Tool use recorded and enqueued", {
				toolName: validated.toolName,
				promptNumber: promptNumber,
				inputLength: validated.toolInput.length,
				outputLength: validated.toolOutput.length,
			});

			// If Read tool, also track file read separately
			if (validated.toolName === "Read") {
				logger.debug("Processing Read tool for file_reads tracking");
				const readData = extractReadToolData(
					validated.toolInput,
					validated.toolOutput,
					logger
				);

				if (readData) {
					addFileRead(
						db,
						validated.sessionId,
						readData.filePath,
						readData.content,
						config.sqlite.retention!.file_reads_per_file!
					);

					logger.debug("File read tracked separately", {
						filePath: readData.filePath,
						contentLength: readData.content.length,
					});
				}
			}

			db.close();
		} catch (sqliteError) {
			logger.warn("SQLite error, using fallback storage", { error: sqliteError });

			// Fallback to JSON storage
			if (!fallbackSessionExists(validated.sessionId)) {
				logger.warn("Fallback session not found, cannot record tool use");
				return;
			}

			// Get current prompt number in fallback too
			const promptNumber = getFallbackCurrentPromptNumber(validated.sessionId);

			addFallbackToolUse(
				validated.sessionId,
				promptNumber,
				validated.toolName,
				validated.toolInput,
				validated.toolOutput,
				validated.durationMs,
				validated.cwd
			);

			// Track file reads in fallback too
			if (validated.toolName === "Read") {
				logger.debug("Processing Read tool for fallback file_reads tracking");
				const readData = extractReadToolData(
					validated.toolInput,
					validated.toolOutput,
					logger
				);

				if (readData) {
					const contentHash = createHash("sha256")
						.update(readData.content)
						.digest("hex");
					const contentSnippet =
						readData.content.length > 1024
							? readData.content.substring(0, 1024)
							: readData.content;
					const lineCount = readData.content.split("\n").length;

					addFallbackFileRead(
						validated.sessionId,
						readData.filePath,
						contentHash,
						contentSnippet,
						lineCount
					);
				}
			}

			logger.info("Tool use recorded to fallback storage", {
				toolName: validated.toolName,
			});
		}
	} catch (error) {
		// Log error but don't throw - hooks must never crash
		if (logger) {
			logger.error("PostToolUse hook error", { error });
		} else {
			console.error("PostToolUse hook error:", error);
		}
	}
}

main();
