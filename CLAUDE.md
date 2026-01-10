# cc-obsidian-mem Development Guide

## Version Bump Checklist

When releasing a new version, update the version number in **all three files**:

| File | Field | Example |
|------|-------|---------|
| `plugin/package.json` | `version` | `"version": "0.3.0"` |
| `plugin/.claude-plugin/plugin.json` | `version` | `"version": "0.3.0"` |
| `.claude-plugin/marketplace.json` | `plugins[0].version` | `"version": "0.3.0"` |

## Project Structure

```
cc-obsidian-mem/
├── .claude-plugin/
│   └── marketplace.json      # Marketplace metadata (version here!)
├── plugin/                   # The actual plugin
│   ├── .claude-plugin/
│   │   └── plugin.json       # Plugin metadata (version here!)
│   ├── package.json          # NPM package (version here!)
│   ├── hooks/
│   │   ├── hooks.json        # Hook definitions
│   │   └── scripts/          # Hook implementations
│   ├── scripts/              # Utility scripts (backfill, migrations)
│   ├── src/
│   │   ├── cli/              # Setup CLI
│   │   ├── mcp-server/       # MCP server for mem_* tools
│   │   ├── services/         # Summarization & knowledge extraction
│   │   └── shared/           # Shared types, config, session store
│   └── tests/
└── CLAUDE.md                 # This file
```

## Key Files by Feature

### Agent SDK Integration
- `plugin/src/services/summarizer.ts` - AI summarization using Agent SDK
- `plugin/src/services/knowledge-extractor.ts` - Knowledge extraction using Agent SDK
- `plugin/hooks/scripts/session-end.ts` - Session summary generation

### Hook Scripts
- `plugin/hooks/scripts/session-start.ts` - Initialize session, inject context
- `plugin/hooks/scripts/user-prompt-submit.ts` - Track user prompts
- `plugin/hooks/scripts/post-tool-use.ts` - Capture tool observations, extract knowledge from WebFetch/WebSearch/Context7
- `plugin/hooks/scripts/pre-compact.ts` - Trigger background summarization before compaction
- `plugin/hooks/scripts/background-summarize.ts` - AI-powered knowledge extraction (spawned by pre-compact)
- `plugin/hooks/scripts/session-end.ts` - Finalize session, generate summaries

### Configuration
- `plugin/src/shared/config.ts` - Config loading and defaults
- `plugin/src/shared/types.ts` - TypeScript type definitions
- User config: `~/.cc-obsidian-mem/config.json`

### MCP Server
- `plugin/src/mcp-server/index.ts` - MCP server entry point, registers all `mem_*` tools
- `plugin/src/mcp-server/utils/vault.ts` - Vault read/write operations, note linking, superseding

### Utility Scripts
- `plugin/scripts/backfill-parent-links.ts` - Backfill parent links and create category indexes for existing notes

## Testing

```bash
cd plugin
bun test              # Run all tests
bunx tsc --noEmit     # Type check only
```

## Local Development

```bash
# Install from local path
claude /plugin install /path/to/cc-obsidian-mem/plugin

# Uninstall
claude /plugin uninstall cc-obsidian-mem

# Check installed plugins
claude /plugin list
```

## Important Notes

- Agent SDK calls use `tools: []` to ensure read-only operation
- Knowledge notes use `frontmatter.knowledge_type` for the actual type (qa/explanation/decision/research/learning)
- Project detection searches up the directory tree for `.git` to find the repo root

## Note Linking Structure

Notes follow a hierarchical linking pattern for proper Obsidian graph navigation:

```
Project Base (project-name.md)
    ↑ parent
Category Index (decisions/decisions.md, knowledge/knowledge.md, etc.)
    ↑ parent
Individual Notes (decisions/2026-01-10_some-decision.md)
```

- **Category indexes** use the folder name as filename: `decisions/decisions.md`, NOT `_index.md`
- **Parent links** in frontmatter: `parent: "[[_claude-mem/projects/project-name/category/category]]"`
- **Superseding notes** creates bidirectional links: old note gets `superseded_by`, new note gets `supersedes`

## Utility Scripts

- `plugin/scripts/backfill-parent-links.ts` - Add parent links to existing notes and create category indexes
