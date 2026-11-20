import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { CHANNELS } from "./release.ts";

export * from "./errors.ts";
export * from "./release.ts";

export const PROTOCOL_VERSION = 9;
export const DEFAULT_PORT = 7357;

const Struct = Schema.Struct;
const List = Schema.Array;
const Optional = Schema.optionalKey;

export const BotId = Schema.Int;
export type BotId = typeof BotId.Type;
export const Seq = Schema.Int;
export type Seq = typeof Seq.Type;

export const BotStatus = Schema.Literals(["idle", "thinking", "tool", "retrying", "failed"]);
export type BotStatus = typeof BotStatus.Type;

export const BotSummary = Struct({
  id: BotId,
  name: Schema.String,
  description: Schema.String,
  avatar: Optional(Schema.Int),
  status: BotStatus,
  tool: Optional(Schema.String),
  searching: Optional(Schema.Literal(true)),
  since: Schema.Number,
  error: Optional(Schema.String),
  preview: Schema.String,
  queued: Schema.Int,
  background: Optional(Schema.Int),
  asks: Optional(Schema.Int),
  wakeAt: Optional(Schema.Number),
  lastSeq: Seq,
});
export type BotSummary = typeof BotSummary.Type;

export const ToolCallView = Struct({
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
});
export type ToolCallView = typeof ToolCallView.Type;

export const WebSearchStep = Struct({
  action: Schema.Literals(["search", "open_page", "find_in_page"]),
  queries: Optional(List(Schema.String)),
  url: Optional(Schema.String),
  pattern: Optional(Schema.String),
  failed: Optional(Schema.Literal(true)),
  sourceCount: Optional(Schema.Int),
  sources: Optional(List(Schema.String)),
});
export type WebSearchStep = typeof WebSearchStep.Type;

export const Citation = Struct({ url: Schema.String, title: Schema.String });
export type Citation = typeof Citation.Type;

export const ToolOutcome = Schema.Literals(["interrupted", "not_run", "recovered", "replayed", "stopped"]);
export type ToolOutcome = typeof ToolOutcome.Type;

export const Attachment = Struct({ id: Schema.String, name: Schema.String, mimeType: Schema.String, size: Schema.Int });
export type Attachment = typeof Attachment.Type;

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2000;
export const MODEL_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const isModelImage = (attachment: Pick<Attachment, "mimeType" | "size">) =>
  MODEL_IMAGE_TYPES.includes(attachment.mimeType) && attachment.size <= MAX_IMAGE_BYTES;

export const MAX_PERMISSION_ACTION = 500;
export const MAX_PERMISSION_REASON = 1_000;
export const MAX_QUESTION = 500;
export const MAX_QUESTION_DETAIL = 1_000;
export const MAX_QUESTION_OPTIONS = 6;
export const MAX_OPTION_LABEL = 100;
export const MAX_OPTION_DESCRIPTION = 300;
export const MAX_ANSWER_TEXT = 2_000;
export const MAX_SECRET_LABEL = 80;
export const MAX_SECRET_REASON = 500;
export const MAX_SECRET_PLACEHOLDER = 80;
export const MAX_SECRET_URL = 2_000;
export const MAX_SECRET_BYTES = 8 * 1024;

export const QuestionOption = Struct({ label: Schema.String, description: Optional(Schema.String) });
export type QuestionOption = typeof QuestionOption.Type;

export const PermissionAsk = Struct({ kind: Schema.Literal("permission"), id: Schema.Int, action: Schema.String, reason: Optional(Schema.String) });
export type PermissionAsk = typeof PermissionAsk.Type;
export const QuestionAsk = Struct({
  kind: Schema.Literal("question"),
  id: Schema.Int,
  question: Schema.String,
  detail: Optional(Schema.String),
  options: List(QuestionOption),
  multiple: Optional(Schema.Literal(true)),
  other: Optional(Schema.Literal(true)),
});
export type QuestionAsk = typeof QuestionAsk.Type;
export const SecretAsk = Struct({
  kind: Schema.Literal("secret"),
  id: Schema.Int,
  label: Schema.String,
  reason: Schema.String,
  placeholder: Optional(Schema.String),
  url: Optional(Schema.String),
});
export type SecretAsk = typeof SecretAsk.Type;

