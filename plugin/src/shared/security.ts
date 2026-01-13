/**
 * Security utilities for path validation and sensitive data redaction
 */

import { resolve, relative, normalize } from "path";

/**
 * Validate path is within allowed directory (prevent path traversal)
 * Returns normalized safe path if valid, throws error otherwise
 */
export function validatePath(inputPath: string, allowedDir: string): string {
	// Step 1: Normalize and resolve
	const normalizedInput = normalize(inputPath);
	const resolvedInput = resolve(allowedDir, normalizedInput);
	const resolvedAllowed = resolve(allowedDir);

	// Step 2: Check relative path doesn't escape
	const relativePath = relative(resolvedAllowed, resolvedInput);

	// Step 3: Reject if starts with .. or is absolute after relative
	if (relativePath.startsWith("..") || resolve(relativePath) === relativePath) {
		throw new Error(
			`Path traversal detected: ${inputPath} escapes ${allowedDir}`
		);
	}

	// Step 4: Return safe normalized path
	return resolvedInput;
}

/**
 * Patterns for detecting sensitive data
 */
const SENSITIVE_PATTERNS = [
	// API keys and tokens
	/['\"]?api[_-]?key['\"]?\s*[:=]\s*['\"]?([a-zA-Z0-9_\-]{20,})['\"]?/gi,
	/['\"]?token['\"]?\s*[:=]\s*['\"]?([a-zA-Z0-9_\-]{20,})['\"]?/gi,
	/Bearer\s+([a-zA-Z0-9_\-\.]{20,})/gi,

	// Passwords
	/['\"]?password['\"]?\s*[:=]\s*['\"]?([^\s'"]{8,})['\"]?/gi,
	/['\"]?passwd['\"]?\s*[:=]\s*['\"]?([^\s'"]{8,})['\"]?/gi,

	// AWS keys
	/AKIA[0-9A-Z]{16}/g,

	// Private keys
	/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,

	// Database connection strings
	/(?:postgres|mysql|mongodb):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi,
];

/**
 * Redact sensitive information from text
 */
export function redactSensitiveData(text: string): string {
	let redacted = text;

	for (const pattern of SENSITIVE_PATTERNS) {
		redacted = redacted.replace(pattern, (match) => {
			// Keep first few chars for context, redact the rest
			const visible = match.substring(0, Math.min(10, match.length));
			return `${visible}...[REDACTED]`;
		});
	}

	return redacted;
}

/**
 * Check if text contains potential sensitive data
 */
export function containsSensitiveData(text: string): boolean {
	return SENSITIVE_PATTERNS.some((pattern) => {
		pattern.lastIndex = 0; // Reset regex state
		return pattern.test(text);
	});
}

/**
 * Truncate large text content to max size
 * Keeps first half and last half to preserve context
 */
export function truncateContent(
	content: string,
	maxSize: number
): { content: string; truncated: boolean } {
	if (content.length <= maxSize) {
		return { content, truncated: false };
	}

	const halfSize = Math.floor(maxSize / 2);
	const truncated =
		content.substring(0, halfSize) +
		"\n\n... [TRUNCATED] ...\n\n" +
		content.substring(content.length - halfSize);

	return { content: truncated, truncated: true };
}
