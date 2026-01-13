import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IndexManager, type ProjectIndex, type IndexEntry } from '../src/mcp-server/utils/index-manager.js';

// Create a temp directory for testing
let tempDir: string;
let indexManager: IndexManager;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-test-'));
  indexManager = new IndexManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('IndexManager', () => {
  test('getIndexPath returns correct path', () => {
    const indexPath = indexManager.getIndexPath('my-project');
    expect(indexPath).toBe(path.join(tempDir, 'projects', 'my-project', '_index.json'));
  });

  test('rebuildProjectIndex creates index from notes', async () => {
    const projectName = 'test-project';
    const projectDir = path.join(tempDir, 'projects', projectName);

    // Create project structure
    fs.mkdirSync(path.join(projectDir, 'errors'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'decisions'), { recursive: true });

    // Create sample notes
    const errorNote = `---
type: error
title: "Test Error"
project: ${projectName}
created: "2026-01-13T10:00:00.000Z"
updated: "2026-01-13T10:00:00.000Z"
tags: [typescript, bug]
status: active
---

Error content here.
`;
    fs.writeFileSync(path.join(projectDir, 'errors', '2026-01-13_test-error.md'), errorNote);

    const decisionNote = `---
type: decision
title: "Use TypeScript"
project: ${projectName}
created: "2026-01-12T10:00:00.000Z"
updated: "2026-01-12T10:00:00.000Z"
tags: [typescript, architecture]
status: active
---

Decision content here.
`;
    fs.writeFileSync(path.join(projectDir, 'decisions', '2026-01-12_use-typescript.md'), decisionNote);

    // Rebuild index
    const index = await indexManager.rebuildProjectIndex(projectName);

    expect(index).not.toBeNull();
    expect(index!.project).toBe(projectName);
    expect(index!.version).toBe(1);
    expect(index!.stale).toBe(false);
    expect(index!.stats.total_notes).toBe(2);
    expect(index!.notes.length).toBe(2);

    // Verify notes were indexed
    const errorEntry = index!.notes.find(n => n.title === 'Test Error');
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.type).toBe('error');
    expect(errorEntry!.tags).toContain('typescript');

    const decisionEntry = index!.notes.find(n => n.title === 'Use TypeScript');
    expect(decisionEntry).toBeDefined();
    expect(decisionEntry!.type).toBe('decision');
  });

  test('getProjectIndex auto-rebuilds if index missing', async () => {
    const projectName = 'auto-rebuild-test';
    const projectDir = path.join(tempDir, 'projects', projectName);
    fs.mkdirSync(projectDir, { recursive: true });

    // Create a note without an index
    const note = `---
type: pattern
title: "Test Pattern"
project: ${projectName}
created: "2026-01-13T10:00:00.000Z"
updated: "2026-01-13T10:00:00.000Z"
tags: []
status: active
---

Content.
`;
    fs.writeFileSync(path.join(projectDir, 'test-pattern.md'), note);

    // Get index (should auto-rebuild)
    const index = await indexManager.getProjectIndex(projectName);

    expect(index).not.toBeNull();
    expect(index!.notes.length).toBe(1);
  });

  test('updateIndexEntry adds new note to index', async () => {
    const projectName = 'update-test';
    const projectDir = path.join(tempDir, 'projects', projectName);
    fs.mkdirSync(projectDir, { recursive: true });

    // Create initial index
    await indexManager.rebuildProjectIndex(projectName);

    // Add a new note
    const newNote = `---
type: learning
title: "New Learning"
project: ${projectName}
created: "2026-01-14T10:00:00.000Z"
updated: "2026-01-14T10:00:00.000Z"
tags: [new]
status: active
---

New content.
`;
    const notePath = path.join(projectDir, 'new-learning.md');
    fs.writeFileSync(notePath, newNote);

    // Update index
    await indexManager.updateIndexEntry(notePath);

    // Verify index was updated
    const index = await indexManager.getProjectIndex(projectName);
    expect(index!.notes.length).toBe(1);
    expect(index!.notes[0].title).toBe('New Learning');
  });

  test('markStale sets stale flag', async () => {
    const projectName = 'stale-test';
    const projectDir = path.join(tempDir, 'projects', projectName);
    fs.mkdirSync(projectDir, { recursive: true });

    // Create initial index
    await indexManager.rebuildProjectIndex(projectName);

    // Mark as stale
    indexManager.markStale(projectName);

    // Read raw index file
    const indexPath = indexManager.getIndexPath(projectName);
    const content = fs.readFileSync(indexPath, 'utf-8');
    const index = JSON.parse(content) as ProjectIndex;

    expect(index.stale).toBe(true);
  });

  test('searchByIndex filters by type', async () => {
    const projectName = 'search-test';
    const projectDir = path.join(tempDir, 'projects', projectName);
    fs.mkdirSync(projectDir, { recursive: true });

    // Create notes of different types
    const errorNote = `---
type: error
title: "Test Error"
project: ${projectName}
created: "2026-01-13T10:00:00.000Z"
updated: "2026-01-13T10:00:00.000Z"
tags: []
status: active
---
Error.
`;
    const patternNote = `---
type: pattern
title: "Test Pattern"
project: ${projectName}
created: "2026-01-13T10:00:00.000Z"
updated: "2026-01-13T10:00:00.000Z"
tags: []
status: active
---
Pattern.
`;
    fs.writeFileSync(path.join(projectDir, 'error.md'), errorNote);
    fs.writeFileSync(path.join(projectDir, 'pattern.md'), patternNote);

    // Rebuild index
    await indexManager.rebuildProjectIndex(projectName);

    // Search by type
    const errors = await indexManager.searchByIndex(projectName, { type: 'error' });
    expect(errors.length).toBe(1);
    expect(errors[0].type).toBe('error');
  });

  test('searchByIndex filters by query', async () => {
    const projectName = 'query-test';
    const projectDir = path.join(tempDir, 'projects', projectName);
    fs.mkdirSync(projectDir, { recursive: true });

    const note1 = `---
type: learning
title: "TypeScript Patterns"
project: ${projectName}
created: "2026-01-13T10:00:00.000Z"
tags: [typescript]
status: active
---
TypeScript content.
`;
    const note2 = `---
type: learning
title: "JavaScript Basics"
project: ${projectName}
created: "2026-01-13T10:00:00.000Z"
tags: [javascript]
status: active
---
JavaScript content.
`;
    fs.writeFileSync(path.join(projectDir, 'typescript.md'), note1);
    fs.writeFileSync(path.join(projectDir, 'javascript.md'), note2);

    await indexManager.rebuildProjectIndex(projectName);

    // Search by query
    const results = await indexManager.searchByIndex(projectName, { query: 'typescript' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('TypeScript Patterns');
  });
});
