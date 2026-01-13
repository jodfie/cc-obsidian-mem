#!/usr/bin/env bun

/**
 * Session End Hook
 *
 * Runs when a Claude Code session ends (stop or natural end).
 *
 * Key design:
 * - Sessions are ephemeral - no vault persistence
 * - NO background summarization at session-end (no injection path exists)
 * - Cleans up session file and pending items
 * - Generates/updates project canvases if enabled
 *
 * Note: Knowledge extraction only happens on /compact (pre-compact hook)
 * where there's a subsequent message for pending injection.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, getProjectPath, sanitizeProjectName } from '../../src/shared/config.js';
import { endSession, readSession, clearSessionFile, getSessionExplorationSummary } from '../../src/shared/session-store.js';
import { VaultManager } from '../../src/mcp-server/utils/vault.js';
import { generateProjectCanvases, detectFolder, type CanvasNote } from '../../src/mcp-server/utils/canvas.js';
import { readStdinJson } from './utils/helpers.js';
import { clearPending } from './utils/pending.js';
import { createLogger, cleanupOldLogs } from '../../src/shared/logger.js';
import type { SessionEndInput, Session, SessionExploration } from '../../src/shared/types.js';

async function main() {
  try {
    const args = process.argv.slice(2);
    const endType = (args.find(a => a.startsWith('--type='))?.split('=')[1] || 'end') as 'stop' | 'end';

    const input = await readStdinJson<SessionEndInput>();
    const logger = createLogger('session-end', input.session_id);

    logger.debug('Session end hook triggered', { endType, session_id: input.session_id });

    // Validate session_id from input
    if (!input.session_id) {
      logger.error('No session_id provided');
      return;
    }

    // Verify session exists and belongs to this session_id
    const existingSession = readSession(input.session_id);
    if (!existingSession) {
      logger.error(`Session not found: ${input.session_id}`);
      return;
    }

    // End the specific session by ID
    const session = endSession(input.session_id, endType);
    if (!session) {
      logger.debug('endSession returned null');
      return;
    }

    logger.info(`Session ended`, { project: session.project, endType, duration: session.durationMinutes });

    const config = loadConfig();

    // Create session summary note if session has meaningful content
    try {
      const exploration = getSessionExplorationSummary(input.session_id);
      if (exploration.exploration_count > 0 || session.filesModified.length > 0) {
        const projectPath = getProjectPath(session.project, config);
        await createSessionSummaryNote(session, exploration, projectPath, config.vault.memFolder, logger);
      }
    } catch (summaryError) {
      // Never fail the hook on summary note failure
      logger.error('Session summary note creation failed', summaryError instanceof Error ? summaryError : undefined);
    }

    // Generate/update project canvases if enabled
    if (config.canvas?.enabled) {
      logger.debug('Canvas generation enabled', { updateStrategy: config.canvas.updateStrategy });
      try {
        const vault = new VaultManager(config.vault.path, config.vault.memFolder);
        const notes = await vault.getProjectNotes(session.project);
        logger.debug('Retrieved project notes for canvas', { notesCount: notes.length });

        if (notes.length > 0) {
          const canvasNotes: CanvasNote[] = notes.map((note) => ({
            path: note.path,
            title: note.title,
            folder: detectFolder(note.path),
            status: note.frontmatter.status || 'active',
            created: note.frontmatter.created,
          }));

          const projectPath = getProjectPath(session.project, config);
          const canvasDir = path.join(projectPath, 'canvases');
          const updateStrategy = config.canvas.updateStrategy || 'skip';

          const result = generateProjectCanvases(
            session.project,
            canvasNotes,
            canvasDir,
            updateStrategy,
            false // don't force
          );

          const generated: string[] = [];
          if (result.dashboard) generated.push('dashboard');
          if (result.timeline) generated.push('timeline');
          if (result.graph) generated.push('graph');

          if (generated.length > 0) {
            logger.info(`Updated ${generated.length} canvas(es): ${generated.join(', ')}`);
          }
        }
      } catch (canvasError) {
        logger.error('Canvas generation failed', canvasError instanceof Error ? canvasError : undefined);
      }
    } else {
      logger.debug('Canvas generation disabled in config');
    }

    // Note: We intentionally do NOT spawn background summarization here.
    // Session-end has no injection path - there's no subsequent message
    // where we could inject pending items for Claude to write.
    // Knowledge extraction only happens on /compact (pre-compact hook).

    // Only clear session file and pending on true 'end' events (not 'stop')
    // On 'stop', the user might continue the conversation, so we preserve:
    // - Session file: for pre-compact to read project info
    // - Pending items: for potential resumption
    // Stale sessions are cleaned up after 24h by cleanupStaleSessions
    if (endType === 'end') {
      // Clear any pending knowledge items that were never written
      // (e.g., user ran /compact but didn't write the pending items before ending)
      clearPending(input.session_id);
      logger.debug('Cleared pending knowledge items');

      // Clear the session file
      clearSessionFile(input.session_id);
      logger.debug('Cleared session file');
    } else {
      logger.debug('Session stopped (not ended), preserving session file for potential resumption');
    }

    // Cleanup old session log files (24+ hours old)
    cleanupOldLogs(24);
    logger.debug('Cleaned up old log files');

    logger.info(`Session ${input.session_id.substring(0, 8)} ended successfully`);

  } catch (error) {
    // Silently fail to not break Claude Code (don't use logger here, might not be initialized)
    console.error('Session end hook error:', error);
  }
}

/**
 * Create a session summary note in the vault
 * Includes exploration activity, files modified, and session metadata
 */
