# Executive Summary: Observability Strategy for `opencode-to-openai`

## 1. Introduction & Context
The `opencode-to-openai` project functions as an API proxy/gateway translating OpenAI-compliant Chat Completion requests into the downstream OpenCode SDK model. Because this service acts as a critical path interface between clients and the OpenCode execution environment, having clear, reliable, and actionable observability is crucial.

Observing an AI/LLM gateway has unique dimensions compared to traditional web APIs. Beyond standard HTTP status codes, we must understand prompt token consumption, response generation latencies (especially for streamed/SSE responses), downstream sandbox/session management life cycles, and detailed error mapping.

This document outlines the observability options available for `opencode-to-openai`, categorizing them by implementation complexity, richness of insight, and operational cost.

---

## 2. Key Dimensions of LLM Gateway Observability

Any successful observability solution for this gateway must address three distinct telemetry categories:

### A. Metrics (The "What is happening?")
*   **Throughput & Error Rates**: Request counts segmented by endpoint, model (`request.model`), and HTTP status codes.
*   **Latencies (Crucial for UX)**:
    *   **Time to First Token (TTFT)**: For streaming requests, the duration between receiving the client request and delivering the first SSE chunk.
    *   **Total Response Latency**: The total time taken to resolve non-streamed requests or finish sending a stream.
    *   **Downstream Session Latency**: Time spent in `session.create`, `session.prompt`, and `session.delete` via the `@opencode-ai/sdk`.
*   **Resource & Token Usage**: Count of input tokens, output tokens, and total tokens per request/user to track costs and quotas.
*   **Session Lifecycle Metrics**: Active downstream sessions, session deletion success rates, and leaked/hung session counts.

### B. Structured Logs (The "Why is it happening?")
*   **Correlation IDs**: A unique `request_id` passed via headers or generated at the router to correlate API requests with downstream SDK sessions.
*   **Contextual Payloads**: Structured logs containing the model requested, token counts, execution duration, and IP/client identifiers.
*   **SDK Error Mapping**: Clear structured logs capturing OpenCode failures (e.g., session timeout, syntax errors in OpenCode execution, resource depletion) linked to the corresponding OpenAI-compliant error returned to the client.

### C. Distributed Traces (The "Where is it happening?")
*   Visualizing the lifecycle of a request as a sequence of nested operations (spans).
*   **Span Hierarchy Example**:
    *   `POST /v1/chat/completions` (Root Span)
        *   `parse_request` (Parsing Zod schema)
        *   `opencode_session_create` (Calling SDK `session.create`)
        *   `opencode_session_prompt` (Calling SDK `session.prompt`)
        *   `sse_stream_delivery` (Active while streaming chunks to client)
        *   `opencode_session_delete` (Asynchronous clean-up of session)

---

## 3. Observability Architecture Options

Here are three distinct, practical paths to introduce observability to the codebase.

### Option A: Lightweight Structured Logging & Prometheus Metrics (Self-Hosted / Zero-Cost)
This approach relies on a lightweight logging library (such as Pino) and a simple Prometheus metrics exporter built directly into Bun. It involves wrapping the router and service layers to output highly parsable JSON logs and register counter/histogram metrics.

#### How It Works:
1.  Introduce a logger utility (`src/utils/logger.ts`) using standard JSON output.
2.  Modify the router `handle` function in `src/router.ts` to log incoming requests, status codes, and latencies.
3.  Expose a `/metrics` endpoint in `src/server.ts` using Bun's built-in APIs to serve Prometheus-formatted metrics (e.g., total requests, error count, latency histograms).

#### Code-Level Integration Example:
```typescript
// Example: Adding lightweight request logging and latency measurement in src/router.ts
import { crypto } from "bun";

export class Router {
  // ... existing code ...
  async handle(request: Request, server: TimeoutConfigurableServer): Promise<Response> {
    const start = Performance.now();
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const url = new URL(request.url);

    try {
      const route = this.#findRoute(request.method, url.pathname);
      const response = await route.handler(request, server);

      const duration = Performance.now() - start;
      console.log(JSON.stringify({
        level: "info",
        timestamp: new Date().toISOString(),
        requestId,
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: duration
      }));

      // Inject correlation header for the client
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      const duration = Performance.now() - start;
      console.error(JSON.stringify({
        level: "error",
        timestamp: new Date().toISOString(),
        requestId,
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration
      }));
      return toErrorResponse(error);
    }
  }
}
```

#### Evaluation:
*   **Pros**:
    *   No external SaaS platform dependency.
    *   Minimal performance overhead (~microseconds added).
    *   Extremely straightforward to implement.
*   **Cons**:
    *   Does not capture visual traces of downstream calls natively.
    *   Visualizing data requires setting up Prometheus and Grafana instances.

---

### Option B: Industry-Standard OpenTelemetry (OTel)
OpenTelemetry is the CNCF standard for cloud-native telemetry. By instrumenting the HTTP router and the `@opencode-ai/sdk` interactions with OpenTelemetry JS SDK, traces and metrics can be exported directly to standard collectors (e.g., Datadog, Dynatrace, New Relic, Honeycomb, Jaeger, or Grafana Tempo).

#### How It Works:
1.  Install OTel dependency packages (`@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`).
2.  Initialize the OTel SDK inside `src/main.ts` prior to serving traffic.
3.  Wrap service methods in custom OTel spans to track downstream SDK calls (`session.create`, `prompt`, `delete`).

