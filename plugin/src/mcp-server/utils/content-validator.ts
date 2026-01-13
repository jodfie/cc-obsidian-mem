/**
 * Content Validator for AI-powered staleness detection
 *
 * Validates knowledge notes against the current codebase to detect
 * when documented information has become outdated.
 *
 * Uses claude -p CLI for AI analysis to avoid hook deadlock.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseFrontmatter } from './frontmatter.js';
import { sanitizeProjectName, loadConfig } from '../../shared/config.js';
import { PROJECTS_FOLDER } from '../../shared/constants.js';
import { createLogger, type Logger } from '../../shared/logger.js';
import type {
  ValidationResult,
  ValidateOptions,
  ContentValidationSummary,
} from '../../shared/audit-types.js';

/**
 * Regex patterns to detect file references in note content
 */
const FILE_REFERENCE_PATTERNS = [
  // Explicit paths in prose: "in src/utils/helper.ts" or "file src/foo.ts"
  /(?:src|lib|plugin|packages?)\/[\w\-\/]+\.(?:ts|js|tsx|jsx|json|md)/g,
  // Code block file comments: "// src/foo.ts" or "/* src/bar.js */"
  /(?:\/\/|\/\*)\s*((?:src|lib|plugin|packages?)\/[\w\-\/]+\.(?:ts|js|tsx|jsx|json|md))/g,
];

/**
 * Maximum content length to read from referenced files
 */
const MAX_FILE_CONTENT = 2000;

/**
 * Default timeout for AI validation (60 seconds)
 */
const DEFAULT_TIMEOUT = 60000;

/**
 * Expected structure of AI validation response
 */
interface AIValidationResponse {
  isStale: boolean;
  confidence: number;
  reason: string;
}

export class ContentValidator {
  private memPath: string;
  private vaultPath: string;
  private projectRoot: string;
  private logger: Logger;

  constructor(vaultPath: string, memFolder: string, projectRoot?: string) {
    this.vaultPath = vaultPath;
    this.memPath = path.join(vaultPath, memFolder);
    this.projectRoot = projectRoot || process.cwd();
    this.logger = createLogger('content-validator');
  }

  /**
   * Validate notes for staleness
   */
  async validate(options: ValidateOptions): Promise<ContentValidationSummary> {
    const project = sanitizeProjectName(options.project);
    const projectPath = path.join(this.memPath, PROJECTS_FOLDER, project);

    this.logger.info(`Starting content validation for project: ${project}`);

    const summary: ContentValidationSummary = {
      notes_checked: 0,
      stale_count: 0,
      validation_failed_count: 0,
      results: [],
    };

    if (!fs.existsSync(projectPath)) {
      this.logger.info(`Project path does not exist: ${projectPath}`);
      return summary;
    }

    // Collect notes to validate
    const notes = this.collectNotes(projectPath, options);
    this.logger.info(`Found ${notes.length} notes to validate`);

    // Apply limit
    const limit = options.limit || 20;
    const notesToValidate = notes.slice(0, limit);

    // Validate each note
    for (const notePath of notesToValidate) {
      try {
        const result = await this.validateNote(notePath, options.confidenceThreshold || 0.7);
        summary.results.push(result);
        summary.notes_checked++;

        if (result.isStale === true) {
          summary.stale_count++;
        } else if (result.isStale === null) {
          summary.validation_failed_count++;
        }
      } catch (error) {
        this.logger.error(`Failed to validate ${notePath}: ${error}`);
        summary.results.push({
          notePath: path.relative(this.vaultPath, notePath),
          isStale: null,
          confidence: 0,
          reason: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          referencedFiles: [],
        });
        summary.validation_failed_count++;
        summary.notes_checked++;
      }
    }

    this.logger.info(`Validation complete: ${summary.stale_count} stale, ${summary.validation_failed_count} failed, ${summary.notes_checked - summary.stale_count - summary.validation_failed_count} current`);

    return summary;
  }

