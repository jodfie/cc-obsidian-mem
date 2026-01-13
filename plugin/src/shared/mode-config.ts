/**
 * Mode Configuration System
 * Provides pluggable observation types and concepts for the SDK agent
 */

import type {
	ModeConfig,
	ObservationTypeConfig,
	ConceptConfig,
	ModePrompts,
} from "./types.js";

// ============================================================================
// Default Observation Types
// ============================================================================

export const DEFAULT_OBSERVATION_TYPES: ObservationTypeConfig[] = [
	{
		id: "decision",
		label: "Decision",
		description: "An architectural or technical decision made during the session",
		emoji: "🎯",
	},
	{
		id: "bugfix",
		label: "Bug Fix",
		description: "A bug that was identified and fixed",
		emoji: "🐛",
	},
	{
		id: "feature",
		label: "Feature",
		description: "A new feature or functionality added",
		emoji: "✨",
	},
	{
		id: "refactor",
		label: "Refactor",
		description: "Code restructuring without changing behavior",
		emoji: "♻️",
	},
	{
		id: "discovery",
		label: "Discovery",
		description: "Something learned about the codebase or domain",
		emoji: "💡",
	},
	{
		id: "change",
		label: "Change",
		description: "A general modification to the codebase",
		emoji: "📝",
	},
	{
		id: "error",
		label: "Error",
		description: "An error encountered and potentially resolved",
		emoji: "❌",
	},
	{
		id: "pattern",
		label: "Pattern",
		description: "A reusable pattern or convention identified",
		emoji: "🔄",
	},
];

// ============================================================================
// Default Concepts
// ============================================================================

export const DEFAULT_CONCEPTS: ConceptConfig[] = [
	{ id: "architecture", label: "Architecture", description: "System design and structure" },
	{ id: "api", label: "API", description: "Interface design and contracts" },
	{ id: "database", label: "Database", description: "Data storage and queries" },
	{ id: "security", label: "Security", description: "Authentication, authorization, vulnerabilities" },
	{ id: "performance", label: "Performance", description: "Speed and optimization" },
	{ id: "testing", label: "Testing", description: "Test coverage and quality" },
	{ id: "documentation", label: "Documentation", description: "Code docs and comments" },
	{ id: "deployment", label: "Deployment", description: "CI/CD and infrastructure" },
	{ id: "error-handling", label: "Error Handling", description: "Exception and error management" },
	{ id: "configuration", label: "Configuration", description: "Settings and environment" },
];

// ============================================================================
// Default Prompts
// ============================================================================

export const DEFAULT_PROMPTS: ModePrompts = {
	system_identity: `You are a memory observation agent for a Claude Code session. Your role is to observe tool interactions and extract structured knowledge that will be valuable for future sessions.`,

	observer_role: `As an observer, you:
- Watch tool interactions without interfering
- Extract meaningful observations from each interaction
- Focus on decisions, discoveries, patterns, and errors
- Create concise but complete summaries`,

	spatial_awareness: `You are observing a coding session in a specific project directory. Pay attention to:
- File paths and their relationships
- Project structure and conventions
- Dependencies and configurations`,

	recording_focus: `Focus on recording:
- Technical decisions and their rationale
- Bugs found and how they were fixed
- New features implemented
- Code patterns discovered
- Errors encountered and solutions`,

	skip_guidance: `Skip recording:
- Trivial file reads with no insights
- Repeated similar operations
- Debugging steps that didn't lead to discoveries
- Temporary or experimental changes`,

	output_format_header: `Output your observations in this XML format:`,

	type_guidance: `Choose the type that best describes the nature of the observation`,

	field_guidance: `Facts should be specific, actionable points. Narrative should provide context.`,

	concept_guidance: `Choose 1-3 concepts that this observation relates to`,

	format_examples: `
Example observation:
\`\`\`xml
<observation>
  <type>decision</type>
  <title>Use SQLite for session storage</title>
  <subtitle>Replacing JSON file-based storage</subtitle>
  <facts>
    <fact>SQLite provides ACID guarantees for session data</fact>
    <fact>WAL mode enables concurrent read/write</fact>
    <fact>FTS5 enables full-text search on observations</fact>
  </facts>
  <narrative>The decision to use SQLite was driven by the need for reliable session storage with search capabilities. JSON files were prone to corruption during concurrent access.</narrative>
  <concepts>
    <concept>database</concept>
    <concept>architecture</concept>
  </concepts>
  <files_read>
    <file>src/shared/config.ts</file>
  </files_read>
  <files_modified>
    <file>src/sqlite/migrations.ts</file>
  </files_modified>
</observation>
\`\`\``,

	footer: `Remember: Only record observations that would be valuable in future sessions. Quality over quantity.`,

	header_memory_start: `--- MEMORY SESSION STARTED ---
Begin observing and recording valuable insights.`,

	header_memory_continued: `--- MEMORY SESSION CONTINUED ---
Resume observing from where we left off.`,

	continuation_greeting: `Welcome back to the observation session.`,

	continuation_instruction: `Continue recording observations for this ongoing session. Review previous context and maintain consistency.`,

	header_summary_checkpoint: `--- SUMMARY CHECKPOINT ---`,

	summary_instruction: `Generate a summary of the session progress so far. Focus on what was requested, investigated, learned, and completed.`,

	summary_context_label: `Last assistant response for context:`,

	summary_format_instruction: `Output your summary in this XML format:`,

	summary_footer: `The summary should help future sessions understand what was accomplished.`,

	xml_title_placeholder: "Brief title describing the observation",
	xml_subtitle_placeholder: "Optional subtitle with additional context",
	xml_fact_placeholder: "A specific, actionable fact",
	xml_narrative_placeholder: "Contextual narrative explaining the observation",
	xml_concept_placeholder: "Related concept from the concept list",
	xml_file_placeholder: "Path to file read or modified",
	xml_summary_request_placeholder: "What was the user trying to accomplish?",
	xml_summary_investigated_placeholder: "What was explored or researched?",
	xml_summary_learned_placeholder: "What insights were gained?",
	xml_summary_completed_placeholder: "What was actually done?",
	xml_summary_next_steps_placeholder: "What remains to be done?",
	xml_summary_notes_placeholder: "Any additional notes or caveats",
};

