/**
 * The animated architecture diagram for the marketing site's "How it works"
 * section.
 *
 * Not a stock illustration - every node and every line on it is a real stage
 * in Tally's own pipeline (see src/lib/agent/worker.ts and
 * src/app/api/webhooks/razorpay/[merchantId]/route.ts), in the order events
 * actually move through them. A visitor who reads this and then opens the
 * dashboard's own "Live progress" strip should recognise the same stages by
 * the same names.
 *
 * Built as one SVG (for the connecting lines and the flowing dots, which
 * scale and animate natively via viewBox and SMIL) with plain HTML icon
 * nodes laid on top of it, positioned from the same coordinate space. A pure
 * server component - nothing here needs client JS, so the motion keeps
 * running even if hydration is slow.
 */
import {
  BarChart3Icon,
  CreditCardIcon,
  DatabaseIcon,
  FileTextIcon,
  MailIcon,
  MessageCircleIcon,
  PhoneIcon,
  RadioIcon,
  RepeatIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  SparklesIcon,
  UserIcon,
  WebhookIcon,
} from "lucide-react";

/** The 1200x460 space every coordinate below is measured in. Nodes and paths
 *  share it, so an icon and the line drawn into it always meet exactly. */
const VW = 1200;
const VH = 460;

type Tone = "emerald" | "amber" | "violet" | "sky" | "indigo" | "slate" | "rose";

const RING: Record<Tone, string> = {
  emerald: "border-emerald-400 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
  amber: "border-amber-400 bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
  violet: "border-violet-400 bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400",
  sky: "border-sky-400 bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400",
  indigo: "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400",
  slate: "border-slate-300 bg-slate-50 text-slate-600 dark:bg-slate-500/10 dark:text-slate-300",
  rose: "border-rose-400 bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400",
};

/** The stroke a line takes on as it draws INTO the tone it's carrying data
 *  toward - so a line changes colour partway if the two ends disagree, the
 *  same way current changes colour crossing a component in a circuit diagram. */
const STROKE: Record<Tone, string> = {
  emerald: "#10b981",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  sky: "#0ea5e9",
  indigo: "#6366f1",
  slate: "#94a3b8",
  rose: "#fb7185",
};

interface Node {
  id: string;
  x: number;
  y: number;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub?: string;
  tone: Tone;
  size?: "sm" | "md";
}

const NODES: Node[] = [
  // Column A - the four shapes a failure arrives in.
  { id: "n-failed", x: 70, y: 70, icon: CreditCardIcon, label: "Failed payment", tone: "rose", size: "sm" },
  { id: "n-mandate", x: 70, y: 170, icon: RepeatIcon, label: "Mandate retry", tone: "rose", size: "sm" },
  { id: "n-cart", x: 70, y: 270, icon: ShoppingCartIcon, label: "Cart abandoned", tone: "rose", size: "sm" },
  { id: "n-invoice", x: 70, y: 370, icon: FileTextIcon, label: "Overdue invoice", tone: "rose", size: "sm" },

  // Column B - one webhook, verified and classified.
  { id: "n-webhook", x: 300, y: 220, icon: WebhookIcon, label: "Verify & classify", sub: "one webhook, every merchant", tone: "slate", size: "md" },

  // Column C - inside "the recovery engine" cluster.
  { id: "n-queue", x: 520, y: 130, icon: DatabaseIcon, label: "Queued", tone: "slate", size: "sm" },
  { id: "n-guard", x: 660, y: 130, icon: ShieldCheckIcon, label: "Guardrails", tone: "indigo", size: "sm" },
  { id: "n-agent", x: 800, y: 130, icon: SparklesIcon, label: "Agent decides", tone: "violet", size: "sm" },
  { id: "n-audit", x: 520, y: 310, icon: ScrollTextIcon, label: "Audit trail", tone: "slate", size: "sm" },
  { id: "n-live", x: 660, y: 310, icon: RadioIcon, label: "Live dashboard", tone: "sky", size: "sm" },
  { id: "n-workflows", x: 800, y: 310, icon: BarChart3Icon, label: "Workflows", tone: "emerald", size: "sm" },

  // Column D - the channel it actually goes out on.
  { id: "n-email", x: 1000, y: 110, icon: MailIcon, label: "Email", tone: "sky", size: "sm" },
  { id: "n-whatsapp", x: 1000, y: 220, icon: MessageCircleIcon, label: "WhatsApp", tone: "emerald", size: "sm" },
  { id: "n-voice", x: 1000, y: 330, icon: PhoneIcon, label: "Voice", tone: "amber", size: "sm" },

  // Column E - the customer, both ends of the conversation.
  { id: "n-customer", x: 1140, y: 220, icon: UserIcon, label: "Customer", tone: "rose", size: "md" },
];

/** One flowing connector: the path it draws, and the dots travelling it. */
interface Flow {
  d: string;
  tone: Tone;
  dots?: number;
  duration?: number;
  dashed?: boolean;
}

