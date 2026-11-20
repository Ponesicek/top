import { randomUUID } from "node:crypto";
import Type from "typebox";
import type { Capabilities, HarnessAdapter, HarnessAnswer, HarnessEvent, OpenSpec, Turn, Where } from "./harness.ts";

export const FAKE_HARNESS = "fake";
export const FAKE_CLOUD = "fake-cloud";

export type FakeHarnessConfig = {
  readonly id?: string;
  readonly stepMs?: number;
  readonly capabilities?: Partial<Capabilities>;
  readonly unavailable?: string;
  readonly opened?: (spec: OpenSpec) => void;
  readonly failOpen?: string;
  readonly closed?: () => void;
  readonly label?: string;
  /** "cloud": takes no `cwd`, sends to its `cloud_session` option, and only hands work off (its turns end `handed_off`). */
  readonly where?: Where;
};

export type FakeHarness = HarnessAdapter & {
  readonly sessions: { readonly spec: OpenSpec; readonly turns: Turn[]; readonly steered: string[]; closed: boolean; interrupted: number }[];
};

const ALL: Capabilities = {
  resume: true,
  fork: true,
  steer: true,
  queue: true,
  questions: true,
  images: true,
  fileChanges: true,
  usage: true,
  cancel: true,
  reconnect: true,
  durable: false,
};

export function fakeHarness(config: FakeHarnessConfig = {}): FakeHarness {
  const stepMs = config.stepMs ?? 300;
  const sessions: FakeHarness["sessions"] = [];
  const cloud = config.where === "cloud";
  return {
    id: config.id ?? (cloud ? FAKE_CLOUD : FAKE_HARNESS),
    label: config.label ?? (cloud ? "Fake cloud" : "Fake harness"),
    ...(config.where ? { where: config.where } : {}),
    capabilities: cloud
      ? {
          ...ALL,
          fork: false,
          steer: false,
          queue: false,
          questions: false,
          images: false,
          cancel: false,
          reconnect: false,
          follow: false,
          ...config.capabilities,
        }
      : { ...ALL, ...config.capabilities },
    options: cloud
      ? Type.Object({ cloud_session: Type.String({ description: "Testing only: a cloud session's id." }) }, { additionalProperties: false })
      : Type.Object({ speed: Type.Optional(Type.Number({ minimum: 0, description: "Testing only." })) }, { additionalProperties: false }),
    ...(cloud
      ? {
          locate: async (cwd: string | undefined, start: { readonly options: Readonly<Record<string, unknown>> }) => {
            if (cwd !== undefined) throw new Error("Fake cloud takes no `cwd`.");
            return { cwd: `fake.invalid/${String(start.options.cloud_session)}` };
          },
        }
      : {}),
    sessions,
    check: async () => (config.unavailable ? { ok: false, error: config.unavailable } : { ok: true, version: "1.0.0" }),
    open: async (spec, emit) => {
      config.opened?.(spec);
      if (config.failOpen) throw new Error(config.failOpen);
      const record = { spec, turns: [] as Turn[], steered: [] as string[], closed: false, interrupted: 0 };
      sessions.push(record);
      const externalId = spec.resume && !spec.fork ? spec.resume : `fake-${randomUUID()}`;
      emit({ type: "session", externalId });
      if (spec.resume) emit({ type: "log", kind: "status", text: `${spec.fork ? "branched from" : "resumed"} ${spec.resume}` });
      const pending = new Map<string, (answer: HarnessAnswer) => void>();
      let timers: NodeJS.Timeout[] = [];
      let turn = 0;
      let active = false;

      const later = (ms: number, run: () => void) => {
        const timer = setTimeout(run, ms);
        timers.push(timer);
      };
      const end = (event: Omit<Extract<HarnessEvent, { type: "turn_ended" }>, "type">) => {
        if (!active) return;
        active = false;
        for (const id of pending.keys()) emit({ type: "resolved", id });
        pending.clear();
        emit({ type: "usage", usage: { inputTokens: 100 * turn, outputTokens: 20 * turn } });
        emit({ type: "turn_ended", ...event });
      };
      const ask = (request: Extract<HarnessEvent, { type: "request" }>["request"], then: (answer: HarnessAnswer) => void) => {
        pending.set(request.id, (answer) => {
          pending.delete(request.id);
          then(answer);
        });
        emit({ type: "request", request });
      };

      const play = (text: string) => {
        const lower = text.toLowerCase();
        const n = turn;
        emit({ type: "log", kind: "reasoning", text: `Looking at: ${text.slice(0, 80)}` });
        if (lower.includes("crash")) return later(stepMs, () => emit({ type: "exited", error: "Fake harness stopped: it crashed" }));
        if (lower.includes("forever")) return;
        if (lower.includes("fail")) return later(stepMs, () => end({ status: "failed", error: "The fake turn failed." }));
        if (cloud)
          return later(stepMs, () =>
            end({ status: "handed_off", result: `Sent to Fake cloud: https://example.invalid/fake/${n}. Top can't see its progress or result there.` }),
          );
        if (lower.includes("question")) {
          return later(stepMs, () =>
            ask(
              {
                id: `r${n}-question`,
                title: "Which database?",
                questions: [
                  { id: "db", question: "Which database?", header: "Database", options: [{ label: "Postgres" }, { label: "SQLite", description: "simpler" }] },
                ],
              },
              (answer) => {
                const given = answer.kind === "question" ? Object.values(answer.answers).flat() : [];
                later(stepMs, () => end({ status: "completed", result: `Using ${given.join(", ") || "nothing"}.` }));
              },
            ),
          );
        }
        later(stepMs, () => emit({ type: "log", kind: "file_change", text: "~ src/app.ts" }));
        later(stepMs * 2, () => emit({ type: "log", kind: "message", text: `Done: ${text.slice(0, 200)}` }));
        later(stepMs * 3, () => end({ status: "completed", result: `Done: ${text.slice(0, 200)}` }));
      };

      return {
        run: async (next) => {
          if (record.closed) throw new Error("closed");
          record.turns.push(next);
          turn++;
          active = true;
          play(next.text);
        },
        steer: async (text) => {
          if (!active) throw new Error("no turn running");
          record.steered.push(text);
          emit({ type: "log", kind: "message", text: `Steered: ${text}` });
        },
        interrupt: async () => {
          record.interrupted++;
          for (const timer of timers) clearTimeout(timer);
          timers = [];
          later(stepMs / 3, () => end({ status: "interrupted" }));
        },
        answer: (id, answer) => pending.get(id)?.(answer),
        close: async () => {
          record.closed = true;
          for (const timer of timers) clearTimeout(timer);
          timers = [];
          pending.clear();
          config.closed?.();
        },
      };
    },
  };
}
