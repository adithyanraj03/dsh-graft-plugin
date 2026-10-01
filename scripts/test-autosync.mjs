import { join } from 'node:path'
import { resolveGraftCommand, savedTokensIn } from '../src/graft-tools.js'
import { createAutoSync } from '../src/auto-sync.js'
import { totalSaved } from '../src/index.js'

let failures = 0
const check = (l, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l + (extra ? '  -> ' + extra : '')); if (!ok) failures += 1 }

console.log('--- reading graft\'s own savings line ---')
check('plain grouping', savedTokensIn('[graft] tokens saved ≈ 26,730 (99%) — this output ≈ 308 tok') === 26730)
// This machine renders lakh grouping; a locale-naive parse would read 150.
check('Indian grouping (as this host prints it)', savedTokensIn('[graft] tokens saved ≈ 1,50,427 (100%) — x') === 150427)
check('no separators', savedTokensIn('tokens saved ≈ 42 (10%) — x') === 42)
check('absent line is zero, not NaN', savedTokensIn('no such line here') === 0)
check('undefined is zero', savedTokensIn(undefined) === 0)

console.log('\n--- the two tallies are summed, not merged ---')
check('graft + ours', totalSaved(663783, 26730) === 690513)
check('missing ours', totalSaved(663783, undefined) === 663783)
check('neither', totalSaved(undefined, undefined) === 0)

console.log('\n--- auto-rebuild gating ---')
let now = 1_000_000
let spawned = []
const state = {
  stats: { dirty: false },
  readStats: () => state.stats,
  patchStats: (_d, patch) => Object.assign(state.stats, patch),
  acquireLock: () => state.lock !== false,
}
const make = (over = {}) => createAutoSync({
  graft: { state, syncRun: 'C:/fake/sync-run.js' },
  now: () => now,
  spawn: (...a) => { spawned.push(a); return { on() {}, unref() {} } },
  ...over,
})

let sync = make()
// dsh's REAL wire names, from the packages that register them: dsh-tool-fs
// (write, edit), dsh-tool-str-replace-editor, dsh-tool-bash, dsh-tool-pwsh.
// This check previously asserted `write_file`, which dsh does not register — so
// it passed while the most common write path in a new repo triggered nothing.
check('write is watched', sync.touches('write'))
check('edit is watched', sync.touches('edit'))
check('so is the editor tool', sync.touches('str_replace_editor'))
check('shells too (scripts write files here)', sync.touches('pwsh') && sync.touches('bash'))
check('reads are not', sync.touches('read') === false)
// The regression, named so it cannot come back quietly.
check('the name dsh does NOT register is not relied on', sync.touches('write_file') === false)
check('a custom list replaces the defaults', make({ writeTools: ['only_this'] }).touches('only_this') && make({ writeTools: ['only_this'] }).touches('write') === false)

check('a clean repo is not rebuilt', (await sync.syncIfDirty('C:/x')) === 'clean')
await sync.markDirty('C:/x')
check('marking dirty writes graft\'s own flag', state.stats.dirty === true)
check('a dirty repo rebuilds', (await sync.syncIfDirty('C:/x')) === 'started')
check('and it spawned graft\'s sync-run', spawned.length === 1 && spawned[0][1][0] === 'C:/fake/sync-run.js')
// Windows: sync-run's own execFileSync passes no windowsHide, so it inherits
// whatever console this child has. `detached` would leave it with NONE, and the
// grandchild would then be given a new VISIBLE console — a terminal that
// flashes on every rebuild and takes foreground off a fullscreen game.
check('hidden, so the rebuild cannot flash a console', spawned[0][2].windowsHide === true)
check('and NOT detached, or the grandchild gets a visible one', spawned[0][2].detached !== true)
check('it set syncing so the chip can show it', state.stats.syncing === true)

check('a second rebuild inside the interval is refused', (await sync.syncIfDirty('C:/x')) === 'too-soon')
now += 6_000
state.stats.dirty = true
check('and allowed once the interval passes', (await sync.syncIfDirty('C:/x')) === 'started')

console.log('\n--- it never races another rebuild ---')
state.lock = false
state.stats.dirty = true
now += 6_000
check('a held lock defers instead of racing', (await sync.syncIfDirty('C:/x')) === 'locked')

console.log('\n--- graft missing is not an error ---')
const none = createAutoSync({ graft: null, now: () => now, spawn: () => { throw new Error('should not spawn') } })
check('no graft, no rebuild, no throw', (await none.syncIfDirty('C:/x')) === 'graft-unavailable')

console.log('\n--- a manual Build forces a rebuild, like the popup button ---')
// The popup's Build must not go through syncIfDirty's gates: a repo whose
// stats already read clean (plain `graft build` never patches stats.json, so
// `dirty` is whatever the last sync-run left) would answer 'clean' and spawn
// nothing — the exact "button press changes nothing" shipped once.
state.lock = true
now += 60_000
check('a forced rebuild skips the clean gate', (await sync.rebuild('C:/y')) === 'started')
check('and it spawned graft\'s sync-run for that root', spawned.some((a) => a[1][1] === 'C:/y'), JSON.stringify(spawned.at(-1)))
check('it set syncing so the chip can show it', state.stats.syncing === true)

