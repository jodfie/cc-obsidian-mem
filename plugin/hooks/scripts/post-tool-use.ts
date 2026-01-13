#!/usr/bin/env bun

import { loadConfig } from '../../src/shared/config.js';
import { addObservation, readSession, appendExploration } from '../../src/shared/session-store.js';
import { VaultManager } from '../../src/mcp-server/utils/vault.js';
import {
  isSignificantAction,
  generateObservationId,
  extractFileInfo,
  extractCommandInfo,
  extractErrorInfo,
  readStdinJson,
} from './utils/helpers.js';
import { createLogger } from '../../src/shared/logger.js';
import type { PostToolUseInput, Observation, ErrorData, ExplorationData } from '../../src/shared/types.js';
import { extractToolKnowledge } from '../../src/services/knowledge-extractor.js';
import { sanitizeProjectName } from '../../src/shared/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

async function main() {
  try {
    const input = await readStdinJson<PostToolUseInput>();
    const config = loadConfig();
    const logger = createLogger('post-tool-use', input.session_id);

    // DEBUG: Log the actual input structure for exploration tools
    if (EXPLORATION_TOOLS.has(input.tool_name)) {
      const envOutput = process.env.CLAUDE_TOOL_OUTPUT;
      const resp = input.tool_response as any;
      logger.debug('Exploration tool raw input', {
        tool: input.tool_name,
        hasToolResponse: !!input.tool_response,
        toolResponseKeys: input.tool_response ? Object.keys(input.tool_response) : [],
        // Tool-specific fields
        hasFilenames: Array.isArray(resp?.filenames),
        filenamesCount: Array.isArray(resp?.filenames) ? resp.filenames.length : 0,
        hasMatches: Array.isArray(resp?.matches),
        hasFiles: Array.isArray(resp?.files),
        // Standard fields
        contentType: resp?.content ? typeof resp.content : 'undefined',
        isContentArray: Array.isArray(resp?.content),
        // Also check for tool_result which docs mention
        hasToolResult: !!(input as any).tool_result,
        // Check environment variable
        hasEnvOutput: !!envOutput,
        envOutputLength: envOutput?.length ?? 0,
      });
    }

    logger.debug('Post-tool-use hook triggered', { tool: input.tool_name, isError: input.tool_response?.isError });

    // Validate session_id from input
    if (!input.session_id) {
      logger.debug('No session_id in input, skipping');
      return;
    }

    // Check if we have an active or stopped session for this session_id
    // Allow stopped sessions to receive observations from in-flight tool completions
    const session = readSession(input.session_id);
    if (!session || (session.status !== 'active' && session.status !== 'stopped')) {
      logger.debug('Session not found or not writable', { sessionExists: !!session, status: session?.status });
      return;
    }

    // Handle knowledge-producing tools FIRST (before shouldCapture/isSignificantAction filters)
    // These tools don't need to pass the observation filters
    if (isKnowledgeTool(input.tool_name)) {
      logger.debug('Knowledge-producing tool detected', { tool: input.tool_name });
      // Check if tool failed - still record as error
      if (input.tool_response.isError) {
        logger.info('Knowledge tool failed, recording error', { tool: input.tool_name });
        const errorObservation = buildErrorObservation(input);
        addObservation(input.session_id, errorObservation);
        await processError(errorObservation, session.project, session.id, config);
      } else {
        // Only extract knowledge from successful responses
        await processKnowledgeTool(input, session.project, session.id, config, logger);
      }
      return;
    }

    // Handle exploration tools (Read, Grep, Glob) - capture lightweight exploration data
    // These tools don't create observations but log exploration activity
    if (isExplorationTool(input.tool_name)) {
      logger.debug('Exploration tool detected', { tool: input.tool_name });
      try {
        const explorationData = extractExplorationData(input, session.projectPath, logger);
        if (explorationData) {
          const success = appendExploration(input.session_id, explorationData);
          if (!success) {
            logger.info('Failed to append exploration (size limit or error)', { tool: input.tool_name });
          }
        }
      } catch (error) {
        // Never fail the hook on exploration capture failure
        logger.error('Error capturing exploration', error instanceof Error ? error : undefined);
      }
      return;
    }

    // Filter based on configuration (for file edits, bash commands)
    if (!shouldCapture(input.tool_name, config)) {
      logger.debug('Tool not configured for capture', { tool: input.tool_name });
      return;
    }

    // Check if action is significant enough to capture
    if (!isSignificantAction(input)) {
      logger.debug('Action not significant, skipping', { tool: input.tool_name });
      return;
    }

    // Build observation based on tool type
    const observation = buildObservation(input, config);
    logger.debug('Observation built', { type: observation.type, tool: observation.tool });

    // Add to session file using the session_id from input
    addObservation(input.session_id, observation);
    logger.info('Observation recorded', { type: observation.type, tool: observation.tool });

    // Handle errors specially - create/update error notes in vault
    if (observation.type === 'error' || observation.isError) {
      logger.info('Processing error observation');
      await processError(observation, session.project, session.id, config);
    }

    // Handle file edits - update file knowledge
    if (observation.type === 'file_edit') {
      logger.info('Processing file edit observation');
      await processFileEdit(observation, session.project, session.id, config);
    }
  } catch (error) {
    // Silently fail to not break Claude Code (don't use logger here, might not be initialized)
    console.error('Post tool use hook error:', error);
  }
}

