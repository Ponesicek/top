# Top

Top is a fast client for your bots: one daemon (`apps/server`) runs them 24/7, and the desktop app
(`apps/desktop`, Electron, the same UI runs in a browser) and the phone attach to it. The README covers the
architecture, the packages and every flag; read it before a change that crosses packages.

These are good defaults, not hard rules. The developer's preferences override anything here.

## Commands

- `pnpm install` once. Before committing: `pnpm check` (Biome; `pnpm fix` applies the safe fixes),
  `pnpm typecheck` and `pnpm test`.
- `pnpm dev:fake` runs the app in a browser against fake bots, for trying and checking changes (below).
- Fake bots cost nothing and need no sign-in. Never sign in or start real bots (`pnpm server`, `--model`)
  to look at the UI.

## Verifying

- Proof depends on the change. Logic, state and protocol changes get a test, in the module's existing test
  file where one fits; a bug fix gets one that fails before the fix. Purely visual changes (spacing,
  colour, alignment, layout) get before/after captures as their proof, not tests.
- **Checking a user-visible change in a real client is requested for every such change in this repo**,
  including in T3's Browser panel (its `preview_*` tools): you don't need to be asked each time. Follow
  [test-top-app](.agents/skills/test-top-app/SKILL.md), once, after the change is done. Subagents don't
  start their own servers.
- Look at light, dark and the narrow window (under 720px, where the sidebar collapses to avatars).
- Desktop-only behavior (the window, its title bar, the PDF viewer, updates) isn't in the browser: use
  `pnpm screenshot` (see the skill).

## Pull requests

- Only when asked. Base them on `nightly`.
- Titles say what changes for the person using Top, in plain language: "Keep the sidebar preview while
  a bot runs tools, instead of "No messages yet"". Commits follow the same style.
- Body: the problem in a sentence or two, then how it's solved. End with the model and harness that did
  the work.
- UI changes carry before/after images, uploaded to the PR, never committed.
