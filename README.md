# Top

A fast, never-drops client for your bots. One daemon runs the bots 24/7, and desktop and phone
clients attach to it and detach whenever they like. Nothing streams: answers arrive whole, tool calls
show as steps, and the app says what each bot is doing while it does it.

```
┌──────────── Top daemon (apps/server) ────────────┐        ┌── desktop (apps/desktop, Electron) ──┐
│ pi-agent-core: one Agent per bot                 │  WS    │ @top/client                           │
│ SQLite: entries · inbox · tool_calls · bots      │◄──────►│  entries after `seq`, gaps, paging    │
│ every step saved before the next one starts      │ deflate│  optimistic sends, requestId resend   │
└──────────────────────────────────────────────────┘        └── phone (React Native, next) ─────────┘
```

| Package | What it is |
|---|---|
| `packages/protocol` | Wire frames (JSON over one compressed WebSocket), as Effect schemas: the types derive from them, and both ends check every frame that arrives. Also the daemon's refusals, as tagged errors. |
| `packages/client` | `@top/client`: connection, reconnect, catch-up by sequence number, history paging, optimistic sends. Framework-free, so it's shared by desktop and mobile: Effect inside, snapshots and Promises outside. |
| `apps/server` | The daemon, as Effect services: storage (`store.ts`, Effect SQL on `node:sqlite`), one runner per bot (`runner.ts`), tools and their crash policies (`tools.ts`), the event bus (`events.ts`), the HTTP and WebSocket layer (`serve.ts`). |
| `apps/desktop` | Electron + React, its state in Effect atoms. Virtualized transcript, performance overlay, benchmark. |

