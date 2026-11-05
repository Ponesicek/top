# Top

A fast, never-drops client for your bots. One daemon runs the bots 24/7, and desktop and phone
clients attach to it and detach whenever they like.

```
┌──────────── Top daemon (apps/server) ────────────┐        ┌── desktop (apps/desktop, Electron) ──┐
│ Pi Durable Harness on SQLite                     │  WS    │ @top/client                           │
│  bots = conversations · turns = durable tasks    │◄──────►│  view + Chord ops, applied per frame  │
│  watch() per client → Chord ops, backpressured   │        │  ConversationTranscript (gaps, pages) │
└──────────────────────────────────────────────────┘        │  optimistic sends, requestId resend   │
                                                            └── phone (React Native, next) ─────────┘
```

| Package | What it is |
|---|---|
| `packages/protocol` | Wire frames (JSON over one WebSocket). No dependencies. |
| `packages/client` | `@top/client`: connection, reconnect, view sync, transcript paging, optimistic sends. Framework-free, so it's shared by desktop and mobile. |
| `apps/server` | The daemon. Owns the Harness, the bot roster, sidebar summaries, and serves clients. |
| `apps/desktop` | Electron + React. Virtualized transcript, performance overlay, benchmark. |

## Run it

```bash
pnpm install
pnpm server:load     # daemon with 5 fake bots streaming, one with a 10,000-message history
pnpm desktop         # Electron app (or `pnpm web` for the same UI in a browser at :5199)
```

The bots use Pi AI's faux provider, so no API key is needed. Everything above the model is real Pi
Durable: commits, views, the inbox, crash recovery. Daemon flags: `--port`, `--data`, `--load`,
`--seed N`, `--tps N`, `--reset`.

Desktop keys: `Ctrl+1…9` / `Alt+↑↓` switch bots, `Enter` sends (queues while busy), `Ctrl+Enter` steers,
`Esc` stops, `Ctrl+Shift+P` toggles the performance overlay.

## The UX bar

`pnpm bench` builds the app, starts a loaded daemon, drives Electron with real input events, and
kills the daemon with `kill -9` partway through. Latest run (Linux, Xvfb, software rendering):

| Check | Result | Bar |
|---|---|---|
| Cold start → content, empty cache / cached | 279 / 229 ms | < 1 s |
| Keystroke → frame, p50 / p99, 5 bots streaming | 11.3 / 19.5 ms | next 60 Hz frame |
| Keystrokes that missed the next frame | 0 / 144 | < 1% |
| Scrolling a 10,000-message transcript | 60 fps, p99 16.8 ms, 0 frames > 33 ms | steady 60 fps |
| `kill -9` daemon | stale banner, transcript kept | no blank screen |
| Reconnect after the daemon is back | 153 ms | < 1 s |
| Message sent while the daemon was down | accepted 153 ms after restart, exactly 1 copy | lands once |

`pnpm --filter @top/client test` runs the same crash/resume scenario headless.

## How the "never drops" part works

- **The daemon commits before it shows.** Pi Durable stores every step, so a killed daemon resumes
  interrupted turns on restart.
- **Clients render state; they don't replay events.** The daemon sends the conversation view once,
  then Chord ops. The client decodes ops as they arrive and applies them once per animation frame.
- **Backpressure is free.** The daemon's watch listener waits for the socket to drain, and Chord folds
  any commits that land meanwhile into the next update. A slow phone gets fewer, bigger updates.
- **Reconnect resumes from what the client has.** `ConversationTranscript.resume` asks only for
  entries after the newest one held. Anything missed beyond the window becomes a gap that loads
  when scrolled into view.
- **Dead connections are noticed fast.** Pings every 3 s, and silence for 8 s counts as a drop. Retries
  run at 250 ms through a blip, then back off to 5 s with jitter.
- **Sends are optimistic and idempotent.** A message shows as pending at once, survives a drop, and is
  resent with the same `requestId`. The daemon places it as a `top.message` entry carrying that
  `requestId`, so the client retires its pending copy exactly when the real one lands.
- **Cold start doesn't wait for the network.** The last view of each bot is cached locally and shown
  as stale until the daemon answers.

## Notes

- `patches/@earendil-works__pi-durable@1.5.0.patch` adds a `./transcript` export, so the client can
  import `ConversationTranscript` without pulling in the Node-only parts of the package root.
  Worth upstreaming.
- Pi Durable is experimental. Its API is only touched in `apps/server/src` and
  `packages/client/src/conversation.ts`.
