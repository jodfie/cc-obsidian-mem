import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContentValidator } from '../src/mcp-server/utils/content-validator.js';

// Create a temp directory for testing
let tempDir: string;
let vaultPath: string;
let memFolder: string;
let projectRoot: string;
let validator: ContentValidator;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-test-'));
  vaultPath = path.join(tempDir, 'vault');
  memFolder = '_claude-mem';
  projectRoot = path.join(tempDir, 'project');

  // Create directories
  fs.mkdirSync(path.join(vaultPath, memFolder), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  validator = new ContentValidator(vaultPath, memFolder, projectRoot);
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

describe('ContentValidator', () => {
  describe('validate() - basic functionality', () => {
    test('returns empty results for non-existent project', async () => {
      const result = await validator.validate({
        project: 'non-existent',
      });

      expect(result.notes_checked).toBe(0);
      expect(result.stale_count).toBe(0);
      expect(result.results.length).toBe(0);
    });

    test('handles notes without file references', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'no-refs');

      createNote(
        path.join(projectDir, 'research', 'general-note.md'),
        {
          type: 'learning',
          title: 'General Note',
          project: 'no-refs',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'This note has no file references, just general knowledge.'
      );

      const result = await validator.validate({
        project: 'no-refs',
      });

      expect(result.notes_checked).toBe(1);
      // Note without file references can't be validated
      expect(result.validation_failed_count).toBe(1);
      expect(result.results[0].isStale).toBe(null);
      expect(result.results[0].reason).toContain('No file references');
    });

    test('marks notes stale when referenced files are deleted', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'deleted-files');

      // Create note referencing a non-existent file
      createNote(
        path.join(projectDir, 'research', 'stale-note.md'),
        {
          type: 'learning',
          title: 'Note about deleted file',
          project: 'deleted-files',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'This documents src/utils/helper.ts which has been deleted.'
      );

      const result = await validator.validate({
        project: 'deleted-files',
      });

      expect(result.notes_checked).toBe(1);
      expect(result.stale_count).toBe(1);
      expect(result.results[0].isStale).toBe(true);
      expect(result.results[0].confidence).toBe(1.0);
      expect(result.results[0].reason).toContain('deleted');
    });
  });

  describe('file reference extraction', () => {
    test('extracts file paths from prose (deleted file case)', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'extract-test');

      // DON'T create the referenced file - this tests file extraction without triggering AI
      // When files don't exist, validation returns immediately with stale=true

      createNote(
        path.join(projectDir, 'research', 'test-note.md'),
        {
          type: 'learning',
          title: 'Test Note',
          project: 'extract-test',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'The utility function is defined in src/utils/helper.ts which handles...'
      );

      const result = await validator.validate({
        project: 'extract-test',
      });

      expect(result.notes_checked).toBe(1);
      // File reference should be extracted even though file doesn't exist
      expect(result.results[0].referencedFiles).toContain('src/utils/helper.ts');
      // Should be marked stale because file doesn't exist
      expect(result.results[0].isStale).toBe(true);
    });

    test('extracts multiple file references (deleted files case)', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'multi-ref');

      // DON'T create referenced files - this tests extraction without AI validation

      createNote(
        path.join(projectDir, 'research', 'api-note.md'),
        {
          type: 'learning',
          title: 'API Documentation',
          project: 'multi-ref',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'The API is defined in src/api/routes.ts and src/api/handlers.ts.'
      );

      const result = await validator.validate({
        project: 'multi-ref',
      });

      expect(result.results[0].referencedFiles.length).toBe(2);
      expect(result.results[0].referencedFiles).toContain('src/api/routes.ts');
      expect(result.results[0].referencedFiles).toContain('src/api/handlers.ts');
      // Should be marked stale because files don't exist
      expect(result.results[0].isStale).toBe(true);
    });
  });

  describe('path sanitization security', () => {
    test('rejects path traversal attempts', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'security-test');

      createNote(
        path.join(projectDir, 'research', 'malicious-note.md'),
        {
          type: 'learning',
          title: 'Malicious Note',
          project: 'security-test',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'Try to access ../../../etc/passwd or src/../../../etc/passwd'
      );

      const result = await validator.validate({
        project: 'security-test',
      });

      // Path traversal attempts should be filtered out
      expect(result.results[0].referencedFiles.length).toBe(0);
    });

    test('rejects absolute paths', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'absolute-test');

      createNote(
        path.join(projectDir, 'research', 'absolute-note.md'),
        {
          type: 'learning',
          title: 'Absolute Path Note',
          project: 'absolute-test',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'Located at /etc/passwd and /home/user/.ssh/id_rsa'
      );

      const result = await validator.validate({
        project: 'absolute-test',
      });

      // Absolute paths should be filtered out
      expect(result.results[0].referencedFiles.length).toBe(0);
    });
  });

  describe('filtering options', () => {
    test('respects limit option', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'limit-test');

      // Create multiple notes
      for (let i = 0; i < 5; i++) {
        createNote(
          path.join(projectDir, 'research', `note-${i}.md`),
          {
            type: 'learning',
            title: `Note ${i}`,
            project: 'limit-test',
            created: '2026-01-13T10:00:00.000Z',
            knowledge_type: 'learning',
          },
          `Content for note ${i}`
        );
      }

      const result = await validator.validate({
        project: 'limit-test',
        limit: 2,
      });

      expect(result.notes_checked).toBe(2);
    });

    test('filters by noteType', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'type-filter');

      // Create notes of different types
      createNote(
        path.join(projectDir, 'research', 'qa-note.md'),
        {
          type: 'learning',
          title: 'QA Note',
          project: 'type-filter',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'qa',
        },
        'Q&A content'
      );

      createNote(
        path.join(projectDir, 'research', 'learning-note.md'),
        {
          type: 'learning',
          title: 'Learning Note',
          project: 'type-filter',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'Learning content'
      );

      const result = await validator.validate({
        project: 'type-filter',
        noteType: 'qa',
      });

      expect(result.notes_checked).toBe(1);
      expect(result.results[0].notePath).toContain('qa-note');
    });
  });

  describe('partial file deletion detection', () => {
    test('marks stale when some referenced files are missing', async () => {
      const projectDir = path.join(vaultPath, memFolder, 'projects', 'partial-delete');

      // Create one referenced file, leave the other missing
      fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'src', 'exists.ts'), 'export {}');
      // src/deleted.ts does not exist

      createNote(
        path.join(projectDir, 'research', 'partial-note.md'),
        {
          type: 'learning',
          title: 'Partial Deletion',
          project: 'partial-delete',
          created: '2026-01-13T10:00:00.000Z',
          knowledge_type: 'learning',
        },
        'Uses src/exists.ts and src/deleted.ts for the implementation.'
      );

      const result = await validator.validate({
        project: 'partial-delete',
      });

      expect(result.notes_checked).toBe(1);
      expect(result.stale_count).toBe(1);
      expect(result.results[0].isStale).toBe(true);
      expect(result.results[0].reason).toContain('no longer exist');
    });
  });
});
