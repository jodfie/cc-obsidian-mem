/**
 * Prompts for AI-powered knowledge extraction
 * Used by summarizer to extract structured knowledge from sessions
 */

export const KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction assistant. Your job is to analyze Claude Code session data and extract valuable, reusable knowledge.

Extract knowledge in these categories:
- **Decisions**: Technical or architectural decisions made
- **Patterns**: Reusable code patterns or conventions discovered
- **Errors**: Problems encountered and their solutions
- **Learnings**: Tips, insights, or gotchas learned
- **Q&A**: Important questions asked and answers found

For each piece of knowledge:
1. Make it concise but complete (2-5 sentences)
2. Focus on WHY, not just WHAT
3. Make it reusable for future similar situations
4. Include relevant context (what project, what problem)

Output as JSON with this structure:
{
  "decisions": [{ "title": "...", "content": "...", "tags": ["..."] }],
  "patterns": [{ "title": "...", "content": "...", "tags": ["..."] }],
  "errors": [{ "title": "...", "content": "...", "solution": "...", "tags": ["..."] }],
  "learnings": [{ "title": "...", "content": "...", "tags": ["..."] }],
  "qa": [{ "question": "...", "answer": "...", "tags": ["..."] }]
}

Only extract knowledge that would be useful in future sessions. Skip trivial changes, debugging steps, or temporary fixes.`;

/**
 * Build user prompt from session data
 */
export function buildSessionPrompt(sessionData: {
	project: string;
	prompts: Array<{ prompt_text: string; created_at: string }>;
	toolUses: Array<{
		tool_name: string;
		tool_input: string;
		tool_output: string;
		created_at: string;
	}>;
	fileReads: Array<{
		file_path: string;
		content_snippet: string;
		created_at: string;
	}>;
}): string {
	const { project, prompts, toolUses, fileReads } = sessionData;

	let prompt = `# Session for Project: ${project}\n\n`;

	// Add user prompts
	if (prompts.length > 0) {
		prompt += `## User Requests\n\n`;
		for (const p of prompts) {
			prompt += `### ${p.created_at}\n${p.prompt_text}\n\n`;
		}
	}

	// Add tool uses (summarized)
	if (toolUses.length > 0) {
		prompt += `## Tool Uses Summary\n\n`;

		// Group by tool name
		const toolGroups = new Map<string, number>();
		for (const t of toolUses) {
			toolGroups.set(t.tool_name, (toolGroups.get(t.tool_name) || 0) + 1);
		}

		for (const [toolName, count] of toolGroups) {
			prompt += `- ${toolName}: ${count} uses\n`;
		}

		prompt += `\n`;

		// Add key tool outputs (errors, file edits, important commands)
		prompt += `## Key Tool Outputs\n\n`;
		for (const t of toolUses) {
			// Include Edit, Write, Bash with errors, or errors in output
			const isImportant =
				["Edit", "Write"].includes(t.tool_name) ||
				(t.tool_name === "Bash" && t.tool_output.toLowerCase().includes("error")) ||
				t.tool_output.toLowerCase().includes("error:");

			if (isImportant) {
				prompt += `### ${t.tool_name} at ${t.created_at}\n`;
				prompt += `Input: ${t.tool_input.substring(0, 500)}...\n`;
				prompt += `Output: ${t.tool_output.substring(0, 500)}...\n\n`;
			}
		}
	}

	// Add file reads summary
	if (fileReads.length > 0) {
		prompt += `## Files Examined\n\n`;
		const uniqueFiles = new Set(fileReads.map((f) => f.file_path));
		for (const filePath of uniqueFiles) {
			prompt += `- ${filePath}\n`;
		}
		prompt += `\n`;
	}

	prompt += `\nAnalyze this session and extract valuable knowledge as JSON.`;

	return prompt;
}
