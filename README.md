# OpenCode Reminders

Self-scheduling for OpenCode agents using **fork/join** to preserve context.

## How it works

```
Main session: working on auth
         │
    [9:30 PM - task triggers]
         │
         ├────────────────────┐
         │                    ▼
         │           Fork: "Check markets"
         │                    │
         │                 (works)
         │                    │
         │    ◄───────────────┘
         │    Results injected
         ▼
Main session continues, context intact
```

The fork handles the interruption. Main session never lost context.

## Install

```bash
git clone https://github.com/zeroexcore/opencode-reminders.git
cd opencode-reminders
bun install
bun run install:plugin
```

This:
- Copies plugin to `~/.config/opencode/plugins/`
- Copies daemon to `~/.config/opencode/plugins/daemon.ts`
- Generates LaunchAgent plist from template (auto-detects paths)
- Starts the daemon

Restart OpenCode after install.

## Usage

### Schedule a task
```
remind({ delay: "2m", prompt: "Check my email", priority: "normal" })
remind({ delay: "1h", prompt: "Review PR #123", priority: "critical" })

# silent=false (default) - agent responds to result (user-facing)
remind({ delay: "1m", prompt: "Tell user a fun fact", silent: false })

# silent=true - inject result without response (background task)
remind({ delay: "1h", prompt: "Check portfolio", silent: true })
```

### Recurring tasks
```
remind({ 
  recurrence: "daily 21:30", 
  prompt: "Check markets",
  priority: "critical"
})
```

### List reminders
```
list_reminders()
```

### Cancel
```
cancel_reminder({ id: "abc12345" })
```

## Priority

| Priority | Behavior | Default |
|----------|----------|---------|
| `critical` | Forks immediately (interrupts) | ✓ |
| `normal` | Waits for session idle | |

User reminders should interrupt. Agent background tasks can use `normal`.

## Daemon

```bash
# Check status
launchctl list | grep opencode-reminders

# Logs
tail -f /tmp/opencode-reminders.log

# Stop
launchctl unload ~/Library/LaunchAgents/com.oxc.opencode-reminders.plist

# Start
launchctl load ~/Library/LaunchAgents/com.oxc.opencode-reminders.plist
```

## Config

- Schedule file: `~/.config/opencode/reminders.json`
- OpenCode port: auto-discovered via `lsof` (no config needed)
- Poll interval: 30s (change in `src/daemon.ts`)

## Troubleshooting

```bash
# OpenCode running?
curl http://localhost:4096/global/health

# Quick check if port is in use
lsof -i :4096 -sTCP:LISTEN >/dev/null 2>&1 && echo "running" || echo "not running"

# Schedule file
cat ~/.config/opencode/reminders.json

# Daemon logs
tail /tmp/opencode-reminders.log
```

## License

MIT
