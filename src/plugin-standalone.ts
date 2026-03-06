/**
 * Reminders Plugin for OpenCode (Standalone version)
 * 
 * This file is self-contained and gets copied to ~/.config/opencode/plugins/
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

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
  status: TaskStatus
  lastError?: string
  forkSessionId?: string
}

interface Schedule {
  tasks: ScheduledTask[]
  version: number
}

const SCHEDULE_PATH = `${process.env.HOME}/.config/opencode/reminders.json`

// ============ Schedule Operations ============
const DEFAULT_SCHEDULE: Schedule = { tasks: [], version: 1 }

async function readSchedule(): Promise<Schedule> {
  try {
    const file = Bun.file(SCHEDULE_PATH)
    if (!(await file.exists())) return DEFAULT_SCHEDULE
    return await file.json()
  } catch {
    return DEFAULT_SCHEDULE
  }
}

async function writeSchedule(schedule: Schedule): Promise<void> {
  await Bun.write(SCHEDULE_PATH, JSON.stringify(schedule, null, 2))
}

async function addTask(task: Omit<ScheduledTask, "id" | "createdAt" | "status">): Promise<ScheduledTask> {
  const schedule = await readSchedule()
  const newTask: ScheduledTask = {
    ...task,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    status: "pending",
  }
  schedule.tasks.push(newTask)
  await writeSchedule(schedule)
  return newTask
}

async function updateTask(id: string, updates: Partial<ScheduledTask>): Promise<void> {
  const schedule = await readSchedule()
  const idx = schedule.tasks.findIndex((t) => t.id === id)
  if (idx !== -1) {
    schedule.tasks[idx] = { ...schedule.tasks[idx], ...updates }
    await writeSchedule(schedule)
  }
}

async function removeTask(id: string): Promise<void> {
  const schedule = await readSchedule()
  schedule.tasks = schedule.tasks.filter((t) => t.id !== id)
  await writeSchedule(schedule)
}

async function getRunningTasks(): Promise<ScheduledTask[]> {
  const schedule = await readSchedule()
  return schedule.tasks.filter((t) => t.status === "running")
}

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

// ============ Plugin ============
export const RemindersPlugin: Plugin = async ({ client }) => {
  console.log("[reminders] Plugin loaded")

  // Reset any orphaned running tasks
  const running = await getRunningTasks()
  for (const task of running) {
    console.log(`[reminders] Found orphaned running task: ${task.id}, marking as pending`)
    await updateTask(task.id, { status: "pending", forkSessionId: undefined })
  }

  return {
    // NOTE: Fork completion is handled by the daemon, not here.
    // The daemon waits for the fork to complete and injects the summary.
    // We only provide the tools here.

    tool: {
      remind: tool({
        description: `Schedule a future task for yourself (the agent). Use this to:
- Set reminders that will interrupt you at a specific time
- Schedule recurring tasks (e.g., "check markets daily at 21:30")  
- Defer work to later ("remind me in 2 hours to review PR")

The task executes via fork/join - your current context is preserved.
critical = interrupt immediately, normal = wait for idle.

NOTE: Use this instead of the native 'schedule' tool - this one captures session context.`,

        args: {
          delay: tool.schema.string().describe('When to trigger: "2m", "1h30m", "24h", "1d"').optional(),
          prompt: tool.schema.string().describe('What to do when triggered'),
          priority: tool.schema.enum(["normal", "critical"]).default("normal"),
          recurrence: tool.schema.string().describe('Recurring: "daily 21:30", "every 24h"').optional(),
        },

        async execute(args, context) {
          const { delay, prompt, priority, recurrence } = args

          if (!delay && !recurrence) {
            throw new Error("Either delay or recurrence is required")
          }

          let triggerAt: number
          if (recurrence && !delay) {
            triggerAt = getNextTriggerTime(recurrence)
          } else {
            triggerAt = Date.now() + parseDelay(delay!)
          }

          const task = await addTask({
            sessionId: context.sessionID,
            triggerAt,
            prompt,
            priority: priority as Priority,
            recurrence,
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
          const schedule = await readSchedule()
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
          const schedule = await readSchedule()
          const task = schedule.tasks.find((t) => t.id.startsWith(args.id))
          if (!task) throw new Error(`Reminder not found: ${args.id}`)
          await removeTask(task.id)
          return `Cancelled reminder: ${task.id}`
        },
      }),
    },
  }
}

async function handleForkCompletion(client: any, task: ScheduledTask, forkSessionId: string): Promise<void> {
  try {
    const messages = await client.session.messages({ path: { id: forkSessionId } })
    const lastAssistant = [...messages.data].reverse().find((m: any) => m.info.role === "assistant")
    
    let summary = "Task completed (no response captured)"
    if (lastAssistant) {
      const textPart = lastAssistant.parts.find((p: any) => p.type === "text")
      if (textPart) summary = textPart.text.slice(0, 2000)
    }

    await client.session.prompt({
      path: { id: task.sessionId },
      body: {
        noReply: true,
        parts: [{
          type: "text",
          text: `<scheduled_task_completed id="${task.id}" time="${new Date().toISOString()}">
## Task: ${task.prompt}

## Result:
${summary}

${task.recurrence ? `## Note: Recurring task (${task.recurrence}) - next occurrence scheduled.` : ''}
</scheduled_task_completed>`
        }]
      }
    })

    if (task.recurrence) {
      const nextTrigger = getNextTriggerTime(task.recurrence)
      await addTask({
        sessionId: task.sessionId,
        triggerAt: nextTrigger,
        prompt: task.prompt,
        priority: task.priority,
        recurrence: task.recurrence,
      })
      console.log(`[reminders] Scheduled next: ${new Date(nextTrigger).toISOString()}`)
    }

    await updateTask(task.id, { status: "completed" })
    console.log(`[reminders] Task ${task.id} completed`)
  } catch (err) {
    console.error(`[reminders] Error:`, err)
    await updateTask(task.id, { status: "failed", lastError: String(err) })
  }
}

export default RemindersPlugin
