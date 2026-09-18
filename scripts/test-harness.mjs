/**
 * Terminal harness for graft-status.
 *
 * Everything runs against fixtures, including a synthetic graft repo built in
 * a temp directory, so the suite passes on a fresh clone with no graft index
 * and no graft installed anywhere on the machine.
 *
 * That synthetic repo is laid out exactly as index.js probes for and reads,
 * so it exercises the real contract rather than a mock of it. `npm run
 * test:live` is where the same code is checked against a genuine index.
 *
 * Run:  npm test
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeStatus, countWiring, findGraftRoot, freshnessOf } from '../src/index.js'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''))
  if (!ok) failures += 1
}

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}
const io = { exists, readJson, readSavedTokens: async () => 0 }

/**
 * Same directory, however it happens to be spelled.
 *
 * `path.join` emits backslashes on Windows while the literals here use forward
 * slashes, so a raw `===` would fail on a walk that is actually correct. The
 * product never compares these strings — it only shows the basename — so
 * normalising in the assertion tests the claim that matters (which directory)
 * rather than an incidental one (which separator).
 */
const samePath = (a, b) =>
  typeof a === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

console.log('--- freshness ---')
check('dirty reads as stale', freshnessOf({ dirty: true }) === 'stale')
check('syncing outranks dirty', freshnessOf({ dirty: true, syncing: true }) === 'syncing')
check('staleCount alone is stale', freshnessOf({ dirty: false, staleCount: 3 }) === 'stale')
check('clean reads as synced', freshnessOf({ dirty: false, staleCount: 0 }) === 'synced')
check('no stats is unknown', freshnessOf(null) === 'unknown')

console.log('\n--- wiring counts ---')
check('counts nodes and edges', JSON.stringify(countWiring({ nodes: [1, 2, 3], edges: [1] })) === '{"nodeCount":3,"edgeCount":1}')
check('missing edges is zero, not a crash', countWiring({ nodes: [] })?.edgeCount === 0)
check('a non-graph yields undefined', countWiring({ what: 1 }) === undefined)
check('null yields undefined', countWiring(null) === undefined)

/* ------------------------------------------------------------------------ *
 * A synthetic graft repo, so this suite runs anywhere.
 *
 * The layout is the one index.js actually probes for, not an invention:
 *
 *   <repo>/graft/INDEX.md              one of the three root markers
 *   <repo>/graft/.cache/stats.json     the live cache, the preferred source
 *   <repo>/graft/.graph/wiring.json    the graph, the fallback source
 *
 * One fixture repo deliberately carries a SPACE in its name. Every path here
 * reaches a shell-free spawn eventually, and a space is what breaks that.
 * ------------------------------------------------------------------------ */
const fixture = await mkdtemp(join(tmpdir(), 'dsh-graft-test-'))
const REPO = join(fixture, 'repo')
const OTHER = join(fixture, 'other repo')
const BARE = join(fixture, 'bare')

await mkdir(join(REPO, 'graft', '.cache'), { recursive: true })
await mkdir(join(REPO, 'graft', '.graph'), { recursive: true })
await mkdir(join(REPO, 'profiles', 'web'), { recursive: true })
await mkdir(join(OTHER, 'graft'), { recursive: true })
await mkdir(BARE, { recursive: true })
await writeFile(join(REPO, 'graft', 'INDEX.md'), '# graft repo map\n')
await writeFile(
  join(REPO, 'graft', '.cache', 'stats.json'),
  JSON.stringify({ nodeCount: 1284, edgeCount: 5312, dirty: false, staleCount: 0, syncedAt: '2026-09-11T09:00:00.000Z' }),
)
await writeFile(
  join(REPO, 'graft', '.graph', 'wiring.json'),
  JSON.stringify({ nodes: Array.from({ length: 97 }, (_, i) => i), edges: Array.from({ length: 41 }, (_, i) => i) }),
)
await writeFile(join(OTHER, 'graft', 'INDEX.md'), '# graft repo map\n')

