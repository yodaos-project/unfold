import {
  createMcpHandler,
  McpServer,
  ResourceTemplate,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RequestContext } from './context.js';
import { errorResponse, UnfoldError } from './errors.js';
import { compilePage, compilePatch, inkMimeType } from './ink.js';
import {
  MemoryMcpPageStore,
  type McpEventBus,
  type McpPage,
  type McpPageStore,
} from './mcp-page-store.js';
import type { Page, UnfoldRuntime } from './unfold.js';

export interface McpOptions {
  pageStore?: McpPageStore;
  eventBus?: McpEventBus;
  allowedOrigins?: readonly string[];
}

const encoder = new TextEncoder();
const maxRequestBytes = 256 * 1024;
const maxGenerationBytes = 512 * 1024;
const maxPatches = 128;
const pageTtlMs = 15 * 60 * 1000;
const resourceMimeType = 'application/json';

const id = z.string().min(1).max(256);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const taskInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8192) }),
  z.object({
    type: z.literal('action'),
    name: id,
    data: z.record(z.string(), z.unknown()),
  }),
]);
const listen = z.object({
  method: z.literal('subscriptions/listen'),
  params: z.object({
    notifications: z.object({
      resourceSubscriptions: z.array(z.string()).max(32).optional(),
    }),
  }),
});

async function readMcpBody(request: Request): Promise<unknown> {
  if (
    request.method !== 'POST' ||
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
  )
    return undefined;
  const reader = request.clone().body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxRequestBytes) {
        // The unconsumed branch of the cloned request may still be open.
        void reader.cancel().catch(() => undefined);
        throw new UnfoldError(
          413,
          'request_too_large',
          'MCP request exceeds the size limit',
        );
      }
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function toolData(page: McpPage) {
  const source = [
    page.source,
    ...(page.generation?.patches ?? []).map((patch) => patch.source),
  ].join('\n');
  return {
    viewId: page.viewId,
    taskId: page.taskId,
    revision: page.revision,
    pageUri: page.uri,
    mimeType: inkMimeType,
    source,
  };
}

async function toolResult(
  run: () => object | Promise<object>,
): Promise<CallToolResult> {
  try {
    const data = await run();
    return {
      structuredContent: { ...data },
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  } catch (error) {
    const code = error instanceof UnfoldError ? error.code : 'internal_error';
    const message =
      error instanceof UnfoldError
        ? error.message
        : 'The Unfold operation failed';
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
    };
  }
}

function generationLimit(): UnfoldError {
  return new UnfoldError(
    422,
    'generation_limit',
    'The Ink page exceeds the generation limits',
  );
}

