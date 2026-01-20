/**
 * SQLite database manager
 * Handles connection, configuration, and initialization
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { runMigrations } from "./migrations.js";
import type { Logger } from "../shared/logger.js";

// SQLite error codes that indicate transient lock issues
const RETRYABLE_ERROR_CODES = [
	"SQLITE_BUSY",
	"SQLITE_BUSY_RECOVERY",
	"SQLITE_LOCKED",
];

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 50;

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (transient SQLite lock)
 */
function isRetryableError(error: unknown): boolean {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code: string }).code;
		return RETRYABLE_ERROR_CODES.includes(code);
	}
	return false;
}

/**
 * Initialize and configure SQLite database
 */
export function initDatabase(dbPath: string, logger: Logger): Database {
	logger.debug("Initializing database", { dbPath });

	// Ensure directory exists
	const dbDir = dirname(dbPath);
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true, mode: 0o700 });
	}

	// Open database
	const db = new Database(dbPath, { create: true });

	// Set file permissions to 0600 (owner read/write only)
	try {
		const fs = require("fs");
		fs.chmodSync(dbPath, 0o600);
	} catch (error) {
		logger.warn("Failed to set database file permissions", { error });
	}

	// Configure database with retry logic for transient lock errors
	configureDatabaseWithRetry(db, logger);

	// Run migrations
	try {
		runMigrations(db);
		logger.info("Database migrations completed");
	} catch (error) {
		logger.error("Database migration failed", { error });
		throw error;
	}

	return db;
}

/**
 * Configure database with retry logic for transient lock errors
 * Uses exponential backoff: 50ms, 100ms, 200ms
 */
function configureDatabaseWithRetry(db: Database, logger: Logger): void {
	let lastError: unknown;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			configureDatabase(db, logger);
			return; // Success
		} catch (error) {
			lastError = error;

			if (!isRetryableError(error)) {
				// Non-retryable error, throw immediately
				throw error;
			}

			// Calculate delay with exponential backoff
			const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt);

			logger.debug("Database configuration failed with retryable error, retrying", {
				attempt: attempt + 1,
				maxRetries: MAX_RETRIES,
				delayMs,
				errorCode: (error as { code?: string }).code,
			});

			// Synchronous sleep using Atomics.wait (works in Bun)
			const sharedBuffer = new SharedArrayBuffer(4);
			const int32 = new Int32Array(sharedBuffer);
			Atomics.wait(int32, 0, 0, delayMs);
		}
	}

	// All retries exhausted
	logger.error("Database configuration failed after all retries", {
		attempts: MAX_RETRIES,
		lastError,
	});
	throw lastError;
}

/**
 * Configure database performance and reliability settings
 */
function configureDatabase(db: Database, logger: Logger): void {
	try {
		// Enable WAL mode for better concurrency
		db.run("PRAGMA journal_mode = WAL");

		// Enable foreign keys
		db.run("PRAGMA foreign_keys = ON");

		// Set busy timeout to 5 seconds
		db.run("PRAGMA busy_timeout = 5000");

		// Memory-mapped I/O for better performance (256MB)
		db.run("PRAGMA mmap_size = 268435456");

		// Increase cache size (10000 pages ~= 40MB with 4KB pages)
		db.run("PRAGMA cache_size = -10000");

		// Synchronous = NORMAL for WAL mode (good balance of safety and performance)
		db.run("PRAGMA synchronous = NORMAL");

		logger.debug("Database configured successfully");
	} catch (error) {
		logger.error("Failed to configure database", { error });
		throw error;
	}
}

/**
 * Close database connection safely
 */
export function closeDatabase(db: Database, logger: Logger): void {
	try {
		// Checkpoint WAL file
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");

		// Close connection
		db.close();

		logger.debug("Database closed successfully");
	} catch (error) {
		logger.error("Failed to close database", { error });
	}
}
