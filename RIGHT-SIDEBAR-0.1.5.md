# Open `graft viz` in dsh 0.1.5's built-in right sidebar

Status: **applied** to this package (`src/client.js`, `scripts/test-harness.mjs`)
and to the local plugin it was developed in (`~/.dsh/plugins/graft-status/client.js`).
Both copies are byte-identical in the changed regions; this repo keeps CRLF
endings, the local plugin uses LF.

Not published yet. This document is what the published version needs.

---

## 1. Why

The visualiser button opened `graft viz` in a **dsh-better-sidebar** tab, and
fell back to a browser tab when that plugin was absent:

```
better-sidebar (ctx.betterSidebar.openTab)  ->  window.open
```

dsh **0.1.5** ships its own right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`,
with `-sidebar-files` and `-sidebar-documentpreview` tabs). Profiles are dropping
dsh-better-sidebar because the built-in column duplicates it — and when it goes,
this plugin's graph silently degrades to a browser tab.

The order is now:

```
better-sidebar  ->  dsh's own right sidebar  ->  window.open
```

Nothing is removed. A profile that still has dsh-better-sidebar behaves exactly
as before, and a dsh older than 0.1.5 (no right-sidebar services) is unaffected.

## 2. What the user sees

- Clicking the graph button in the composer chip opens **Graft** as a tab in the
  right sidebar, and expands that column if it was collapsed.
- Clicking again focuses the tab that is already open instead of starting a
  second `graft viz` server.
- The sidebar's **guide page** (its "+" / new-tab screen) gains a **Graft**
  entry, described as "The graft graph for this workspace", so the graph can be
  opened from there too.
- The tab body is unchanged: the same header (repo, nodes, edges, freshness,
  tokens saved), the same reload control, the same iframe.

## 3. The dsh 0.1.5 API this uses

Read from the shipped packages, not from docs:

| Concern | API |
|---|---|
| Declare the tab type | `ctx.sidebarRightTabs.register(definition)` → disposer |
| Supply its body | keyed slot `sidebar.right.pane.tab`, **key = `definition.id`** |
| Open it | `ctx.sidebarRight.openTab(kind, options?)` |

Details that matter, from
`@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`
and `.../service.d.ts`:

- A type is registered in **two stages**: a static definition (stage 1) and the
  body in the keyed seat under the same `id` (stage 2). `id` is the
  implementation identity and must be unique; `kind` is the type discriminator
  that `openTab` names. A second registration of an `id` throws.
- A **page type** (opened by kind, recognising no address) simply omits
  `patterns`. Ours is a page type.
- `priority` is one of `'extension' | 'builtin' | 'fallback'`, and **defaults to
  `extension`** — the band for types from outside the product, which outranks
  shipped viewers. We state it explicitly.
- `title` and the guide entry's `title`/`description` are **thunks**, re-read on
  every use, so a language change needs no re-registration.
- `openTab` "opens a page type by kind … The column expands in the same step,
  because content the user cannot see is not opened", and **throws for a kind
  nothing registered** — hence the try/catch below.
- Bodies receive their session as a **prop**: `sessionId`, alongside
  `useTabInfo`, `useStore`, `actions`. (better-sidebar instead passes
  `scope.sessionId` and a `visible` flag.)

## 4. The change, hunk by hunk

All four hunks are in `src/client.js` (the browser half). Anchors are quoted
exactly; nothing else in the file changed.

### 4.1 A kind for dsh's sidebar

**Before**

```js
    /** The tab type contributed to dsh-better-sidebar. */
    const TAB_TYPE = "graft-status:viz";
```

**After**

```js
    /** This viewer's identity: better-sidebar's tab type, and dsh's tab id. */
    const TAB_TYPE = "graft-status:viz";

    /**
     * The kind dsh's own right sidebar opens this page type by.
     *
     * dsh 0.1.5 splits a tab type in two: a static registration naming the kind
     * (`ctx.sidebarRightTabs`), and the body under the registration's id in the
     * keyed `sidebar.right.pane.tab` seat. `ctx.sidebarRight.openTab(kind)`
     * then opens it AND expands a collapsed column in the same step.
     */
    const VIZ_KIND = "graft-viz";