export function createMcpApi(runtime: UnfoldRuntime, options: McpOptions = {}) {
  const store = options.pageStore ?? new MemoryMcpPageStore();

  async function currentPage(
    context: RequestContext,
    uri: string,
  ): Promise<McpPage> {
    const page = await store.get(uri);
    if (!page || page.owner !== context.user || page.expiresAt <= Date.now()) {
      throw new UnfoldError(404, 'page_not_found', 'Page not found');
    }
    if (page.taskId !== undefined)
      await runtime.taskPage(context, page.taskId, page.revision);
    return page;
  }

  async function preparePage(
    context: RequestContext,
    page: Page,
  ): Promise<McpPage> {
    const source = await runtime.render(context, page);
    if (encoder.encode(source).byteLength > maxGenerationBytes)
      throw generationLimit();
    const saved: McpPage = {
      ...page,
      source,
      owner: context.user,
      uri: `unfold://pages/${crypto.randomUUID()}`,
      expiresAt: Date.now() + pageTtlMs,
      version: 0,
    };
    await store.create(saved);
    return saved;
  }

  async function generate(
    context: RequestContext,
    uri: string,
    prompt: string,
  ): Promise<McpPage> {
    let page = await currentPage(context, uri);
    if (page.generation) {
      throw new UnfoldError(
        409,
        'page_already_generated',
        'Open a new page snapshot before generating again',
      );
    }
    const generation = {
      runId: crypto.randomUUID(),
      status: 'running' as const,
      patches: [],
    };
    const started = { ...page, version: page.version + 1, generation };
    if (!(await store.update(started, page.version))) {
      throw new UnfoldError(
        409,
        'generation_conflict',
        'The page changed before generation could start',
      );
    }
    page = started;
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(30_000),
    ]);

    async function publish(generation: NonNullable<McpPage['generation']>) {
      const updated = { ...page, version: page.version + 1, generation };
      if (!(await store.update(updated, page.version))) {
        throw new UnfoldError(
          409,
          'generation_conflict',
          'The page changed during generation',
        );
      }
      page = updated;
      handler.notify.resourceUpdated(uri);
    }

    let writer: ReturnType<UnfoldRuntime['openPage']> | undefined;
    try {
      writer = runtime.openPage({ ...context, signal }, page, prompt);
      signal.throwIfAborted();
      const compiled = compilePage(await writer.next());
      if (compiled.source !== page.source) {
        throw new UnfoldError(
          409,
          'page_changed',
          'Open the page again before generating',
        );
      }
      let size = encoder.encode(page.source).byteLength;
      for (;;) {
        signal.throwIfAborted();
        const next = await writer.next();
        signal.throwIfAborted();
        const previous = page.generation!;
        if (next.done) {
          await currentPage(context, uri);
          await publish({ ...previous, status: 'done' });
          return page;
        }
        const source = compilePatch(next.value, compiled.regions);
        size += encoder.encode(source).byteLength + 1;
        if (size > maxGenerationBytes || previous.patches.length >= maxPatches)
          throw generationLimit();
        await currentPage(context, uri);
        await publish({
          ...previous,
          patches: [
            ...previous.patches,
            { seq: previous.patches.length + 1, source },
          ],
        });
      }
    } catch (error) {
      await publish({ ...page.generation!, status: 'failed' }).catch(
        () => undefined,
      );
      if (signal.aborted)
        throw new UnfoldError(
          408,
          'generation_interrupted',
          'Generation was cancelled or timed out',
        );
      throw error;
    } finally {
      await writer?.return(undefined);
    }
  }

  const handler = createMcpHandler(
    ({ authInfo, requestInfo, era }) => {
      if (!requestInfo || !authInfo)
        throw new Error('Missing authenticated request');
      const contextFor = (
        signal: AbortSignal = requestInfo.signal,
      ): RequestContext => ({
        request: requestInfo,
        user: authInfo.clientId,
        signal: AbortSignal.any([requestInfo.signal, signal]),
      });
      const server = new McpServer(
        { name: 'unfold', version: '0.1.0' },
        { capabilities: { resources: { subscribe: era === 'modern' } } },
      );

      server.registerTool(
        'list_tasks',
        { description: 'List the registered Unfold task types' },
        () => toolResult(() => ({ tasks: runtime.listTasks() })),
      );
      server.registerTool(
        'list_pages',
        {
          description: 'List the registered Unfold pages and their input mode',
        },
        () => toolResult(() => ({ pages: runtime.listPages() })),
      );
      server.registerTool(
        'start_task',
        {
          description:
            'Start a registered task with a text request or a structured action',
          inputSchema: z.object({ taskType: id, input: taskInput }),
        },
        (args, ctx) =>
          toolResult(async () => {
            const context = contextFor(ctx.mcpReq.signal);
            return toolData(
              await preparePage(
                context,
                await runtime.startTask(context, args),
              ),
            );
          }),
      );
      server.registerTool(
        'send_task_input',
        {
          description:
            'Advance an existing task using the current revision and a unique action ID',
          inputSchema: z.object({
            taskId: id,
            revision,
            actionId: id,
            input: taskInput,
          }),
        },
        (args, ctx) =>
          toolResult(async () => {
            const context = contextFor(ctx.mcpReq.signal);
            return toolData(
              await preparePage(
                context,
                await runtime.sendTaskInput(context, args),
              ),
            );
          }),
      );
      server.registerTool(
        'render_view',
        {
          description:
            'Open a current task page (taskId, optional revision) or a standalone page (view, data)',
          inputSchema: z.object({
            taskId: id.optional(),
            revision: revision.optional(),
            view: id.optional(),
            data: z.unknown().optional(),
          }),
        },
        (args, ctx) =>
          toolResult(async () => {
            const context = contextFor(ctx.mcpReq.signal);
            const { taskId, revision, view, data } = args;
            if (taskId && !view && data === undefined) {
              return toolData(
                await preparePage(
                  context,
                  await runtime.taskPage(context, taskId, revision),
                ),
              );
            }
            if (view && !taskId && revision === undefined) {
              return toolData(
                await preparePage(context, runtime.externalPage(view, data)),
              );
            }
            throw new UnfoldError(
              400,
              'invalid_page_target',
              'Provide a task ID or a standalone view',
            );
          }),
      );
      server.registerTool(
        'generate_view',
        {
          description:
            'Generate Ink snippets for a page URI returned by a previous Unfold tool',
          inputSchema: z.object({
            pageUri: id,
            prompt: z.string().min(1).max(8192),
          }),
        },
        ({ pageUri, prompt }, ctx) =>
          toolResult(async () =>
            toolData(
              await generate(contextFor(ctx.mcpReq.signal), pageUri, prompt),
            ),
          ),
      );
      server.registerResource(
        'page_updates',
        new ResourceTemplate('unfold://pages/{id}', { list: undefined }),
        {
          description:
            'Read the current Ink source and ordered snippets for a page generation',
          mimeType: resourceMimeType,
        },
        async (uri) => {
          const page = await currentPage(contextFor(), uri.href);
          const { source, viewId, taskId, revision, generation } = page;
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: resourceMimeType,
                text: JSON.stringify({
                  source,
                  viewId,
                  taskId,
                  revision,
                  ...generation,
                }),
              },
            ],
          };
        },
      );
      return server;
    },
    { bus: options.eventBus, maxRequestBodySize: maxRequestBytes },
  );

  return {
    close: handler.close,
    async fetch(request: Request): Promise<Response> {
      try {
        const origin = request.headers.get('origin');
        if (
          origin &&
          !(options.allowedOrigins ?? [new URL(request.url).origin]).includes(
            origin,
          )
        ) {
          throw new UnfoldError(403, 'invalid_origin', 'Origin is not allowed');
        }
        const context = await runtime.context(request);
        const parsedBody = await readMcpBody(request);
        // The SDK routes resource notifications by URI. Check ownership before opening the stream.
        for (const message of Array.isArray(parsedBody)
          ? parsedBody
          : [parsedBody]) {
          if (
            !message ||
            typeof message !== 'object' ||
            message.method !== 'subscriptions/listen'
          )
            continue;
          const subscription = listen.safeParse(message);
          if (!subscription.success) {
            throw new UnfoldError(
              400,
              'invalid_subscription',
              'Invalid resource subscription',
            );
          }
          for (const uri of subscription.data.params.notifications
            .resourceSubscriptions ?? []) {
            await currentPage(context, uri);
          }
        }
        return await handler.fetch(request, {
          parsedBody,
          authInfo: { clientId: context.user, token: '', scopes: [] },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
