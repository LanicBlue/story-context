import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ContentProcessor } from "../src/content-processor.js";
import { ContentStorage } from "../src/content-storage.js";
import type { ContentFilterRule } from "../src/content-filter.js";
import type { Summarizer } from "../src/types.js";

let testDir: string;
let storage: ContentStorage;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cp-test-"));
  storage = new ContentStorage(testDir);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeProcessor(
  overrides: {
    largeTextThreshold?: number;
    contentFilters?: ContentFilterRule[];
    outlineSummaryEnabled?: boolean;
  } = {},
  summarizer?: Summarizer,
) {
  return new ContentProcessor(
    {
      largeTextThreshold: overrides.largeTextThreshold ?? 2000,
      outlineHeadLines: 3,
      outlineTailLines: 2,
      outlineMaxSections: 10,
      contentFilters: overrides.contentFilters ?? [],
      outlineSummaryEnabled: overrides.outlineSummaryEnabled ?? false,
    },
    storage,
    summarizer,
  );
}

describe("ContentProcessor", () => {
  describe("short text passthrough", () => {
    it("passes through short string content", async () => {
      const cp = makeProcessor();
      const result = await cp.processContent("short text", "s1");
      expect(result.dropMessage).toBe(false);
      expect(result.contextText).toBe("short text");
    });

    it("passes through text block below threshold", async () => {
      const cp = makeProcessor({ largeTextThreshold: 500 });
      const result = await cp.processContent(
        { type: "text", text: "a".repeat(400) },
        "s1",
      );
      expect(result.contextText).toBe("a".repeat(400));
    });
  });

  describe("large text processing", () => {
    it("stores large text and returns outline", async () => {
      const cp = makeProcessor({ largeTextThreshold: 100 });
      const longText = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

      const result = await cp.processContent(longText, "s1");
      expect(result.contextText).toContain("[Stored:");
      expect(result.contextText).toContain("text/content-");
      expect(result.contextText).toContain("50 lines");
      expect(result.contextText).toContain("--- Head ---");
      expect(result.contextText).toContain("--- Tail ---");
    });

    it("stores large text from array content", async () => {
      const cp = makeProcessor({ largeTextThreshold: 100 });
      const longText = "x".repeat(200);

      const result = await cp.processContent(
        [{ type: "text", text: longText }],
        "s1",
      );
      expect(result.contextText).toContain("[Stored:");
    });

    it("includes AI summary when enabled and summarizer available", async () => {
      const mockSummarizer: Summarizer = {
        summarize: async () => "Key findings: 3 errors found",
      };
      const cp = makeProcessor(
        { largeTextThreshold: 100, outlineSummaryEnabled: true },
        mockSummarizer,
      );

      const result = await cp.processContent("x".repeat(200), "s1");
      expect(result.contextText).toContain("--- AI Summary ---");
      expect(result.contextText).toContain("Key findings: 3 errors found");
    });

    it("skips AI summary when not enabled even if summarizer exists", async () => {
      const mockSummarizer: Summarizer = {
        summarize: async () => "summary",
      };
      const cp = makeProcessor(
        { largeTextThreshold: 100, outlineSummaryEnabled: false },
        mockSummarizer,
      );

      const result = await cp.processContent("x".repeat(200), "s1");
      expect(result.contextText).not.toContain("--- AI Summary ---");
    });
  });

  describe("media handling", () => {
    it("stores image block and returns metadata", async () => {
      const cp = makeProcessor();
      const imageData = Buffer.from("fake png data").toString("base64");

      const result = await cp.processContent(
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: imageData },
        },
        "s1",
      );
      expect(result.contextText).toContain("image stored:");
      expect(result.contextText).toContain("image/png");
      expect(result.contextText).toContain("img-");
    });

    it("stores file block with name", async () => {
      const cp = makeProcessor();
      const fileData = Buffer.from("pdf content").toString("base64");

      const result = await cp.processContent(
        {
          type: "file",
          name: "report.pdf",
          data: fileData,
          mediaType: "application/pdf",
        },
        "s1",
      );
      expect(result.contextText).toContain("file stored:");
      expect(result.contextText).toContain("name=report.pdf");
      expect(result.contextText).toContain("application/pdf");
    });

    it("handles image with data URI prefix", async () => {
      const cp = makeProcessor();
      const dataUri = `data:image/png;base64,${Buffer.from("img").toString("base64")}`;

      const result = await cp.processContent(
        { type: "image", source: { type: "base64", data: dataUri } },
        "s1",
      );
      expect(result.contextText).toContain("image stored:");
    });

    it("handles media block with no data", async () => {
      const cp = makeProcessor();
      const result = await cp.processContent(
        { type: "image", source: { type: "url", url: "https://example.com/img.png" } },
        "s1",
      );
      expect(result.contextText).toContain("image stored:");
      // URL source: URL is stored as the media content
      expect(result.contextText).toContain("27 bytes");
    });
  });

  describe("mixed content", () => {
    it("processes text + image in same message", async () => {
      const cp = makeProcessor();
      const result = await cp.processContent(
        [
          { type: "text", text: "Here is the screenshot:" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from("screenshot").toString("base64"),
            },
          },
          { type: "text", text: "The error is visible above." },
        ],
        "s1",
      );
      expect(result.contextText).toContain("Here is the screenshot:");
      expect(result.contextText).toContain("image stored:");
      expect(result.contextText).toContain("The error is visible above.");
    });
  });

  describe("content filtering", () => {
    it("drops message when filter matches at message level", async () => {
      const cp = makeProcessor({
        contentFilters: [
          { match: "contains", pattern: "internal debug", granularity: "message" },
        ],
      });
      const result = await cp.processContent("internal debug output", "s1");
      expect(result.dropMessage).toBe(true);
      expect(result.contextText).toBe("");
    });

    it("removes blocks at block granularity", async () => {
      const cp = makeProcessor({
        contentFilters: [
          { match: "contains", pattern: "Loading cache", granularity: "block" },
        ],
      });
      const result = await cp.processContent(
        [
          { type: "text", text: "Loading cache from disk" },
          { type: "text", text: "Processing data" },
        ],
        "s1",
      );
      expect(result.dropMessage).toBe(false);
      expect(result.contextText).not.toContain("Loading cache");
      expect(result.contextText).toContain("Processing data");
    });

    it("filters lines at line granularity", async () => {
      const cp = makeProcessor({
        contentFilters: [
          {
            match: "regex",
            pattern: "^\\[debug\\]",
            granularity: "line",
            caseSensitive: true,
          },
        ],
      });
      const result = await cp.processContent(
        "[debug] start\n[info] useful\n[debug] end",
        "s1",
      );
      expect(result.contextText).toBe("[info] useful");
    });
  });

  describe("cleanup", () => {
    it("cleans up session files", async () => {
      const cp = makeProcessor({ largeTextThreshold: 10 });
      await cp.processContent("x".repeat(50), "s1");
      await cp.cleanupSession("s1");
      // Should not throw; directory removed
      await expect(cp.cleanupSession("s1")).resolves.toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles null content", async () => {
      const cp = makeProcessor();
      const result = await cp.processContent(null, "s1");
      expect(result.contextText).toBe("");
      expect(result.dropMessage).toBe(false);
    });

    it("handles empty string content", async () => {
      const cp = makeProcessor();
      const result = await cp.processContent("", "s1");
      expect(result.contextText).toBe("");
    });

    it("handles unknown block types", async () => {
      const cp = makeProcessor();
      const result = await cp.processContent(
        { type: "custom", text: "custom content" },
        "s1",
      );
      expect(result.contextText).toBe("custom content");
    });
  });
});
