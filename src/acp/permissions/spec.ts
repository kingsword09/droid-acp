export function extractSpecTitleAndPlan(rawInput: unknown): {
  title: string | null;
  plan: string | null;
} {
  if (!rawInput || typeof rawInput !== "object") return { title: null, plan: null };

  const obj = rawInput as Record<string, unknown>;

  const title =
    typeof obj.title === "string"
      ? obj.title
      : typeof obj.specTitle === "string"
        ? obj.specTitle
        : typeof obj.name === "string"
          ? obj.name
          : null;

  const candidates: unknown[] = [
    obj.plan,
    (obj as { planMarkdown?: unknown }).planMarkdown,
    (obj as { markdown?: unknown }).markdown,
    (obj as { content?: unknown }).content,
    (obj as { text?: unknown }).text,
  ];

  const toMarkdown = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2)));
      const joined = parts.join("\n").trim();
      return joined.length > 0 ? joined : null;
    }
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (typeof v.markdown === "string") return v.markdown;
      if (typeof v.text === "string") return v.text;
      const json = JSON.stringify(v, null, 2);
      return json && json !== "{}" ? json : null;
    }
    return null;
  };

  for (const c of candidates) {
    const plan = toMarkdown(c);
    if (plan) return { title, plan };
  }

  return { title, plan: null };
}

export function planEntriesFromMarkdown(planMarkdown: string): Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "medium";
}> {
  const entries: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "medium";
  }> = [];
  let inCodeFence = false;

  for (const rawLine of planMarkdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!line) continue;

    const checkbox = line.match(/^- \[([ xX~])\]\s+(.*)$/);
    if (checkbox) {
      const [, mark, content] = checkbox;
      const status =
        mark === "x" || mark === "X"
          ? ("completed" as const)
          : mark === "~"
            ? ("in_progress" as const)
            : ("pending" as const);
      entries.push({ content, status, priority: "medium" as const });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      entries.push({
        content: bullet[1],
        status: "pending",
        priority: "medium",
      });
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      entries.push({
        content: numbered[1],
        status: "pending",
        priority: "medium",
      });
      continue;
    }
  }

  return entries.filter((e) => e.content.length > 0);
}

export function extractPlanChoices(planMarkdown: string): Array<{ id: string; title: string }> {
  const explicitChoices: Array<{ id: string; title: string }> = [];
  const looseChoices: Array<{ id: string; title: string }> = [];
  const seenExplicit = new Set<string>();
  const seenLoose = new Set<string>();

  for (const rawLine of planMarkdown.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const stripped = line
      .replace(/^>\s+/, "")
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s+/, "")
      .trim()
      .replace(/^[*_`]+/, "")
      .trim();

    const explicit = stripped.match(/^(?:Option)\s*([A-Z])\s*[：:–—.)-]\s*(.+)$/i);
    if (explicit) {
      const id = explicit[1].toUpperCase();
      if (seenExplicit.has(id)) continue;
      seenExplicit.add(id);

      const title = explicit[2].trim();
      explicitChoices.push({ id, title });
      continue;
    }

    // Looser fallback: allow "A: ..." / "B) ..." style lines (only if we find multiple).
    const loose = stripped.match(/^([A-F])\s*[：:–—.)-]\s*(.+)$/);
    if (!loose) continue;

    const id = loose[1].toUpperCase();
    if (seenLoose.has(id)) continue;
    seenLoose.add(id);

    const title = loose[2].trim();
    looseChoices.push({ id, title });
  }

  if (explicitChoices.length > 0) return explicitChoices;
  if (looseChoices.length >= 2) return looseChoices;
  return [];
}