  /**
   * Collect notes to validate based on options
   */
  private collectNotes(projectPath: string, options: ValidateOptions): string[] {
    const notes: string[] = [];

    // Focus on research and decisions folders (where knowledge is stored)
    const foldersToCheck = ['research', 'decisions'];

    for (const folder of foldersToCheck) {
      const folderPath = path.join(projectPath, folder);
      if (!fs.existsSync(folderPath)) continue;

      const files = this.walkDir(folderPath, '.md');
      for (const file of files) {
        // Skip index files
        const filename = path.basename(file, '.md');
        if (filename === folder) continue;

        // Filter by note type if specified
        if (options.noteType) {
          try {
            const content = fs.readFileSync(file, 'utf-8');
            const { frontmatter } = parseFrontmatter(content);
            const knowledgeType = frontmatter.knowledge_type || frontmatter.type;
            if (knowledgeType !== options.noteType) continue;
          } catch {
            continue;
          }
        }

        notes.push(file);
      }
    }

    // Sort by modification time (newest first - more likely to be relevant)
    notes.sort((a, b) => {
      try {
        return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime();
      } catch {
        return 0;
      }
    });

    return notes;
  }

  /**
   * Validate a single note
   */
  private async validateNote(notePath: string, confidenceThreshold: number): Promise<ValidationResult> {
    const relativePath = path.relative(this.vaultPath, notePath);

    // Read note content
    const noteContent = fs.readFileSync(notePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(noteContent);

    // Extract file references
    const referencedFiles = this.extractFileReferences(content);

    // If no files referenced, we can't determine staleness without AI
    // Consider the note as "cannot validate" rather than "not stale"
    if (referencedFiles.length === 0) {
      return {
        notePath: relativePath,
        isStale: null,
        confidence: 0,
        reason: 'No file references found in note content',
        referencedFiles: [],
      };
    }

    // Check which files exist
    const existingFiles: string[] = [];
    const missingFiles: string[] = [];

    for (const ref of referencedFiles) {
      const fullPath = path.join(this.projectRoot, ref);
      if (fs.existsSync(fullPath)) {
        existingFiles.push(ref);
      } else {
        missingFiles.push(ref);
      }
    }

    // If all referenced files are missing, the note is definitely stale
    if (existingFiles.length === 0 && missingFiles.length > 0) {
      return {
        notePath: relativePath,
        isStale: true,
        confidence: 1.0,
        reason: `All referenced files have been deleted: ${missingFiles.join(', ')}`,
        referencedFiles: missingFiles,
      };
    }

    // If some files are missing, note is likely stale
    if (missingFiles.length > 0) {
      const missingRatio = missingFiles.length / referencedFiles.length;
      return {
        notePath: relativePath,
        isStale: true,
        confidence: 0.7 + (missingRatio * 0.3),
        reason: `Some referenced files no longer exist: ${missingFiles.join(', ')}`,
        referencedFiles: referencedFiles,
      };
    }

    // All files exist - use AI to compare content
    const fileContents = this.readFileContents(existingFiles);

    if (Object.keys(fileContents).length === 0) {
      return {
        notePath: relativePath,
        isStale: null,
        confidence: 0,
        reason: 'Could not read any referenced files',
        referencedFiles: existingFiles,
      };
    }

    // Run AI validation
    const aiResult = await this.runAIValidation(
      frontmatter.title as string || 'Untitled',
      content,
      fileContents
    );

    // Apply confidence threshold - if confidence is below threshold, treat as uncertain
    const meetsThreshold = aiResult.confidence >= confidenceThreshold;
    const effectiveIsStale = meetsThreshold ? aiResult.isStale : null;
    const effectiveReason = meetsThreshold
      ? aiResult.reason
      : `${aiResult.reason} (confidence ${Math.round(aiResult.confidence * 100)}% below threshold ${Math.round(confidenceThreshold * 100)}%)`;

    return {
      notePath: relativePath,
      isStale: effectiveIsStale,
      confidence: aiResult.confidence,
      reason: effectiveReason,
      referencedFiles: existingFiles,
    };
  }

  /**
   * Extract file references from note content
   * Includes security sanitization to prevent path traversal
   */
  private extractFileReferences(content: string): string[] {
    const references = new Set<string>();

    for (const pattern of FILE_REFERENCE_PATTERNS) {
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;

      let match;
      while ((match = pattern.exec(content)) !== null) {
        // Get the matched path (may be in group 1 for some patterns)
        const rawPath = match[1] || match[0];

        // Sanitize path
        const sanitized = this.sanitizePath(rawPath);
        if (sanitized) {
          references.add(sanitized);
        }
      }
    }

    return Array.from(references);
  }

  /**
   * Sanitize a file path to prevent path traversal
   * Returns null if path is invalid/dangerous
   */
  private sanitizePath(rawPath: string): string | null {
    // Reject paths with parent directory references
    if (rawPath.includes('..')) {
      return null;
    }

    // Normalize the path
    const normalized = path.normalize(rawPath);

    // Verify it's still within expected bounds (no leading /)
    if (path.isAbsolute(normalized)) {
      return null;
    }

    // Verify normalized path doesn't escape (double-check after normalize)
    if (normalized.includes('..')) {
      return null;
    }

    // Verify the resolved path would be within project root
    const resolved = path.resolve(this.projectRoot, normalized);
    if (!resolved.startsWith(this.projectRoot + path.sep) && resolved !== this.projectRoot) {
      return null;
    }

    return normalized;
  }

  /**
   * Read contents of referenced files (limited to MAX_FILE_CONTENT chars each)
   */
  private readFileContents(files: string[]): Record<string, string> {
    const contents: Record<string, string> = {};

    for (const file of files) {
      try {
        const fullPath = path.join(this.projectRoot, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        contents[file] = content.substring(0, MAX_FILE_CONTENT);
      } catch {
        // Skip files we can't read
      }
    }

    return contents;
  }

  /**
   * Run AI validation using claude -p
   */
  private async runAIValidation(
    noteTitle: string,
    noteContent: string,
    fileContents: Record<string, string>
  ): Promise<{ isStale: boolean | null; confidence: number; reason: string }> {
    const config = loadConfig();
    const timeout = DEFAULT_TIMEOUT;

    // Build prompt
    const filesSection = Object.entries(fileContents)
      .map(([file, content]) => `### ${file}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n');

    const prompt = `You are comparing a knowledge note against current code to determine if the note is still accurate.

## Knowledge Note: "${noteTitle}"

${noteContent.substring(0, 3000)}

## Current File Contents

${filesSection}

## Task

Compare the knowledge note against the current file contents. Determine if the note is:
- **stale**: The code has changed significantly and the note no longer accurately describes it
- **current**: The note still accurately reflects the code

Consider:
1. Have the APIs, functions, or classes mentioned in the note changed?
2. Are the described patterns or approaches still used?
3. Is the note's context still relevant?

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "isStale": boolean,
  "confidence": number between 0 and 1,
  "reason": "brief explanation of why the note is stale or current"
}`;

    return new Promise((resolve) => {
      const proc = spawn('claude', [
        '-p',
        '--model', config.summarization.model || 'haiku',
        '--output-format', 'text',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Send prompt via stdin
      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Timeout
      const timeoutId = setTimeout(() => {
        proc.kill();
        this.logger.error(`AI validation timed out after ${timeout / 1000}s`);
        resolve({
          isStale: null,
          confidence: 0,
          reason: 'AI validation timed out',
        });
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        if (code !== 0) {
          this.logger.error(`claude -p exited with code ${code}`);
          resolve({
            isStale: null,
            confidence: 0,
            reason: `AI validation failed with exit code ${code}`,
          });
          return;
        }

        try {
          // Parse JSON response
          const trimmed = stdout.trim();

          // Handle potential markdown code blocks
          let jsonStr = trimmed;
          const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
          }

          const parsed: unknown = JSON.parse(jsonStr);

          // Type guard for AI response structure
          if (!this.isValidAIResponse(parsed)) {
            this.logger.error('Invalid AI response structure');
            resolve({
              isStale: null,
              confidence: 0,
              reason: 'AI returned invalid response structure',
            });
            return;
          }

          resolve({
            isStale: parsed.isStale,
            confidence: Math.min(1, Math.max(0, parsed.confidence)),
            reason: parsed.reason,
          });
        } catch (error) {
          this.logger.error(`Failed to parse AI response: ${error}`);
          resolve({
            isStale: null,
            confidence: 0,
            reason: `Failed to parse AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        this.logger.error(`Failed to spawn claude -p: ${error}`);
        resolve({
          isStale: null,
          confidence: 0,
          reason: `Failed to run AI validation: ${error.message}`,
        });
      });
    });
  }

  /**
   * Walk directory recursively for files with given extension
   */
  private walkDir(dir: string, ext: string): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) {
      return files;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip canvases, sessions, and hidden directories
        if (!['canvases', 'sessions', '.'].some(s => entry.name.startsWith(s) || entry.name === s)) {
          files.push(...this.walkDir(fullPath, ext));
        }
      } else if (entry.name.endsWith(ext)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Type guard to validate AI response structure
   */
  private isValidAIResponse(value: unknown): value is AIValidationResponse {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.isStale === 'boolean' &&
      typeof obj.confidence === 'number' &&
      typeof obj.reason === 'string'
    );
  }
}
