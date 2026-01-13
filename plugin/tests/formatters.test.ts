import { describe, it, expect } from "bun:test";
import {
  formatSearchResults,
  formatNote,
  formatProjectContext,
  formatAuditResult,
  formatFixResults,
  formatValidationResult,
} from "../src/mcp-server/utils/formatters.js";
import type { SearchResult, ProjectContext, Note } from "../src/shared/types.js";
import type {
  AuditResult,
  FixResult,
  ContentValidationSummary,
} from "../src/shared/audit-types.js";

describe("formatSearchResults", () => {
  it("returns 'No results found.' for empty array", () => {
    const result = formatSearchResults([]);
    expect(result).toBe("No results found.");
  });

  it("formats single result with all fields", () => {
    const results: SearchResult[] = [
      {
        title: "Test Note",
        path: "projects/test/note.md",
        type: "decision",
        score: 0.95,
        snippet: "This is a test snippet",
        metadata: {
          project: "test-project",
          tags: ["tag1", "tag2"],
        },
      },
    ];

    const output = formatSearchResults(results);

    expect(output).toContain("## Search Results (1)");
    expect(output).toContain("### Test Note");
    expect(output).toContain("**Type**: decision");
    expect(output).toContain("`projects/test/note.md`");
    expect(output).toContain("**Project**: test-project");
    expect(output).toContain("#tag1");
    expect(output).toContain("#tag2");
    expect(output).toContain("> This is a test snippet");
  });

  it("formats result without optional fields", () => {
    const results: SearchResult[] = [
      {
        title: "Minimal Note",
        path: "note.md",
        type: "error",
        score: 0.5,
        metadata: {},
      },
    ];

    const output = formatSearchResults(results);

    expect(output).toContain("### Minimal Note");
    expect(output).not.toContain("**Project**:");
    expect(output).not.toContain("**Tags**:");
  });
});

describe("formatNote", () => {
  it("formats note with all fields", () => {
    const note: Note = {
      title: "Test Decision",
      path: "decisions/test.md",
      content: "This is the content.",
      frontmatter: {
        type: "decision",
        title: "Test Decision",
        project: "my-project",
        tags: ["arch", "db"],
        created: "2026-01-13",
        status: "active",
      },
    };

    const output = formatNote(note);

    expect(output).toContain("# Test Decision");
    expect(output).toContain("**Path**: `decisions/test.md`");
    expect(output).toContain("**Type**: decision");
    expect(output).toContain("**Project**: my-project");
    expect(output).toContain("#arch");
    expect(output).toContain("#db");
    expect(output).toContain("---");
    expect(output).toContain("This is the content.");
  });

  it("formats note without optional project", () => {
    const note: Note = {
      title: "Global Note",
      path: "global/note.md",
      content: "Global content.",
      frontmatter: {
        type: "pattern",
        title: "Global Note",
        tags: [],
        created: "2026-01-13",
      },
    };

    const output = formatNote(note);

    expect(output).toContain("# Global Note");
    expect(output).not.toContain("**Project**:");
    expect(output).not.toContain("**Tags**:");
  });
});

describe("formatProjectContext", () => {
  it("formats empty context", () => {
    const context: ProjectContext = {
      project: "empty-project",
      unresolvedErrors: [],
      activeDecisions: [],
      patterns: [],
    };

    const output = formatProjectContext(context);

    expect(output).toContain("# Project: empty-project");
    expect(output).not.toContain("## Unresolved Errors");
    expect(output).not.toContain("## Active Decisions");
    expect(output).not.toContain("## Relevant Patterns");
  });

  it("formats context with summary", () => {
    const context: ProjectContext = {
      project: "test-project",
      summary: "This is the project summary.",
      unresolvedErrors: [],
      activeDecisions: [],
      patterns: [],
    };

    const output = formatProjectContext(context);

    expect(output).toContain("## Summary");
    expect(output).toContain("This is the project summary.");
  });

  it("formats context with all sections", () => {
    const context: ProjectContext = {
      project: "full-project",
      unresolvedErrors: [
        { type: "TypeError", message: "Cannot read property", lastSeen: "2026-01-13" },
      ],
      activeDecisions: [
        { title: "Use PostgreSQL", decision: "We decided to use PostgreSQL for the database." },
      ],
      patterns: [
        { name: "Repository Pattern", description: "Abstract data access behind interfaces" },
      ],
    };

    const output = formatProjectContext(context);

    expect(output).toContain("## Unresolved Errors");
    expect(output).toContain("[!danger] TypeError");
    expect(output).toContain("Cannot read property");
    expect(output).toContain("Last seen: 2026-01-13");

    expect(output).toContain("## Active Decisions");
    expect(output).toContain("### Use PostgreSQL");
    expect(output).toContain("We decided to use PostgreSQL");

    expect(output).toContain("## Relevant Patterns");
    expect(output).toContain("**Repository Pattern**");
    expect(output).toContain("Abstract data access");
  });
});

