/**
 * Find graft, and install it when it is not there.
 *
 * WHY THIS IS NOT ONLY A POSTINSTALL
 *
 * scripts/postinstall.mjs has always run `npm install -g @nanonets/graft`, and
 * for a marketplace user it never runs at all. Measured with the pnpm dsh
 * ships (11.28.5), installing this plugin's tarball into a fresh profile:
 *
 *     [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: dsh-graft-plugin@file:…
 *
 * pnpm refuses lifecycle scripts of dependencies unless the profile approves
 * them, and even WITH the approval entry (`allowBuilds: dsh-graft-plugin: true`)
 * a `file:` tarball dependency — exactly how the marketplace installs — is
 * still ignored. So the plugin lands, graft does not, and the first Build says
 * "no graft". A global prefix that needs elevation is the second way the
 * postinstall loses, on machines where it does run.
 *
 * The one trigger that always runs is this plugin's own code inside the dsh
 * host. So the install lives here: on first need, once at a time, with a
 * user-writable fallback for the machines where `-g` is refused. postinstall
 * calls the same function, so npm users keep the install-time convenience and
 * gain the same fallback.
 *
 * NO dsh IMPORTS IN THIS FILE, DELIBERATELY
 *
 * postinstall runs under plain npm/pnpm node, where `@deepseek-ai/dsh-tools`
 * does not exist. Everything here is node builtins, so both callers can use it.
 *
 * @module graft-status/ensure-graft
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** The package behind the `graft` command. */
export const GRAFT_PACKAGE = '@nanonets/graft'

/** What a fresh install asks for. Overridable per profile (`graftVersion`). */
export const DEFAULT_SPEC = 'latest'

/** An install downloads and builds tree-sitter grammars; give it room. */
const INSTALL_TIMEOUT_MS = 240_000

/** After a failed attempt, do not hammer npm on every chip poll. */
const FAIL_COOLDOWN_MS = 60_000

/** Cap on npm output kept for the failure message. */
const MAX_LOG = 2_000

const NODE_EXE = process.platform === 'win32' ? 'node.exe' : 'node'

const noop = () => {}

/**
 * Where the fallback install lives: a prefix this plugin owns, under the dsh
 * home. Never needs elevation, survives plugin upgrades, and is one directory
 * to delete for a clean uninstall. A graft the user installed themselves always
 * wins over it — see the scan order in resolveGraftCommand.
 */
export function managedPrefix(env = process.env) {
  const home = env.DSH_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.dsh')
  return join(home, 'graft-cli')
}

/**
 * Which binary to run a graft/npm script with.
 *
 * The npm shim's own rule is the first choice — `%dp0%\node.exe`, the node that
 * was installed beside the shims — so this agrees with what typing `graft` in a
 * terminal would do. Only an Electron host needs the PATH search after it,
 * because `graft` and its node need not share a prefix. A Node host keeps using
 * its own execPath, unchanged.
 *
 * WHY NOT JUST process.execPath
 *
 * execPath is Node only when the host is Node. The dsh DESKTOP app is Electron
 * (`DeepSeek Harness.exe`) running with ELECTRON_RUN_AS_NODE=1, so execPath is
 * that app binary: the script still starts, and the breakage happens one layer
 * in, inside graft's own argument parsing. The child keeps
 * `process.versions.electron`, and commander 15 picks its `electron` argv
 * convention from exactly that (`if (process.versions?.electron) from =
 * 'electron'`). That branch then keys on `process.defaultApp`, which is
 * undefined when the JS arrived as a script path rather than an app directory,
 * and slices argv from 1 instead of 2 — so the cli.js path lands where the
 * subcommand should be:
 *
 *     error: unknown command '<...>\@nanonets\graft\dist\cli.js'
 *
 * which is what the Build button and all five query tools returned in the
 * desktop app before 0.3.4. A real node avoids the Electron binary altogether.
 */
