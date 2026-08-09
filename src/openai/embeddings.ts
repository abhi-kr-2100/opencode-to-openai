import { z } from "zod";

export const embeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string(),
    z.array(z.string()),
  ]),
  encoding_format: z.enum(["float", "base64"]).optional(),
  dimensions: z.number().int().positive().optional(),
});

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;

export interface Embedding {
  object: "embedding";
  index: number;
  embedding: number[] | string;
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
}

export interface EmbeddingList {
  object: "list";
  data: Embedding[];
  model: string;
  usage: EmbeddingUsage;
}
