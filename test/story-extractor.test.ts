import { describe, it, expect } from "vitest";
import {
  parseStoryOrientedOutput,
  extractStoriesStructural,
} from "../src/story-extractor.js";

function makeMsg(role: string, content: string, extra?: Record<string, unknown>) {
  return { role, content, ...extra };
}

function makeTool(toolName: string, content: string, args?: Record<string, unknown>) {
  return makeMsg("toolResult", content, { toolName, args: args ?? {} });
}

describe("parseStoryOrientedOutput", () => {
  it("parses JSON array output", () => {
    const json = JSON.stringify([{
      subject: "XX项目",
      type: "软件开发",
      scenario: "Web应用",
      content: "实现了用户认证模块，包括JWT token生成和验证",
    }]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe("XX项目");
    expect(stories[0].attributes.type).toBe("软件开发");
    expect(stories[0].attributes.scenario).toBe("Web应用");
    expect(stories[0].content).toContain("认证模块");
    expect(stories[0].sourceSummary).toBe("summaries/2026-04-21-0.md");
  });

  it("parses multiple stories from JSON array", () => {
    const json = JSON.stringify([
      { subject: "XX项目", type: "软件开发", scenario: "Web应用", content: "实现了用户认证模块的功能开发" },
      { subject: "XX项目", type: "调研", scenario: "技术选型", content: "对比了 JWT 和 session 方案的优缺点" },
    ]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 10]);
    expect(stories).toHaveLength(2);
    expect(stories[0].attributes.type).toBe("软件开发");
    expect(stories[1].attributes.type).toBe("调研");
  });

  it("strips markdown code fences from JSON", () => {
    const json = "```json\n" + JSON.stringify([{
      subject: "XX项目", type: "软件开发", scenario: "通用", content: "完成了核心功能的开发工作",
    }]) + "\n```";

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe("XX项目");
  });

  it("falls back to ---STORY--- format for legacy output", () => {
    const markdown = [
      "---STORY---",
      "## subject",
      "XX项目",
      "## type",
      "软件开发",
      "## scenario",
      "Web应用",
      "## content",
      "实现了用户认证模块，包括JWT token生成和验证",
      "---END---",
    ].join("\n");

    const stories = parseStoryOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 5]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe("XX项目");
  });

  it("falls back to single story for unstructured output", () => {
    const markdown = "Just some plain text without story markers.";
    const stories = parseStoryOrientedOutput(markdown, "summaries/2026-04-21-0.md", [0, 3]);
    expect(stories).toHaveLength(1);
    expect(stories[0].content).toBe("Just some plain text without story markers.");
    expect(stories[0].attributes.subject).toBe("未知");
  });

  it("uses default values for missing fields in JSON", () => {
    const json = JSON.stringify([{ content: "Some content here that is long enough" }]);

    const stories = parseStoryOrientedOutput(json, "summaries/2026-04-21-0.md", [0, 3]);
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe("未知");
    expect(stories[0].attributes.type).toBe("对话");
    expect(stories[0].attributes.scenario).toBe("通用");
  });
});

describe("extractStoriesStructural", () => {
  it("extracts stories from tool-heavy messages", () => {
    const messages = [
      makeMsg("user", "Fix the login bug"),
      makeTool("read_file", "old code", { path: "src/auth.ts" }),
      makeTool("write_file", "fixed", { path: "src/auth.ts" }),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 3]);
    expect(stories.length).toBeGreaterThanOrEqual(1);
    expect(stories[0].content).toBeTruthy();
    expect(stories[0].attributes.subject).toBeTruthy();
  });

  it("extracts type as 软件开发 when write_file present", () => {
    const messages = [
      makeTool("write_file", "wrote file", { path: "src/utils.ts" }),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 1]);
    expect(stories[0].attributes.type).toBe("软件开发");
  });

  it("extracts type as 故障排查 when shell error present", () => {
    const messages = [
      makeTool("run_shell", "Error: something failed"),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 1]);
    expect(stories[0].attributes.type).toBe("故障排查");
  });

  it("handles empty messages", () => {
    const stories = extractStoriesStructural([], "summaries/2026-04-21-0.md", [0, 0]);
    expect(stories).toHaveLength(0);
  });

  it("splits segments on new user message with no file overlap", () => {
    const messages = [
      makeMsg("user", "First task"),
      makeTool("read_file", "content", { path: "src/a.ts" }),
      makeMsg("user", "Completely different task"),
      makeTool("read_file", "content", { path: "src/b.ts" }),
    ];

    const stories = extractStoriesStructural(messages, "summaries/2026-04-21-0.md", [0, 4]);
    expect(stories.length).toBeGreaterThanOrEqual(1);
  });
});
