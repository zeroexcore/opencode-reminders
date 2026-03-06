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
- Installs LaunchAgent for background daemon
- Starts the daemon

Restart OpenCode after install.

## Usage

### Schedule a task
```
remind({ delay: "2m", prompt: "Check my email", priority: "normal" })
remind({ delay: "1h", prompt: "Review PR #123", priority: "critical" })
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

| Priority | Behavior |
|----------|----------|
| `normal` | Waits for session idle |
| `critical` | Forks immediately |

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
- OpenCode port: 4096 (change in `src/types.ts`)
- Poll interval: 30s (change in `src/daemon.ts`)

## Troubleshooting

```bash
# OpenCode running?
curl http://localhost:4096/global/health

# Schedule file
cat ~/.config/opencode/reminders.json

# Daemon logs
tail /tmp/opencode-reminders.log
```

## License

MIT
