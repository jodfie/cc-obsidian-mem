/**
 * Pending Messages Store
 * Implements claim-and-delete pattern for durable message processing
 */

import type { Database } from "bun:sqlite";
import type { PendingMessage, PendingMessageType } from "../shared/types.js";
import { retryWithBackoff } from "../shared/database-utils.js";

// ============================================================================
// Message Queue Operations
// ============================================================================

/**
 * Enqueue a message for processing
 */
export function enqueueMessage(
	db: Database,
	sessionId: string,
	messageType: PendingMessageType,
	payload: Record<string, unknown>
): PendingMessage {
	return retryWithBackoff(() => {
		const now = new Date();
		const stmt = db.prepare(`
			INSERT INTO pending_messages (session_id, message_type, payload, created_at, created_at_epoch)
			VALUES (?, ?, ?, ?, ?)
		`);
		const result = stmt.run(
			sessionId,
			messageType,
			JSON.stringify(payload),
			now.toISOString(),
			now.getTime()
		);

		return {
			id: Number(result.lastInsertRowid),
			session_id: sessionId,
			message_type: messageType,
			payload: JSON.stringify(payload),
			claimed_at: null,
			claimed_at_epoch: null,
			created_at: now.toISOString(),
			created_at_epoch: now.getTime(),
		};
	});
}

/**
 * Claim unclaimed messages for processing
 * Returns messages and marks them as claimed
 * Uses BEGIN IMMEDIATE transaction to prevent race conditions
 */
export function claimMessages(
	db: Database,
	sessionId: string,
	limit: number = 10
): PendingMessage[] {
	return retryWithBackoff(() => {
		const now = new Date();
		const nowIso = now.toISOString();
		const nowEpoch = now.getTime();

		// Use BEGIN IMMEDIATE to acquire write lock immediately
		// This prevents TOCTOU race conditions between SELECT and UPDATE
		db.run("BEGIN IMMEDIATE");

		try {
			// Get unclaimed messages
			const selectStmt = db.prepare(`
				SELECT * FROM pending_messages
				WHERE session_id = ? AND claimed_at IS NULL
				ORDER BY created_at_epoch ASC
				LIMIT ?
			`);
			const messages = selectStmt.all(sessionId, limit) as PendingMessage[];

			if (messages.length === 0) {
				db.run("COMMIT");
				return [];
			}

			// Mark them as claimed atomically within the same transaction
			const ids = messages.map((m) => m.id);
			const placeholders = ids.map(() => "?").join(",");
			const updateStmt = db.prepare(`
				UPDATE pending_messages
				SET claimed_at = ?, claimed_at_epoch = ?
				WHERE id IN (${placeholders})
			`);
			updateStmt.run(nowIso, nowEpoch, ...ids);

			db.run("COMMIT");

			// Return with updated claimed_at
			return messages.map((m) => ({
				...m,
				claimed_at: nowIso,
				claimed_at_epoch: nowEpoch,
			}));
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	});
}

/**
 * Claim all unclaimed messages for a session
 * Uses BEGIN IMMEDIATE transaction to prevent race conditions
 */
export function claimAllMessages(db: Database, sessionId: string): PendingMessage[] {
	return retryWithBackoff(() => {
		const now = new Date();
		const nowIso = now.toISOString();
		const nowEpoch = now.getTime();

		// Use BEGIN IMMEDIATE to acquire write lock immediately
		// This prevents TOCTOU race conditions between SELECT and UPDATE
		db.run("BEGIN IMMEDIATE");

		try {
			// Get all unclaimed messages
			const selectStmt = db.prepare(`
				SELECT * FROM pending_messages
				WHERE session_id = ? AND claimed_at IS NULL
				ORDER BY created_at_epoch ASC
			`);
			const messages = selectStmt.all(sessionId) as PendingMessage[];

			if (messages.length === 0) {
				db.run("COMMIT");
				return [];
			}

			// Mark all as claimed atomically within the same transaction
			const updateStmt = db.prepare(`
				UPDATE pending_messages
				SET claimed_at = ?, claimed_at_epoch = ?
				WHERE session_id = ? AND claimed_at IS NULL
			`);
			updateStmt.run(nowIso, nowEpoch, sessionId);

			db.run("COMMIT");

			return messages.map((m) => ({
				...m,
				claimed_at: nowIso,
				claimed_at_epoch: nowEpoch,
			}));
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	});
}

/**
 * Delete a message after successful processing
 */
export function deleteMessage(db: Database, messageId: number): void {
	retryWithBackoff(() => {
		const stmt = db.prepare("DELETE FROM pending_messages WHERE id = ?");
		stmt.run(messageId);
	});
}

/**
 * Delete multiple messages after successful processing
 */
export function deleteMessages(db: Database, messageIds: number[]): void {
	if (messageIds.length === 0) return;

	retryWithBackoff(() => {
		const placeholders = messageIds.map(() => "?").join(",");
		const stmt = db.prepare(`DELETE FROM pending_messages WHERE id IN (${placeholders})`);
		stmt.run(...messageIds);
	});
}

/**
 * Release claimed messages back to the queue (on failure)
 */
export function releaseMessages(db: Database, messageIds: number[]): void {
	if (messageIds.length === 0) return;

	retryWithBackoff(() => {
		const placeholders = messageIds.map(() => "?").join(",");
		const stmt = db.prepare(`
			UPDATE pending_messages
			SET claimed_at = NULL, claimed_at_epoch = NULL
			WHERE id IN (${placeholders})
		`);
		stmt.run(...messageIds);
	});
}

/**
 * Get count of pending messages for a session
 */
export function getPendingCount(db: Database, sessionId: string): number {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT COUNT(*) as count FROM pending_messages
			WHERE session_id = ? AND claimed_at IS NULL
		`);
		const result = stmt.get(sessionId) as { count: number };
		return result.count;
	});
}

/**
 * Get all pending messages for a session (for debugging)
 */
export function getPendingMessages(db: Database, sessionId: string): PendingMessage[] {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM pending_messages
			WHERE session_id = ?
			ORDER BY created_at_epoch ASC
		`);
		return stmt.all(sessionId) as PendingMessage[];
	});
}

/**
 * Clean up stale claimed messages (claimed but not processed within timeout)
 * Returns them to unclaimed state
 */
export function cleanupStaleClaims(db: Database, timeoutMs: number = 60000): number {
	return retryWithBackoff(() => {
		const cutoff = Date.now() - timeoutMs;
		const stmt = db.prepare(`
			UPDATE pending_messages
			SET claimed_at = NULL, claimed_at_epoch = NULL
			WHERE claimed_at IS NOT NULL AND claimed_at_epoch < ?
		`);
		const result = stmt.run(cutoff);
		return result.changes;
	});
}

/**
 * Delete all messages for a session (on session cleanup)
 */
export function deleteSessionMessages(db: Database, sessionId: string): number {
	return retryWithBackoff(() => {
		const stmt = db.prepare("DELETE FROM pending_messages WHERE session_id = ?");
		const result = stmt.run(sessionId);
		return result.changes;
	});
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse message payload
 */
export function parsePayload<T>(message: PendingMessage): T {
	return JSON.parse(message.payload) as T;
}

/**
 * Check if there are any pending messages for a session
 */
export function hasPendingMessages(db: Database, sessionId: string): boolean {
	return getPendingCount(db, sessionId) > 0;
}
