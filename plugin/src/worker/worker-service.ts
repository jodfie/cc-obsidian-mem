#!/usr/bin/env bun

/**
 * Worker Service for Async Message Processing
 *
 * This worker runs in the background and:
 * 1. Polls for pending messages across all active sessions
 * 2. Processes them using the SDK agent
 * 3. Cleans up stale claims
 *
 * Can be run as:
 * - Standalone daemon: bun run worker-service.ts
 * - One-shot: bun run worker-service.ts --once
 * - For specific session: bun run worker-service.ts --session <id>
 */

import { loadConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { initDatabase, closeDatabase } from "../sqlite/database.js";
import { getActiveSessions } from "../sqlite/session-store.js";
import {
	hasPendingMessages,
	cleanupStaleClaims,
	getPendingCount,
} from "../sqlite/pending-store.js";
import { processSessionMessages } from "../sdk/agent.js";

// ============================================================================
// Configuration
// ============================================================================

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const STALE_CLAIM_TIMEOUT_MS = 60000; // Claims older than 1 minute are stale
const MAX_SESSIONS_PER_CYCLE = 10; // Max sessions to process per cycle

// ============================================================================
// Worker State
// ============================================================================

let isRunning = false;
let shouldStop = false;

// ============================================================================
// Main Worker Logic
// ============================================================================

/**
 * Process pending messages for all active sessions
 */
async function processCycle(
	dbPath: string,
	logger: ReturnType<typeof createLogger>
): Promise<{ sessionsProcessed: number; messagesProcessed: number; observationsCreated: number }> {
	const db = initDatabase(dbPath, logger);
	let sessionsProcessed = 0;
	let messagesProcessed = 0;
	let observationsCreated = 0;

	try {
		// Clean up stale claims first
		const staleReleased = cleanupStaleClaims(db, STALE_CLAIM_TIMEOUT_MS);
		if (staleReleased > 0) {
			logger.info("Released stale claims", { count: staleReleased });
		}

		// Get active sessions
		const sessions = getActiveSessions(db);
		const sessionsToProcess = sessions.slice(0, MAX_SESSIONS_PER_CYCLE);

		for (const session of sessionsToProcess) {
			if (shouldStop) break;

			// Check if session has pending messages
			if (!hasPendingMessages(db, session.session_id)) {
				continue;
			}

			const pendingCount = getPendingCount(db, session.session_id);
			logger.debug("Processing session", {
				sessionId: session.session_id,
				pendingMessages: pendingCount,
			});

			try {
				const result = processSessionMessages(db, session.session_id, logger);
				sessionsProcessed++;
				messagesProcessed += result.processed;
				observationsCreated += result.observations.length;

				logger.info("Session processed", {
					sessionId: session.session_id,
					processed: result.processed,
					observations: result.observations.length,
				});
			} catch (error) {
				logger.error("Error processing session", {
					sessionId: session.session_id,
					error: (error as Error).message,
				});
			}
		}
	} finally {
		closeDatabase(db, logger);
	}

	return { sessionsProcessed, messagesProcessed, observationsCreated };
}

/**
 * Process a single session
 */
async function processSingleSession(
	dbPath: string,
	sessionId: string,
	logger: ReturnType<typeof createLogger>
): Promise<{ processed: number; observations: number }> {
	const db = initDatabase(dbPath, logger);

	try {
		const result = processSessionMessages(db, sessionId, logger);
		return {
			processed: result.processed,
			observations: result.observations.length,
		};
	} finally {
		closeDatabase(db, logger);
	}
}

/**
 * Run the worker in daemon mode
 */
async function runDaemon(
	dbPath: string,
	logger: ReturnType<typeof createLogger>
): Promise<void> {
	logger.info("Worker daemon starting", { pollInterval: POLL_INTERVAL_MS });

	isRunning = true;

	while (!shouldStop) {
		try {
			const result = await processCycle(dbPath, logger);

			if (result.messagesProcessed > 0) {
				logger.info("Cycle completed", result);
			}
		} catch (error) {
			logger.error("Cycle error", { error: (error as Error).message });
		}

		// Wait for next poll interval
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	isRunning = false;
	logger.info("Worker daemon stopped");
}

/**
 * Run the worker once (process all pending and exit)
 */
async function runOnce(
	dbPath: string,
	logger: ReturnType<typeof createLogger>
): Promise<void> {
	logger.info("Worker running once");

	const result = await processCycle(dbPath, logger);

	logger.info("One-shot processing complete", result);
}

// ============================================================================
// Signal Handling
// ============================================================================

function setupSignalHandlers(logger: ReturnType<typeof createLogger>): void {
	const handleShutdown = (signal: string) => {
		logger.info(`Received ${signal}, shutting down...`);
		shouldStop = true;
	};

	process.on("SIGINT", () => handleShutdown("SIGINT"));
	process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
	const config = loadConfig();
	const logger = createLogger({
		logDir: config.logging?.logDir,
		verbose: config.logging?.verbose,
	});

	const args = process.argv.slice(2);
	const once = args.includes("--once");
	const sessionIndex = args.indexOf("--session");
	const sessionId = sessionIndex !== -1 ? args[sessionIndex + 1] : null;

	if (!config.sqlite.path) {
		logger.error("SQLite path not configured");
		process.exit(1);
	}

	setupSignalHandlers(logger);

	if (sessionId) {
		// Process specific session
		logger.info("Processing specific session", { sessionId });
		const result = await processSingleSession(config.sqlite.path, sessionId, logger);
		logger.info("Session processing complete", result);
	} else if (once) {
		// One-shot mode
		await runOnce(config.sqlite.path, logger);
	} else {
		// Daemon mode
		await runDaemon(config.sqlite.path, logger);
	}
}

// Export for programmatic use
export {
	processCycle,
	processSingleSession,
	runOnce,
	runDaemon,
};

// Run if executed directly
main().catch((error) => {
	console.error("Worker service error:", error);
	process.exit(1);
});
