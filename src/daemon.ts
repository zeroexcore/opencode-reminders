#!/usr/bin/env bun
/**
 * Reminders Daemon
 * 
 * Runs in background, checks schedule file, triggers tasks via OpenCode API.
 * Uses fork/join pattern to preserve main session context.
 * 
 * Usage:
 *   bun run daemon        # Run continuously (30s poll interval)
 *   bun run daemon:once   # Run once and exit (for cron/launchd)
 */
import { createOpencodeClient } from "@opencode-ai/sdk"
import { 
  getDueTasks, 
  updateTask, 
  addTask,
  getNextTriggerTime,
  readSchedule,
  blockSession
} from "./schedule"
import { OPENCODE_HOST, discoverOpencodePort, type ScheduledTask } from "./types"

const POLL_INTERVAL = 30_000 // 30 seconds
const ONCE_MODE = process.argv.includes("--once")
const LOG_FILE = "/tmp/opencode-reminders.log"

// Simple file-based logging (doesn't interfere with TUI)
import { appendFileSync } from "fs"
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  appendFileSync(LOG_FILE, line)
}

// Cache discovered port (won't change during daemon lifetime)
let cachedPort: number | null = null

async function getOpencodePort(): Promise<number | null> {
  if (cachedPort) return cachedPort
  cachedPort = await discoverOpencodePort()
  if (cachedPort) {
  }
  return cachedPort
}

async function isOpencodeRunning(): Promise<boolean> {
  const port = await getOpencodePort()
  if (!port) {
    return false
  }
  try {
    const res = await fetch(`${OPENCODE_HOST}:${port}/global/health`)
    return res.ok
  } catch (err) {
    // Port discovery succeeded but connection failed - reset cache
    cachedPort = null
    return false
  }
}

async function getSessionStatus(client: any, sessionId: string): Promise<string | null> {
  try {
    const status = await client.session.status()
    const sessionStatus = status.data?.[sessionId]
    // Status is an object like { type: "busy" } or { type: "idle" }
    return sessionStatus?.type ?? null
  } catch {
    return null
  }
}

async function executeTask(task: ScheduledTask): Promise<void> {
  log(`Executing task: ${task.id} - "${task.prompt.slice(0, 50)}..."`)
  
  const port = await getOpencodePort()
  if (!port) {
    return
  }
  
  const client = createOpencodeClient({ 
    baseUrl: `${OPENCODE_HOST}:${port}` 
  })

  // Get/validate session ID
  // Note: Plugin may capture wrong sessionId (fork instead of main) due to context bug
  // Forks have "(fork" in title - we need to find a non-fork session
  let sessionId = task.sessionId
  try {
    const sessions = await client.session.list()
    
    // Check if stored session is a fork (has "fork" in title)
    const storedSession = sessions.data?.find(s => s.id === sessionId)
    const isFork = storedSession?.title?.includes("(fork")
    
    if (!storedSession || isFork) {
      // Need to find a non-fork session
      const mainSession = sessions.data?.find(s => !s.title?.includes("(fork"))
      if (mainSession) {
        sessionId = mainSession.id
        await log(`Using main session ${sessionId} instead of ${task.sessionId}${isFork ? " (was fork)" : " (not found)"}`)
        await updateTask(task.id, { sessionId })
      } else if (sessions.data && sessions.data.length > 0) {
        // No non-fork session, use first available
        sessionId = sessions.data[0].id
        await log(`No main session found, using ${sessionId}`)
        await updateTask(task.id, { sessionId })
      } else {
        // No sessions at all, create one
        const newSession = await client.session.create({ body: { title: "Scheduled Task" } })
        sessionId = newSession.data!.id
        await updateTask(task.id, { sessionId })
      }
    }
  } catch (err) {
    await updateTask(task.id, { status: "failed", lastError: "Could not validate session" })
    return
  }

  // Check if main session is busy
  const status = await getSessionStatus(client, sessionId)
  
  // For normal priority, wait for idle
  if (task.priority === "normal" && status !== "idle" && status !== null) {
    return
  }

  // Mark as running before we start
  await updateTask(task.id, { status: "running" })

  try {
    // Fork the main session
    log(`Forking session ${sessionId}`)
    const fork = await client.session.fork({ 
      path: { id: sessionId } 
    })
    const forkId = fork.data!.id
    log(`Created fork: ${forkId}`)

    // Store fork ID and block this session from creating new reminders
    await updateTask(task.id, { forkSessionId: forkId })
    await log(`Blocking session ${forkId}...`)
    await blockSession(forkId)
    await log(`Session ${forkId} blocked successfully`)

    // Send the task prompt to the forked session
    // Using prompt (not promptAsync) so we wait for completion
    const result = await client.session.prompt({
      path: { id: forkId },
      body: {
        parts: [{ 
          type: "text", 
          text: buildTaskPrompt(task)
        }]
      }
    })

    log(`Fork completed, extracting summary...`)
    // Extract summary from response
    const summary = extractSummary(result.data)

    // NOTE: We removed the "check if task still exists" logic here.
    // Previously, zombie sessions could overwrite the file during fork execution,
    // causing legitimate tasks to appear "cancelled". Now we always inject.
    // Actual user cancellation should kill the fork session instead.

    // Join back to main session
    // silent=true -> noReply (background task, just inject info)
    // silent=false -> let agent respond (user-facing task)
    const shouldBeQuiet = task.silent ?? false
    log(`Joining back to main session (silent=${shouldBeQuiet})`)
    await client.session.prompt({
      path: { id: task.sessionId },
      body: {
        noReply: shouldBeQuiet,
        parts: [{
          type: "text",
          text: buildJoinMessage(task, summary)
        }]
      }
    })

    // Handle recurrence - reschedule SAME task instead of creating new one
    if (task.recurrence) {
      const nextTrigger = getNextTriggerTime(task.recurrence)
      log(`Recurring task - same ID ${task.id}, next trigger: ${new Date(nextTrigger).toISOString()}`)
      await updateTask(task.id, { 
        status: "pending", 
        triggerAt: nextTrigger,
        forkSessionId: undefined 
      })
    } else {
      // Mark completed only for non-recurring tasks
      log(`Task ${task.id} completed`)
      await updateTask(task.id, { status: "completed" })
    }

    // Show toast notification
    try {
      await client.tui.showToast({
        body: {
          message: `Scheduled task completed: ${task.prompt.slice(0, 30)}...`,
          variant: "success"
        }
      })
    } catch {
      // TUI might not be available
    }

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`Task ${task.id} failed: ${errMsg}`)
    await updateTask(task.id, { 
      status: "failed", 
      lastError: errMsg
    })
  }
}

