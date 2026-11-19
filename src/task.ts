import type { RequestContext } from './context.js';
import { UnfoldError } from './errors.js';
import type { InkPageClass } from './ink.js';

export type TaskInput =
  | { type: 'text'; text: string }
  | { type: 'action'; name: string; data: Record<string, unknown> };

export interface TaskStartContext extends RequestContext {
  input: TaskInput;
  taskId: string;
  actionId?: string;
}

export interface TaskInputContext<State> extends TaskStartContext {
  state: State;
}

type Handler<Input, Output> = (context: Input) => Output | Promise<Output>;
type Outcome = { outcome: string; state: unknown };

const currentNode = Symbol('stay');

interface Step {
  kind: 'step';
  id: string;
  run(context: TaskInputContext<unknown>): unknown | Promise<unknown>;
  next?: Node;
}

interface Wait {
  kind: 'wait';
  id: string;
  page: InkPageClass;
  run(context: TaskInputContext<unknown>): Outcome | Promise<Outcome>;
  branches: Map<string, Node | typeof currentNode>;
}

interface End {
  kind: 'end';
  id: string;
  page: InkPageClass;
}

type Node = Step | Wait | End;

class TaskNode<State> {
  declare readonly input: (state: State) => void;
  constructor(readonly node: Node) {}
}

class StepNode<State, Output> extends TaskNode<State> {
  constructor(private readonly step: Step) {
    super(step);
  }

  to(target: TaskNode<NoInfer<Output>>): this {
    if (this.step.next)
      throw new TypeError(`Duplicate edge from ${this.step.id}`);
    this.step.next = target.node;
    return this;
  }
}

type OutcomeState<Result extends Outcome, Label> = Extract<
  Result,
  { outcome: Label }
>['state'];

class WaitNode<State, Result extends Outcome> extends TaskNode<State> {
  constructor(private readonly wait: Wait) {
    super(wait);
  }

  on<Label extends Result['outcome']>(
    outcome: Label,
    target:
      | TaskNode<NoInfer<OutcomeState<Result, Label>>>
      | (OutcomeState<Result, Label> extends State
          ? typeof currentNode
          : never),
  ): this {
    if (this.wait.branches.has(outcome)) {
      throw new TypeError(`Duplicate outcome ${outcome} in ${this.wait.id}`);
    }
    this.wait.branches.set(
      outcome,
      target === currentNode ? target : target.node,
    );
    return this;
  }
}

export function step<Output, State = unknown>(
  id: string,
  run: Handler<TaskInputContext<State>, Output>,
): StepNode<State, Output> {
  return new StepNode({
    kind: 'step',
    id,
    run: run as Handler<TaskInputContext<unknown>, Output>,
  });
}

export function waitForInput<State, Result extends Outcome>(
  id: string,
  page: InkPageClass<State>,
  run: Handler<TaskInputContext<NoInfer<State>>, Result>,
): WaitNode<State, Result> {
  return new WaitNode({
    kind: 'wait',
    id,
    page,
    run: run as Handler<TaskInputContext<unknown>, Result>,
    branches: new Map(),
  });
}

export function end<State>(
  id: string,
  page: InkPageClass<State>,
): TaskNode<State> {
  return new TaskNode({ kind: 'end', id, page });
}

export function stay(): typeof currentNode {
  return currentNode;
}

interface TaskDefinition {
  main(): TaskNode<unknown>;
}

type TaskClass = new () => TaskDefinition;
export type RegisteredTask = TaskClass | TaskDefinition;

const taskClasses = new WeakSet<TaskClass>();

export function Task() {
  return (definition: TaskClass) => {
    taskClasses.add(definition);
  };
}

export function defineTask(definition: TaskDefinition): TaskDefinition {
  return definition;
}

export function resolveTask(
  definition: RegisteredTask,
  viewIds: ReadonlyMap<InkPageClass, string>,
) {
  if (typeof definition === 'function' && !taskClasses.has(definition)) {
    throw new TypeError(`${definition.name} must use @Task()`);
  }
  const instance =
    typeof definition === 'function' ? new definition() : definition;
  const root = instance.main().node;
  const nodes = new Map<string, Node>();

  function visit(node: Node) {
    if (nodes.get(node.id) === node) return;
    if (!node.id || nodes.has(node.id))
      throw new TypeError(`Duplicate or empty task node ID: ${node.id}`);
    nodes.set(node.id, node);
    if (node.kind === 'step') {
      if (!node.next) throw new TypeError(`Step ${node.id} needs a next node`);
      visit(node.next);
      return;
    }
    if (!viewIds.has(node.page))
      throw new TypeError(`Unregistered task page ${node.page.name}`);
    if (node.kind === 'wait') {
      if (!node.branches.size)
        throw new TypeError(`Waiting node ${node.id} needs a branch`);
      for (const target of node.branches.values()) {
        if (target !== currentNode) visit(target);
      }
    }
  }

  visit(root);

  async function advance(node: Node, context: TaskInputContext<unknown>) {
    let state = context.state;
    const executed = new Set<Step>();
    while (node.kind === 'step') {
      if (executed.has(node))
        throw new TypeError(`Automatic task cycle at ${node.id}`);
      executed.add(node);
      context.signal.throwIfAborted();
      state = await node.run.call(instance, { ...context, state });
      node = node.next!;
    }
    return { node, state };
  }

  return {
    start(context: TaskStartContext) {
      return advance(root, { ...context, state: undefined });
    },
    async input(nodeId: string, context: TaskInputContext<unknown>) {
      const node = nodes.get(nodeId);
      if (!node || node.kind !== 'wait') {
        throw new UnfoldError(
          409,
          'task_not_waiting',
          'This task is not waiting for input',
        );
      }
      const result = await node.run.call(instance, context);
      const target = node.branches.get(result.outcome);
      if (!target)
        throw new TypeError(`Unknown outcome ${result.outcome} in ${nodeId}`);
      return advance(target === currentNode ? node : target, {
        ...context,
        state: result.state,
      });
    },
    view(nodeId: string) {
      const node = nodes.get(nodeId);
      if (!node || node.kind === 'step')
        throw new TypeError(`Missing saved task page: ${nodeId}`);
      return viewIds.get(node.page)!;
    },
  };
}
