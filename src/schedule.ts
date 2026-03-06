import { type Schedule, type ScheduledTask, SCHEDULE_PATH } from "./types"

const DEFAULT_SCHEDULE: Schedule = { tasks: [], version: 1 }

export async function readSchedule(): Promise<Schedule> {
  try {
    const file = Bun.file(SCHEDULE_PATH)
    if (!(await file.exists())) return DEFAULT_SCHEDULE
    return await file.json()
  } catch {
    return DEFAULT_SCHEDULE
  }
}

export async function writeSchedule(schedule: Schedule): Promise<void> {
  await Bun.write(SCHEDULE_PATH, JSON.stringify(schedule, null, 2))
}

export async function addTask(task: Omit<ScheduledTask, "id" | "createdAt" | "status">): Promise<ScheduledTask> {
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

export async function updateTask(id: string, updates: Partial<ScheduledTask>): Promise<void> {
  const schedule = await readSchedule()
  const idx = schedule.tasks.findIndex((t) => t.id === id)
  if (idx !== -1) {
    schedule.tasks[idx] = { ...schedule.tasks[idx], ...updates }
    await writeSchedule(schedule)
  }
}

export async function removeTask(id: string): Promise<void> {
  const schedule = await readSchedule()
  schedule.tasks = schedule.tasks.filter((t) => t.id !== id)
  await writeSchedule(schedule)
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
