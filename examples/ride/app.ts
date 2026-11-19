import { Hono } from 'hono';
import {
  createUnfold,
  UnfoldError,
  type PageRenderer,
  type TaskPage,
  type TaskStore,
} from '@yodaos-pkg/unfold';
import { OrderReviewPage, RideOptionsPage } from './pages.js';
import { loadRidePreview } from './services.js';
import { RideTask } from './task.js';

interface DemoOptions {
  authenticate?: (request: Request) => string | undefined;
  taskStore?: TaskStore;
  renderPng?: PageRenderer;
}

async function readInput(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new UnfoldError(400, 'invalid_json', 'Expected a JSON object');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnfoldError(400, 'invalid_json', 'Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function rideReply(page: TaskPage) {
  return {
    page,
    headers: {
      'Ride-Task-Id': page.taskId,
      'Ride-Revision': String(page.revision),
    },
  };
}

export function createRideApp(options: DemoOptions = {}) {
  const app = new Hono();
  const unfold = createUnfold({
    authenticate:
      options.authenticate ??
      ((request) =>
        request.headers.get('authorization') === 'Bearer unfold-demo'
          ? 'demo'
          : undefined),
    views: { rideOptions: RideOptionsPage, orderReview: OrderReviewPage },
    tasks: { ride: RideTask },
    taskStore: options.taskStore,
    renderers: options.renderPng ? { 'image/png': options.renderPng } : {},
  });

  app.post('/rides', (c) =>
    unfold.respond(c.req.raw, async (context) => {
      const { destination } = await readInput(context.request);
      return rideReply(
        await unfold.startTask(context, {
          taskType: 'ride',
          input: { type: 'action', name: 'startRide', data: { destination } },
        }),
      );
    }),
  );

  app.post('/rides/:taskId/selection', (c) =>
    unfold.respond(c.req.raw, async (context) => {
      const { revision, actionId, offerId } = await readInput(context.request);
      if (
        typeof revision !== 'number' ||
        typeof actionId !== 'string' ||
        typeof offerId !== 'string'
      ) {
        throw new UnfoldError(
          400,
          'invalid_selection',
          'Expected revision, actionId and offerId',
        );
      }
      return rideReply(
        await unfold.sendTaskInput(context, {
          taskId: c.req.param('taskId'),
          revision,
          actionId,
          input: { type: 'action', name: 'selectOffer', data: { offerId } },
        }),
      );
    }),
  );

  app.get('/rides/:rideId/preview', (c) =>
    unfold.respond(c.req.raw, async (context) => {
      const ride = await loadRidePreview(context.user, c.req.param('rideId'));
      return { page: unfold.page(OrderReviewPage, ride) };
    }),
  );

  app.all('/mcp', (c) => unfold.mcp.fetch(c.req.raw));
  return { app, unfold };
}