console.log('\n--- mid-turn rebuild: a long turn must not sit on a stale graph ---')
// The turn boundary alone left a graph dirty for 36 minutes of one agentic
// turn while the model kept querying it. A write now also arms a debounce.
let fired = []
let timerId = 0
const pendingTimers = new Map()
const debounced = createAutoSync({
  graft: { state, syncRun: 'C:/fake/sync-run.js' },
  now: () => now,
  spawn: (...a) => { fired.push(a); return { on() {}, unref() {} } },
  debounceMs: 20000,
  setTimeout: (fn) => { const id = ++timerId; pendingTimers.set(id, fn); return id },
  clearTimeout: (id) => { pendingTimers.delete(id) },
})
state.stats = { dirty: false }
state.lock = true
now += 60_000

await debounced.markDirty('C:/x')
check('a write arms a timer', pendingTimers.size === 1, String(pendingTimers.size))
check('and does not rebuild immediately', fired.length === 0)

// A second write inside the window replaces the first timer, so a burst of
// edits collapses into ONE rebuild rather than one per file.
await debounced.markDirty('C:/x')
check('a second write replaces the timer, not adds one', pendingTimers.size === 1, String(pendingTimers.size))

const fire = [...pendingTimers.values()][0]
pendingTimers.clear()
await fire()
// The timer callback fires syncIfDirty without awaiting it (fire-and-forget
// by design — a throw inside a timer must never surface), so flush before
// asserting the spawn landed. This needed one more hop once syncIfDirty
// started delegating to rebuild().
await new Promise((resolve) => setTimeout(resolve, 0))
check('the quiet period rebuilds without waiting for the turn', fired.length === 1, String(fired.length))

const off = createAutoSync({ graft: { state, syncRun: 'x' }, now: () => now, spawn: () => ({ on() {}, unref() {} }), debounceMs: 0, setTimeout: () => { throw new Error('should not arm') } })
let armed = true
try { await off.markDirty('C:/y') } catch { armed = false }
check('debounceMs 0 restores turn-end-only', armed === true)

console.log('\n--- a graft cli we cannot locate must never crash dsh ---')
// THE ORIGINAL FATALITY: graft installed as a bare shim (bun global) left
// `cliPath` undefined, `dirname(undefined)` in loadGraftState escaped the
// `void`-ed markDirty as an unhandled rejection, and dsh died on the FIRST
// successful edit in an indexed repo. These checks pin the guarantee: no
// input, no throw, no rejection, no spawn.
const noCli = createAutoSync({ now: () => now, spawn: (...a) => { spawned.push(a); return { on() {}, unref() {} } }, debounceMs: 0 })
let crashed = false
const spawnedBefore = spawned.length
try { await noCli.markDirty('C:/no-cli') } catch { crashed = true }
check('markDirty resolves without a cli', crashed === false)
check('and never spawns a rebuild', spawned.length === spawnedBefore, String(spawned.length - spawnedBefore))
check('syncIfDirty reports graft unavailable', (await noCli.syncIfDirty('C:/no-cli')) === 'graft-unavailable')

// Even a loader that REJECTS is swallowed — graft() awaits the injected stub
// inside its own try, so no input shape can turn into an unhandled rejection.
const throwing = createAutoSync({ graft: Promise.reject(new Error('boom')), now: () => now, spawn: () => ({ on() {}, unref() {} }), debounceMs: 0 })
crashed = false
try { await throwing.markDirty('C:/throwing') } catch { crashed = true }
check('a rejecting graft loader is swallowed', crashed === false)
check('and sync stays unavailable, not fatal', (await throwing.syncIfDirty('C:/throwing')) === 'graft-unavailable')

console.log('\n--- resolveGraftCommand finds graft however it was installed ---')
const fakeExists = (set) => (p) => set.has(p)
const bunCli = '/home/x/.bun/install/global/node_modules/@nanonets/graft/dist/cli.js'
// A bun global install: only the shim is on PATH, the package lives under
// $BUN_INSTALL/install/global. The PATH-only scan returned prefix: [] here,
// which is what fed undefined into loadGraftState above.
const viaBunInstall = resolveGraftCommand(
  { PATH: '/home/x/.bun/bin', BUN_INSTALL: '/home/x/.bun', HOME: '/home/x' },
  fakeExists(new Set([bunCli])),
)
check('a bun global install resolves to its dist cli', viaBunInstall.prefix[0] === bunCli && viaBunInstall.shell === false, viaBunInstall.prefix[0])
const viaHome = resolveGraftCommand(
  { PATH: '', HOME: '/home/x' },
  fakeExists(new Set([bunCli])),
)
check('or via HOME/.bun when BUN_INSTALL is unset', viaHome.prefix[0] === bunCli, viaHome.prefix[0])
const viaUserprofile = resolveGraftCommand(
  { PATH: '', USERPROFILE: 'C:\\Users\\x' },
  // The fixture path is built with the same join() the source uses, so this
  // checks WHERE the lookup happens, not how a host renders separators.
  fakeExists(new Set([join('C:\\Users\\x', '.bun', 'install', 'global', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')])),
)
check('or via USERPROFILE/.bun on Windows', viaUserprofile.prefix[0] === join('C:\\Users\\x', '.bun', 'install', 'global', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'), viaUserprofile.prefix[0])
const bare = resolveGraftCommand({ PATH: '', HOME: '/home/x' }, fakeExists(new Set()))
check('nothing installed falls back to the bare command', bare.command === 'graft' && bare.prefix.length === 0)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
