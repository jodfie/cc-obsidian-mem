import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FixEngine } from '../src/mcp-server/utils/fix-engine.js';
import { AuditEngine } from '../src/mcp-server/utils/audit-engine.js';

// Create a temp directory for testing
let tempDir: string;
let vaultPath: string;
let memFolder: string;
let fixEngine: FixEngine;
let auditEngine: AuditEngine;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-test-'));
  vaultPath = tempDir;
  memFolder = '_claude-mem';
  const memPath = path.join(vaultPath, memFolder);
  fs.mkdirSync(memPath, { recursive: true });
  fixEngine = new FixEngine(vaultPath, memFolder);
  auditEngine = new AuditEngine(vaultPath, memFolder);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Helper to create a note with frontmatter
 */
function createNote(notePath: string, frontmatter: Record<string, unknown>, content: string): void {
  const dir = path.dirname(notePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}:\n${value.map(v => `  - ${v}`).join('\n')}`;
      }
      if (typeof value === 'string' && value.includes('\n')) {
        return `${key}: |\n  ${value.replace(/\n/g, '\n  ')}`;
      }
      return `${key}: ${JSON.stringify(value)}`;
    })
    .join('\n');

  const fullContent = `---\n${yaml}\n---\n\n${content}`;
  fs.writeFileSync(notePath, fullContent);
}

/**
 * Helper to read frontmatter from a note
 */
function readFrontmatter(notePath: string): Record<string, unknown> {
  const content = fs.readFileSync(notePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      result[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return result;
}

describe('FixEngine', () => {
  describe('applyFixes() - dry run mode', () => {
    test('dry run does not modify files', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'dry-run-test');

      createNote(
        path.join(projectDir, 'research', 'note-with-broken-link.md'),
        {
          type: 'learning',
          title: 'Note with Broken Link',
          project: 'dry-run-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
        },
        'This links to [[non-existent-note]] which does not exist.'
      );

      // Get original content
      const notePath = path.join(projectDir, 'research', 'note-with-broken-link.md');
      const originalContent = fs.readFileSync(notePath, 'utf-8');

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'dry-run-test',
        categories: ['broken_link'],
      });

      // Apply fixes in dry run mode
      const results = await fixEngine.applyFixes(auditResult.issues, {
        project: 'dry-run-test',
        dryRun: true,
      });

      // File should not be modified
      const newContent = fs.readFileSync(notePath, 'utf-8');
      expect(newContent).toBe(originalContent);

      // Results should still report success for dry run
      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain('Would remove');
    });
  });

  describe('remove_link fix', () => {
    test('removes broken wikilink', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'remove-link-test');

      createNote(
        path.join(projectDir, 'research', 'note.md'),
        {
          type: 'learning',
          title: 'Note',
          project: 'remove-link-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
        },
        'Before [[broken-link]] after.'
      );

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'remove-link-test',
        categories: ['broken_link'],
      });

      expect(auditResult.issues.length).toBe(1);

      // Apply fix
      const results = await fixEngine.applyFixes(auditResult.issues, {
        project: 'remove-link-test',
        dryRun: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      // Verify link was removed
      const notePath = path.join(projectDir, 'research', 'note.md');
      const content = fs.readFileSync(notePath, 'utf-8');
      expect(content).not.toContain('[[broken-link]]');
      expect(content).toContain('Before  after.'); // Link removed, spaces remain
    });

    test('removes embedded wikilink', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'embed-test');

      createNote(
        path.join(projectDir, 'research', 'note.md'),
        {
          type: 'learning',
          title: 'Note',
          project: 'embed-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
        },
        'Here is an embed: ![[broken-image.png]]'
      );

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'embed-test',
        categories: ['broken_link'],
      });

      expect(auditResult.issues.length).toBe(1);

      // Apply fix
      const results = await fixEngine.applyFixes(auditResult.issues, {
        project: 'embed-test',
        dryRun: false,
      });

      expect(results[0].success).toBe(true);

      // Verify embed was removed
      const notePath = path.join(projectDir, 'research', 'note.md');
      const content = fs.readFileSync(notePath, 'utf-8');
      expect(content).not.toContain('![[broken-image.png]]');
    });
  });

  describe('add_parent fix', () => {
    test('adds parent link to orphan note', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'parent-test');

      createNote(
        path.join(projectDir, 'research', 'orphan-note.md'),
        {
          type: 'learning',
          title: 'Orphan Note',
          project: 'parent-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
          // No parent!
        },
        'Orphan content.'
      );

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'parent-test',
        categories: ['orphan_note'],
      });

      const orphanIssues = auditResult.issues.filter(i => i.category === 'orphan_note');
      expect(orphanIssues.length).toBe(1);

      // Apply fix
      const results = await fixEngine.applyFixes(orphanIssues, {
        project: 'parent-test',
        dryRun: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      // Verify parent was added
      const notePath = path.join(projectDir, 'research', 'orphan-note.md');
      const content = fs.readFileSync(notePath, 'utf-8');
      expect(content).toContain('parent:');
      expect(content).toContain('research/research');
    });
  });

  describe('create_index fix', () => {
    test('creates missing category index', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'index-test');

      // Create decisions folder with a note but no index
      createNote(
        path.join(projectDir, 'decisions', 'some-decision.md'),
        {
          type: 'decision',
          title: 'Some Decision',
          project: 'index-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
        },
        'Decision content.'
      );

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'index-test',
        categories: ['missing_index'],
      });

      const missingIndexIssues = auditResult.issues.filter(i => i.category === 'missing_index');
      expect(missingIndexIssues.length).toBe(1);

      // Apply fix
      const results = await fixEngine.applyFixes(missingIndexIssues, {
        project: 'index-test',
        dryRun: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);

      // Verify index was created
      const indexPath = path.join(projectDir, 'decisions', 'decisions.md');
      expect(fs.existsSync(indexPath)).toBe(true);

      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('# Decisions');
      expect(content).toContain('type: decision');
    });
  });

  describe('rebuild_index fix', () => {
    test('rebuilds stale index', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'rebuild-test');
      fs.mkdirSync(projectDir, { recursive: true });

      // Create an index with old timestamp (not marked stale, but outdated)
      const indexPath = path.join(projectDir, '_index.json');
      const oldIndex = {
        version: 1,
        updated: '2020-01-01T00:00:00.000Z', // Very old date
        project: 'rebuild-test',
        stale: false,
        stats: { total_notes: 0, by_type: {}, by_status: {} },
        notes: [],
      };
      fs.writeFileSync(indexPath, JSON.stringify(oldIndex, null, 2));

      // Create a note (will have current mtime, newer than index)
      createNote(
        path.join(projectDir, 'test-note.md'),
        {
          type: 'learning',
          title: 'Test Note',
          project: 'rebuild-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
        },
        'Content.'
      );

      // Run audit to find stale index
      const auditResult = await auditEngine.audit({
        project: 'rebuild-test',
        categories: ['index_stale'],
      });

      const staleIssues = auditResult.issues.filter(i => i.category === 'index_stale');

      // If no stale issues found, the index was auto-rebuilt during audit
      // This is expected behavior - test passes if either:
      // 1. Stale issue found and fixed
      // 2. Index was auto-rebuilt during audit
      if (staleIssues.length > 0) {
        // Apply fix
        const results = await fixEngine.applyFixes(staleIssues, {
          project: 'rebuild-test',
          dryRun: false,
        });

        expect(results.length).toBe(1);
        expect(results[0].success).toBe(true);
      }

      // Either way, verify index is now up to date
      const newContent = fs.readFileSync(indexPath, 'utf-8');
      const newIndex = JSON.parse(newContent);
      expect(newIndex.stale).toBe(false);
      expect(newIndex.notes.length).toBe(1);
    });
  });

  describe('filtering fixes', () => {
    test('only applies fixes for specified issue IDs', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'filter-test');

      // Create two notes with broken links
      const note1Path = path.join(projectDir, 'research', 'note1.md');
      const note2Path = path.join(projectDir, 'research', 'note2.md');

      createNote(
        note1Path,
        {
          type: 'learning',
          title: 'Note 1',
          project: 'filter-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: ['test'],
        },
        'Link to [[broken1]].'
      );

      createNote(
        note2Path,
        {
          type: 'learning',
          title: 'Note 2',
          project: 'filter-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: ['test'],
        },
        'Link to [[broken2]].'
      );

      // Store original content of note2
      const originalNote2Content = fs.readFileSync(note2Path, 'utf-8');
      expect(originalNote2Content).toContain('[[broken2]]');

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'filter-test',
        categories: ['broken_link'],
      });

      expect(auditResult.issues.length).toBe(2);

      // Verify issue IDs are different
      expect(auditResult.issues[0].id).not.toBe(auditResult.issues[1].id);

      // Find the issue for note1 specifically (issues may be in any order)
      const note1Issue = auditResult.issues.find(i =>
        i.notePath.includes('note1') && i.details.link === 'broken1'
      );
      expect(note1Issue).toBeDefined();

      // Apply fix for only note1's issue
      const results = await fixEngine.applyFixes(auditResult.issues, {
        project: 'filter-test',
        issueIds: [note1Issue!.id],
        dryRun: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].issueId).toBe(note1Issue!.id);
      expect(results[0].success).toBe(true);

      // Note1 should have the broken link removed
      const note1Content = fs.readFileSync(note1Path, 'utf-8');
      expect(note1Content).not.toContain('[[broken1]]');

      // Note2 should still have the broken link (unchanged)
      const note2Content = fs.readFileSync(note2Path, 'utf-8');
      expect(note2Content).toContain('[[broken2]]');
    });

    test('only applies auto-fixable issues by default', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'auto-fix-test');

      // Create a superseded note without superseded_by (not auto-fixable)
      createNote(
        path.join(projectDir, 'research', 'superseded-note.md'),
        {
          type: 'learning',
          title: 'Superseded Note',
          project: 'auto-fix-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
          status: 'superseded',
          // Missing superseded_by - requires manual input
        },
        'Old content.'
      );

      // Run audit
      const auditResult = await auditEngine.audit({
        project: 'auto-fix-test',
        categories: ['supersession_inconsistent'],
      });

      const supersessionIssues = auditResult.issues.filter(i => i.category === 'supersession_inconsistent');
      expect(supersessionIssues.length).toBe(1);
      expect(supersessionIssues[0].suggestedFix?.autoFixable).toBe(false);

      // Apply fixes (should skip non-auto-fixable)
      const results = await fixEngine.applyFixes(supersessionIssues, {
        project: 'auto-fix-test',
        dryRun: false,
      });

      // No fixes should be applied (it's not auto-fixable)
      expect(results.length).toBe(0);
    });
  });

  describe('rebuildIndexes option', () => {
    test('rebuilds indexes after fixes when requested', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'rebuild-after-test');

      // Create a note with a broken link
      createNote(
        path.join(projectDir, 'research', 'note.md'),
        {
          type: 'learning',
          title: 'Note',
          project: 'rebuild-after-test',
          created: '2026-01-13T10:00:00.000Z',
          tags: [],
        },
        'Link to [[broken]].'
      );

      // Run audit and apply fix with rebuildIndexes
      const auditResult = await auditEngine.audit({
        project: 'rebuild-after-test',
        categories: ['broken_link'],
      });

      await fixEngine.applyFixes(auditResult.issues, {
        project: 'rebuild-after-test',
        dryRun: false,
        rebuildIndexes: true,
      });

      // Verify index was rebuilt
      const indexPath = path.join(projectDir, '_index.json');
      expect(fs.existsSync(indexPath)).toBe(true);
    });
  });
});
