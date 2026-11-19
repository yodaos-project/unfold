import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { PageRenderer } from '@yodaos-pkg/unfold';

const run = promisify(execFile);

export function headlessPng(inkOpen: string): PageRenderer {
  return async (source, { signal }) => {
    const directory = await mkdtemp(join(tmpdir(), 'unfold-'));
    try {
      const input = join(directory, 'page.ink');
      const output = join(directory, 'page.png');
      await writeFile(input, source);
      await run(
        inkOpen,
        [
          input,
          '--headless',
          '--window-size=480,352',
          '--timeout=5000',
          '--capture-after=content-ready',
          `--screenshot=${output}`,
        ],
        { timeout: 12_000, signal },
      );
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
