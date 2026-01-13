/**
 * Observations Store
 * CRUD operations for structured observations extracted by SDK agent
 */

import type { Database } from "bun:sqlite";
import type { Observation, ParsedObservation, ObservationType } from "../shared/types.js";
import { retryWithBackoff } from "../shared/database-utils.js";

// ============================================================================
// Create Operations
// ============================================================================

/**
 * Create a new observation
 */
export function createObservation(
	db: Database,
	sessionId: string,
	project: string,
	observation: ParsedObservation
): Observation {
	return retryWithBackoff(() => {
		const now = new Date();
		const stmt = db.prepare(`
			INSERT INTO observations (
				session_id, project, type, title, subtitle,
				facts, concepts, narrative, files_read, files_modified,
				created_at, created_at_epoch
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const result = stmt.run(
			sessionId,
			project,
			observation.type,
			observation.title,
			observation.subtitle || null,
			JSON.stringify(observation.facts),
			JSON.stringify(observation.concepts),
			observation.narrative || null,
			JSON.stringify(observation.files_read),
			JSON.stringify(observation.files_modified),
			now.toISOString(),
			now.getTime()
		);

		return {
			id: Number(result.lastInsertRowid),
			session_id: sessionId,
			project,
			type: observation.type,
			title: observation.title,
			subtitle: observation.subtitle || null,
			facts: JSON.stringify(observation.facts),
			concepts: JSON.stringify(observation.concepts),
			narrative: observation.narrative || null,
			files_read: JSON.stringify(observation.files_read),
			files_modified: JSON.stringify(observation.files_modified),
			discovery_tokens: null,
			created_at: now.toISOString(),
			created_at_epoch: now.getTime(),
		};
	});
}

/**
 * Create multiple observations in a transaction
 */
export function createObservations(
	db: Database,
	sessionId: string,
	project: string,
	observations: ParsedObservation[]
): Observation[] {
	if (observations.length === 0) return [];

	return retryWithBackoff(() => {
		const results: Observation[] = [];
		const now = new Date();

		const stmt = db.prepare(`
			INSERT INTO observations (
				session_id, project, type, title, subtitle,
				facts, concepts, narrative, files_read, files_modified,
				created_at, created_at_epoch
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		db.run("BEGIN TRANSACTION");
		try {
			for (const obs of observations) {
				const result = stmt.run(
					sessionId,
					project,
					obs.type,
					obs.title,
					obs.subtitle || null,
					JSON.stringify(obs.facts),
					JSON.stringify(obs.concepts),
					obs.narrative || null,
					JSON.stringify(obs.files_read),
					JSON.stringify(obs.files_modified),
					now.toISOString(),
					now.getTime()
				);

				results.push({
					id: Number(result.lastInsertRowid),
					session_id: sessionId,
					project,
					type: obs.type,
					title: obs.title,
					subtitle: obs.subtitle || null,
					facts: JSON.stringify(obs.facts),
					concepts: JSON.stringify(obs.concepts),
					narrative: obs.narrative || null,
					files_read: JSON.stringify(obs.files_read),
					files_modified: JSON.stringify(obs.files_modified),
					discovery_tokens: null,
					created_at: now.toISOString(),
					created_at_epoch: now.getTime(),
				});
			}
			db.run("COMMIT");
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}

		return results;
	});
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get observation by ID
 */
export function getObservation(db: Database, id: number): Observation | null {
	return retryWithBackoff(() => {
		const stmt = db.prepare("SELECT * FROM observations WHERE id = ?");
		return (stmt.get(id) as Observation) || null;
	});
}

/**
 * Get all observations for a session
 */
export function getSessionObservations(db: Database, sessionId: string): Observation[] {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM observations
			WHERE session_id = ?
			ORDER BY created_at_epoch ASC
		`);
		return stmt.all(sessionId) as Observation[];
	});
}

/**
 * Get recent observations for a project
 */
export function getProjectObservations(
	db: Database,
	project: string,
	limit: number = 50
): Observation[] {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM observations
			WHERE project = ?
			ORDER BY created_at_epoch DESC
			LIMIT ?
		`);
		return stmt.all(project, limit) as Observation[];
	});
}

/**
 * Get observations by type
 */
export function getObservationsByType(
	db: Database,
	project: string,
	type: ObservationType,
	limit: number = 20
): Observation[] {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM observations
			WHERE project = ? AND type = ?
			ORDER BY created_at_epoch DESC
			LIMIT ?
		`);
		return stmt.all(project, type, limit) as Observation[];
	});
}

/**
 * Search observations using FTS5
 */
export function searchObservations(
	db: Database,
	query: string,
	project?: string,
	limit: number = 20
): Observation[] {
	return retryWithBackoff(() => {
		let sql = `
			SELECT o.* FROM observations o
			JOIN observations_fts fts ON o.id = fts.rowid
			WHERE observations_fts MATCH ?
		`;
		const params: (string | number)[] = [query];

		if (project) {
			sql += " AND o.project = ?";
			params.push(project);
		}

		sql += " ORDER BY o.created_at_epoch DESC LIMIT ?";
		params.push(limit);

		const stmt = db.prepare(sql);
		return stmt.all(...params) as Observation[];
	});
}

// ============================================================================
// Update Operations
// ============================================================================

/**
 * Update discovery tokens for an observation
 */
export function updateDiscoveryTokens(
	db: Database,
	id: number,
	tokens: number
): void {
	retryWithBackoff(() => {
		const stmt = db.prepare("UPDATE observations SET discovery_tokens = ? WHERE id = ?");
		stmt.run(tokens, id);
	});
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete observation by ID
 */
export function deleteObservation(db: Database, id: number): void {
	retryWithBackoff(() => {
		const stmt = db.prepare("DELETE FROM observations WHERE id = ?");
		stmt.run(id);
	});
}

/**
 * Delete all observations for a session
 */
export function deleteSessionObservations(db: Database, sessionId: string): number {
	return retryWithBackoff(() => {
		const stmt = db.prepare("DELETE FROM observations WHERE session_id = ?");
		const result = stmt.run(sessionId);
		return result.changes;
	});
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Safely parse JSON string or return empty array on failure
 */
function safeParseJsonArray(json: string | null): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		// Return empty array on parse failure to keep context rendering resilient
		return [];
	}
}

/**
 * Parse observation JSON fields
 * Returns empty arrays on parse failure to prevent context injection from breaking
 */
export function parseObservationFields(obs: Observation): {
	facts: string[];
	concepts: string[];
	files_read: string[];
	files_modified: string[];
} {
	return {
		facts: safeParseJsonArray(obs.facts),
		concepts: safeParseJsonArray(obs.concepts),
		files_read: safeParseJsonArray(obs.files_read),
		files_modified: safeParseJsonArray(obs.files_modified),
	};
}

/**
 * Count observations for a project
 */
export function countProjectObservations(db: Database, project: string): number {
	return retryWithBackoff(() => {
		const stmt = db.prepare("SELECT COUNT(*) as count FROM observations WHERE project = ?");
		const result = stmt.get(project) as { count: number };
		return result.count;
	});
}

/**
 * Get observation type distribution for a project
 */
export function getTypeDistribution(
	db: Database,
	project: string
): Record<ObservationType, number> {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT type, COUNT(*) as count
			FROM observations
			WHERE project = ?
			GROUP BY type
		`);
		const rows = stmt.all(project) as Array<{ type: ObservationType; count: number }>;

		const distribution: Record<string, number> = {};
		for (const row of rows) {
			distribution[row.type] = row.count;
		}
		return distribution as Record<ObservationType, number>;
	});
}