/**
 * Check if a tool produces knowledge worth extracting
 */
function isKnowledgeTool(toolName: string): boolean {
  return (
    toolName === 'WebFetch' ||
    toolName === 'WebSearch' ||
    (toolName.includes('context7') && toolName.includes('query-docs'))
  );
}

/**
 * Process a knowledge-producing tool and extract/store knowledge
 */
async function processKnowledgeTool(
  input: PostToolUseInput,
  project: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  // Skip if summarization is disabled
  if (!config.summarization.enabled) {
    logger.debug('Summarization disabled, skipping knowledge extraction');
    return;
  }

  // Extract tool output text using flexible extractor
  const outputText = getToolOutputText(input.tool_response, input);

  if (!outputText || outputText.length < 100) {
    logger.debug('Output too short for knowledge extraction', { length: outputText?.length ?? 0 });
    return;
  }

  logger.debug('Extracting knowledge from tool output', { tool: input.tool_name, outputLength: outputText.length });

  try {
    // Extract knowledge from tool output
    const knowledge = await extractToolKnowledge(
      input.tool_name,
      input.tool_input,
      outputText,
      sessionId
    );

    if (knowledge) {
      // Store knowledge in vault
      const vault = new VaultManager(config.vault.path, config.vault.memFolder);
      await vault.writeKnowledge(knowledge, project);
      logger.info('Knowledge extracted and stored', { type: knowledge.type, title: knowledge.title });
    } else {
      logger.debug('No knowledge extracted from tool output');
    }
  } catch (error) {
    logger.error('Failed to extract knowledge from tool', error instanceof Error ? error : undefined);
  }
}

function shouldCapture(toolName: string, config: ReturnType<typeof loadConfig>): boolean {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return config.capture.fileEdits;
    case 'Bash':
      return config.capture.bashCommands;
    // Knowledge-producing tools
    case 'WebFetch':
    case 'WebSearch':
      return true; // Always capture web research
    default:
      // Capture Context7 tools
      if (toolName.includes('context7') && toolName.includes('query-docs')) {
        return true;
      }
      return false;
  }
}

function buildObservation(input: PostToolUseInput, config: ReturnType<typeof loadConfig>): Observation {
  const baseObservation: Observation = {
    id: generateObservationId(),
    timestamp: new Date().toISOString(),
    tool: input.tool_name,
    type: 'other',
    isError: input.tool_response.isError || false,
    data: {},
  };

  switch (input.tool_name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return {
        ...baseObservation,
        type: 'file_edit',
        data: extractFileInfo(input.tool_input, input.tool_response),
      };

    case 'Bash':
      const cmdInfo = extractCommandInfo(
        input.tool_input,
        input.tool_response,
        config.capture.bashOutput
      );
      if (cmdInfo.isError) {
        return {
          ...baseObservation,
          type: 'error',
          isError: true,
          data: extractErrorInfo(input.tool_name, input.tool_input, input.tool_response),
        };
      }
      return {
        ...baseObservation,
        type: 'command',
        data: cmdInfo,
      };

    default:
      return {
        ...baseObservation,
        type: 'other',
        data: {
          input: input.tool_input,
          output: input.tool_response,
        },
      };
  }
}

