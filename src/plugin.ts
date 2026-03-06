/**
 * Reminders Plugin for OpenCode
 * 
 * Handles fork/join execution of scheduled tasks and monitors for completion.
 * This gets copied to ~/.config/opencode/plugins/reminders.ts
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { 
  addTask, 
  updateTask, 
  removeTask, 
  getRunningTasks, 
  readSchedule,
  parseDelay,
  getNextTriggerTime 
} from "./schedule"
import type { ScheduledTask, Priority } from "./types"

export const RemindersPlugin: Plugin = async ({ client }) => {
  console.log("[reminders] Plugin loaded")

  // Check for any tasks that were running when OpenCode restarted
  const running = await getRunningTasks()
  for (const task of running) {
    console.log(`[reminders] Found orphaned running task: ${task.id}, marking as pending`)
    await updateTask(task.id, { status: "pending", forkSessionId: undefined })
  }

  return {
    // Monitor forked sessions for completion
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const idleSessionId = event.properties.sessionID
        
        // Check if this is a forked reminder session that completed
        const schedule = await readSchedule()
        const runningTask = schedule.tasks.find(
          (t) => t.status === "running" && t.forkSessionId === idleSessionId
        )

        if (runningTask) {
          console.log(`[reminders] Forked session completed for task: ${runningTask.id}`)
          await handleForkCompletion(client, runningTask, idleSessionId)
        }
      }
    },

    // Expose the schedule tool
    tool: {
      schedule: tool({
        description: `Schedule a future task for yourself (the agent). Use this to:
- Set reminders that will interrupt you at a specific time
- Schedule recurring tasks (e.g., "check markets daily at 21:30")  
- Defer work to later ("remind me in 2 hours to review PR")

The task will be executed via fork/join - your current context is preserved.
For critical tasks, you will be interrupted immediately when triggered.
For normal tasks, execution waits for an idle moment.`,

        args: {
          delay: tool.schema.string().describe(
            'When to trigger. Examples: "2m", "1h30m", "24h", "1d"'
          ).optional(),
          prompt: tool.schema.string().describe(
            'What to do when triggered. Be specific.'
          ),
          priority: tool.schema.enum(["normal", "critical"]).describe(
            'critical = interrupt immediately, normal = wait for idle'
          ).default("normal"),
          recurrence: tool.schema.string().describe(
            'For recurring tasks. Examples: "daily 21:30", "every 24h"'
          ).optional(),
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
            sessionId: context.sessionId,
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

      // Tool to list scheduled tasks
      schedule_list: tool({
        description: "List all scheduled tasks",
        args: {},
        async execute() {
          const schedule = await readSchedule()
          if (schedule.tasks.length === 0) {
            return "No scheduled tasks"
          }

          return schedule.tasks
            .map((t) => {
              const time = new Date(t.triggerAt).toLocaleString()
              const status = t.status === "pending" ? "⏳" : t.status === "running" ? "🔄" : "✅"
              return `${status} [${t.id.slice(0, 8)}] ${time} - ${t.prompt.slice(0, 40)}...`
            })
            .join("\n")
        },
      }),

      // Tool to cancel a scheduled task
      schedule_cancel: tool({
        description: "Cancel a scheduled task by ID",
        args: {
          id: tool.schema.string().describe("Task ID (can be partial, first 8 chars)"),
        },
        async execute(args) {
          const schedule = await readSchedule()
          const task = schedule.tasks.find((t) => t.id.startsWith(args.id))
          if (!task) {
            throw new Error(`Task not found: ${args.id}`)
          }
          await removeTask(task.id)
          return `Cancelled task: ${task.id}`
        },
      }),
    },
  }
}

async function handleForkCompletion(
  client: any, 
  task: ScheduledTask, 
  forkSessionId: string
): Promise<void> {
  try {
    // Get the fork's messages to extract summary
    const messages = await client.session.messages({ path: { id: forkSessionId } })
    
    // Find the last assistant message
    const lastAssistant = [...messages.data].reverse().find(
      (m: any) => m.info.role === "assistant"
    )
    
    let summary = "Task completed (no response captured)"
    if (lastAssistant) {
      const textPart = lastAssistant.parts.find((p: any) => p.type === "text")
      if (textPart) {
        summary = textPart.text.slice(0, 2000) // Truncate if too long
      }
    }

    // Inject summary back into original session
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

${task.recurrence ? `## Note: This is a recurring task (${task.recurrence}). A new task has been scheduled.` : ''}
</scheduled_task_completed>`
        }]
      }
    })

    // Handle recurrence - schedule next occurrence
    if (task.recurrence) {
      const nextTrigger = getNextTriggerTime(task.recurrence)
      await addTask({
        sessionId: task.sessionId,
        triggerAt: nextTrigger,
        prompt: task.prompt,
        priority: task.priority,
        recurrence: task.recurrence,
      })
      console.log(`[reminders] Scheduled next occurrence for: ${new Date(nextTrigger).toISOString()}`)
    }

    // Mark original task as completed
    await updateTask(task.id, { status: "completed" })

    // Optionally delete the fork session (uncomment if desired)
    // await client.session.delete({ path: { id: forkSessionId } })

    console.log(`[reminders] Task ${task.id} completed and joined back to session ${task.sessionId}`)
  } catch (err) {
    console.error(`[reminders] Error handling fork completion:`, err)
    await updateTask(task.id, { 
      status: "failed", 
      lastError: err instanceof Error ? err.message : String(err) 
    })
  }
}

export default RemindersPlugin
