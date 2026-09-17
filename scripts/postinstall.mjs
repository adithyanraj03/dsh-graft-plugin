/**
 * Put the graft CLI on the machine, and say what is still left to do.
 *
 * WHY A POSTINSTALL AT ALL
 *
 * This plugin is a front end. Every tool it registers shells out to `graft`,
 * and the chip reads an index `graft build` writes — so a correct install of
 * the plugin with no `graft` on PATH is a plugin that can do nothing, and says
 * so only at the first tool call. Installing it here turns that into one
 * install step instead of two.
 *
 * WHY IT NEVER FAILS THE INSTALL
 *
 * A global npm install is exactly the kind of thing that is refused: no write
 * permission on the prefix, an offline machine, a locked-down CI image, or
 * `--ignore-scripts` (which skips this file entirely and is a perfectly
 * reasonable thing for a careful user to do). None of those mean the PLUGIN
 * failed to install, so none of them exit non-zero. They print the one command
 * to run by hand and get out of the way.
 *
 * Set DSH_GRAFT_SKIP_POSTINSTALL=1 to skip it outright.
 */

import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'

/** The package behind the `graft` command. The GitHub home is trailhq/Graft. */
const PACKAGE = '@nanonets/graft'

const BOLD = '[1m'
const DIM = '[2m'
const OFF = '[0m'

const say = (line = '') => process.stdout.write(`${line}\n`)

/** Is `graft` already reachable? Checked before installing, so a re-install is a no-op. */
function graftOnPath(env = process.env, exists = existsSync) {
  const path = String(env.PATH ?? env.Path ?? '')
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    for (const name of ['graft.cmd', 'graft.exe', 'graft']) {
      if (exists(join(dir, name))) return true
    }
  }
  return false
}

/** Run a command to completion. Resolves with the exit code; never rejects. */
function run(command, args) {
  return new Promise((resolve) => {
    let child
    try {
      // `shell: true` on Windows, because npm is a `.cmd` shim that cannot be
      // exec'd directly. No argument here contains a space, so the unquoted
      // argv join that makes `shell: true` dangerous cannot bite.
      child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
    } catch {
      resolve(null)
      return
    }
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })
}

async function main() {
  if (process.env.DSH_GRAFT_SKIP_POSTINSTALL === '1') return

  say()
  say(`${BOLD}dsh-graft${OFF}`)

  if (graftOnPath()) {
    say(`  ${DIM}graft is already on PATH - nothing to install.${OFF}`)
  } else {
    say(`  installing the graft CLI (${PACKAGE}) globally...`)
    const code = await run('npm', ['install', '-g', PACKAGE])
    if (code === 0) {
      say(`  ${BOLD}done.${OFF} graft is on PATH.`)
    } else {
      say()
      say(`  ${BOLD}graft was not installed${OFF} (npm exited ${code === null ? 'without running' : code}).`)
      say('  This plugin needs it. Install it by hand:')
      say()
      say(`      npm install -g ${PACKAGE}`)
      say()
      say('  On a machine where the global prefix needs elevation, run that in an')
      say('  administrator shell, or point npm at a writable prefix first.')
    }
  }

  say()
  say(`  ${BOLD}Next:${OFF}`)
  say('    1. Index a repo:   cd <your repo> && graft build')
  say('    2. The sidebar tab for `graft viz` needs dsh-better-sidebar mounted.')
  say('       It ships as a dependency of this plugin, so it is already downloaded,')
  say('       but dsh only mounts what the profile lists:')
  say()
  say('           dsh plugin --profile web add dsh-better-sidebar')
  say()
  say('       Skip it if you do not want the tab - the chip, the tools, the')
  say('       /graft command and the auto-rebuild all work without it.')
  say()
}

main().catch(() => {
  // A postinstall that throws fails the install of a plugin that is, itself,
  // perfectly fine. Never do that.
})
