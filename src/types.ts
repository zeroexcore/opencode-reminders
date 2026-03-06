export type Priority = "normal" | "critical"
export type TaskStatus = "pending" | "running" | "completed" | "failed"

export interface ScheduledTask {
  id: string
  sessionId: string
  createdAt: number
  triggerAt: number
  prompt: string
  priority: Priority
  recurrence?: string // cron-like: "daily 21:30" or interval: "every 24h"
  status: TaskStatus
  lastError?: string
  forkSessionId?: string // tracks the forked session while running
}

export interface Schedule {
  tasks: ScheduledTask[]
  version: number
}

export const SCHEDULE_PATH = `${process.env.HOME}/.config/opencode/reminders.json`
export const OPENCODE_PORT = 4096
export const OPENCODE_HOST = "http://127.0.0.1"
