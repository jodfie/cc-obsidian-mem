/**
 * AI-powered summarization engine
 * Reads session data from SQLite and extracts knowledge to Obsidian vault
 */

import { Database } from "bun:sqlite";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { spawn } from "child_process";
import { initDatabase, closeDatabase } from "../sqlite/database.js";
import {
	getSession,
	getSessionPrompts,
	getSessionToolUses,
	getSessionFileReads,
	upsertSessionSummary,
} from "../sqlite/session-store.js";
import { loadConfig, getConfigDir, AGENT_SESSION_MARKER } from "../shared/config.js";
import { createLogger, Logger } from "../shared/logger.js";
import {
	KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
	buildSessionPrompt,
} from "./prompts.js";
import type { CompletionMarker } from "../shared/types.js";

interface ExtractedKnowledge {
	decisions: Array<{ title: string; content: string; tags: string[] }>;
	patterns: Array<{ title: string; content: string; tags: string[] }>;
	errors: Array<{ title: string; content: string; solution: string; tags: string[] }>;
	learnings: Array<{ title: string; content: string; tags: string[] }>;
	qa: Array<{ question: string; answer: string; tags: string[] }>;
}

/**
 * Run summarization for a session
 */
export async function summarizeSession(
	sessionId: string,
	logger: Logger
): Promise<{ success: boolean; error?: string; writtenNotes: string[] }> {
	const config = loadConfig();
	const tempFile = join(tmpdir(), `cc-obsidian-mem-${sessionId}.txt`);
	const writtenNotes: string[] = [];

	try {
		// Initialize database
		const db = initDatabase(config.sqlite.path!, logger);

		// Get session
		const session = getSession(db, sessionId);
		if (!session) {
			closeDatabase(db, logger);
			return { success: false, error: "Session not found", writtenNotes: [] };
		}

		// Get session data
		const prompts = getSessionPrompts(db, sessionId);
		const toolUses = getSessionToolUses(db, sessionId);
		const fileReads = getSessionFileReads(db, sessionId);

		logger.info("Retrieved session data", {
			prompts: prompts.length,
			toolUses: toolUses.length,
			fileReads: fileReads.length,
		});

		// Check if there's enough data to summarize
		if (prompts.length === 0 && toolUses.length < 5) {
			logger.info("Insufficient data for summarization, skipping");
			upsertSessionSummary(db, sessionId, session.project, {
				written_to_vault: 1,
				written_notes: JSON.stringify([]),
			});
			closeDatabase(db, logger);
			return { success: true, writtenNotes: [] };
		}

		// Build prompt
		const userPrompt = buildSessionPrompt({
			project: session.project,
			prompts: prompts.map((p) => ({
				prompt_text: p.prompt_text,
				created_at: p.created_at,
			})),
			toolUses: toolUses.map((t) => ({
				tool_name: t.tool_name,
				tool_input: t.tool_input,
				tool_output: t.tool_output,
				created_at: t.created_at,
			})),
			fileReads: fileReads.map((f) => ({
				file_path: f.file_path,
				content_snippet: f.content_snippet || "",
				created_at: f.created_at,
			})),
		});

		// Write prompt to temp file
		const fullPrompt = `${KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT}\n\n${userPrompt}`;
		writeFileSync(tempFile, fullPrompt, "utf-8");

		logger.debug("Wrote prompt to temp file", { path: tempFile });

		// Call Claude via CLI
		const claudeOutput = await invokeClaudeCLI(tempFile, logger);

		// Parse JSON response
		const knowledge = parseKnowledgeResponse(claudeOutput, logger);

		if (!knowledge) {
			throw new Error("Failed to parse knowledge from Claude response");
		}

		// Write knowledge to vault
		const vaultPath = config.vault.path;
		const memFolder = config.vault.memFolder || "_claude-mem";
		const projectPath = join(vaultPath, memFolder, "projects", session.project);

		// Ensure directories exist
		ensureDirectories(projectPath);

		// Write each type of knowledge
		if (knowledge.decisions.length > 0) {
			for (const decision of knowledge.decisions) {
				const notePath = writeKnowledgeNote(
					projectPath,
					"decisions",
					decision.title,
					decision.content,
					decision.tags,
					session.project
				);
				writtenNotes.push(notePath);
			}
		}

		if (knowledge.patterns.length > 0) {
			for (const pattern of knowledge.patterns) {
				const notePath = writeKnowledgeNote(
					projectPath,
					"patterns",
					pattern.title,
					pattern.content,
					pattern.tags,
					session.project
				);
				writtenNotes.push(notePath);
			}
		}

		if (knowledge.errors.length > 0) {
			for (const error of knowledge.errors) {
				const content = `${error.content}\n\n## Solution\n${error.solution}`;
				const notePath = writeKnowledgeNote(
					projectPath,
					"errors",
					error.title,
					content,
					error.tags,
					session.project
				);
				writtenNotes.push(notePath);
			}
		}

		if (knowledge.learnings.length > 0) {
			for (const learning of knowledge.learnings) {
				const notePath = writeKnowledgeNote(
					projectPath,
					"research",
					learning.title,
					learning.content,
					learning.tags,
					session.project
				);
				writtenNotes.push(notePath);
			}
		}

		if (knowledge.qa.length > 0) {
			for (const qa of knowledge.qa) {
				const content = `## Question\n${qa.question}\n\n## Answer\n${qa.answer}`;
				const notePath = writeKnowledgeNote(
					projectPath,
					"research",
					`QA: ${qa.question.substring(0, 50)}`,
					content,
					qa.tags,
					session.project
				);
				writtenNotes.push(notePath);
			}
		}

		// Update session summary
		upsertSessionSummary(db, sessionId, session.project, {
			written_to_vault: 1,
			written_notes: JSON.stringify(writtenNotes),
		});

		logger.info("Summarization completed", { notesWritten: writtenNotes.length });

		closeDatabase(db, logger);
		return { success: true, writtenNotes };
	} catch (error) {
		logger.error("Summarization failed", { error });
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			writtenNotes,
		};
	} finally {
		// Clean up temp file
		try {
			if (existsSync(tempFile)) {
				unlinkSync(tempFile);
			}
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Invoke Claude CLI with prompt file
 */
async function invokeClaudeCLI(promptFile: string, logger: Logger): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = ["-p", promptFile, "--output-format", "text"];

		logger.debug("Invoking Claude CLI", { args });

		const child = spawn("claude", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [AGENT_SESSION_MARKER]: "1" },
			windowsHide: true, // Prevent cmd popup on Windows
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				logger.error("Claude CLI failed", { code, stderr });
				reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
			}
		});

		child.on("error", (error) => {
			reject(error);
		});

		// Timeout after 5 minutes
		setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Claude CLI timeout after 5 minutes"));
		}, 5 * 60 * 1000);
	});
}

