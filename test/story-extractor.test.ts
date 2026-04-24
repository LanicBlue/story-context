import { describe, it, expect } from "vitest";
import {
  parseStoryOrientedOutput,
  extractStoriesStructural,
  formatStoriesAsMarkdown,
  normalizeDimensionValue,
} from "../src/story-extractor.js";
import { TYPES, SCENARIOS, SUBJECTS, makeToolResult } from "./test-data.js";

function makeMsg(role: string, content: string, extra?: Record<string, unknown>) {
  return { role, content, ...extra };
}

describe("parseStoryOrientedOutput", () => {
  it("parses JSON array output", () => {
    const json = JSON.stringify([{
      subject: SUBJECTS.opinionAnalysis,
      type: TYPES.implementation,
      scenario: SCENARIOS.softwareCoding,
      content: "Built a multi-platform crawler pipeline with webhook integration",
    }]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe(SUBJECTS.opinionAnalysis);
    expect(stories[0].attributes.type).toBe(TYPES.implementation);
    expect(stories[0].attributes.scenario).toBe(SCENARIOS.softwareCoding);
    expect(stories[0].content).toContain("crawler pipeline");
    expect(stories[0].sourceSummary).toBe("summaries/2026-04-21-0.md");
  });

  it("parses multiple stories from JSON array", () => {
    const json = JSON.stringify([
      { subject: SUBJECTS.opinionAnalysis, type: TYPES.implementation, scenario: SCENARIOS.softwareCoding, content: "Implemented authentication module with JWT support" },
      { subject: SUBJECTS.opinionAnalysis, type: TYPES.exploration, scenario: SCENARIOS.dataEngineering, content: "Compared JWT and session-based approaches for API security" },
    ]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 10]);
    expect(stories).toHaveLength(2);
    expect(stories[0].attributes.type).toBe(TYPES.implementation);
    expect(stories[1].attributes.type).toBe(TYPES.exploration);
  });

  it("parses single JSON object (not wrapped in array)", () => {
    const json = JSON.stringify({
      subject: SUBJECTS.authModule,
      type: TYPES.implementation,
      scenario: SCENARIOS.softwareCoding,
      content: "Implemented JWT token generation and validation",
    });

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe(SUBJECTS.authModule);
    expect(stories[0].attributes.type).toBe(TYPES.implementation);
  });

  it("strips markdown code fences from JSON", () => {
    const json = "```json\n" + JSON.stringify([{
      subject: SUBJECTS.opinionAnalysis, type: TYPES.implementation, scenario: SCENARIOS.general, content: "Completed core feature development",
    }]) + "\n```";

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe(SUBJECTS.opinionAnalysis);
  });

  it("normalizes comma-separated dimension values", () => {
    const json = JSON.stringify([{
      subject: SUBJECTS.opinionAnalysis,
      type: `${TYPES.implementation},${TYPES.debugging}`,
      scenario: `${SCENARIOS.softwareCoding}，${SCENARIOS.dataEngineering}`,
      content: "Fixed the crawler pipeline after initial deployment issues",
    }]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.type).toBe(TYPES.implementation);
    expect(stories[0].attributes.scenario).toBe(SCENARIOS.softwareCoding);
  });

  it("falls back to ---STORY--- format for legacy output", () => {
    const markdown = [
      "---STORY---",
      "## subject",
      SUBJECTS.opinionAnalysis,
      "## type",
      TYPES.implementation,
      "## scenario",
      SCENARIOS.softwareCoding,
      "## content",
      "Implemented the authentication module with proper token handling",
      "---END---",
    ].join("\n");

    const stories = parseStoryOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe(SUBJECTS.opinionAnalysis);
    expect(stories[0].attributes.type).toBe(TYPES.implementation);
  });

  it("falls back to single story for unstructured output", () => {
    const markdown = "Just some plain text without story markers.";
    const stories = parseStoryOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 3]);
    expect(stories).toHaveLength(1);
    expect(stories[0].content).toBe("Just some plain text without story markers.");
    expect(stories[0].attributes.subject).toBe("unknown");
    expect(stories[0].attributes.type).toBe(TYPES.assistance);
    expect(stories[0].attributes.scenario).toBe(SCENARIOS.general);
  });

  it("uses default values for missing fields in JSON", () => {
    const json = JSON.stringify([{ content: "Some content here that is long enough" }]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 3]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe("unknown");
    expect(stories[0].attributes.type).toBe(TYPES.assistance);
    expect(stories[0].attributes.scenario).toBe(SCENARIOS.general);
  });
});

