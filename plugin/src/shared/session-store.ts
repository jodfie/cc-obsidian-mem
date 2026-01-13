import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Session, Observation } from './types.js';
import { getConfigDir } from './config.js';
import { atomicWriteSync, ensureDir } from './file-utils.js';

/**
 * File-based session store with multi-session support
 *
 * Architecture:
 * - Session metadata: sessions/{safe_id}.json (atomic writes)
 * - Observations: sessions/{safe_id}.observations.jsonl (locked appends)
 *
 * This design allows concurrent observation writes without data loss.
 */

const SESSIONS_DIR = 'sessions';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

export interface SessionMetadata {
  id: string;
  project: string;
  projectPath: string;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  status: 'active' | 'completed' | 'stopped';
  summary?: string;
  lastUpdated: string;
  /** Knowledge paths captured during pre-compact */
  preCompactKnowledge?: string[];
}

/**
 * Get the sessions directory path
 */
export function getSessionsDir(): string {
  return path.join(getConfigDir(), SESSIONS_DIR);
}

/**
 * Convert session ID to a safe filename
 * Uses hash + prefix to avoid collisions while keeping some readability
 */
function safeSessionFilename(sessionId: string): string {
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 16);
  const prefix = sessionId
    .substring(0, 8)
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase() || 'session';
  return `${prefix}_${hash}`;
}

/**
 * Get the path to a session's metadata file
 */
export function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${safeSessionFilename(sessionId)}.json`);
}

/**
 * Get the path to a session's observations file (JSONL format)
 */
function getObservationsFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${safeSessionFilename(sessionId)}.observations.jsonl`);
}

/**
 * Get the path to a session's exploration file (JSONL format)
 */
export function getExplorationFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${safeSessionFilename(sessionId)}.exploration.jsonl`);
}

/**
 * Get the path to a session's lock file
 */
function getLockFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${safeSessionFilename(sessionId)}.lock`);
}

/**
 * Ensure sessions directory exists
 */
function ensureSessionsDir(): void {
  ensureDir(getSessionsDir());
}

/**
 * Simple file-based lock for observation writes
 * Uses exclusive file creation as lock mechanism
 */
function acquireLock(sessionId: string): boolean {
  ensureSessionsDir();
  const lockPath = getLockFilePath(sessionId);
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // O_CREAT | O_EXCL - fails if file exists
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
      fs.closeSync(fd);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Check for stale lock (older than LOCK_TIMEOUT_MS)
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
            // Stale lock, remove it
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock file disappeared, retry
          continue;
        }
        // Wait and retry
        const waitTime = LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS;
        const end = Date.now() + waitTime;
        while (Date.now() < end) {
          // Busy wait (sync sleep)
        }
        continue;
      }
      throw err;
    }
  }
  return false;
}

/**
 * Release the file lock
 */
function releaseLock(sessionId: string): void {
  const lockPath = getLockFilePath(sessionId);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore errors - lock may have been cleaned up
  }
}

/**
 * Read session metadata by ID
 */
function readSessionMetadata(sessionId: string): SessionMetadata | null {
  const metaPath = getSessionFilePath(sessionId);

  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    return JSON.parse(content) as SessionMetadata;
  } catch {
    return null;
  }
}

/**
 * Write session metadata atomically
 */
function writeSessionMetadata(metadata: SessionMetadata): void {
  ensureSessionsDir();
  const metaPath = getSessionFilePath(metadata.id);
  metadata.lastUpdated = new Date().toISOString();
  atomicWriteSync(metaPath, JSON.stringify(metadata, null, 2));
}

/**
 * Read observations from JSONL file
 * Skips malformed lines instead of failing completely
 */
function readObservations(sessionId: string): Observation[] {
  const obsPath = getObservationsFilePath(sessionId);

  if (!fs.existsSync(obsPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(obsPath, 'utf-8');
    const lines = content.split('\n');
    const observations: Observation[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obs = JSON.parse(trimmed) as Observation;
        // Basic validation - ensure required fields exist
        if (obs.id && obs.timestamp && obs.type && obs.tool !== undefined) {
          observations.push(obs);
        }
      } catch {
        // Skip malformed lines - log for debugging
        console.error(`Skipping malformed observation line: ${trimmed.substring(0, 100)}...`);
      }
    }

    return observations;
  } catch {
    return [];
  }
}