async function createSessionSummaryNote(
  session: Session,
  exploration: SessionExploration,
  projectPath: string,
  memFolder: string,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const sessionsDir = path.join(projectPath, 'sessions');

  // Ensure sessions directory exists
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // Generate filename: YYYY-MM-DD_<session_id_short>.md
  const date = new Date(session.startTime).toISOString().split('T')[0];
  const sessionIdShort = session.id.substring(0, 8);
  const filename = `${date}_${sessionIdShort}.md`;
  const notePath = path.join(sessionsDir, filename);

  // Calculate duration
  const durationMinutes = session.durationMinutes || 0;
  const durationStr = durationMinutes > 60
    ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
    : `${durationMinutes}m`;

  // Build frontmatter
  const sanitizedProject = sanitizeProjectName(session.project);
  const frontmatter = {
    type: 'session',
    title: `Session ${sessionIdShort}`,
    project: session.project,
    created: session.startTime,
    ended: session.endTime || new Date().toISOString(),
    duration_minutes: durationMinutes,
    status: session.status,
    files_modified: session.filesModified.length,
    commands_run: session.commandsRun,
    errors_encountered: session.errorsEncountered,
    exploration_count: exploration.exploration_count,
    parent: `[[${memFolder}/projects/${sanitizedProject}/${sanitizedProject}]]`,
  };

  // Build content
  const contentSections: string[] = [];

  // Summary section
  contentSections.push(`# Session ${sessionIdShort}\n`);
  contentSections.push(`**Project**: ${session.project}`);
  contentSections.push(`**Duration**: ${durationStr}`);
  contentSections.push(`**Date**: ${date}\n`);

  // Files modified
  if (session.filesModified.length > 0) {
    contentSections.push(`## Files Modified (${session.filesModified.length})\n`);
    contentSections.push(session.filesModified.slice(0, 20).map(f => `- ${f}`).join('\n'));
    if (session.filesModified.length > 20) {
      contentSections.push(`\n... and ${session.filesModified.length - 20} more files`);
    }
    contentSections.push('');
  }

  // Codebase exploration
  if (exploration.exploration_count > 0) {
    contentSections.push(`## Codebase Exploration\n`);

    if (exploration.files_read.length > 0) {
      contentSections.push(`### Files Examined (${exploration.files_read.length})`);
      contentSections.push(exploration.files_read.slice(0, 15).map(f => `- ${f}`).join('\n'));
      if (exploration.files_read.length > 15) {
        contentSections.push(`... and ${exploration.files_read.length - 15} more files`);
      }
      contentSections.push('');
    }

    if (exploration.patterns_searched.length > 0) {
      contentSections.push(`### Search Patterns (${exploration.patterns_searched.length})`);
      contentSections.push(exploration.patterns_searched.slice(0, 10).map(p => `- \`${p}\``).join('\n'));
      if (exploration.patterns_searched.length > 10) {
        contentSections.push(`... and ${exploration.patterns_searched.length - 10} more patterns`);
      }
      contentSections.push('');
    }

    if (exploration.globs_matched.length > 0) {
      contentSections.push(`### Glob Patterns (${exploration.globs_matched.length})`);
      contentSections.push(exploration.globs_matched.slice(0, 10).map(p => `- \`${p}\``).join('\n'));
      contentSections.push('');
    }
  }

  // Session statistics
  contentSections.push(`## Statistics\n`);
  contentSections.push(`- Commands run: ${session.commandsRun}`);
  contentSections.push(`- Errors encountered: ${session.errorsEncountered}`);
  contentSections.push(`- Exploration actions: ${exploration.exploration_count}`);

  // Build final content with YAML frontmatter
  const yamlFrontmatter = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return `${key}: "${value}"`;
      }
      return `${key}: ${value}`;
    })
    .join('\n');

  const fullContent = `---\n${yamlFrontmatter}\n---\n\n${contentSections.join('\n')}`;

  // Write the note
  fs.writeFileSync(notePath, fullContent, 'utf-8');
  logger.info(`Created session summary note: ${filename}`);
}

main();