export const Ask = Schema.Union([PermissionAsk, QuestionAsk, SecretAsk]);
export type Ask = typeof Ask.Type;
export type AskKind = Ask["kind"];

export const WaitingAsk = Struct({ bot: BotId, ask: Ask });
export type WaitingAsk = typeof WaitingAsk.Type;

export const AskOutcome = Schema.Literals(["allowed", "denied", "answered", "saved", "declined", "withdrawn"]);
export type AskOutcome = typeof AskOutcome.Type;

export const QuestionReply = Struct({ choices: List(Schema.Int), text: Optional(Schema.String) });
export type QuestionReply = typeof QuestionReply.Type;

export const AskReply = Schema.Union([
  Struct({ kind: Schema.Literal("permission"), allow: Schema.Boolean }),
  Struct({ kind: Schema.Literal("question"), ...QuestionReply.fields }),
  Struct({ kind: Schema.Literal("decline") }),
]);
export type AskReply = typeof AskReply.Type;

export const TASK_STATES = ["queued", "starting", "running", "waiting_for_input", "completed", "failed", "cancelled"] as const;
export const TaskState = Schema.Literals(TASK_STATES);
export type TaskState = typeof TaskState.Type;
export const ENDED_TASK_STATES: readonly TaskState[] = ["completed", "failed", "cancelled"];
export const taskEnded = (state: TaskState) => ENDED_TASK_STATES.includes(state);

export const TaskQuestionOption = Struct({ label: Schema.String, description: Optional(Schema.String) });
export type TaskQuestionOption = typeof TaskQuestionOption.Type;

export const TaskQuestion = Struct({
  id: Schema.String,
  question: Schema.String,
  header: Optional(Schema.String),
  options: List(TaskQuestionOption),
  multiple: Optional(Schema.Literal(true)),
});
export type TaskQuestion = typeof TaskQuestion.Type;

export const TaskInputView = Struct({
  id: Schema.Int,
  title: Schema.String,
  questions: List(TaskQuestion),
});
export type TaskInputView = typeof TaskInputView.Type;

/** A task with questions waiting for an answer: all the app hears about running tasks. */
export const WaitingTask = Struct({
  id: Schema.String,
  bot: BotId,
  title: Schema.String,
  inputs: List(TaskInputView),
});
export type WaitingTask = typeof WaitingTask.Type;

/** What a bot's task_start leaves in its transcript when it starts a new session, fixed when it started. */
export const AgentSpawn = Struct({
  title: Optional(Schema.String),
  harness: Schema.String,
  cwd: Schema.String,
  model: Optional(Schema.String),
});
export type AgentSpawn = typeof AgentSpawn.Type;

export const TaskAnswers = Schema.Record(Schema.String, List(Schema.String));
export type TaskAnswers = typeof TaskAnswers.Type;

export const MAX_TASK_ANSWER = 4_000;

export const SkillSource = Schema.Literals(["shared", "local"]);
export type SkillSource = typeof SkillSource.Type;

export const SkillView = Struct({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  error: Optional(Schema.String),
  /** Its frontmatter says `disable-model-invocation: true`: the bot isn't told about it, and gets it only from `/<name>`. */
  manual: Optional(Schema.Literal(true)),
  /** Its folder is a link into this folder: a collection of skills kept elsewhere, such as a cloned repository. */
  linkedFrom: Optional(Schema.String),
});
export type SkillView = typeof SkillView.Type;

export const BotSkills = Struct({
  bot: BotId,
  folder: Schema.String,
  local: List(SkillView),
  enabled: List(Schema.String),
});
export type BotSkills = typeof BotSkills.Type;