function buildTaskPrompt(task: ScheduledTask): string {
  return `<scheduled_task id="${task.id}" priority="${task.priority}" scheduled_for="${new Date(task.triggerAt).toISOString()}">
## Scheduled Task

${task.prompt}

---
## CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. EXECUTE the task above and provide a brief summary
2. DO NOT call the remind tool - scheduling is handled automatically by the system
3. DO NOT call list_reminders or cancel_reminder
4. DO NOT try to reschedule or create any new reminders
5. Just respond with the task result, nothing more

If you call any reminder-related tools, the system will break. Simply execute the task and respond.
</scheduled_task>`
}

function buildJoinMessage(task: ScheduledTask, summary: string): string {
  return `<scheduled_task_completed id="${task.id}" time="${new Date().toISOString()}">
## Scheduled Task Completed: ${task.prompt.slice(0, 100)}

### Result:
${summary}

${task.recurrence ? `### Note: Recurring task (${task.recurrence}) - next occurrence scheduled automatically.` : ''}

---
You may continue with your previous work. Check your todo list if needed.
</scheduled_task_completed>`
}

function extractSummary(data: any): string {
  try {
    // data is { info: Message, parts: Part[] }
    const textPart = data.parts?.find((p: any) => p.type === "text")
    if (textPart?.text) {
      // Truncate if too long
      return textPart.text.slice(0, 3000)
    }
  } catch {}
  return "(No summary captured)"
}

async function runOnce(): Promise<void> {
  log(`[daemon] Poll cycle starting...`)
  if (!(await isOpencodeRunning())) {
    log(`[daemon] OpenCode not running, skipping`)
    return
  }

  const dueTasks = await getDueTasks()
  log(`[daemon] Found ${dueTasks.length} due tasks`)

  for (const task of dueTasks) {
    await executeTask(task)
  }
}

async function runLoop(): Promise<void> {
  
  while (true) {
    try {
      await runOnce()
    } catch (err) {
    }
    await Bun.sleep(POLL_INTERVAL)
  }
}

// Main

if (ONCE_MODE) {
  runOnce().then(() => process.exit(0)).catch((err) => {
    process.exit(1)
  })
} else {
  runLoop()
}
