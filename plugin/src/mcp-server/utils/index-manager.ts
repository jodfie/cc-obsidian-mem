/**
 * File-based JSON Index Manager
 *
 * Provides fast search through JSON index files instead of scanning all markdown files.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { sanitizeProjectName } from '../../shared/config.js';
import { atomicWriteSync } from '../../shared/file-utils.js';

const INDEX_SCHEMA_VERSION = 1;

/**
 * Index entry for a single note
 */
export interface IndexEntry {
  path: string;
  title: string;
  type: string;
  status: string;
  created: string;
  updated: string;
  tags: string[];
  topics?: string[];
  snippet?: string;        // First 200 chars of content
  year_month: string;      // "2026-01" for date filtering
}

/**
 * Project-level index
 */
export interface ProjectIndex {
  version: number;
  updated: string;
  project: string;
  stale: boolean;
  stats: {
    total_notes: number;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
  };
  notes: IndexEntry[];
}

/**
 * Index Manager class for managing project indexes
 */
export class IndexManager {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Get the path to a project's index file
   * Sanitizes project name to prevent path traversal
   */
  getIndexPath(projectName: string): string {
    const sanitized = sanitizeProjectName(projectName);
    const indexPath = path.join(this.basePath, 'projects', sanitized, '_index.json');

    // Validate path stays within projects folder (prevent path traversal)
    const projectsBase = path.resolve(this.basePath, 'projects');
    const resolvedPath = path.resolve(indexPath);
    if (!resolvedPath.startsWith(projectsBase + path.sep)) {
      throw new Error(`Invalid project name: ${projectName}`);
    }

    return indexPath;
  }

