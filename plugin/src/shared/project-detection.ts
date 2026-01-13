/**
 * Project name detection utilities
 * Searches for git repository root and extracts project name
 */

import { existsSync } from "fs";
import { join, basename, dirname } from "path";

/**
 * Detect project name from current working directory
 * Searches up the directory tree for .git folder
 */
export function detectProjectName(cwd: string, fallbackProject?: string): string {
	// Try to find git repository root
	const gitRoot = findGitRoot(cwd);

	if (gitRoot) {
		// Use repository name as project name
		const repoName = basename(gitRoot);
		return sanitizeProjectName(repoName);
	}

	// Fallback to provided project name
	if (fallbackProject) {
		return sanitizeProjectName(fallbackProject);
	}

	// Final fallback: use directory name
	const dirName = basename(cwd);
	return sanitizeProjectName(dirName);
}

/**
 * Find git repository root by searching up the directory tree
 */
function findGitRoot(startPath: string): string | null {
	let currentPath = startPath;
	const root = "/"; // Unix root, will work on Windows too since we're using path.dirname

	while (currentPath !== root) {
		const gitPath = join(currentPath, ".git");

		if (existsSync(gitPath)) {
			return currentPath;
		}

		const parentPath = dirname(currentPath);

		// Prevent infinite loop
		if (parentPath === currentPath) {
			break;
		}

		currentPath = parentPath;
	}

	return null;
}

/**
 * Sanitize project name for use as folder/file name
 * Removes special characters, converts to lowercase kebab-case
 */
export function sanitizeProjectName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}
