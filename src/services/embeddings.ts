import { pipeline } from "@huggingface/transformers";
import { BadRequestError } from "../http/errors.ts";
import type { EmbeddingsRequest, EmbeddingList, Embedding } from "../openai/embeddings.ts";

export interface EmbeddingsService {
  create(request: EmbeddingsRequest): Promise<EmbeddingList>;
}

export class LocalEmbeddingsService implements EmbeddingsService {
  readonly #model: string;
  readonly #preload: boolean;
  #pipelinePromise: Promise<any> | null = null;

  constructor(model: string, preload: boolean = false) {
    this.#model = model;
    this.#preload = preload;
    if (this.#preload) {
      this.#getPipeline().catch((err) => {
        console.error(`Failed to preload embeddings model ${this.#model}:`, err);
      });
    }
  }

  async #getPipeline(): Promise<any> {
    if (!this.#pipelinePromise) {
      this.#pipelinePromise = pipeline("feature-extraction", this.#model, {
        dtype: "q8",
      });
    }
    return this.#pipelinePromise;
  }

  async create(request: EmbeddingsRequest): Promise<EmbeddingList> {
    const extractor = await this.#getPipeline();
    const inputs = typeof request.input === "string" ? [request.input] : request.input;

    if (inputs.length === 0) {
      return {
        object: "list",
        data: [],
        model: this.#model,
        usage: {
          prompt_tokens: 0,
          total_tokens: 0,
        },
      };
    }

    // Run inference
    const result = await extractor(inputs, { pooling: "mean", normalize: true });
    const { dims, data } = result;
    const numSentences = dims[0];
    const originalDim = dims[1];

    if (request.dimensions !== undefined && request.dimensions > originalDim) {
      throw new BadRequestError(
        `dimensions (${request.dimensions}) cannot exceed the model's maximum of ${originalDim}`,
      );
    }

    let promptTokens = 0;
    for (const text of inputs) {
      try {
        const tokens = extractor.tokenizer.encode(text);
        const count = Array.isArray(tokens)
          ? tokens.length
          : tokens && typeof (tokens as any).length === "number"
            ? (tokens as any).length
            : 0;
        promptTokens += count;
      } catch (err) {
        console.warn(`Failed to count tokens for text "${text}":`, err);
      }
    }

    const embeddings: Embedding[] = [];
    for (let i = 0; i < numSentences; i++) {
      const start = i * originalDim;
      // Extract raw slice
      let slice = Array.from(
        data.subarray
          ? data.subarray(start, start + originalDim)
          : data.slice(start, start + originalDim),
      ) as number[];

      if (request.dimensions !== undefined) {
        slice = slice.slice(0, request.dimensions);
        // Re-normalize
        let sumSq = 0;
        for (const val of slice) {
          sumSq += val * val;
        }
        const norm = Math.sqrt(sumSq);
        if (norm > 0) {
          slice = slice.map((val) => val / norm);
        }
      }

      let embeddingValue: number[] | string;
      if (request.encoding_format === "base64") {
        const floatArray = new Float32Array(slice);
        embeddingValue = Buffer.from(
          floatArray.buffer,
          floatArray.byteOffset,
          floatArray.byteLength,
        ).toString("base64");
      } else {
        embeddingValue = slice;
      }

      embeddings.push({
        object: "embedding",
        index: i,
        embedding: embeddingValue,
      });
    }

    return {
      object: "list",
      data: embeddings,
      model: this.#model,
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: promptTokens,
      },
    };
  }
}
