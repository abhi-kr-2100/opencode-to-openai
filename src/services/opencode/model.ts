import { BadRequestError } from "../../http/errors.ts";

export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

/**
 * Splits a model id into the provider/model pair opencode expects.
 *
 * The id must contain exactly one slash with non-empty parts on both sides;
 * anything else is rejected rather than guessed.
 */
export function parseModel(model: string): OpencodeModel {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new BadRequestError(
      `invalid model "${model}": expected a "provider/model" pair, e.g. "anthropic/claude-3-5-sonnet-20241022"`,
    );
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}
