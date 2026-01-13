import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendExploration,
  readExplorations,
  getSessionExplorationSummary,
  getExplorationFilePath,
} from '../src/shared/session-store.js';
import type { ExplorationData } from '../src/shared/types.js';

// Create a temp directory for testing
let tempDir: string;
let originalConfigPath: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-test-'));
  originalConfigPath = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(tempDir, 'config.json');

  // Create a minimal config
  const configDir = path.dirname(process.env.CONFIG_PATH);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    process.env.CONFIG_PATH,
    JSON.stringify({ vault: { path: tempDir, memFolder: '_claude-mem' } })
  );
});

afterEach(() => {
  if (originalConfigPath !== undefined) {
    process.env.CONFIG_PATH = originalConfigPath;
  } else {
    delete process.env.CONFIG_PATH;
  }
  // Clean up temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Exploration Capture', () => {
  test('appendExploration creates new file and appends', () => {
    const sessionId = 'test-session-123';
    const exploration: ExplorationData = {
      action: 'read',
      paths: ['src/index.ts'],
    };

    const result = appendExploration(sessionId, exploration);
    expect(result).toBe(true);

    const explorations = readExplorations(sessionId);
    expect(explorations.length).toBe(1);
    expect(explorations[0].action).toBe('read');
    expect(explorations[0].paths).toEqual(['src/index.ts']);
  });

  test('appendExploration appends multiple entries', () => {
    const sessionId = 'test-session-456';

    appendExploration(sessionId, { action: 'read', paths: ['file1.ts'] });
    appendExploration(sessionId, { action: 'search', query: 'function', paths: ['file2.ts'] });
    appendExploration(sessionId, { action: 'glob', patterns: ['**/*.ts'], paths: ['a.ts', 'b.ts'] });

    const explorations = readExplorations(sessionId);
    expect(explorations.length).toBe(3);
  });

  test('appendExploration enforces 5000 entry limit', () => {
    const sessionId = 'test-session-limit';

    // Write entries up to limit
    for (let i = 0; i < 5000; i++) {
      appendExploration(sessionId, { action: 'read', paths: [`file${i}.ts`] });
    }

    // Next append should return false
    const result = appendExploration(sessionId, { action: 'read', paths: ['overflow.ts'] });
    expect(result).toBe(false);

    // Verify count
    const explorations = readExplorations(sessionId);
    expect(explorations.length).toBe(5000);
  });
});

describe('Exploration Summary', () => {
  test('getSessionExplorationSummary aggregates unique paths', () => {
    const sessionId = 'test-session-summary';

    appendExploration(sessionId, { action: 'read', paths: ['src/a.ts'] });
    appendExploration(sessionId, { action: 'read', paths: ['src/b.ts'] });
    appendExploration(sessionId, { action: 'read', paths: ['src/a.ts'] }); // Duplicate

    const summary = getSessionExplorationSummary(sessionId);
    expect(summary.files_read.length).toBe(2);
    expect(summary.files_read).toContain('src/a.ts');
    expect(summary.files_read).toContain('src/b.ts');
    expect(summary.exploration_count).toBe(3);
  });

  test('getSessionExplorationSummary aggregates search patterns', () => {
    const sessionId = 'test-session-patterns';

    appendExploration(sessionId, { action: 'search', query: 'function', paths: [] });
    appendExploration(sessionId, { action: 'search', query: 'class', paths: [] });
    appendExploration(sessionId, { action: 'search', query: 'function', paths: [] }); // Duplicate

    const summary = getSessionExplorationSummary(sessionId);
    expect(summary.patterns_searched.length).toBe(2);
    expect(summary.patterns_searched).toContain('function');
    expect(summary.patterns_searched).toContain('class');
  });

  test('getSessionExplorationSummary returns empty for missing session', () => {
    const summary = getSessionExplorationSummary('nonexistent-session');
    expect(summary.files_read).toEqual([]);
    expect(summary.patterns_searched).toEqual([]);
    expect(summary.exploration_count).toBe(0);
  });
});

describe('Exploration File Path', () => {
  test('getExplorationFilePath returns correct path', () => {
    const filePath = getExplorationFilePath('test-session');
    expect(filePath).toContain('.exploration.jsonl');
  });
});
