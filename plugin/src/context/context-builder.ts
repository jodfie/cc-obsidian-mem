/**
 * Context Builder
 * Generates memory context to inject before each user prompt
 */

import type { Database } from "bun:sqlite";
import type { Observation, SessionSummary, ContextConfig, TokenEconomics } from "../shared/types.js";
import { getProjectObservations, parseObservationFields } from "../sqlite/observations-store.js";
import { retryWithBackoff } from "../shared/database-utils.js";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: ContextConfig = {
	observationCount: 20, // Recent observations to include
	sessionCount: 5, // Recent session summaries to include
	fullObservationCount: 5, // Observations to show in full detail
	maxTokens: 4000, // Rough token limit for context
};

// ============================================================================
// Data Retrieval
// ============================================================================

/**
 * Query recent observations for a project
 */
export function queryObservations(
	db: Database,
	project: string,
	config: ContextConfig = DEFAULT_CONFIG
): Observation[] {
	return getProjectObservations(db, project, config.observationCount);
}

/**
 * Query recent session summaries for a project
 */
export function querySummaries(
	db: Database,
	project: string,
	config: ContextConfig = DEFAULT_CONFIG
): SessionSummary[] {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM session_summaries
			WHERE project = ?
			ORDER BY created_at_epoch DESC
			LIMIT ?
		`);
		return stmt.all(project, config.sessionCount) as SessionSummary[];
	});
}

// ============================================================================
// Token Economics
// ============================================================================

/**
 * Estimate token count (rough approximation: 4 chars = 1 token)
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Calculate token economics for observations
 */
export function calculateTokenEconomics(observations: Observation[]): TokenEconomics {
	let totalChars = 0;
	for (const obs of observations) {
		totalChars += obs.title.length;
		totalChars += (obs.subtitle?.length || 0);
		totalChars += (obs.narrative?.length || 0);
		totalChars += (obs.facts?.length || 0);
	}

	return {
		totalObservations: observations.length,
		estimatedTokens: Math.ceil(totalChars / 4),
		truncated: false,
	};
}

// ============================================================================
// Context Rendering
// ============================================================================

/**
 * Render a single observation as markdown
 */
function renderObservation(obs: Observation, full: boolean = false): string {
	const emoji = getTypeEmoji(obs.type);
	const fields = parseObservationFields(obs);

	if (full) {
		let content = `### ${emoji} ${obs.title}\n`;
		if (obs.subtitle) {
			content += `*${obs.subtitle}*\n`;
		}
		if (obs.narrative) {
			content += `\n${obs.narrative}\n`;
		}
		if (fields.facts.length > 0) {
			content += `\n**Facts:**\n`;
			for (const fact of fields.facts) {
				content += `- ${fact}\n`;
			}
		}
		if (fields.concepts.length > 0) {
			content += `\n**Concepts:** ${fields.concepts.join(", ")}\n`;
		}
		return content;
	}

	// Compact format
	return `- ${emoji} **${obs.title}**${obs.subtitle ? `: ${obs.subtitle}` : ""}`;
}

/**
 * Get emoji for observation type
 */
function getTypeEmoji(type: string): string {
	const emojis: Record<string, string> = {
		decision: "🎯",
		bugfix: "🐛",
		feature: "✨",
		refactor: "♻️",
		discovery: "💡",
		change: "📝",
		error: "❌",
		pattern: "🔄",
	};
	return emojis[type] || "📌";
}

/**
 * Render session summary as markdown
 */
function renderSummary(summary: SessionSummary): string {
	let content = `#### Session Summary\n`;

	if (summary.request) {
		content += `**Request:** ${summary.request}\n`;
	}
	if (summary.completed) {
		content += `**Completed:** ${summary.completed}\n`;
	}
	if (summary.learned) {
		content += `**Learned:** ${summary.learned}\n`;
	}
	if (summary.next_steps) {
		content += `**Next:** ${summary.next_steps}\n`;
	}

	return content;
}

// ============================================================================
// Main Context Generation
// ============================================================================

