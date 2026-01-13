#!/usr/bin/env bun

/**
 * PostToolUse Hook
 *
 * Records tool uses to SQLite with redaction and truncation
 * Also tracks file reads separately for better context
 */

import { loadConfig } from "../../src/shared/config.js";
import { createLogger } from "../../src/shared/logger.js";
import { initDatabase } from "../../src/sqlite/database.js";
import { addToolUse, addFileRead, getSession } from "../../src/sqlite/session-store.js";
import { enqueueMessage } from "../../src/sqlite/pending-store.js";
import {
	addFallbackToolUse,
	addFallbackFileRead,
	fallbackSessionExists,
} from "../../src/fallback/fallback-store.js";
import { validate, PostToolUsePayloadSchema } from "../../src/shared/validation.js";
import { createHash } from "crypto";

interface PostToolUseInput {
	sessionId: string;
	promptNumber: number;
	toolName: string;
	toolInput: string;
	toolOutput: string;
	durationMs?: number;
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
	toolOutput: string
): { filePath: string; content: string } | null {
	try {
		const input = JSON.parse(toolInput);
		const output = JSON.parse(toolOutput);

		if (input.file_path && output.content) {
			return {
				filePath: input.file_path,
				content: output.content,
			};
		}
	} catch {
		// Not JSON or missing expected fields
	}

	return null;
}

async function main() {
	let logger: ReturnType<typeof createLogger> | null = null;

	try {
		const input = await readStdinJson<PostToolUseInput>();

		const config = loadConfig();
		logger = createLogger({
			logDir: config.logging?.logDir,
			sessionId: input.sessionId,
			verbose: config.logging?.verbose,
		});

		logger.debug("PostToolUse hook triggered", {
			sessionId: input.sessionId,
			toolName: input.toolName,
			promptNumber: input.promptNumber,
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

			// Add tool use with automatic redaction and truncation
			addToolUse(
				db,
				validated.sessionId,
				validated.promptNumber,
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
				inputLength: validated.toolInput.length,
				outputLength: validated.toolOutput.length,
			});

			// If Read tool, also track file read separately
			if (validated.toolName === "Read") {
				const readData = extractReadToolData(
					validated.toolInput,
					validated.toolOutput
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

			addFallbackToolUse(
				validated.sessionId,
				validated.promptNumber,
				validated.toolName,
				validated.toolInput,
				validated.toolOutput,
				validated.durationMs,
				validated.cwd
			);

			// Track file reads in fallback too
			if (validated.toolName === "Read") {
				const readData = extractReadToolData(
					validated.toolInput,
					validated.toolOutput
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