describe("formatAuditResult", () => {
  it("formats healthy audit with no issues", () => {
    const result: AuditResult = {
      project: "healthy-project",
      timestamp: "2026-01-13T10:00:00Z",
      duration_ms: 150,
      stats: {
        total_notes: 25,
        by_severity: { error: 0, warning: 0, info: 0 },
        by_category: {},
      },
      issues: [],
    };

    const output = formatAuditResult(result);

    expect(output).toContain("# Audit Results: healthy-project");
    expect(output).toContain("**Scanned**: 25 notes in 150ms");
    expect(output).toContain("No issues found! Your knowledge base is healthy.");
    expect(output).not.toContain("## Summary");
  });

  it("formats audit with issues by severity", () => {
    const result: AuditResult = {
      project: "issue-project",
      timestamp: "2026-01-13T10:00:00Z",
      duration_ms: 200,
      stats: {
        total_notes: 10,
        by_severity: { error: 2, warning: 3, info: 1 },
        by_category: { broken_link: 2, orphan_note: 3, invalid_frontmatter: 1 },
      },
      issues: [
        {
          id: "issue-1",
          category: "broken_link",
          severity: "error",
          notePath: "notes/test.md",
          message: "Link to [[missing]] is broken",
          details: { link: "missing" },
          suggestedFix: {
            type: "remove_link",
            description: "Remove broken link",
            details: { link: "missing" },
            autoFixable: true,
          },
        },
        {
          id: "issue-2",
          category: "broken_link",
          severity: "error",
          notePath: "notes/other.md",
          message: "Link to [[gone]] is broken",
          details: { link: "gone" },
        },
      ],
    };

    const output = formatAuditResult(result);

    expect(output).toContain("## Summary");
    expect(output).toContain("**Errors**: 2");
    expect(output).toContain("**Warnings**: 3");
    expect(output).toContain("**Info**: 1");

    expect(output).toContain("## Broken Link (2)");
    expect(output).toContain("[x] `notes/test.md`");
    expect(output).toContain("Link to [[missing]] is broken");
    expect(output).toContain("Fix: Remove broken link (auto-fixable)");
    expect(output).toContain("ID: `issue-1`");

    expect(output).toContain("Use `mem_fix` to apply fixes");
  });

  it("shows first 5 issues and hides rest", () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({
      id: `issue-${i}`,
      category: "orphan_note" as const,
      severity: "warning" as const,
      notePath: `notes/orphan-${i}.md`,
      message: `Note ${i} has no parent`,
      details: {},
    }));

    const result: AuditResult = {
      project: "many-issues",
      timestamp: "2026-01-13T10:00:00Z",
      duration_ms: 100,
      stats: {
        total_notes: 20,
        by_severity: { error: 0, warning: 8, info: 0 },
        by_category: { orphan_note: 8 },
      },
      issues,
    };

    const output = formatAuditResult(result);

    expect(output).toContain("## Orphan Note (8)");
    expect(output).toContain("orphan-0.md");
    expect(output).toContain("orphan-4.md");
    expect(output).not.toContain("orphan-5.md");
    expect(output).toContain("... and 3 more");
  });

  it("includes content validation summary when present", () => {
    const result: AuditResult = {
      project: "validated-project",
      timestamp: "2026-01-13T10:00:00Z",
      duration_ms: 5000,
      stats: {
        total_notes: 10,
        by_severity: { error: 0, warning: 0, info: 0 },
        by_category: {},
      },
      issues: [],
      contentValidation: {
        notes_checked: 5,
        stale_count: 2,
        validation_failed_count: 1,
        results: [
          {
            notePath: "knowledge/old-info.md",
            isStale: true,
            confidence: 0.85,
            reason: "Code has changed significantly",
            referencedFiles: ["src/main.ts"],
          },
        ],
      },
    };

    const output = formatAuditResult(result);

    // When no structural issues but content validation exists, show appropriate message
    expect(output).toContain("No structural issues found.");
    expect(output).toContain("## Content Validation");
    expect(output).toContain("Checked: 5 notes");
    expect(output).toContain("Stale: 2");
    expect(output).toContain("Unable to validate: 1");
    expect(output).toContain("### Stale Notes");
    expect(output).toContain("`knowledge/old-info.md` (85% confidence)");
  });
});

