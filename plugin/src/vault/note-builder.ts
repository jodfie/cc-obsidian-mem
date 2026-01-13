/**
 * Note builder utilities
 * Helps construct markdown notes with proper frontmatter and linking
 */

import { join } from "path";
import type { NoteFrontmatter, NoteType, NoteStatus } from "../shared/types.js";

/**
 * Build frontmatter for a note
 */
export function buildFrontmatter(options: {
	type: NoteType;
	title: string;
	project: string;
	tags?: string[];
	status?: NoteStatus;
	parent?: string;
	supersedes?: string[];
	superseded_by?: string;
	knowledge_type?: string;
}): NoteFrontmatter {
	const now = new Date().toISOString();

	return {
		type: options.type,
		title: options.title,
		project: options.project,
		created: now,
		tags: options.tags || [],
		status: options.status || "active",
		parent: options.parent,
		supersedes: options.supersedes,
		superseded_by: options.superseded_by,
		...(options.knowledge_type && { knowledge_type: options.knowledge_type }),
	};
}

/**
 * Generate safe filename from title
 */
export function generateFilename(title: string): string {
	const date = new Date().toISOString().split("T")[0];
	const safeTitle = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.substring(0, 50);

	return `${date}_${safeTitle}.md`;
}

/**
 * Get parent wikilink for a note
 */
export function getParentLink(
	project: string,
	category: string,
	memFolder: string = "_claude-mem"
): string {
	return `[[${memFolder}/projects/${project}/${category}/${category}]]`;
}

/**
 * Build wikilink to a note
 */
export function buildWikilink(notePath: string): string {
	// Remove .md extension and create wikilink
	const linkPath = notePath.replace(/\.md$/, "");
	return `[[${linkPath}]]`;
}

/**
 * Build supersession links
 */
export function buildSupersessionNote(
	oldNotePath: string,
	newNotePath: string
): {
	oldNoteUpdate: string;
	newNoteSupersedes: string[];
} {
	return {
		oldNoteUpdate: buildWikilink(newNotePath),
		newNoteSupersedes: [buildWikilink(oldNotePath)],
	};
}

/**
 * Map category folder to note type
 */
export function categoryToNoteType(category: string): NoteType {
	const mapping: Record<string, NoteType> = {
		decisions: "decision",
		patterns: "pattern",
		errors: "error",
		research: "learning",
		files: "file",
	};

	return mapping[category] || "learning";
}

/**
 * Get folder for note type
 */
export function noteTypeToFolder(type: NoteType): string {
	const mapping: Record<NoteType, string> = {
		decision: "decisions",
		pattern: "patterns",
		error: "errors",
		learning: "research",
		file: "files",
	};

	return mapping[type] || "research";
}
