/**
 * Pending Messages Store Tests
 * Tests claim-and-delete pattern
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "../src/sqlite/migrations.js";
import { createSession } from "../src/sqlite/session-store.js";
import {
	enqueueMessage,
	claimMessages,
	claimAllMessages,
	deleteMessage,
	deleteMessages,
	releaseMessages,
	getPendingCount,
	getPendingMessages,
	cleanupStaleClaims,
	hasPendingMessages,
	parsePayload,
} from "../src/sqlite/pending-store.js";
import { safeUnlink } from "./test-utils.js";

describe("Pending Messages Store", () => {
	let db: Database;
	let dbPath: string;
	const sessionId = "test-session-pending";

	beforeEach(() => {
		dbPath = join(tmpdir(), `test-pending-${Date.now()}.db`);
		db = new Database(dbPath, { create: true });
		runMigrations(db);
		// Create a session for foreign key
		createSession(db, sessionId, "test-project");
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// Ignore close errors
		}
		safeUnlink(dbPath);
	});

	describe("Enqueue Operations", () => {
		test("enqueues a message", () => {
			const msg = enqueueMessage(db, sessionId, "tool_use", {
				tool_name: "Read",
				tool_input: '{"file_path": "test.ts"}',
			});

			expect(msg.id).toBeGreaterThan(0);
			expect(msg.session_id).toBe(sessionId);
			expect(msg.message_type).toBe("tool_use");
			expect(msg.claimed_at).toBeNull();
		});

		test("enqueues multiple messages", () => {
			enqueueMessage(db, sessionId, "tool_use", { tool: "Read" });
			enqueueMessage(db, sessionId, "tool_use", { tool: "Edit" });
			enqueueMessage(db, sessionId, "prompt", { text: "Hello" });

			expect(getPendingCount(db, sessionId)).toBe(3);
		});
	});

	describe("Claim Operations", () => {
		test("claims messages and marks them", () => {
			enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			enqueueMessage(db, sessionId, "tool_use", { a: 2 });

			const claimed = claimMessages(db, sessionId, 2);

			expect(claimed).toHaveLength(2);
			expect(claimed[0].claimed_at).not.toBeNull();
			expect(claimed[1].claimed_at).not.toBeNull();
		});

		test("respects limit", () => {
			enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			enqueueMessage(db, sessionId, "tool_use", { a: 2 });
			enqueueMessage(db, sessionId, "tool_use", { a: 3 });

			const claimed = claimMessages(db, sessionId, 2);

			expect(claimed).toHaveLength(2);
			expect(getPendingCount(db, sessionId)).toBe(1);
		});

		test("claimAllMessages claims everything", () => {
			enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			enqueueMessage(db, sessionId, "tool_use", { a: 2 });
			enqueueMessage(db, sessionId, "tool_use", { a: 3 });

			const claimed = claimAllMessages(db, sessionId);

			expect(claimed).toHaveLength(3);
			expect(getPendingCount(db, sessionId)).toBe(0);
		});

		test("does not re-claim already claimed messages", () => {
			enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			claimMessages(db, sessionId, 1);

			const secondClaim = claimMessages(db, sessionId, 10);

			expect(secondClaim).toHaveLength(0);
		});
	});

	describe("Delete Operations", () => {
		test("deletes a message", () => {
			const msg = enqueueMessage(db, sessionId, "tool_use", { a: 1 });

			deleteMessage(db, msg.id);

			expect(getPendingMessages(db, sessionId)).toHaveLength(0);
		});

		test("deletes multiple messages", () => {
			const msg1 = enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			const msg2 = enqueueMessage(db, sessionId, "tool_use", { a: 2 });
			enqueueMessage(db, sessionId, "tool_use", { a: 3 });

			deleteMessages(db, [msg1.id, msg2.id]);

			expect(getPendingMessages(db, sessionId)).toHaveLength(1);
		});
	});

	describe("Release Operations", () => {
		test("releases claimed messages", () => {
			enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			const claimed = claimMessages(db, sessionId, 1);

			expect(getPendingCount(db, sessionId)).toBe(0);

			releaseMessages(db, [claimed[0].id]);

			expect(getPendingCount(db, sessionId)).toBe(1);
		});
	});

	describe("Stale Claim Cleanup", () => {
		test("cleans up stale claims", () => {
			const msg = enqueueMessage(db, sessionId, "tool_use", { a: 1 });
			claimMessages(db, sessionId, 1);

			// Manually set claimed_at to old timestamp
			const oldTime = Date.now() - 120000; // 2 minutes ago
			db.run(
				"UPDATE pending_messages SET claimed_at_epoch = ? WHERE id = ?",
				[oldTime, msg.id]
			);

			const released = cleanupStaleClaims(db, 60000); // 1 minute timeout

			expect(released).toBe(1);
			expect(getPendingCount(db, sessionId)).toBe(1);
		});
	});

	describe("Utility Functions", () => {
		test("hasPendingMessages returns true when messages exist", () => {
			expect(hasPendingMessages(db, sessionId)).toBe(false);

			enqueueMessage(db, sessionId, "tool_use", { a: 1 });

			expect(hasPendingMessages(db, sessionId)).toBe(true);
		});

		test("parsePayload parses JSON payload", () => {
			const msg = enqueueMessage(db, sessionId, "tool_use", {
				tool_name: "Read",
				file: "test.ts",
			});

			const payload = parsePayload<{ tool_name: string; file: string }>(msg);

			expect(payload.tool_name).toBe("Read");
			expect(payload.file).toBe("test.ts");
		});
	});
});
