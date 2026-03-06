# OpenCode Reminders - Agent Skill

Self-scheduling reminder system for OpenCode agents using fork/join to preserve context.

## Mental Model: Human vs Agent Reminders

### Human-initiated reminders
User says: "remind me in 10 mins to check the build"

Expected behavior:
- **Interrupt** when due (don't wait for idle)
- **Agent responds** naturally ("Hey, the build finished - here's the status...")
- Feels like a conversation, not a system dump

Settings: `priority: "critical"` (default), `silent: false` (default)

### Agent-initiated background tasks
Agent schedules: "check portfolio every hour"

Expected behavior:
- **Wait for idle** (don't interrupt user mid-thought)
- **Silent injection** (agent sees info in context, decides if worth mentioning)
- Agent can act on info without forcing a response

Settings: `priority: "normal"`, `silent: true`

## Semantics

### Priority = When to interrupt

| Priority | Behavior | Who uses it |
|----------|----------|-------------|
| `critical` (default) | Fork immediately | Human reminders - "remind me in 5 mins" |
| `normal` | Wait for session idle | Agent tasks - "check X periodically" |

### Silent = Whether agent responds

| Mode | Behavior | Use case |
|------|----------|----------|
| `silent: false` (default) | Agent responds to result | Need to communicate/act on result |
| `silent: true` | Inject into context only | Just want info available, decide later |

**Key insight**: `silent` isn't human vs agent. It's about whether the task result needs a response.

Agent tasks often want `silent: false` to paste context back and act on it:
- "Fetch latest prices and update the user" → needs response
- "Research X and summarize findings" → needs response
- "Check build status" → just info, might mention if failed

### Common Patterns

```
# User reminder - interrupt + respond
"remind me in 2 mins to stretch"
→ priority: critical, silent: false
→ Agent: "Hey! Time to stretch. Stand up, roll your shoulders..."

# User info request - interrupt + respond  
"tell me a fun fact in 1 min"
→ priority: critical, silent: false
→ Agent: "Here's something cool: [presents fact naturally]"

# Agent task needing response - wait + respond
"fetch market data and brief me when idle"
→ priority: normal, silent: false
→ Agent: "Quick market update: BTC up 3%, ETH flat..."

# Agent research task - wait + respond
"research this error and report back"
→ priority: normal, silent: false  
→ Agent: "Found the issue - it's a known bug in v2.3..."

# Agent passive monitoring - wait + silent
"check build status periodically"
→ priority: normal, silent: true
→ Agent sees status, only speaks up if failed

# Agent context gathering - wait + silent
"load project README into context"
→ priority: normal, silent: true
→ Info available, no response needed
```

### Decision Matrix

| Need to tell user? | Time sensitive? | Settings |
|--------------------|-----------------|----------|
| Yes | Yes | `critical`, `silent: false` |
| Yes | No | `normal`, `silent: false` |
| Maybe | No | `normal`, `silent: true` |
| No (just context) | No | `normal`, `silent: true` |

## Core Concepts

### Fork/Join Pattern
When a reminder triggers, the daemon:
1. Forks the main session (preserves all context)
2. Executes the task in the fork
3. Joins results back to main session via message injection

The main session never loses context - the fork handles the interruption.

## Tool Usage

### Basic reminder (interrupts, agent responds)
```
remind({ delay: "2m", prompt: "Check my email" })
```

### Background task (waits for idle, silent)
```
remind({ 
  delay: "1h", 
  prompt: "Check portfolio status",
  priority: "normal",
  silent: true 
})
```

### Recurring task
```
remind({ 
  recurrence: "daily 21:30", 
  prompt: "Review market positions",
  silent: true  // background check
})
```

## Architecture

### Components
- **Plugin** (`~/.config/opencode/plugins/reminders.ts`): Provides tools, runs inside OpenCode
- **Daemon** (`~/.config/opencode/plugins/daemon.ts`): Background service, triggers tasks
- **Schedule** (`~/.config/opencode/reminders.json`): Persisted task list

### Port Discovery
The daemon auto-discovers OpenCode's port via:
```bash
lsof -c opencode -i -sTCP:LISTEN -nP
```
No hardcoded port - works regardless of `--port` flag.

### Session Detection
Daemon checks session status before executing:
- `critical`: Fork immediately regardless of busy state
- `normal`: Wait until session reports `idle`

## Key Discoveries

1. **`context.sessionID`** (capital ID) - how plugins get current session
2. **`noReply: true`** - injects message without triggering response
3. **Session status** returns `{ type: "busy" }` object, not string
4. **Multiple opencode processes** - must filter for LISTEN socket owner
5. **Plugin vs daemon responsibility** - daemon handles fork completion, not plugin (avoids duplicates)

## Troubleshooting

```bash
# Check if opencode is running
lsof -c opencode -i -sTCP:LISTEN -nP

# Daemon status
launchctl list | grep opencode-reminders

# Daemon logs
tail -f /tmp/opencode-reminders.log

# Schedule file
cat ~/.config/opencode/reminders.json

# Restart daemon
launchctl unload ~/Library/LaunchAgents/com.oxc.opencode-reminders.plist
launchctl load ~/Library/LaunchAgents/com.oxc.opencode-reminders.plist
```

## Installation

The install script:
1. Auto-detects bun binary location
2. Copies plugin to `~/.config/opencode/plugins/`
3. Generates plist from template (fills in paths)
4. Installs LaunchAgent for background daemon

```bash
git clone https://github.com/zeroexcore/opencode-reminders.git
cd opencode-reminders
bun install
bun run install:plugin
```

Restart OpenCode after install to load the plugin.
