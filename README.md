# Unfold

Unfold is a TypeScript server framework for rendering Ink pages and exposing multi-turn tasks to AI agents over MCP.

Applications own their HTTP routes. Unfold renders a complete `.ink` page as `text/ink`, or uses a configured renderer for a representation such as `image/png`. MCP serves the same registered tasks and views, and runs the generation phase that produces Ink Snippets.

## Run the ride example

Use Node.js 22 or later.

```sh
npm ci
npm run demo
```

Start a ride over the application's HTTP route.

```sh
curl -i http://127.0.0.1:9000/rides \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink' \
  --json '{"destination":"西湖"}'
```

Put the returned `Ride-Task-Id` in `TASK_ID` and submit a selection against the displayed revision.

```sh
curl -i "http://127.0.0.1:9000/rides/${TASK_ID}/selection" \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink' \
  --json '{"revision":1,"actionId":"pick-4","offerId":"offer_4"}'
```

In another terminal, run the MCP client against the same server.

```sh
npm run demo:mcp
```

The client starts a ride, subscribes to page updates, calls `generate_view`, and sends 「第四个」 for the same task. The demo uses fixed quotes and a simulated asynchronous text generator.

### PNG output

Set `INK_OPEN` to a built Ink `ink-open` binary before starting the demo to enable the PNG renderer. The same URL serves both representations.

```sh
curl -i http://127.0.0.1:9000/rides/ride_123/preview \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink'

curl http://127.0.0.1:9000/rides/ride_123/preview \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: image/png' \
  -o ride.png
```

## Application structure

- [Custom HTTP routes and the MCP mount](examples/ride/app.ts) use the same runtime. `respond()` negotiates the representation before invoking the route callback.
- [The ride task](examples/ride/task.ts) declares its entry and branches in `main()`. Tasks persist a node, state, and revision. Retried actions use the same action ID and input.
- [The Ink pages](examples/ride/pages.tsx) yield the first page, then yield named updates. HTTP takes the first yield. MCP `generate_view` consumes the updates and returns the assembled Source.

Live MCP updates use resource subscriptions on protocol version `2026-07-28`. Legacy clients can use the tools and receive the completed generation result. The example binds to loopback and uses the local demo token. Its stores and notifications live in memory. Deployments can inject shared `TaskStore`, `McpPageStore`, and `McpEventBus` implementations.

The initial Ink JSX renderer accepts `View`, `Text`, `Button`, and append or replace regions. Literal braces are reserved because Ink evaluates WXML template bindings after entity decoding.

## Verify

```sh
npm test
npm run format:check
```

Set `INK_OPEN` when running the tests to include native Ink headless rendering.
