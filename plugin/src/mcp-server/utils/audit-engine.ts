/**
 * Audit Engine for Knowledge Refinement & Housekeeping
 *
 * Performs structural checks on the vault to identify issues
 * like broken links, orphan notes, missing indexes, etc.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { extractWikilinks } from './wikilinks.js';
import { IndexManager, type ProjectIndex, type IndexEntry } from './index-manager.js';
import { sanitizeProjectName } from '../../shared/config.js';
import { PROJECTS_FOLDER } from '../../shared/constants.js';
import type {
  AuditResult,
  AuditIssue,
  AuditOptions,
  IssueCategory,
  IssueSeverity,
  AuditFix,
} from '../../shared/audit-types.js';
import { createLogger, type Logger } from '../../shared/logger.js';

/**
 * Map of note titles/filenames to their paths
 * Used for wikilink resolution
 */
interface WikilinkMap {
  /** Filename (without .md) to paths */
  byFilename: Map<string, string[]>;
  /** Title to paths */
  byTitle: Map<string, string[]>;
}

/**
 * Required frontmatter fields by note type
 */
const REQUIRED_FRONTMATTER: Record<string, string[]> = {
  error: ['type', 'created'],
  decision: ['type', 'title', 'created'],
  pattern: ['type', 'title', 'created'],
  file: ['type', 'created'],
  learning: ['type', 'created'],
};

/**
 * Category folders and their expected index files
 */
const CATEGORY_FOLDERS = ['errors', 'decisions', 'patterns', 'research'];

export class AuditEngine {
  private memPath: string;
  private vaultPath: string;
  private indexManager: IndexManager;
  private logger: Logger;

  constructor(vaultPath: string, memFolder: string) {
    this.vaultPath = vaultPath;
    this.memPath = path.join(vaultPath, memFolder);
    this.indexManager = new IndexManager(this.memPath);
    this.logger = createLogger('audit-engine');
  }

  /**
   * Run a full audit on a project
   */
  async audit(options: AuditOptions): Promise<AuditResult> {
    const startTime = Date.now();
    const project = sanitizeProjectName(options.project);
    const projectPath = path.join(this.memPath, PROJECTS_FOLDER, project);

    this.logger.info(`Starting audit for project: ${project}`);

    // Initialize result
    const result: AuditResult = {
      project: options.project,
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      stats: {
        total_notes: 0,
        by_severity: { error: 0, warning: 0, info: 0 },
        by_category: {},
      },
      issues: [],
    };

    // Check if project exists
    if (!fs.existsSync(projectPath)) {
      this.logger.info(`Project path does not exist: ${projectPath}`);
      result.duration_ms = Date.now() - startTime;
      return result;
    }

    // Get project index for efficient scanning
    const index = await this.indexManager.getProjectIndex(project);
    if (index) {
      result.stats.total_notes = index.stats.total_notes;
    }

    // Build wikilink map for link resolution
    const wikilinkMap = await this.buildWikilinkMap(projectPath);

    // Determine which checks to run
    const categories = options.categories || [
      'broken_link',
      'orphan_note',
      'missing_index',
      'supersession_inconsistent',
      'index_stale',
      'invalid_frontmatter',
    ];

    // Run structural checks
    const allIssues: AuditIssue[] = [];

    if (categories.includes('broken_link')) {
      const issues = await this.checkBrokenLinks(projectPath, wikilinkMap);
      allIssues.push(...issues);
    }

    if (categories.includes('orphan_note')) {
      const issues = await this.checkOrphanNotes(projectPath);
      allIssues.push(...issues);
    }

    if (categories.includes('missing_index')) {
      const issues = await this.checkMissingIndexes(projectPath, project);
      allIssues.push(...issues);
    }

    if (categories.includes('supersession_inconsistent')) {
      const issues = await this.checkSupersessionConsistency(projectPath, wikilinkMap);
      allIssues.push(...issues);
    }

    if (categories.includes('index_stale')) {
      const issues = await this.checkIndexStaleness(project, index);
      allIssues.push(...issues);
    }

    if (categories.includes('invalid_frontmatter')) {
      const issues = await this.checkFrontmatterValidity(projectPath);
      allIssues.push(...issues);
    }

    // Populate result
    result.issues = allIssues;
    for (const issue of allIssues) {
      result.stats.by_severity[issue.severity]++;
      result.stats.by_category[issue.category] = (result.stats.by_category[issue.category] || 0) + 1;
    }

    result.duration_ms = Date.now() - startTime;
    this.logger.info(`Audit complete: ${allIssues.length} issues found in ${result.duration_ms}ms`);

    return result;
  }