describe("formatFixResults", () => {
  it("formats dry run results", () => {
    const results: FixResult[] = [
      {
        issueId: "fix-1",
        success: true,
        message: "Would remove broken link",
        changes: [
          { type: "link_removed", path: "note.md", description: "Remove [[missing]]" },
        ],
      },
    ];

    const output = formatFixResults(results, true);

    expect(output).toContain("# Dry Run Results");
    expect(output).toContain("**Would fix**: 1/1");
    expect(output).toContain("## Successful");
    expect(output).toContain("`fix-1`: Would remove broken link");
    expect(output).toContain("link_removed: Remove [[missing]]");
    expect(output).toContain("Run again with `dryRun: false`");
  });

  it("formats actual fix results", () => {
    const results: FixResult[] = [
      {
        issueId: "fix-1",
        success: true,
        message: "Removed broken link",
        changes: [
          { type: "file_modified", path: "note.md", description: "Updated content" },
        ],
      },
      {
        issueId: "fix-2",
        success: false,
        message: "File not found",
        changes: [],
      },
    ];

    const output = formatFixResults(results, false);

    expect(output).toContain("# Fix Results");
    expect(output).toContain("**Fixed**: 1/2");
    expect(output).toContain("## Successful");
    expect(output).toContain("`fix-1`");
    expect(output).toContain("## Failed");
    expect(output).toContain("`fix-2`: File not found");
    expect(output).not.toContain("Run again with `dryRun: false`");
  });

  it("handles all successful fixes", () => {
    const results: FixResult[] = [
      { issueId: "a", success: true, message: "Done", changes: [] },
      { issueId: "b", success: true, message: "Done", changes: [] },
    ];

    const output = formatFixResults(results, false);

    expect(output).toContain("**Fixed**: 2/2");
    expect(output).toContain("## Successful");
    expect(output).not.toContain("## Failed");
  });

  it("handles all failed fixes", () => {
    const results: FixResult[] = [
      { issueId: "a", success: false, message: "Error 1", changes: [] },
      { issueId: "b", success: false, message: "Error 2", changes: [] },
    ];

    const output = formatFixResults(results, false);

    expect(output).toContain("**Fixed**: 0/2");
    expect(output).not.toContain("## Successful");
    expect(output).toContain("## Failed");
  });
});

describe("formatValidationResult", () => {
  it("formats all current notes", () => {
    const result: ContentValidationSummary = {
      notes_checked: 5,
      stale_count: 0,
      validation_failed_count: 0,
      results: [
        { notePath: "note1.md", isStale: false, confidence: 0.9, reason: "Up to date", referencedFiles: [] },
        { notePath: "note2.md", isStale: false, confidence: 0.85, reason: "Current", referencedFiles: [] },
      ],
    };

    const output = formatValidationResult(result);

    expect(output).toContain("# Content Validation Results");
    expect(output).toContain("**Checked**: 5 notes");
    expect(output).toContain("**Stale**: 0");
    expect(output).toContain("**Current**: 5");
    expect(output).toContain("All validated notes appear to be current.");
    expect(output).not.toContain("## Stale Notes");
  });

  it("formats stale notes with details", () => {
    const result: ContentValidationSummary = {
      notes_checked: 3,
      stale_count: 2,
      validation_failed_count: 0,
      results: [
        {
          notePath: "old-decision.md",
          isStale: true,
          confidence: 0.92,
          reason: "Referenced function was removed",
          referencedFiles: ["src/utils.ts", "src/helper.ts"],
        },
        {
          notePath: "outdated-qa.md",
          isStale: true,
          confidence: 0.78,
          reason: "API has changed",
          referencedFiles: [],
        },
      ],
    };

    const output = formatValidationResult(result);

    expect(output).toContain("**Stale**: 2");
    expect(output).toContain("**Current**: 1");
    expect(output).toContain("## Stale Notes");
    expect(output).toContain("These notes may need to be updated or superseded");

    expect(output).toContain("### `old-decision.md`");
    expect(output).toContain("**Confidence**: 92%");
    expect(output).toContain("**Reason**: Referenced function was removed");
    expect(output).toContain("**Referenced files**: src/utils.ts, src/helper.ts");

    expect(output).toContain("### `outdated-qa.md`");
    expect(output).toContain("**Confidence**: 78%");

    expect(output).toContain("Use `mem_supersede` to update stale notes");
  });

  it("formats validation failures", () => {
    const result: ContentValidationSummary = {
      notes_checked: 4,
      stale_count: 1,
      validation_failed_count: 2,
      results: [
        { notePath: "failed1.md", isStale: null, confidence: 0, reason: "AI timeout", referencedFiles: [] },
        { notePath: "failed2.md", isStale: null, confidence: 0, reason: "Parse error", referencedFiles: [] },
      ],
    };

    const output = formatValidationResult(result);

    expect(output).toContain("**Unable to validate**: 2");
    expect(output).toContain("## Unable to Validate");
    expect(output).toContain("`failed1.md`: AI timeout");
    expect(output).toContain("`failed2.md`: Parse error");
  });
});
