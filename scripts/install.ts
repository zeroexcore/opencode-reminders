#!/usr/bin/env bun
/**
 * Install script for OpenCode Reminders
 * 
 * Copies plugin to ~/.config/opencode/plugins/
 * Installs LaunchAgent for background daemon (generates plist from template)
 */
import { $ } from "bun"
import { dirname, resolve } from "path"

const HOME = process.env.HOME!
const SCRIPT_DIR = dirname(Bun.main)
const PROJECT_DIR = resolve(SCRIPT_DIR, "..")
const OPENCODE_CONFIG = `${HOME}/.config/opencode`
const LAUNCH_AGENTS = `${HOME}/Library/LaunchAgents`

// Find bun binary
async function findBun(): Promise<string> {
  // Check common locations
  const candidates = [
    `${HOME}/.bun/bin/bun`,
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ]
  
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path
  }
  
  // Try which
  try {
    const result = await $`which bun`.text()
    return result.trim()
  } catch {}
  
  throw new Error("Could not find bun binary")
}

async function main() {
  console.log("Installing OpenCode Reminders...\n")
  console.log(`Project dir: ${PROJECT_DIR}`)
  console.log(`Config dir: ${OPENCODE_CONFIG}\n`)

  // Find bun path
  const bunPath = await findBun()
  const bunBin = dirname(bunPath)
  console.log(`Found bun: ${bunPath}\n`)

  // 1. Create directories
  console.log("1. Creating directories...")
  await $`mkdir -p ${OPENCODE_CONFIG}/plugins`
  await $`mkdir -p ${LAUNCH_AGENTS}`

  // 2. Copy plugin (standalone version - all-in-one file)
  console.log("2. Installing plugin...")
  await $`cp ${PROJECT_DIR}/src/plugin-standalone.ts ${OPENCODE_CONFIG}/plugins/reminders.ts`
  
  // 3. Create package.json in opencode config for dependencies
  console.log("3. Setting up dependencies...")
  const pkgPath = `${OPENCODE_CONFIG}/package.json`
  let pkg: any = { dependencies: {} }
  try {
    const existing = await Bun.file(pkgPath).json()
    pkg = existing
  } catch {}
  pkg.dependencies = {
    ...pkg.dependencies,
    "@opencode-ai/sdk": "latest",
    "@opencode-ai/plugin": "latest",
  }
  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))

  // 4. Install dependencies
  console.log("4. Installing npm dependencies...")
  await $`cd ${OPENCODE_CONFIG} && bun install`

  // 5. Unload old LaunchAgent if exists
  console.log("5. Cleaning up old LaunchAgent...")
  try {
    await $`launchctl unload ${LAUNCH_AGENTS}/com.rusintez.opencode-reminders.plist 2>/dev/null`.quiet()
    await $`rm -f ${LAUNCH_AGENTS}/com.rusintez.opencode-reminders.plist`.quiet()
  } catch {}

  // 6. Generate plist from template
  console.log("6. Generating LaunchAgent plist...")
  const templatePath = `${PROJECT_DIR}/com.oxc.opencode-reminders.plist.template`
  const daemonPath = `${OPENCODE_CONFIG}/plugins/daemon.ts`
  
  // Copy daemon and its dependencies to plugins dir
  await $`cp ${PROJECT_DIR}/src/daemon.ts ${daemonPath}`
  await $`cp ${PROJECT_DIR}/src/types.ts ${OPENCODE_CONFIG}/plugins/types.ts`
  await $`cp ${PROJECT_DIR}/src/schedule.ts ${OPENCODE_CONFIG}/plugins/schedule.ts`
  
  let plistContent = await Bun.file(templatePath).text()
  plistContent = plistContent
    .replace(/\{\{BUN_PATH\}\}/g, bunPath)
    .replace(/\{\{BUN_BIN\}\}/g, bunBin)
    .replace(/\{\{DAEMON_PATH\}\}/g, daemonPath)
    .replace(/\{\{HOME\}\}/g, HOME)
  
  const plistDst = `${LAUNCH_AGENTS}/com.oxc.opencode-reminders.plist`
  await Bun.write(plistDst, plistContent)

  // 7. Unload if already loaded, then load
  console.log("7. Loading LaunchAgent...")
  try {
    await $`launchctl unload ${plistDst} 2>/dev/null`.quiet()
  } catch {}
  await $`launchctl load ${plistDst}`

  console.log("\n✅ Installation complete!\n")
  console.log("The daemon is now running in the background.")
  console.log("Logs: /tmp/opencode-reminders.log")
  console.log("Errors: /tmp/opencode-reminders.err")
  console.log("\nTo test, restart OpenCode and try:")
  console.log('  remind({ delay: "1m", prompt: "Test!", priority: "normal" })')
  console.log("\nTo check daemon status:")
  console.log("  launchctl list | grep opencode-reminders")
  console.log("\nTo stop the daemon:")
  console.log("  launchctl unload ~/Library/LaunchAgents/com.oxc.opencode-reminders.plist")
}

main().catch(console.error)