/**
 * Parse knowledge JSON from Claude response
 */
function parseKnowledgeResponse(
	response: string,
	logger: Logger
): ExtractedKnowledge | null {
	try {
		// Try to find JSON in the response
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			logger.warn("No JSON found in response");
			return null;
		}

		const parsed = JSON.parse(jsonMatch[0]);

		// Validate structure
		return {
			decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
			patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
			errors: Array.isArray(parsed.errors) ? parsed.errors : [],
			learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
			qa: Array.isArray(parsed.qa) ? parsed.qa : [],
		};
	} catch (error) {
		logger.error("Failed to parse knowledge response", { error });
		return null;
	}
}

/**
 * Ensure project directories exist
 */
function ensureDirectories(projectPath: string): void {
	const dirs = ["decisions", "patterns", "errors", "research", "sessions"];
	for (const dir of dirs) {
		const dirPath = join(projectPath, dir);
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
		}
	}
}

/**
 * Write a knowledge note to the vault
 */
function writeKnowledgeNote(
	projectPath: string,
	category: string,
	title: string,
	content: string,
	tags: string[],
	project: string
): string {
	const timestamp = new Date().toISOString().split("T")[0];
	const safeTitle = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.substring(0, 50);
	const filename = `${timestamp}_${safeTitle}.md`;
	const filePath = join(projectPath, category, filename);

	const frontmatter = `---
type: ${category === "research" ? "learning" : category.slice(0, -1)}
title: "${title.replace(/"/g, '\\"')}"
project: ${project}
created: ${new Date().toISOString()}
tags: [${tags.map((t) => `"${t}"`).join(", ")}]
status: active
parent: "[[${project}/${category}/${category}]]"
---

`;

	const fullContent = frontmatter + content;
	writeFileSync(filePath, fullContent, "utf-8");

	return filePath;
}

/**
 * Write completion marker
 */
export function writeCompletionMarker(
	sessionId: string,
	success: boolean,
	writtenNotes: string[],
	errorMessage?: string
): void {
	const markerDir = join(getConfigDir(), "completed");
	if (!existsSync(markerDir)) {
		mkdirSync(markerDir, { recursive: true });
	}

	const marker: CompletionMarker = {
		completed_at: new Date().toISOString(),
		written_notes: writtenNotes,
		success,
		error_message: errorMessage,
	};

	const markerPath = join(markerDir, `${sessionId}.marker`);
	writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf-8");
}
