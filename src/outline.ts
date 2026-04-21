export type OutlineSection = {
  lineStart: number;
  lineEnd: number;
  label: string;
  depth: number;
};

export type TextOutline = {
  totalLines: number;
  totalChars: number;
  head: string;
  sections: OutlineSection[];
  tail: string;
};

export type OutlineOptions = {
  headLines?: number;
  tailLines?: number;
  maxSections?: number;
};

const DEFAULT_OPTIONS: Required<OutlineOptions> = {
  headLines: 8,
  tailLines: 5,
  maxSections: 20,
};

export function generateOutline(
  text: string,
  options?: OutlineOptions,
): TextOutline {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines = text === "" ? [] : text.split("\n");
  const totalLines = lines.length;
  const totalChars = text.length;

  if (totalLines === 0) {
    return { totalLines: 0, totalChars: 0, head: "", sections: [], tail: "" };
  }

  // Head: first N lines
  const headCount = Math.min(opts.headLines, totalLines);
  const head = lines.slice(0, headCount).join("\n");

  // Tail: last N lines (only if no overlap with head)
  const tailStart = totalLines - opts.tailLines;
  const tail =
    tailStart >= headCount
      ? lines.slice(tailStart).join("\n")
      : "";

  // Detect section markers
  const rawMarkers: Array<{ lineNumber: number; label: string; depth: number }> = [];
  for (let i = headCount; i < tailStart; i++) {
    const marker = detectSectionMarker(lines[i], lines[i - 1] ?? "");
    if (marker) {
      rawMarkers.push({ lineNumber: i + 1, ...marker }); // 1-based
    }
  }

  // Cap sections: keep first (maxSections-1) and last one
  const sections = rawMarkers.length <= opts.maxSections
    ? rawMarkers
    : [...rawMarkers.slice(0, opts.maxSections - 1), rawMarkers[rawMarkers.length - 1]];

  // Assign line ranges
  const outlinedSections = assignLineRanges(sections, tailStart > headCount ? tailStart : totalLines);

  return { totalLines, totalChars, head, sections: outlinedSections, tail };
}

export function detectSectionMarker(
  line: string,
  prevLine: string,
): { label: string; depth: number } | null {
  const trimmed = line.trim();

  if (!trimmed) return null;

  // 1. Markdown heading: # ... ###### ...
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return { label: headingMatch[2].trim(), depth: headingMatch[1].length };
  }

  // 2. Repeated divider: --- === *** ___ ~~~
  if (/^[-=*_~]{3,}$/.test(trimmed)) {
    const label = prevLine.trim() || `Section`;
    return { label, depth: 1 };
  }

  // 3. Indented label ending with colon (use raw line for indent)
  const colonMatch = line.match(/^(\s*)([A-Z][^:\n]{2,50}):\s*$/);
  if (colonMatch) {
    const indent = colonMatch[1].length;
    return { label: colonMatch[2], depth: Math.floor(indent / 2) };
  }

  // 4. Numbered section: "1. Something" or "1 Something"
  const numberedMatch = trimmed.match(/^(\d+\.?\s+[A-Z].{2,60})/);
  if (numberedMatch) {
    return { label: numberedMatch[1].trim(), depth: 0 };
  }

  // 5. ALL CAPS line (at least 3 alpha chars, no lowercase)
  if (/^[A-Z][A-Z\s/:]{2,}$/.test(trimmed) && /[A-Z]{3}/.test(trimmed)) {
    return { label: trimmed, depth: 0 };
  }

  return null;
}

export function assignLineRanges(
  markers: Array<{ lineNumber: number; label: string; depth: number }>,
  totalLines: number,
): OutlineSection[] {
  if (markers.length === 0) return [];

  return markers.map((m, i) => {
    const nextLine = i < markers.length - 1 ? markers[i + 1].lineNumber - 1 : totalLines;
    return {
      lineStart: m.lineNumber,
      lineEnd: nextLine,
      label: m.label,
      depth: m.depth,
    };
  });
}

/** Format an outline into a human-readable context string. */
export function formatOutline(outline: TextOutline, storagePath: string): string {
  const parts: string[] = [];

  const sizeStr =
    outline.totalChars >= 1024
      ? `${(outline.totalChars / 1024).toFixed(1)}KB`
      : `${outline.totalChars} chars`;

  parts.push(`[Stored: ${storagePath} | ${outline.totalLines} lines | ${sizeStr}]`);

  if (outline.head) {
    parts.push("--- Head ---");
    parts.push(outline.head);
  }

  if (outline.sections.length > 0) {
    parts.push("--- Outline ---");
    for (const s of outline.sections) {
      const indent = "  ".repeat(s.depth);
      parts.push(`${indent}${s.label} (lines ${s.lineStart}-${s.lineEnd})`);
    }
  }

  if (outline.tail) {
    parts.push("--- Tail ---");
    parts.push(outline.tail);
  }

  return parts.join("\n");
}
