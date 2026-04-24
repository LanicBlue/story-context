import { describe, it, expect } from "vitest";
import { cosineSimilarity, serializeEmbedding, deserializeEmbedding } from "../src/embedding.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const vec = [1, 2, 3, 4];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it("computes similarity correctly", () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(32 / Math.sqrt(14 * 77));
  });
});

describe("serializeEmbedding / deserializeEmbedding", () => {
  it("round-trips a vector correctly", () => {
    const vec = [0.1, -0.5, 0.999, 0.0, -1.234];
    const buf = serializeEmbedding(vec);
    const restored = deserializeEmbedding(buf, vec.length);
    expect(restored.length).toBe(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i], 10);
    }
  });

  it("handles empty vector", () => {
    const buf = serializeEmbedding([]);
    expect(buf.length).toBe(0);
    expect(deserializeEmbedding(buf, 0)).toEqual([]);
  });
});
