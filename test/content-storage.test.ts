import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ContentStorage } from "../src/content-storage.js";

let testDir: string;
let storage: ContentStorage;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "sc-test-"));
  storage = new ContentStorage(testDir);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("ContentStorage", () => {
  it("stores text and returns relative path", async () => {
    const path = await storage.storeText("sess-1", "hello world");
    expect(path).toMatch(/^text\/content-[0-9a-f]{12}\.txt$/);

    // Verify file content
    const content = await storage.read("sess-1", path);
    expect(content.toString("utf-8")).toBe("hello world");
  });

  it("detects JSON content and uses .json extension", async () => {
    const path = await storage.storeText("sess-1", '{"key": "value"}');
    expect(path).toMatch(/\.json$/);
  });

  it("detects CSV content and uses .csv extension", async () => {
    const csv = "a,b,c\n1,2,3\n4,5,6";
    const path = await storage.storeText("sess-1", csv);
    expect(path).toMatch(/\.csv$/);
  });

  it("uses .txt for plain text", async () => {
    const path = await storage.storeText("sess-1", "just some text\nno structure");
    expect(path).toMatch(/\.txt$/);
  });

  it("deduplicates same content (same hash)", async () => {
    const path1 = await storage.storeText("sess-1", "duplicate content");
    const path2 = await storage.storeText("sess-1", "duplicate content");
    expect(path1).toBe(path2);
  });

  it("stores media with correct extension", async () => {
    const data = Buffer.from("fake image data");
    const path = await storage.storeMedia("sess-1", data, "image/png", "img");
    expect(path).toMatch(/^media\/img-[0-9a-f]{12}\.png$/);

    const content = await storage.read("sess-1", path);
    expect(content.toString()).toBe("fake image data");
  });

  it("defaults to .bin for unknown media type", async () => {
    const data = Buffer.from("binary");
    const path = await storage.storeMedia("sess-1", data, "application/x-unknown");
    expect(path).toMatch(/\.bin$/);
  });

  it("resolves absolute paths correctly", () => {
    const abs = storage.resolvePath("sess-1", "text/content-abc.txt");
    expect(abs).toBe(join(testDir, "sess-1", "text", "content-abc.txt"));
  });

  it("cleans up session directory", async () => {
    await storage.storeText("sess-1", "data");
    await storage.storeMedia("sess-1", Buffer.from("img"), "image/png");

    await storage.cleanupSession("sess-1");

    await expect(stat(join(testDir, "sess-1"))).rejects.toThrow();
  });

  it("cleanup is safe for non-existent session", async () => {
    await expect(storage.cleanupSession("nonexistent")).resolves.toBeUndefined();
  });

  it("isolates different sessions", async () => {
    const path1 = await storage.storeText("sess-a", "session a data");
    const path2 = await storage.storeText("sess-b", "session b data");

    const contentA = await storage.read("sess-a", path1);
    const contentB = await storage.read("sess-b", path2);

    expect(contentA.toString()).toBe("session a data");
    expect(contentB.toString()).toBe("session b data");
  });

  it("inferMediaExtension covers common types", () => {
    expect(storage.inferMediaExtension("image/jpeg")).toBe(".jpg");
    expect(storage.inferMediaExtension("audio/mpeg")).toBe(".mp3");
    expect(storage.inferMediaExtension("application/pdf")).toBe(".pdf");
    expect(storage.inferMediaExtension()).toBe(".bin");
  });
});
