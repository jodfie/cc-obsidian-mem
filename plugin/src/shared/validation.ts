/**
 * Input validation using Zod schemas
 * Prevents invalid data from entering the system
 */

import { z } from "zod";

// ============================================================================
// Hook Payload Schemas
// ============================================================================

// Claude Code sends snake_case fields, so we accept both formats
export const SessionStartPayloadSchema = z.object({
	session_id: z.string().min(1),
	cwd: z.string().min(1),
}).transform((data) => ({
	sessionId: data.session_id,
	cwd: data.cwd,
}));

// Claude Code does NOT send prompt_number - we track it internally per session
export const UserPromptSubmitPayloadSchema = z.object({
	session_id: z.string().min(1),
	prompt: z.string(),
}).transform((data) => ({
	sessionId: data.session_id,
	promptText: data.prompt,
}));

// Claude Code sends tool_input and tool_response as objects, not strings
// Also does NOT send prompt_number - we track it internally
export const PostToolUsePayloadSchema = z.object({
	session_id: z.string().min(1),
	tool_name: z.string().min(1),
	tool_input: z.unknown(), // Can be object or string
	tool_response: z.unknown(), // Can be object or string
	duration_ms: z.number().int().nonnegative().optional(),
	cwd: z.string().optional(),
}).transform((data) => ({
	sessionId: data.session_id,
	toolName: data.tool_name,
	// Stringify if object, keep as-is if already string
	toolInput: typeof data.tool_input === 'string'
		? data.tool_input
		: JSON.stringify(data.tool_input),
	toolOutput: typeof data.tool_response === 'string'
		? data.tool_response
		: JSON.stringify(data.tool_response),
	durationMs: data.duration_ms,
	cwd: data.cwd,
}));

export const StopPayloadSchema = z.object({
	session_id: z.string().min(1),
}).transform((data) => ({
	sessionId: data.session_id,
}));

// ============================================================================
// MCP Tool Argument Schemas
// ============================================================================

export const MemSearchArgsSchema = z.object({
	query: z.string().min(1),
	type: z.enum(["error", "decision", "pattern", "file", "learning", "knowledge"]).optional(),
	limit: z.number().int().positive().max(100).optional(),
});

export const MemReadArgsSchema = z.object({
	path: z.string().min(1),
	section: z.string().optional(),
});

export const MemWriteArgsSchema = z.object({
	type: z.enum(["error", "decision", "pattern", "file", "learning"]),
	title: z.string().min(1).max(200),
	content: z.string().min(1),
	project: z.string().min(1).max(100).optional(),
	tags: z.array(z.string()).optional(),
	status: z.enum(["active", "superseded", "draft"]).optional(),
});

export const MemSupersedeArgsSchema = z.object({
	oldNotePath: z.string().min(1),
	type: z.enum(["error", "decision", "pattern", "file", "learning"]),
	title: z.string().min(1).max(200),
	content: z.string().min(1),
	project: z.string().min(1).max(100).optional(),
	tags: z.array(z.string()).optional(),
});

export const MemProjectContextArgsSchema = z.object({
	project: z.string().min(1).max(100),
	includeErrors: z.boolean().optional(),
	includeDecisions: z.boolean().optional(),
	includePatterns: z.boolean().optional(),
	generateCanvas: z.boolean().optional(),
});

// ============================================================================
// Config Schema
// ============================================================================

export const ConfigSchema = z.object({
	vault: z.object({
		path: z.string().min(1),
		memFolder: z.string().min(1).optional(),
	}),
	sqlite: z.object({
		path: z.string().min(1).optional(),
		retention: z.object({
			sessions: z.number().int().positive().optional(),
			orphan_timeout_hours: z.number().int().positive().optional(),
			file_reads_per_file: z.number().int().positive().optional(),
		}).optional(),
		max_output_size: z.number().int().positive().optional(),
	}).optional(),
	logging: z.object({
		verbose: z.boolean().optional(),
		logDir: z.string().optional(),
	}).optional(),
	canvas: z.object({
		enabled: z.boolean().optional(),
		autoGenerate: z.boolean().optional(),
		updateStrategy: z.enum(["always", "skip"]).optional(),
	}).optional(),
	defaultProject: z.string().optional(),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate and parse data with a schema
 * Throws ZodError if validation fails
 * Works with both regular schemas and transforms
 */
export function validate<S extends z.ZodTypeAny>(
	schema: S,
	data: unknown
): z.output<S> {
	return schema.parse(data);
}

/**
 * Safely validate data, returning null if validation fails
 * Works with both regular schemas and transforms
 */
export function safeValidate<S extends z.ZodTypeAny>(
	schema: S,
	data: unknown
): z.output<S> | null {
	const result = schema.safeParse(data);
	return result.success ? result.data : null;
}