Everything but the React components runs on [Effect](https://effect.website) 4. The daemon is a set of
services composed as Layers (`main.ts`) and closed in reverse order when it stops. Where pi calls in
(its Agent's hooks and listener, tools, credentials) the interfaces stay Promise-based, and run Effects
inside. The wire format is Top's own: Effect RPC's socket protocol answers every streamed frame with an
acknowledgement, which would cost about a fifth more data while following bots (see Data use).

## Run it

```bash
pnpm install
pnpm server          # the daemon, with one bot (Atlas) on a real model (openai/gpt-6.1-sol)
pnpm desktop         # Electron app (or `pnpm web` for the same UI in a browser at :5199)
```

Before committing: `pnpm check` (Biome: lint, format, import order; `pnpm fix` applies the safe fixes),
`pnpm typecheck` (TypeScript 7 with Effect's diagnostics, through `effect-tsgo`) and `pnpm test` (vitest).

The bots sign in through pi, the coding agent: Top reads and refreshes pi's `~/.pi/agent/auth.json`
under pi's own file lock, so if `pi` works, Top works. Not signed in? Run `pi`, then `/login`. An API
key in the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) works too. Pick another model with
`pnpm server --model anthropic/claude-opus-5-5`; `--thinking off|low|medium|high` sets reasoning
(default medium). ChatGPT sign-ins can't use every model (`gpt-5.5` is refused); `gpt-6.1-sol` works.
Each real bot owns a folder, `~/bots/<name>` (`--workspace DIR` puts them in `DIR/bots/<name>`),
and works from it: commands start there and relative paths resolve there. Its tools are pi's coding
tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) with full access to the computer, as the
user running the daemon. After a crash, `read`/`ls`/`grep`/`find`/`write` run again; a cut-off `bash`
or `edit` is reported as interrupted, never re-run. Conversations live in `apps/server/.data/bots`.

Because the bots can run commands, the daemon refuses browser connections from anything but the app
(`file://` and the dev UI on :5199): browsers let any web page open a WebSocket to localhost.
`--allow-origin URL` adds one. There's no login on the daemon's own port, so keep `--host` on
127.0.0.1: whoever reaches that port can run commands as you. To use Top from your phone or another
computer, put it on your tailnet with `--tailscale` (below), which checks who each caller is, or use
an SSH tunnel.

Fake bots, for development and the tests, need no sign-in:

```bash
pnpm server:load     # 5 fake bots under load, one with a 10,000-message history
pnpm server:fake     # fake bots that answer only when you message them
```

The fake model calls tools when asked: "deploy web 3s", "email the team", "check status", "write a report", "crash",
or any MCP tool by its full name: `call github_work__search {"query": "top"}`.
Their data is in `apps/server/.data/fake`. Daemon flags: `--model`, `--thinking`, `--workspace`, `--allow-origin`, `--port`, `--host`,
`--data`, `--reset`, `--no-compress`, `--tailscale`, `--tailscale-allow`, `--tailscale-port`; fake only: `--load`, `--tools` (load includes tool calls),
`--seed N`, `--tps N`.

Real mode starts with one bot, Atlas. Make more with the **+** beside "Bots" (a name, and a
description the bot reads as part of its instructions); hover over a bot to delete it. Deleting
erases its conversation everywhere; files in its folder stay.

Attach files with the paperclip, by pasting, or by dropping them on the conversation. They upload as
soon as they're added. Images are shrunk to 2000 px on their long side first, and a paste over 32 KB
becomes a text file (`Ctrl+Shift+V` pastes it inline). The bot gets each file's path to open with its
tools, and PNG, JPEG, GIF and WebP images as images too. They're kept in `<data>/attachments`: an
upload no message used goes after a day, the rest go with their bot.

Desktop keys: `Ctrl+1…9` / `Alt+↑↓` switch bots, `Enter` sends (queues while busy), `Ctrl+Enter` steers,
`Esc` stops, `Ctrl+Shift+E` shows the bot's files, `Ctrl+,` opens settings, `Ctrl+=` / `Ctrl+-` / `Ctrl+0`
change the interface size (also in settings), `Ctrl+Shift+P` toggles the performance overlay.

### Tailscale

`pnpm server --tailscale` also puts the daemon on your tailnet, through the Tailscale already running
on its computer, at `wss://<device>.<tailnet>.ts.net:7357`, with a real HTTPS certificate:

```bash
pnpm server --tailscale                                  # every device on your tailnet
pnpm server --tailscale --tailscale-allow tag:laptops    # only you, this computer, and devices with that tag
```

- **Who gets in.** Tailscale Serve forwards to a second listener on 127.0.0.1 (`--port` + 2), and
  every connection, file and sign-in redirect there is looked up with `tailscale whois`. Without
  `--tailscale-allow`, every device on the tailnet gets in (so do devices shared into it: anyone who
  reaches it can run commands as you). With it, only the device's owner, this computer, and what it
  names: a login (`you@example.com`), a tag (`tag:laptops`), or a device (`phone`); the daemon logs
  who it refused and how to let them in. Funnel's public traffic, and anything that didn't come
  through Serve, is always refused.
- **Setting up.** Top runs `tailscale serve --bg --https=7357` itself and turns it off when it stops.
  It won't take over a port that serves something else (`--tailscale-port N` picks another) or one
  with Funnel on. It needs HTTPS certificates on for the tailnet (admin console → DNS) and, on Linux,
  permission to change Serve: `sudo tailscale set --operator=$USER` once. It says so when it can't.
- **In the app.** Settings → **Daemon** shows which daemon the app is connected to, lets you change
  it, and lists the Top daemons on your tailnet's online devices (the desktop app asks the local
  Tailscale). Connected over the tailnet, it says who Tailscale says you are. Connected locally, it
  shows the tailnet address to give your phone.
- **MCP sign-in** redirects to the daemon's tailnet address, which passes it to the daemon, so you
  can finish signing in from any device it lets in, not only its own computer.

### Files

Each bot has a files folder, `~/bots/<name>/files` (fake bots: in the data folder), for what it makes
for you: pages, reports, charts, images, notes. The bot is told about it. The **Files** button in the
header opens it beside the conversation: newest first, and the file you pick rendered.

- **What renders.** HTML pages (their scripts run, and they may load libraries from a CDN), Markdown
  with Mermaid diagrams, images, PDFs, audio, video, CSV/TSV as tables, and code and text with
  highlighting. A folder with an `index.html` is a site: its pages link to each other.
