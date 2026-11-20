# Top

A fast, never-drops client for your bots. One daemon runs the bots 24/7, and desktop and phone
clients attach to it and detach whenever they like. Nothing streams: answers arrive whole, tool calls
show as steps, and the app says what each bot is doing while it does it.

```
┌──────────── Top daemon (apps/server) ────────────┐        ┌── desktop (apps/desktop, Electron) ──┐
│ one agent loop per bot (loop.ts), pi-ai models   │  WS    │ @top/client                           │
│ SQLite: entries · inbox · tool_calls · bots      │◄──────►│  entries after `seq`, gaps, paging    │
│ every step saved before the next one starts      │ deflate│  optimistic sends, requestId resend   │
└──────────────────────────────────────────────────┘        └── phone (React Native, next) ─────────┘
```

| Package | What it is |
|---|---|
| `packages/protocol` | Wire frames (JSON over one compressed WebSocket), as Effect schemas: the types derive from them, and both ends check every frame that arrives. Also the daemon's refusals, as tagged errors. |
| `packages/client` | `@top/client`: connection, reconnect, catch-up by sequence number, history paging, optimistic sends. Framework-free, so it's shared by desktop and mobile: Effect inside, snapshots and Promises outside. |
| `apps/server` | The daemon, as Effect services: storage (`store.ts`, Effect SQL on `node:sqlite`), one runner per bot (`runner.ts`) on Top's own agent loop (`loop.ts`), tools and their crash policies (`tools.ts`), the event bus (`events.ts`), the HTTP and WebSocket layer (`serve.ts`). |
| `apps/desktop` | Electron + React, its state in Effect atoms. Virtualized transcript, performance overlay, benchmark. |