describe("normalizeDimensionValue", () => {
  it("returns value as-is when no commas", () => {
    expect(normalizeDimensionValue(TYPES.implementation)).toBe(TYPES.implementation);
  });

  it("takes first value from comma-separated list", () => {
    expect(normalizeDimensionValue(`${TYPES.implementation},${TYPES.debugging}`)).toBe(TYPES.implementation);
  });

  it("handles Chinese comma", () => {
    expect(normalizeDimensionValue("软件开发，故障排查")).toBe("软件开发");
  });

  it("handles Chinese enumeration comma", () => {
    expect(normalizeDimensionValue(`${SCENARIOS.softwareCoding}、${SCENARIOS.dataEngineering}`)).toBe(SCENARIOS.softwareCoding);
  });

  it("trims whitespace", () => {
    expect(normalizeDimensionValue(`  ${TYPES.implementation}  `)).toBe(TYPES.implementation);
  });
});

describe("formatStoriesAsMarkdown", () => {
  it("formats stories as structured markdown", () => {
    const stories = parseStoryOrientedOutput(
      JSON.stringify([
        { subject: "auth", type: TYPES.implementation, scenario: SCENARIOS.softwareCoding, content: "Built auth module." },
        { subject: "auth", type: TYPES.debugging, scenario: SCENARIOS.systemOps, content: "Fixed token expiry bug." },
      ]),
      "summaries/test.md",
      [0, 10],
    );

    const md = formatStoriesAsMarkdown(stories);
    expect(md).toContain(`## 1. auth — ${TYPES.implementation} · ${SCENARIOS.softwareCoding}`);
    expect(md).toContain(`## 2. auth — ${TYPES.debugging} · ${SCENARIOS.systemOps}`);
    expect(md).toContain("Built auth module.");
    expect(md).toContain("---");
  });

  it("returns empty string for empty array", () => {
    expect(formatStoriesAsMarkdown([])).toBe("");
  });
});

describe("extractStoriesStructural", () => {
  it("extracts stories from tool-heavy messages", () => {
    const messages = [
      makeMsg("user", "Fix the login bug"),
      makeToolResult("read_file", "old code", { path: "src/auth.ts" }),
      makeToolResult("write_file", "fixed", { path: "src/auth.ts" }),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 3]);
    expect(stories.length).toBeGreaterThanOrEqual(1);
    expect(stories[0].content).toBeTruthy();
    expect(stories[0].attributes.subject).toBeTruthy();
  });

  it("extracts type as implementation when write_file present", () => {
    const messages = [
      makeToolResult("write_file", "wrote file", { path: "src/utils.ts" }),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 1]);
    expect(stories[0].attributes.type).toBe(TYPES.implementation);
  });

  it("extracts type as debugging when shell error present", () => {
    const messages = [
      makeToolResult("run_shell", "Error: something failed"),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 1]);
    expect(stories[0].attributes.type).toBe(TYPES.debugging);
  });

  it("handles empty messages", () => {
    const stories = extractStoriesStructural([], "summaries/2026-04-21-0.md", [0, 0]);
    expect(stories).toHaveLength(0);
  });

  it("splits segments on new user message with no file overlap", () => {
    const messages = [
      makeMsg("user", "First task"),
      makeToolResult("read_file", "content", { path: "src/a.ts" }),
      makeMsg("user", "Completely different task"),
      makeToolResult("read_file", "content", { path: "src/b.ts" }),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 4]);
    expect(stories.length).toBeGreaterThanOrEqual(1);
  });
});