  /**
   * Build a map of note names/titles to paths for wikilink resolution
   */
  private async buildWikilinkMap(projectPath: string): Promise<WikilinkMap> {
    const byFilename = new Map<string, string[]>();
    const byTitle = new Map<string, string[]>();

    const files = this.walkDir(projectPath, '.md');

    for (const file of files) {
      try {
        const relativePath = path.relative(this.vaultPath, file);
        const filename = path.basename(file, '.md').toLowerCase();

        // Add by filename
        const existingByFilename = byFilename.get(filename) || [];
        existingByFilename.push(relativePath);
        byFilename.set(filename, existingByFilename);

        // Parse frontmatter for title
        const content = fs.readFileSync(file, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);

        if (frontmatter.title) {
          const titleLower = frontmatter.title.toLowerCase();
          const existingByTitle = byTitle.get(titleLower) || [];
          existingByTitle.push(relativePath);
          byTitle.set(titleLower, existingByTitle);
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return { byFilename, byTitle };
  }

  /**
   * Resolve a wikilink to a note path
   * Returns null if the link cannot be resolved (broken)
   */
  resolveWikilink(link: string, wikilinkMap: WikilinkMap, contextPath?: string): string | null {
    const linkLower = link.toLowerCase();

    // Try exact filename match first
    const byFilename = wikilinkMap.byFilename.get(linkLower);
    if (byFilename && byFilename.length > 0) {
      // If multiple matches, try to resolve by context
      if (byFilename.length === 1) {
        return byFilename[0];
      }

      // Multiple matches - try to find one in the same folder as context
      if (contextPath) {
        const contextDir = path.dirname(contextPath);
        for (const p of byFilename) {
          if (path.dirname(p) === contextDir) {
            return p;
          }
        }
      }

      // Return first match as fallback
      return byFilename[0];
    }

    // Try title match
    const byTitle = wikilinkMap.byTitle.get(linkLower);
    if (byTitle && byTitle.length > 0) {
      if (byTitle.length === 1) {
        return byTitle[0];
      }

      // Multiple matches - try to resolve by context
      if (contextPath) {
        const contextDir = path.dirname(contextPath);
        for (const p of byTitle) {
          if (path.dirname(p) === contextDir) {
            return p;
          }
        }
      }

      return byTitle[0];
    }

    // Handle links with paths (e.g., [[folder/note]])
    if (link.includes('/')) {
      const fullPath = path.join(this.vaultPath, link + '.md');
      if (fs.existsSync(fullPath)) {
        return path.relative(this.vaultPath, fullPath);
      }

      // Try with memFolder prefix
      const memPath = path.join(this.memPath, link + '.md');
      if (fs.existsSync(memPath)) {
        return path.relative(this.vaultPath, memPath);
      }
    }

    return null;
  }

  /**
   * Check for broken wikilinks
   */
  private async checkBrokenLinks(projectPath: string, wikilinkMap: WikilinkMap): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];
    const files = this.walkDir(projectPath, '.md');

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const { content: bodyContent } = parseFrontmatter(content);
        const links = extractWikilinks(bodyContent);

        const relativePath = path.relative(this.vaultPath, file);

        for (const linkInfo of links) {
          const resolved = this.resolveWikilink(linkInfo.link, wikilinkMap, relativePath);

          if (!resolved) {
            issues.push({
              id: this.generateIssueId('broken_link', relativePath, linkInfo.link),
              category: 'broken_link',
              severity: 'warning',
              notePath: relativePath,
              message: `Broken link: [[${linkInfo.link}]]`,
              details: {
                link: linkInfo.link,
                displayText: linkInfo.displayText,
                isEmbed: linkInfo.isEmbed,
              },
              suggestedFix: {
                type: 'remove_link',
                description: `Remove broken link [[${linkInfo.link}]]`,
                details: { link: linkInfo.link },
                autoFixable: true,
              },
            });
          }
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return issues;
  }

  /**
   * Check for orphan notes (missing parent links)
   */
  private async checkOrphanNotes(projectPath: string): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];
    const files = this.walkDir(projectPath, '.md');

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        const relativePath = path.relative(this.vaultPath, file);
        const filename = path.basename(file, '.md');

        // Skip index files (they don't need parent or are at the top)
        if (frontmatter.tags?.includes('index') || filename === filename.split('/').pop()?.replace('.md', '')) {
          // Check if this is a category index or project index
          const pathParts = relativePath.split(path.sep);
          const projectFolder = pathParts.find((_, i) => pathParts[i - 1] === PROJECTS_FOLDER);
          if (projectFolder && filename === projectFolder) {
            continue; // Project root - no parent needed
          }

          // Check if category index (e.g., decisions/decisions.md)
          const parentFolder = pathParts[pathParts.length - 2];
          if (CATEGORY_FOLDERS.includes(parentFolder) && filename === parentFolder) {
            continue; // Category index - parent should point to project root
          }
        }

        // Regular notes should have a parent
        if (!frontmatter.parent) {
          // Determine expected parent based on path
          const pathParts = relativePath.split(path.sep);
          const categoryIndex = pathParts.findIndex(p => CATEGORY_FOLDERS.includes(p));

          if (categoryIndex !== -1) {
            const category = pathParts[categoryIndex];
            const projectIndex = pathParts.findIndex(p => p === PROJECTS_FOLDER);
            const projectName = pathParts[projectIndex + 1];

            issues.push({
              id: this.generateIssueId('orphan_note', relativePath),
              category: 'orphan_note',
              severity: 'info',
              notePath: relativePath,
              message: 'Note has no parent link (not connected to hierarchy)',
              details: {
                expectedParent: `${category}/${category}`,
              },
              suggestedFix: {
                type: 'add_parent',
                description: `Add parent link to ${category} index`,
                details: {
                  parentPath: `${this.memPath.split(path.sep).pop()}/${PROJECTS_FOLDER}/${projectName}/${category}/${category}`,
                },
                autoFixable: true,
              },
            });
          }
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return issues;
  }

  /**
   * Check for missing category index files
   */
  private async checkMissingIndexes(projectPath: string, projectName: string): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    for (const category of CATEGORY_FOLDERS) {
      const categoryPath = path.join(projectPath, category);
      if (!fs.existsSync(categoryPath)) {
        continue; // Category folder doesn't exist - not an issue
      }

      const indexPath = path.join(categoryPath, `${category}.md`);
      if (!fs.existsSync(indexPath)) {
        const relativePath = path.relative(this.vaultPath, categoryPath);

        issues.push({
          id: this.generateIssueId('missing_index', relativePath),
          category: 'missing_index',
          severity: 'warning',
          notePath: relativePath,
          message: `Missing index file: ${category}/${category}.md`,
          details: {
            category,
            expectedPath: `${category}/${category}.md`,
          },
          suggestedFix: {
            type: 'create_index',
            description: `Create ${category} index file`,
            details: {
              category,
              projectName,
            },
            autoFixable: true,
          },
        });
      }
    }

    return issues;
  }