- **Hand it on.** Each file has **Copy path** (on the daemon's computer, for an agent there, which can
  read and edit it) and **Copy link** / **Open in browser**. The link uses the address the app reaches
  the daemon at, so it works over Tailscale or a tunnel too: the daemon serves files on its own port,
  at `/files/<secret>/<bot>/<path>`.
- **Changes show in the conversation.** Anything that changes the folder (the bot's tools, a script it
  runs, you in your editor) adds a line under the bot's turn naming the files, each a click away. The
  model never sees these lines. Changes made while the daemon was down show when it starts.
- **Safety.** Browsers let any web page reach localhost, so links carry a secret no page can guess
  (made once per data folder, so links keep working across restarts), and pages never pass it on as a
  referrer. A bot's page runs with the daemon's address as its origin, which the WebSocket refuses, so
  it can't reach the daemon's controls; in the app it runs in a sandboxed frame that can't touch the
  app or navigate the window. Hidden files (`.env`, `.git`) aren't listed or served.

### MCP servers

Settings → **MCP servers** keeps every MCP connection in one place, on the daemon, and each bot gets
only the ones you switch on for it (a new bot has none). A server is either a **URL** (Streamable
HTTP) or a **command** the daemon runs (stdio, e.g. `npx -y @modelcontextprotocol/server-github`), with
headers or environment variables for keys. Their values stay on the daemon: the app shows only the names.

- **The same server twice** is two connections, each with its own credentials: add "GitHub (work)" and
  "GitHub (personal)" and give each bot the account it should use. A server's tools are named after it
  (`github_work__create_issue`), so a bot with both never mixes them up.
- **Sign-in.** A URL without an `Authorization` header signs in with OAuth when the server asks: press
  **Sign in**, and the browser comes back to the daemon on port `--port` + 1 (7358). That redirect goes
  to 127.0.0.1, so finish it on the daemon's computer (or, with `--tailscale`, on any device it lets in). To switch accounts, Edit → **Sign out**. With
  two connections to one service, the browser may pick the account it's already signed in to; switch it
  in the browser first.
- **When tools change.** A bot picks up servers given to it, removed, or newly connected from its next
  message. One connection serves every bot that has it; a server that fails is retried (2 s up to every
  5 min), or right away with **Retry**.
- **Crash safety.** A cut-off call to a tool the server marks read-only or idempotent runs again;
  any other is reported as interrupted, like `bash`. So is one whose server hasn't reconnected yet when
  the daemon restarts.

**Collar** is Top's own set of tools for managing the app. Every bot always has it, it isn't
listed among the servers, and no server may be named "Collar". Its tools are named like a server's
(`collar__<tool>`) but run inside the daemon. It has no tools yet.

## Crash safety

The bots' tools do real things, so a restart must never run one twice by accident. Every step is
saved in SQLite (`synchronous=FULL`) before the next one starts:

1. A message you send is stored in the inbox before the daemon confirms it. It moves into the
   transcript in one transaction when the model takes it, so it is never lost or doubled.
2. An answer is saved when it ends. pi-agent-core waits for that before it starts any tool.
3. A tool call is recorded right before the tool runs, and its result is saved the moment it returns.

After a crash, a tool call without a result is settled by the tool's own policy:

| Tool says | What happens | Example |
|---|---|---|
| nothing (default) | The model is told it was interrupted and may have taken effect. Not run again. | `deploy` |
| `recover()` | The tool checks its outcome by `ctx.key` (stable per call, also across restarts) and reports what really happened. | `send_email` |
| `replay: "safe"` | It runs again. | `check_status` |
| (never started) | The model is told it did not run. | |

A task that keeps killing the daemon is ended after 3 restarts instead of looping. Stop is final: no
tool or model request starts after it. A failed model request is retried after 1, 4 and 15 s; only
the final failure shows.

`pnpm test` kills the daemon with SIGKILL at each of these moments and counts the tools' real side
effects afterwards.

