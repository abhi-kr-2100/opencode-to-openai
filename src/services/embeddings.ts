import { pipeline } from "@huggingface/transformers";
import { BadRequestError } from "../http/errors.ts";
import type { EmbeddingsRequest, EmbeddingsList, EmbeddingObject } from "../openai/embeddings.ts";

export interface EmbeddingsService {
  readonly modelName: string;
  create(request: EmbeddingsRequest): Promise<EmbeddingsList>;
  preload(): Promise<void>;
}

export interface FeatureExtractorOutput {
  tolist(): number[][];
}

/**
 * The subset of the transformers "feature-extraction" pipeline API used by
 * this service. Stubs in tests can implement this shape without pulling in
 * the concrete pipeline classes from `@huggingface/transformers`.
 */
export interface FeatureExtractor {
  (
    texts: string | string[],
    options?: {
      pooling?: "none" | "mean" | "cls" | "first_token" | "eos" | "last_token";
      normalize?: boolean;
    },
  ): Promise<FeatureExtractorOutput>;
  tokenizer: { encode(text: string): number[] };
}

/**
 * Builds the feature-extraction pipeline. Injected so tests can stub the
 * model without patching the module registry (which would leak across files).
 */
export type FeatureExtractionPipeline = (
  task: string,
  model: string,
  options: { dtype: string },
) => Promise<FeatureExtractor>;

function l2Normalize(vector: number[]): number[] {
  const sumSq = vector.reduce((acc, val) => acc + val * val, 0);
  const magnitude = Math.sqrt(sumSq);
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

function float32ArrayToBase64(vector: number[]): string {
  const floatArray = new Float32Array(vector);
  const buffer = Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
  return buffer.toString("base64");
}

export class HuggingFaceEmbeddingsService implements EmbeddingsService {
  readonly #modelName: string;
  readonly #buildPipeline: FeatureExtractionPipeline;
  #extractor: FeatureExtractor | null = null;
  #initPromise: Promise<FeatureExtractor> | null = null;

  constructor(
    modelName: string,
    buildPipeline: FeatureExtractionPipeline = pipeline as FeatureExtractionPipeline,
  ) {
    this.#modelName = modelName;
    this.#buildPipeline = buildPipeline;
  }

  get modelName(): string {
    return this.#modelName;
  }

  async #getExtractor(): Promise<FeatureExtractor> {
    if (this.#extractor) {
      return this.#extractor;
    }
    if (!this.#initPromise) {
      this.#initPromise = this.#buildPipeline("feature-extraction", this.#modelName, {
        dtype: "q8",
      });
    }

    try {
      const extractor = await this.#initPromise;
      this.#extractor = extractor;
      this.#initPromise = null;
      return extractor;
    } catch (error) {
      this.#initPromise = null;
      throw error;
    }
  }

  async preload(): Promise<void> {
    await this.#getExtractor();
  }

  async create(request: EmbeddingsRequest): Promise<EmbeddingsList> {
    const extractor = await this.#getExtractor();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    // Compute token count
    let prompt_tokens = 0;
    for (const text of inputs) {
      const tokens = extractor.tokenizer.encode(text);
      prompt_tokens += tokens.length;
    }

    // Run inference
    const output = await extractor(inputs, { pooling: "mean", normalize: true });

    // output can be a Tensor. We convert it to a nested JavaScript array
    const rawEmbeddings: number[][] = output.tolist();

    const data: EmbeddingObject[] = rawEmbeddings.map((rawVec, index) => {
      let vec = rawVec;
      if (request.dimensions !== undefined) {
        if (request.dimensions > rawVec.length) {
          throw new BadRequestError(
            `requested ${request.dimensions} dimensions but the "${this.modelName}" model produces ${rawVec.length} dimensions`,
          );
        }
        vec = rawVec.slice(0, request.dimensions);
        vec = l2Normalize(vec);
      }

      const embeddingVal = request.encoding_format === "base64" ? float32ArrayToBase64(vec) : vec;

      return {
        object: "embedding",
        index,
        embedding: embeddingVal,
      };
    });

    return {
      object: "list",
      data,
      model: this.modelName,
      usage: {
        prompt_tokens,
        total_tokens: prompt_tokens,
      },
    };
  }
}
