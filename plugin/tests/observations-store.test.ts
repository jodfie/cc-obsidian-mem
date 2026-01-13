/**
 * Observations Store Tests
 * Tests CRUD operations for structured observations
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { runMigrations } from "../src/sqlite/migrations.js";
import { createSession } from "../src/sqlite/session-store.js";
import {
	createObservation,
	createObservations,
	getObservation,
	getSessionObservations,
	getProjectObservations,
	getObservationsByType,
	searchObservations,
	deleteObservation,
	deleteSessionObservations,
	parseObservationFields,
	countProjectObservations,
	getTypeDistribution,
} from "../src/sqlite/observations-store.js";
import type { ParsedObservation } from "../src/shared/types.js";

describe("Observations Store", () => {
	let db: Database;
	let dbPath: string;
	const sessionId = "test-session-obs";
	const project = "test-project";

	beforeEach(() => {
		dbPath = join(tmpdir(), `test-obs-${Date.now()}.db`);
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

	const sampleObservation: ParsedObservation = {
		type: "decision",
		title: "Use SQLite for storage",
		subtitle: "Replacing JSON files",
		facts: ["ACID guarantees", "FTS5 search", "WAL mode"],
		concepts: ["database", "architecture"],
		narrative: "SQLite provides better reliability than JSON files.",
		files_read: ["config.ts"],
		files_modified: ["database.ts", "migrations.ts"],
	};

	describe("Create Operations", () => {
		test("creates an observation", () => {
			const obs = createObservation(db, sessionId, project, sampleObservation);

			expect(obs.id).toBeGreaterThan(0);
			expect(obs.session_id).toBe(sessionId);
			expect(obs.project).toBe(project);
			expect(obs.type).toBe("decision");
			expect(obs.title).toBe("Use SQLite for storage");
		});

		test("creates multiple observations in transaction", () => {
			const observations: ParsedObservation[] = [
				{ ...sampleObservation, title: "First" },
				{ ...sampleObservation, title: "Second", type: "bugfix" },
				{ ...sampleObservation, title: "Third", type: "feature" },
			];

			const created = createObservations(db, sessionId, project, observations);

			expect(created).toHaveLength(3);
			expect(created[0].title).toBe("First");
			expect(created[1].title).toBe("Second");
			expect(created[2].title).toBe("Third");
		});
	});

	describe("Read Operations", () => {
		test("gets observation by ID", () => {
			const created = createObservation(db, sessionId, project, sampleObservation);

			const retrieved = getObservation(db, created.id);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.title).toBe(sampleObservation.title);
		});

		test("returns null for non-existent ID", () => {
			const obs = getObservation(db, 99999);
			expect(obs).toBeNull();
		});

		test("gets session observations", () => {
			createObservation(db, sessionId, project, sampleObservation);
			createObservation(db, sessionId, project, { ...sampleObservation, title: "Second" });

			const obs = getSessionObservations(db, sessionId);

			expect(obs).toHaveLength(2);
		});

		test("gets project observations", () => {
			createObservation(db, sessionId, project, sampleObservation);

			// Create second session with same project
			createSession(db, "session-2", project);
			createObservation(db, "session-2", project, {
				...sampleObservation,
				title: "From session 2",
			});

			const obs = getProjectObservations(db, project);

			expect(obs).toHaveLength(2);
		});

		test("gets observations by type", () => {
			createObservation(db, sessionId, project, { ...sampleObservation, type: "decision" });
			createObservation(db, sessionId, project, { ...sampleObservation, type: "bugfix" });
			createObservation(db, sessionId, project, { ...sampleObservation, type: "decision" });

			const decisions = getObservationsByType(db, project, "decision");

			expect(decisions).toHaveLength(2);
		});
	});

	describe("Search Operations", () => {
		test("searches observations using FTS5", () => {
			createObservation(db, sessionId, project, {
				type: "decision",
				title: "Migration strategy for PostgreSQL",
				facts: ["Uses PostgreSQL"],
				concepts: ["postgresql"],
				files_read: [],
				files_modified: [],
			});
			createObservation(db, sessionId, project, {
				type: "feature",
				title: "UI component design",
				facts: ["React components"],
				concepts: ["ui"],
				files_read: [],
				files_modified: [],
			});

			const results = searchObservations(db, "PostgreSQL");

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Migration strategy for PostgreSQL");
		});

		test("filters search by project", () => {
			createObservation(db, sessionId, project, sampleObservation);

			createSession(db, "session-other", "other-project");
			createObservation(db, "session-other", "other-project", {
				...sampleObservation,
				title: "Other project SQLite",
			});

			const results = searchObservations(db, "SQLite", project);

			expect(results).toHaveLength(1);
			expect(results[0].project).toBe(project);
		});
	});

	describe("Delete Operations", () => {
		test("deletes observation", () => {
			const obs = createObservation(db, sessionId, project, sampleObservation);

			deleteObservation(db, obs.id);

			expect(getObservation(db, obs.id)).toBeNull();
		});

		test("deletes all session observations", () => {
			createObservation(db, sessionId, project, sampleObservation);
			createObservation(db, sessionId, project, sampleObservation);
			createObservation(db, sessionId, project, sampleObservation);

			const deleted = deleteSessionObservations(db, sessionId);

			expect(deleted).toBe(3);
			expect(getSessionObservations(db, sessionId)).toHaveLength(0);
		});
	});

	describe("Utility Functions", () => {
		test("parses observation fields", () => {
			const obs = createObservation(db, sessionId, project, sampleObservation);

			const fields = parseObservationFields(obs);

			expect(fields.facts).toEqual(sampleObservation.facts);
			expect(fields.concepts).toEqual(sampleObservation.concepts);
			expect(fields.files_read).toEqual(sampleObservation.files_read);
			expect(fields.files_modified).toEqual(sampleObservation.files_modified);
		});

		test("counts project observations", () => {
			createObservation(db, sessionId, project, sampleObservation);
			createObservation(db, sessionId, project, sampleObservation);

			expect(countProjectObservations(db, project)).toBe(2);
		});

		test("gets type distribution", () => {
			createObservation(db, sessionId, project, { ...sampleObservation, type: "decision" });
			createObservation(db, sessionId, project, { ...sampleObservation, type: "decision" });
			createObservation(db, sessionId, project, { ...sampleObservation, type: "bugfix" });

			const dist = getTypeDistribution(db, project);

			expect(dist.decision).toBe(2);
			expect(dist.bugfix).toBe(1);
		});
	});
});
