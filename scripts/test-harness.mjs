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
import { computeStatus, countWiring, createToolPulse, findGraftRoot, freshnessOf } from '../src/index.js'
import { graftTools } from '../src/graft-tools.js'

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

console.log('\n--- git worktrees are their own graft root ---')
// A linked worktree's .git is a FILE pointing at its admin dir, whose
// commondir names the shared .git. The one that matters is NESTED inside the
// main checkout: without the boundary, resolution walked straight past it and
// the tools answered from the main checkout's graph — wrong paths for this
// branch's files.
await mkdir(join(REPO, '.git'), { recursive: true })
const wt = join(REPO, 'wt')
const gitDir = join(fixture, 'main.git', 'worktrees', 'wt')
await mkdir(join(wt, 'src'), { recursive: true })
await mkdir(gitDir, { recursive: true })
await writeFile(join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
await writeFile(join(gitDir, 'commondir'), '../..\n', 'utf8')

const fromWt = await findGraftRoot(join(wt, 'src'), exists)
check('a nested worktree never answers from the main graph above it', fromWt === undefined, String(fromWt))

const mainAgain = await findGraftRoot(REPO, exists)
check('the main checkout itself still resolves', samePath(mainAgain, REPO), String(mainAgain))

const mainStatus = await computeStatus(REPO, io)
check('a main checkout is not reported as a worktree', mainStatus.worktreeOf === undefined, String(mainStatus.worktreeOf))

// Once the worktree has its own index (graft seeds it from main on build),
// resolution stays inside the worktree and the status names its repo.
await mkdir(join(wt, 'graft', '.cache'), { recursive: true })
await writeFile(join(wt, 'graft', 'INDEX.md'), '# graft repo map\n')
await writeFile(
  join(wt, 'graft', '.cache', 'stats.json'),
  JSON.stringify({ nodeCount: 12, edgeCount: 7, dirty: false, staleCount: 0, syncedAt: '2026-09-11T09:00:00.000Z' }),
)
const wtIndexed = await findGraftRoot(join(wt, 'src'), exists)
check('a worktree with its own index resolves to itself', samePath(wtIndexed, wt), String(wtIndexed))

const wtStatus = await computeStatus(wt, io)
check('status names the main checkout the worktree belongs to', samePath(wtStatus.worktreeOf, fixture), String(wtStatus.worktreeOf))
check('and still serves the worktree graph', wtStatus.nodeCount === 12, String(wtStatus.nodeCount))

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
 * Tool-use pulses: any graft_* call must reach the chip's dot
 * ========================================================================== */

console.log('\n--- tool use is recorded against its repo ---')
const pulse = createToolPulse()
check('an unused repo has no pulse', pulse.get(REPO) === undefined)
pulse.note(REPO)
const first = pulse.get(REPO)
pulse.note(REPO)
const second = pulse.get(REPO)
check('repeated uses count up per root', first.count === 1 && second.count === 2, JSON.stringify(first) + ' vs ' + JSON.stringify(second))
check('the pulse carries when it last happened', typeof first.at === 'number' && second.at >= first.at)
check('another repo pulses independently', pulse.get(OTHER) === undefined)
pulse.note('')
check('an empty root is ignored', pulse.get('') === undefined)

console.log('\n--- every graft tool announces its own use ---')
const pulsed = []
const spawnedArgv = []
const fakeSpawn = (command, argv) => {
  spawnedArgv.push([command, argv])
  return {
    stdout: { on() {} },
    stderr: { on() {} },
    on(event, fn) { if (event === 'close') fn() },
    kill() {},
  }
}
const pulseTools = graftTools({
  fallbackCwd: BARE,
  // BARE has no index: the no-graph branch. Everything else resolves to REPO.
  findRoot: async (start) => (start === BARE ? undefined : REPO),
  noteUse: (root) => pulsed.push(root),
  command: { command: 'graft-fake', prefix: [], shell: false },
  spawn: fakeSpawn,
})
const ask = pulseTools.find((t) => t.name === 'graft_ask')
const answered = await ask.execute({ query: 'anything' }, { agent: { session: { header: { cwd: OTHER } } } })
check('the call still answers', typeof answered.text === 'string' && answered.text !== '', answered.text.slice(0, 60))
check('rooted at the session repo, not the process cwd', samePath(spawnedArgv[0]?.[1]?.at(-1), REPO), String(spawnedArgv[0]?.[1]?.at(-1)))
check('one call, one pulse, for the right root', pulsed.length === 1 && samePath(pulsed[0], REPO), JSON.stringify(pulsed))

const noGraph = await ask.execute({ query: 'anything' }, { agent: { session: { header: { cwd: BARE } } } })
check('a workspace with no graph explains itself', /No graft index/.test(noGraph.text))
check('and does not pulse — there is no green dot to light', pulsed.length === 1, JSON.stringify(pulsed))

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
// The open order: better-sidebar if a profile still has it, then dsh's own
// right sidebar (0.1.5+), and a browser tab only when neither is there.
check('dsh right sidebar comes after better-sidebar', clientSource.indexOf('ctx.get("betterSidebar")') < clientSource.indexOf('ctx.get("sidebarRight")'))
check('it opens by kind, which also reveals the column', clientSource.includes('right.openTab(VIZ_KIND)'))
check('a kind nothing registered falls through, not dead', clientSource.includes('openTab throws for a kind nothing registered'))
check('the type and its body register under the same id', clientSource.includes('sidebarRightTabs.register({') && clientSource.includes('id: TAB_TYPE,') && clientSource.includes('name: "sidebar.right.pane.tab", key: TAB_TYPE'))
check('that dependency is soft too', clientSource.includes('ctx.inject(["sidebarRightTabs", "slots"]') && !/const inject = [[]/.test('') && clientSource.indexOf('const inject = ["slots", "remote"]') !== -1)
check('the body reads the session from either host', clientSource.includes('props?.sessionId ?? props?.scope?.sessionId'))
check('the browser tab survives only as the last resort', clientSource.includes('neither sidebar'))
// The viz panel bar shows which checkout a worktree graph belongs to.
check('the viz panel names the worktree when the graph serves one', clientSource.includes('"worktree of " + wt') && clientSource.includes('status.worktreeOf'))

console.log('\n--- the dot flickers blue while a graft tool runs ---')
// The pulse rides the status poll, so it must bypass the five-second status
// cache: a blink that waited out `cacheMs` would land after the call ended.
const indexSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
check('the status payload carries the pulse', /toolUse: pulses\.get\(root\)/.test(indexSource))
check('on the cache-hit path too', (indexSource.match(/toolUse: pulses\.get\(root\)/g) ?? []).length === 2)
check('the flicker style exists and sits on the dot', clientSource.includes('.gs-chip.gs-live .gs-dot{color:#8b5cf6}'))
check('the client counts incoming pulses', clientSource.includes('toolUse?.count'))
check('a fresh pulse blinks, on and off, not solid', /for \(const ms of \[0, 175, 350, 525, 700, 875, 1050, 1225, 1400, 1575, 1750, 1925\]\)/.test(clientSource))
// Toggles alternate on/off, so an ODD number of marks ends ON — which shipped
// once as a dot stuck purple after every blink. An even count ends off.
const marks = clientSource.match(/for \(const ms of \[((?:\d+)(?:, \d+)*)\]\)/)?.[1]?.split(', ').map(Number) ?? []
check('the blink ends off, back at the resting colour', marks.length > 0 && marks.length % 2 === 0, JSON.stringify(marks))
check('polling speeds up while graft tools are active', clientSource.includes('settled && !recent ? 4000 : 2000'))
check('a pulse keeps the fast poll for a tail, not just the blink', clientSource.includes('window.setTimeout(() => setRecent(false), 20000)'))
check('the flicker timers are cleaned up on unmount', clientSource.includes('for (const t of flickTimers.current) window.clearTimeout(t)'))

console.log('\n--- the chip label truncates, the popup builds ---')
// A long workspace name must collapse to an ellipsis in the trailing-row
// chip, not stretch the composer. The popup keeps the full path.
check(
  'the chip label carries its own ellipsis rule',
  clientSource.includes('.gs-chip .gs-label{overflow:hidden;text-overflow:ellipsis'),
)
check('and the chip renders the label under that class', clientSource.includes('h("span", { className: "gs-label" }'))
// The popup's Build button calls a `build` remote method — the same plain
// offline `graft build` the bare /graft runs — with a busy state while it
// is in flight, then a status re-read so the card shows the fresh graph.
check('the client declares a build descriptor', clientSource.includes('descriptor("build", ["sessionId"])'))
check('the host serves a build method', indexSource.includes('markRemoteMethod(GraftStatusRemote.prototype, \'build\')'))
// The button rebuilds through the SAME sync-run.js the automatic hooks run —
// never a bare `graft build`, which writes the graph but NOT stats.json, so
// the pill kept reading the old `dirty` flag and never flipped to IN SYNC.
// That shipped once as a press that changed nothing.
check('the build goes through the shared rebuild engine', /build[\s\S]{0,600}autoSync\.rebuild\(root\)/.test(indexSource))
check('a finished build drops the stale cache', /build[\s\S]*?cache\.delete\(root\)/.test(indexSource))
check('the popup has a Build button', clientSource.includes('"Build"'))
check('it disables while the build runs', clientSource.includes('disabled: building'))
// The rebuild button sits IN the header row, right of the status pill — not
// in a footer row of its own.
check('no footer row survives the move', !clientSource.includes('gs-pop-buildrow'))
check(
  'one header group, rendered in both heads',
  (clientSource.match(/headGroup\(h\(/g) ?? []).length === 2,
  String((clientSource.match(/headGroup\(h\(/g) ?? []).length),
)
// Pill and Build travel as one group pinned right: a wrapper carries the
// row's only auto margin, so the flex gap is the only thing between the
// pair and nothing can split them — either apart or across the header.
check('the header pills travel in one right-pinned group', clientSource.includes('.gs-pop-group{margin-left:auto'))
check('the pill no longer spaces itself away from the button', !clientSource.includes('.gs-pill{margin-left:auto'))
// The card itself is click-through (pointer-events:none), which was fine
// while it was pure text — but any button inside it is dead unless it
// re-enables events on itself. That shipped once as a button that could
// never be pressed; this guard is the reason it will not ship again.
check('the Build button re-enables pointer events on itself', clientSource.includes('.gs-build{') && /\.gs-build\{[^}]*pointer-events:auto/.test(clientSource))
// The button holds Building… until OBSERVED freshness flips to synced, not
// until the build promise lands: a build that exits while stats.json still
// reads dirty (plain `graft build` never patches it) must not re-enable the
// button against a pill that still says STALE. That shipped once as a press
// that changed nothing; this guard is the reason it will not ship again.
check('the button waits for observed sync, not the promise', clientSource.includes('waitForSynced'))
check('with a bounded wait, not forever', clientSource.includes('SYNC_WAIT_MS'))
check('the seat hands the waiter to the card', clientSource.includes('onSynced: waitForSynced'))
check('a build that never reports sync re-enables with an error', clientSource.includes('did not report in sync'))

console.log('\n--- Build in a workspace with no index confirms first ---')
// The prompt is dsh's own themed Modal, not the browser's ugly box: the card
// requires the primitives package permission-presets already proves a client
// bundle can require. Guarded — if the package is ever absent the prompt
// falls back to window.confirm, so the gate can never go missing silently.
check('the card prefers dsh\'s own Modal', clientSource.includes('Primitives.Modal') && clientSource.includes('dsh-client-ui-primitives'))
check('the Modal carries the confirm copy', clientSource.includes('Build graft index?'))
check('its footer holds both accept and decline', clientSource.includes('Build index') && clientSource.includes('"Cancel"'))
// Guarded require: if primitives is ever unresolvable the gate falls back to
// the ugly box rather than going missing silently. The fallback is the ONLY
// window.confirm in the file.
check('only the fallback uses the browser box', (clientSource.match(/window\.confirm\(/g) ?? []).length === 1)
// The modal accept must START the build while the modal is still open: it may
// only close the modal after the build promise is underway. Closing first
// (unmounting the card's modal subtree in the same tick) shipped once as an
// accept that dismissed the dialog and built nothing.
check('the accept starts the build while the modal is open', /startBuild[\s\S]{0,300}setConfirming\(false\)/.test(clientSource))
check('the modal never closes before the build promise exists', !/setConfirming\(false\)[\s\S]{0,60}Promise\.resolve\(runBuild/.test(clientSource))
// The confirm modal portals to document.body — OUTSIDE the card's wrap — so
// the seat's capture-phase click-away closer would unmount the card (modal
// included) before the accept's own click dispatches. That shipped once as an
// accept that hid the dialog and built nothing; the closer must let modal
// clicks through.
check('the click-away closer lets modal clicks through', /closest\(['"]\[role="dialog"\]/.test(clientSource))
check('the accept runs the plain offline initialise', /runGraft\(\['build', from\], from/.test(indexSource))
check('a failed initialise reports graft\'s own message', /produced no index/.test(indexSource))
check('a fresh initialise resolves as initialising', /initialising: true/.test(indexSource))

await rm(fixture, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
