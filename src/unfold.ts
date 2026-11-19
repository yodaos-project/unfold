import Negotiator from 'negotiator';
import {
  requestContext,
  type Authenticate,
  type RequestContext,
} from './context.js';
import { errorResponse, UnfoldError } from './errors.js';
import {
  compilePage,
  getPageOptions,
  inkContentType,
  inkMimeType,
  type InkPageClass,
} from './ink.js';
import { createMcpApi, type McpOptions } from './mcp.js';
import { resolveTask, type RegisteredTask, type TaskInput } from './task.js';
import {
  MemoryTaskStore,
  type TaskCommit,
  type TaskRecord,
  type TaskStore,
} from './task-store.js';

export interface Page {
  viewId: string;
  input: unknown;
}

export interface TaskPage extends Page {
  taskId: string;
  revision: number;
}

export interface StartTask {
  taskType: string;
  input: TaskInput;
}

export interface SendTaskInput {
  taskId: string;
  revision: number;
  actionId: string;
  input: TaskInput;
}

export interface PageResponse {
  page: Page;
  headers?: HeadersInit;
}

export type PageRenderer = (
  source: string,
  context: RequestContext,
) => BodyInit | Promise<BodyInit>;

export interface UnfoldOptions {
  authenticate: Authenticate;
  views: Record<string, InkPageClass>;
  tasks?: Record<string, RegisteredTask>;
  taskStore?: TaskStore;
  renderers?: Record<string, PageRenderer>;
  mcp?: McpOptions;
}

function taskMissing(): UnfoldError {
  return new UnfoldError(404, 'task_not_found', 'Task not found');
}

function staleRevision(): UnfoldError {
  return new UnfoldError(
    409,
    'stale_revision',
    'The task has a newer revision',
  );
}

