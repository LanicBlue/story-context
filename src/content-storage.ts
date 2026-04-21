import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

export class ContentStorage {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || join(tmpdir(), "smart-context");
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Generate a short deterministic hash for content dedup. */
  private contentHash(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex").slice(0, 12);
  }

  /** Infer file extension from text content heuristics. */
  private inferTextExtension(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        return ".json";
      } catch { /* not JSON */ }
    }
    // Check for CSV: consistent comma count across first few lines
    const lines = trimmed.split("\n").slice(0, 5);
    if (lines.length >= 2) {
      const commaCounts = lines.map((l) => (l.match(/,/g) || []).length);
      if (commaCounts.every((c) => c > 0 && c === commaCounts[0])) {
        return ".csv";
      }
    }
    return ".txt";
  }

  /** Infer extension from MIME type. */
  inferMediaExtension(mediaType?: string): string {
    if (!mediaType) return ".bin";
    const map: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "audio/mpeg": ".mp3",
      "audio/wav": ".wav",
      "audio/ogg": ".ogg",
      "audio/mp4": ".m4a",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/gzip": ".gz",
    };
    return map[mediaType] || ".bin";
  }

  /** Store large text to disk. Returns storage-relative path. */
  async storeText(sessionId: string, text: string): Promise<string> {
    const hash = this.contentHash(text);
    const ext = this.inferTextExtension(text);
    const relPath = `text/content-${hash}${ext}`;
    const absPath = join(this.sessionDir(sessionId), relPath);

    await this.ensureDir(dirname(absPath));
    await writeFile(absPath, text, "utf-8");
    return relPath;
  }

  /** Store media binary to disk. Returns storage-relative path. */
  async storeMedia(
    sessionId: string,
    data: Buffer,
    mediaType?: string,
    prefix = "media",
  ): Promise<string> {
    const hash = this.contentHash(data);
    const ext = this.inferMediaExtension(mediaType);
    const relPath = `media/${prefix}-${hash}${ext}`;
    const absPath = join(this.sessionDir(sessionId), relPath);

    await this.ensureDir(dirname(absPath));
    await writeFile(absPath, data);
    return relPath;
  }

  /** Read a stored file back. */
  async read(sessionId: string, storagePath: string): Promise<Buffer> {
    const absPath = this.resolvePath(sessionId, storagePath);
    return readFile(absPath);
  }

  /** Resolve to absolute filesystem path. */
  resolvePath(sessionId: string, storagePath: string): string {
    return join(this.sessionDir(sessionId), storagePath);
  }

  /** Delete all stored files for a session. */
  async cleanupSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await rm(dir, { recursive: true, force: true });
  }
}
