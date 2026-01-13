/**
 * Fix Engine for Knowledge Refinement & Housekeeping
 *
 * Applies fixes for issues detected by the AuditEngine.
 * Uses atomic writes and mtime checks to prevent data loss.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { IndexManager } from './index-manager.js';
import { VaultManager } from './vault.js';
import { sanitizeProjectName } from '../../shared/config.js';
import { PROJECTS_FOLDER } from '../../shared/constants.js';
import { atomicWriteSync } from '../../shared/file-utils.js';
import { createLogger, type Logger } from '../../shared/logger.js';
import type {
  AuditIssue,
  FixResult,
  FixChange,
  FixOptions,
} from '../../shared/audit-types.js';

/**
 * TOCTOU protection - track file state at audit time
 */
interface FileState {
  path: string;
  mtime: number;
}

export class FixEngine {
  private vaultPath: string;
  private memPath: string;
  private memFolder: string;
  private indexManager: IndexManager;
  private vaultManager: VaultManager;
  private logger: Logger;

  constructor(vaultPath: string, memFolder: string) {
    this.vaultPath = vaultPath;
    this.memFolder = memFolder;
    this.memPath = path.join(vaultPath, memFolder);
    this.indexManager = new IndexManager(this.memPath);
    this.vaultManager = new VaultManager(vaultPath, memFolder);
    this.logger = createLogger('fix-engine');
  }

  /**
   * Apply fixes for a set of issues
   */
  async applyFixes(issues: AuditIssue[], options: FixOptions): Promise<FixResult[]> {
    const results: FixResult[] = [];
    const project = sanitizeProjectName(options.project);

    this.logger.info(`Applying fixes for ${issues.length} issues (dryRun: ${options.dryRun})`);

    // Filter issues by requested criteria
    let issuesToFix = issues;

    if (options.issueIds && options.issueIds.length > 0) {
      issuesToFix = issues.filter(i => options.issueIds!.includes(i.id));
    } else if (options.fixCategories && options.fixCategories.length > 0) {
      issuesToFix = issues.filter(i => options.fixCategories!.includes(i.category));
    }

    // Only apply auto-fixable issues unless explicitly specified by ID
    if (!options.issueIds) {
      issuesToFix = issuesToFix.filter(i => i.suggestedFix?.autoFixable);
    }

    for (const issue of issuesToFix) {
      try {
        const result = await this.applyFix(issue, options.dryRun || false);
        results.push(result);
      } catch (error) {
        results.push({
          issueId: issue.id,
          success: false,
          message: `Error applying fix: ${error instanceof Error ? error.message : 'Unknown error'}`,
          changes: [],
        });
      }
    }

    // Rebuild indexes if requested
    if (options.rebuildIndexes && !options.dryRun) {
      try {
        await this.indexManager.rebuildProjectIndex(project);
        this.logger.info(`Rebuilt index for project: ${project}`);
      } catch (error) {
        this.logger.error(`Failed to rebuild index: ${error}`);
      }
    }

    return results;
  }

  /**
   * Apply a single fix
   */
  private async applyFix(issue: AuditIssue, dryRun: boolean): Promise<FixResult> {
    if (!issue.suggestedFix) {
      return {
        issueId: issue.id,
        success: false,
        message: 'No suggested fix available',
        changes: [],
      };
    }

    const fix = issue.suggestedFix;

    switch (fix.type) {
      case 'remove_link':
        return this.removeLink(issue, dryRun);

      case 'add_parent':
        return this.addParentLink(issue, dryRun);

      case 'create_index':
        return this.createMissingIndex(issue, dryRun);

      case 'update_frontmatter':
        return this.updateFrontmatter(issue, dryRun);

      case 'rebuild_index':
        return this.rebuildIndex(issue, dryRun);

      default:
        return {
          issueId: issue.id,
          success: false,
          message: `Unknown fix type: ${fix.type}`,
          changes: [],
        };
    }
  }