  /**
   * Get project index (auto-rebuild if stale or missing)
   */
  async getProjectIndex(projectName: string): Promise<ProjectIndex | null> {
    const indexPath = this.getIndexPath(projectName);

    try {
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(content) as ProjectIndex;

        // Check schema version
        if (index.version !== INDEX_SCHEMA_VERSION) {
          console.log(`Index schema version mismatch, rebuilding for ${projectName}`);
          return await this.rebuildProjectIndex(projectName);
        }

        // Check if stale
        if (index.stale) {
          console.log(`Index marked stale, rebuilding for ${projectName}`);
          return await this.rebuildProjectIndex(projectName);
        }

        return index;
      } else {
        // Index doesn't exist, build it
        return await this.rebuildProjectIndex(projectName);
      }
    } catch (error) {
      console.error(`Failed to read index for ${projectName}:`, error);
      // Try to rebuild
      return await this.rebuildProjectIndex(projectName);
    }
  }

  /**
   * Rebuild the entire project index from notes
   * Sanitizes project name to prevent path traversal
   */
  async rebuildProjectIndex(projectName: string): Promise<ProjectIndex | null> {
    const sanitized = sanitizeProjectName(projectName);
    const projectPath = path.join(this.basePath, 'projects', sanitized);

    // Validate path stays within projects folder (prevent path traversal)
    const projectsBase = path.resolve(this.basePath, 'projects');
    const resolvedPath = path.resolve(projectPath);
    if (!resolvedPath.startsWith(projectsBase + path.sep)) {
      console.error(`Invalid project name rejected: ${projectName}`);
      return null;
    }

    if (!fs.existsSync(projectPath)) {
      return null;
    }

    const notes: IndexEntry[] = [];
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    // Recursively scan for markdown files
    const scanDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip canvases and hidden directories
          if (entry.name !== 'canvases' && !entry.name.startsWith('.')) {
            scanDir(fullPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
          // Parse markdown file
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const { data: frontmatter, content: body } = matter(content);

            const relativePath = path.relative(this.basePath, fullPath);
            const created = frontmatter.created || '';
            const yearMonth = created ? created.substring(0, 7) : '';

            const indexEntry: IndexEntry = {
              path: relativePath,
              title: frontmatter.title || entry.name.replace('.md', ''),
              type: frontmatter.type || frontmatter.knowledge_type || 'unknown',
              status: frontmatter.status || 'active',
              created,
              updated: frontmatter.updated || created,
              tags: frontmatter.tags || [],
              topics: frontmatter.topics,
              snippet: body.substring(0, 200).replace(/\n/g, ' ').trim(),
              year_month: yearMonth,
            };

            notes.push(indexEntry);

            // Update stats
            byType[indexEntry.type] = (byType[indexEntry.type] || 0) + 1;
            byStatus[indexEntry.status] = (byStatus[indexEntry.status] || 0) + 1;
          } catch (error) {
            console.error(`Failed to parse ${fullPath}:`, error);
          }
        }
      }
    };

    scanDir(projectPath);

    const index: ProjectIndex = {
      version: INDEX_SCHEMA_VERSION,
      updated: new Date().toISOString(),
      project: projectName,
      stale: false,
      stats: {
        total_notes: notes.length,
        by_type: byType,
        by_status: byStatus,
      },
      notes,
    };

    // Write index atomically
    try {
      const indexPath = this.getIndexPath(projectName);
      atomicWriteSync(indexPath, JSON.stringify(index, null, 2));
    } catch (error) {
      console.error(`Failed to write index for ${projectName}:`, error);
      // Return the index anyway, just don't persist it
      index.stale = true;
    }

    return index;
  }

  /**
   * Update a single entry in the index
   * Called after writeNote/writeKnowledge
   */
  async updateIndexEntry(notePath: string): Promise<void> {
    // Extract project name from path
    const relativePath = path.relative(this.basePath, notePath);
    const parts = relativePath.split(path.sep);

    // Expected format: projects/{projectName}/...
    if (parts[0] !== 'projects' || parts.length < 3) {
      return; // Not a project note
    }

    const projectName = parts[1];
    const indexPath = this.getIndexPath(projectName);

    try {
      // Read existing index
      let index: ProjectIndex;
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        index = JSON.parse(content) as ProjectIndex;
      } else {
        // No index, rebuild
        await this.rebuildProjectIndex(projectName);
        return;
      }

      // Parse the note
      if (!fs.existsSync(notePath)) {
        // Note was deleted, remove from index
        index.notes = index.notes.filter(n => n.path !== relativePath);
      } else {
        const content = fs.readFileSync(notePath, 'utf-8');
        const { data: frontmatter, content: body } = matter(content);

        const created = frontmatter.created || '';
        const yearMonth = created ? created.substring(0, 7) : '';

        const newEntry: IndexEntry = {
          path: relativePath,
          title: frontmatter.title || path.basename(notePath, '.md'),
          type: frontmatter.type || frontmatter.knowledge_type || 'unknown',
          status: frontmatter.status || 'active',
          created,
          updated: frontmatter.updated || created,
          tags: frontmatter.tags || [],
          topics: frontmatter.topics,
          snippet: body.substring(0, 200).replace(/\n/g, ' ').trim(),
          year_month: yearMonth,
        };

        // Update or add entry
        const existingIndex = index.notes.findIndex(n => n.path === relativePath);
        if (existingIndex >= 0) {
          index.notes[existingIndex] = newEntry;
        } else {
          index.notes.push(newEntry);
        }
      }

      // Recalculate stats
      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const note of index.notes) {
        byType[note.type] = (byType[note.type] || 0) + 1;
        byStatus[note.status] = (byStatus[note.status] || 0) + 1;
      }

      index.stats = {
        total_notes: index.notes.length,
        by_type: byType,
        by_status: byStatus,
      };
      index.updated = new Date().toISOString();
      index.stale = false;

      // Write atomically
      atomicWriteSync(indexPath, JSON.stringify(index, null, 2));
    } catch (error) {
      // Mark as stale on failure
      console.error(`Failed to update index entry for ${notePath}:`, error);
      try {
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, 'utf-8');
          const index = JSON.parse(content) as ProjectIndex;
          index.stale = true;
          atomicWriteSync(indexPath, JSON.stringify(index, null, 2));
        }
      } catch {
        // Ignore stale marking failure
      }
    }
  }

  /**
   * Mark an index as stale (will be rebuilt on next read)
   */
  markStale(projectName: string): void {
    const indexPath = this.getIndexPath(projectName);

    try {
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(content) as ProjectIndex;
        index.stale = true;
        atomicWriteSync(indexPath, JSON.stringify(index, null, 2));
      }
    } catch (error) {
      console.error(`Failed to mark index stale for ${projectName}:`, error);
    }
  }

  /**
   * Search using index (faster than file scan)
   */
  async searchByIndex(
    projectName: string,
    options: {
      query?: string;
      type?: string;
      status?: string;
      tags?: string[];
      limit?: number;
    }
  ): Promise<IndexEntry[]> {
    const index = await this.getProjectIndex(projectName);
    if (!index) return [];

    let results = index.notes;

    // Filter by type
    if (options.type) {
      results = results.filter(n => n.type === options.type);
    }

    // Filter by status
    if (options.status) {
      results = results.filter(n => n.status === options.status);
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      results = results.filter(n =>
        options.tags!.some(tag => n.tags.includes(tag))
      );
    }

    // Filter by query (search title, snippet, tags)
    if (options.query) {
      const query = options.query.toLowerCase();
      results = results.filter(n =>
        n.title.toLowerCase().includes(query) ||
        (n.snippet && n.snippet.toLowerCase().includes(query)) ||
        n.tags.some(t => t.toLowerCase().includes(query)) ||
        (n.topics && n.topics.some(t => t.toLowerCase().includes(query)))
      );
    }

    // Apply limit
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }
}