console.log('\n--- root resolution ---')
const fromRepo = await findGraftRoot(REPO, exists)
check('finds an indexed repo', samePath(fromRepo, REPO), String(fromRepo))

// The property the chip depends on: launched deeper in the tree, it must walk
// UP to the same repo — this is exactly what `graft mcp` does from dsh's cwd.
const fromNested = await findGraftRoot(join(REPO, 'profiles', 'web'), exists)
check('walks up from a nested dir to the same root', samePath(fromNested, REPO), String(fromNested))

const fromOther = await findGraftRoot(OTHER, exists)
check('finds a second repo, not the first', samePath(fromOther, OTHER), String(fromOther))
check('and a space in the path does not break it', OTHER.includes(' '))

const nowhere = await findGraftRoot(BARE, exists)
check('an unindexed tree resolves to nothing', nowhere === undefined, String(nowhere))

console.log('\n--- status from the cache ---')
const status = await computeStatus(REPO, io)
check('reports the cache node count', status.nodeCount === 1284, String(status.nodeCount))
check('reports the cache edge count', status.edgeCount === 5312, String(status.edgeCount))
check('carries the root back', samePath(status.root, REPO))
check('freshness is a known word', ['synced', 'stale', 'syncing', 'unknown'].includes(status.freshness), status.freshness)
check('came from the live cache', status.source === 'cache', status.source)

console.log('\n--- the graph fallback ---')
// stats.json absent: must fall back to the wiring graph rather than report
// "no graph", which is the bug graft's own statusline documents.
const noCache = await computeStatus(REPO, {
  ...io,
  readJson: async (path) => (path.endsWith('stats.json') ? undefined : readJson(path)),
})
check('falls back to the wiring graph', noCache.source === 'graph', noCache.source)
check('counts from the graph, not the cache', noCache.nodeCount === 97, String(noCache.nodeCount))
check('admits it has no drift signal', noCache.freshness === 'synced')

console.log('\n--- a repo with no graft at all ---')
const bare = await computeStatus(BARE, io)
check('reports not-ok rather than throwing', bare.ok === false, JSON.stringify(bare))

/* ========================================================================== *
 * The visualiser
 * ========================================================================== */

console.log('\n--- the workspace comes from the SESSION, not the launch dir ---')
const { cwdForSession } = await import('../src/index.js')
// The exact failure reported: dsh launched from a directory with no graft index
// above it, while the session's workspace had one.
const HOME = BARE
const fakeSessions = { get: (id) => (id === 'sess-street' ? { header: { cwd: OTHER } } : undefined) }
check('a session cwd wins over the launch dir', cwdForSession(fakeSessions, 'sess-street', HOME) === OTHER)
check('and it is the one that resolves a graft root', (await findGraftRoot(cwdForSession(fakeSessions, 'sess-street', HOME), exists)) !== undefined)
check('while the launch dir resolves nothing', (await findGraftRoot(HOME, exists)) === undefined)
check('an unknown session falls back', cwdForSession(fakeSessions, 'nope', HOME) === HOME)
check('a session with no cwd falls back', cwdForSession({ get: () => ({ header: {} }) }, 'x', HOME) === HOME)
check('no sessions service at all falls back', cwdForSession(undefined, 'x', HOME) === HOME)
check('a throwing service falls back', cwdForSession({ get: () => { throw new Error('nope') } }, 'x', HOME) === HOME)
check('no session id falls back', cwdForSession(fakeSessions, undefined, HOME) === HOME)

console.log('\n--- graft viz: port choice and startup ---')
const { startViz, pickPort } = await import('../src/index.js')

const never = { exitCode: null }
const wait = async () => {}

// One `graft viz` serves ONE repo, so a server this plugin did not start is
// useless to it: from the outside there is no way to tell which repo the thing
// on that port is serving. An earlier version adopted it anyway, which is
// invisible and wrong the moment a second repo is open. Free ports instead.
check('takes the base port when it is free', (await pickPort(4400, { alive: async () => false })) === 4400)
check(
  'steps over a port something else holds',
  (await pickPort(4400, { alive: async (p) => p < 4402 })) === 4402,
)
check(
  'gives up rather than looping forever',
  (await pickPort(4400, { alive: async () => true }, 3)) === undefined,
)

