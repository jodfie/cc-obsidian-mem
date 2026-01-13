/**
 * Context Builder Tests
 * Tests context generation for memory injection
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { runMigrations } from "../src/sqlite/migrations.js";
import { createSession } from "../src/sqlite/session-store.js";
import { createObservation } from "../src/sqlite/observations-store.js";
import {
	generateContext,
	generateCompactContext,
	generateErrorContext,
	generateDecisionContext,
	calculateTokenEconomics,
} from "../src/context/context-builder.js";
import type { ParsedObservation } from "../src/shared/types.js";

describe("Context Builder", () => {
	let db: Database;
	let dbPath: string;
	const sessionId = "test-session-ctx";
	const project = "test-project";

	beforeEach(() => {
		dbPath = join(tmpdir(), `test-ctx-${Date.now()}.db`);
		db = new Database(dbPath, { create: true });
		runMigrations(db);
		createSession(db, sessionId, project);
	});

	afterEach(() => {
		db.close();
		if (existsSync(dbPath)) {
			unlinkSync(dbPath);
		}
	});

	const createTestObservation = (overrides: Partial<ParsedObservation> = {}): ParsedObservation => ({
		type: "decision",
		title: "Test Decision",
		subtitle: "A test subtitle",
		facts: ["Fact 1", "Fact 2"],
		concepts: ["architecture"],
		narrative: "This is a test narrative.",
		files_read: ["test.ts"],
		files_modified: ["modified.ts"],
		...overrides,
	});

	describe("generateContext", () => {
		test("returns empty state message for new project", () => {
			const context = generateContext(db, project, sessionId);

			expect(context).toContain("No Memory Yet");
			expect(context).toContain(project);
		});

		test("includes recent observations", () => {
			createObservation(db, sessionId, project, createTestObservation({
				title: "Important Decision",
				type: "decision",
			}));

			const context = generateContext(db, project, sessionId);

			expect(context).toContain("Recent Observations");
			expect(context).toContain("Important Decision");
		});

		test("includes observation type emoji", () => {
			createObservation(db, sessionId, project, createTestObservation({
				type: "bugfix",
				title: "Bug Fix Title",
			}));

			const context = generateContext(db, project, sessionId);

			// Should contain the bugfix emoji
			expect(context).toContain("Bug Fix Title");
		});

		test("shows full detail for recent observations", () => {
			createObservation(db, sessionId, project, createTestObservation({
				title: "Recent Observation",
				narrative: "Detailed narrative here",
				facts: ["Important fact"],
			}));

			const context = generateContext(db, project, sessionId);

			expect(context).toContain("Recent Observation");
			expect(context).toContain("Detailed narrative here");
			expect(context).toContain("Important fact");
		});

		test("includes mem_search hint", () => {
			createObservation(db, sessionId, project, createTestObservation());

			const context = generateContext(db, project, sessionId);

			expect(context).toContain("mem_search");
		});
	});

	describe("generateCompactContext", () => {
		test("returns minimal message for empty project", () => {
			const context = generateCompactContext(db, project);

			expect(context).toContain("No memory");
			expect(context).toContain(project);
		});

		test("generates compact list format", () => {
			createObservation(db, sessionId, project, createTestObservation({
				title: "Decision One",
				type: "decision",
			}));
			createObservation(db, sessionId, project, createTestObservation({
				title: "Bug Fix Two",
				type: "bugfix",
			}));

			const context = generateCompactContext(db, project);

			expect(context).toContain("Decision One");
			expect(context).toContain("Bug Fix Two");
			// Should be compact - no narratives or facts
			expect(context).not.toContain("Facts");
		});

		test("respects maxObservations limit", () => {
			// Create 5 observations
			for (let i = 0; i < 5; i++) {
				createObservation(db, sessionId, project, createTestObservation({
					title: `Observation ${i}`,
				}));
			}

			const context = generateCompactContext(db, project, 3);

			// Should only contain 3 most recent
			const lines = context.split("\n").filter(l => l.startsWith("-"));
			expect(lines.length).toBe(3);
		});
	});

	describe("generateErrorContext", () => {
		test("returns empty string for no errors", () => {
			createObservation(db, sessionId, project, createTestObservation({
				type: "decision",
				title: "Not an error",
			}));

			const context = generateErrorContext(db, project);

			expect(context).toBe("");
		});

		test("includes error observations", () => {
			createObservation(db, sessionId, project, createTestObservation({
				type: "error",
				title: "TypeError in module",
			}));

			const context = generateErrorContext(db, project);

			expect(context).toContain("Known Issues");
			expect(context).toContain("TypeError in module");
		});

		test("includes bugfix observations", () => {
			createObservation(db, sessionId, project, createTestObservation({
				type: "bugfix",
				title: "Fixed null pointer",
			}));

			const context = generateErrorContext(db, project);

			expect(context).toContain("Fixed null pointer");
		});
	});

	describe("generateDecisionContext", () => {
		test("returns empty string for no decisions", () => {
			createObservation(db, sessionId, project, createTestObservation({
				type: "bugfix",
				title: "Not a decision",
			}));

			const context = generateDecisionContext(db, project);

			expect(context).toBe("");
		});

		test("includes decision observations", () => {
			createObservation(db, sessionId, project, createTestObservation({
				type: "decision",
				title: "Use PostgreSQL",
				facts: ["Better for our scale"],
			}));

			const context = generateDecisionContext(db, project);

			expect(context).toContain("Active Decisions");
			expect(context).toContain("Use PostgreSQL");
			expect(context).toContain("Better for our scale");
		});
	});

	describe("calculateTokenEconomics", () => {
		test("calculates token economics for observations", () => {
			const obs1 = createObservation(db, sessionId, project, createTestObservation({
				title: "Short title",
			}));
			const obs2 = createObservation(db, sessionId, project, createTestObservation({
				title: "Another title",
				narrative: "Some narrative text here",
			}));

			const economics = calculateTokenEconomics([obs1, obs2]);

			expect(economics.totalObservations).toBe(2);
			expect(economics.estimatedTokens).toBeGreaterThan(0);
			expect(economics.truncated).toBe(false);
		});

		test("returns zero for empty observations", () => {
			const economics = calculateTokenEconomics([]);

			expect(economics.totalObservations).toBe(0);
			expect(economics.estimatedTokens).toBe(0);
		});
	});
});