export const SkillsView = Struct({
  library: Schema.String,
  shared: List(SkillView),
  bots: List(BotSkills),
});
export type SkillsView = typeof SkillsView.Type;

export const SkillUse = Struct({
  name: Schema.String,
  source: SkillSource,
  path: Schema.String,
  error: Optional(Schema.String),
});
export type SkillUse = typeof SkillUse.Type;

/** What adding a folder of skills would do with each one: link it, find it already linked, or leave it out and say why. */
export const SkillFolderEntry = Struct({
  skill: SkillView,
  state: Schema.Literals(["new", "added", "taken", "broken"]),
  reason: Optional(Schema.String),
});
export type SkillFolderEntry = typeof SkillFolderEntry.Type;

export const SkillFolder = Struct({ folder: Schema.String, skills: List(SkillFolderEntry) });
export type SkillFolder = typeof SkillFolder.Type;

export const SkillFolderAdded = Struct({
  folder: Schema.String,
  added: List(Schema.String),
  enabled: List(Struct({ bot: BotId, names: List(Schema.String) })),
  skipped: List(Struct({ name: Schema.String, reason: Schema.String })),
});
export type SkillFolderAdded = typeof SkillFolderAdded.Type;

export type ActiveSkill = SkillView & { readonly source: SkillSource };

export function activeSkills(view: SkillsView, bot: BotId): ActiveSkill[] {
  const mine = view.bots.find((b) => b.bot === bot);
  if (!mine) return [];
  return mine.enabled.flatMap((name): ActiveSkill[] => {
    const local = mine.local.find((s) => s.name === name);
    if (local) return [{ ...local, source: "local" }];
    const shared = view.shared.find((s) => s.name === name);
    return shared ? [{ ...shared, source: "shared" }] : [];
  });
}

export const CONTEXT_FILES = ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"] as const;
export const ContextFileName = Schema.Literals(CONTEXT_FILES);
export type ContextFileName = typeof ContextFileName.Type;
export const MAX_CONTEXT_FILE_BYTES = 8 * 1024;

export const ContextFileView = Struct({
  name: ContextFileName,
  path: Schema.String,
  content: Optional(Schema.String),
  version: Schema.String,
  error: Optional(Schema.String),
});
export type ContextFileView = typeof ContextFileView.Type;

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1_024;

export function skillInvocation(text: string): string | undefined {
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(text);
  return match && match[1]!.length <= MAX_SKILL_NAME ? match[1] : undefined;
}

const entryBase = { seq: Seq, bot: BotId, at: Schema.Number };

export const FileChange = Struct({ path: Schema.String, change: Schema.Literals(["added", "changed", "removed"]) });
export type FileChange = typeof FileChange.Type;

export const MessageSource = Schema.Literals(["wake", "job", "answer", "task"]);
export type MessageSource = typeof MessageSource.Type;

export const Entry = Schema.Union([
  Struct({
    ...entryBase,
    kind: Schema.Literal("user"),
    text: Schema.String,
    attachments: Optional(List(Attachment)),
    requestId: Optional(Schema.String),
    source: Optional(MessageSource),
    skill: Optional(SkillUse),
  }),
  Struct({
    ...entryBase,
    kind: Schema.Literal("assistant"),
    text: Schema.String,
    tools: Optional(List(ToolCallView)),
    searches: Optional(List(WebSearchStep)),
    citations: Optional(List(Citation)),
    hasThinking: Optional(Schema.Literal(true)),
    thinking: Optional(Schema.String),
    error: Optional(Schema.String),
    stopped: Optional(Schema.Literal(true)),
  }),
  Struct({
    ...entryBase,
    kind: Schema.Literal("tool"),
    toolCallId: Schema.String,
    name: Schema.String,
    text: Schema.String,
    truncated: Optional(Schema.Literal(true)),
    isError: Optional(Schema.Literal(true)),
    outcome: Optional(ToolOutcome),
    ask: Optional(Ask),
    agent: Optional(AgentSpawn),
  }),
  Struct({ ...entryBase, kind: Schema.Literal("answer"), request: Schema.Int, answer: AskOutcome, reply: Optional(QuestionReply) }),
  Struct({ ...entryBase, kind: Schema.Literal("notice"), text: Schema.String }),
  Struct({
    ...entryBase,
    kind: Schema.Literal("files"),
    files: List(FileChange),
  }),
]);
export type Entry = typeof Entry.Type;

