import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

interface RidePage {
  taskId: string;
  revision: number;
  viewId: string;
  pageUri: string;
  source: string;
}

function readPage(result: Awaited<ReturnType<Client['callTool']>>): RidePage {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const page = result.structuredContent as Partial<RidePage> | undefined;
  if (
    !page ||
    typeof page.taskId !== 'string' ||
    typeof page.revision !== 'number' ||
    typeof page.viewId !== 'string' ||
    typeof page.pageUri !== 'string' ||
    typeof page.source !== 'string'
  ) {
    throw new Error('Unexpected MCP page result');
  }
  return page as RidePage;
}

const client = new Client(
  { name: 'unfold-ride-demo', version: '0.1.0' },
  { versionNegotiation: { mode: 'auto' } },
);
const endpoint = process.argv[2] ?? 'http://127.0.0.1:9000/mcp';
await client.connect(
  new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: 'Bearer unfold-demo' } },
  }),
);

try {
  const { tools } = await client.listTools();
  console.log(tools.map((tool) => tool.name).join(', '));
  const options = readPage(
    await client.callTool({
      name: 'start_task',
      arguments: {
        taskType: 'ride',
        input: { type: 'text', text: '帮我打车去西湖' },
      },
    }),
  );
  console.log(`${options.viewId}, revision ${options.revision}`);

  client.setNotificationHandler(
    'notifications/resources/updated',
    async ({ params }) => {
      if (params.uri === options.pageUri) console.log('Ink resource updated');
    },
  );
  const subscription = await client.listen({
    resourceSubscriptions: [options.pageUri],
  });
  try {
    const generated = readPage(
      await client.callTool({
        name: 'generate_view',
        arguments: { pageUri: options.pageUri, prompt: '补充上车和行李提示' },
      }),
    );
    console.log(generated.source.slice(options.source.length).trim());
  } finally {
    await subscription.close();
  }

  const review = readPage(
    await client.callTool({
      name: 'send_task_input',
      arguments: {
        taskId: options.taskId,
        revision: options.revision,
        actionId: crypto.randomUUID(),
        input: { type: 'text', text: '第四个' },
      },
    }),
  );
  console.log(`${review.viewId}, revision ${review.revision}`);
  console.log(review.source);
} finally {
  await client.close();
}
