/**
 * Formatters for MCP tool output
 *
 * Extracted for testability and reuse.
 */

import type { SearchResult, ProjectContext, Note } from "../../shared/types.js";
import type {
  AuditResult,
  FixResult,
  ContentValidationSummary,
} from "../../shared/audit-types.js";

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const lines: string[] = [`## Search Results (${results.length})\n`];

  for (const result of results) {
    lines.push(`### ${result.title}`);
    lines.push(`**Type**: ${result.type} | **Path**: \`${result.path}\``);
    if (result.metadata.project) {
      lines.push(`**Project**: ${result.metadata.project}`);
    }
    if (result.metadata.tags && result.metadata.tags.length > 0) {
      lines.push(
        `**Tags**: ${result.metadata.tags.map((t) => `#${t}`).join(" ")}`
      );
    }
    if (result.snippet) {
      lines.push("");
      lines.push(`> ${result.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatNote(note: Note): string {
  const lines: string[] = [];

  lines.push(`# ${note.title}`);
  lines.push("");
  lines.push(`**Path**: \`${note.path}\``);
  lines.push(`**Type**: ${note.frontmatter.type}`);
  if (note.frontmatter.project) {
    lines.push(`**Project**: ${note.frontmatter.project}`);
  }
  if (note.frontmatter.tags.length > 0) {
    lines.push(
      `**Tags**: ${note.frontmatter.tags.map((t) => `#${t}`).join(" ")}`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(note.content);

  return lines.join("\n");
}

export function formatProjectContext(context: ProjectContext): string {
  const lines: string[] = [];

  lines.push(`# Project: ${context.project}`);
  lines.push("");

  if (context.summary) {
    lines.push("## Summary");
    lines.push(context.summary);
    lines.push("");
  }

  if (context.unresolvedErrors.length > 0) {
    lines.push("## Unresolved Errors");
    lines.push("");
    for (const error of context.unresolvedErrors) {
      lines.push(`> [!danger] ${error.type}`);
      lines.push(`> ${error.message}`);
      lines.push(`> Last seen: ${error.lastSeen}`);
      lines.push("");
    }
  }

  if (context.activeDecisions.length > 0) {
    lines.push("## Active Decisions");
    lines.push("");
    for (const decision of context.activeDecisions) {
      lines.push(`### ${decision.title}`);
      lines.push(decision.decision);
      lines.push("");
    }
  }

  if (context.patterns.length > 0) {
    lines.push("## Relevant Patterns");
    lines.push("");
    for (const pattern of context.patterns) {
      lines.push(`- **${pattern.name}**: ${pattern.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatAuditResult(result: AuditResult): string {
  const lines: string[] = [];

  lines.push(`# Audit Results: ${result.project}`);
  lines.push("");
  lines.push(`**Scanned**: ${result.stats.total_notes} notes in ${result.duration_ms}ms`);
  lines.push("");

  // Summary by severity
  const { error, warning, info } = result.stats.by_severity;
  const hasStructuralIssues = error + warning + info > 0;

  if (!hasStructuralIssues && !result.contentValidation) {
    lines.push("> No issues found! Your knowledge base is healthy.");
    return lines.join("\n");
  }

  if (!hasStructuralIssues) {
    lines.push("> No structural issues found.");
    lines.push("");
  } else {
    lines.push("## Summary");
    lines.push("");
    if (error > 0) lines.push(`- **Errors**: ${error}`);
    if (warning > 0) lines.push(`- **Warnings**: ${warning}`);
    if (info > 0) lines.push(`- **Info**: ${info}`);
    lines.push("");

    // Group issues by category
    const byCategory = new Map<string, typeof result.issues>();
    for (const issue of result.issues) {
      const existing = byCategory.get(issue.category) || [];
      existing.push(issue);
      byCategory.set(issue.category, existing);
    }

    for (const [category, issues] of byCategory) {
      const categoryTitle = category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`## ${categoryTitle} (${issues.length})`);
      lines.push("");

      // Show first 5 issues, summarize rest
      const shown = issues.slice(0, 5);
      const hidden = issues.length - shown.length;

      for (const issue of shown) {
        const icon = issue.severity === "error" ? "x" : issue.severity === "warning" ? "!" : "i";
        lines.push(`- [${icon}] \`${issue.notePath}\`: ${issue.message}`);
        if (issue.suggestedFix) {
          const autoTag = issue.suggestedFix.autoFixable ? " (auto-fixable)" : "";
          lines.push(`  - Fix: ${issue.suggestedFix.description}${autoTag}`);
          lines.push(`  - ID: \`${issue.id}\``);
        }
      }

      if (hidden > 0) {
        lines.push(`- ... and ${hidden} more`);
      }
      lines.push("");
    }
  }

  // Content validation summary
  if (result.contentValidation) {
    const cv = result.contentValidation;
    lines.push("## Content Validation");
    lines.push("");
    lines.push(`- Checked: ${cv.notes_checked} notes`);
    lines.push(`- Stale: ${cv.stale_count}`);
    if (cv.validation_failed_count > 0) {
      lines.push(`- Unable to validate: ${cv.validation_failed_count}`);
    }
    lines.push("");

    if (cv.results.some(r => r.isStale === true)) {
      lines.push("### Stale Notes");
      lines.push("");
      for (const r of cv.results.filter(r => r.isStale === true)) {
        lines.push(`- \`${r.notePath}\` (${Math.round(r.confidence * 100)}% confidence)`);
        lines.push(`  - ${r.reason}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("Use `mem_fix` to apply fixes. Use `dryRun: true` to preview changes first.");

  return lines.join("\n");
}

export function formatFixResults(results: FixResult[], dryRun: boolean): string {
  const lines: string[] = [];

  const mode = dryRun ? "Dry Run" : "Fix";
  lines.push(`# ${mode} Results`);
  lines.push("");

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  lines.push(`**${mode === "Dry Run" ? "Would fix" : "Fixed"}**: ${successful.length}/${results.length}`);
  lines.push("");

  if (successful.length > 0) {
    lines.push("## Successful");
    lines.push("");
    for (const r of successful) {
      lines.push(`- \`${r.issueId}\`: ${r.message}`);
      for (const change of r.changes) {
        lines.push(`  - ${change.type}: ${change.description}`);
      }
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("## Failed");
    lines.push("");
    for (const r of failed) {
      lines.push(`- \`${r.issueId}\`: ${r.message}`);
    }
    lines.push("");
  }

  if (dryRun && successful.length > 0) {
    lines.push("---");
    lines.push("Run again with `dryRun: false` to apply these changes.");
  }

  return lines.join("\n");
}

export function formatValidationResult(result: ContentValidationSummary): string {
  const lines: string[] = [];

  lines.push("# Content Validation Results");
  lines.push("");
  lines.push(`**Checked**: ${result.notes_checked} notes`);
  lines.push(`**Stale**: ${result.stale_count}`);
  lines.push(`**Current**: ${result.notes_checked - result.stale_count - result.validation_failed_count}`);
  if (result.validation_failed_count > 0) {
    lines.push(`**Unable to validate**: ${result.validation_failed_count}`);
  }
  lines.push("");

  // Group by status
  const stale = result.results.filter(r => r.isStale === true);
  const current = result.results.filter(r => r.isStale === false);
  const failed = result.results.filter(r => r.isStale === null);

  if (stale.length > 0) {
    lines.push("## Stale Notes");
    lines.push("");
    lines.push("These notes may need to be updated or superseded:");
    lines.push("");
    for (const r of stale) {
      lines.push(`### \`${r.notePath}\``);
      lines.push(`- **Confidence**: ${Math.round(r.confidence * 100)}%`);
      lines.push(`- **Reason**: ${r.reason}`);
      if (r.referencedFiles.length > 0) {
        lines.push(`- **Referenced files**: ${r.referencedFiles.join(", ")}`);
      }
      lines.push("");
    }
  }

  if (failed.length > 0) {
    lines.push("## Unable to Validate");
    lines.push("");
    for (const r of failed) {
      lines.push(`- \`${r.notePath}\`: ${r.reason}`);
    }
    lines.push("");
  }

  if (current.length > 0 && stale.length === 0) {
    lines.push("> All validated notes appear to be current.");
  }

  if (stale.length > 0) {
    lines.push("---");
    lines.push("Use `mem_supersede` to update stale notes with current information.");
  }

  return lines.join("\n");
}
