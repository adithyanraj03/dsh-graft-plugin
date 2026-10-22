/**
 * The standing instruction must reach the model on CURRENT dsh.
 *
 * dsh `0.1.7-rc.2` removed the `agent/session-start` event the guidance used to
 * ride: the listener stayed registered and the suite stayed green, while no
 * agent ever fired it, so `graft-status:usage` silently vanished from every
 * prompt. This suite runs `apply()` against a REAL Cordis context and drives
 * the event dsh actually emits now (`agent/created`, the same seam dsh's own
 * file-reference plugin uses), so an upstream rename fails here instead of
 * disappearing into a prompt nobody diffs.
 *
 * Cordis resolves injects asynchronously, so every check after a trigger
 * waits a tick first — the assertions test what a live session would see,
 * not what a synchronous read-back would flatter.
 *
 * Run:  node scripts/test-guidance.mjs      (part of `npm test`)
 */
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'

import { apply } from '../src/index.js'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''))
  if (!ok) failures += 1
}
/** Let pending Cordis inject fibers and disposals settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The whole prompt section this plugin registers, as the tests see it. */
const SECTION_NAME = 'graft-status:usage'
const GUIDANCE_ORDER = 950

/**
 * A prompt-registry stand-in that behaves like the real `systemPrompt`
 * service where it matters. It is a Cordis Service, so the traceable-context
 * overlay applies, and `section()` creates its undo effect on the CALLER's
 * context — the same ownership `SystemPrompt.section()` gets through
 * `ScopedLayers`, and the reason an agent's section can die with the agent.
 */
function fakePromptRegistry(sections, removed) {
  return class FakePromptRegistry extends Service {
    constructor(ctx) {
      super(ctx, 'systemPrompt')
    }

    section(section) {
      sections.push(section)
      return this.ctx.effect(() => () => {
        removed.push(section.name)
      }, `fake.section(${section.name})`)
    }
  }
}

/** Mount the stand-in on a context as the `systemPrompt` service. */
function providePromptRegistry(ctx, sections, removed) {
  ctx.plugin(fakePromptRegistry(sections, removed))
}

console.log('--- apply() against a real Cordis context ---')
const root = new Context()
const registeredTools = []
const sections = []
const removed = []
root.plugin(fakePromptRegistry(sections, removed))
root.reflect.provide('tools', {
  register(tool) {
    registeredTools.push(tool)
    return () => {}
  },
})

let threw
try {
  await apply(root, {})
} catch (error) {
  threw = error
}
check('apply() mounts without throwing', threw === undefined, threw ? String(threw) : '')
check('the five graft tools register', registeredTools.length === 5, registeredTools.map((t) => t.name).join(', '))

console.log('\n--- the guidance rides agent/created, not the removed agent/session-start ---')
check(
  'the source never names the removed event',
  !(await readFile(new URL('../src/index.js', import.meta.url), 'utf8')).includes('agent/session-start'),
)
check('no guidance before any agent exists', sections.length === 0, JSON.stringify(sections))

console.log('\n--- an agent with the prompt registry gets the section ---')
const agent = { ctx: new Context() }
providePromptRegistry(agent.ctx, sections, removed)
root.emit('agent/created', { agent })
await settle()
check('the section registered on the agent scope', sections.length === 1, JSON.stringify(sections[0]?.name))
check('under its own name', sections[0]?.name === SECTION_NAME, sections[0]?.name)
check('at the documented order', sections[0]?.order === GUIDANCE_ORDER, String(sections[0]?.order))
check('with the graft guidance text', /graft_ask/.test(sections[0]?.text ?? ''), (sections[0]?.text ?? '').split('\n')[0])

console.log('\n--- a second announce does not duplicate it ---')
root.emit('agent/created', { agent })
await settle()
check('the section registered exactly once', sections.length === 1, String(sections.length))

console.log('\n--- agent disposal takes the section down ---')
root.emit('agent/disposed', { agent })
await settle()
check('the section was disposed with the agent', removed.length === 1, JSON.stringify(removed))

console.log('\n--- an agent WITHOUT the prompt registry only loses the sentence ---')
const bare = { ctx: new Context() }
let bareThrew
try {
  root.emit('agent/created', { agent: bare })
  await settle()
} catch (error) {
  bareThrew = error
}
check('a registry-less agent is survived, not crashed', bareThrew === undefined, bareThrew ? String(bareThrew) : '')
check('and it adds no section', sections.length === 1, String(sections.length))

console.log('\n--- agents that already exist when the row mounts are briefed too ---')
const lateRoot = new Context()
lateRoot.reflect.provide('tools', { register: () => () => {} })
providePromptRegistry(lateRoot, sections, removed)
lateRoot.reflect.provide('agents', { list: () => [agent, bare] })
const before = sections.length
let lateThrew
try {
  await apply(lateRoot, {})
  await settle()
} catch (error) {
  lateThrew = error
}
check('apply() with an agents service does not throw', lateThrew === undefined, lateThrew ? String(lateThrew) : '')
check('pre-existing agents got the section at mount', sections.length === before + 1, `${sections.length - before} added`)
check('and the registry-less one stayed silent', sections.every((s) => s.name === SECTION_NAME))

console.log('\n--- promptSection: false registers nothing ---')
const quietRoot = new Context()
quietRoot.reflect.provide('tools', { register: () => () => {} })
providePromptRegistry(quietRoot, sections, removed)
quietRoot.reflect.provide('agents', { list: () => [agent] })
await apply(quietRoot, { promptSection: false })
quietRoot.emit('agent/created', { agent })
await settle()
check('no guidance section from a suppressed row', sections.length === before + 1, `${sections.length - before - 1} added`)

console.log('\n--- teardown ---')
for (const ctx of [root, agent.ctx, lateRoot, quietRoot]) {
  try {
    await ctx.fiber?.dispose?.()
  } catch {
    // A test context holds only fake services; nothing here may block exit.
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