```

`TAB_TYPE` is reused as the dsh registration's `id`, so one constant identifies
the viewer in both hosts.

### 4.2 The body serves both hosts

Inside `makeVizTab`'s returned component.

**Before**

```js
        const visible = props?.visible !== false;
        // The sidebar's own scope. Its `sessionId` is what tells the host WHICH
        // workspace to resolve — the same session whose cwd the sidebar shows.
        const sessionId = props?.scope?.sessionId;
```

**After**

```js
        // Visible by default: better-sidebar passes `visible: false` for a tab
        // that exists but is not focused (and asks live views to pause then);
        // dsh's sidebar mounts only what it draws and passes nothing.
        const visible = props?.visible !== false;
        // Which workspace to resolve. Both hosts supply the session, in their
        // own shape: dsh passes `sessionId` straight to the body, while
        // better-sidebar wraps it in the tab's `scope`.
        const sessionId = props?.sessionId ?? props?.scope?.sessionId;
```

The rest of the component is untouched, including the rule that the URL is
**always** asked of the host on mount and never seeded from the tab record.

### 4.3 The click path

In `openViz`, immediately after the `ctx.get("betterSidebar")` branch returns
and before the browser-tab fallback.

**Before**

```js
          // Fallback for a profile with no dsh-better-sidebar: a browser tab.
```

**After**

```js
          // Next: dsh's own right sidebar (0.1.5+). `openTab` names the KIND,
          // reveals the column, and reuses the tab that is already open, so a
          // second click focuses the graph rather than stacking another.
          // The body starts the server itself on mount, so nothing is awaited
          // here and no popup-blocker timing applies.
          const right = ctx.get("sidebarRight");
          if (right !== undefined && right !== null && typeof right.openTab === "function") {
            try {
              right.openTab(VIZ_KIND);
              return;
            } catch (error) {
              // openTab throws for a kind nothing registered — which is the
              // case when the tab registry was absent at load. Fall through to
              // the browser tab rather than leaving the click dead.
              console.warn("[graft-status] right sidebar refused the viz tab:", error);
            }
          }

          // Last resort, for a profile with neither sidebar: a browser tab.
```

Three properties are deliberate:

1. **`ctx.get`, not a declared inject.** A hard dependency would stop the whole
   plugin — chip included — from activating on a dsh without the sidebar.
2. **No `await` before the branch.** The body starts the server itself, so the
   popup-blocker timing that governs the `window.open` path does not apply here.
3. **The `catch` falls through.** `openTab` throws on an unregistered kind; a
   dead button would be worse than a browser tab.

### 4.4 Registering type + body

Inserted immediately **before** the existing `ctx.inject(["betterSidebar"], …)`
block in `apply`.

```js
      // dsh's own right sidebar (0.1.5+). Two registrations: the static type,
      // and the body in the keyed seat under the SAME id. `ctx.inject` rather
      // than the module-level list for the same reason as below — a profile
      // without this sidebar must still get the chip and the button.
      ctx.inject(["sidebarRightTabs", "slots"], (scope) => {
        scope.effect(
          () =>
            scope.sidebarRightTabs.register({
              id: TAB_TYPE,
              kind: VIZ_KIND,
              // A page type, opened by kind: it recognises no resource address,
              // so it declares no patterns. "extension" is the band for a type
              // from outside the product, and the default.
              priority: "extension",
              title: () => "Graft",
              guide: [
                {
                  order: 60,
                  title: () => "Graft",
                  description: () => "The graft graph for this workspace",
                  icon: GraphIcon,
                },
              ],
            }),
          "graft-status: right sidebar tab type",
        );
        scope.effect(
          () =>
            scope.slots.inject("sidebar.right.pane.tab", () =>
              scope.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE }, makeVizTab(ctx)),
            ),
          "graft-status: right sidebar tab body",
        );
      });