export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);
export type WhenBusy = typeof WhenBusy.Type;

export const QueuedMessage = Struct({
  requestId: Schema.String,
  text: Schema.String,
  attachments: Optional(List(Attachment)),
  mode: Schema.Literals(["steer", "followUp"]),
  at: Schema.Number,
  source: Optional(MessageSource),
});
export type QueuedMessage = typeof QueuedMessage.Type;

export const Gap = Struct({ after: Seq, before: Seq });
export type Gap = typeof Gap.Type;

export const FileView = Struct({ path: Schema.String, size: Schema.Int, mtime: Schema.Number });
export type FileView = typeof FileView.Type;

export const MAX_FILES = 1_000;

export const Viewer = Struct({
  device: Schema.String,
  login: Optional(Schema.String),
  name: Optional(Schema.String),
  tags: Optional(List(Schema.String)),
});
export type Viewer = typeof Viewer.Type;

export const McpServerId = Schema.Int;
export type McpServerId = typeof McpServerId.Type;

export const McpSecret = Struct({ name: Schema.String, value: Optional(Schema.String) });
export type McpSecret = typeof McpSecret.Type;

export const McpServerConfig = Schema.Union([
  Struct({ transport: Schema.Literal("stdio"), command: Schema.String, args: List(Schema.String), env: List(McpSecret) }),
  Struct({ transport: Schema.Literal("http"), url: Schema.String, headers: List(McpSecret) }),
]);
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpServerState = Schema.Literals(["connecting", "ready", "signin", "failed"]);
export type McpServerState = typeof McpServerState.Type;

export const McpServerView = Struct({
  id: McpServerId,
  name: Schema.String,
  config: McpServerConfig,
  bots: List(BotId),
  state: McpServerState,
  error: Optional(Schema.String),
  tools: List(Schema.String),
  signedIn: Optional(Schema.Literal(true)),
});
export type McpServerView = typeof McpServerView.Type;

export const MAX_MCP_NAME = 40;

export const CHATGPT_REDIRECT = "http://127.0.0.1:1455/auth/callback";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
export const CHATGPT_BACKGROUND_NOTICE =
  "Your bots work on their own: they wake up when they set themselves to and finish background jobs, also while no app is open. Signed in with ChatGPT, that uses your ChatGPT plan too, within its usage limits. You can see and limit it in ChatGPT's settings.";

export const AccountView = Struct({
  model: Schema.String,
  signedIn: Optional(Schema.Literals(["chatgpt", "apiKey"])),
  canSignIn: Schema.Boolean,
  signingIn: Optional(Schema.String),
  error: Optional(Schema.String),
});
export type AccountView = typeof AccountView.Type;

export const Channel = Schema.Literals(CHANNELS);
export type Channel = typeof Channel.Type;

export const UpdateRelease = Struct({
  version: Schema.String,
  notes: List(Schema.String),
  url: Schema.String,
});
export type UpdateRelease = typeof UpdateRelease.Type;

export const UpdateView = Struct({
  channel: Channel,
  current: Schema.String,
  state: Schema.Literals(["idle", "checking", "downloading", "restarting", "failed"]),
  available: Optional(UpdateRelease),
  checkedAt: Optional(Schema.Number),
  error: Optional(Schema.String),
  rolledBack: Optional(Schema.String),
});
export type UpdateView = typeof UpdateView.Type;

