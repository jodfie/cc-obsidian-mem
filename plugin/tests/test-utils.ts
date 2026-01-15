/**
 * Test utilities for handling platform-specific cleanup
 */

import { existsSync, unlinkSync } from "fs";

/**
 * Safely delete a file with retry logic for Windows
 * Windows may hold file locks briefly after closing handles
 */
export function safeUnlink(filePath: string, maxRetries = 5, delayMs = 100): void {
	if (!existsSync(filePath)) {
		return;
	}

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			unlinkSync(filePath);
			return;
		} catch (error: unknown) {
			const isLastAttempt = attempt === maxRetries - 1;
			const isLockError =
				error instanceof Error &&
				"code" in error &&
				(error.code === "EBUSY" || error.code === "EPERM");

			if (isLastAttempt || !isLockError) {
				// On last attempt or non-lock error, just ignore
				// Test temp files will eventually be cleaned up
				return;
			}

			// Wait before retrying
			Bun.sleepSync(delayMs);
		}
	}
}

/**
 * Create a cleanup function for afterEach that handles Windows file locking
 */
export function createDbCleanup(
	getDb: () => { close: () => void } | null,
	getPath: () => string
): () => void {
	return () => {
		const db = getDb();
		if (db) {
			try {
				db.close();
			} catch {
				// Ignore close errors
			}
		}
		safeUnlink(getPath());
	};
}
