import type { ModelScore } from "./router.ts";

export function openAIModelList(models: ModelScore[]) {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 1700000000,
      owned_by: "makefun",
      permission: [],
      root: m.id,
      parent: null,
    })),
  };
}

export function anthropicModelList(models: ModelScore[]) {
  return {
    data: models.map((m) => ({
      id: m.id,
      type: "model",
      display_name: m.name || m.id,
      created_at: "2024-01-01T00:00:00Z",
    })),
    has_more: false,
    first_id: models[0]?.id || null,
    last_id: models[models.length - 1]?.id || null,
  };
}

export function anthropicError(status: number, message: string, type: string = "api_error") {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

export function openAIError(
  status: number,
  message: string,
  type: string = "invalid_request_error",
  code?: string
) {
  return {
    error: {
      message,
      type,
      param: null,
      code: code ?? null,
    },
  };
}

export function stopReasonOf(finish: string | null | undefined): string {
  switch (finish) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

export function anthropicToOpenAI(body: any, model: string): any {
  const messages: any[] = [];

  if (body.system) {
    let sysText = "";
    if (typeof body.system === "string") {
      sysText = body.system;
    } else if (Array.isArray(body.system)) {
      sysText = body.system
        .map((s: any) => (typeof s === "string" ? s : s.text || ""))
        .join("\n");
    }
    if (sysText) {
      messages.push({ role: "system", content: sysText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role;
      if (typeof msg.content === "string") {
        messages.push({ role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textParts = "";
        const toolCalls: any[] = [];
        const extraMessages: any[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts += (textParts ? "\n" : "") + (block.text || "");
          } else if (block.type === "image") {
            const mediaType = block.source?.media_type || "image/png";
            const b64Data = block.source?.data || "";
            messages.push({
              role,
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${mediaType};base64,${b64Data}` },
                },
              ],
            });
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
              },
            });
          } else if (block.type === "tool_result") {
            const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
            extraMessages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content,
            });
          }
        }

        if (role === "assistant" && toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: textParts || null,
            tool_calls: toolCalls,
          });
        } else if (textParts) {
          messages.push({ role, content: textParts });
        }

        for (const em of extraMessages) {
          messages.push(em);
        }
      }
    }
  }

  const result: any = {
    model,
    messages,
  };

  if (body.max_tokens !== undefined) {
    result.max_tokens = body.max_tokens;
  }
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.top_p = body.top_p;
  }
  if (body.stream !== undefined) {
    result.stream = body.stream;
  }
  if (body.stop_sequences) {
    result.stop = body.stop_sequences;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    if (body.tool_choice) {
      if (body.tool_choice.type === "auto") {
        result.tool_choice = "auto";
      } else if (body.tool_choice.type === "any") {
        result.tool_choice = "required";
      } else if (body.tool_choice.type === "tool" && body.tool_choice.name) {
        result.tool_choice = {
          type: "function",
          function: { name: body.tool_choice.name },
        };
      }
    }
  }

  return result;
}

export function openAIToAnthropic(body: any, model: string): any {
  const choice = body.choices?.[0] || {};
  const msg = choice.message || {};
  const content: any[] = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let inputObj = {};
      try {
        inputObj = JSON.parse(tc.function.arguments || "{}");
      } catch {
        inputObj = { raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id || `tool_${Date.now()}`,
        name: tc.function.name,
        input: inputObj,
      });
    }
  }

  return {
    id: body.id ? (String(body.id).startsWith("msg_") ? body.id : `msg_${body.id}`) : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    },
  };
}

export function openAIJsonWithModel(body: any, model: string): any {
  const cloned = typeof body === "string" ? JSON.parse(body) : { ...body };
  cloned.model = model;
  return cloned;
}

/**
 * Formats an SSE event line with optional event name and data payload.
 */
export function sseEvent(event: string | null, data: any): string {
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  if (event) {
    return `event: ${event}\ndata: ${dataStr}\n\n`;
  }
  return `data: ${dataStr}\n\n`;
}

export async function* iterateSseLines(upstream: any): AsyncGenerator<string> {
  let buffer = "";
  for await (const rawChunk of upstream) {
    buffer += typeof rawChunk === "string" ? rawChunk : rawChunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        yield line;
      }
    }
  }
  if (buffer.trim()) {
    yield buffer.trim();
  }
}

export async function* openAIStreamWithModel(upstream: any, model: string): AsyncGenerator<string> {
  let hasEmittedUsage = false;
  let lastUsage: any = null;

  for await (const line of iterateSseLines(upstream)) {
    if (!line.startsWith("data:")) continue;
    const dataPart = line.slice(5).trim();
    if (dataPart === "[DONE]") {
      if (!hasEmittedUsage && lastUsage) {
        const usageChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: lastUsage,
        };
        yield `data: ${JSON.stringify(usageChunk)}\n\n`;
      }
      yield `data: [DONE]\n\n`;
      return;
    }

    try {
      const parsed = JSON.parse(dataPart);
      parsed.model = model;
      if (parsed.usage) {
        lastUsage = parsed.usage;
        hasEmittedUsage = true;
      }
      yield `data: ${JSON.stringify(parsed)}\n\n`;
    } catch {
      yield `${line}\n\n`;
    }
  }
  yield `data: [DONE]\n\n`;
}

export async function* anthropicEventsFromOpenAI(upstream: any, model: string): AsyncGenerator<string> {
  const messageId = `msg_${Date.now()}`;
  let started = false;
  let textBlockOpened = false;
  let blockIndex = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";

  for await (const line of iterateSseLines(upstream)) {
    if (!line.startsWith("data:")) continue;
    const dataPart = line.slice(5).trim();
    if (dataPart === "[DONE]") break;

    let chunk: any;
    try {
      chunk = JSON.parse(dataPart);
    } catch {
      continue;
    }

    if (!started) {
      started = true;
      yield sseEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: chunk.usage?.prompt_tokens ?? 0,
            output_tokens: 0,
          },
        },
      });
    }

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) {
      stopReason = stopReasonOf(choice.finish_reason);
    }

    const delta = choice?.delta;
    if (delta) {
      if (delta.content) {
        if (!textBlockOpened) {
          textBlockOpened = true;
          yield sseEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
        outputTokens += 1;
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            if (textBlockOpened) {
              yield sseEvent("content_block_stop", {
                type: "content_block_stop",
                index: blockIndex,
              });
              textBlockOpened = false;
              blockIndex++;
            }
            yield sseEvent("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id || `tool_${Date.now()}`,
                name: tc.function.name,
                input: {},
              },
            });
          }
          if (tc.function?.arguments) {
            yield sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }
    }

    if (chunk.usage?.completion_tokens) {
      outputTokens = chunk.usage.completion_tokens;
    }
  }

  if (textBlockOpened) {
    yield sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
  }

  yield sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: outputTokens,
    },
  });

  yield sseEvent("message_stop", {
    type: "message_stop",
  });
}
