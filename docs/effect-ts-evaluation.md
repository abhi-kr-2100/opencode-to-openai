# Technical Evaluation: Adopting Effect.ts in opencode-to-openai

---

## 1. Executive Summary
The `opencode-to-openai` repository acts as a bridge between OpenAI-compliant API requests and the OpenCode backend system. Currently, the codebase is lightweight, leveraging standard async/await Promises, custom HTTP handling, Zod schemas, and class-based service architecture.

Using **Effect.ts** would significantly **restructure** and **simplify** key areas of the current codebase—especially around **resource management (session lifecycle)**, **type-safe error handling**, and **dependency injection / test mocking**.

However, because the codebase is extremely small (~15 files), introducing Effect.ts as a dependency adds a **high cognitive overhead** and a **steep learning curve** for future maintainers. Therefore, we recommend:
- **No immediate migration** if the goal is to keep the codebase lightweight, simple, and accessible to standard TypeScript developers.
- **Adopt progressively** (specifically for the session/prompt execution flow) if the codebase is planned to grow in complexity, require advanced resiliency (e.g., automated retries, fiber supervision), or require rich distributed tracing.

---

## 2. Core Pillars of Effect.ts vs. Current Codebase Patterns

| Feature / Pattern | Current Codebase Pattern | Effect.ts Equivalent | Impact of Transition |
|---|---|---|---|
| **Error Handling** | Untyped `Promise` throws; custom `ApiError` hierarchy; manual mapping via `mapOpencodeError` / `mapSessionError`. | Statically typed errors via `Effect<Value, Error>` (using Tagged Errors). | **High Simplification & Safety:** The compiler guarantees all edge cases and HTTP error codes are fully modeled and handled, preventing unhandled 500 crashes. |
| **Resource Management** | Manual `try / finally` blocks with best-effort nested try-catches (e.g., deleting temporary sessions in `OpencodeChatCompletionsService`). | Deterministic scoping via `Effect.acquireRelease` and `Scope`. | **Significant Simplification:** Resource cleanup is guaranteed and declarative, eliminating nesting. |
| **Dependency Injection (DI)** | Manual constructor-based injection. | Type-safe DI layers (`Context.Tag` and `Layer`). | **Cleaner Architecture:** Decouples implementation from instantiation, making testing and environment-specific configuration straightforward. |
| **Data Validation** | Zod schemas (using `.safeParse` in routes). | `@effect/schema` | **Unified Parsing:** Unifies schema validation, serialization, and error generation under the same ecosystem. |
| **Resilience & Retries** | Manual loops or none (e.g., if OpenCode is unreachable, it instantly fails with a 502 Bad Gateway). | Declarative scheduling and retries with backoff/jitter (`Effect.retry`). | **Huge Reliability Boost:** Extremely easy to add automatic retries with exponential backoff on connection errors. |

---

## 3. Side-by-Side Code Comparison

### Scenario: Creating and Cleaning Up an OpenCode Session

#### A. Current Implementation (`src/services/opencode/service.ts`)
```typescript
export class OpencodeChatCompletionsService implements ChatCompletionsService {
  readonly #client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.#client = client;
  }

  async create(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const model = parseModel(request.model);
    const input = toPrompt(request.messages, {
      tools: request.tools,
      toolChoice: request.tool_choice,
    });

    let session: { id: string };
    try {
      session = (await this.#client.session.create<true>({})).data;
    } catch (error) {
      throw mapOpencodeError(error);
    }

    try {
      const result = await this.#client.session.prompt<true>({
        path: { id: session.id },
        body: { model, system: input.system, parts: input.parts },
      });
      if (result.data.info.error) throw mapSessionError(result.data.info.error);
      const completion = buildCompletion(request, result.data.info, result.data.parts);
      if (!request.stream) {
        return { stream: false, value: completion };
      }
      return {
        stream: true,
        value: (async function* () {
          yield* buildChunks(request, completion);
        })(),
      };
    } catch (error) {
      throw mapOpencodeError(error);
    } finally {
      await this.#deleteSession(session.id);
    }
  }

  async #deleteSession(sessionID: string): Promise<void> {
    try {
      await this.#client.session.delete<true>({ path: { id: sessionID } });
    } catch {
      // Best effort cleanup; the session may already be gone.
    }
  }
}
```

#### B. Proposed Effect.ts Implementation
Using Effect's generator syntax (`Effect.gen`) and resource scoping, we completely eliminate nested try-catch blocks and make the cleanup logic deterministic and elegant.

