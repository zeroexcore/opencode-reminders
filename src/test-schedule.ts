#!/usr/bin/env bun
/**
 * Test script to manually add a schedule entry
 */
import { addTask, readSchedule, parseDelay } from "./schedule"

async function main() {
  const args = process.argv.slice(2)
  
  if (args[0] === "list") {
    const schedule = await readSchedule()
    console.log("Current schedule:")
    console.log(JSON.stringify(schedule, null, 2))
    return
  }

  if (args[0] === "add") {
    const delay = args[1] || "1m"
    const prompt = args[2] || "Test reminder - this is a test!"
    const priority = (args[3] as "normal" | "critical") || "normal"
    
    // We need a session ID - you'd get this from the actual session
    const sessionId = args[4] || "test-session-id"
    
    const task = await addTask({
      sessionId,
      triggerAt: Date.now() + parseDelay(delay),
      prompt,
      priority,
    })
    
    console.log("Added task:")
    console.log(JSON.stringify(task, null, 2))
    return
  }

  console.log(`Usage:
  bun run test:schedule list              - List all scheduled tasks
  bun run test:schedule add <delay> <prompt> [priority] [sessionId]
  
Examples:
  bun run test:schedule add 1m "Test reminder"
  bun run test:schedule add 30s "Urgent task" critical
`)
}

main().catch(console.error)