// ============================================================================
// Default Mode Configuration
// ============================================================================

export const DEFAULT_MODE: ModeConfig = {
	id: "default",
	name: "Default Mode",
	description: "General-purpose observation mode for coding sessions",
	observation_types: DEFAULT_OBSERVATION_TYPES,
	observation_concepts: DEFAULT_CONCEPTS,
	prompts: DEFAULT_PROMPTS,
};

// ============================================================================
// Mode Loader
// ============================================================================

/**
 * Load mode configuration
 * Currently returns default mode; can be extended to load custom modes from config
 */
export function loadModeConfig(modeId?: string): ModeConfig {
	// For now, always return default mode
	// Future: Load custom modes from ~/.cc-obsidian-mem/modes/{modeId}.json
	return DEFAULT_MODE;
}

/**
 * Get observation type by ID
 */
export function getObservationType(
	mode: ModeConfig,
	typeId: string
): ObservationTypeConfig | undefined {
	return mode.observation_types.find((t) => t.id === typeId);
}

/**
 * Get concept by ID
 */
export function getConcept(mode: ModeConfig, conceptId: string): ConceptConfig | undefined {
	return mode.observation_concepts.find((c) => c.id === conceptId);
}

/**
 * Build the init prompt for the SDK agent
 */
export function buildInitPrompt(
	project: string,
	sessionId: string,
	userPrompt: string,
	mode: ModeConfig
): string {
	return `${mode.prompts.system_identity}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split("T")[0]}</requested_at>
  <project>${project}</project>
  <session_id>${sessionId}</session_id>
</observed_from_primary_session>

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map((t) => t.id).join(" | ")} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

/**
 * Build observation prompt from tool use data
 */
export function buildObservationPrompt(obs: {
	tool_name: string;
	tool_input: string;
	tool_output: string;
	created_at_epoch: number;
	cwd?: string;
}): string {
	let toolInput: unknown;
	let toolOutput: unknown;

	try {
		toolInput = JSON.parse(obs.tool_input);
	} catch {
		toolInput = obs.tool_input;
	}

	try {
		toolOutput = JSON.parse(obs.tool_output);
	} catch {
		toolOutput = obs.tool_output;
	}

	return `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ""}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>`;
}

/**
 * Build summary prompt
 */
export function buildSummaryPrompt(
	lastAssistantMessage: string,
	mode: ModeConfig
): string {
	return `${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${lastAssistantMessage}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

${mode.prompts.summary_footer}`;
}

/**
 * Build observation format instructions (used by agent to remind Claude of the XML format)
 */
export function buildObservationFormatInstructions(mode: ModeConfig): string {
	return `${mode.prompts.observer_role}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map((t) => t.id).join(" | ")} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`

${mode.prompts.footer}

If there is nothing worth recording from this tool interaction, output <skip/> instead.`;
}

/**
 * Build continuation prompt for resumed sessions
 */
export function buildContinuationPrompt(
	userPrompt: string,
	promptNumber: number,
	sessionId: string,
	mode: ModeConfig
): string {
	return `${mode.prompts.continuation_greeting}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split("T")[0]}</requested_at>
  <prompt_number>${promptNumber}</prompt_number>
  <session_id>${sessionId}</session_id>
</observed_from_primary_session>

${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.continuation_instruction}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map((t) => t.id).join(" | ")} ]</type>
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`

${mode.prompts.footer}

${mode.prompts.header_memory_continued}`;
}
