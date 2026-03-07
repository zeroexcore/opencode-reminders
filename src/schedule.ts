import { type Schedule, type ScheduledTask, SCHEDULE_PATH } from "./types"

const DEFAULT_SCHEDULE: Schedule = { tasks: [], version: 1 }
const LOCK_PATH = SCHEDULE_PATH + ".lock"
const LOCK_TIMEOUT = 5000 // 5 second lock timeout

// Simple file-based locking
async function acquireLock(): Promise<void> {
  const lockFile = Bun.file(LOCK_PATH)
  const startTime = Date.now()
  
  while (Date.now() - startTime < LOCK_TIMEOUT) {
    try {
      // Check if lock exists and is stale
      if (await lockFile.exists()) {
        const lockTime = parseInt(await lockFile.text())
        if (Date.now() - lockTime > LOCK_TIMEOUT) {
          // Stale lock, remove it
          await Bun.write(LOCK_PATH, String(Date.now()))
          return
        }
        // Lock held by another process, wait
        await Bun.sleep(50)
        continue
      }
      // No lock, create it
      await Bun.write(LOCK_PATH, String(Date.now()))
      return
    } catch {
      // Error reading lock, retry
      await Bun.sleep(50)
    }
  }
  // Timeout - proceed anyway (better than deadlock)
}

async function releaseLock(): Promise<void> {
  try {
    const fs = await import("fs/promises")
    await fs.unlink(LOCK_PATH)
  } catch {
    // Lock file already removed
  }
}

export async function readSchedule(): Promise<Schedule> {
  const file = Bun.file(SCHEDULE_PATH)
  if (!(await file.exists())) {
    // File doesn't exist - create with defaults
    await Bun.write(SCHEDULE_PATH, JSON.stringify(DEFAULT_SCHEDULE, null, 2))
    return DEFAULT_SCHEDULE
  }
  
  // Retry JSON parse a few times (handles partial writes)
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await file.text()
      const parsed = JSON.parse(content) as Schedule
      // Ensure required fields exist
      if (!Array.isArray(parsed.tasks)) parsed.tasks = []
      if (!Array.isArray(parsed.blockedSessions)) parsed.blockedSessions = []
      return parsed
    } catch (e) {
      lastError = e as Error
      await Bun.sleep(50) // Brief wait before retry
    }
  }
  
  // After retries, log error but DON'T return defaults (that would wipe tasks)
  console.error(`[schedule] Failed to parse ${SCHEDULE_PATH}: ${lastError?.message}`)
  throw lastError
}

export async function writeSchedule(schedule: Schedule): Promise<void> {
  await Bun.write(SCHEDULE_PATH, JSON.stringify(schedule, null, 2))
}

// Atomic read-modify-write with locking
export async function withScheduleLock<T>(fn: (schedule: Schedule) => Promise<{ schedule: Schedule; result: T }>): Promise<T> {
  await acquireLock()
  try {
    const schedule = await readSchedule()
    const { schedule: newSchedule, result } = await fn(schedule)
    await writeSchedule(newSchedule)
    return result
  } finally {
    await releaseLock()
  }
}

export async function addTask(task: Omit<ScheduledTask, "id" | "createdAt" | "status">): Promise<ScheduledTask> {
  return withScheduleLock(async (schedule) => {
    // Initialize blockedSessions if missing
    if (!schedule.blockedSessions) schedule.blockedSessions = []

    // CRITICAL: Block tasks from known fork sessions (prevents infinite loop)
    // Check both blockedSessions list AND current forkSessionIds
    const isBlockedSession = schedule.blockedSessions.includes(task.sessionId)
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
    return { schedule, result: newTask }
  })
}

export async function updateTask(id: string, updates: Partial<ScheduledTask>): Promise<void> {
  await withScheduleLock(async (schedule) => {
    const idx = schedule.tasks.findIndex((t) => t.id === id)
    if (idx !== -1) {
      schedule.tasks[idx] = { ...schedule.tasks[idx], ...updates }
    }
    return { schedule, result: undefined }
  })
}

export async function removeTask(id: string): Promise<void> {
  await withScheduleLock(async (schedule) => {
    schedule.tasks = schedule.tasks.filter((t) => t.id !== id)
    return { schedule, result: undefined }
  })
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const schedule = await readSchedule()
  const now = Date.now()
  return schedule.tasks.filter((t) => t.status === "pending" && t.triggerAt <= now)
}

export async function getRunningTasks(): Promise<ScheduledTask[]> {
  const schedule = await readSchedule()
  return schedule.tasks.filter((t) => t.status === "running")
}

export async function getTask(id: string): Promise<ScheduledTask | null> {
  const schedule = await readSchedule()
  return schedule.tasks.find((t) => t.id === id) ?? null
}

// Permanently block a session from creating reminders (used for fork sessions)
export async function blockSession(sessionId: string): Promise<void> {
  await withScheduleLock(async (schedule) => {
    if (!schedule.blockedSessions) schedule.blockedSessions = []
    if (!schedule.blockedSessions.includes(sessionId)) {
      schedule.blockedSessions.push(sessionId)
    }
    return { schedule, result: undefined }
  })
}

// Parse delay strings like "2m", "1h30m", "24h", "1d"
export function parseDelay(delay: string): number {
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

// Parse recurrence like "daily 21:30" or "every 24h"
export function getNextTriggerTime(recurrence: string): number {
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