Everything but the React components runs on [Effect](https://effect.website) 4. The daemon is a set of
services composed as Layers (`main.ts`) and closed in reverse order when it stops. The agent loop is
Top's own, an Effect: Stop is checked before every model request and tool call, and stopping the daemon
interrupts it, so nothing more is saved. pi still talks to the models (`pi-ai`), signs in, and provides
the coding tools; where it calls in (tools, credentials) the interfaces stay Promise-based, and run
Effects inside. The wire format is Top's own: Effect RPC's socket protocol answers every streamed frame with an
acknowledgement, which would cost about a fifth more data while following bots (see Data use).

## Run it

```bash
pnpm install
pnpm server          # the daemon, with one bot (Atlas) on a real model (openai/gpt-6.1-sol)
pnpm desktop         # Electron app (or `pnpm web` for the same UI in a browser at :5199)
```

Before committing: `pnpm check` (Biome: lint, format, import order; `pnpm fix` applies the safe fixes),
`pnpm typecheck` (TypeScript 7 with Effect's diagnostics, through `effect-tsgo`) and `pnpm test` (vitest).

The bots use your ChatGPT plan through Sign in with ChatGPT, OpenAI's sign-in for open-source and local
agents. The daemon starts signed out. Sign in from the app (**Continue with ChatGPT** under the
composer, or in Settings) or with `pnpm login` (`top login`; `top logout` signs out). Top signs in
under its own name and keeps the tokens in `~/.top/server/auth.json`. It doesn't borrow pi's or the
Codex CLI's sign-in: OpenAI's terms don't allow that. The browser comes back to `127.0.0.1:1455`. On
the daemon's computer that finishes the sign-in by itself. From another device, paste the address
that page ended on into the app (or into `top login` over SSH). Before signing in, you agree that the
bots use your plan in the background too (wake-ups, background jobs), as OpenAI's terms require. Top
is for one person: on the tailnet, let in only your own devices, because other people's messages
would run on your plan, which the terms forbid. An API key in the environment (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, …) works too, and is the only way for providers other than OpenAI. Pick another model with
`pnpm server --model anthropic/claude-opus-5-5`; `--thinking off|low|medium|high` sets reasoning
(default medium). ChatGPT sign-ins can't use every model (`gpt-5.5` is refused); `gpt-6.1-sol` works.
Each real bot owns a folder, `~/.top/bots/<name>`, and works from it: commands start there and relative paths resolve there. Its tools are pi's coding
tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) with full access to the computer, as the
user running the daemon. After a crash, `read`/`ls`/`grep`/`find`/`write` run again; a cut-off `bash`
or `edit` is reported as interrupted, never re-run.

Everything Top keeps is in its home, `~/.top` (`TOP_HOME=DIR` or `--home DIR` moves it):

```
~/.top/
├── server/        the daemon's: top.sqlite (bots, conversations, MCP servers and their sign-ins), attachments/, secrets/, auth.json, chatgpt-host.json
├── skills/        the shared skill library (see Skills)
├── bots/<name>/   each bot's working folder: SOUL.md, AGENTS.md, USER.md, MEMORY.md (see Identity and memory); files/ is what the Files panel shows, .agents/skills/ its own skills
├── daemon/        the installed daemon (`top install`, see Releases and updates)
└── desktop/       the desktop app's profile: its cache and settings (TOP_USER_DATA moves it)
```

`--reset` clears `server/` and leaves the bots' folders, which are their work.

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
or any MCP tool by its full name: `call github_work__search {"query": "top"}`. "Search the web for …" plays OpenAI's
web search (see Web search) once it's switched on for the bot; "… fails" and "… refused" play a failed search and OpenAI
refusing it. "Ask permission to …", "ask me which", "ask me to pick", "ask me what" and "ask me for a token" play the
cards in Questions and secrets.
Their home is `apps/server/.data/fake`, laid out like `~/.top` (a reset clears their folders too). Daemon flags: `--model`, `--thinking`, `--allow-origin`, `--port`, `--host`,
`--home`, `--reset`, `--no-compress`, `--tailscale`, `--tailscale-allow`, `--tailscale-port`; fake only: `--load`, `--tools` (load includes tool calls),
`--seed N`, `--tps N`.

Real mode starts with one bot, Atlas. Make more with the **+** beside "Bots" (a name, an icon
drawn from the name, with more to shuffle through, and a description that starts its SOUL.md);
hover over a bot to delete it. Deleting
erases its conversation everywhere; files in its folder stay, and a new bot can't take that
folder over while its SOUL.md, AGENTS.md, USER.md or MEMORY.md are still there.

Attach files with the paperclip, by pasting, or by dropping them on the conversation. They upload as
soon as they're added. Images are shrunk to 2000 px on their long side first, and a paste over 32 KB
becomes a text file (`Ctrl+Shift+V` pastes it inline). The bot gets each file's path to open with its
tools, and PNG, JPEG, GIF and WebP images as images too. They're kept in `~/.top/server/attachments`: an
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

### Identity and memory

Each bot has four Markdown files in its folder (`~/.top/bots/<name>/`), and they are what it is:
`SOUL.md` (who it is: a `# Heading` on its first line is its name in the app, the paragraph under it the line
under its name), `AGENTS.md` (how it works), `USER.md` (what it knows about you) and `MEMORY.md`
(what it has learned). The files are the only copy: Settings → **Identity and memory** edits them
in place, and the bot edits them with its tools, unasked, when it learns something that will
matter later. A save from Settings is refused when the file changed since it was opened (by the
bot, say), unless you choose to replace it. Saves from different clients take turns, so two saves
of the same version can't both win; a write by the bot or an editor landing in the same instant as
a save can still be replaced by it. When Top creates a file (a new bot's SOUL.md, or a first save
from Settings) it uses a hard link or an exclusive create, which never replace a file made
meanwhile.

- **Loading.** Each file goes into the bot's instructions whole, between `<file … id="…">` and
  `</file id="…">` lines whose id is a hash of its text, so nothing in a file can end its frame
  early; its path is escaped. The files come after Top's own instructions, which tell the bot
  where they are, how to keep them and that they never
  override Top's rules (safety, permissions, tools), and that text from web pages or tool output is
  information, not instructions. Missing or empty files aren't sent. Each file is at most 8 KB
  (`MAX_CONTEXT_FILE_BYTES`): a longer one, or one that can't be read, is sent as a note saying so
  and why, never cut short, and Settings shows the same.
- **Changes reach the bot from its next message**, a follow-up queued meanwhile included, never in
  the middle of a task. Top compares the files with what the conversation already has and, for
  each file that differs, saves the whole new version as a system message after the conversation so
  far; it replaces the earlier one (deleted: a note that it's gone). Nothing before it is
  rewritten, so the cached prefix stays: OpenAI and Anthropic get it in place (a developer or
  system message; Anthropic's lands after the next user message), and providers that can't take
  system messages mid-conversation rebuild their system prompt, which changes the prefix there.
  Same text, no update; A → B → A sends A again. Updates never show in the conversation.
- **Restarts** replay the conversation as saved, never rebuilt from the files as they are now; a
  change made while the daemon was down arrives as an update with the next message.
- **Compaction** folds the instructions and every update before the cut into one fresh baseline
  holding the latest version of each file, and the versions it replaced drop out of the context.
  The messages themselves stay in the history.
- **From older versions** (migration 6): each bot's name and description move into its SOUL.md
  (`# Name`, then the description) the first time the new daemon starts. A SOUL.md already there
  is kept, with the description added at its end if it isn't in it (unless that would take it
  over 8 KB: then it waits, logged, until there's room); this happens at startup, before any bot
  or app runs. The text stays in the database until the
  file is written, so a failure or crash midway loses nothing and the next start
  finishes it. Conversations carry on where they were: the files arrive as an update with the next
  message, and the bot is told SOUL.md's name and purpose replace any given earlier.
- **The folder keeps the name the bot was made with**, whatever SOUL.md calls it; without a
  heading, that's its name in the app too. A new bot can't take a name a bot already has, in the
  app or as its folder.

### Files

Each bot has a files folder, `~/.top/bots/<name>/files` (fake bots: in their home), for what it makes
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
  (made once per home, so links keep working across restarts), and pages never pass it on as a
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

### Skills

Skills are [AgentSkills](https://agentskills.io) folders: `<name>/SKILL.md` (frontmatter with a `name`
and a `description`, then instructions), with any scripts, references and assets beside it. Top reads
them where they are and never copies, changes or updates one. Settings → **Skills** lists what it
found and which bots have which; a new bot has none, however many are installed.

- **Where.** Shared skills are in Top's home, `~/.top/skills` (fake bots: in their home). Every bot a
  shared skill is switched on for uses the same files, so a change to one, by you or by a bot with its
  tools, reaches all of them. A bot's own skills are in its folder, `.agents/skills`. Nothing else is
  read: not `~/.claude/skills`, not a project's.
- **Same name.** A bot's own skill takes the place of the shared one with its name, for that bot only.
  Settings shows both, which one each bot uses, and why one that's broken can't be used (a folder name
  that isn't a skill name, a frontmatter `name` that isn't the folder's, no description, bad YAML, a
  dangling link). A broken skill can't be switched on and never stops the others loading. Folders may
  be links to skills kept elsewhere.
- **Adding a folder of them.** **Add from folder** takes a folder on the daemon's computer: a
  collection of skill folders (a cloned repository's `skills/`, say) or one skill's folder. It shows
  what it found first, then links each new, usable skill into the shared library (`~/.top/skills/<name>`
  → the skill's folder), so the files stay where they are, unchanged, and pulling the repository
  updates them. It never replaces anything: a name the library already has stays as it is, and a
  broken skill is left out, each with the reason. Nothing in the folder is run. It can switch the
  skills on for the bots you pick, except where a bot has its own skill by that name. Adding the same
  folder again links only what's new.
- **Collections.** Shared skills linked in from one folder show as one row, with a chip per bot that
  switches all of them on or off (`3 of 57` when some are), and **One by one** to list them.
- **What the bot gets.** The skills switched on for it are listed in its instructions (name,
  description, where SKILL.md is), read again before it starts on a new message, so a change shows from
  its next task. It reads a skill's SKILL.md with its tools when a task matches. Paths in a skill are
  relative to its folder, and the bot is told so: it runs a skill's scripts by their full path or from
  the skill's folder. A skill whose frontmatter sets `disable-model-invocation` (to anything but
  `false`) isn't listed: the bot gets it only when you ask for it, and Settings marks it **Only when
  asked**.
- **Asking for one.** Start a message with `/<name>` (type `/` to pick from the bot's skills, those only
  for asking included): the skill's SKILL.md, as it is then, goes with the message, and the message
  shows which skill it used.
- **Rescan** reads the folders again after you add or edit a skill; opening Settings does too.

### Web search

On an OpenAI model (the Responses API, signed in with ChatGPT or with an API key), a bot can search the web with
OpenAI's own web search. Settings → **Web search** switches it on per bot (a bot has it off until then); it reaches the
bot from its next message. No search key or other provider is involved, and nothing is fetched by Top itself.

- **OpenAI runs it**, inside the model request (`store: false`, `stream: true`, on `api.openai.com/v1/responses`). It
  isn't one of the bot's tools: it has no tool step, no crash policy, and nothing is run again after a restart. While it
  searches, the bot says **Searching the web**.
- **What it did stays with the answer**: the searches (with the pages OpenAI says it looked at, loaded when you open the
  line), pages it opened, and the pages the answer cites, as **Sources** under it. Only http(s) addresses become links,
  and they open outside the app. A failed search shows as failed; nothing is listed that OpenAI didn't report.
- **Whether you may use it is OpenAI's call.** Sign in with ChatGPT doesn't promise it: OpenAI says web search there
  "remains subject to model and account/workspace policy", and no model list says which models have it. When OpenAI
  refuses it, the answer fails and says so, with what OpenAI said, and isn't retried; switch it off for that bot to
  carry on. Top never quietly answers without it.
- **Pages are evidence, not instructions.** A bot that may search is told not to follow directions found on the web.
  Earlier searches go back to OpenAI with the conversation (each request carries it whole), as OpenAI sent them.

### Questions and secrets

A bot asks you things on cards in its conversation, with three Collar tools. It never waits on one: it carries on or
ends its turn, and your answer comes to it as a message, even when it's idle. The card shows wherever you open the
bot, the first answer from any device wins, and a waiting card outlives a restart. Stop withdraws a bot's waiting
cards (no answer reaches it); deleting the bot removes them.

- **Permission** (`ask_permission`): Allow or Deny. Nothing enforces it; the bot is told to respect it.
- **Question** (`ask_question`): a question, with up to 6 options to pick (one, or several when the bot allows it)
  and a field to write your own answer (unless the bot left it out), or Skip. An answer is information, never a
  permission: it can't settle a permission card, and the bot is told to ask with `ask_permission` for that.
- **Secret** (`request_secret`): one password, token or key (one line, at least 4 characters), with what it's for
  and, if the bot gives one, a link to the page where you make it. Save sends it to the daemon, which writes it to a
  file of its own in `server/secrets/` (owner-only, `0600` in a `0700` folder) and tells the bot only the path. The
  bot is told to hand it to the command that needs it from the file, standard input or an environment variable the
  program reads itself, never as a command argument, which other users of the computer can read. The value never goes into the
  conversation, the database, the logs or the bot's context. Top replaces it with `[secret hidden by Top]` in
  everything a tool returns (its output, details, progress and errors; a command's output is cleaned as it streams,
  before pi shows it, keeps it or writes the full output of a long command to a temp file),
  as is and URL- or JSON-encoded, so a command that prints it doesn't hand it to the model. That holds while the file
  lives and, for values of 8 characters or more, until the daemon restarts, since a command may have copied it
  somewhere. It's protection against accidents, not against a bot set on getting it: part of the value, or the value
  transformed (base64, reversed), isn't recognised.
  The file is deleted an hour after you saved it, when the bot is deleted, or at the next start once that hour has
  passed; after that the bot asks again. Stop withdraws a waiting card but leaves a saved file to its hour. Decline
  tells the bot to go on without it and not to ask another way. The file keeps it from other users on the computer,
  not from the bot's own commands or other bots: they all run as you, with full access (see Run it).

Cards from other MCP servers don't reach Top. T3 Code's `request_secret`, for one, opens its card in a T3 Code thread
and only works for an agent running in one, and its secret references only work in T3 Code's own tools. Top doesn't
offer MCP elicitation either, so a server can't put up a form of its own; a bot uses these tools instead.

**Collar** is Top's own set of tools for managing the app. Every bot always has it, it isn't
listed among the servers, and no server may be named "Collar". Its tools are named like a server's
(`collar__<tool>`) but run inside the daemon: wake-ups, background jobs, the cards in Questions and secrets, and
coding tasks.

### Coding tasks

A bot can hand coding work to a full coding agent on the daemon's computer: **Claude Code** (driven
through the official Claude Agent SDK) or **Codex** (through `codex app-server`, its official JSON-RPC
protocol). Each harness runs its own agent loop and tools; Top coordinates the work, keeps it durable
and puts its questions in front of the bot and the user. The harness, the model and where it runs are
separate things: a task names a harness, may name a model in that harness's terms, and runs locally,
or on another computer through **T3 Code** (below).

**The tools** (Collar, so `collar__task_start` and so on):

| Tool | What it does |
|---|---|
| `task_start` | Starts a task: `harness`, `prompt`, optional `cwd`, `model`, `options` (checked against the harness), `images`, `title`. Returns at once with a task id. `session` continues an earlier session in a new task; `fork: true` branches it. |
| `task_read` | State, result (12,000 characters at a time, `result_from` for the next part), waiting requests and the event log after a cursor (`after`, `limit` ≤ 200, at most ~24 KB per read). Without `id`: the bot's recent tasks and sessions. |
| `task_send` | More work for a running task, `mode` required: `steer` goes into the running turn (fails if none runs), `queue` runs as the next turn. An ended task takes none: continue its session instead. |
| `task_respond` | Answers one waiting request by number. First answer wins; a second is refused. |
| `task_wait` | Waits until the task ends or needs input (`until: "end"` waits through input), up to 30 min; says `"timedOut":true` otherwise. Rarely needed: see below. |
| `task_cancel` | Interrupts the running turn, withdraws its requests, drops queued messages. The session stays. A task that already ended stays as it ended. |

**Tasks and sessions.** A task is one piece of work: its prompt, any queued follow-ups, and an
outcome. A session is the harness's own conversation (Claude Code's session id, Codex's thread id),
kept with the folder and model it was made with; later tasks can carry it on, one task at a
time. Tasks and sessions belong to the bot that made them.

**States:** `queued` (waiting for one of `TOP_MAX_TASKS` slots, default 4) →
`starting` → `running` ⇄ `waiting_for_input` → `completed`, `failed` or `cancelled`. Every change is
saved before it's announced. A task keeps its slot while it waits for input. A cancel that arrives
as the turn completes leaves it completed, with its answer. The bot gets one message when a task ends, and one when the harness asks
it a question, even while idle, so it never polls; a `task_wait` that's waiting gets the news instead.
The app hears nothing of a task's progress: only which tasks have questions waiting, when that
changes. Harness processes are the daemon's children, their output goes to a bounded event log (2 KB an event, the newest 1,000 kept,
written in batches every 250 ms), and the result is kept up to 30,000 characters.

**Full access.** A harness runs as the user running the daemon, with everything that user can do:
Codex with `danger-full-access` and approvals off, Claude Code with its permission checks off
(`bypassPermissions`). There is no sandbox and no approval prompt, and `cwd`, any folder the daemon
can reach (default: the bot's own), is where it starts, not a limit. A bot can already run commands
as that user, so a harness adds no new power, but it acts on its own for as long as the task runs:
start tasks only for work you'd let the bot do. Limiting harnesses (sandboxes, approval cards) is
left for later. If a harness asks for an approval anyway (Claude Code still asks about removals of
critical paths such as `rm -rf ~`, rules set to "ask" and tools an organization set to ask), Top
declines it at once and the task's log says so, so nothing waits on a card that doesn't exist. Claude Code loads its own settings and the
folder's CLAUDE.md as it does when you run it; it won't run with its checks off as root, so the
daemon must run as a normal user.

**In the conversation.** Where a bot starts a new session (or branches one), the conversation keeps
a card that says an agent was spawned, with the harness, folder and model it started with. It never
changes after: no state, no progress, no controls; the bot tells the user what came of it. Carrying a
session on adds no second card.

**Questions.** When Claude Code asks a question (AskUserQuestion), it goes to both the bot (as a
message) and the user (on a card at the end of the conversation, until it's answered), and whoever
answers first wins. Codex's default mode doesn't ask questions, and Top doesn't turn that on. A
harness's question lives on the task (`task_respond`, its card), apart from the bot's own Permission,
Question and Secret cards; it never asks for a secret or an approval (T3 Code's own secret requests
stay in T3 Code).

**Credentials.** Harnesses use their own sign-in: the model-provider keys the daemon's bots use
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, the AWS keys for Bedrock and the rest of pi's list) aren't
passed to them; other variables, a project's own keys among them, are. Text that looks like a key is
redacted from the event log and results.

**Restarts.** Nothing is started twice. A task that hadn't started yet (queued) carries on after a restart. One that had started fails as cut off, saying it
may have made some of its changes, with its session kept to carry on, and the bot is told. A harness
process that dies mid-task fails that task the same way. A turn's start is never assumed to have
happened without the harness saying so (a Claude Code session counts once it has said it started).
An end whose message to the bot was lost in a crash is sent at the next start. T3 Code is the
exception that proves it: its work runs in T3 Code's server, not under the daemon, so a task there keeps
going through a restart and Top follows it again (see below).

**What each harness supports.** Unsupported features are refused with an error, never imitated.

| | Claude Code | Codex | T3 Code |
|---|---|---|---|
| Continue a session / branch it | ✓ / ✓ | ✓ / ✓ | ✓ (same thread) / ✗ |
| Steer the running turn / queue the next | ✓ (`priority: next`) / ✓ | ✓ (`turn/steer`) / ✓ (Top's queue) | ✓ (`steer_active`) / ✓ (Top's queue) |
| Questions | ✓ (AskUserQuestion) | ✗ (off in Codex's default mode; never enabled by Top) | ✓ (its providers' questions) |
| Permissions | checks off (`bypassPermissions`) | `danger-full-access`, approvals `never` | threads start in `full-access`; approvals declined |
| Images with the prompt | ✓ | ✓ (`localImage`) | ✗ |
| Changed files / usage | ✓ / ✓ tokens and cost | ✓ / ✓ tokens | ✓ / ✗ |
| Cancel / pick a session up in a new process | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ |
| Keeps working through a Top restart | ✗ (cut off) | ✗ (cut off) | ✓ (followed again) |
| MCP servers' requests for input | not relayed | declined, and logged | answered in T3 Code only |
| Options | `effort`, `max_turns` | `reasoning_effort` | `provider` (a T3 Code provider instance) |

**Setting up.** Top uses the `claude` and `codex` already installed and signed in on the daemon's
computer (`TOP_CLAUDE_PATH` and `TOP_CODEX_PATH` point elsewhere), and never signs them in, out, or
changes their settings. Settings an organization manages on the computer still apply, as they do
for the user. Missing or signed-out harnesses fail the task with what to do. Fake bots get
a fake harness instead: message one `call collar__task_start {"harness": "fake", "prompt": "a question"}`;
"fail", "crash" or "forever" in the prompt play the other cases.
`TOP_REAL_HARNESS=codex pnpm --filter @top/server test test/real-harness.test.ts` runs one real
harness end to end in a temporary folder (it uses your plan).

#### T3 Code

The `t3code` harness hands a task to a [T3 Code](https://github.com/pingdotgg/t3code) server, on this
computer or another one, through T3 Code's own client API: its HTTP auth routes and the WebSocket RPC
its apps use (orchestration protocol 2). Top doesn't use T3 Code's `/mcp` endpoint, T3 Connect or any
cloud relay. A task becomes a thread in a T3 Code project, run by one of T3 Code's providers; the
work, the files and the provider sign-ins are all on T3 Code's computer.

- **Connecting.** `top t3code connect <address>` on the daemon's computer. The address is explicit
  (Top never guesses one) and is checked to answer as T3 Code before anything secret is sent. It then
  asks for a pairing code, read without echo (or from stdin): make one on T3 Code's computer with
  `t3 auth pairing create --scope orchestration:read --scope orchestration:operate --label Top`, or
  take a pairing link from T3 Code's Settings → Sharing & access. Top trades the code for its own
  session, narrowed to those two scopes (reading threads and projects; starting, messaging,
  answering and stopping threads), and keeps it in `~/.top/server/t3code.json`, readable by you
  only. The session lasts 30 days; pair again for a new one. Top remembers the environment it paired with and won't send the credential to an address
  that now answers as another one. Restart the daemon to offer T3 Code to the bots;
  `top t3code status` checks the connection and lists T3 Code's providers, models and projects;
  `top t3code disconnect` forgets it (revoke the session in T3 Code's Sharing & access too).
- **Ways to reach it.** `http://127.0.0.1:3773` on the same computer. Over Tailscale, the address of
  T3 Code's Tailscale Serve route (`https://machine.tailnet.ts.net`, from `t3 serve --tailscale-serve`
  or `t3 pair --tailscale` there), or its tailnet address when T3 Code listens on the tailnet (`t3 serve
  --lan` or the background service's local-network choice), plain HTTP that WireGuard encrypts. Over
  SSH, a forward (`ssh -L 3773:127.0.0.1:3773 host`) and `http://127.0.0.1:3773`. Tailscale is only
  the transport: T3 Code's pairing still decides what Top may do. Plain HTTP to anything but this
  computer takes `--plain-http`, since Top can't tell a tailnet from another network by the address;
  redirects are never followed. HTTPS uses the system's certificate authorities
  (`NODE_EXTRA_CA_CERTS` adds your own). Top changes nothing about Tailscale, T3 Code or either
  computer's network settings.
- **Tasks.** `cwd` is a folder on T3 Code's computer and must be one of its projects (Top doesn't look
  at its own disk for it; with one project it's the default). `model` is a T3 Code model (`haiku` and
  other aliases work), `options.provider` its provider instance (`claudeAgent`, `codex`, …); without
  them, T3 Code's first ready provider and its default model. Threads start in T3 Code's
  `full-access` mode, as Top's other harnesses run; an approval it asks for anyway is declined and
  logged, and T3 Code may still refuse what its own policy doesn't allow. Questions come to the bot and
  the user as with Claude Code, and can be answered in T3 Code too. Secret and link requests can only
  be answered in T3 Code.
- **Durable and once only.** Each turn carries an id made from Top's task (T3 Code's command and
  message ids), so a request whose reply was lost is simply sent again, and T3 Code takes it once.
  When the connection drops, Top reconnects (for up to 10 minutes) and asks for the thread's events
  from where it left off. When Top restarts, a running task is followed again: what was already sent
  isn't sent twice, a finished run gives its answer, an answer Top saved before the restart is
  delivered, and a cancel Top had started is carried out (a turn it never sent stays unsent). A
  session stays with the T3 Code environment it started on: paired with another one later, Top
  refuses to carry it on there rather than start it again. An answer T3 Code refuses, or never
  confirms while it still waits, opens the request again, and `task_respond` says why; one answered
  in T3 Code first wins. Cancel stops only the task's own run (`run.interrupt`, or takes it out of the queue), never
  another thread; like T3 Code's own Stop, that also stops background work still running in the
  session's thread. A stop T3 Code doesn't confirm in time leaves the task cancelled with a note that it
  may still be running there. A run someone stops in T3 Code fails the task, saying so. An expired or
  revoked session fails the task with how to pair again.
- **Compatibility.** Tested against T3 Code `0.1.8-nightly.20261109.4429`; its upstream `main`
  (0.1.11 nightlies) speaks the same protocol. T3 Code's client API is the protocol of its own apps,
  not a published SDK, so it can change: Top checks the protocol version first and refuses a server
  that speaks another one, saying which side to update.

`TOP_REAL_T3=/path/to/t3 pnpm --filter @top/server test test/real-t3code.test.ts` boots an isolated T3
Code server (its own data folder, port and project) and drives it end to end with Claude Haiku (it uses
the Claude Code sign-in on this computer).

## Releases and updates

Top has two channels, each built from its own branch and published as [GitHub releases](https://github.com/Ponesicek/Top/releases),
for Linux x64 for now:

| Channel | Branch | Version | Release |
|---|---|---|---|
| Stable | `main` | `0.2.0`, from `package.json` | marked Latest |
| Nightly | `nightly` | `0.2.0-nightly.20261114.7`: the next stable version, the UTC date, the run number | a prerelease |

Work lands on `nightly`. To ship it, merge `nightly` into `main` and release Stable, then bump the
version on `nightly` to the next one. A hotfix goes on `main` (with a version bump) and is merged back.
Each release has the desktop app (`Top-<version>-x86_64.AppImage`), the daemon
(`top-daemon-<version>-linux-x64.tar.gz`, with the Node it runs on), the app's update feed
(`latest-linux.yml` or `nightly-linux.yml`) and `SHA256SUMS`.

**Making a release.** It's manual: Actions → **Release** → Run workflow, pick the channel (or
`gh workflow run release.yml -f channel=nightly`). It builds the channel's branch, whichever branch
it was started from, runs the checks and tests, and publishes. It refuses a version that's already
out: bump `package.json` on `main` before each Stable release. `pnpm build:daemon` and
`pnpm build:desktop` build the same files locally, in `release/`.

**Installing the daemon.** Unpack the archive and run `bin/top install`. It copies itself to
`~/.top/daemon/`, follows the channel it came from, and runs under systemd (`systemctl --user …top`,
logs in `journalctl --user -u top -f`; `loginctl enable-linger` keeps it running while you're logged
out). Its flags are in `~/.top/daemon/args`, one per line (default `--model openai/gpt-6.1-sol`;
`top install --tailscale` adds `--tailscale`). `pnpm server` from a checkout never updates itself.

**Updating.** The daemon and the app each follow a channel of their own, since one server serves
many devices; they check now and then, and when you press the update button (in the sidebar, beside
Settings) or **Check now** in Settings → **Updates**. A newer release turns that button into **Update**,
which updates the server and then the app; hovering or focusing it shows what's new and how the update
is going. Nothing installs until you press Update. When the app and the server follow different
channels, the button's card says so. (`?fakeUpdates=available` in `pnpm dev:fake` pretends there's an
update, to try it without one.)

- **The server** downloads the new version, checks it against `SHA256SUMS`, unpacks it beside the
  running one, backs up `top.sqlite`, and restarts on it. Bots stop where they are and pick their
  tasks back up after the restart, like after a crash (this restart doesn't count toward the limit of
  3). A version that fails to start twice before it has run 30 seconds is rolled back with the
  database as it was, and the app says so. Switching from Nightly to Stable never goes back: you stay
  on your nightly until a stable release is newer.
- **The app** (the AppImage) downloads the new AppImage, then quits and starts it. With both to
  update, the server goes first.
- **Older data.** The database has numbered migrations (`store.ts`). A version that finds data a
  newer version has migrated refuses to start and says so, instead of misreading it.

## Crash safety

The bots' tools do real things, so a restart must never run one twice by accident. Every step is
saved in SQLite (`synchronous=FULL`) before the next one starts:

1. A message you send is stored in the inbox before the daemon confirms it. It moves into the
   transcript in one transaction when the model takes it, so it is never lost or doubled.
2. An answer is saved when it ends, before any of its tools start: the loop waits for each save.
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
- Choosing a model per bot.
- MCP resources and prompts (only tools so far), and signing in to an MCP server from the phone.
- Login and device pairing for the daemon itself.