export const T3CodeProvider = Struct({ id: Schema.String, status: Schema.String, models: List(Schema.String), defaultModel: Optional(Schema.String) });
export type T3CodeProvider = typeof T3CodeProvider.Type;

/**
 * Top's connection to T3 Code, checked as it's asked for. Without `url`, Top has none. With `error`, it can't use it now;
 * otherwise T3 Code answered, takes Top's session and listed what tasks can use. Never carries the credential.
 */
export const T3CodeView = Struct({
  url: Optional(Schema.String),
  label: Optional(Schema.String),
  connectedAt: Optional(Schema.String),
  serverVersion: Optional(Schema.String),
  expiresAt: Optional(Schema.String),
  providers: Optional(List(T3CodeProvider)),
  projects: Optional(List(Struct({ title: Schema.String, path: Schema.String }))),
  error: Optional(Schema.String),
});
export type T3CodeView = typeof T3CodeView.Type;

const req = Schema.Int;

export const ClientFrame = Schema.Union([
  Struct({
    t: Schema.Literal("hello"),
    clientId: Schema.String,
    protocol: Schema.Int,
    serverId: Optional(Schema.String),
  }),
  Struct({ t: Schema.Literal("watch"), bot: BotId, after: Optional(Seq), limit: Optional(Schema.Int) }),
  Struct({ t: Schema.Literal("unwatch"), bot: BotId }),
  Struct({ t: Schema.Literal("history"), req, bot: BotId, before: Seq, after: Optional(Seq), limit: Schema.Int }),
  Struct({ t: Schema.Literal("detail"), req, bot: BotId, seq: Seq }),
  Struct({
    t: Schema.Literal("submit"),
    req,
    bot: BotId,
    requestId: Schema.String,
    text: Schema.String,
    attachments: Optional(List(Schema.String)),
    whenBusy: WhenBusy,
    clientId: Schema.String,
  }),
  Struct({ t: Schema.Literal("abort"), req, bot: BotId }),
  Struct({
    t: Schema.Literal("createBot"),
    req,
    name: Schema.String,
    description: Schema.String,
    avatar: Optional(Schema.Int),
  }),
  Struct({ t: Schema.Literal("deleteBot"), req, bot: BotId }),
  Struct({ t: Schema.Literal("setBotOrder"), req, bots: List(BotId) }),
  Struct({ t: Schema.Literal("contextFiles"), req, bot: BotId }),
  Struct({ t: Schema.Literal("saveContextFile"), req, bot: BotId, name: ContextFileName, content: Schema.String, version: Schema.String }),
  Struct({
    t: Schema.Literal("saveMcpServer"),
    req,
    id: Optional(McpServerId),
    name: Schema.String,
    config: McpServerConfig,
  }),
  Struct({ t: Schema.Literal("deleteMcpServer"), req, id: McpServerId }),
  Struct({ t: Schema.Literal("assignMcp"), req, server: McpServerId, bot: BotId, on: Schema.Boolean }),
  Struct({ t: Schema.Literal("mcpSignIn"), req, id: McpServerId }),
  Struct({ t: Schema.Literal("mcpSignOut"), req, id: McpServerId }),
  Struct({ t: Schema.Literal("mcpRetry"), req, id: McpServerId }),
  Struct({ t: Schema.Literal("enableSkills"), req, bot: BotId, names: List(Schema.String), on: Schema.Boolean }),
  Struct({ t: Schema.Literal("previewSkillFolder"), req, folder: Schema.String }),
  Struct({ t: Schema.Literal("addSkillFolder"), req, folder: Schema.String, bots: List(BotId) }),
  Struct({ t: Schema.Literal("rescanSkills"), req }),
  Struct({ t: Schema.Literal("chatgptSignIn"), req, backgroundConsent: Schema.Literal(true) }),
  Struct({ t: Schema.Literal("chatgptSignInFinish"), req, url: Schema.String }),
  Struct({ t: Schema.Literal("chatgptSignInCancel"), req }),
  Struct({ t: Schema.Literal("chatgptSignOut"), req }),
  Struct({ t: Schema.Literal("checkForUpdate"), req }),
  Struct({ t: Schema.Literal("installUpdate"), req, version: Schema.String }),
  Struct({ t: Schema.Literal("setUpdateChannel"), req, channel: Channel }),
  Struct({ t: Schema.Literal("answer"), req, id: Schema.Int, bot: BotId, reply: AskReply }),
  Struct({ t: Schema.Literal("saveSecret"), req, id: Schema.Int, bot: BotId, value: Schema.String }),
  Struct({
    t: Schema.Literal("answerTask"),
    req,
    task: Schema.String,
    input: Schema.Int,
    answers: TaskAnswers,
  }),
  Struct({ t: Schema.Literal("t3code"), req }),
  Struct({ t: Schema.Literal("t3codeConnect"), req, address: Schema.String, code: Schema.String, plainHttp: Optional(Schema.Boolean) }),
  Struct({ t: Schema.Literal("t3codeDisconnect"), req }),
  Struct({ t: Schema.Literal("ping"), at: Schema.Number }),
]);
export type ClientFrame = typeof ClientFrame.Type;

