#!/usr/bin/env bun

/**
 * Summarizer Wrapper Script
 *
 * Invokes summarization and captures exit codes for failure tracking
 * Called by Stop hook to ensure completion status is always recorded
 */

import { summarizeSession, writeCompletionMarker } from "./summarizer.js";
import { loadConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { initDatabase, closeDatabase } from "../sqlite/database.js";
import { upsertSessionSummary, getSession } from "../sqlite/session-store.js";

async function main() {
	// Get session ID from command line args
	const sessionId = process.argv[2];

	if (!sessionId) {
		console.error("Usage: run-summarizer.ts <session_id>");
		process.exit(1);
	}

	const config = loadConfig();
	const logger = createLogger({
		logDir: config.logging?.logDir,
		sessionId,
		verbose: config.logging?.verbose,
	});

	logger.info("Summarizer wrapper started", { sessionId });

	try {
		// Run summarization
		const result = await summarizeSession(sessionId, logger);

		// Write completion marker
		writeCompletionMarker(
			sessionId,
			result.success,
			result.writtenNotes,
			result.error
		);

		if (result.success) {
			logger.info("Summarization completed successfully", {
				notesWritten: result.writtenNotes.length,
			});
			process.exit(0);
		} else {
			// Update session summary with error
			const db = initDatabase(config.sqlite.path!, logger);
			const session = getSession(db, sessionId);
			if (session) {
				upsertSessionSummary(db, sessionId, session.project, {
					error_message: result.error,
					written_to_vault: 0,
				});
			}
			closeDatabase(db, logger);

			logger.error("Summarization failed", { error: result.error });
			process.exit(1);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Write failure marker
		writeCompletionMarker(sessionId, false, [], errorMessage);

		logger.error("Summarizer wrapper crashed", { error: errorMessage });
		process.exit(1);
	}
}

main();
