import { describe, it, expect } from "vitest";
import {
  parseEventOrientedOutput,
  extractEventsStructural,
} from "../src/event-extractor.js";

function makeMsg(role: string, content: string, extra?: Record<string, unknown>) {
  return { role, content, ...extra };
}

function makeTool(toolName: string, content: string, args?: Record<string, unknown>) {
  return makeMsg("toolResult", content, { toolName, args: args ?? {} });
}

describe("parseEventOrientedOutput", () => {
  it("parses a single event block", () => {
    const markdown = [
      "---EVENT---",
      "## subject",
      "XX项目",
      "## type",
      "软件开发",
      "## scenario",
      "Web应用",
      "## content",
      "实现了认证模块",
      "---END---",
    ].join("\n");

    const events = parseEventOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 5]);
    expect(events).toHaveLength(1);
    expect(events[0].attributes.subject).toBe("XX项目");
    expect(events[0].attributes.type).toBe("软件开发");
    expect(events[0].attributes.scenario).toBe("Web应用");
    expect(events[0].content).toContain("认证模块");
    expect(events[0].sourceSummary).toBe("summaries/2026-04-21-0.md");
  });

  it("parses multiple event blocks", () => {
    const markdown = [
      "---EVENT---",
      "## subject",
      "XX项目",
      "## type",
      "软件开发",
      "## scenario",
      "Web应用",
      "## content",
      "实现认证",
      "---END---",
      "---EVENT---",
      "## subject",
      "XX项目",
      "## type",
      "调研",
      "## scenario",
      "技术选型",
      "## content",
      "对比了 JWT 和 session",
      "---END---",
    ].join("\n");

    const events = parseEventOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 10]);
    expect(events).toHaveLength(2);
    expect(events[0].attributes.type).toBe("软件开发");
    expect(events[1].attributes.type).toBe("调研");
  });

  it("falls back to single event for unstructured output", () => {
    const markdown = "Just some plain text without event markers.";
    const events = parseEventOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 3]);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Just some plain text without event markers.");
    expect(events[0].attributes.subject).toBe("未知");
  });

  it("uses default values for missing attributes", () => {
    const markdown = [
      "---EVENT---",
      "## content",
      "Some content here",
      "---END---",
    ].join("\n");

    const events = parseEventOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 3]);
    expect(events).toHaveLength(1);
    expect(events[0].attributes.subject).toBe("未知");
    expect(events[0].attributes.type).toBe("对话");
    expect(events[0].attributes.scenario).toBe("通用");
  });
});

describe("extractEventsStructural", () => {
  it("extracts events from tool-heavy messages", () => {
    const messages = [
      makeMsg("user", "Fix the login bug"),
      makeTool("read_file", "old code", { path: "src/auth.ts" }),
      makeTool("write_file", "fixed", { path: "src/auth.ts" }),
    ];

    const events = extractEventsStructural(messages, "summaries/2026-04-21-0.md", [0, 3]);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].content).toBeTruthy();
    expect(events[0].attributes.subject).toBeTruthy();
  });

  it("extracts type as 软件开发 when write_file present", () => {
    const messages = [
      makeTool("write_file", "wrote file", { path: "src/utils.ts" }),
    ];

    const events = extractEventsStructural(messages, "summaries/2026-04-21-0.md", [0, 1]);
    expect(events[0].attributes.type).toBe("软件开发");
  });

  it("extracts type as 故障排查 when shell error present", () => {
    const messages = [
      makeTool("run_shell", "Error: something failed"),
    ];

    const events = extractEventsStructural(messages, "summaries/2026-04-21-0.md", [0, 1]);
    expect(events[0].attributes.type).toBe("故障排查");
  });

  it("handles empty messages", () => {
    const events = extractEventsStructural([], "summaries/2026-04-21-0.md", [0, 0]);
    expect(events).toHaveLength(0);
  });

  it("splits segments on new user message with no file overlap", () => {
    const messages = [
      makeMsg("user", "First task"),
      makeTool("read_file", "content", { path: "src/a.ts" }),
      makeMsg("user", "Completely different task"),
      makeTool("read_file", "content", { path: "src/b.ts" }),
    ];

    const events = extractEventsStructural(messages, "summaries/2026-04-21-0.md", [0, 4]);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
