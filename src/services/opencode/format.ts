import type { ChatCompletionRequest } from "../../openai/chat-completions.ts";

/**
 * Renders the OpenAI `response_format` request parameter into system prompt instructions.
 *
 * For `text` or undefined response_format, returns undefined.
 * For `json_object`, directs the model to output valid JSON with no extra text or markdown formatting.
 * For `json_schema`, directs the model to output valid JSON matching the specified JSON Schema.
 */
export function renderFormatSection(
  responseFormat: ChatCompletionRequest["response_format"],
): string | undefined {
  if (!responseFormat || responseFormat.type === "text") {
    return undefined;
  }

  if (responseFormat.type === "json_object") {
    return [
      "You must respond with a valid JSON object.",
      "Do not include any markdown formatting (such as ```json), explanations, or commentary outside of the JSON object.",
    ].join("\n");
  }

  if (responseFormat.type === "json_schema") {
    const { name, description, schema } = responseFormat.json_schema;
    const lines = [
      "You must respond with a valid JSON object matching the required JSON Schema.",
      "Do not include any markdown formatting (such as ```json), explanations, or commentary outside of the JSON object.",
    ];
    if (name) {
      lines.push(`Schema Name: ${name}`);
    }
    if (description) {
      lines.push(`Schema Description: ${description}`);
    }
    if (schema) {
      lines.push(`JSON Schema:\n${JSON.stringify(schema, null, 2)}`);
    }
    return lines.join("\n");
  }

  return undefined;
}
