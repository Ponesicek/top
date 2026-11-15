---
name: test-top-app
description: Check Top's UI in a real client, in T3's Browser panel against fake bots (pnpm dev:fake), or as an Electron screenshot (pnpm screenshot). Use to verify a user-visible change, capture before/after images, or reproduce a UI bug.
---

# Test Top in a real client

Use T3's Browser panel against `pnpm dev:fake`. Don't install or build another browser automation
setup: if the panel is unavailable, say so and fall back to `pnpm screenshot`.

## Start the app

Reuse this task's running `pnpm dev:fake` if it's healthy. Otherwise start it in the background from
the repository root and keep its output:

```bash
pnpm dev:fake                       # busy fake bots: --load --tools --seed 40
pnpm dev:fake --tools --seed 40     # quiet bots with a history, for steady before/after captures
```

It prints `url: …` (the page to open, already pointed at its daemon) and `pid: …`. Both servers take
free ports, so it never touches the developer's own daemon (7357), `pnpm web` (5199) or another
checkout. The fake bots' state is this checkout's `apps/server/.data/fake`. Flags replace the defaults, so
`pnpm dev:fake --reset --load --tools --seed 40` starts that state over with busy bots.

To make a bot do something, message it: "deploy web 3s", "email the team", "check status", "write a
report", "crash". With `--load`, the bots keep working on their own.

## Use the Browser panel

1. `preview_status`. If no tab can be automated, `preview_open` (status can say unavailable just because
   no tab exists yet).
2. `preview_navigate` to the `url:` line, then `preview_snapshot` and the interaction tools.
3. Check light and dark (`preview_set_appearance`) and the narrow layout (`preview_resize` under 720px).
4. Keep using the same tab. `localStorage` (selected bot, pins, settings) belongs to the page's origin,
   so a restarted `pnpm dev:fake`, on new ports, starts with none.

## Desktop-only: pnpm screenshot

For what the browser doesn't have (the Electron window and title bar, the PDF viewer, zoom) or a capture
without the panel:

```bash
pnpm --filter @top/desktop screenshot /tmp/top.png     # a relative path lands in apps/desktop
```

It builds the app, starts its own fake daemon and captures the window: no window appears on screen, and
a failure exits non-zero with the reason. Settings, as environment variables:

- `TOP_SHOT_BOT=2` opens the third bot; `TOP_THEME=dark` or `light`; `TOP_SHOT_SCALE=2` captures at 2x.
- `TOP_SHOT_JS='…'` runs in the page before the capture (open a menu, fill a field); a promise is awaited,
  for up to 20 s. `TOP_SHOT_HOVER=selector` points the mouse at an element.
- `TOP_SHOT_WAIT=selector` waits for an element, `TOP_SHOT_SCROLL=1` scrolls it into view.
- The page's errors are always printed; `TOP_SHOT_CONSOLE=1` prints the rest of its console.

## Verify and keep it running

Exercise the flow the change touches and capture what proves it works. Leave the servers and the tab up
while the developer looks or asks for more: the end of a turn isn't the end of the check. When you're
done, stop `pnpm dev:fake` with Ctrl+C in its terminal or `kill <pid>` from its `pid:` line (stopping
`pnpm` alone leaves it running).
