import type { BotStatus } from "@top/client";
import { type CSSProperties, memo } from "react";
import { cn } from "../lib/utils.ts";

const HUES = {
  cocoa: "[--hue:#b07a55]",
  sky: "[--hue:#4f8af0]",
  emerald: "[--hue:#3fae5c]",
  cyan: "[--hue:#16aab6]",
  indigo: "[--hue:#7280f7]",
  violet: "[--hue:#9a70f7]",
  fuchsia: "[--hue:#cf62e0]",
  rose: "[--hue:#ea5a80]",
} as const;
const NAMES = Object.keys(HUES) as (keyof typeof HUES)[];

export const avatarSeed = (name: string, avatar = 0) => (avatar ? `${name}\n${avatar}` : name);

export function botHue(name: string): keyof typeof HUES {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAMES[h % NAMES.length]!;
}

function random(name: string, salt: number): () => number {
  let a = 2166136261 ^ salt;
  for (const c of name) {
    a ^= c.charCodeAt(0);
    a = Math.imul(a, 16777619);
  }
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const n = (v: number) => Math.round(v * 10) / 10;

type Body =
  | { kind: "path"; d: string }
  | { kind: "poly"; points: string; join: number }
  | { kind: "circles"; circles: readonly (readonly [number, number, number])[] };
type Shape = { body: Body; face: readonly [number, number]; gap: number };

function polar(radius: (t: number) => number, rotate = 0): Body {
  const points: string[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const r = radius(t);
    points.push(`${n(50 + r * Math.cos(t + rotate))} ${n(50 + r * Math.sin(t + rotate))}`);
  }
  return { kind: "path", d: `M${points.join("L")}Z` };
}

function superellipse(a: number, b: number, e: number) {
  return (t: number) => 1 / ((Math.abs(Math.cos(t)) / a) ** e + (Math.abs(Math.sin(t)) / b) ** e) ** (1 / e);
}

function polygon(sides: number, radius: number, rotate: number, join: number): Body {
  const points: string[] = [];
  for (let i = 0; i < sides; i++) {
    const t = rotate + (i / sides) * Math.PI * 2;
    points.push(`${n(50 + radius * Math.cos(t))},${n(50 + radius * Math.sin(t))}`);
  }
  return { kind: "poly", points: points.join(" "), join };
}

const SHAPES: readonly ((r: () => number) => Shape)[] = [
  () => ({ body: polar(() => 44), face: [50, 50], gap: 11 }),
  () => ({ body: polar(superellipse(43, 43, 4.2)), face: [50, 51], gap: 12 }),
  () => ({ body: polar(superellipse(46, 35, 3.2)), face: [50, 52], gap: 14 }),
  () => ({ body: polar(superellipse(33, 46, 2.6)), face: [50, 44], gap: 9 }),
  (r) => {
    const petals = 5 + Math.floor(r() * 4);
    return { body: polar((t) => 40 + 6 * Math.cos(petals * t), -Math.PI / 2), face: [50, 51], gap: 10 };
  },
  (r) => {
    const points = pick(r, [4, 5, 6]);
    return { body: polar((t) => 37 + 9.5 * Math.cos(points * t), -Math.PI / 2), face: [50, 52], gap: 9 };
  },
  () => ({ body: polygon(3, 36, -Math.PI / 2, 22), face: [50, 59], gap: 9 }),
  () => ({ body: polygon(6, 38, Math.PI / 6, 14), face: [50, 51], gap: 11 }),
  () => ({
    body: { kind: "path", d: "M14 52A36 36 0 0 1 86 52L86 86Q77 78 68 86Q59 94 50 86Q41 78 32 86Q23 94 14 86Z" },
    face: [50, 50],
    gap: 11,
  }),
  () => ({ body: { kind: "path", d: "M50 6C64 26 86 40 86 60A36 36 0 0 1 14 60C14 40 36 26 50 6Z" }, face: [50, 62], gap: 11 }),
  () => ({
    body: {
      kind: "circles",
      circles: [
        [32, 58, 24],
        [68, 58, 24],
        [50, 40, 28],
        [50, 64, 24],
      ],
    },
    face: [50, 54],
    gap: 12,
  }),
  (r) => ({ body: polar((t) => 40 + 5 * Math.cos(2 * t) + 3 * Math.cos(3 * t + 1.2), r() * Math.PI), face: [50, 50], gap: 10 }),
];

type Eyes = { kind: "pill" | "dot" | "happy"; xs: readonly [number, number]; y: number; size: number };
type Look = { body: Body; eyes: Eyes };

function draw(name: string): Look {
  const r = random(name, 11);
  const shape = pick(r, SHAPES)(r);
  const kind = r() < 0.78 ? "pill" : r() < 0.6 ? "dot" : "happy";
  const lookX = (r() - 0.5) * 8;
  const lookY = (r() - 0.5) * 5;
  const size = 5.8 + r() * 1.6;
  const gap = shape.gap * (0.85 + r() * 0.3);
  const x = shape.face[0] + lookX;
  return { body: shape.body, eyes: { kind, xs: [n(x - gap), n(x + gap)], y: n(shape.face[1] + lookY), size } };
}

const looks = new Map<string, Look>();
function lookFor(name: string): Look {
  let look = looks.get(name);
  if (!look) {
    look = draw(name);
    if (looks.size >= 256) looks.clear();
    looks.set(name, look);
  }
  return look;
}

function BodyShape({ body }: { body: Body }) {
  if (body.kind === "path") return <path d={body.d} />;
  if (body.kind === "poly") return <polygon points={body.points} strokeWidth={body.join} strokeLinejoin="round" className="stroke-(--avatar-body)" />;
  return body.circles.map(([cx, cy, r]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} />);
}

function Eye({ kind, x, y, s }: { kind: Eyes["kind"]; x: number; y: number; s: number }) {
  if (kind === "pill") return <rect x={n(x - s * 0.62)} y={n(y - s * 1.15)} width={n(s * 1.24)} height={n(s * 2.3)} rx={n(s * 0.62)} />;
  if (kind === "dot") return <circle cx={x} cy={y} r={n(s * 0.82)} />;
  return (
    <path
      d={`M${n(x - s)} ${n(y + s * 0.5)}Q${x} ${n(y - s * 1.2)} ${n(x + s)} ${n(y + s * 0.5)}`}
      fill="none"
      strokeWidth={n(s * 0.7)}
      strokeLinecap="round"
      className="stroke-(--avatar-eye)"
    />
  );
}

const SIZES = {
  sm: "size-7",
  md: "size-9",
  lg: "size-14",
} as const;

export type AvatarMotion = "calm" | "pondering" | "busy" | "strained" | "down";

const MOTIONS: Record<BotStatus, AvatarMotion> = {
  idle: "calm",
  thinking: "pondering",
  tool: "busy",
  retrying: "strained",
  failed: "down",
};

export const avatarMotion = (status: BotStatus | undefined): AvatarMotion | undefined => (status ? MOTIONS[status] : undefined);

export function avatarRhythm(seed: string): { phase: number; lean: 1 | -1 } {
  const r = random(seed, 29);
  return { phase: Math.round(r() * 100) / 100, lean: r() < 0.5 ? -1 : 1 };
}

export const Avatar = memo(function Avatar({
  name,
  avatar,
  status,
  size = "md",
  title,
  className,
}: {
  name: string;
  avatar?: number | undefined;
  status?: BotStatus | undefined;
  size?: keyof typeof SIZES;
  title?: string;
  className?: string;
}) {
  const seed = avatarSeed(name, avatar);
  const { body, eyes } = lookFor(seed);
  const motion = avatarMotion(status);
  const rhythm = motion && avatarRhythm(seed);
  return (
    <span
      className={cn(
        "avatar relative flex-none select-none [--avatar-body:var(--hue)] [--avatar-eye:#fff] [filter:var(--avatar-filter)] in-data-[avatars=mono]:[--avatar-body:var(--color-foreground)] in-data-[avatars=mono]:[--avatar-eye:var(--hue)]",
        SIZES[size],
        HUES[botHue(seed)],
        className,
      )}
      data-state={motion}
      style={
        rhythm &&
        ({
          "--avatar-phase": rhythm.phase,
          "--avatar-lean": rhythm.lean,
          "--avatar-gaze": `${n((eyes.xs[0] + eyes.xs[1]) / 2)}% ${eyes.y}%`,
        } as CSSProperties)
      }
      aria-hidden
      title={title}
    >
      <span className="avatar-body relative block size-full">
        <svg viewBox="0 0 100 100" className="block size-full overflow-visible fill-(--avatar-body)" aria-hidden="true">
          <BodyShape body={body} />
        </svg>
        <span className="avatar-eyes absolute inset-0">
          <svg viewBox="0 0 100 100" className="avatar-lids block size-full overflow-visible fill-(--avatar-eye)" aria-hidden="true">
            <Eye kind={eyes.kind} x={eyes.xs[0]} y={eyes.y} s={eyes.size} />
            <Eye kind={eyes.kind} x={eyes.xs[1]} y={eyes.y} s={eyes.size} />
          </svg>
        </span>
      </span>
      {status === "failed" && (
        <i className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-[2.5px] border-(--avatar-ring,var(--color-sidebar)) bg-destructive" />
      )}
    </span>
  );
});