/**
 * Append an observation to the JSONL file with locking
 * Uses file locking to prevent interleaving of large writes
 * Returns true on success, false on failure
 */
function appendObservation(sessionId: string, observation: Observation): boolean {
  ensureSessionsDir();

  if (!acquireLock(sessionId)) {
    console.error(`Failed to acquire lock for session ${sessionId}, observation may be lost`);
    return false;
  }

  try {
    const obsPath = getObservationsFilePath(sessionId);
    const line = JSON.stringify(observation) + '\n';
    fs.appendFileSync(obsPath, line, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error(`Failed to write observation for session ${sessionId}:`, error);
    return false;
  } finally {
    releaseLock(sessionId);
  }
}

/**
 * Append an exploration entry to the JSONL file
 * Uses simple append without locking (hooks are single-threaded)
 * Returns true on success, false if size limit exceeded or on error
 */
export function appendExploration(sessionId: string, exploration: import('./types.js').ExplorationData): boolean {
  ensureSessionsDir();

  try {
    const explPath = getExplorationFilePath(sessionId);

    // Check size limit (max 5000 entries)
    if (fs.existsSync(explPath)) {
      const content = fs.readFileSync(explPath, 'utf-8');
      const lineCount = content.split('\n').filter(line => line.trim()).length;
      if (lineCount >= 5000) {
        return false; // Size limit exceeded
      }
    }

    const line = JSON.stringify(exploration) + '\n';
    fs.appendFileSync(explPath, line, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error(`Failed to write exploration for session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Read explorations from JSONL file
 * Skips malformed lines and deduplicates paths/patterns
 */
export function readExplorations(sessionId: string): import('./types.js').ExplorationData[] {
  const explPath = getExplorationFilePath(sessionId);

  if (!fs.existsSync(explPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(explPath, 'utf-8');
    const lines = content.split('\n');
    const explorations: import('./types.js').ExplorationData[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const expl = JSON.parse(trimmed) as import('./types.js').ExplorationData;
        if (expl.action) {
          explorations.push(expl);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return explorations;
  } catch {
    return [];
  }
}

/**
 * Get aggregated exploration summary for a session
 * Deduplicates paths and patterns
 */
export function getSessionExplorationSummary(sessionId: string): import('./types.js').SessionExploration {
  const explorations = readExplorations(sessionId);

  const filesRead = new Set<string>();
  const patternsSearched = new Set<string>();
  const globsMatched = new Set<string>();

  for (const expl of explorations) {
    if (expl.paths) {
      for (const p of expl.paths) {
        if (expl.action === 'read') {
          filesRead.add(p);
        }
      }
    }
    if (expl.query) {
      patternsSearched.add(expl.query);
    }
    if (expl.patterns) {
      for (const pat of expl.patterns) {
        globsMatched.add(pat);
      }
    }
  }

  return {
    files_read: Array.from(filesRead),
    patterns_searched: Array.from(patternsSearched),
    globs_matched: Array.from(globsMatched),
    exploration_count: explorations.length,
  };
}

/**
 * Update last extraction leaf UUID in session metadata (for Phase 6)
 */
export function updateLastExtractionLeafUuid(sessionId: string, leafUuid: string): void {
  const metadata = readSessionMetadata(sessionId);
  if (!metadata) return;

  // Add to metadata (we'll need to extend SessionMetadata type)
  (metadata as SessionMetadata & { lastExtractionLeafUuid?: string }).lastExtractionLeafUuid = leafUuid;
  (metadata as SessionMetadata & { lastExtractionTime?: string }).lastExtractionTime = new Date().toISOString();

  writeSessionMetadata(metadata);
}

/**
 * Get the last activity time for a session (most recent of metadata or observations file)
 */
function getSessionLastActivity(sessionId: string): number {
  let lastActivity = 0;

  const metaPath = getSessionFilePath(sessionId);
  const obsPath = getObservationsFilePath(sessionId);

  try {
    if (fs.existsSync(metaPath)) {
      const stat = fs.statSync(metaPath);
      lastActivity = Math.max(lastActivity, stat.mtimeMs);
    }
  } catch {
    // Ignore
  }

  try {
    if (fs.existsSync(obsPath)) {
      const stat = fs.statSync(obsPath);
      lastActivity = Math.max(lastActivity, stat.mtimeMs);
    }
  } catch {
    // Ignore
  }

  return lastActivity;
}

/**
 * Read a full session by ID (metadata + observations)
 */
export function readSession(sessionId: string): Session | null {
  const metadata = readSessionMetadata(sessionId);
  if (!metadata) {
    return null;
  }

  const observations = readObservations(sessionId);

  // Calculate counters from observations
  const filesModified = new Set<string>();
  let commandsRun = 0;
  let errorsEncountered = 0;

  for (const obs of observations) {
    if (obs.type === 'file_edit') {
      const filePath = (obs.data as { path: string }).path;
      if (filePath) filesModified.add(filePath);
    } else if (obs.type === 'command') {
      commandsRun++;
    }
    if (obs.type === 'error' || obs.isError) {
      errorsEncountered++;
    }
  }

  return {
    id: metadata.id,
    project: metadata.project,
    projectPath: metadata.projectPath,
    startTime: metadata.startTime,
    endTime: metadata.endTime,
    durationMinutes: metadata.durationMinutes,
    status: metadata.status,
    summary: metadata.summary,
    observations,
    filesModified: Array.from(filesModified),
    commandsRun,
    errorsEncountered,
  };
}

/**
 * Start a new session
 */
export function startSession(
  sessionId: string,
  project: string,
  projectPath: string
): Session {
  const metadata: SessionMetadata = {
    id: sessionId,
    project,
    projectPath,
    startTime: new Date().toISOString(),
    status: 'active',
    lastUpdated: new Date().toISOString(),
  };

  writeSessionMetadata(metadata);

  return {
    id: sessionId,
    project,
    projectPath,
    startTime: metadata.startTime,
    status: 'active',
    observations: [],
    filesModified: [],
    commandsRun: 0,
    errorsEncountered: 0,
  };
}

/**
 * Add an observation to a session (with file locking)
 * Returns false if session doesn't exist, is not writable, or write failed
 * Accepts both 'active' and 'stopped' sessions to allow observations
 * from tools that complete after a stop event.
 */
export function addObservation(sessionId: string, observation: Observation): boolean {
  const metadata = readSessionMetadata(sessionId);

  // Allow observations on active or stopped sessions
  // Stopped sessions can still receive observations from in-flight tool completions
  if (!metadata || (metadata.status !== 'active' && metadata.status !== 'stopped')) {
    return false;
  }

  // Append to observations file (with locking for large writes)
  // Returns false if lock acquisition or write fails
  return appendObservation(sessionId, observation);
}

/**
 * End a specific session by ID
 * State transitions:
 * - active + stop -> stopped (can be resumed)
 * - active + end -> completed (final state)
 * - stopped + end -> completed (final state)
 * - stopped + stop -> no change (already stopped)
 * - completed + any -> no change (already completed)
 */
export function endSession(sessionId: string, endType: 'stop' | 'end'): Session | null {
  const metadata = readSessionMetadata(sessionId);

  if (!metadata) {
    return null;
  }

  // Don't re-end an already completed session
  if (metadata.status === 'completed') {
    return readSession(sessionId);
  }

  // If already stopped and receiving another 'stop', no change needed
  if (metadata.status === 'stopped' && endType === 'stop') {
    return readSession(sessionId);
  }

  metadata.endTime = new Date().toISOString();
  metadata.status = endType === 'stop' ? 'stopped' : 'completed';

  // Calculate duration
  const start = new Date(metadata.startTime);
  const end = new Date(metadata.endTime);
  metadata.durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);

  writeSessionMetadata(metadata);
  return readSession(sessionId);
}

/**
 * Reactivate a stopped session (resume after stop event)
 * Used when session-start receives the same session_id for a stopped session.
 * Resets the session to 'active' state, clearing end markers.
 *
 * @param sessionId The session ID to reactivate
 * @param projectName Optional new project name (if user changed directories)
 * @param projectPath Optional new project path
 * @returns true if session was reactivated, false if not found or already active
 */
export function reactivateSession(
  sessionId: string,
  projectName?: string,
  projectPath?: string
): boolean {
  const metadata = readSessionMetadata(sessionId);

  if (!metadata) {
    return false;
  }

  // Don't reactivate if already active
  if (metadata.status === 'active') {
    return false;
  }

  // Don't reactivate completed sessions - they should create a new session
  if (metadata.status === 'completed') {
    return false;
  }

  // Reactivate: set status to active, clear end markers
  metadata.status = 'active';
  delete metadata.endTime;
  delete metadata.durationMinutes;
  metadata.lastUpdated = new Date().toISOString();

  // Update project info if provided and different
  if (projectName && projectName !== metadata.project) {
    metadata.project = projectName;
  }
  if (projectPath && projectPath !== metadata.projectPath) {
    metadata.projectPath = projectPath;
  }

  writeSessionMetadata(metadata);
  return true;
}

/**
 * Update session summary
 */
export function updateSessionSummary(sessionId: string, summary: string): boolean {
  const metadata = readSessionMetadata(sessionId);

  if (!metadata) {
    return false;
  }

  metadata.summary = summary;
  writeSessionMetadata(metadata);
  return true;
}

/**
 * Update pre-compact knowledge paths
 * Called by pre-compact hook to store knowledge captured before compaction
 */
export function updatePreCompactKnowledge(sessionId: string, paths: string[]): boolean {
  const metadata = readSessionMetadata(sessionId);

  if (!metadata) {
    return false;
  }

  // Append to existing paths if any
  metadata.preCompactKnowledge = [
    ...(metadata.preCompactKnowledge || []),
    ...paths,
  ];
  writeSessionMetadata(metadata);
  return true;
}

/**
 * Get pre-compact knowledge paths for a session
 * Waits briefly for any pending background jobs to complete
 */
export function getPreCompactKnowledge(sessionId: string, maxWaitMs: number = 3000): string[] {
  const pendingPath = getPendingFilePath(sessionId);
  const startTime = Date.now();

  // Wait for all pending background jobs to complete (counter reaches 0)
  // Use conservative mode: treat read errors as "still pending" to avoid race
  while (Date.now() - startTime < maxWaitMs) {
    const count = getPendingJobCount(pendingPath, true);
    if (count <= 0) break;

    // Short sleep to avoid busy-waiting
    const end = Date.now() + 100;
    while (Date.now() < end) {
      // Busy wait (sync)
    }
  }

  const metadata = readSessionMetadata(sessionId);
  return metadata?.preCompactKnowledge || [];
}

/**
 * Get the path to a session's pending background job counter file
 */
function getPendingFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${safeSessionFilename(sessionId)}.pending`);
}

/**
 * Get the path to pending job lock file
 */
function getPendingLockPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${safeSessionFilename(sessionId)}.pending.lock`);
}

/**
 * Acquire lock for pending counter operations
 */
function acquirePendingLock(sessionId: string): boolean {
  ensureSessionsDir();
  const lockPath = getPendingLockPath(sessionId);
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
      fs.closeSync(fd);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Check for stale lock
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        // Wait and retry
        const end = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < end) { /* busy wait */ }
        continue;
      }
      throw err;
    }
  }
  return false;
}

/**
 * Release pending counter lock
 */
function releasePendingLock(sessionId: string): void {
  const lockPath = getPendingLockPath(sessionId);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore
  }
}

/**
 * Read the pending job count from file
 * @param conservative If true, returns 1 on read errors (assume pending). Default false for backward compat.
 */
function getPendingJobCount(pendingPath: string, conservative: boolean = false): number {
  try {
    if (!fs.existsSync(pendingPath)) return 0;
    const content = fs.readFileSync(pendingPath, 'utf-8').trim();
    const count = parseInt(content, 10);
    if (isNaN(count)) {
      // Invalid read - could be partial write in progress
      return conservative ? 1 : 0;
    }
    return count;
  } catch {
    // Read error - could be write in progress
    return conservative ? 1 : 0;
  }
}

/**
 * Mark that a background job is starting for this session
 * Uses a counter with locking to handle multiple concurrent jobs
 */
export function markBackgroundJobStarted(sessionId: string): void {
  ensureSessionsDir();
  const pendingPath = getPendingFilePath(sessionId);

  const gotLock = acquirePendingLock(sessionId);
  if (!gotLock) {
    console.warn(`markBackgroundJobStarted: Could not acquire lock for ${sessionId}, skipping`);
    return; // Don't update without lock - could corrupt counter
  }

  try {
    const currentCount = getPendingJobCount(pendingPath);
    fs.writeFileSync(pendingPath, `${currentCount + 1}`);
  } finally {
    releasePendingLock(sessionId);
  }
}

/**
 * Mark that a background job has completed for this session
 * Decrements the counter; removes file when counter reaches 0
 */
export function markBackgroundJobCompleted(sessionId: string): void {
  const pendingPath = getPendingFilePath(sessionId);

  const gotLock = acquirePendingLock(sessionId);
  if (!gotLock) {
    console.warn(`markBackgroundJobCompleted: Could not acquire lock for ${sessionId}, skipping`);
    return; // Don't update without lock - could corrupt counter
  }

  try {
    const currentCount = getPendingJobCount(pendingPath);
    if (currentCount <= 1) {
      // Last job done, remove file
      if (fs.existsSync(pendingPath)) {
        fs.unlinkSync(pendingPath);
      }
    } else {
      // Decrement counter
      fs.writeFileSync(pendingPath, `${currentCount - 1}`);
    }
  } catch {
    // Ignore errors
  } finally {
    releasePendingLock(sessionId);
  }
}

/**
 * Clear session files (after persisting to vault)
 * Waits for pending background jobs to complete before clearing
 */
export function clearSessionFile(sessionId: string, maxWaitMs: number = 5000): void {
  // Wait for pending background jobs to complete before clearing
  // Use conservative mode: treat read errors as "still pending" to avoid race
  const pendingPath = getPendingFilePath(sessionId);
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const count = getPendingJobCount(pendingPath, true);
    if (count <= 0) break;

    // Short sleep to avoid busy-waiting
    const end = Date.now() + 100;
    while (Date.now() < end) { /* busy wait */ }
  }

  // Acquire lock to ensure no writes are in progress
  // If we can't get the lock after timeout, proceed anyway with warning
  const gotLock = acquireLock(sessionId);
  if (!gotLock) {
    console.warn(`clearSessionFile: Could not acquire lock for ${sessionId}, proceeding anyway`);
  }

  try {
    const metaPath = getSessionFilePath(sessionId);
    const obsPath = getObservationsFilePath(sessionId);
    const explPath = getExplorationFilePath(sessionId);
    const lockPath = getLockFilePath(sessionId);
    const pendingLockPath = getPendingLockPath(sessionId);

    // Delete metadata, observations, exploration, pending files and pending lock
    // Note: pendingPath is cleared separately after waiting
    for (const filePath of [metaPath, obsPath, explPath, pendingPath, pendingLockPath]) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore errors
      }
    }

    // Lock file will be released/deleted below
  } finally {
    if (gotLock) {
      releaseLock(sessionId);
    } else {
      // If we didn't get the lock, still try to clean up any stale lock file
      const lockPath = getLockFilePath(sessionId);
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * List all active sessions
 */
export function listActiveSessions(): Session[] {
  const dir = getSessionsDir();

  if (!fs.existsSync(dir)) {
    return [];
  }

  const sessions: Session[] = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const metadata = JSON.parse(content) as SessionMetadata;
      if (metadata.status === 'active') {
        const session = readSession(metadata.id);
        if (session) sessions.push(session);
      }
    } catch {
      // Skip invalid files
    }
  }

  return sessions;
}

/**
 * Clean up stale sessions (older than specified hours)
 * Checks BOTH metadata lastUpdated AND observations file mtime
 */
export function cleanupStaleSessions(maxAgeHours: number = 24): Session[] {
  const dir = getSessionsDir();

  if (!fs.existsSync(dir)) {
    return [];
  }

  const staleSessions: Session[] = [];
  const now = Date.now();
  const maxAge = maxAgeHours * 60 * 60 * 1000;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const metadata = JSON.parse(content) as SessionMetadata;

      // Use the most recent activity time (metadata OR observations file)
      const lastActivity = getSessionLastActivity(metadata.id);

      if (now - lastActivity > maxAge) {
        // Get full session before cleanup
        const session = readSession(metadata.id);
        if (session) {
          if (session.status === 'active') {
            session.status = 'stopped';
            session.endTime = new Date().toISOString();
          }
          staleSessions.push(session);
        }

        // Remove all session files
        clearSessionFile(metadata.id);
      }
    } catch {
      // Skip invalid files
    }
  }

  return staleSessions;
}

// Legacy compatibility
export function readCurrentSession(): Session | null {
  const sessions = listActiveSessions();
  return sessions.length > 0 ? sessions[0] : null;
}
