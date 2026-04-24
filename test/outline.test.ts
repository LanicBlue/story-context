import { describe, it, expect } from "vitest";
import {
  generateOutline,
  detectSectionMarker,
  assignLineRanges,
  formatOutline,
  type TextOutline,
} from "../src/outline.js";

describe("generateOutline", () => {
  it("returns empty for empty string", () => {
    const o = generateOutline("");
    expect(o.totalLines).toBe(0);
    expect(o.totalChars).toBe(0);
    expect(o.head).toBe("");
    expect(o.sections).toEqual([]);
    expect(o.tail).toBe("");
  });

  it("captures short text as head only", () => {
    const o = generateOutline("hello\nworld");
    expect(o.totalLines).toBe(2);
    expect(o.head).toBe("hello\nworld");
    expect(o.sections).toEqual([]);
    expect(o.tail).toBe("");
  });

  it("extracts head and tail from long plain text", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const o = generateOutline(text, { headLines: 3, tailLines: 3 });

    expect(o.head.split("\n").length).toBe(3);
    expect(o.head).toContain("line 1");
    expect(o.tail.split("\n").length).toBe(3);
    expect(o.tail).toContain("line 50");
    expect(o.sections).toEqual([]);
  });

  it("detects markdown headings as sections", () => {
    const text = [
      "# Title",
      "intro",
      "## Section A",
      "content a",
      "### Subsection",
      "sub content",
      "## Section B",
      "content b",
    ].join("\n");

    const o = generateOutline(text, { headLines: 2, tailLines: 1 });
    expect(o.sections.length).toBeGreaterThanOrEqual(2);
    expect(o.sections[0].label).toBe("Section A");
    expect(o.sections[0].depth).toBe(2);
    expect(o.sections.find((s) => s.label === "Subsection")?.depth).toBe(3);
    expect(o.sections.find((s) => s.label === "Section B")?.depth).toBe(2);
  });

  it("detects divider lines with previous-line labels", () => {
    const text = [
      "Config",
      "=======",
      "value: 42",
      "Network",
      "-------",
      "port: 8080",
    ].join("\n");

    const o = generateOutline(text, { headLines: 1, tailLines: 1 });
    expect(o.sections.length).toBe(2);
    expect(o.sections[0].label).toBe("Config");
    expect(o.sections[1].label).toBe("Network");
  });

  it("detects ALL CAPS section markers", () => {
    const text = [
      "HEADER",
      "some content",
      "ANOTHER SECTION",
      "more content",
    ].join("\n");

    const o = generateOutline(text, { headLines: 1, tailLines: 1 });
    expect(o.sections.length).toBe(1);
    expect(o.sections[0].label).toBe("ANOTHER SECTION");
  });

  it("detects numbered sections", () => {
    const text = [
      "1. First step",
      "do thing",
      "2. Second step",
      "do another thing",
      "3. Third step",
      "finish",
    ].join("\n");

    const o = generateOutline(text, { headLines: 1, tailLines: 1 });
    expect(o.sections.length).toBeGreaterThanOrEqual(1);
    expect(o.sections[0].label).toContain("Second step");
  });

  it("respects maxSections cap", () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      i % 10 === 0 ? `## Section ${i / 10}` : `content ${i}`,
    );
    const text = lines.join("\n");
    const o = generateOutline(text, { headLines: 2, tailLines: 2, maxSections: 3 });
    expect(o.sections.length).toBe(3);
  });

  it("tail does not overlap with head", () => {
    const text = "only\nthree\nlines";
    const o = generateOutline(text, { headLines: 5, tailLines: 3 });
    expect(o.tail).toBe("");
    expect(o.head.split("\n").length).toBe(3);
  });
});

describe("detectSectionMarker", () => {
  it("detects markdown headings", () => {
    expect(detectSectionMarker("# Title", "")).toEqual({ label: "Title", depth: 1 });
    expect(detectSectionMarker("### Sub", "")).toEqual({ label: "Sub", depth: 3 });
  });

  it("detects dividers using previous line as label", () => {
    expect(detectSectionMarker("===", "Config")).toEqual({ label: "Config", depth: 1 });
    expect(detectSectionMarker("---", "")).toEqual({ label: "Section", depth: 1 });
  });

  it("detects colon labels", () => {
    expect(detectSectionMarker("Dependencies:", "")).toEqual({ label: "Dependencies", depth: 0 });
    expect(detectSectionMarker("  Nested section:", "")).toEqual({ label: "Nested section", depth: 1 });
  });

  it("detects numbered items", () => {
    expect(detectSectionMarker("1. Install dependencies", "")).toEqual({
      label: "1. Install dependencies",
      depth: 0,
    });
  });

  it("detects ALL CAPS lines", () => {
    expect(detectSectionMarker("ERROR LOG", "")).toEqual({ label: "ERROR LOG", depth: 0 });
  });

  it("returns null for plain text", () => {
    expect(detectSectionMarker("just some text", "")).toBeNull();
    expect(detectSectionMarker("", "")).toBeNull();
    expect(detectSectionMarker("a", "")).toBeNull();
  });
});

describe("assignLineRanges", () => {
  it("assigns correct ranges", () => {
    const markers = [
      { lineNumber: 5, label: "A", depth: 0 },
      { lineNumber: 10, label: "B", depth: 0 },
      { lineNumber: 20, label: "C", depth: 0 },
    ];
    const result = assignLineRanges(markers, 30);
    expect(result[0]).toEqual({ lineStart: 5, lineEnd: 9, label: "A", depth: 0 });
    expect(result[1]).toEqual({ lineStart: 10, lineEnd: 19, label: "B", depth: 0 });
    expect(result[2]).toEqual({ lineStart: 20, lineEnd: 30, label: "C", depth: 0 });
  });

  it("returns empty for no markers", () => {
    expect(assignLineRanges([], 100)).toEqual([]);
  });
});

describe("formatOutline", () => {
  it("formats a complete outline", () => {
    const outline: TextOutline = {
      totalLines: 100,
      totalChars: 5000,
      head: "line 1\nline 2",
      sections: [
        { lineStart: 10, lineEnd: 30, label: "Section A", depth: 0 },
        { lineStart: 15, lineEnd: 25, label: "Sub A", depth: 1 },
      ],
      tail: "line 99\nline 100",
    };
    const result = formatOutline(outline, "text/content-abc.txt");

    expect(result).toContain("[Stored: text/content-abc.txt | 100 lines | 4.9KB]");
    expect(result).toContain("--- Head ---");
    expect(result).toContain("line 1");
    expect(result).toContain("--- Outline ---");
    expect(result).toContain("Section A (lines 10-30)");
    expect(result).toContain("  Sub A (lines 15-25)");
    expect(result).toContain("--- Tail ---");
    expect(result).toContain("line 100");
  });

  it("handles small sizes without KB", () => {
    const outline: TextOutline = {
      totalLines: 5,
      totalChars: 500,
      head: "content",
      sections: [],
      tail: "",
    };
    const result = formatOutline(outline, "text/content-small.txt");
    expect(result).toContain("500 chars");
  });
});