#### Code-Level Integration Example:
```typescript
// Example: Custom Span Instrumentation in src/services/opencode/service.ts
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("opencode-to-openai");

export class OpencodeChatCompletionsService implements ChatCompletionsService {
  // ... existing constructor ...

  async create(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return tracer.startActiveSpan("ChatCompletionsService.create", async (span) => {
      const model = parseModel(request.model);
      span.setAttribute("llm.request.model", model);

      let session;
      try {
        session = await tracer.startActiveSpan("opencode.session.create", async (innerSpan) => {
          const res = (await this.#client.session.create<true>({})).data;
          innerSpan.setAttribute("opencode.session.id", res.id);
          return res;
        });
      } catch (error) {
        span.recordException(error as Error);
        throw mapOpencodeError(error);
      }

      try {
        const result = await tracer.startActiveSpan("opencode.session.prompt", async (innerSpan) => {
          const res = await this.#client.session.prompt<true>({
            path: { id: session.id },
            body: { model, system: input.system, parts: input.parts },
          });
          return res;
        });

        // Span telemetry representation
        span.setAttribute("llm.usage.completion_tokens", result.data.info.usage?.completion_tokens ?? 0);

        const completion = buildCompletion(request, result.data.info, result.data.parts);
        // ... build response and cleanup ...
      } catch (error) {
        span.recordException(error as Error);
        throw mapOpencodeError(error);
      } finally {
        await this.#deleteSession(session.id);
        span.end();
      }
    });
  }
}
```

#### Evaluation:
*   **Pros**:
    *   Vendor-agnostic: Supports switching backend telemetry platforms (Honeycomb, Datadog, Grafana) without rewriting core logic.
    *   Highly granular traces showing precise latencies of downstream networks vs. compute times.
*   **Cons**:
    *   Adds slight initial footprint package overhead.
    *   Requires configuring and deploying an OTel Collector or managing SaaS API keys.

---

### Option C: LLM-Specific Observability Platforms (Langfuse, LangSmith, Arize Phoenix)
LLM-specific platforms are tailored precisely for generative AI applications. Instead of raw generic trace spans, they render prompt trees, tool usage parameters, token costs, evaluation scores, and detailed playbacks of user-system conversations.

#### How It Works:
1.  Integrate a specialized SDK like **Langfuse** (which features an open-source, lightweight TypeScript SDK).
2.  Log completion prompts, exact inputs/outputs, model variations, and custom evaluation scores during execution.
3.  Gain immediate visual playground debuggers and analytics showing token consumption trends.

#### Code-Level Integration Example (Using Langfuse SDK):
```typescript
import { Langfuse } from "langfuse";

const langfuse = new Langfuse();

export class OpencodeChatCompletionsService implements ChatCompletionsService {
  async create(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const trace = langfuse.trace({
      name: "chat_completion",
      userId: request.user,
      metadata: { model: request.model }
    });

    const generation = trace.generation({
      name: "opencode-generation",
      model: request.model,
      input: request.messages,
    });

    try {
      // Call downstream SDK
      // ...

      generation.update({
        output: completion.choices[0].message,
        usage: {
          promptTokens: completion.usage?.prompt_tokens,
          completionTokens: completion.usage?.completion_tokens,
        }
      });
    } catch (error) {
      generation.update({ level: "ERROR", statusMessage: String(error) });
      throw error;
    } finally {
      generation.end();
      trace.end();
    }
  }
}
```

#### Evaluation:
*   **Pros**:
    *   Out-of-the-box support for capturing prompt histories, variables, tool outputs, and guardrail validations.
    *   Includes rich dashboards for counting token usage per tenant, estimating costs, and viewing playground iterations.
*   **Cons**:
    *   Requires adopting a specialized SaaS tool or hosting a separate dedicated dashboard stack.
    *   Slightly higher performance latency penalty during SDK tracking if not using asynchronous flushing.

---

## 4. Comparison Matrix & Recommendation

| Feature/Metric | Option A: Structured Logs + Prometheus | Option B: OpenTelemetry (OTel) | Option C: LLM Observability (Langfuse/LangSmith) |
| :--- | :--- | :--- | :--- |
| **Development Effort** | Low (1–2 days) | Medium (3–5 days) | Medium (2–4 days) |
| **Performance Impact** | Near Zero ($<0.1$ms overhead) | Very Low ($<1$ms overhead) | Low ($<2$ms, async flushing) |
| **Infrastructure Cost** | None (Self-Hosted / Standard VM) | Low/Medium (OTel storage/SaaS cost) | Medium (SaaS subscription or self-hosted UI) |
| **Telemetry Granularity** | Request levels, HTTP status codes | Detailed execution-span timelines | Full LLM input/output prompt trees & cost tracking |
| **Primary Audience** | DevOps / Platform Engineers | Infrastructure / SRE Teams | AI Product Managers / LLM Developers |

### Strategic Recommendation

1.  **Immediate First Step**: Implement **Option A (Lightweight Structured Logging)** using a Bun-compatible logger and correlation IDs (`x-request-id`). This provides immediate production safety, allows tracking of uncaught runtime errors, and guarantees downstream session safety without adding third-party dependencies or external service risks.
2.  **For Scale and Production Readiness**: Transition to **Option B (OpenTelemetry)**. Setting up OTel allows integration into standard corporate visualization platforms (e.g. Grafana or Datadog) and makes the gateway fully cloud-native, enabling precise debugging of downstream SDK call latencies.
3.  **For LLM Optimization / Product Strategy**: If the gateway is heavily used for fine-tuning prompt performance, tracking multi-turn system tool outputs, or evaluating generation quality, **Option C (Langfuse)** should be deployed in parallel to trace exact user-system behavior.