/**
 * Build an error observation for failed knowledge tools
 */
function buildErrorObservation(input: PostToolUseInput): Observation {
  return {
    id: generateObservationId(),
    timestamp: new Date().toISOString(),
    tool: input.tool_name,
    type: 'error',
    isError: true,
    data: extractErrorInfo(input.tool_name, input.tool_input, input.tool_response),
  };
}

/**
 * Process an error observation - create/update error notes
 */
async function processError(
  observation: Observation,
  project: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  if (!config.capture.errors) return;

  const vault = new VaultManager(config.vault.path, config.vault.memFolder);
  const errorData = observation.data as ErrorData;
  const errorHash = hashError(errorData);

  const projectPath = path.join(
    vault.getMemPath(),
    'projects',
    sanitizeProjectName(project),
    'errors'
  );

  // Ensure directory exists
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

  const errorFilePath = path.join(projectPath, `${errorHash}.md`);

  if (fs.existsSync(errorFilePath)) {
    // Update existing error note - add new occurrence row
    await updateErrorNote(errorFilePath, observation, sessionId, vault);
  } else {
    // Create new error note
    await createErrorNote(errorFilePath, observation, project, sessionId);
  }
}

/**
 * Create a new error note
 */
async function createErrorNote(
  filePath: string,
  observation: Observation,
  project: string,
  sessionId: string
): Promise<void> {
  const config = loadConfig();
  const errorData = observation.data as ErrorData;
  const errorType = categorizeError(errorData);

  // Parent link to errors category index (errors/errors.md)
  const parentLink = `[[${config.vault.memFolder}/projects/${sanitizeProjectName(project)}/errors/errors]]`;

  const frontmatter = `---
type: error
title: "Error: ${(errorData.type || 'Unknown').replace(/"/g, '\\"')}"
project: ${project}
created: ${new Date().toISOString()}
updated: ${new Date().toISOString()}
tags:
  - error
  - error/${errorType}
  - project/${sanitizeProjectName(project)}
parent: "${parentLink}"
error_type: ${errorData.type || 'unknown'}
error_hash: ${path.basename(filePath, '.md')}
first_seen: ${observation.timestamp}
last_seen: ${observation.timestamp}
occurrences: 1
resolved: false
sessions:
  - ${sessionId}
---

`;

  const content = `# Error: ${errorData.type || 'Unknown'}

## Summary

> [!danger] Error Pattern
> ${errorData.message || 'No message'}

## Context

**File**: \`${errorData.file || 'unknown'}\`
**Line**: ${errorData.line || 'unknown'}

## Error Message

\`\`\`
${errorData.message || 'No error message'}
\`\`\`

${errorData.stack ? `## Stack Trace

\`\`\`
${errorData.stack}
\`\`\`` : ''}

## Resolution

> [!success] Solution
> _Not yet resolved_

## Occurrences

