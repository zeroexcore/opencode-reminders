/**
 * Reminders Plugin for OpenCode
 * 
 * Self-contained plugin using Node.js APIs (no Bun dependencies)
 * The daemon (daemon.ts) runs under Bun and handles task execution.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { execSync } from "child_process"

// ============ Types ============
type Priority = "normal" | "critical"
type TaskStatus = "pending" | "running" | "completed" | "failed"

interface ScheduledTask {
  id: string
  sessionId: string
  createdAt: number
  triggerAt: number
  prompt: string
  priority: Priority
  recurrence?: string
  silent?: boolean
  status: TaskStatus
  lastError?: string
  forkSessionId?: string
}

interface Schedule {
  tasks: ScheduledTask[]
  blockedSessions?: string[]
  version: number
}

const SCHEDULE_PATH = `${process.env.HOME}/.config/opencode/reminders.json`
const PORT_FILE = `${process.env.HOME}/.config/opencode/reminders-port`
const LOCK_PATH = SCHEDULE_PATH + ".lock"
const DEFAULT_SCHEDULE: Schedule = { tasks: [], blockedSessions: [], version: 1 }

// ============ Simple File Locking ============
function acquireLock(): void {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    try {
      if (existsSync(LOCK_PATH)) {
        const lockTime = parseInt(readFileSync(LOCK_PATH, "utf8"))
        if (Date.now() - lockTime > 5000) {
          // Stale lock
          writeFileSync(LOCK_PATH, String(Date.now()))
          return
        }
        // Wait
        const waitUntil = Date.now() + 50
        while (Date.now() < waitUntil) {} // Busy wait (sync)
        continue
      }
      writeFileSync(LOCK_PATH, String(Date.now()))
      return
    } catch {
      const waitUntil = Date.now() + 50
      while (Date.now() < waitUntil) {}
    }
  }
  // Timeout - proceed anyway
}

function releaseLock(): void {
  try {
    const fs = require("fs")
    fs.unlinkSync(LOCK_PATH)
  } catch {}
}

// ============ Schedule Operations ============
function readSchedule(): Schedule {
  if (!existsSync(SCHEDULE_PATH)) {
    writeFileSync(SCHEDULE_PATH, JSON.stringify(DEFAULT_SCHEDULE, null, 2))
    return DEFAULT_SCHEDULE
  }
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = readFileSync(SCHEDULE_PATH, "utf8")
      const parsed = JSON.parse(content) as Schedule
      if (!Array.isArray(parsed.tasks)) parsed.tasks = []
      if (!Array.isArray(parsed.blockedSessions)) parsed.blockedSessions = []
      return parsed
    } catch {
      const waitUntil = Date.now() + 50
      while (Date.now() < waitUntil) {}
    }
  }
  throw new Error("Failed to read schedule after 3 attempts")
}

function writeSchedule(schedule: Schedule): void {
  writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2))
}

function addTask(task: Omit<ScheduledTask, "id" | "createdAt" | "status">): ScheduledTask {
  acquireLock()
  try {
    const schedule = readSchedule()
    
    // Block tasks from fork sessions
    const isBlockedSession = schedule.blockedSessions?.includes(task.sessionId)
    const isActiveFork = schedule.tasks.some(t => t.forkSessionId === task.sessionId)
    if (isBlockedSession || isActiveFork) {
      throw new Error("Cannot create reminders from fork sessions")
    }
    
    const newTask: ScheduledTask = {
      ...task,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      status: "pending",
    }
    schedule.tasks.push(newTask)
    writeSchedule(schedule)
    return newTask
  } finally {
    releaseLock()
  }
}

function removeTask(id: string): void {
  acquireLock()
  try {
    const schedule = readSchedule()
    schedule.tasks = schedule.tasks.filter(t => t.id !== id)
    writeSchedule(schedule)
  } finally {
    releaseLock()
  }
}

// ============ Delay/Recurrence Parsing ============
function parseDelay(delay: string): number {
  const match = delay.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!match) throw new Error(`Invalid delay format: ${delay}`)
  const [, days, hours, mins, secs] = match
  return (
    (parseInt(days || "0") * 24 * 60 * 60 * 1000) +
    (parseInt(hours || "0") * 60 * 60 * 1000) +
    (parseInt(mins || "0") * 60 * 1000) +
    (parseInt(secs || "0") * 1000)
  )
}

function getNextTriggerTime(recurrence: string): number {
  if (recurrence.startsWith("every ")) {
    return Date.now() + parseDelay(recurrence.slice(6))
  }
  if (recurrence.startsWith("daily ")) {
    const [hours, mins] = recurrence.slice(6).split(":").map(Number)
    const next = new Date()
    next.setHours(hours, mins, 0, 0)
    if (next.getTime() <= Date.now()) {
      next.setDate(next.getDate() + 1)
    }
    return next.getTime()
  }
  throw new Error(`Invalid recurrence format: ${recurrence}`)
}

// ============ Port Discovery ============
function discoverAndWritePort(): void {
  try {
    const output = execSync(
      '/usr/sbin/lsof -c opencode -i -sTCP:LISTEN -nP 2>/dev/null || true',
      { encoding: 'utf8' }
    )
    for (const line of output.split("\n")) {
      if (line.includes("opencode") && line.includes("LISTEN")) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/)
        if (match) {
          writeFileSync(PORT_FILE, match[1])
          return
        }
      }
    }
  } catch {}
}

// ============ Plugin ============
export const RemindersPlugin: Plugin = async ({ client }) => {
  // Write port file for daemon
  discoverAndWritePort()

  return {
    tool: {
      remind: tool({
        description: `Schedule a future task for yourself (the agent). Use this to:
- Set reminders that will interrupt you at a specific time
- Schedule recurring tasks (e.g., "check markets daily at 21:30")  
- Defer work to later ("remind me in 2 hours to review PR")

The task executes via fork/join - your current context is preserved.
critical (default) = interrupt immediately (user-facing reminders)
normal = wait for idle (agent background tasks)
silent = true injects result without triggering response (background tasks).
silent = false (default) lets you respond to the result (user-facing tasks).

NOTE: Use this instead of the native 'schedule' tool - this one captures session context.`,

        args: {
          delay: tool.schema.string().describe('When to trigger: "2m", "1h30m", "24h", "1d"').optional(),
          prompt: tool.schema.string().describe('What to do when triggered'),
          priority: tool.schema.enum(["normal", "critical"]).default("critical"),
          recurrence: tool.schema.string().describe('Recurring: "daily 21:30", "every 24h"').optional(),
          silent: tool.schema.boolean().describe('Inject result silently without response (default: false)').optional(),
        },

        async execute(args, context) {
          const { delay, prompt, priority, recurrence, silent } = args

          // Check if this session is blocked (is a fork)
          const schedule = readSchedule()
          const isForkSession = schedule.tasks.some(t => t.forkSessionId === context.sessionID)
          const isBlockedSession = schedule.blockedSessions?.includes(context.sessionID)
          if (isForkSession || isBlockedSession) {
            return "Cannot schedule reminders from a fork session. Complete the current task without scheduling."
          }

          if (!delay && !recurrence) {
            throw new Error("Either delay or recurrence is required")
          }

          let triggerAt: number
          if (recurrence && !delay) {
            triggerAt = getNextTriggerTime(recurrence)
          } else {
            triggerAt = Date.now() + parseDelay(delay!)
          }

          const task = addTask({
            sessionId: context.sessionID,
            triggerAt,
            prompt,
            priority: priority as Priority,
            recurrence,
            silent: silent ?? false,
          })

          const triggerDate = new Date(triggerAt)
          let response = `Scheduled: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"\n`
          response += `Trigger: ${triggerDate.toLocaleString()}\n`
          response += `Priority: ${priority}\n`
          response += `ID: ${task.id}`
          if (recurrence) response += `\nRecurrence: ${recurrence}`
          return response
        },
      }),

      list_reminders: tool({
        description: "List all scheduled reminders",
        args: {},
        async execute() {
          const schedule = readSchedule()
          if (schedule.tasks.length === 0) return "No scheduled reminders"

          return schedule.tasks
            .map((t) => {
              const time = new Date(t.triggerAt).toLocaleString()
              const status = t.status === "pending" ? "⏳" : t.status === "running" ? "🔄" : "✅"
              return `${status} [${t.id.slice(0, 8)}] ${time} - ${t.prompt.slice(0, 40)}...`
            })
            .join("\n")
        },
      }),

      cancel_reminder: tool({
        description: "Cancel a scheduled reminder by ID",
        args: {
          id: tool.schema.string().describe("Reminder ID (can be partial)"),
        },
        async execute(args) {
          const schedule = readSchedule()
          const task = schedule.tasks.find((t) => t.id.startsWith(args.id))
          if (!task) throw new Error(`Reminder not found: ${args.id}`)
          removeTask(task.id)
          return `Cancelled reminder: ${task.id}`
        },
      }),
    },
  }
}

export default RemindersPlugin
