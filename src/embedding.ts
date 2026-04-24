/**
 * Embedding service for semantic story matching.
 * Uses Ollama /api/embeddings endpoint.
 */

export type EmbeddingService = {
  embed(text: string): Promise<number[]>;
};

export class OllamaEmbedding implements EmbeddingService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, model: string, timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embedding HTTP ${response.status}: ${body}`);
    }

    const json = (await response.json()) as { embedding?: number[] };
    if (!json.embedding || !Array.isArray(json.embedding)) {
      throw new Error("Invalid embedding response");
    }
    return json.embedding;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Serialize Float64 array to Buffer for SQLite BLOB storage. */
export function serializeEmbedding(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 8);
  for (let i = 0; i < vec.length; i++) {
    buf.writeDoubleLE(vec[i], i * 8);
  }
  return buf;
}

/** Deserialize Buffer from SQLite BLOB to Float64 array. */
export function deserializeEmbedding(buf: Buffer, length: number): number[] {
  const vec: number[] = new Array(length);
  for (let i = 0; i < length; i++) {
    vec[i] = buf.readDoubleLE(i * 8);
  }
  return vec;
}
