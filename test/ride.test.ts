import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { getRequestListener } from '@hono/node-server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { MemoryTaskStore, type TaskRecord } from '@yodaos-pkg/unfold';
import { createRideApp } from '../examples/ride/app.js';
import { headlessPng } from '../examples/ride/png.js';

const headers = { Authorization: 'Bearer unfold-demo', Accept: 'text/ink' };

function json(body: object, accept = 'text/ink'): RequestInit {
  return {
    method: 'POST',
    headers: { ...headers, Accept: accept, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

interface ToolPage {
  taskId: string;
  revision: number;
  viewId: string;
  pageUri: string;
  mimeType: string;
  source: string;
}

function pageResult(result: Awaited<ReturnType<Client['callTool']>>): ToolPage {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const data = result.structuredContent as unknown as ToolPage;
  assert.equal(typeof data.source, 'string');
  assert.equal(typeof data.pageUri, 'string');
  assert.equal(data.mimeType, 'text/ink; charset=utf-8');
  return data;
}

async function listen(t: TestContext, demo: ReturnType<typeof createRideApp>) {
  const server = createServer(getRequestListener(demo.app.fetch));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await demo.unfold.mcp.close();
    await close(server);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function connect(
  t: TestContext,
  url: string,
  token = 'unfold-demo',
  modern = true,
) {
  const client = new Client(
    { name: 'unfold-integration-test', version: '1.0.0' },
    { versionNegotiation: { mode: modern ? 'auto' : 'legacy' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  t.after(() => client.close());
  return client;
}

const pickFourth = {
  revision: 1,
  actionId: 'pick-fourth',
  offerId: 'offer_4',
};

test('custom routes negotiate the same page and advance the Task once', async () => {
  let presentedSource = '';
  const { app } = createRideApp({
    renderPng(source) {
      presentedSource = source;
      return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
  });

  const url = '/rides/ride_123/preview';
  const preview = await app.request(url, { headers });
  assert.equal(preview.headers.get('Content-Type'), 'text/ink; charset=utf-8');
  assert.equal(preview.headers.get('Vary'), 'Accept');
  const source = await preview.text();
  assert.match(source, /确认行程.*舒适型 ¥45\.00/);
  const utf8 = await app.request(url, {
    headers: { ...headers, Accept: 'text/ink; charset=utf-8' },
  });
  assert.equal(await utf8.text(), source);

  const png = await app.request(url, {
    headers: { ...headers, Accept: 'text/ink;q=0.3, image/png;q=0.9' },
  });
  assert.equal(png.headers.get('Content-Type'), 'image/png');
  assert.equal((await png.arrayBuffer()).byteLength, 8);
  assert.equal(presentedSource, source);
  assert.equal(
    (
      await app.request(url, { headers: { ...headers, Accept: '*/*' } })
    ).headers.get('Content-Type'),
    'text/ink; charset=utf-8',
  );
  assert.equal(
    (await app.request('/rides', json({}, 'text/ink;q=0,*/*;q=0'))).status,
    406,
  );
  assert.equal(
    (await app.request('/v1/generate', { method: 'POST' })).status,
    404,
  );

  const started = await app.request('/rides', json({ destination: '西湖' }));
  const taskId = started.headers.get('Ride-Task-Id');
  assert.ok(taskId);
  assert.equal(started.headers.get('Ride-Revision'), '1');
  const initial = await started.text();
  assert.match(initial, /4\. 舒适型 ¥45\.00/);
  assert.match(initial, /bindtap="unfoldAction3"/);
  assert.match(initial, /this\.postMessage/);
  assert.match(initial, /<\?marker name="tips">/);
  assert.doesNotMatch(initial, /<template for=|请先确认上车地点/);

  const selection = `/rides/${taskId}/selection`;
  const [result, conflicting] = await Promise.all([
    app.request(selection, json(pickFourth)),
    app.request(selection, json({ ...pickFourth, actionId: 'another-tap' })),
  ]);
  const [committed, stale] =
    result.status === 200 ? [result, conflicting] : [conflicting, result];
  assert.equal(committed.headers.get('Ride-Revision'), '2');
  const review = await committed.text();
  assert.match(review, /确认行程.*舒适型 ¥45\.00/);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'stale_revision');

  const retry = await app.request(
    selection,
    json({
      ...pickFourth,
      actionId: result.status === 200 ? 'pick-fourth' : 'another-tap',
    }),
  );
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), review);
  assert.equal(
    (
      await app.request(
        selection,
        json({
          ...pickFourth,
          actionId: result.status === 200 ? 'pick-fourth' : 'another-tap',
          offerId: 'offer_1',
        }),
      )
    ).status,
    409,
  );
});

test('refreshing an expired quote stays on the options node', async () => {
  class ExpiringStore extends MemoryTaskStore {
    override async create(record: TaskRecord) {
      return super.create({
        ...record,
        state: { ...(record.state as object), expiresAt: 0 },
      });
    }
  }
  const { app } = createRideApp({ taskStore: new ExpiringStore() });
  const created = await app.request('/rides', json({ destination: '西湖' }));
  const taskId = created.headers.get('Ride-Task-Id');
  assert.ok(taskId);
  const refreshed = await app.request(
    `/rides/${taskId}/selection`,
    json(pickFourth),
  );
  assert.equal(refreshed.headers.get('Ride-Revision'), '2');
  assert.match(await refreshed.text(), /报价已更新，请重新选择/);
  const review = await app.request(
    `/rides/${taskId}/selection`,
    json({
      ...pickFourth,
      revision: 2,
      actionId: 'pick-after-refresh',
    }),
  );
  assert.equal(review.headers.get('Ride-Revision'), '3');
  assert.match(await review.text(), /确认行程/);
});

test(
  'MCP exposes registered pages and tasks and streams native Ink snippets',
  { timeout: 12_000 },
  async (t) => {
    const demo = createRideApp({
      authenticate(request) {
        const token = request.headers.get('authorization');
        if (token === 'Bearer unfold-demo') return 'demo';
        if (token === 'Bearer other-user') return 'other-user';
        return undefined;
      },
    });
    const url = await listen(t, demo);
    const client = await connect(t, url);
    const otherUser = await connect(t, url, 'other-user');
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    for (const name of [
      'list_tasks',
      'list_pages',
      'start_task',
      'send_task_input',
      'render_view',
      'generate_view',
    ]) {
      assert.ok(tools.includes(name));
    }
    const pages = await client.callTool({ name: 'list_pages' });
    assert.deepEqual(pages.structuredContent, {
      pages: [
        { viewId: 'rideOptions', acceptsInput: false },
        { viewId: 'orderReview', acceptsInput: false },
      ],
    });
    const started = pageResult(
      await client.callTool({
        name: 'start_task',
        arguments: {
          taskType: 'ride',
          input: { type: 'text', text: '帮我打车去西湖' },
        },
      }),
    );
    assert.equal(started.viewId, 'rideOptions');
    assert.equal(started.revision, 1);
    assert.doesNotMatch(started.source, /<template for=/);
    const denied = await otherUser.callTool({
      name: 'generate_view',
      arguments: { pageUri: started.pageUri, prompt: '补充提示' },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /page_not_found/);
    await assert.rejects(
      otherUser.listen(
        { resourceSubscriptions: [started.pageUri] },
        { timeout: 1000 },
      ),
    );

    const updates = new EventEmitter();
    client.setNotificationHandler(
      'notifications/resources/updated',
      async ({ params }) => {
        if (params.uri === started.pageUri) updates.emit('updated');
      },
    );
    const subscription = await client.listen(
      { resourceSubscriptions: [started.pageUri] },
      { timeout: 3000 },
    );
    t.after(() => subscription.close());
    assert.deepEqual(subscription.honoredFilter.resourceSubscriptions, [
      started.pageUri,
    ]);
    const update = once(updates, 'updated', {
      signal: AbortSignal.timeout(5000),
    });
    const output = client.callTool({
      name: 'generate_view',
      arguments: { pageUri: started.pageUri, prompt: '补充上车和行李提示' },
    });
    await update;
    const partial = await client.readResource(
      { uri: started.pageUri },
      { cacheMode: 'bypass' },
    );
    assert.ok('text' in partial.contents[0]);
    const snapshot = JSON.parse(partial.contents[0].text);
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.patches[0].seq, 1);
    assert.match(
      snapshot.patches[0].source,
      /<template for="tips">.*<\?marker name="tips"><\/template>/,
    );
    const generated = pageResult(await output);
    assert.ok(generated.source.startsWith(started.source));
    assert.match(generated.source, /请先确认上车地点/);
    assert.match(generated.source, /携带行李/);
    assert.equal(generated.source.match(/<template for="tips">/g)?.length, 2);

    if (process.env.INK_OPEN) {
      const render = headlessPng(process.env.INK_OPEN);
      const request = new Request(url);
      const context = { request, user: 'demo', signal: request.signal };
      const initialPng = await render(started.source, context);
      const generatedPng = await render(generated.source, context);
      assert.ok(initialPng instanceof Uint8Array);
      assert.ok(generatedPng instanceof Uint8Array);
      assert.notDeepEqual(
        generatedPng,
        initialPng,
        'Ink renders the appended tips',
      );
    }

    const legacy = await connect(t, url, 'unfold-demo', false);
    const recovered = pageResult(
      await legacy.callTool({
        name: 'render_view',
        arguments: { taskId: started.taskId, revision: 1 },
      }),
    );
    assert.equal(recovered.source, started.source);
    await subscription.close();

    const review = pageResult(
      await client.callTool({
        name: 'send_task_input',
        arguments: {
          taskId: started.taskId,
          revision: 1,
          actionId: 'voice-fourth',
          input: { type: 'text', text: '第四个' },
        },
      }),
    );
    assert.equal(review.taskId, started.taskId);
    assert.equal(review.revision, 2);
    assert.equal(review.viewId, 'orderReview');
    assert.match(review.source, /确认行程.*舒适型 ¥45\.00/);
    const stale = await client.callTool({
      name: 'generate_view',
      arguments: { pageUri: started.pageUri, prompt: '补充提示' },
    });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /stale_revision/);

    const http = await demo.app.request(
      '/rides',
      json({ destination: '西湖' }),
    );
    const httpTaskId = http.headers.get('Ride-Task-Id');
    assert.ok(httpTaskId);
    const acrossTransports = pageResult(
      await client.callTool({
        name: 'send_task_input',
        arguments: {
          taskId: httpTaskId,
          revision: 1,
          actionId: 'continue-http-from-mcp',
          input: { type: 'text', text: '第四个' },
        },
      }),
    );
    assert.equal(acrossTransports.taskId, httpTaskId);
    assert.equal(acrossTransports.viewId, 'orderReview');
  },
);

test(
  'native Ink headless renders the HTTP page to a PNG',
  {
    skip: process.env.INK_OPEN
      ? false
      : 'Set INK_OPEN to a built ink-open binary',
    timeout: 20_000,
  },
  async () => {
    const { app } = createRideApp({
      renderPng: headlessPng(process.env.INK_OPEN!),
    });
    const response = await app.request('/rides/ride_123/preview', {
      headers: { ...headers, Accept: 'image/png' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(bytes.readUInt32BE(16), 480);
    assert.equal(bytes.readUInt32BE(20), 352);
  },
);
