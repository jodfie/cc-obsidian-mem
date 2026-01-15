/**
 * Database utilities for retry logic and error handling
 */

/**
 * SQLITE_BUSY error code
 */
const SQLITE_BUSY = "SQLITE_BUSY";

/**
 * Synchronous retry for database operations
 * Note: SQLite's busy_timeout pragma handles most contention cases
 * This is an additional safety layer for edge cases
 */
export function retryWithBackoff<T>(
	operation: () => T,
	options?: {
		maxRetries?: number;
	}
): T {
	const maxRetries = options?.maxRetries ?? 3;

	let lastError: Error | undefined;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return operation();
		} catch (error) {
			lastError = error as Error;

			// Only retry on SQLITE_BUSY errors
			if (!isSQLiteBusyError(error)) {
				throw error;
			}

			// Don't retry on last attempt
			if (attempt === maxRetries - 1) {
				break;
			}

			// Note: SQLite's busy_timeout pragma handles waiting
			// We just retry immediately for a fresh attempt
		}
	}

	throw lastError;
}

/**
 * Check if error is SQLITE_BUSY
 */
function isSQLiteBusyError(error: unknown): boolean {
	if (error instanceof Error) {
		return (
			error.message.includes(SQLITE_BUSY) ||
			error.message.includes("database is locked")
		);
	}
	return false;
}