## Sync

- **Entries are finished and never change.** Each has a sequence number from one counter shared by all
  bots. A client says which it has (`after`) and gets only the ones it is missing, then each new one
  once. Missed more than 50? It gets the newest 50 and a gap that loads when scrolled into view.
- **The client sees what it shows, not what the model saw.** No usage counters or provider metadata;
  tool output is cut to a preview, and `detail` fetches one entry in full when it's opened.
- **The sidebar gets one small frame per bot that changed**, coalesced per 100 ms.
- **Compressed.** permessage-deflate with context takeover, so repeated keys cost almost nothing.
- **Pings are sparse** (10 s, dead after 25 s). When the app returns to the foreground or the network
  changes, `kick()` checks the socket right away instead.
- **Sends are optimistic and idempotent.** A message shows as pending at once, survives a drop, and is
  resent with the same `requestId`; the daemon applies it once.
- **A cache belongs to one daemon's data.** The daemon has a permanent id; the client names the one its
  entries came from in `hello`. Point the app at different data on the same address and it drops what
  it held, instead of mixing two histories whose sequence numbers overlap.
- **Cold start doesn't wait for the network.** Each bot's newest 200 entries are cached locally and
  shown as stale until the daemon answers, and the reconnect asks only for what's newer.

## Data use

`pnpm wire` measures the real client's TCP bytes against a loaded daemon (5 bots answering
nonstop at 100 tokens/s). Before = the Pi Durable version with streaming:

| Scenario | Before | After, no compression | After |
|---|---|---|---|
| Phone: following the open bot | 473 KB/min, 27.8 KB/answer | 59 KB/min, 3.1 KB/answer | 11 KB/min, 0.6 KB/answer |
| Desktop: following all 5 bots | 769 KB/min, 8.9 KB/answer | 155 KB/min, 1.8 KB/answer | 31 KB/min, 0.4 KB/answer |
| Open the 10,000-message bot, no cache | 40.6 KB | 29.9 KB | 7.9 KB |
| Come back after 30 s away, with cache | 16.5 KB | 11.4 KB | 4.0 KB |
| Connected, nothing happening | 1.4 KB/min | 0.4 KB/min | 0.2 KB/min |

The fake answers draw from a ~70-word vocabulary and compress better than real text, so expect real
numbers between the last two columns.

## The UX bar

`pnpm bench` builds the app, starts a loaded daemon, drives Electron with real input events, and
kills the daemon with `kill -9` partway through. Same machine, same run conditions (Linux, Xvfb,
software rendering), before → after:

| Check | Before | After | Bar |
|---|---|---|---|
| Cold start → content, empty cache / cached | 763 / 533 ms | 593 / 516 ms | < 1 s |
| Keystroke → frame, p50 / p99, bots working | 11.2 / 22.1 ms ✘ | 11.7 / 20.3 ms | next 60 Hz frame |
| Keystrokes that missed the next frame | 2 / 144 ✘ | 0 / 144 | < 1% |
| Scrolling a 10,000-message transcript | 59.9 fps, 1 frame > 33 ms ✘ | 60 fps, 0 frames > 33 ms | steady 60 fps |
| `kill -9` daemon | stale banner, transcript kept | stale banner, transcript kept | no blank screen |
| Reconnect after the daemon is back | 209 ms | 358 ms | < 1 s |
| Message sent while the daemon was down | accepted 209 ms after restart, 1 copy | accepted 411 ms after restart, 1 copy | lands once |

Reconnect time depends mostly on where the client's retry backoff is when the daemon comes back.

## Not done yet

- Compaction: long-running bots will outgrow the model's context window. Pi Durable did this; it
  needs writing (or borrowing from pi's coding agent).
- Push notifications when an answer lands, so the phone needn't stay connected.
- The React Native app; a bigger local cache (IndexedDB / SQLite) there.
- Choosing a model per bot, renaming bots and editing their descriptions.
- MCP resources and prompts (only tools so far), and signing in to an MCP server from the phone.
- Login and device pairing for the daemon itself.
