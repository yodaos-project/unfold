export interface TaskRecord {
  taskId: string;
  user: string;
  taskType: string;
  nodeId: string;
  revision: number;
  state: unknown;
}

export interface TaskCommit {
  key: string;
  record: TaskRecord;
}

export type TaskCommitResult =
  | { kind: 'committed'; record: TaskRecord }
  | { kind: 'replayed'; commit: TaskCommit }
  | { kind: 'conflict' };

export interface TaskStore {
  create(record: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  getAction(taskId: string, actionId: string): Promise<TaskCommit | undefined>;
  /** Atomically check the revision, save the record, and remember the action outcome. */
  commit(
    record: TaskRecord,
    actionId: string,
    key: string,
  ): Promise<TaskCommitResult>;
}

export class MemoryTaskStore implements TaskStore {
  private readonly records = new Map<
    string,
    { record: TaskRecord; actions: Map<string, TaskCommit> }
  >();

  async create(record: TaskRecord): Promise<void> {
    if (this.records.has(record.taskId))
      throw new Error('Task ID already exists');
    this.records.set(record.taskId, {
      record: structuredClone(record),
      actions: new Map(),
    });
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return structuredClone(this.records.get(taskId)?.record);
  }

  async getAction(
    taskId: string,
    actionId: string,
  ): Promise<TaskCommit | undefined> {
    return structuredClone(this.records.get(taskId)?.actions.get(actionId));
  }

  async commit(
    record: TaskRecord,
    actionId: string,
    key: string,
  ): Promise<TaskCommitResult> {
    const saved = this.records.get(record.taskId);
    if (!saved) return { kind: 'conflict' };
    const previous = saved.actions.get(actionId);
    if (previous)
      return { kind: 'replayed', commit: structuredClone(previous) };
    if (saved.record.revision + 1 !== record.revision)
      return { kind: 'conflict' };
    const commit = { key, record: structuredClone(record) };
    saved.record = commit.record;
    saved.actions.set(actionId, commit);
    return { kind: 'committed', record: structuredClone(commit.record) };
  }
}