| Date | Session | Context |
|------|---------|---------|
| ${observation.timestamp.split('T')[0]} | ${sessionId.substring(0, 8)} | First occurrence |
`;

  fs.writeFileSync(filePath, frontmatter + content);
}

/**
 * Update an existing error note with new occurrence
 */
async function updateErrorNote(
  filePath: string,
  observation: Observation,
  sessionId: string,
  vault: VaultManager
): Promise<void> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const errorData = observation.data as ErrorData;

  // Update frontmatter fields
  let updated = raw;

  // Update last_seen
  updated = updated.replace(
    /last_seen: .+/,
    `last_seen: ${observation.timestamp}`
  );

  // Increment occurrences
  const occurrencesMatch = updated.match(/occurrences: (\d+)/);
  if (occurrencesMatch) {
    const count = parseInt(occurrencesMatch[1], 10) + 1;
    updated = updated.replace(/occurrences: \d+/, `occurrences: ${count}`);
  }

  // Update updated timestamp
  updated = updated.replace(
    /updated: .+/,
    `updated: ${new Date().toISOString()}`
  );

  // Add session to sessions list if not already there
  if (!updated.includes(`  - ${sessionId}`)) {
    updated = updated.replace(
      /(sessions:\n(?:  - .+\n)*)/,
      `$1  - ${sessionId}\n`
    );
  }

  // Add new row to occurrences table
  const newRow = `| ${observation.timestamp.split('T')[0]} | ${sessionId.substring(0, 8)} | ${errorData.context || 'Recurring'} |`;

  const occurrencesHeader = '## Occurrences';
  const headerIndex = updated.indexOf(occurrencesHeader);

  if (headerIndex !== -1) {
    const afterHeader = updated.substring(headerIndex);
    const separatorMatch = afterHeader.match(/\|[-|\s]+\|\n/);

    if (separatorMatch) {
      const separatorEnd = headerIndex + (separatorMatch.index || 0) + separatorMatch[0].length;
      updated = updated.substring(0, separatorEnd) + newRow + '\n' + updated.substring(separatorEnd);
    }
  }

  fs.writeFileSync(filePath, updated);
}

/**
 * Process a file edit observation
 */
async function processFileEdit(
  observation: Observation,
  project: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const vault = new VaultManager(config.vault.path, config.vault.memFolder);
  const fileData = observation.data as { path: string; language?: string; changeType?: string };
  const fileHash = hashFilePath(fileData.path);

  const projectPath = path.join(
    vault.getMemPath(),
    'projects',
    sanitizeProjectName(project),
    'patterns'
  );

  // Ensure directory exists
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

  const knowledgeFilePath = path.join(projectPath, `${fileHash}.md`);

  if (fs.existsSync(knowledgeFilePath)) {
    await updateFileKnowledge(knowledgeFilePath, observation, sessionId);
  } else {
    await createFileKnowledge(knowledgeFilePath, observation, project, sessionId);
  }
}

/**
 * Create a new file knowledge note
 */
async function createFileKnowledge(
  filePath: string,
  observation: Observation,
  project: string,
  sessionId: string
): Promise<void> {
  const config = loadConfig();
  const fileData = observation.data as { path: string; language?: string; changeType?: string };

  // Parent link to patterns category index (patterns/patterns.md)
  const parentLink = `[[${config.vault.memFolder}/projects/${sanitizeProjectName(project)}/patterns/patterns]]`;

  const frontmatter = `---
type: file
title: "${path.basename(fileData.path).replace(/"/g, '\\"')}"
project: ${project}
created: ${new Date().toISOString()}
updated: ${new Date().toISOString()}
tags:
  - file
  - lang/${fileData.language || 'unknown'}
  - project/${sanitizeProjectName(project)}
parent: "${parentLink}"
file_path: ${fileData.path}
file_hash: ${path.basename(filePath, '.md')}
language: ${fileData.language || 'unknown'}
edit_count: 1
last_edited: ${observation.timestamp}
---

`;

  const content = `# File: ${fileData.path}

## Purpose

_File purpose not yet documented_

## Edit History

| Date | Session | Change Summary |
|------|---------|----------------|
| ${observation.timestamp.split('T')[0]} | ${sessionId.substring(0, 8)} | ${fileData.changeType || 'Modified'} |

## Notes

