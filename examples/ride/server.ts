import { serve } from '@hono/node-server';
import { createRideApp } from './app.js';
import { headlessPng } from './png.js';

const port = Number(process.env.PORT ?? 9000);
const { app } = createRideApp({
  renderPng: process.env.INK_OPEN
    ? headlessPng(process.env.INK_OPEN)
    : undefined,
});
serve(
  {
    fetch(request) {
      const hostname = new URL(request.url).hostname;
      if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        return new Response('Invalid demo host', { status: 403 });
      }
      return app.fetch(request);
    },
    hostname: '127.0.0.1',
    port,
  },
  ({ address, port }) => {
    console.log(`Unfold ride demo at http://${address}:${port}`);
  },
);