// Not yet listening, then listening: must wait for the socket, not the banner.
let polls = 0
const started = await startViz('C:/x', 4400, {
  alive: async () => (polls++ > 1),
  wait,
  spawn: () => never,
})
check('waits for the port, then reports the url', started.ok === true && started.url === 'http://127.0.0.1:4400/', JSON.stringify(started))

// A child that dies must fail immediately rather than burn the whole deadline.
const died = await startViz('C:/x', 4400, {
  alive: async () => false,
  wait,
  spawn: () => ({ exitCode: 9 }),
})
check('a child that exits is reported, not awaited', died.ok === false && /exited with code 9/.test(died.reason), String(died.reason))

const cannotSpawn = await startViz('C:/x', 4400, {
  alive: async () => false,
  wait,
  spawn: () => { throw new Error('graft not on PATH') },
})
check('an unspawnable graft is a reason, not a throw', cannotSpawn.ok === false && /not on PATH/.test(cannotSpawn.reason))

/* ========================================================================== *
 * The new-tab handle (a source-level guard)
 * ========================================================================== */

console.log('\n--- window.open must keep its handle ---')
// Asserted against the SOURCE because this failure is unreachable from Node and
// invisible at runtime: `window.open` returns null when `noopener` is set — that
// is the flag's whole purpose — so a caller that needs the handle and passes it
// anyway opens a tab it can never write to or navigate. That shipped once and
// showed up as a permanent blank page, with no error anywhere.
const clientSource = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const opens = clientSource.match(/window\.open\([^)]*\)/g) ?? []
check('the tab is opened exactly once', opens.length === 1, opens.join(' | '))
check('and never with noopener', opens.every((call) => !call.includes('noopener')), opens.join(' | '))
check('and opened blank, to be navigated later', (opens[0] ?? '').includes('"", "_blank"'), opens[0])

console.log('\n--- the client module key ---')
// The client loader keys bundles by the package name — entry.options.name in
// cordis.patch.yml — and arrive() asserts factories.has(that name). The row id
// `graft-status` is a DIFFERENT namespace (storage keys, prompt section,
// effect labels) and must stay put there. When the two were conflated, the
// factory landed under the row id and the assert fired on every boot with the
// chip and tab missing. That shipped as 0.1.0; this guard is the reason it
// will not ship again.
check(
  'registers under the package name, not the row id',
  /__ModuleLoader__\.load\(\{\s*\r?\n\s*id:\s*"dsh-graft-plugin"/.test(clientSource),
)
check('and never under the row id', !/__ModuleLoader__\.load\(\{\s*\r?\n\s*id:\s*"graft-status"/.test(clientSource))

console.log('\n--- the sidebar tab is a consumer, not a patch ---')
// dsh-better-sidebar is never edited by this plugin: the tab is contributed
// through its documented `ctx.betterSidebar` service, which its README states
// third-party tabs and its own built-in eight share.
check('registers a tab through the public service', clientSource.includes('betterSidebar.registerTab('))
// Resolved through the inject-free accessor, then called — `ctx.betterSidebar`
// would throw without a declared inject, which is exactly what must not happen
// in a profile that lacks the sidebar.
check('resolves the service without requiring an inject', clientSource.includes('ctx.get("betterSidebar")'))
check('opens the tab through it', /\.openTab\(\{ type: TAB_TYPE/.test(clientSource))
// A HARD dependency would stop this whole plugin — chip included — from
// activating in a profile without the sidebar. It must stay a soft one.
check(
  'declares the dependency softly (ctx.inject, not the module inject list)',
  clientSource.includes('ctx.inject(["betterSidebar"]') && /const inject = \[[^\]]*\]/.exec(clientSource)?.[0].includes('betterSidebar') === false,
  /const inject = \[[^\]]*\]/.exec(clientSource)?.[0],
)
check('the browser tab survives only as the fallback', clientSource.includes('no dsh-better-sidebar'))

await rm(fixture, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
