#!/usr/bin/env bun

/**
 * UserPromptSubmit Hook
 *
 * 1. Injects memory context before each prompt
 * 2. Records user prompts to SQLite
 * 3. Enqueues prompt for SDK agent processing
 */

import { loadConfig } from "../../src/shared/config.js";
import { createLogger } from "../../src/shared/logger.js";
import { initDatabase } from "../../src/sqlite/database.js";
import { addUserPrompt, getSession } from "../../src/sqlite/session-store.js";
import { enqueueMessage } from "../../src/sqlite/pending-store.js";
import { generateContext, generateCompactContext } from "../../src/context/context-builder.js";
import {
	initFallbackSession,
	addFallbackPrompt,
	fallbackSessionExists,
} from "../../src/fallback/fallback-store.js";
import { validate, UserPromptSubmitPayloadSchema } from "../../src/shared/validation.js";

interface UserPromptSubmitInput {
	sessionId: string;
	promptNumber: number;
	promptText: string;
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

	try {
		const input = await readStdinJson<UserPromptSubmitInput>();

		const config = loadConfig();
		logger = createLogger({
			logDir: config.logging?.logDir,
			sessionId: input.sessionId,
			verbose: config.logging?.verbose,
		});

		logger.debug("UserPromptSubmit hook triggered", {
			sessionId: input.sessionId,
			promptNumber: input.promptNumber,
		});

		// Validate input
		const validated = validate(UserPromptSubmitPayloadSchema, input);

		// Try SQLite first
		try {
			const db = initDatabase(config.sqlite.path!, logger);

			// Check session exists and is active
			const session = getSession(db, validated.sessionId);
			if (!session) {
				logger.warn("Session not found, skipping prompt recording");
				db.close();
				return;
			}

			// Add prompt to database
			addUserPrompt(
				db,
				validated.sessionId,
				validated.promptNumber,
				validated.promptText
			);

			// Enqueue prompt for SDK agent processing
			enqueueMessage(db, validated.sessionId, "prompt", {
				prompt_text: validated.promptText,
				prompt_number: validated.promptNumber,
			});

			logger.info("User prompt recorded and enqueued", {
				promptNumber: validated.promptNumber,
				promptLength: validated.promptText.length,
			});

			// Generate and inject memory context
			// Skip context injection for first prompt (handled in SessionStart)
			if (validated.promptNumber > 1) {
				try {
					const context = generateContext(db, session.project, validated.sessionId);

					if (context && context.length > 50) {
						// Output context as a comment that will be injected
						console.log(context);
						logger.debug("Context injected", {
							contextLength: context.length,
							project: session.project,
						});
					}
				} catch (contextError) {
					// Context injection is non-critical, log and continue
					logger.warn("Context generation failed", { error: contextError });
				}
			}

			db.close();
		} catch (sqliteError) {
			logger.warn("SQLite error, using fallback storage", { error: sqliteError });

			// Fallback to JSON storage
			if (!fallbackSessionExists(validated.sessionId)) {
				logger.warn("Fallback session not found, cannot record prompt");
				return;
			}

			addFallbackPrompt(
				validated.sessionId,
				validated.promptNumber,
				validated.promptText
			);

			logger.info("User prompt recorded to fallback storage", {
				promptNumber: validated.promptNumber,
			});
		}
	} catch (error) {
		// Log error but don't throw - hooks must never crash
		if (logger) {
			logger.error("UserPromptSubmit hook error", { error });
		} else {
			console.error("UserPromptSubmit hook error:", error);
		}
	}
}

main();
