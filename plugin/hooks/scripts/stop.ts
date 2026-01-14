#!/usr/bin/env bun

/**
 * Stop Hook
 *
 * 1. Processes any remaining pending messages
 * 2. Requests final session summary
 * 3. Marks session as completed
 * 4. Triggers background summarization for vault export
 */

import { loadConfig, isAgentSession } from "../../src/shared/config.js";
import { createLogger } from "../../src/shared/logger.js";
import { initDatabase, closeDatabase } from "../../src/sqlite/database.js";
import {
	updateSessionStatus,
	cleanupOldSessions,
	getSession,
} from "../../src/sqlite/session-store.js";
import {
	enqueueMessage,
	claimAllMessages,
	deleteMessages,
	hasPendingMessages,
} from "../../src/sqlite/pending-store.js";
import { processSessionMessages, clearAgentContext } from "../../src/sdk/agent.js";
import { updateFallbackSessionStatus } from "../../src/fallback/fallback-store.js";
import { validate, StopPayloadSchema } from "../../src/shared/validation.js";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Claude Code sends snake_case fields
interface StopInput {
	session_id: string;
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

async function main() {
	let logger: ReturnType<typeof createLogger> | null = null;

	// Step 1: Read stdin with dedicated error handling
	let input: StopInput;
	try {
		input = await readStdinJson<StopInput>();
	} catch (error) {
		console.error("[cc-obsidian-mem] Failed to parse stdin in stop hook:", error);
		return;
	}

	// Step 2: Check if this is an agent session - skip hooks for agent-spawned sessions
	if (isAgentSession()) {
		console.error("[cc-obsidian-mem] Skipping stop hook - agent session");
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

		logger.info("Stop hook triggered", { sessionId: input.session_id });

		// Validate input
		const validated = validate(StopPayloadSchema, input);

		// Try SQLite first
		try {
			const db = initDatabase(config.sqlite.path!, logger);

			// Get session for project info
			const session = getSession(db, validated.sessionId);
			if (!session) {
				logger.warn("Session not found", { sessionId: validated.sessionId });
				closeDatabase(db, logger);
				return;
			}

			// Process any remaining pending messages
			if (hasPendingMessages(db, validated.sessionId)) {
				logger.info("Processing remaining pending messages");
				try {
					const result = processSessionMessages(db, validated.sessionId, logger);
					logger.info("Pending messages processed", {
						processed: result.processed,
						observations: result.observations.length,
					});
				} catch (agentError) {
					logger.warn("Agent processing failed", { error: agentError });
				}
			}

			// Request final summary
			enqueueMessage(db, validated.sessionId, "summary_request", {
				last_assistant_message: "",
			});

			// Process the summary request
			try {
				const summaryResult = processSessionMessages(db, validated.sessionId, logger);
				logger.info("Summary generated", {
					observations: summaryResult.observations.length,
				});
			} catch (summaryError) {
				logger.warn("Summary generation failed", { error: summaryError });
			}

			// Clear agent context
			clearAgentContext(validated.sessionId);

			// Mark session as completed
			updateSessionStatus(db, validated.sessionId, "completed");

			logger.info("Session marked as completed", {
				sessionId: validated.sessionId,
			});

			// Trigger background summarization for vault export
			triggerBackgroundSummarization(validated.sessionId, logger);

			// Clean up old sessions based on retention
			const retentionCount = config.sqlite.retention?.sessions ?? 50;
			cleanupOldSessions(db, retentionCount);

			closeDatabase(db, logger);
		} catch (sqliteError) {
			logger.warn("SQLite error, using fallback storage", { error: sqliteError });

			// Fallback to JSON storage
			updateFallbackSessionStatus(validated.sessionId, "completed");

			logger.info("Session marked as completed in fallback storage", {
				sessionId: validated.sessionId,
			});
		}
	} catch (error) {
		// Log error but don't throw - hooks must never crash
		if (logger) {
			logger.error("Stop hook error", { error });
		} else {
			console.error("Stop hook error:", error);
		}
	}
}

/**
 * Trigger background summarization to export observations to vault
 */
function triggerBackgroundSummarization(
	sessionId: string,
	logger: ReturnType<typeof createLogger>
): void {
	try {
		// Get the path to the summarizer script
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const summarizerPath = join(__dirname, "../../src/summarizer/run-summarizer.ts");

		// Spawn the summarizer in background
		const child = spawn("bun", ["run", summarizerPath, sessionId], {
			detached: true,
			stdio: "ignore",
			windowsHide: true, // Prevent cmd popup on Windows
		});

		child.unref();

		logger.info("Background summarization triggered", {
			sessionId,
			pid: child.pid,
		});
	} catch (error) {
		logger.warn("Failed to trigger background summarization", {
			error: (error as Error).message,
		});
	}
}

main();
