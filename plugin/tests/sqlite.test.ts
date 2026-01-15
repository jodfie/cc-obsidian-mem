/**
 * SQLite layer tests
 * Tests database initialization, session operations, and data handling
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "../src/sqlite/migrations.js";
import {
	createSession,
	getSession,
	updateSessionStatus,
	addUserPrompt,
	getSessionPrompts,
	addToolUse,
	getSessionToolUses,
	addFileRead,
	getSessionFileReads,
	deleteSession,
} from "../src/sqlite/session-store.js";
import { createLogger } from "../src/shared/logger.js";
import { safeUnlink } from "./test-utils.js";

describe("SQLite Database", () => {
	let db: Database;
	let dbPath: string;
	const logger = createLogger({ verbose: false });

	beforeEach(() => {
		dbPath = join(tmpdir(), `test-${Date.now()}.db`);
		db = new Database(dbPath, { create: true });
		runMigrations(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// Ignore close errors
		}
		safeUnlink(dbPath);
	});

	describe("Session Operations", () => {
		test("creates a session", () => {
			const session = createSession(db, "test-session-1", "test-project");

			expect(session).toBeDefined();
			expect(session.session_id).toBe("test-session-1");
			expect(session.project).toBe("test-project");
			expect(session.status).toBe("active");
		});

		test("retrieves a session by ID", () => {
			createSession(db, "test-session-2", "test-project");
			const session = getSession(db, "test-session-2");

			expect(session).not.toBeNull();
			expect(session?.session_id).toBe("test-session-2");
		});

		test("returns null for non-existent session", () => {
			const session = getSession(db, "non-existent");
			expect(session).toBeNull();
		});

		test("updates session status", () => {
			createSession(db, "test-session-3", "test-project");
			updateSessionStatus(db, "test-session-3", "completed");

			const session = getSession(db, "test-session-3");
			expect(session?.status).toBe("completed");
			expect(session?.completed_at).toBeDefined();
		});

		test("deletes session and cascades", () => {
			createSession(db, "test-session-4", "test-project");
			addUserPrompt(db, "test-session-4", 1, "Test prompt");
			deleteSession(db, "test-session-4");

			const session = getSession(db, "test-session-4");
			expect(session).toBeNull();

			// Prompts should be cascade deleted
			const prompts = getSessionPrompts(db, "test-session-4");
			expect(prompts).toHaveLength(0);
		});
	});

	describe("User Prompt Operations", () => {
		test("adds user prompt", () => {
			createSession(db, "test-session-5", "test-project");
			addUserPrompt(db, "test-session-5", 1, "First prompt");
			addUserPrompt(db, "test-session-5", 2, "Second prompt");

			const prompts = getSessionPrompts(db, "test-session-5");
			expect(prompts).toHaveLength(2);
			expect(prompts[0].prompt_text).toBe("First prompt");
			expect(prompts[1].prompt_text).toBe("Second prompt");
		});
	});

	describe("Tool Use Operations", () => {
		test("adds tool use with truncation", () => {
			createSession(db, "test-session-6", "test-project");

			const longOutput = "x".repeat(200 * 1024); // 200KB
			addToolUse(
				db,
				"test-session-6",
				1,
				"Read",
				'{"file_path": "test.ts"}',
				longOutput,
				100 * 1024, // 100KB max
				100,
				"/test"
			);

			const toolUses = getSessionToolUses(db, "test-session-6");
			expect(toolUses).toHaveLength(1);
			expect(toolUses[0].tool_output_truncated).toBe(1);
			expect(toolUses[0].tool_output.length).toBeLessThan(longOutput.length);
		});

		test("redacts sensitive data", () => {
			createSession(db, "test-session-7", "test-project");

			addToolUse(
				db,
				"test-session-7",
				1,
				"Bash",
				'{"command": "export API_KEY=sk-secret123456789012345"}',
				"Command executed",
				100 * 1024,
				50
			);

			const toolUses = getSessionToolUses(db, "test-session-7");
			expect(toolUses[0].tool_input).toContain("[REDACTED]");
		});
	});

	describe("File Read Operations", () => {
		test("adds file read with deduplication", () => {
			createSession(db, "test-session-8", "test-project");

			// Add same file twice
			addFileRead(db, "test-session-8", "/test/file.ts", "content1", 5);
			addFileRead(db, "test-session-8", "/test/file.ts", "content1", 5);

			const reads = getSessionFileReads(db, "test-session-8");
			expect(reads).toHaveLength(1); // Deduplicated
		});

		test("enforces max reads per file", () => {
			createSession(db, "test-session-9", "test-project");

			// Add multiple reads of same file with different content
			for (let i = 0; i < 10; i++) {
				addFileRead(db, "test-session-9", "/test/file.ts", `content-${i}`, 3);
			}

			const reads = getSessionFileReads(db, "test-session-9");
			expect(reads.length).toBeLessThanOrEqual(3); // Max 3 per file
		});
	});
});