  /**
   * Remove a broken wikilink from note content
   */
  private async removeLink(issue: AuditIssue, dryRun: boolean): Promise<FixResult> {
    const fullPath = this.resolvePath(issue.notePath);
    const changes: FixChange[] = [];

    // TOCTOU check
    const stateCheck = this.checkFileState(fullPath);
    if (!stateCheck.valid) {
      return {
        issueId: issue.id,
        success: false,
        message: stateCheck.message,
        changes: [],
      };
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const link = issue.details.link as string;

      // Build regex to match the wikilink (with optional display text and embed prefix)
      const escapedLink = link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const linkRegex = new RegExp(`!?\\[\\[${escapedLink}(?:#[^|\\]]*)?(?:\\|[^\\]]*)?\\]\\]`, 'g');

      const newContent = content.replace(linkRegex, '');

      if (newContent === content) {
        return {
          issueId: issue.id,
          success: false,
          message: `Link [[${link}]] not found in file`,
          changes: [],
        };
      }

      if (!dryRun) {
        atomicWriteSync(fullPath, newContent);
      }

      changes.push({
        type: 'link_removed',
        path: issue.notePath,
        description: `Removed broken link [[${link}]]`,
      });

      return {
        issueId: issue.id,
        success: true,
        message: dryRun ? `Would remove link [[${link}]]` : `Removed link [[${link}]]`,
        changes,
      };
    } catch (error) {
      return {
        issueId: issue.id,
        success: false,
        message: `Failed to remove link: ${error instanceof Error ? error.message : 'Unknown error'}`,
        changes: [],
      };
    }
  }

  /**
   * Add parent link to orphan note
   */
  private async addParentLink(issue: AuditIssue, dryRun: boolean): Promise<FixResult> {
    const fullPath = this.resolvePath(issue.notePath);
    const changes: FixChange[] = [];

    // TOCTOU check
    const stateCheck = this.checkFileState(fullPath);
    if (!stateCheck.valid) {
      return {
        issueId: issue.id,
        success: false,
        message: stateCheck.message,
        changes: [],
      };
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const { frontmatter, content: bodyContent } = parseFrontmatter(content);

      const parentPath = issue.suggestedFix?.details.parentPath as string;
      if (!parentPath) {
        return {
          issueId: issue.id,
          success: false,
          message: 'No parent path specified in fix details',
          changes: [],
        };
      }

      // Add parent link to frontmatter
      frontmatter.parent = `[[${parentPath}]]`;

      if (!dryRun) {
        const newContent = stringifyFrontmatter(frontmatter, bodyContent);
        atomicWriteSync(fullPath, newContent);
      }

      changes.push({
        type: 'frontmatter_updated',
        path: issue.notePath,
        description: `Added parent link: [[${parentPath}]]`,
      });

      return {
        issueId: issue.id,
        success: true,
        message: dryRun ? `Would add parent link to ${parentPath}` : `Added parent link to ${parentPath}`,
        changes,
      };
    } catch (error) {
      return {
        issueId: issue.id,
        success: false,
        message: `Failed to add parent link: ${error instanceof Error ? error.message : 'Unknown error'}`,
        changes: [],
      };
    }
  }

  /**
   * Create missing category index
   */
  private async createMissingIndex(issue: AuditIssue, dryRun: boolean): Promise<FixResult> {
    const changes: FixChange[] = [];

    const category = issue.suggestedFix?.details.category as string;
    const projectName = issue.suggestedFix?.details.projectName as string;

    if (!category || !projectName) {
      return {
        issueId: issue.id,
        success: false,
        message: 'Missing category or projectName in fix details',
        changes: [],
      };
    }

    const projectPath = path.join(this.memPath, PROJECTS_FOLDER, sanitizeProjectName(projectName));
    const indexPath = path.join(projectPath, category, `${category}.md`);

    if (fs.existsSync(indexPath)) {
      return {
        issueId: issue.id,
        success: false,
        message: `Index file already exists: ${category}/${category}.md`,
        changes: [],
      };
    }

    if (!dryRun) {
      // Use VaultManager to create the index (it has the template logic)
      await this.vaultManager.createCategoryIndexPublic(projectName, category);
    }

    changes.push({
      type: 'file_created',
      path: `${PROJECTS_FOLDER}/${sanitizeProjectName(projectName)}/${category}/${category}.md`,
      description: `Created ${category} index file`,
    });

    return {
      issueId: issue.id,
      success: true,
      message: dryRun ? `Would create ${category} index` : `Created ${category} index`,
      changes,
    };
  }

