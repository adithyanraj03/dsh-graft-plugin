/**
 * ensure-graft: the install that postinstall cannot guarantee.
 *
 * Every case here runs against a fake filesystem and a fake spawn, so the
 * suite never touches the network or the machine's real npm prefix. The two
 * real-install smoke tests live outside the suite (they need a contained
 * npm_config_prefix) and are run by hand before a release.
 */

import { delimiter, join } from 'node:path'
import {
  GRAFT_PACKAGE,
  cachedGraftCommand,
  ensureGraft,
  managedPrefix,
  npmInvocation,
  resetEnsureGraftState,
  resetGraftCommandCache,
  resolveGraftCommand,
} from '../src/ensure-graft.js'
import { createAutoSync } from '../src/auto-sync.js'

let failures = 0
const check = (l, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l + (extra ? '  -> ' + extra : '')); if (!ok) failures += 1 }

const NODE_EXE = process.platform === 'win32' ? 'node.exe' : 'node'
const cliIn = (dir) => join(dir, 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')
const nodeIn = (dir) => join(dir, NODE_EXE)
const npmIn = (dir) => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const HOME = { DSH_HOME: join('C:', 'dsh-home') }

/** A fake machine: which files exist, and what each spawned npm run does. */
function world({ pathDirs = [], nodeDirs = [], managed = false, plan = () => ({ code: 0 }) } = {}) {
  const set = new Set()
  for (const d of pathDirs) set.add(cliIn(d))
  for (const d of nodeDirs) { set.add(nodeIn(d)); set.add(npmIn(d)) }
  if (managed) set.add(cliIn(managedPrefix(HOME)))
  const spawns = []
  const env = { ...HOME, PATH: pathDirs.join(delimiter) }
  const exists = (p) => set.has(p)
  const spawn = (command, args) => {
    const step = plan(command, args, spawns.length)
    spawns.push({ command, args })
    for (const p of step.add ?? []) set.add(p)
    return {
      stdout: { on() {} },
      stderr: { on() {} },
      kill() {},
      on(ev, cb) { if (ev === 'close') setImmediate(() => cb(step.code)) },
    }
  }
  return { env, exists, spawn, spawns, set }
}

const deps = (w, over = {}) => ({ env: w.env, exists: w.exists, spawn: w.spawn, execPath: join('C:', 'app', 'DeepSeek Harness.exe'), electron: true, ...over })

console.log('--- nothing to do when graft is already there ---')
resetEnsureGraftState()
let w = world({ pathDirs: [join('C:', 'npm')] })
let r = await ensureGraft(deps(w))
check('an existing install is reported, not reinstalled', r.ok === true && r.already === true && w.spawns.length === 0, JSON.stringify(r))

console.log('--- opt-outs keep the old report-the-command behaviour ---')
for (const over of [{ autoInstall: false }, {}]) {
  resetEnsureGraftState()
  w = world()
  if (over.autoInstall === undefined) w.env.DSH_GRAFT_NO_AUTOINSTALL = '1'
  r = await ensureGraft(deps(w, over))
  check('no install, and the manual command is in the reason', r.ok === false && w.spawns.length === 0 && r.reason.includes(`npm install -g ${GRAFT_PACKAGE}`), JSON.stringify(r).slice(0, 120))
}

console.log('--- global install, with a real node and npm-cli.js (no shell) ---')
resetEnsureGraftState()
const nodeDir = join('C:', 'node')
w = world({ nodeDirs: [nodeDir], plan: (cmd, args) => (args.includes('-g') ? { code: 0, add: [cliIn(nodeDir)] } : { code: 1 }) })
w.env.PATH = nodeDir
r = await ensureGraft(deps(w))
check('global success is reported as global', r.ok === true && r.installed === 'global', JSON.stringify(r))
check('spawned node + npm-cli.js, not the npm shim', w.spawns[0].command === nodeIn(nodeDir) && w.spawns[0].args[0] === npmIn(nodeDir), JSON.stringify(w.spawns[0]))
check('asked for the package at the default spec', w.spawns[0].args.includes('-g') && w.spawns[0].args.includes(`${GRAFT_PACKAGE}@latest`), JSON.stringify(w.spawns[0].args))
check('one npm run, no fallback needed', w.spawns.length === 1, String(w.spawns.length))

console.log('--- a refused global prefix falls back to the managed prefix ---')
resetEnsureGraftState()
w = world({ nodeDirs: [nodeDir], plan: (cmd, args) => (args.includes('-g') ? { code: 1 } : { code: 0, add: [cliIn(managedPrefix(HOME))] }) })
r = await ensureGraft(deps(w))
check('the fallback reports managed', r.ok === true && r.installed === 'managed', JSON.stringify(r))
check('and installed with --prefix under the dsh home', w.spawns[1].args.includes('--prefix') && w.spawns[1].args.includes(managedPrefix(HOME)), JSON.stringify(w.spawns[1].args))
check('the resolver now finds the managed cli', resolveGraftCommand(w.env, w.exists).prefix[0] === cliIn(managedPrefix(HOME)))

console.log('--- total failure: cooldown, then force ---')
resetEnsureGraftState()
w = world({ nodeDirs: [nodeDir], plan: () => ({ code: 1 }) })
r = await ensureGraft(deps(w))
check('failure carries npm output and the manual command', r.ok === false && r.reason.includes('by hand'), JSON.stringify(r).slice(0, 100))
const after = w.spawns.length
r = await ensureGraft(deps(w))
check('a second poll inside the cooldown does not hammer npm', r.ok === false && w.spawns.length === after, String(w.spawns.length))
r = await ensureGraft(deps(w, { force: true }))
check('a pressed Build (force) retries anyway', w.spawns.length > after, String(w.spawns.length))

console.log('--- one install at a time ---')
resetEnsureGraftState()
w = world({ nodeDirs: [nodeDir], plan: () => ({ code: 1 }) })
const p1 = ensureGraft(deps(w))
const p2 = ensureGraft(deps(w))
check('concurrent callers share one attempt', p1 === p2)
await p1
check('and npm ran once per target, not once per caller', w.spawns.length === 2, String(w.spawns.length))

console.log('--- resolution order and interpreter choice ---')
resetEnsureGraftState()
const own = join('C:', 'own')
w = world({ pathDirs: [own], nodeDirs: [nodeDir], managed: true })
check('the user\'s own PATH install wins over the managed one', resolveGraftCommand(w.env, w.exists).prefix[0] === cliIn(own))
w = world({ nodeDirs: [nodeDir], managed: true })
w.env.PATH = nodeDir
const managedHow = resolveGraftCommand(w.env, w.exists, join('C:', 'app', 'x.exe'), true)
check('a managed install on an Electron host runs with a real node', managedHow.command === nodeIn(nodeDir) && managedHow.shell === false, managedHow.command)
const npmHow = npmInvocation(w.env, w.exists, join('C:', 'app', 'x.exe'), true)
check('npm likewise avoids the Electron binary', npmHow.command === nodeIn(nodeDir) && npmHow.prefix[0] === npmIn(nodeDir), npmHow.command)
check('the command cache is droppable after an install', (resetGraftCommandCache(), typeof cachedGraftCommand === 'function'))

console.log('--- auto-sync picks up a graft installed mid-session ---')
let now = 1_000_000
let spawned = []
const state = { stats: { dirty: true }, readStats: () => state.stats, patchStats: (_d, p) => Object.assign(state.stats, p), acquireLock: () => true }
let available = null
const sync = createAutoSync({
  get graft() { return available },
  resolveCli: () => (available ? 'C:/late/cli.js' : undefined),
  resolveCommand: () => ({ command: 'C:/late/node.exe' }),
  now: () => now,
  spawn: (...a) => { spawned.push(a); return { on() {}, unref() {} } },
})
check('unavailable before the install', (await sync.syncIfDirty('C:/x')) === 'graft-unavailable')
available = { state, syncRun: 'C:/late/sync-run.js' }
now += 60_000
check('and rebuilds after it, without a restart', (await sync.syncIfDirty('C:/x')) === 'started')
check('with the live-resolved interpreter', spawned.at(-1)?.[0] === 'C:/late/node.exe', String(spawned.at(-1)?.[0]))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
