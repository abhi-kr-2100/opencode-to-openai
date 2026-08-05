import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk";
import { BadRequestError } from "../../http/errors.ts";
import type { ChatCompletionMessage } from "../../openai/chat-completions.ts";
import { isRecord, mimeFromUrl } from "./guards.ts";
import { renderToolSection } from "./tools.ts";

/**
 * Flattens OpenAI message content into the opencode part input format.
 *
 * String content becomes a single text part; array content is mapped
 * part-by-part, with text parts passing through and image URLs becoming file
 * parts. Malformed or unsupported entries are rejected rather than dropped.
 */
export function toParts(messages: ChatCompletionMessage[]): Array<TextPartInput | FilePartInput> {
  const parts: Array<TextPartInput | FilePartInput> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.length > 0) parts.push({ type: "text", text: message.content });
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const contentPart of message.content) {
        if (!isRecord(contentPart)) {
          throw new BadRequestError("message content parts must be objects");
        }
        switch (contentPart.type) {
          // Text parts pass through as-is.
          case "text":
            if (typeof contentPart.text !== "string") {
              throw new BadRequestError('text content parts must have a string "text" field');
            }
            if (contentPart.text.length > 0) parts.push({ type: "text", text: contentPart.text });
            break;
          // OpenAI image URLs become opencode file parts.
          case "image_url":
            if (!isRecord(contentPart.image_url) || typeof contentPart.image_url.url !== "string") {
              throw new BadRequestError('image_url content parts must have a string "url" field');
            }
            parts.push({
              type: "file",
              mime: mimeFromUrl(contentPart.image_url.url),
              url: contentPart.image_url.url,
            });
            break;
          default:
            throw new BadRequestError(
              `unsupported content part type ${JSON.stringify(contentPart.type)}`,
            );
        }
      }
    }
  }
  return parts;
}

export interface PromptInput {
  system?: string;
  parts: Array<TextPartInput | FilePartInput>;
}

export interface PromptOptions {
  tools?: unknown;
  toolChoice?: unknown;
}

/**
 * Maps OpenAI chat messages onto an opencode session prompt.
 *
 * Leading `system`/`developer` instructions are carried in the prompt's
 * `system` field, followed by the emulated tool instructions when tools were
 * requested. The final message becomes the prompt's parts — whether it is a
 * user turn or a `tool` result continuing an agent loop. Any preceding
 * conversation turns are flattened into a transcript text part with role
 * markers, since opencode starts from a fresh session and cannot replay prior
 * assistant turns or tool results as real session messages.
 */
export function toPrompt(
  messages: ChatCompletionMessage[],
  options: PromptOptions = {},
): PromptInput {
  const system: string[] = [];
  let index = 0;
  while (index < messages.length && isSystemRole(messages[index]?.role)) {
    const text = contentText(messages[index]!);
    if (text !== undefined && text.length > 0) system.push(text);
    index += 1;
  }

  const conversation = messages.slice(index);
  for (const message of conversation) {
    if (isSystemRole(message.role)) {
      throw new BadRequestError(
        `a ${message.role} message cannot follow a user message: system instructions must come first`,
      );
    }
  }

  let lastUserIndex = -1;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    throw new BadRequestError("a user message is required");
  }

  const lastIndex = conversation.length - 1;
  const transcript = flattenTranscript(conversation, lastIndex);
  const parts: Array<TextPartInput | FilePartInput> = [];
  if (transcript !== undefined) parts.push({ type: "text", text: transcript });
  const lastParts = toParts([conversation[lastIndex]!]);
  if (lastParts.length === 0) {
    throw new BadRequestError("the last message must carry some content");
  }
  parts.push(...lastParts);

  const toolSection = renderToolSection(options.tools, options.toolChoice);
  if (toolSection !== undefined) system.push(toolSection);

  return {
    system: system.length > 0 ? system.join("\n\n") : undefined,
    parts,
  };
}

/** Renders the turns before the final user message as a role-labeled transcript. */
function flattenTranscript(
  conversation: ChatCompletionMessage[],
  lastUserIndex: number,
): string | undefined {
  if (lastUserIndex === 0) return undefined;
  const transcript = conversation
    .slice(0, lastUserIndex)
    .map(transcriptText)
    .filter((text) => text.length > 0)
    .join("\n\n");
  return transcript.length > 0 ? transcript : undefined;
}

/** Renders a single conversation turn as a transcript line with role markers. */
function transcriptText(message: ChatCompletionMessage): string {
  const text = contentText(message) ?? "";
  switch (message.role) {
    case "user":
      return text.length > 0 ? `user: ${text}` : "user:";
    case "assistant": {
      const lines: string[] = [];
      if (text.length > 0) lines.push(`assistant: ${text}`);
      for (const call of toolCallsOf(message)) lines.push(call);
      return lines.join("\n");
    }
    case "tool":
      return `tool${message.tool_call_id ? ` (${message.tool_call_id})` : ""}: ${text}`;
    default:
      return "";
  }
}

/** Renders the tool calls attached to an assistant message as emulated blocks. */
function toolCallsOf(message: ChatCompletionMessage): string[] {
  const lines: string[] = [];
  for (const call of message.tool_calls ?? []) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    const name = typeof fn.name === "string" ? fn.name : "function";
    const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
    const id = typeof call.id === "string" ? call.id : undefined;
    const payload: Record<string, string> = { name, arguments: args };
    if (id !== undefined) payload.id = id;
    lines.push(`<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`);
  }
  return lines;
}

function isSystemRole(role: ChatCompletionMessage["role"] | undefined): boolean {
  return role === "system" || role === "developer";
}

/** Extracts the text content of a message, joining array text parts with newlines. */
function contentText(message: ChatCompletionMessage): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const texts: string[] = [];
    for (const contentPart of message.content) {
      if (
        isRecord(contentPart) &&
        contentPart.type === "text" &&
        typeof contentPart.text === "string"
      ) {
        texts.push(contentPart.text);
      }
    }
    return texts.join("\n");
  }
  return undefined;
}