function inputKey(revision: number, input: TaskInput): string {
  // A retry may serialize object keys in a different order.
  return JSON.stringify([revision, input], (_, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

export class UnfoldRuntime {
  private readonly views: Map<string, InkPageClass>;
  private readonly viewIds = new Map<InkPageClass, string>();
  private readonly tasks: Map<string, RegisteredTask>;
  private readonly taskStore: TaskStore;
  private readonly renderers: Map<string, PageRenderer>;
  readonly mcp: ReturnType<typeof createMcpApi>;

  constructor(private readonly options: UnfoldOptions) {
    this.views = new Map(Object.entries(options.views));
    this.tasks = new Map(Object.entries(options.tasks ?? {}));
    this.taskStore = options.taskStore ?? new MemoryTaskStore();
    this.renderers = new Map(Object.entries(options.renderers ?? {}));
    for (const type of this.renderers.keys()) {
      if (type.split(';', 1)[0].trim().toLowerCase() === inkContentType) {
        throw new TypeError('text/ink is built in');
      }
    }
    for (const [id, page] of this.views) {
      getPageOptions(page);
      if (this.viewIds.has(page))
        throw new TypeError(`Duplicate registration of ${page.name}`);
      this.viewIds.set(page, id);
    }
    for (const definition of this.tasks.values())
      resolveTask(definition, this.viewIds);
    this.mcp = createMcpApi(this, options.mcp);
  }

  context(request: Request): Promise<RequestContext> {
    return requestContext(this.options.authenticate, request);
  }

  page<Input>(Page: InkPageClass<Input>, input: NoInfer<Input>): Page {
    const viewId = this.viewIds.get(Page);
    if (!viewId) throw new TypeError(`Unregistered page ${Page.name}`);
    return { viewId, input };
  }

  listPages() {
    return Array.from(this.views, ([viewId, page]) => ({
      viewId,
      acceptsInput: getPageOptions(page).input !== undefined,
    }));
  }

  listTasks() {
    return Array.from(this.tasks.keys(), (taskType) => ({ taskType }));
  }

  externalPage(viewId: string, value: unknown): Page {
    const page = this.getView(viewId);
    const parse = getPageOptions(page).input;
    if (!parse) {
      throw new UnfoldError(
        400,
        'page_requires_task',
        'Provide this page through its task',
      );
    }
    try {
      return { viewId, input: parse(value) };
    } catch (error) {
      if (error instanceof UnfoldError) throw error;
      throw new UnfoldError(
        400,
        'invalid_page_input',
        'Invalid input for this page',
      );
    }
  }

  openPage(context: RequestContext, page: Page, prompt?: string) {
    const View = this.getView(page.viewId) as InkPageClass<unknown>;
    return new View().render({ ...context, input: page.input, prompt });
  }

  async render(context: RequestContext, page: Page): Promise<string> {
    const writer = this.openPage(context, page);
    try {
      context.signal.throwIfAborted();
      return compilePage(await writer.next()).source;
    } finally {
      await writer.return(undefined);
    }
  }

  async respond(
    request: Request,
    handler: (context: RequestContext) => PageResponse | Promise<PageResponse>,
  ): Promise<Response> {
    const accept = request.headers.get('accept') ?? undefined;
    const type = new Negotiator({ headers: { accept } }).mediaType([
      inkMimeType,
      ...this.renderers.keys(),
    ]);
    if (!type) {
      return new Response(null, { status: 406, headers: { Vary: 'Accept' } });
    }

    try {
      const context = await this.context(request);
      const { page, headers: extraHeaders } = await handler(context);
      const source = await this.render(context, page);
      const body =
        type === inkMimeType
          ? source
          : await this.renderers.get(type)!(source, context);
      const headers = new Headers(extraHeaders);
      headers.set('Content-Type', type);
      headers.append('Vary', 'Accept');
      if (!headers.has('Cache-Control'))
        headers.set('Cache-Control', 'no-store');
      return new Response(body, { headers });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async startTask(
    context: RequestContext,
    command: StartTask,
  ): Promise<TaskPage> {
    const graph = this.getTask(command.taskType);
    const taskId = crypto.randomUUID();
    const { node, state } = await graph.start({
      ...context,
      taskId,
      input: command.input,
    });
    context.signal.throwIfAborted();
    const record = {
      taskId,
      user: context.user,
      taskType: command.taskType,
      nodeId: node.id,
      revision: 1,
      state,
    };
    await this.taskStore.create(record);
    return this.taskPageAt(record, graph);
  }

  async taskPage(
    context: RequestContext,
    taskId: string,
    revision?: number,
  ): Promise<TaskPage> {
    const record = await this.ownedTask(context, taskId);
    if (revision !== undefined && revision !== record.revision)
      throw staleRevision();
    return this.taskPageAt(record);
  }

  async sendTaskInput(
    context: RequestContext,
    command: SendTaskInput,
  ): Promise<TaskPage> {
    const current = await this.ownedTask(context, command.taskId);
    if (
      !command.actionId.trim() ||
      !Number.isSafeInteger(command.revision) ||
      command.revision < 1
    ) {
      throw new UnfoldError(
        400,
        'invalid_action',
        'Task input requires an action ID and a positive revision',
      );
    }

    const key = inputKey(command.revision, command.input);
    const previous = await this.taskStore.getAction(
      current.taskId,
      command.actionId,
    );
    if (previous) return this.replay(previous, key);
    if (current.revision !== command.revision) throw staleRevision();

    const graph = this.getTask(current.taskType);
    const { node, state } = await graph.input(current.nodeId, {
      ...context,
      input: command.input,
      state: current.state,
      taskId: current.taskId,
      actionId: command.actionId,
    });
    context.signal.throwIfAborted();
    const result = await this.taskStore.commit(
      { ...current, revision: current.revision + 1, nodeId: node.id, state },
      command.actionId,
      key,
    );

    if (result.kind === 'replayed') return this.replay(result.commit, key);
    if (result.kind === 'conflict') throw staleRevision();
    return this.taskPageAt(result.record, graph);
  }

  private async ownedTask(
    context: RequestContext,
    taskId: string,
  ): Promise<TaskRecord> {
    const record = await this.taskStore.get(taskId);
    if (!record || record.user !== context.user) throw taskMissing();
    return record;
  }

  private replay(previous: TaskCommit, key: string): TaskPage {
    if (previous.key !== key) {
      throw new UnfoldError(
        409,
        'action_id_reused',
        'This action ID was already used for different input',
      );
    }
    return this.taskPageAt(previous.record);
  }

  private taskPageAt(
    record: TaskRecord,
    graph = this.getTask(record.taskType),
  ): TaskPage {
    return {
      taskId: record.taskId,
      revision: record.revision,
      viewId: graph.view(record.nodeId),
      input: record.state,
    };
  }

  private getTask(taskType: string) {
    const definition = this.tasks.get(taskType);
    if (!definition)
      throw new UnfoldError(404, 'unknown_task_type', 'Unknown task type');
    return resolveTask(definition, this.viewIds);
  }

  private getView(viewId: string): InkPageClass {
    const View = this.views.get(viewId);
    if (!View) throw new UnfoldError(404, 'view_not_found', 'Page not found');
    return View;
  }
}

export function createUnfold(options: UnfoldOptions): UnfoldRuntime {
  return new UnfoldRuntime(options);
}
