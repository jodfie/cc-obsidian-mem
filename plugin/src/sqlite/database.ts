/**
 * SQLite database manager
 * Handles connection, configuration, and initialization
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { runMigrations } from "./migrations.js";
import type { Logger } from "../shared/logger.js";

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

	// Configure database
	configureDatabase(db, logger);

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
