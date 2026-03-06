/**
 * Schedule tool for OpenCode
 * 
 * This gets copied to ~/.config/opencode/tools/schedule.ts
 */
import { tool } from "@opencode-ai/plugin"
import { addTask, parseDelay, getNextTriggerTime } from "./schedule"
import type { Priority } from "./types"

export const schedule = tool({
  description: `Schedule a future task for yourself (the agent). Use this to:
- Set reminders that will interrupt you at a specific time
- Schedule recurring tasks (e.g., "check markets daily at 21:30")
- Defer work to later ("remind me in 2 hours to review PR")

The task will be executed via fork/join - your current context is preserved.
For critical tasks, you will be interrupted immediately when triggered.
For normal tasks, execution waits for an idle moment.`,

  args: {
    delay: tool.schema.string().describe(
      'When to trigger. Examples: "2m", "1h30m", "24h", "1d". Required unless using absoluteTime.'
    ).optional(),
    absoluteTime: tool.schema.string().describe(
      'ISO timestamp for when to trigger. Alternative to delay.'
    ).optional(),
    prompt: tool.schema.string().describe(
      'What to do when triggered. Be specific - this is what future-you will see.'
    ),
    priority: tool.schema.enum(["normal", "critical"]).describe(
      'critical = interrupt immediately, normal = wait for idle'
    ).default("normal"),
    recurrence: tool.schema.string().describe(
      'For recurring tasks. Examples: "daily 21:30", "every 24h", "every 1h"'
    ).optional(),
  },

  async execute(args, context) {
    const { delay, absoluteTime, prompt, priority, recurrence } = args
    const sessionId = context.sessionId

    if (!delay && !absoluteTime) {
      throw new Error("Either delay or absoluteTime is required")
    }

    let triggerAt: number
    if (absoluteTime) {
      triggerAt = new Date(absoluteTime).getTime()
      if (isNaN(triggerAt)) throw new Error(`Invalid absoluteTime: ${absoluteTime}`)
    } else {
      triggerAt = Date.now() + parseDelay(delay!)
    }

    const task = await addTask({
      sessionId,
      triggerAt,
      prompt,
      priority: priority as Priority,
      recurrence,
    })

    const triggerDate = new Date(triggerAt)
    const relativeTime = formatRelativeTime(triggerAt - Date.now())

    let response = `Scheduled task for ${triggerDate.toLocaleString()} (${relativeTime})`
    if (recurrence) {
      response += `\nRecurrence: ${recurrence}`
    }
    response += `\nPriority: ${priority}`
    response += `\nTask ID: ${task.id}`

    return response
  },
})

function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `in ${days}d ${hours % 24}h`
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`
  if (minutes > 0) return `in ${minutes}m`
  return `in ${seconds}s`
}

export default schedule
