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
  readSchedule 
} from "./schedule"
import { OPENCODE_HOST, discoverOpencodePort, type ScheduledTask } from "./types"

const POLL_INTERVAL = 30_000 // 30 seconds
const ONCE_MODE = process.argv.includes("--once")

// Cache discovered port (won't change during daemon lifetime)
let cachedPort: number | null = null

async function getOpencodePort(): Promise<number | null> {
  if (cachedPort) return cachedPort
  cachedPort = await discoverOpencodePort()
  if (cachedPort) {
    console.log(`[daemon] Discovered OpenCode on port ${cachedPort}`)
  }
  return cachedPort
}

async function isOpencodeRunning(): Promise<boolean> {
  const port = await getOpencodePort()
  if (!port) {
    console.log(`[daemon] Port discovery returned null`)
    return false
  }
  try {
    const res = await fetch(`${OPENCODE_HOST}:${port}/global/health`)
    return res.ok
  } catch (err) {
    // Port discovery succeeded but connection failed - reset cache
    console.log(`[daemon] Connection to port ${port} failed:`, err)
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
  console.log(`[daemon] Executing task: ${task.id} - "${task.prompt.slice(0, 50)}..."`)
  
  const port = await getOpencodePort()
  if (!port) {
    console.log(`[daemon] Cannot discover OpenCode port, skipping task`)
    return
  }
  
  const client = createOpencodeClient({ 
    baseUrl: `${OPENCODE_HOST}:${port}` 
  })

  // If no sessionId, try to get the most recent session
  let sessionId = task.sessionId
  if (!sessionId) {
    console.log(`[daemon] No sessionId in task, fetching sessions...`)
    try {
      const sessions = await client.session.list()
      if (sessions.data && sessions.data.length > 0) {
        // Get most recent session (they should be sorted)
        sessionId = sessions.data[0].id
        console.log(`[daemon] Using most recent session: ${sessionId}`)
        await updateTask(task.id, { sessionId })
      } else {
        console.log(`[daemon] No sessions found, creating new session`)
        const newSession = await client.session.create({ body: { title: "Scheduled Task" } })
        sessionId = newSession.data!.id
        await updateTask(task.id, { sessionId })
      }
    } catch (err) {
      console.error(`[daemon] Failed to get/create session:`, err)
      await updateTask(task.id, { status: "failed", lastError: "Could not get or create session" })
      return
    }
  }

  // Check if main session is busy
  const status = await getSessionStatus(client, sessionId)
  
  // For normal priority, wait for idle
  if (task.priority === "normal" && status !== "idle" && status !== null) {
    console.log(`[daemon] Session ${sessionId} is busy (${status}), deferring normal-priority task`)
    return
  }

  // Mark as running before we start
  await updateTask(task.id, { status: "running" })

  try {
    // Fork the main session
    console.log(`[daemon] Forking session ${sessionId}`)
    const fork = await client.session.fork({ 
      path: { id: sessionId } 
    })
    const forkId = fork.data!.id
    console.log(`[daemon] Created fork: ${forkId}`)

    // Store fork ID for the plugin to track
    await updateTask(task.id, { forkSessionId: forkId })

    // Send the task prompt to the forked session
    // Using prompt (not promptAsync) so we wait for completion
    console.log(`[daemon] Sending prompt to fork...`)
    const result = await client.session.prompt({
      path: { id: forkId },
      body: {
        parts: [{ 
          type: "text", 
          text: buildTaskPrompt(task)
        }]
      }
    })

    console.log(`[daemon] Fork completed, extracting summary...`)
    
    // Extract summary from response
    const summary = extractSummary(result.data)

    // Join back to main session
    // silent=true -> noReply (background task, just inject info)
    // silent=false -> let agent respond (user-facing task)
    const shouldBeQuiet = task.silent ?? false
    console.log(`[daemon] Joining results back to main session (silent=${shouldBeQuiet})...`)
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

    // Handle recurrence
    if (task.recurrence) {
      const nextTrigger = getNextTriggerTime(task.recurrence)
      await addTask({
        sessionId: task.sessionId,
        triggerAt: nextTrigger,
        prompt: task.prompt,
        priority: task.priority,
        recurrence: task.recurrence,
        silent: task.silent,
      })
      console.log(`[daemon] Scheduled next occurrence: ${new Date(nextTrigger).toISOString()}`)
    }

    // Mark completed
    await updateTask(task.id, { status: "completed" })
    console.log(`[daemon] Task ${task.id} completed successfully`)

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
    console.error(`[daemon] Task ${task.id} failed:`, err)
    await updateTask(task.id, { 
      status: "failed", 
      lastError: err instanceof Error ? err.message : String(err)
    })
  }
}

function buildTaskPrompt(task: ScheduledTask): string {
  return `<scheduled_task id="${task.id}" priority="${task.priority}" scheduled_for="${new Date(task.triggerAt).toISOString()}">
## Scheduled Task

${task.prompt}

---
Instructions:
1. Execute the task above completely
2. Provide a clear summary of what was done and any results
${task.recurrence ? `3. Note: This is a recurring task (${task.recurrence}). Next occurrence will be scheduled automatically.` : ''}
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
  console.log(`[daemon] Running once at ${new Date().toISOString()}`)
  
  if (!(await isOpencodeRunning())) {
    console.log("[daemon] OpenCode not running, skipping")
    return
  }

  const dueTasks = await getDueTasks()
  console.log(`[daemon] Found ${dueTasks.length} due tasks`)

  for (const task of dueTasks) {
    await executeTask(task)
  }
}

async function runLoop(): Promise<void> {
  console.log(`[daemon] Starting daemon loop (${POLL_INTERVAL / 1000}s interval)`)
  
  while (true) {
    try {
      await runOnce()
    } catch (err) {
      console.error("[daemon] Error in loop:", err)
    }
    await Bun.sleep(POLL_INTERVAL)
  }
}

// Main
console.log("[daemon] OpenCode Reminders Daemon starting...")
console.log(`[daemon] Schedule file: ~/.config/opencode/reminders.json`)
console.log(`[daemon] OpenCode endpoint: auto-discover via lsof`)

if (ONCE_MODE) {
  runOnce().then(() => process.exit(0)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
} else {
  runLoop()
}
