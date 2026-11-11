/**
 * Put the graft CLI on the machine, and say what is still left to do.
 *
 * WHY A POSTINSTALL AT ALL
 *
 * This plugin is a front end. Every tool it registers shells out to `graft`,
 * and the chip reads an index `graft build` writes — so a correct install of
 * the plugin with no `graft` on PATH is a plugin that can do nothing, and says
 * so only at the first tool call. Installing it here turns that into one
 * install step instead of two, for the package managers that run this file.
 *
 * WHY IT IS NOT THE ONLY INSTALL PATH
 *
 * pnpm — which is what dsh profiles and the marketplace use — refuses
 * lifecycle scripts of dependencies unless the profile approves them, and
 * ignores them for `file:` tarball deps even WITH the approval. Measured on
 * pnpm 11.28.5: ERR_PNPM_IGNORED_BUILDS, plugin installed, graft absent. So the
 * host half runs the same ensureGraft() on first need; this file is the
 * install-time convenience for plain npm, not the guarantee.
 *
 * WHY IT NEVER FAILS THE INSTALL
 *
 * A global npm install is exactly the kind of thing that is refused: no write
 * permission on the prefix, an offline machine, a locked-down CI image, or
 * `--ignore-scripts` (which skips this file entirely and is a perfectly
 * reasonable thing for a careful user to do). None of those mean the PLUGIN
 * failed to install, so none of them exit non-zero. ensureGraft already falls
 * back to a user-writable prefix; whatever is left prints the one command to
 * run by hand and gets out of the way.
 *
 * Set DSH_GRAFT_SKIP_POSTINSTALL=1 to skip it outright.
 */

import { ensureGraft, GRAFT_PACKAGE } from '../src/ensure-graft.js'

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

const say = (line = '') => process.stdout.write(`${line}\n`)

async function main() {
  if (process.env.DSH_GRAFT_SKIP_POSTINSTALL === '1') return

  say()
  say(`${BOLD}dsh-graft-plugin${OFF}`)

  const result = await ensureGraft({
    spec: process.env.DSH_GRAFT_VERSION || undefined,
    log: (message) => say(`  ${message}`),
  })

  if (result.ok && result.already) {
    say(`  ${DIM}graft is already installed - nothing to do.${OFF}`)
  } else if (result.ok) {
    say(`  ${BOLD}done.${OFF} graft is installed (${result.installed}).`)
  } else {
    say()
    say(`  ${BOLD}graft was not installed.${OFF} This plugin needs it.`)
    for (const line of String(result.reason ?? '').split('\n')) say(`  ${line}`)
    say()
    say('  On a machine where the global prefix needs elevation, run that in an')
    say('  administrator shell, or point npm at a writable prefix first.')
    say(`  (dsh itself will retry automatically on first use: ${GRAFT_PACKAGE}.)`)
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
