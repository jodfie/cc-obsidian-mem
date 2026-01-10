# cc-obsidian-mem

Obsidian-based persistent memory system for Claude Code. Automatically captures session activity, errors, decisions, and patterns into a browsable, visualizable knowledge base.

## Features

- **Automatic Capture**: Session hooks automatically log file edits, commands, and errors
- **AI Summaries**: Claude-powered session summaries and error analysis
- **Obsidian Integration**: Full Obsidian syntax support with Dataview queries for visualization
- **Project Organization**: Memories organized by project with cross-project patterns
- **MCP Tools**: Search, read, and write memories directly from Claude Code
- **Skills**: User-invokable commands (`/mem-search`, `/mem-save`, `/mem-status`)

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌────────────────┐
│ Claude Code  │◄───►│ MCP Server  │◄───►│ Obsidian Vault │
└──────┬───────┘     └─────────────┘     └────────────────┘
       │
       ▼
┌──────────────┐     ┌─────────────┐
│    Hooks     │────►│Session Store│
│ (Lifecycle)  │     │ (File-based)│
└──────────────┘     └─────────────┘
```

## Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Obsidian](https://obsidian.md/) (with Dataview plugin recommended)
- Claude Code CLI

### Option 1: Install from GitHub (Recommended)

```bash
# Add the marketplace
/plugin marketplace add z-m-huang/cc-obsidian-mem

# Install the plugin
/plugin install cc-obsidian-mem
```

### Option 2: Install from Local Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/Z-M-Huang/cc-obsidian-mem.git
   cd cc-obsidian-mem
   ```

2. Install dependencies:
   ```bash
   cd plugin && bun install
   ```

3. Add as local marketplace in Claude Code:
   ```
   /plugin marketplace add /path/to/cc-obsidian-mem
   /plugin install cc-obsidian-mem
   ```

4. Restart Claude Code to load the plugin

### Setup

Run the setup wizard to configure your vault:
```bash
cd plugin && bun run setup
```

Or manually create `~/.cc-obsidian-mem/config.json`:

```json
{
  "vault": {
    "path": "/path/to/your/obsidian/vault",
    "memFolder": "_claude-mem"
  },
  "capture": {
    "fileEdits": true,
    "bashCommands": true,
    "bashOutput": {
      "enabled": true,
      "maxLength": 5000
    },
    "errors": true,
    "decisions": true
  },
  "summarization": {
    "enabled": true,
    "model": "sonnet",
    "sessionSummary": true,
    "errorSummary": true
  },
  "contextInjection": {
    "enabled": true,
    "maxTokens": 4000,
    "includeRecentSessions": 3,
    "includeRelatedErrors": true,
    "includeProjectPatterns": true
  }
}
```

> **Note**: AI summarization uses the Claude Code SDK (via `claude -p` CLI), so no separate API key is required. Valid model values: `sonnet`, `opus`, `haiku`.

## Usage

### Automatic Capture

Once installed, the plugin automatically:
- Logs file edits, bash commands, and errors during sessions
- Creates session notes with observations
- Updates error patterns when recurring issues occur
- Generates AI summaries at session end (if enabled)

### Skills (User Commands)

#### `/mem-search` - Search your knowledge base
```
/mem-search authentication error fix
/mem-search database schema decisions
/mem-search recent sessions
```

#### `/mem-save` - Save knowledge explicitly
```
/mem-save decision: We chose PostgreSQL for better JSON support
/mem-save pattern: This regex validates email addresses
/mem-save learning: API rate limits at 100 req/min
```

#### `/mem-status` - Check system status
```
/mem-status
```

### MCP Tools

The MCP server provides these tools:

| Tool | Description |
|------|-------------|
| `mem_search` | Search notes by query, project, type, or tags |
| `mem_read` | Read a specific note's content |
| `mem_write` | Create or update notes |
| `mem_supersede` | Create a new note that supersedes an existing one (bidirectional links) |
| `mem_project_context` | Get context for a project |
| `mem_list_projects` | List all tracked projects |

## Vault Structure

```
vault/
├── _claude-mem/
│   ├── index.md                     # Dashboard with Dataview queries
│   ├── projects/
│   │   └── {project-name}/
│   │       ├── {project-name}.md    # Project overview (base note)
│   │       ├── sessions/
│   │       │   ├── sessions.md      # Category index
│   │       │   └── *.md             # Session logs
│   │       ├── errors/
│   │       │   ├── errors.md        # Category index
│   │       │   └── *.md             # Error patterns
│   │       ├── decisions/
│   │       │   ├── decisions.md     # Category index
│   │       │   └── *.md             # Architectural decisions
│   │       ├── knowledge/
│   │       │   ├── knowledge.md     # Category index
│   │       │   └── *.md             # Q&A, explanations, research
│   │       ├── research/
│   │       │   ├── research.md      # Category index
│   │       │   └── *.md             # External research notes
│   │       └── files/
│   │           ├── files.md         # Category index
│   │           └── *.md             # File-specific knowledge
│   ├── global/
│   │   ├── patterns/                # Reusable patterns
│   │   ├── tools/                   # Tool usage notes
│   │   └── learnings/               # General learnings
│   └── templates/                   # Note templates
```

Notes follow a hierarchical linking structure for proper Obsidian graph navigation:
- Individual notes link to their category index via `parent` frontmatter
- Category indexes link to the project base
- Superseded notes link bidirectionally (old → new via `superseded_by`, new → old via `supersedes`)

## Obsidian Features Used

- **Frontmatter/Properties**: YAML metadata for filtering and Dataview
- **Wikilinks**: `[[Note]]`, `[[Note#heading]]` for navigation
- **Callouts**: `> [!warning]`, `> [!success]` for visual highlighting
- **Dataview queries**: Dynamic dashboards and indexes
- **Graph view**: Visualize connections between notes
- **Tags**: `#session`, `#error`, `#project/name` for organization

## Development

### Project Structure

```
cc-obsidian-mem/
├── .claude-plugin/
│   └── marketplace.json     # Marketplace manifest
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json      # Plugin manifest
│   ├── .mcp.json            # MCP server config
│   ├── hooks/
│   │   ├── hooks.json       # Hook definitions
│   │   └── scripts/         # Hook scripts
│   ├── skills/              # Skill definitions
│   └── src/
│       ├── mcp-server/      # MCP server
│       └── shared/          # Shared utilities
```

### Running Tests
```bash
cd plugin && bun test
```

### Building
```bash
cd plugin && bun run build
```

## Troubleshooting

### No data being captured
1. Restart Claude Code after installing the plugin
2. Check that `~/.cc-obsidian-mem/config.json` exists with correct vault path
3. Verify vault path is writable
4. Check `~/.cc-obsidian-mem/sessions/` for session files

### AI summaries not working
1. Check `summarization.enabled` is `true` in config
2. Verify `model` is a valid value: `sonnet`, `opus`, or `haiku`
3. Check background summarization log: `cat /tmp/cc-obsidian-mem-background.log`
4. Ensure Claude Code CLI is available: `which claude`

### Plugin not loading
1. Run `/plugin` to verify the plugin is installed
2. Check plugin validation: `claude plugin validate /path/to/cc-obsidian-mem`
3. Look for errors in Claude Code debug mode: `claude --debug`

## License

MIT

## Credits

Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) by thedotmack.