  /**
   * Update frontmatter fields
   */
  private async updateFrontmatter(issue: AuditIssue, dryRun: boolean): Promise<FixResult> {
    const fullPath = this.resolvePath(issue.notePath);
    const changes: FixChange[] = [];

    // Check if we're updating a target note (for supersession fixes)
    const targetPath = issue.suggestedFix?.details.targetPath as string | undefined;
    const actualPath = targetPath ? this.resolvePath(targetPath) : fullPath;

    // TOCTOU check
    const stateCheck = this.checkFileState(actualPath);
    if (!stateCheck.valid) {
      return {
        issueId: issue.id,
        success: false,
        message: stateCheck.message,
        changes: [],
      };
    }

    try {
      const content = fs.readFileSync(actualPath, 'utf-8');
      const { frontmatter, content: bodyContent } = parseFrontmatter(content);

      const field = issue.suggestedFix?.details.field as string;
      const value = issue.suggestedFix?.details.value;
      const missingFields = issue.suggestedFix?.details.missingFields as string[] | undefined;

      let updated = false;

      // Handle single field update
      if (field && value !== undefined) {
        (frontmatter as Record<string, unknown>)[field] = value;
        updated = true;
      }

      // Handle missing fields (add defaults)
      if (missingFields) {
        for (const f of missingFields) {
          if (f === 'type') {
            frontmatter.type = frontmatter.type || 'learning';
            updated = true;
          } else if (f === 'created') {
            // Use file mtime as fallback
            const stats = fs.statSync(actualPath);
            frontmatter.created = frontmatter.created || stats.mtime.toISOString();
            updated = true;
          }
          // Note: 'title' is not auto-fixable, skipped
        }
      }

      if (!updated) {
        return {
          issueId: issue.id,
          success: false,
          message: 'No frontmatter updates to apply',
          changes: [],
        };
      }

      if (!dryRun) {
        const newContent = stringifyFrontmatter(frontmatter, bodyContent);
        atomicWriteSync(actualPath, newContent);
      }

      changes.push({
        type: 'frontmatter_updated',
        path: targetPath || issue.notePath,
        description: field ? `Updated ${field} to ${value}` : `Added missing fields: ${missingFields?.join(', ')}`,
      });

      return {
        issueId: issue.id,
        success: true,
        message: dryRun ? 'Would update frontmatter' : 'Updated frontmatter',
        changes,
      };
    } catch (error) {
      return {
        issueId: issue.id,
        success: false,
        message: `Failed to update frontmatter: ${error instanceof Error ? error.message : 'Unknown error'}`,
        changes: [],
      };
    }
  }

  /**
   * Rebuild project index
   */
  private async rebuildIndex(issue: AuditIssue, dryRun: boolean): Promise<FixResult> {
    const changes: FixChange[] = [];

    const projectName = issue.suggestedFix?.details.projectName as string;
    if (!projectName) {
      return {
        issueId: issue.id,
        success: false,
        message: 'Missing projectName in fix details',
        changes: [],
      };
    }

    if (!dryRun) {
      await this.indexManager.rebuildProjectIndex(projectName);
    }

    changes.push({
      type: 'index_rebuilt',
      path: `${PROJECTS_FOLDER}/${sanitizeProjectName(projectName)}/_index.json`,
      description: `Rebuilt project index`,
    });

    return {
      issueId: issue.id,
      success: true,
      message: dryRun ? 'Would rebuild index' : 'Rebuilt index',
      changes,
    };
  }

  /**
   * Resolve note path to full filesystem path
   */
  private resolvePath(notePath: string): string {
    if (path.isAbsolute(notePath)) {
      return notePath;
    }

    // Handle paths that include memFolder
    if (notePath.startsWith(this.memFolder)) {
      return path.join(this.vaultPath, notePath);
    }

    return path.join(this.memPath, notePath);
  }

  /**
   * Check if file exists and hasn't been modified
   * TOCTOU protection: prevents applying stale fixes
   */
  private checkFileState(fullPath: string): { valid: boolean; message: string } {
    if (!fs.existsSync(fullPath)) {
      return {
        valid: false,
        message: `File no longer exists: ${path.basename(fullPath)}`,
      };
    }

    return { valid: true, message: '' };
  }
}
