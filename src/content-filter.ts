export type ContentFilterGranularity = "message" | "block" | "line";

export type ContentFilterRule = {
  match: "contains" | "regex";
  pattern: string;
  caseSensitive?: boolean;
  granularity: ContentFilterGranularity;
};

export type TextBlock = {
  type: string;
  text: string;
};

export type FilterResult = {
  filteredBlocks: TextBlock[] | null;
  dropMessage: boolean;
};

/** Check if text matches a single rule. */
export function matchesRule(text: string, rule: ContentFilterRule): boolean {
  if (rule.match === "contains") {
    return rule.caseSensitive
      ? text.includes(rule.pattern)
      : text.toLowerCase().includes(rule.pattern.toLowerCase());
  }

  // regex
  try {
    const flags = rule.caseSensitive ? "" : "i";
    const re = new RegExp(rule.pattern, flags);
    return re.test(text);
  } catch {
    return false;
  }
}

/** Remove matching lines from text. Returns null if no lines matched (no change needed). */
export function filterLines(text: string, rules: ContentFilterRule[]): string | null {
  const lineRules = rules.filter((r) => r.granularity === "line");
  if (lineRules.length === 0) return null;

  const lines = text.split("\n");
  const remaining: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const shouldRemove = lineRules.some((r) => matchesRule(line, r));
    if (shouldRemove) {
      removed++;
    } else {
      remaining.push(line);
    }
  }

  return removed > 0 ? remaining.join("\n") : null;
}

/** Apply all content filters to a list of text blocks. */
export function applyContentFilters(blocks: TextBlock[], rules: ContentFilterRule[]): FilterResult {
  if (rules.length === 0 || blocks.length === 0) {
    return { filteredBlocks: null, dropMessage: false };
  }

  // Check message-level rules against all text combined
  const messageRules = rules.filter((r) => r.granularity === "message");
  if (messageRules.length > 0) {
    const fullText = blocks.map((b) => b.text).join(" ");
    for (const rule of messageRules) {
      if (matchesRule(fullText, rule)) {
        return { filteredBlocks: null, dropMessage: true };
      }
    }
  }

  // Process per-block and per-line rules
  let changed = false;
  const result: TextBlock[] = [];

  for (const block of blocks) {
    // Check block-level rules
    const blockRules = rules.filter((r) => r.granularity === "block");
    const blockMatched = blockRules.some((r) => matchesRule(block.text, r));
    if (blockMatched) {
      changed = true;
      continue; // Drop this block
    }

    // Apply line-level filtering
    const filtered = filterLines(block.text, rules);
    if (filtered !== null) {
      changed = true;
      if (filtered.length > 0) {
        result.push({ type: block.type, text: filtered });
      }
      // If all lines removed, drop the block entirely
    } else {
      result.push(block);
    }
  }

  return {
    filteredBlocks: changed ? result : null,
    dropMessage: false,
  };
}
