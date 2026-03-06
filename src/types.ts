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
  silent?: boolean // true = inject without response, false = let agent respond
  status: TaskStatus
  lastError?: string
  forkSessionId?: string // tracks the forked session while running
}

export interface Schedule {
  tasks: ScheduledTask[]
  version: number
}

export const SCHEDULE_PATH = `${process.env.HOME}/.config/opencode/reminders.json`
export const OPENCODE_HOST = "http://127.0.0.1"

// Port discovery - find which port opencode is listening on
export async function discoverOpencodePort(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["/usr/sbin/lsof", "-c", "opencode", "-i", "-sTCP:LISTEN", "-nP"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    
    // Parse: opencode 7365 user 23u IPv4 ... TCP 127.0.0.1:4096 (LISTEN)
    for (const line of output.split("\n")) {
      if (line.includes("opencode") && line.includes("LISTEN")) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/)
        if (match) return parseInt(match[1], 10)
      }
    }
  } catch {}
  return null
}
