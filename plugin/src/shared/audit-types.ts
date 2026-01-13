/**
 * Types for the Knowledge Refinement & Housekeeping System
 *
 * Provides audit, fix, and validation capabilities for the memory vault.
 */

/**
 * Severity levels for audit issues
 */
export type IssueSeverity = 'error' | 'warning' | 'info';

/**
 * Categories of issues detected by the audit system
 *
 * Structural issues (fast, no AI):
 * - broken_link: Wikilink points to non-existent note
 * - orphan_note: Note has no parent link (not connected to hierarchy)
 * - missing_index: Category folder missing its index file
 * - supersession_inconsistent: Superseded note missing superseded_by or new note missing supersedes
 * - index_stale: _index.json is out of sync with note file mtimes
 * - invalid_frontmatter: Required frontmatter fields missing (type, title, created)
 *
 * Content issues (AI-powered, slower):
 * - stale_content: Knowledge no longer matches current codebase
 * - duplicate_content: Multiple notes covering the same topic
 * - misclassified_note: Note type doesn't match its content
 */
export type IssueCategory =
  // Structural issues
  | 'broken_link'
  | 'orphan_note'
  | 'missing_index'
  | 'supersession_inconsistent'
  | 'index_stale'
  | 'invalid_frontmatter'
  // Content issues (AI-powered)
  | 'stale_content'
  | 'duplicate_content'
  | 'misclassified_note';

/**
 * Suggested fix for an audit issue
 */
export interface AuditFix {
  /** Type of fix operation */
  type: 'remove_link' | 'add_parent' | 'create_index' | 'update_frontmatter' | 'rebuild_index' | 'supersede' | 'delete' | 'reclassify';
  /** Human-readable description of what the fix does */
  description: string;
  /** Fix-specific details (e.g., field to add, link to remove) */
  details: Record<string, unknown>;
  /** Whether this fix can be applied automatically */
  autoFixable: boolean;
}

/**
 * An issue detected by the audit system
 */
export interface AuditIssue {
  /** Unique identifier for this issue (used for batch fixing) */
  id: string;
  /** Category of the issue */
  category: IssueCategory;
  /** Severity level */
  severity: IssueSeverity;
  /** Path to the affected note (relative to vault) */
  notePath: string;
  /** Human-readable description of the issue */
  message: string;
  /** Additional details about the issue */
  details: Record<string, unknown>;
  /** Suggested fix (if available) */
  suggestedFix?: AuditFix;
}

/**
 * Result of an audit operation
 */
export interface AuditResult {
  /** Project name that was audited */
  project: string;
  /** When the audit was performed */
  timestamp: string;
  /** How long the audit took */
  duration_ms: number;
  /** Summary statistics */
  stats: {
    /** Total notes scanned */
    total_notes: number;
    /** Issues by severity */
    by_severity: Record<IssueSeverity, number>;
    /** Issues by category */
    by_category: Record<string, number>;
  };
  /** All detected issues */
  issues: AuditIssue[];
  /** Content validation results (only if includeContentValidation was true) */
  contentValidation?: ContentValidationSummary;
}

/**
 * Summary of content validation results
 */
export interface ContentValidationSummary {
  /** Number of notes validated */
  notes_checked: number;
  /** Number found to be stale */
  stale_count: number;
  /** Number where validation failed */
  validation_failed_count: number;
  /** Individual validation results */
  results: ValidationResult[];
}

/**
 * Result of validating a single note's content against the codebase
 */
export interface ValidationResult {
  /** Path to the note */
  notePath: string;
  /**
   * Whether the content is stale
   * - true: Content is out of date with codebase
   * - false: Content is up to date
   * - null: AI validation failed (check reason for details)
   */
  isStale: boolean | null;
  /** Confidence score (0-1), 0 if validation failed */
  confidence: number;
  /** Explanation of why the content is/isn't stale, or error message */
  reason: string;
  /** Files referenced in the note content */
  referencedFiles: string[];
}

/**
 * Result of applying a fix
 */
export interface FixResult {
  /** ID of the issue that was fixed */
  issueId: string;
  /** Whether the fix was successful */
  success: boolean;
  /** Human-readable result message */
  message: string;
  /** Changes made (for audit trail) */
  changes: FixChange[];
}

/**
 * A single change made during a fix operation
 */
export interface FixChange {
  /** Type of change */
  type: 'file_modified' | 'file_created' | 'file_deleted' | 'link_removed' | 'frontmatter_updated' | 'index_rebuilt';
  /** Path to the affected file */
  path: string;
  /** Description of what changed */
  description: string;
}

/**
 * Options for the audit operation
 */
export interface AuditOptions {
  /** Project to audit (required) */
  project: string;
  /** Include AI-powered content validation (default: false) */
  includeContentValidation?: boolean;
  /** Categories to check (default: all) */
  categories?: IssueCategory[];
  /** Maximum notes to validate for content staleness (default: 20) */
  maxContentNotes?: number;
}

/**
 * Options for the fix operation
 */
export interface FixOptions {
  /** Project to fix (required) */
  project: string;
  /** Specific issue IDs to fix (default: all auto-fixable) */
  issueIds?: string[];
  /** Categories to fix (alternative to issueIds) */
  fixCategories?: IssueCategory[];
  /** Dry run - report what would be fixed without making changes (default: false) */
  dryRun?: boolean;
  /** Rebuild all indexes after fixes (default: false) */
  rebuildIndexes?: boolean;
}

/**
 * Options for the validate operation
 */
export interface ValidateOptions {
  /** Project to validate (required) */
  project: string;
  /** Only validate notes of this type */
  noteType?: string;
  /** Maximum notes to validate (default: 20) */
  limit?: number;
  /** Minimum confidence threshold for staleness (default: 0.7) */
  confidenceThreshold?: number;
}
