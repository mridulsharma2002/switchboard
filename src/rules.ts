// Stage 1: a free, instant rules pass. Scores difficulty 1-5 and says how sure it is.
export type TaskKind = "chat" | "rewrite" | "code" | "debug" | "architecture" | "analysis" | "math" | "creative" | "agentic";

export interface RuleResult {
  level: number;          // 1 (trivial) .. 5 (hardest)
  confidence: number;     // 0..1, how sure the rules are
  kind: TaskKind;
  signals: string[];      // human-readable reasons
}

interface Rule { re: RegExp; delta: number; kind?: TaskKind; label: string }

const RULES: Rule[] = [
  { re: /\b(quick|quickly|briefly|one[- ]word|tl;?dr|short answer|yes or no)\b/i, delta: -1.5, kind: "chat", label: "asks for a quick answer" },
  { re: /\b(fix (the )?(typo|grammar|spelling)|rephrase|rewrite|reword|proofread|translate|summari[sz]e)\b/i, delta: -0.5, kind: "rewrite", label: "rewrite or summary task" },
  { re: /^(hi|hey|hello|thanks|thank you|what is|what's|who is|when (is|was|did)|define)\b/i, delta: -1, kind: "chat", label: "simple question" },
  { re: /```|\bfunction\b|\bclass\b|=>|\bdef\b|\bconst\b|\bimport\b|;\s*$/m, delta: 1, kind: "code", label: "contains code" },
  { re: /\b(write|implement|build|refactor|code|script|regex|sql|api|endpoint|component)\b/i, delta: 0.75, kind: "code", label: "coding task" },
  { re: /\b(bug|debug|stack ?trace|error|exception|crash|race condition|memory leak|segfault|deadlock)\b/i, delta: 1.25, kind: "debug", label: "debugging" },
  { re: /\b(architect(ure)?|system design|design (a|the)|scal(e|able|ing)|distributed|microservices?|trade-?offs?|migration plan)\b/i, delta: 1.5, kind: "architecture", label: "architecture or system design" },
  { re: /\b(prove|proof|derive|theorem|optimi[sz]e|complexity|algorithm|big-?o)\b/i, delta: 1.25, kind: "math", label: "proof or algorithm" },
  { re: /\b(analy[sz]e|compare|evaluate|critique|research|pros and cons|strategy)\b/i, delta: 0.75, kind: "analysis", label: "analysis" },
  { re: /\b(step[- ]by[- ]step|multi-?step|end[- ]to[- ]end|entire (codebase|repo|project)|whole (codebase|repo|app)|plan and (build|execute)|autonomous|agent)\b/i, delta: 1.75, kind: "agentic", label: "long multi-step work" },
  { re: /\b(poem|story|joke|caption|tweet|slogan|name ideas?)\b/i, delta: -0.5, kind: "creative", label: "light creative writing" },
  { re: /\b(carefully|rigorous(ly)?|production|critical|security|edge cases?)\b/i, delta: 0.75, label: "asks for rigor" },
];

export function scoreWithRules(prompt: string): RuleResult {
  const text = prompt.trim();
  let level = 2;            // start at "everyday"
  const signals: string[] = [];
  const kindVotes = new Map<TaskKind, number>();
  let hits = 0;

  for (const r of RULES) {
    if (r.re.test(text)) {
      level += r.delta;
      hits++;
      signals.push(r.label);
      if (r.kind) kindVotes.set(r.kind, (kindVotes.get(r.kind) ?? 0) + Math.abs(r.delta));
    }
  }

  // Length: long prompts usually carry more context and harder asks.
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 8) { level -= 0.75; signals.push(`very short (${words} words)`); }
  else if (words > 400) { level += 1.25; signals.push(`long prompt (${words} words)`); }
  else if (words > 120) { level += 0.5; signals.push(`detailed prompt (${words} words)`); }

  // Several numbered requirements in one prompt = more steps.
  const listItems = (text.match(/^\s*(\d+[.)]|[-*])\s+/gm) ?? []).length;
  if (listItems >= 4) { level += 0.75; signals.push(`${listItems} separate requirements`); }

  level = Math.min(5, Math.max(1, level));
  const kind = [...kindVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "chat";

  // Confidence: strong when many signals agree or the prompt is clearly tiny;
  // weak in the murky middle, which is where the Haiku classifier earns its keep.
  const distanceFromMiddle = Math.abs(level - 3) / 2; // 0 at level 3, 1 at the ends
  const confidence = Math.min(1, 0.35 + 0.1 * hits + 0.35 * distanceFromMiddle);

  if (signals.length === 0) signals.push("no strong signals");
  return { level: Math.round(level * 10) / 10, confidence: Math.round(confidence * 100) / 100, kind, signals };
}
