/** @jsxImportSource @yodaos-pkg/unfold */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createUnfold,
  InkPage,
  Text,
  View,
  type InkPageContext,
} from '@yodaos-pkg/unfold';

@InkPage()
class HelloPage {
  async *render({ input }: InkPageContext<{ name: string }>) {
    yield (
      <View>
        <Text>Hello, {input.name}!</Text>
      </View>
    );
  }
}

const unfold = createUnfold({
  authenticate: () => 'local-demo',
  views: { hello: HelloPage },
});

const app = new Hono();

app.get('/hello/:name', (c) =>
  unfold.respond(c.req.raw, () => ({
    page: unfold.page(HelloPage, { name: c.req.param('name') }),
  })),
);

serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: Number(process.env.PORT ?? 9001),
  },
  ({ port }) => console.log(`Hello Ink at http://127.0.0.1:${port}/hello/Ada`),
);
