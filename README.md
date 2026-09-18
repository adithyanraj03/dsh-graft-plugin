# dsh-graft-plugin

![language](https://img.shields.io/badge/language-javascript-f7dc6f) ![style](https://img.shields.io/badge/style-vanilla-gray) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen) ![dsh](https://img.shields.io/badge/dsh-web%20profile-orange) ![runtime](https://img.shields.io/badge/runtime-offline_%C2%B7_100%25_local-brightgreen) ![tests](https://img.shields.io/badge/tests-passing-brightgreen)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts [graft](https://github.com/trailhq/Graft) — a prebuilt graph of every symbol, its `file:line` span, and who calls what — in front of both you and the model.

It does four things:

- **A chip in the composer** naming the graft index the current session is actually serving, whether it still matches the code, and how many tokens graft has saved in that repo.
- **Five tools for the model** — `graft_ask`, `graft_grep`, `graft_callers`, `graft_skeleton`, `graft_map` — resolved per session, so one dsh can serve several workspaces at once.
- **`/graft`** to build or rebuild the index, and **auto-rebuild** after the model edits files.
- **A `graft viz` button** that opens the graph as a tab in [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar).

## Install

```sh
dsh plugin --profile web add dsh-graft-plugin
dsh --profile web
```

**pnpm 10 and later block `postinstall` scripts from unapproved packages**, and dsh skips writing the plugin's bundle row whenever the install exits non-zero — the dependency lands, the plugin stays invisible, and dsh starts up cleanly with no error to search for. If `add` ends with `ERR_PNPM_IGNORED_BUILDS`, approve and re-run it:

```sh
cd ~/.dsh/profiles/web && pnpm approve-builds      # tick dsh-graft-plugin
dsh plugin --profile web add dsh-graft-plugin      # re-run so the bundle row gets written
```

Confirm it mounted — the plugin must appear in **both** `dependencies` and `dsh.profile.bundles` in the profile's `package.json`:

```sh
cd ~/.dsh/profiles/web && node -e "const p=require('./package.json');
  console.log(p.dependencies['dsh-graft-plugin'],
              p.dsh.profile.bundles.includes('dsh-graft-plugin'))"
```

Every tool here shells out to the `graft` CLI, so it needs `@nanonets/graft` on PATH:

```sh
npm install -g @nanonets/graft
```

A `postinstall` does this for you **when your package manager runs lifecycle scripts** — under pnpm 10+ they are blocked by default, so treat the command above as the required step there, not a fallback. If your global npm prefix needs elevation, the postinstall says so and prints the one command to run by hand.

Then index a repo once:

```sh
cd <your repo>
graft build
```

### The sidebar tab

The `graft viz` button needs `dsh-better-sidebar` **mounted**. It ships as a dependency of this plugin (0.18.x), so it is already downloaded — but dsh only mounts what the profile lists:

```sh
dsh plugin --profile web add dsh-better-sidebar
```

> **Compatibility.** `dsh-better-sidebar` 0.18.x requires `@deepseek-ai/dsh-client-ui-primitives`, which dsh removed in `0.1.5-rc.2`. On that version or later the tab will not mount and the button reports the sidebar as unavailable. Everything else in this plugin — chip, tools, `/graft`, auto-rebuild — is unaffected.

Skip it if you do not want the tab. The chip, the tools, `/graft` and the auto-rebuild all work without it; the button just reports that the sidebar is unavailable.

> This plugin does **not** insert a `dsh-better-sidebar` row itself, on purpose. That package's own bundle row carries a guard that disables it when another enabled row already mounts the same package. A second row with a different id makes that guard circular, and the losing outcome is *your existing sidebar silently disabling itself*. One explicit command is worth more than that risk.

## What you get

### The chip

Sits in the composer next to the model name:

```
● graft · my-repo          in sync
◐ graft · my-repo          syncing
▲ graft · my-repo          stale
```

Hovering (or clicking) opens a card with the resolved root, node and edge counts, freshness, the running saved-token tally, and the `graft viz` button.

![The chip in the composer, with its hover card](assets/chip.png)

The root is resolved from **the session's own workspace**, not from wherever dsh was launched. That is the whole reason this exists rather than the `graft mcp` server: `graft mcp` resolves its repo once, from its own working directory at startup, and nothing can re-point it afterwards. Launched from a home directory it answers *"no graph found"* for every workspace you open.

### The visualiser

The `graft viz` button opens the graph as a tab in [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar). The context view lays out the whole graph:

![The graph in the sidebar — context view](assets/viz-context.png)

The code view drills into a single file — what it contains, what it depends on, what depends on it:

![The graph in the sidebar — code view](assets/viz-code.png)

### The tools

| tool | what it answers |
|---|---|
| `graft_ask` | "how does X work" / "where is Y" — ranked hits with code inlined at exact `file:line` |
| `graft_grep` | every occurrence, grouped by enclosing symbol (`graft_ask` is top-N and misses some) |
| `graft_callers` | who calls a symbol, what it calls, or the full blast radius before a rename |
| `graft_skeleton` | a file's whole API in ~200 tokens |
| `graft_map` | orientation in an unfamiliar tree |

None of them take a boolean parameter. They take string enums instead — `detail: "full"` rather than `full: true` — which reads better to a model and sidesteps a real failure mode on some OpenAI-compatible servers, where a tool call that *sets* a boolean is emitted as literal `<tool_call>` text and never runs.

### `/graft`

- `/graft` — build the index, or rebuild it if one exists
- `/graft status` — what the chip knows, as text
- `/graft deep` — a full rebuild

### Auto-rebuild

After the model writes or edits files, the index is rebuilt in the background, debounced so a long turn does not rebuild on every keystroke. This reuses graft's own sync runner rather than reimplementing it, so it cannot drift from what `graft build` does.

## Configuration

All optional, all on the plugin's row in your profile's `cordis.patch.yml`:

```yaml
- id: graft-status
  name: 'dsh-graft-plugin'
  config:
    cwd: 'C:/path/to/repo'   # pin to one repo instead of resolving per session
    tools: false             # drop the graft_* tools, keep the chip
    command: false           # drop /graft
    promptSection: false     # stop telling the model to prefer graft
    autoBuild: false         # stop rebuilding after edits
```

## Requirements

| dsh | status |
|---|---|
| `0.1.2-rc.1` – `0.1.0-rc.7` | tested, full feature set |
| `0.1.5-rc.2` | tested — chip, tools, `/graft` and auto-rebuild all work; the `graft viz` tab does not mount (see the sidebar note above) |

- Node 22+
- the `graft` CLI on PATH (`npm install -g @nanonets/graft`)

The client bundle requires only `react`, which is why it survives the dsh `0.1.5-rc.2` client-package removals that broke several neighbouring plugins.

## Development

```sh
npm install
npm test           # portable: builds a synthetic graft index in a temp dir
npm run test:live  # drives the real graft CLI against a real repo
```

`npm test` needs no graft index and no graft install anywhere on the machine. The one suite that does build a real index skips itself, loudly, when graft is absent — a missing CLI is a setup state, not a defect.

### Two identifiers, deliberately different

The cordis row `id` (`graft-status`) is this plugin's own handle — it keys the storage file, the prompt section and every effect label, and is stable across renames.

The client bundle's `__ModuleLoader__.load({ id })` is **not** that handle. It must be the published package name: dsh builds each client row from `entry.options.name` — the `name:` in `cordis.patch.yml` — serves the bundle at `/plugins/<name>/client.js`, then asserts that a factory registered under that same name. Using the row id there fails every boot with:

```
bundle /plugins/dsh-graft-plugin/client.js loaded without
registering "dsh-graft-plugin" via __ModuleLoader__.load
```

`npm test` guards this both ways (the guard was added with the 0.1.1 fix).

## Troubleshooting

**No chip appears and dsh started without errors.** The plugin is in the profile's `package.json` `dependencies` but not in `dsh.profile.bundles` — which happens under pnpm 10+ when the `add` ends non-zero on `ERR_PNPM_IGNORED_BUILDS`; dsh skips the bundle row in that case and starts up looking healthy. Fix: `pnpm approve-builds` in the profile directory (tick `dsh-graft-plugin`), then re-run `dsh plugin --profile web add dsh-graft-plugin`. If `pnpm approve-builds` reports nothing awaiting approval, check `pnpm-workspace.yaml` for an unanswered `dsh-graft-plugin` entry (pnpm's approval placeholder) and set its value to `true` first.

**`/graft` says the graft CLI is not on PATH.** The postinstall was blocked or skipped (see Install): `npm install -g @nanonets/graft`.

## Licence

MIT