/**
 * Generate context for injection before a prompt
 */
export function generateContext(
	db: Database,
	project: string,
	sessionId?: string,
	config: ContextConfig = DEFAULT_CONFIG
): string {
	const observations = queryObservations(db, project, config);
	const summaries = querySummaries(db, project, config);

	// Empty state
	if (observations.length === 0 && summaries.length === 0) {
		return renderEmptyState(project);
	}

	const output: string[] = [];

	// Header
	output.push(`<!-- Memory context for ${project} -->`);
	output.push("");

	// Recent observations section
	if (observations.length > 0) {
		output.push("## Recent Observations");
		output.push("");

		// Render top observations in full
		const fullObs = observations.slice(0, config.fullObservationCount);
		for (const obs of fullObs) {
			output.push(renderObservation(obs, true));
			output.push("");
		}

		// Render rest as compact list
		if (observations.length > config.fullObservationCount) {
			output.push("### More Observations");
			for (const obs of observations.slice(config.fullObservationCount)) {
				output.push(renderObservation(obs, false));
			}
			output.push("");
		}
	}

	// Recent summaries section
	if (summaries.length > 0) {
		output.push("## Session History");
		output.push("");

		const recentSummary = summaries[0];
		output.push(renderSummary(recentSummary));
		output.push("");

		if (summaries.length > 1) {
			output.push(`*${summaries.length - 1} more previous sessions available*`);
			output.push("");
		}
	}

	// Footer
	output.push("---");
	output.push("*Use `mem_search` for detailed notes on any topic.*");

	return output.join("\n");
}

/**
 * Render empty state when no memory exists
 */
function renderEmptyState(project: string): string {
	return `<!-- Memory context for ${project} -->

## No Memory Yet

This is a new project with no recorded observations.
Memory will be populated as you work.

---
*Use \`mem_search\` to search existing knowledge.*`;
}

// ============================================================================
// Compact Context (for token-limited scenarios)
// ============================================================================

/**
 * Generate a more compact context for token-limited scenarios
 */
export function generateCompactContext(
	db: Database,
	project: string,
	maxObservations: number = 10
): string {
	const observations = getProjectObservations(db, project, maxObservations);

	if (observations.length === 0) {
		return `<!-- No memory for ${project} -->`;
	}

	const output: string[] = [];
	output.push(`<!-- Memory: ${project} -->`);
	output.push("");

	for (const obs of observations) {
		const emoji = getTypeEmoji(obs.type);
		output.push(`- ${emoji} ${obs.title}`);
	}

	return output.join("\n");
}

// ============================================================================
// Context for Specific Types
// ============================================================================

/**
 * Generate context for errors only
 */
export function generateErrorContext(db: Database, project: string): string {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM observations
			WHERE project = ? AND type IN ('error', 'bugfix')
			ORDER BY created_at_epoch DESC
			LIMIT 10
		`);
		const observations = stmt.all(project) as Observation[];

		if (observations.length === 0) {
			return "";
		}

		const output: string[] = ["## Known Issues"];
		for (const obs of observations) {
			output.push(`- **${obs.title}**${obs.subtitle ? `: ${obs.subtitle}` : ""}`);
		}

		return output.join("\n");
	});
}

/**
 * Generate context for decisions only
 */
export function generateDecisionContext(db: Database, project: string): string {
	return retryWithBackoff(() => {
		const stmt = db.prepare(`
			SELECT * FROM observations
			WHERE project = ? AND type = 'decision'
			ORDER BY created_at_epoch DESC
			LIMIT 10
		`);
		const observations = stmt.all(project) as Observation[];

		if (observations.length === 0) {
			return "";
		}

		const output: string[] = ["## Active Decisions"];
		for (const obs of observations) {
			const fields = parseObservationFields(obs);
			output.push(`- **${obs.title}**`);
			if (fields.facts.length > 0) {
				output.push(`  - ${fields.facts[0]}`);
			}
		}

		return output.join("\n");
	});
}
