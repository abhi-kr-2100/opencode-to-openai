import { describe, expect, test } from "bun:test";
import { BadRequestError } from "../http/errors.ts";
import { HuggingFaceEmbeddingsService, type FeatureExtractor } from "./embeddings.ts";
import { createRecordingPipeline, type RecordingPipeline } from "../testing/recordingPipeline.ts";

// Stub the "feature-extraction" pipeline. It is injected via the constructor
// so the module under test always uses the real "@huggingface/transformers".
const stubTokenizerEncode = (text: string): number[] => {
  return Array.from({ length: text.split(" ").length }, () => 0);
};

const stubExtractor: FeatureExtractor = async (inputs, _options) => {
  // Return dummy embeddings (e.g., all 0.5, normalized)
  const stubList = (Array.isArray(inputs) ? inputs : [inputs]).map(() => {
    // Generate a vector of length 4: [0.5, 0.5, 0.5, 0.5] which L2 normalizes to [0.5, 0.5, 0.5, 0.5]
    return [0.5, 0.5, 0.5, 0.5];
  });
  return {
    tolist: () => stubList,
  };
};
stubExtractor.tokenizer = {
  encode: stubTokenizerEncode,
};

function makeService(modelName = "mock-model"): {
  service: HuggingFaceEmbeddingsService;
  recording: RecordingPipeline;
} {
  const recording = createRecordingPipeline(async () => stubExtractor);
  return {
    service: new HuggingFaceEmbeddingsService(modelName, recording.pipeline),
    recording,
  };
}

describe("HuggingFaceEmbeddingsService", () => {
  test("preload() initializes the shared extractor", async () => {
    const { service, recording } = makeService();
    expect(service.modelName).toBe("mock-model");
    await service.preload();

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]).toEqual({
      task: "feature-extraction",
      model: "mock-model",
      options: { dtype: "q8" },
    });
  });

  test("retries initialization after a failed first attempt", async () => {
    const { service, recording } = makeService();
    let attempts = 0;
    recording.setImplementation(async () => {
      attempts++;
      if (attempts === 1) throw new Error("model download failed");
      return stubExtractor;
    });

    expect(service.preload()).rejects.toThrow("model download failed");
    expect(service.preload()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("concurrent creates share a single in-flight initialization", async () => {
    const { service, recording } = makeService();
    const [first, second] = await Promise.all([
      service.create({ model: "mock-model", input: "first", encoding_format: "float" }),
      service.create({ model: "mock-model", input: "second", encoding_format: "float" }),
    ]);

    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(recording.calls).toHaveLength(1);
  });

  test("successfully processes string input and computes correct token counts", async () => {
    const { service } = makeService();
    const result = await service.create({
      model: "mock-model",
      input: "hello world",
      encoding_format: "float",
    });

    expect(result.object).toBe("list");
    expect(result.model).toBe("mock-model");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.index).toBe(0);
    expect(result.data[0]!.object).toBe("embedding");
    // "hello world" has 2 words -> 2 tokens
    expect(result.usage.prompt_tokens).toBe(2);
    expect(result.usage.total_tokens).toBe(2);
    expect(result.data[0]!.embedding).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  test("processes array of strings input", async () => {
    const { service } = makeService();
    const result = await service.create({
      model: "mock-model",
      input: ["one", "two three"],
      encoding_format: "float",
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.index).toBe(0);
    expect(result.data[1]!.index).toBe(1);
    // "one" (1) + "two three" (2) = 3 tokens
    expect(result.usage.prompt_tokens).toBe(3);
  });

  test("supports dimensions truncation and L2 re-normalization", async () => {
    const { service } = makeService();
    const result = await service.create({
      model: "mock-model",
      input: "truncate me",
      encoding_format: "float",
      dimensions: 2,
    });

    // Original [0.5, 0.5, 0.5, 0.5] sliced to length 2: [0.5, 0.5]
    // L2 normalized: [1/sqrt(2), 1/sqrt(2)] = [0.7071067811865475, 0.7071067811865475]
    const vec = result.data[0]!.embedding as number[];
    expect(vec).toHaveLength(2);
    expect(vec[0]!).toBeCloseTo(Math.SQRT1_2, 4);
    expect(vec[1]!).toBeCloseTo(Math.SQRT1_2, 4);
  });

  test("rejects dimensions that exceed the native embedding size", async () => {
    const { service } = makeService();
    expect(
      service.create({
        model: "mock-model",
        input: "too small",
        encoding_format: "float",
        dimensions: 6,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("supports base64 encoding format", async () => {
    const { service } = makeService();
    const result = await service.create({
      model: "mock-model",
      input: "encode me",
      encoding_format: "base64",
    });

    expect(typeof result.data[0]!.embedding).toBe("string");
    // Convert base64 back to Float32Array to check values
    const buffer = Buffer.from(result.data[0]!.embedding as string, "base64");
    const arr = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
    expect(Array.from(arr)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});