```typescript
import { Effect, Scope } from "effect";

class OpencodeServiceError extends Schema.TaggedError<OpencodeServiceError>()("OpencodeServiceError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

// 1. Declare the Session as a Scoped Resource
const acquireSession = (client: OpencodeClient) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => client.session.create<true>({}),
      catch: (e) => new OpencodeServiceError({ status: 502, message: "Failed to create session" }),
    }).map((res) => res.data),
    (session) =>
      Effect.tryPromise(() => client.session.delete<true>({ path: { id: session.id } }))
        .catchAll(() => Effect.void) // Ignore cleanup failures silently
  );

// 2. Stream/Generate Completion
export const createCompletionEffect = (
  request: ChatCompletionRequest
) =>
  Effect.gen(function* () {
    const client = yield* OpencodeClientTag;
    const model = parseModel(request.model);
    const input = toPrompt(request.messages, {
      tools: request.tools,
      toolChoice: request.tool_choice,
    });

    // Automatically scoped session: guaranteed cleanup on success, failure, or interruption
    const session = yield* acquireSession(client);

    const result = yield* Effect.tryPromise({
      try: () => client.session.prompt<true>({
        path: { id: session.id },
        body: { model, system: input.system, parts: input.parts },
      }),
      catch: mapOpencodeError,
    });

    if (result.data.info.error) {
      yield* Effect.fail(mapSessionError(result.data.info.error));
    }

    const completion = buildCompletion(request, result.data.info, result.data.parts);

    if (!request.stream) {
      return { stream: false, value: completion };
    }

    // Effect Stream seamlessly maps to OpenAI Chunk streaming
    const stream = Stream.fromIterable(buildChunks(request, completion));
    return { stream: true, value: stream };
  }).provide(Scope.default);
```

---

## 4. Pros and Cons of Adopting Effect.ts in this Project

### Advantages (Pros)
1. **Bulletproof Resource Safety**: We create a session, prompt it, and must guarantee the session is deleted. If the HTTP connection drops during streaming, Effect's structured concurrency will propagate interruption up the Fiber, releasing the session. With standard Promises, detecting connection drops and executing `finally` cleanup is notoriously error-prone.
2. **True Dependency Injection**: Standard DI relies on decorators or manual constructor forwarding. Effect's `Layer` architecture lets us plug mock clients in tests with simple `.provide` calls, avoiding complex stubbing.
3. **Statically Checked Failure Modes**: TypeScript cannot check `throw` types. Under Effect, errors are fully modeled in the type system. If we forget to map a specific OpenCode exception, the compiler refuses to build, ensuring predictable behavior.
4. **Resiliency out of the box**: If the OpenCode server is under high load or temporarily unreachable, we can apply exponential retry policies (`Effect.retry(Schedule.exponential(1000).intersect(Schedule.recurs(3)))`) globally or locally in one line of code.

### Disadvantages / Risks (Cons)
1. **Significant Learning Curve**: Effect introduces custom terminology (`Fibers`, `Layers`, `Scopes`, `TaggedErrors`, `Effect.gen`) and a paradigm shift away from vanilla JavaScript/TypeScript.
2. **Onboarding Friction**: New contributors will face a higher barrier to entry compared to simple Bun HTTP routes and standard async/await.
3. **Ecosystem Lock-in**: Once a project is fully built on Effect, adopting other middleware or standard JS utility patterns can require adapter wrappers like `Effect.runPromise` or `Effect.tryPromise`.
4. **Current Codebase Simplicity**: The current project is extremely small and highly focused. Standard TypeScript with Zod is highly readable for most developers. Migrating to Effect.ts might be "over-engineering" at this stage.

---

## 5. Architectural Recommendation & Next Steps
We recommend a **hybrid/progressive approach** rather than a full rewrite or completely avoiding it:

1. **Keep Routing & Core Lightweight**: The custom Router (`src/router.ts`) and Bun server setup (`src/server.ts`) are currently simple, minimal, and fully functional. There is no immediate need to replace them with `@effect/platform` unless the project scales to support massive concurrent middleware, auth layers, and advanced logging.
2. **Consider Effect.ts for the Service Layer**:
   The session creation, prompting, streaming, and error-mapping sequence in `OpencodeChatCompletionsService` would benefit from Effect's `Scope` and `Stream` to prevent session leaks and handle client timeouts gracefully.
3. **If Adopted, Migrate in Steps**:
   - Start by adding `effect` package.
   - Wrap `OpencodeChatCompletionsService` with Effect patterns.
   - Run the Effect utilizing `Effect.runPromise` at the Route handler boundary (`chatCompletionsHandler`) so the HTTP server layer remains unaware of Effect.
   - Incrementally introduce `@effect/schema` to replace `zod` only if performance bottleneck or unified error modeling is needed.