export type RequestFrame = Extract<ClientFrame, { readonly req: number }>;
export type RequestType = RequestFrame["t"];

export const RequestResult = {
  history: Struct({
    entries: List(Entry),
    more: Schema.Boolean,
  }),
  detail: Schema.NullOr(Entry),
  submit: Struct({ duplicate: Schema.Boolean }),
  abort: Schema.Null,
  createBot: Struct({ id: BotId }),
  deleteBot: Schema.Null,
  setBotOrder: Schema.Null,
  contextFiles: List(ContextFileView),
  saveContextFile: Struct({ version: Schema.String }),
  saveMcpServer: Struct({ id: McpServerId }),
  deleteMcpServer: Schema.Null,
  assignMcp: Schema.Null,
  mcpSignIn: Struct({ url: Schema.String }),
  mcpSignOut: Schema.Null,
  mcpRetry: Schema.Null,
  enableSkills: Schema.Null,
  previewSkillFolder: SkillFolder,
  addSkillFolder: SkillFolderAdded,
  rescanSkills: Schema.Null,
  chatgptSignIn: Struct({ url: Schema.String }),
  chatgptSignInFinish: Schema.Null,
  chatgptSignInCancel: Schema.Null,
  chatgptSignOut: Schema.Null,
  checkForUpdate: Schema.Null,
  installUpdate: Schema.Null,
  setUpdateChannel: Schema.Null,
  answer: Schema.Null,
  saveSecret: Schema.Null,
  answerTask: Schema.Null,
  t3code: T3CodeView,
  t3codeConnect: T3CodeView,
  t3codeDisconnect: Schema.Null,
} as const satisfies { readonly [T in RequestType]: Schema.Codec<unknown> };
export type ResultOf<T extends RequestType> = (typeof RequestResult)[T]["Type"];

export type HistoryResult = ResultOf<"history">;
export type SubmitResult = ResultOf<"submit">;
export type CreateBotResult = ResultOf<"createBot">;
export type SaveMcpServerResult = ResultOf<"saveMcpServer">;
export type McpSignInResult = ResultOf<"mcpSignIn">;

export const MAX_BOT_NAME = 40;
export const MAX_BOT_DESCRIPTION = 2_000;
export const MAX_BOT_AVATAR = 9_999;

