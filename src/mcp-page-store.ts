import type { ServerEventBus } from '@modelcontextprotocol/server';

export type McpEventBus = ServerEventBus;

export interface McpPage {
  uri: string;
  owner: string;
  viewId: string;
  input: unknown;
  taskId?: string;
  revision?: number;
  source: string;
  expiresAt: number;
  version: number;
  generation?: {
    runId: string;
    status: 'running' | 'done' | 'failed';
    patches: { seq: number; source: string }[];
  };
}

export interface McpPageStore {
  create(page: McpPage): Promise<void>;
  get(uri: string): Promise<McpPage | undefined>;
  /** Atomically replace the page when its version matches the supplied version. */
  update(page: McpPage, expectedVersion: number): Promise<boolean>;
}

export class MemoryMcpPageStore implements McpPageStore {
  private readonly pages = new Map<string, McpPage>();

  async create(page: McpPage): Promise<void> {
    for (const [uri, saved] of this.pages) {
      if (saved.expiresAt <= Date.now()) this.pages.delete(uri);
    }
    if (this.pages.has(page.uri)) throw new Error('Page URI already exists');
    this.pages.set(page.uri, structuredClone(page));
  }

  async get(uri: string): Promise<McpPage | undefined> {
    const page = this.pages.get(uri);
    if (!page || page.expiresAt <= Date.now()) {
      this.pages.delete(uri);
      return undefined;
    }
    return structuredClone(page);
  }

  async update(page: McpPage, expectedVersion: number): Promise<boolean> {
    const saved = this.pages.get(page.uri);
    if (
      !saved ||
      saved.version !== expectedVersion ||
      saved.expiresAt <= Date.now()
    )
      return false;
    this.pages.set(page.uri, structuredClone(page));
    return true;
  }
}