_No notes yet_
`;

  fs.writeFileSync(filePath, frontmatter + content);
}

/**
 * Update existing file knowledge
 */
async function updateFileKnowledge(
  filePath: string,
  observation: Observation,
  sessionId: string
): Promise<void> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fileData = observation.data as { path: string; changeType?: string };

  let updated = raw;

  // Update edit_count
  const editCountMatch = updated.match(/edit_count: (\d+)/);
  if (editCountMatch) {
    const count = parseInt(editCountMatch[1], 10) + 1;
    updated = updated.replace(/edit_count: \d+/, `edit_count: ${count}`);
  }

  // Update last_edited
  updated = updated.replace(
    /last_edited: .+/,
    `last_edited: ${observation.timestamp}`
  );

  // Update updated timestamp
  updated = updated.replace(
    /updated: .+/,
    `updated: ${new Date().toISOString()}`
  );

  // Add new row to edit history
  const newRow = `| ${observation.timestamp.split('T')[0]} | ${sessionId.substring(0, 8)} | ${fileData.changeType || 'Modified'} |`;

  const tableMatch = updated.match(/(\| Date \| Session \| Change Summary \|\n\|[-|\s]+\|)/);
  if (tableMatch) {
    const insertPos = updated.indexOf(tableMatch[0]) + tableMatch[0].length;
    updated = updated.substring(0, insertPos) + '\n' + newRow + updated.substring(insertPos);
  }

  fs.writeFileSync(filePath, updated);
}

/**
 * Hash an error for deduplication
 */
function hashError(error: ErrorData): string {
  const key = `${error.type || ''}:${error.message || ''}:${error.file || ''}`;
  return crypto.createHash('md5').update(key).digest('hex').substring(0, 12);
}

/**
 * Hash a file path for note naming
 */
function hashFilePath(filePath: string): string {
  return crypto.createHash('md5').update(filePath).digest('hex').substring(0, 12);
}

// Error category patterns: [category, keywords to check in type/message]
const ERROR_CATEGORIES: Array<[string, string[]]> = [
  ['syntax', ['syntax']],
  ['type', ['type']],
  ['reference', ['reference', 'undefined']],
  ['network', ['network', 'fetch', 'connection']],
  ['permission', ['permission', 'access denied']],
  ['not-found', ['not found', 'enoent']],
];

/**
 * Categorize an error type
 */
function categorizeError(error: ErrorData): string {
  const text = `${error.type || ''} ${error.message || ''}`.toLowerCase();

  for (const [category, keywords] of ERROR_CATEGORIES) {
    if (keywords.some(keyword => text.includes(keyword))) {
      return category;
    }
  }

  return 'general';
}

const EXPLORATION_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/**
 * Check if a tool is an exploration tool
 */
function isExplorationTool(toolName: string): boolean {
  return EXPLORATION_TOOLS.has(toolName);
}

// Patterns for sensitive files that should not be logged
const SENSITIVE_FILE_PATTERNS = [
  /\.ssh/i,
  /\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /\.git\/config$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /credentials\.json$/i,
  /secrets\./i,
];

/**
 * Sanitize file path: convert absolute to project-relative and filter sensitive patterns
 * CRITICAL: Only store paths, never content. Reject paths with '..' or outside project.
 */
function sanitizePath(absolutePath: string, projectPath: string): string | null {
  const absPath = path.isAbsolute(absolutePath)
    ? absolutePath
    : path.resolve(projectPath, absolutePath);

  const relativePath = path.relative(projectPath, absPath);

  // Reject path traversal attempts
  if (relativePath.startsWith('..') || relativePath.includes('/..') || relativePath.includes('\\..')) {
    return null;
  }

  // Reject sensitive file patterns
  if (SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(relativePath))) {
    return null;
  }

  return relativePath;
}

/**
 * Extract text content from tool response
 * Handles different response structures: content array, direct string, tool_result field, or env var
 *
 * Claude Code hooks provide tool output in multiple ways:
 * 1. content array (standard API format): { content: [{ type: 'text', text: '...' }] }
 * 2. Direct string content: { content: '...' }
 * 3. tool_result field on input
 * 4. $CLAUDE_TOOL_OUTPUT environment variable (PostToolUse only)
 * 5. Response may also have type-specific fields like 'file', 'matches', etc.
 */
function getToolOutputText(response: PostToolUseInput['tool_response'], input?: PostToolUseInput): string {
  // Handle content array (standard API format)
  if (response?.content && Array.isArray(response.content)) {
    return response.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }

  // Handle direct string content
  if (typeof response?.content === 'string') {
    return response.content;
  }

  // Check for tool_result field (documented in Claude Code hooks)
  if (input && typeof (input as any).tool_result === 'string') {
    return (input as any).tool_result;
  }

  // Try $CLAUDE_TOOL_OUTPUT environment variable (available for PostToolUse events)
  const envOutput = process.env.CLAUDE_TOOL_OUTPUT;
  if (envOutput) {
    return envOutput;
  }

  // Handle response with 'output' field (some tools use this)
  if (response && typeof (response as any).output === 'string') {
    return (response as any).output;
  }

  // Handle response with 'text' field directly
  if (response && typeof (response as any).text === 'string') {
    return (response as any).text;
  }

  return '';
}

/**
 * Extract exploration data from tool input/output
 * CRITICAL: Only extract paths, patterns, and counts - NEVER store content
 */
function extractExplorationData(
  input: PostToolUseInput,
  projectPath: string,
  logger: ReturnType<typeof createLogger>
): ExplorationData | null {
  const { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse } = input;

  try {
    switch (toolName) {
      case 'Read': {
        const filePath = toolInput.file_path as string | undefined;
        if (!filePath) return null;

        const sanitized = sanitizePath(filePath, projectPath);
        if (!sanitized) {
          logger.debug('Path rejected by sanitization', { path: filePath });
          return null;
        }

        return { action: 'read', paths: [sanitized] };
      }

      case 'Grep': {
        const pattern = toolInput.pattern as string | undefined;
        if (!pattern) return null;

        const uniquePaths = new Set<string>();

        // Try to get file matches from response structure first
        // Claude Code might return matches in a structured format
        const matches = (toolResponse as any).matches as Array<{ file: string }> | undefined;
        const files = (toolResponse as any).files as string[] | undefined;

        if (Array.isArray(matches)) {
          for (const match of matches) {
            if (match.file) {
              const sanitized = sanitizePath(match.file, projectPath);
              if (sanitized) uniquePaths.add(sanitized);
            }
          }
          logger.debug('Grep extracted from matches field', { count: uniquePaths.size });
        } else if (Array.isArray(files)) {
          for (const file of files) {
            const sanitized = sanitizePath(file, projectPath);
            if (sanitized) uniquePaths.add(sanitized);
          }
          logger.debug('Grep extracted from files field', { count: uniquePaths.size });
        } else {
          // Fallback: Extract file paths from text output (format: "path/to/file:line_number:...")
          const outputText = getToolOutputText(toolResponse, input);
          if (outputText) {
            for (const match of outputText.matchAll(/^([^:]+):\d+:/gm)) {
              const sanitized = match[1] ? sanitizePath(match[1], projectPath) : null;
              if (sanitized) uniquePaths.add(sanitized);
            }
            logger.debug('Grep extracted from text output', { count: uniquePaths.size });
          } else {
            logger.debug('Grep: no matches, files, or text output available');
          }
        }

        return {
          action: 'search',
          query: pattern,
          paths: Array.from(uniquePaths),
          results_count: uniquePaths.size,
        };
      }

      case 'Glob': {
        const pattern = toolInput.pattern as string | undefined;
        if (!pattern) return null;

        // Claude Code returns filenames directly in tool_response.filenames array
        const filenames = (toolResponse as any).filenames as string[] | undefined;
        let paths: string[] = [];

        if (Array.isArray(filenames)) {
          // Use the filenames array directly from the response
          paths = filenames
            .map(f => sanitizePath(f, projectPath))
            .filter((p): p is string => p !== null);
          logger.debug('Glob extracted from filenames field', { count: paths.length });
        } else {
          // Fallback: try to parse text output (for compatibility)
          const outputText = getToolOutputText(toolResponse, input);
          if (outputText) {
            paths = outputText
              .split('\n')
              .map(line => line.trim())
              .filter(Boolean)
              .map(line => sanitizePath(line, projectPath))
              .filter((p): p is string => p !== null);
            logger.debug('Glob extracted from text output', { count: paths.length });
          } else {
            logger.debug('Glob: no filenames or text output available');
          }
        }

        return {
          action: 'glob',
          patterns: [pattern],
          paths,
          results_count: paths.length,
        };
      }

      default:
        return null;
    }
  } catch (error) {
    logger.error('Error extracting exploration data', error instanceof Error ? error : undefined);
    return null;
  }
}

main();