export const ServerFrame = Schema.Union([
  Struct({
    t: Schema.Literal("welcome"),
    serverId: Schema.String,
    protocol: Schema.Int,
    version: Optional(Schema.String),
    channel: Optional(Channel),
    filesPath: Optional(Schema.String),
    attachmentsPath: Optional(Schema.String),
    tailnetUrl: Optional(Schema.String),
    viewer: Optional(Viewer),
  }),
  Struct({ t: Schema.Literal("bots"), bots: List(BotSummary) }),
  Struct({ t: Schema.Literal("bot"), bot: BotSummary }),
  Struct({ t: Schema.Literal("botRemoved"), bot: BotId }),
  Struct({ t: Schema.Literal("mcpServers"), servers: List(McpServerView) }),
  Struct({ t: Schema.Literal("mcpServer"), server: McpServerView }),
  Struct({ t: Schema.Literal("mcpServerRemoved"), id: McpServerId }),
  Struct({ t: Schema.Literal("skills"), skills: SkillsView }),
  Struct({ t: Schema.Literal("account"), account: AccountView }),
  Struct({
    t: Schema.Literal("sync"),
    bot: BotId,
    entries: List(Entry),
    gap: Optional(Gap),
    earlier: Optional(Schema.Boolean),
    inbox: List(QueuedMessage),
  }),
  Struct({ t: Schema.Literal("entry"), entry: Entry }),
  Struct({ t: Schema.Literal("files"), bot: BotId, folder: Schema.String, files: List(FileView), more: Optional(Schema.Literal(true)) }),
  Struct({ t: Schema.Literal("inbox"), bot: BotId, items: List(QueuedMessage) }),
  Struct({ t: Schema.Literal("asks"), asks: List(WaitingAsk) }),
  Struct({ t: Schema.Literal("waitingTasks"), tasks: List(WaitingTask) }),
  Struct({ t: Schema.Literal("update"), update: UpdateView }),
  Struct({ t: Schema.Literal("result"), req, ok: Schema.Literal(true), value: Schema.Unknown }),
  Struct({ t: Schema.Literal("result"), req, ok: Schema.Literal(false), error: Schema.String }),
  Struct({ t: Schema.Literal("pong"), at: Schema.Number }),
]);
export type ServerFrame = typeof ServerFrame.Type;

export type Parsed<T> = { readonly ok: true; readonly frame: T } | { readonly ok: false; readonly error: string; readonly req?: number };

const formatIssue = SchemaIssue.makeFormatterDefault();

type FrameSchema = Schema.Decoder<unknown> & { readonly fields: { readonly t: { readonly literal: string } } };

const SENSITIVE_FRAMES: ReadonlySet<string> = new Set(["saveSecret", "t3codeConnect"]);

function frameParser<M extends FrameSchema>(union: { readonly members: ReadonlyArray<M> }): (text: string) => Parsed<M["Type"]> {
  const byTag = new Map<string, M[]>();
  for (const member of union.members) byTag.set(member.fields.t.literal, [...(byTag.get(member.fields.t.literal) ?? []), member]);
  const decoders = new Map(
    [...byTag].map(([tag, members]) => [
      tag,
      Schema.decodeUnknownResult<Schema.Decoder<M["Type"]>>(members.length === 1 ? members[0]! : Schema.Union(members)),
    ]),
  );
  return (text) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: "Not JSON" };
    }
    const object = typeof value === "object" && value !== null ? value : {};
    const t = "t" in object ? object.t : undefined;
    const req = "req" in object && typeof object.req === "number" && Number.isInteger(object.req) ? object.req : undefined;
    const fail = (error: string): Parsed<M["Type"]> => ({ ok: false, error, ...(req === undefined ? {} : { req }) });
    const decode = decoders.get(String(t));
    if (!decode) return fail(`Unknown frame ${JSON.stringify(t)}`);
    const result = decode(value);
    if (Result.isSuccess(result)) return { ok: true, frame: result.success };
    if (SENSITIVE_FRAMES.has(String(t))) return fail(`Bad ${String(t)} frame`);
    return fail(`Bad ${String(t)} frame: ${formatIssue(result.failure.issue)}`);
  };
}

export const parseClientFrame: (text: string) => Parsed<ClientFrame> = frameParser(ClientFrame);
export const parseServerFrame: (text: string) => Parsed<ServerFrame> = frameParser(ServerFrame);
