/**
 * XML Parser for SDK Agent Responses
 * Parses observation and summary XML from Claude responses
 */

import type { ParsedObservation, ObservationType } from "../shared/types.js";

// ============================================================================
// Observation Parsing
// ============================================================================

/**
 * Parse observations from Claude response text
 * Returns array of parsed observations
 */
export function parseObservations(
	responseText: string,
	defaultType: ObservationType = "discovery"
): ParsedObservation[] {
	const observations: ParsedObservation[] = [];

	// Match all <observation>...</observation> blocks
	const observationRegex = /<observation>([\s\S]*?)<\/observation>/gi;
	let match: RegExpExecArray | null;

	while ((match = observationRegex.exec(responseText)) !== null) {
		const content = match[1];
		const parsed = parseObservationBlock(content, defaultType);
		if (parsed) {
			observations.push(parsed);
		}
	}

	return observations;
}

/**
 * Parse a single observation block
 */
function parseObservationBlock(
	content: string,
	defaultType: ObservationType
): ParsedObservation | null {
	// Extract type
	const typeMatch = content.match(/<type>\s*([\w-]+)\s*<\/type>/i);
	const type = (typeMatch?.[1]?.trim() as ObservationType) || defaultType;

	// Validate type
	const validTypes: ObservationType[] = [
		"decision",
		"bugfix",
		"feature",
		"refactor",
		"discovery",
		"change",
		"error",
		"pattern",
	];
	if (!validTypes.includes(type)) {
		// Use default if invalid
	}

	// Extract title (required)
	const titleMatch = content.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
	const title = titleMatch?.[1]?.trim();
	if (!title) {
		return null; // Title is required
	}

	// Extract subtitle (optional)
	const subtitleMatch = content.match(/<subtitle>\s*([\s\S]*?)\s*<\/subtitle>/i);
	const subtitle = subtitleMatch?.[1]?.trim() || undefined;

	// Extract facts
	const facts = extractListItems(content, "facts", "fact");

	// Extract concepts
	const concepts = extractListItems(content, "concepts", "concept");

	// Extract narrative (optional)
	const narrativeMatch = content.match(/<narrative>\s*([\s\S]*?)\s*<\/narrative>/i);
	const narrative = narrativeMatch?.[1]?.trim() || undefined;

	// Extract files_read
	const filesRead = extractListItems(content, "files_read", "file");

	// Extract files_modified
	const filesModified = extractListItems(content, "files_modified", "file");

	return {
		type: validTypes.includes(type) ? type : defaultType,
		title,
		subtitle,
		facts,
		concepts,
		narrative,
		files_read: filesRead,
		files_modified: filesModified,
	};
}

/**
 * Extract list items from XML structure
 */
function extractListItems(content: string, containerTag: string, itemTag: string): string[] {
	const containerRegex = new RegExp(`<${containerTag}>([\\s\\S]*?)<\\/${containerTag}>`, "i");
	const containerMatch = content.match(containerRegex);
	if (!containerMatch) return [];

	const containerContent = containerMatch[1];
	const itemRegex = new RegExp(`<${itemTag}>\\s*([\\s\\S]*?)\\s*<\\/${itemTag}>`, "gi");
	const items: string[] = [];

	let itemMatch: RegExpExecArray | null;
	while ((itemMatch = itemRegex.exec(containerContent)) !== null) {
		const item = itemMatch[1].trim();
		if (item && !isPlaceholder(item)) {
			items.push(item);
		}
	}

	return items;
}

/**
 * Check if text is a placeholder
 */
function isPlaceholder(text: string): boolean {
	const placeholderPatterns = [
		/^brief title/i,
		/^optional subtitle/i,
		/^a specific/i,
		/^contextual narrative/i,
		/^related concept/i,
		/^path to file/i,
		/placeholder/i,
	];
	return placeholderPatterns.some((pattern) => pattern.test(text));
}

// ============================================================================
// Summary Parsing
// ============================================================================

export interface ParsedSummary {
	request: string | null;
	investigated: string | null;
	learned: string | null;
	completed: string | null;
	next_steps: string | null;
	notes: string | null;
	skip: boolean;
}

/**
 * Parse summary from Claude response text
 */
export function parseSummary(responseText: string): ParsedSummary {
	// Check for skip_summary tag
	if (/<skip_summary\s*\/?>/.test(responseText)) {
		return {
			request: null,
			investigated: null,
			learned: null,
			completed: null,
			next_steps: null,
			notes: null,
			skip: true,
		};
	}

	// Match <summary>...</summary> block
	const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/i);
	if (!summaryMatch) {
		return {
			request: null,
			investigated: null,
			learned: null,
			completed: null,
			next_steps: null,
			notes: null,
			skip: false,
		};
	}

	const content = summaryMatch[1];

	return {
		request: extractSummaryField(content, "request"),
		investigated: extractSummaryField(content, "investigated"),
		learned: extractSummaryField(content, "learned"),
		completed: extractSummaryField(content, "completed"),
		next_steps: extractSummaryField(content, "next_steps"),
		notes: extractSummaryField(content, "notes"),
		skip: false,
	};
}

/**
 * Extract a field from summary content
 */
function extractSummaryField(content: string, field: string): string | null {
	const regex = new RegExp(`<${field}>\\s*([\\s\\S]*?)\\s*<\\/${field}>`, "i");
	const match = content.match(regex);
	const value = match?.[1]?.trim();

	// Skip placeholder values
	if (!value || isPlaceholder(value)) {
		return null;
	}

	return value;
}

// ============================================================================
// Response Analysis
// ============================================================================

/**
 * Check if response contains any observations
 */
export function hasObservations(responseText: string): boolean {
	return /<observation>/i.test(responseText);
}

/**
 * Check if response contains a summary
 */
export function hasSummary(responseText: string): boolean {
	return /<summary>/i.test(responseText);
}

/**
 * Check if response indicates skipping
 */
export function hasSkipIndicator(responseText: string): boolean {
	return /<skip_summary\s*\/?>/.test(responseText) || /<skip\s*\/?>/.test(responseText);
}

/**
 * Extract the last assistant message for context
 */
export function extractLastAssistantMessage(
	messages: Array<{ role: string; content: string }>
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			return messages[i].content;
		}
	}
	return null;
}