function interpreterFor(installDir, dirs, exists, execPath, electron) {
  const beside = join(installDir, NODE_EXE)
  if (exists(beside)) return beside
  if (!electron) return execPath
  for (const dir of dirs) {
    const candidate = join(dir, NODE_EXE)
    if (exists(candidate)) return candidate
  }
  // Nothing better to hand: execPath at least runs the script, and graft's own
  // stderr says what happened — the same answer as before this existed.
  return execPath
}

const pathDirs = (env) => String(env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir !== '')

/**
 * How to invoke graft without a shell.
 *
 * `graft` on Windows is a `.cmd` shim, so a naive spawn cannot exec it and the
 * obvious fix — `shell: true` — is a trap: Node joins argv into one command
 * line WITHOUT quoting, so the first argument containing a space is silently
 * split. That broke every call at once, because both the queries
 * (`"punch animation"`) and the repo path (`B:\...\Street Yeet`) contain
 * spaces.
 *
 * The shim's own body is `node <dir>/node_modules/@nanonets/graft/dist/cli.js`,
 * so finding that file and running it with a real node needs no shell at all,
 * and argv is passed through exactly as written.
 *
 * Scan order: the user's own PATH install, then a bun global install (only the
 * shim is on PATH there), then this plugin's managed prefix. The bare-name
 * fallback keeps a differently-installed graft working; it is only reached
 * when no entry point can be found.
 */
export function resolveGraftCommand(
  env = process.env,
  exists = existsSync,
  execPath = process.execPath,
  electron = process.versions?.electron !== undefined,
) {
  const dirs = pathDirs(env)
  for (const dir of dirs) {
    const cli = join(dir, 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')
    if (exists(cli)) return { command: interpreterFor(dir, dirs, exists, execPath, electron), prefix: [cli], shell: false }
  }
  const bunRoot = env.BUN_INSTALL ?? join(env.HOME ?? env.USERPROFILE ?? '.', '.bun')
  if (typeof bunRoot === 'string' && bunRoot !== '') {
    const bunInstall = join(bunRoot, 'install', 'global')
    const bunCli = join(bunInstall, 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')
    if (exists(bunCli)) return { command: interpreterFor(bunInstall, dirs, exists, execPath, electron), prefix: [bunCli], shell: false }
  }
  const managed = managedPrefix(env)
  const managedCli = join(managed, 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')
  if (exists(managedCli)) return { command: interpreterFor(managed, dirs, exists, execPath, electron), prefix: [managedCli], shell: false }
  return { command: 'graft', prefix: [], shell: process.platform === 'win32' }
}

/**
 * The resolved command, cached for the process — and DROPPED after a successful
 * install, because the cache would otherwise keep answering "not installed"
 * for the rest of the session that installed it.
 */
let cachedCommand
export const cachedGraftCommand = () => (cachedCommand ??= resolveGraftCommand())
export const resetGraftCommandCache = () => { cachedCommand = undefined }

/**
 * How to invoke npm without a shell: the npm-cli.js beside the node we would
 * run graft with. Falls back to the `npm` shim (shell on Windows) when that
 * file is not there — a node from nvm or a standalone build still ships npm
 * next to itself in every layout we have seen.
 */
export function npmInvocation(env = process.env, exists = existsSync, execPath = process.execPath, electron = process.versions?.electron !== undefined) {
  const dirs = pathDirs(env)
  let node = execPath
  if (electron) {
    for (const dir of dirs) {
      const candidate = join(dir, NODE_EXE)
      if (exists(candidate)) { node = candidate; break }
    }
  }
  const npmCli = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(npmCli)) return { command: node, prefix: [npmCli], shell: false }
  return { command: 'npm', prefix: [], shell: process.platform === 'win32' }
}

/** Run to completion, capturing both streams. Never rejects; code null = never ran. */
function runCapture(how, args, deps) {
  const spawnFn = deps.spawn ?? spawn
  const timeoutMs = deps.timeoutMs ?? INSTALL_TIMEOUT_MS
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(how.command, [...how.prefix, ...args], {
        shell: how.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ code: null, text: '' })
      return
    }
    let out = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, text: out.length > MAX_LOG ? out.slice(-MAX_LOG) : out })
    }
    const timer = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    child.stdout?.on('data', (c) => { out += c.toString() })
    child.stderr?.on('data', (c) => { out += c.toString() })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