```

`slots.inject` wraps the register because `sidebar.right.pane.tab` is a **child
slot**: registering into one before its parent entry's children table has
committed throws *"slot … is not declared (a parent entry's children table must
declare it)"* and fails the whole plugin at load. The same rule already governs
this plugin's `conversation.input.right` registration.

## 5. Tests

`scripts/test-harness.mjs` asserted the old comment text:

```js
check('the browser tab survives only as the fallback', clientSource.includes('no dsh-better-sidebar'))
```

That single line was replaced by eight source-level checks (the harness asserts
against the client source because these paths are unreachable from Node):

```js
// The open order: better-sidebar if a profile still has it, then dsh's own
// right sidebar (0.1.5+), and a browser tab only when neither is there.
check('dsh right sidebar comes after better-sidebar', clientSource.indexOf('ctx.get("betterSidebar")') < clientSource.indexOf('ctx.get("sidebarRight")'))
check('it opens by kind, which also reveals the column', clientSource.includes('right.openTab(VIZ_KIND)'))
check('a kind nothing registered falls through, not dead', clientSource.includes('openTab throws for a kind nothing registered'))
check('the type and its body register under the same id', clientSource.includes('sidebarRightTabs.register({') && clientSource.includes('id: TAB_TYPE,') && clientSource.includes('name: "sidebar.right.pane.tab", key: TAB_TYPE'))
check('that dependency is soft too', clientSource.includes('ctx.inject(["sidebarRightTabs", "slots"]') && …)
check('the body reads the session from either host', clientSource.includes('props?.sessionId ?? props?.scope?.sessionId'))
check('the browser tab survives only as the last resort', clientSource.includes('neither sidebar'))
```

Run:

```bash
npm test          # test-harness + test-autosync + test-command — all green
npm run test:live # needs a real graft install
```

## 6. Compatibility

- **No new dependencies**, no `package.json` change, no `cordis.patch.yml`
  change, no host-half change.
- **`engines` / peer deps unchanged.** The sidebar path is discovered at
  runtime, so the package does **not** need `dsh >= 0.1.5`.
- **Older dsh:** `ctx.inject(["sidebarRightTabs", "slots"])` never fires, `ctx.get("sidebarRight")`
  returns undefined, behaviour is exactly as before.
- **dsh-better-sidebar still installed:** it is tried first, so that path is
  unchanged. Both tabs can be registered at once; they are separate hosts.
- Suggested version for the release carrying this: **0.2.0** (new surface,
  no breaking change). Current `package.json` says `0.1.2`.

## 7. Notes for whoever publishes this

1. **README** still documents the viz as "opens in dsh-better-sidebar, else a
   browser tab". Add the right-sidebar path and the guide entry; drop any claim
   that better-sidebar is required for an in-app graph.
2. **Screenshots** (`screenshots.json`, `assets/`) show the graph in
   better-sidebar. A shot in the built-in right column would match a default
   0.1.5 profile.
3. **Marketplace description** — same wording fix.
4. **Repo layout changed earlier in this line** and the published package must
   match: runtime modules live in `src/`, test/build scripts in `scripts/`, and
   `main`, every `exports` entry and `files` point at `src/…` / `scripts/…`.
   Verify with `npm pack --dry-run` that all 5 `src/*.js`, `cordis.patch.yml`
   and the 4 `scripts/*.mjs` ship.
5. **Two gotchas seen while porting other plugins to 0.1.5**, worth knowing if
   this plugin grows:
   - A **keyed** slot refuses a second entry at the same priority, and the
     refusal fails the *plugin that loads second*, not just the row. dsh 0.1.5
     began shipping its own `tool.call.toolview` cards for `read_image` and
     `web_fetch`, which took two local plugins down at boot until they
     registered at `priority: -10` (lowest renders). graft-status registers no
     keyed slot other than the new `sidebar.right.pane.tab` key, which is its
     own id, so it is not exposed today.
   - `ctx.connection.rpc.handle(...)` is **broken for third-party plugins** in
     0.1.5: the service reads `webServer` under its own context, which does not
     declare it, so the call throws `cannot get property "webServer" without
     inject` however the caller declares its injects. No shipped dsh plugin
     uses it. graft-status does not either (it uses the typert remote), but
     avoid it.

## 8. Verification performed

- `npm test` in this package: all suites green, including the eight new checks.
- Same change and tests in `~/.dsh/plugins/graft-status`: green.
- dsh 0.1.5 boots with the plugin loaded, and the browser console shows
  `graft-status: client mounted, registering conversation.input.right` with no
  plugin-load errors.
- **Not yet verified by a human:** clicking the button and seeing the graph in
  the right column. Worth one manual pass before release.