const FLOWS: Flow[] = [
  // A -> B, four causes converging on one classifier.
  { d: "M 108 70 C 200 70, 220 150, 262 210", tone: "rose" },
  { d: "M 108 170 C 180 170, 210 190, 262 215", tone: "rose" },
  { d: "M 108 270 C 180 270, 210 250, 262 225", tone: "rose" },
  { d: "M 108 370 C 200 370, 220 290, 262 230", tone: "rose" },

  // B -> the engine cluster's left edge.
  { d: "M 338 220 C 400 220, 400 220, 460 220", tone: "slate" },

  // the engine cluster's right edge -> channels, fanning out.
  { d: "M 860 220 C 920 220, 930 130, 962 115", tone: "sky" },
  { d: "M 860 220 C 920 220, 930 220, 962 220", tone: "emerald" },
  { d: "M 860 220 C 920 220, 930 320, 962 330", tone: "amber" },

  // channels -> customer, converging.
  { d: "M 1038 115 C 1080 115, 1090 180, 1116 208", tone: "sky" },
  { d: "M 1038 220 C 1075 220, 1080 220, 1116 220", tone: "emerald" },
  { d: "M 1038 330 C 1080 330, 1090 260, 1116 232", tone: "amber" },

  // the reply loop: the customer's own words, arcing back to be understood.
  {
    d: "M 1140 258 C 1140 420, 300 420, 300 258",
    tone: "violet",
    dashed: true,
    duration: 3.4,
    dots: 1,
  },
];

/** The four causes above the fold, then the recovery engine's own six
 *  internal steps - counted separately because the second group is the one
 *  a merchant will actually recognise from their own dashboard. */
const CLUSTER = { x: 460, y: 40, w: 400, h: 340 };

function sizePx(size: Node["size"]): number {
  return size === "md" ? 64 : 48;
}

function DiagramNode({ node }: { node: Node }) {
  const Icon = node.icon;
  const px = sizePx(node.size);
  return (
    <div
      className="marketing-motion absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5"
      style={{ left: `${(node.x / VW) * 100}%`, top: `${(node.y / VH) * 100}%` }}
    >
      <span
        className={`animate-float flex shrink-0 items-center justify-center rounded-full border-2 border-dashed shadow-sm ${RING[node.tone]}`}
        style={{
          width: px,
          height: px,
          // Staggered so the nodes bob out of phase with each other rather
          // than as one rigid block.
          animationDelay: `${(node.x + node.y) % 5}00ms`,
        }}
      >
        <Icon className={node.size === "md" ? "size-6" : "size-4.5"} />
      </span>
      <span className="text-center text-[0.68rem] leading-tight font-semibold whitespace-nowrap text-slate-700 dark:text-slate-200 sm:text-xs">
        {node.label}
      </span>
      {node.sub && (
        <span className="text-center text-[0.6rem] leading-tight whitespace-nowrap text-slate-400 dark:text-slate-500">
          {node.sub}
        </span>
      )}
    </div>
  );
}

export function HowItWorksDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <div
        className="relative mx-auto min-w-[900px] max-w-5xl"
        style={{ aspectRatio: `${VW} / ${VH}` }}
      >
        {/* The recovery engine cluster - a dashed boundary, drawn first so
            every node and line sits visibly above it. */}
        <div
          className="absolute rounded-[2rem] border-2 border-dashed border-indigo-200 bg-indigo-50/40 dark:border-indigo-500/25 dark:bg-indigo-500/[0.04]"
          style={{
            left: `${(CLUSTER.x / VW) * 100}%`,
            top: `${(CLUSTER.y / VH) * 100}%`,
            width: `${(CLUSTER.w / VW) * 100}%`,
            height: `${(CLUSTER.h / VH) * 100}%`,
          }}
        >
          <span className="absolute -top-3.5 left-6 rounded-full border border-indigo-200 bg-white px-3 py-1 text-[0.65rem] font-bold tracking-wide text-indigo-600 uppercase shadow-sm dark:border-indigo-500/30 dark:bg-slate-900 dark:text-indigo-400">
            The Recovery Engine
          </span>
        </div>

        {/* Connectors and the dots that travel them. */}
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {FLOWS.map((f, i) => (
            <g key={i}>
              <path
                d={f.d}
                fill="none"
                stroke={STROKE[f.tone]}
                strokeWidth={f.dashed ? 1.5 : 2}
                strokeDasharray={f.dashed ? "5 6" : undefined}
                strokeLinecap="round"
                opacity={f.dashed ? 0.45 : 0.35}
              />
              {Array.from({ length: f.dots ?? 2 }, (_, dotI) => (
                <circle key={dotI} r={f.dashed ? 3 : 3.5} fill={STROKE[f.tone]}>
                  <animateMotion
                    dur={`${f.duration ?? 2.6}s`}
                    repeatCount="indefinite"
                    path={f.d}
                    begin={`${(i * 0.35 + dotI * (f.duration ?? 2.6) / (f.dots ?? 2)).toFixed(2)}s`}
                    rotate="auto"
                  />
                </circle>
              ))}
            </g>
          ))}
        </svg>

        {/* Every node, on top of the lines that connect them. */}
        {NODES.map((n) => (
          <DiagramNode key={n.id} node={n} />
        ))}

        {/* The reply loop's own caption, sitting under the arc it labels. */}
        <span
          className="absolute -translate-x-1/2 text-[0.62rem] font-semibold whitespace-nowrap text-violet-400 dark:text-violet-500"
          style={{ left: `${(720 / VW) * 100}%`, top: `${(408 / VH) * 100}%` }}
        >
          the customer replies, and the agent reads it before its next move
        </span>
      </div>
    </div>
  );
}
