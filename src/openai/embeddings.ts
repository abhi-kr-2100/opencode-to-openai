import { z } from "zod";

const tokenId = z.number().int().nonnegative();

export const embeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1),
    z.array(tokenId).min(1),
    z.array(z.array(tokenId).min(1)).min(1),
  ]),
  encoding_format: z.enum(["float", "base64"]).default("float"),
  dimensions: z.number().int().positive().optional(),
});

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;

export interface EmbeddingObject {
  object: "embedding";
  index: number;
  embedding: number[] | string;
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
}

export interface EmbeddingsList {
  object: "list";
  data: EmbeddingObject[];
  model: string;
  usage: EmbeddingUsage;
}