const manualHint = (spec) =>
  'graft is not installed, and automatic installation is turned off.\n' +
  `Install it once:  npm install -g ${GRAFT_PACKAGE}@${spec}\n` +
  'Then press Build again.'

/** Single-flight + cooldown state. Resettable so tests start clean. */
let inflight
let lastFailAt = -Infinity
let lastReason = ''
export function resetEnsureGraftState() {
  inflight = undefined
  lastFailAt = -Infinity
  lastReason = ''
}

/**
 * Make graft reachable, installing it if needed.
 *
 * Returns { ok, already? , installed?: 'global'|'managed', reason? }. Never
 * throws: every caller is a chip poll, a button or a fire-and-forget hook, and
 * a rejection in any of those is fatal to dsh rather than informative.
 *
 * @param deps.autoInstall - false (or DSH_GRAFT_NO_AUTOINSTALL=1) keeps the old
 *   behaviour: report the one command to run by hand.
 * @param deps.spec - version spec to install; defaults to DEFAULT_SPEC.
 * @param deps.force - skip the failure cooldown (the Build button).
 */
export function ensureGraft(deps = {}) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const execPath = deps.execPath ?? process.execPath
  const electron = deps.electron ?? process.versions?.electron !== undefined
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? noop
  const spec = typeof deps.spec === 'string' && deps.spec !== '' ? deps.spec : DEFAULT_SPEC
  const autoInstall = deps.autoInstall !== false && env.DSH_GRAFT_NO_AUTOINSTALL !== '1'

  if (resolveGraftCommand(env, exists, execPath, electron).prefix[0] !== undefined) {
    return Promise.resolve({ ok: true, already: true })
  }
  if (!autoInstall) return Promise.resolve({ ok: false, reason: manualHint(spec) })
  if (inflight !== undefined) return inflight
  if (!deps.force && now() - lastFailAt < FAIL_COOLDOWN_MS) {
    return Promise.resolve({ ok: false, reason: lastReason })
  }

  const attempt = (async () => {
    const npm = npmInvocation(env, exists, execPath, electron)
    const target = `${GRAFT_PACKAGE}@${spec}`
    log(`graft is not installed — installing ${target} globally…`)
    const global = await runCapture(npm, ['install', '-g', target], deps)
    if (global.code === 0 && resolveGraftCommand(env, exists, execPath, electron).prefix[0] !== undefined) {
      resetGraftCommandCache()
      log('graft installed globally.')
      return { ok: true, installed: 'global' }
    }
    // `-g` refused (elevation, read-only prefix) or landed off PATH. A prefix
    // under the dsh home needs neither, so the install still succeeds there.
    log(`global install did not land (npm exit ${global.code}) — using a user-writable prefix…`)
    const prefix = managedPrefix(env)
    try { mkdirSync(prefix, { recursive: true }) } catch { /* runCapture reports the real error */ }
    const local = await runCapture(npm, ['install', '--prefix', prefix, target], deps)
    if (local.code === 0 && resolveGraftCommand(env, exists, execPath, electron).prefix[0] !== undefined) {
      resetGraftCommandCache()
      log(`graft installed into ${prefix}.`)
      return { ok: true, installed: 'managed', root: prefix }
    }
    lastFailAt = now()
    lastReason =
      'graft could not be installed automatically.\n\n' +
      `${global.text}\n${local.text}\n\n`.trim() +
      `\n\nInstall it by hand:  npm install -g ${target}`
    return { ok: false, reason: lastReason }
  })()

  inflight = attempt.finally(() => { inflight = undefined })
  return inflight
}
