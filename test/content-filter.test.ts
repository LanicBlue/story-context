import { describe, it, expect } from "vitest";
import {
  matchesRule,
  filterLines,
  applyContentFilters,
  type ContentFilterRule,
} from "../src/content-filter.js";

describe("matchesRule", () => {
  it("matches substring (case insensitive by default)", () => {
    const rule: ContentFilterRule = { match: "contains", pattern: "Loading cache", granularity: "block" };
    expect(matchesRule("Loading cache from disk", rule)).toBe(true);
    expect(matchesRule("loading CACHE from disk", rule)).toBe(true);
    expect(matchesRule("Saving data", rule)).toBe(false);
  });

  it("matches substring with case sensitivity", () => {
    const rule: ContentFilterRule = {
      match: "contains",
      pattern: "Debug",
      granularity: "block",
      caseSensitive: true,
    };
    expect(matchesRule("Debug output", rule)).toBe(true);
    expect(matchesRule("debug output", rule)).toBe(false);
  });

  it("matches regex", () => {
    const rule: ContentFilterRule = {
      match: "regex",
      pattern: "^npm warn (deprecated|notice)",
      granularity: "line",
    };
    expect(matchesRule("npm warn deprecated package", rule)).toBe(true);
    expect(matchesRule("npm warn notice something", rule)).toBe(true);
    expect(matchesRule("some npm warn text", rule)).toBe(false);
  });

  it("returns false for invalid regex", () => {
    const rule: ContentFilterRule = {
      match: "regex",
      pattern: "([invalid",
      granularity: "block",
    };
    expect(matchesRule("any text", rule)).toBe(false);
  });
});

describe("filterLines", () => {
  it("removes matching lines", () => {
    const rules: ContentFilterRule[] = [
      { match: "regex", pattern: "^\\[debug\\]", granularity: "line", caseSensitive: true },
    ];
    const text = "[debug] starting\n[info] running\n[debug] done\n[info] finished";
    const result = filterLines(text, rules);
    expect(result).toBe("[info] running\n[info] finished");
  });

  it("returns null when no lines match", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "REMOVE_ME", granularity: "line" },
    ];
    expect(filterLines("keep this\nand this", rules)).toBeNull();
  });

  it("returns null when no line-level rules", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "test", granularity: "block" },
    ];
    expect(filterLines("test line", rules)).toBeNull();
  });

  it("handles empty text", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "x", granularity: "line" },
    ];
    expect(filterLines("", rules)).toBeNull();
  });
});

describe("applyContentFilters", () => {
  it("returns null when no rules", () => {
    const result = applyContentFilters([{ type: "text", text: "hello" }], []);
    expect(result.filteredBlocks).toBeNull();
    expect(result.dropMessage).toBe(false);
  });

  it("drops message on message-level match", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "internal debug", granularity: "message" },
    ];
    const result = applyContentFilters(
      [{ type: "text", text: "This is internal debug output" }],
      rules,
    );
    expect(result.dropMessage).toBe(true);
  });

  it("does not drop message when no message-level match", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "internal debug", granularity: "message" },
    ];
    const result = applyContentFilters(
      [{ type: "text", text: "Normal output" }],
      rules,
    );
    expect(result.dropMessage).toBe(false);
    expect(result.filteredBlocks).toBeNull();
  });

  it("removes matching blocks at block granularity", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "Loading cache", granularity: "block" },
    ];
    const blocks = [
      { type: "text", text: "Loading cache from disk" },
      { type: "text", text: "Processing data" },
    ];
    const result = applyContentFilters(blocks, rules);
    expect(result.dropMessage).toBe(false);
    expect(result.filteredBlocks).toEqual([{ type: "text", text: "Processing data" }]);
  });

  it("filters lines within blocks", () => {
    const rules: ContentFilterRule[] = [
      { match: "regex", pattern: "^\\[debug\\]", granularity: "line", caseSensitive: true },
    ];
    const blocks = [
      { type: "text", text: "[debug] start\n[info] running\n[debug] end" },
    ];
    const result = applyContentFilters(blocks, rules);
    expect(result.filteredBlocks).toEqual([{ type: "text", text: "[info] running" }]);
  });

  it("drops block entirely if all lines filtered", () => {
    const rules: ContentFilterRule[] = [
      { match: "regex", pattern: "^\\[debug\\]", granularity: "line", caseSensitive: true },
    ];
    const blocks = [
      { type: "text", text: "[debug] a\n[debug] b" },
    ];
    const result = applyContentFilters(blocks, rules);
    expect(result.filteredBlocks).toEqual([]);
  });

  it("handles mixed granularity rules", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "DROP_BLOCK", granularity: "block" },
      { match: "regex", pattern: "^\\[debug\\]", granularity: "line", caseSensitive: true },
    ];
    const blocks = [
      { type: "text", text: "DROP_BLOCK content" },
      { type: "text", text: "[debug] start\n[info] useful\n[debug] end" },
      { type: "text", text: "normal text" },
    ];
    const result = applyContentFilters(blocks, rules);
    expect(result.filteredBlocks!.length).toBe(2);
    expect(result.filteredBlocks![0].text).toBe("[info] useful");
    expect(result.filteredBlocks![1].text).toBe("normal text");
  });

  it("returns null when no rules match any content", () => {
    const rules: ContentFilterRule[] = [
      { match: "contains", pattern: "REMOVE", granularity: "block" },
    ];
    const blocks = [{ type: "text", text: "keep this" }];
    const result = applyContentFilters(blocks, rules);
    expect(result.filteredBlocks).toBeNull();
    expect(result.dropMessage).toBe(false);
  });
});