  /**
   * Check supersession consistency
   * - Superseded notes should have superseded_by
   * - New notes with supersedes should point to notes marked as superseded
   */
  private async checkSupersessionConsistency(projectPath: string, wikilinkMap: WikilinkMap): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];
    const files = this.walkDir(projectPath, '.md');

    // First pass: collect all supersession relationships
    const supersededNotes = new Map<string, { supersededBy?: string; path: string }>();
    const supersedingNotes = new Map<string, { supersedes: string[]; path: string }>();

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        const relativePath = path.relative(this.vaultPath, file);

        if (frontmatter.status === 'superseded') {
          supersededNotes.set(relativePath, {
            supersededBy: frontmatter.superseded_by as string | undefined,
            path: relativePath,
          });
        }

        if (frontmatter.supersedes && Array.isArray(frontmatter.supersedes)) {
          supersedingNotes.set(relativePath, {
            supersedes: frontmatter.supersedes as string[],
            path: relativePath,
          });
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    // Check superseded notes have superseded_by
    for (const [notePath, info] of supersededNotes) {
      if (!info.supersededBy) {
        issues.push({
          id: this.generateIssueId('supersession_inconsistent', notePath, 'missing_by'),
          category: 'supersession_inconsistent',
          severity: 'warning',
          notePath,
          message: 'Note marked as superseded but missing superseded_by link',
          details: {
            status: 'superseded',
            missingField: 'superseded_by',
          },
          suggestedFix: {
            type: 'update_frontmatter',
            description: 'Add superseded_by link (requires manual input)',
            details: { field: 'superseded_by' },
            autoFixable: false,
          },
        });
      }
    }

    // Check superseding notes point to actually superseded notes
    for (const [notePath, info] of supersedingNotes) {
      for (const supersededLink of info.supersedes) {
        // Extract link target from wikilink format
        const linkMatch = supersededLink.match(/\[\[([^\]|]+)/);
        const linkTarget = linkMatch ? linkMatch[1] : supersededLink;

        const resolved = this.resolveWikilink(linkTarget, wikilinkMap, notePath);
        if (resolved) {
          const supersededInfo = supersededNotes.get(resolved);
          if (!supersededInfo) {
            issues.push({
              id: this.generateIssueId('supersession_inconsistent', notePath, linkTarget),
              category: 'supersession_inconsistent',
              severity: 'info',
              notePath,
              message: `Note claims to supersede [[${linkTarget}]] but that note is not marked as superseded`,
              details: {
                supersedesLink: linkTarget,
                resolvedPath: resolved,
              },
              suggestedFix: {
                type: 'update_frontmatter',
                description: `Mark ${linkTarget} as superseded`,
                details: { targetPath: resolved, field: 'status', value: 'superseded' },
                autoFixable: true,
              },
            });
          }
        }
      }
    }

    return issues;
  }

  /**
   * Check if project index is stale
   */
  private async checkIndexStaleness(projectName: string, index: ProjectIndex | null): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    if (!index) {
      issues.push({
        id: this.generateIssueId('index_stale', projectName, 'missing'),
        category: 'index_stale',
        severity: 'info',
        notePath: `${PROJECTS_FOLDER}/${projectName}/_index.json`,
        message: 'Project index is missing or could not be read',
        details: { reason: 'missing' },
        suggestedFix: {
          type: 'rebuild_index',
          description: 'Rebuild project index',
          details: { projectName },
          autoFixable: true,
        },
      });
      return issues;
    }

    // Check if index is marked stale
    if (index.stale) {
      issues.push({
        id: this.generateIssueId('index_stale', projectName, 'marked'),
        category: 'index_stale',
        severity: 'info',
        notePath: `${PROJECTS_FOLDER}/${projectName}/_index.json`,
        message: 'Project index is marked as stale',
        details: { reason: 'marked_stale' },
        suggestedFix: {
          type: 'rebuild_index',
          description: 'Rebuild project index',
          details: { projectName },
          autoFixable: true,
        },
      });
      return issues;
    }

    // Check if any notes have been modified since index was updated
    const indexUpdated = new Date(index.updated).getTime();
    const projectPath = path.join(this.memPath, PROJECTS_FOLDER, sanitizeProjectName(projectName));

    try {
      const files = this.walkDir(projectPath, '.md');
      for (const file of files) {
        const stats = fs.statSync(file);
        if (stats.mtime.getTime() > indexUpdated) {
          issues.push({
            id: this.generateIssueId('index_stale', projectName, 'mtime'),
            category: 'index_stale',
            severity: 'info',
            notePath: `${PROJECTS_FOLDER}/${projectName}/_index.json`,
            message: `Project index is out of date (notes modified since ${index.updated})`,
            details: {
              reason: 'files_modified',
              indexUpdated: index.updated,
              exampleFile: path.relative(this.vaultPath, file),
            },
            suggestedFix: {
              type: 'rebuild_index',
              description: 'Rebuild project index',
              details: { projectName },
              autoFixable: true,
            },
          });
          break; // One issue is enough
        }
      }
    } catch {
      // Can't check mtimes - skip this check
    }

    return issues;
  }

  /**
   * Check frontmatter validity
   */
  private async checkFrontmatterValidity(projectPath: string): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];
    const files = this.walkDir(projectPath, '.md');

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        const relativePath = path.relative(this.vaultPath, file);

        // Skip index files
        if (frontmatter.tags?.includes('index')) {
          continue;
        }

        // Determine required fields based on type
        const noteType = frontmatter.type as string || 'learning';
        const required = REQUIRED_FRONTMATTER[noteType] || REQUIRED_FRONTMATTER.learning;

        const missingFields: string[] = [];
        for (const field of required) {
          if (!frontmatter[field]) {
            missingFields.push(field);
          }
        }

        if (missingFields.length > 0) {
          issues.push({
            id: this.generateIssueId('invalid_frontmatter', relativePath),
            category: 'invalid_frontmatter',
            severity: 'warning',
            notePath: relativePath,
            message: `Missing required frontmatter fields: ${missingFields.join(', ')}`,
            details: {
              noteType,
              missingFields,
              currentFrontmatter: Object.keys(frontmatter),
            },
            suggestedFix: {
              type: 'update_frontmatter',
              description: `Add missing fields: ${missingFields.join(', ')}`,
              details: {
                missingFields,
                noteType,
              },
              autoFixable: missingFields.every(f => f !== 'title'), // Can auto-fix everything except title
            },
          });
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return issues;
  }

  /**
   * Generate a unique issue ID
   */
  private generateIssueId(category: IssueCategory, ...parts: string[]): string {
    const hash = parts.join(':').split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0);
    }, 0);
    return `${category}-${Math.abs(hash).toString(36)}`;
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
}
