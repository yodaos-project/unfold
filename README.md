# Unfold

English · [简体中文](README.zh-CN.md)

**Build screens that can follow a conversation.**

Imagine asking for a ride, seeing four options, and saying “the fourth one.” Unfold lets your server remember the list and show the right order review on the next turn. The same ride can start from an app or from an AI agent.

Unfold is a TypeScript library for building that kind of experience.

- **Serve a screen from your app.** Define a web route and return an `.ink` page, or render the same page as a PNG.
- **Carry progress across screens.** A Task remembers which options you showed and what the user chose.
- **Connect an AI agent.** The Model Context Protocol (MCP) gives agents a standard way to call your pages and tasks. An agent can also generate small updates for a page as content becomes ready.

## Get started

Open a terminal. You’ll need [Git](https://git-scm.com/install/) to download the code and [Node.js 22 or newer](https://nodejs.org/en/download) to run it. Node.js includes `npm`, which installs the project’s dependencies. The shell commands below work in macOS Terminal, a Linux shell, or Git Bash on Windows.

```sh
git clone https://github.com/yodaos-project/unfold.git
cd unfold
npm ci
```

### Hello Ink

Start with a single page and one route. Run the example from the `unfold` folder.

```sh
npm run demo:hello
```

Keep that terminal open. In another terminal, use `curl` to ask the server for an Ink page.

```sh
curl -H 'Accept: text/ink' http://127.0.0.1:9001/hello/Ada
```

You should see `<page><view><text>Hello, Ada!</text></view></page>`. Change `Ada` in the address to try a different name. The Hono route reads the name from the address and passes it to Unfold. `HelloPage.render()` describes what the page displays. [Hello Ink source](examples/hello.tsx)

## Try the ride demo

The demo uses sample fares and a simulated generator. Everything runs on your computer.

### 1. Start the server

```sh
npm run demo
```

Keep this terminal open. The server is ready when it prints `Unfold ride demo at http://127.0.0.1:9000`.

### 2. Try the AI agent workflow

Open a second terminal in the same `unfold` folder. The included client sends the same requests an AI agent would send to the server.

```sh
npm run demo:mcp
```

The client asks for a ride to West Lake, adds two travel tips, and sends `第四个` (“the fourth one”). The terminal shows the fare list, an update notification, and the order review.

```text
rideOptions, revision 1
Ink resource updated
…
orderReview, revision 2
```

`rideOptions` is the list of fares. `orderReview` is the confirmation screen for the fourth fare. The tips appear as **Ink Snippets**, small pieces of `.ink` that an Ink client can apply to part of an already open page.

### 3. Get a page through HTTP

Use `curl` to send a web request from the second terminal. The `-i` flag shows the response headers along with the page. `Accept: text/ink` asks for an Ink page, and `Content-Type` tells you what came back.

```sh
curl -i http://127.0.0.1:9000/rides/ride_123/preview \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink'
```

Look for `Content-Type: text/ink; charset=utf-8` and a response body beginning with `<page>`. That body is the screen source. An app with the Ink runtime can display it.

<details>
<summary>Start and continue your own ride over HTTP</summary>

Start a ride. Look for `Ride-Task-Id` and `Ride-Revision` in the response headers above the page.

```sh
curl -i http://127.0.0.1:9000/rides \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink' \
  -H 'Content-Type: application/json' \
  -d '{"destination":"西湖"}'
```

Replace `PASTE_THE_TASK_ID_HERE` with the value of `Ride-Task-Id` from that response. A new ride starts at revision `1`.

```sh
TASK_ID='PASTE_THE_TASK_ID_HERE'
curl -i "http://127.0.0.1:9000/rides/${TASK_ID}/selection" \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink' \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"actionId":"pick-4","offerId":"offer_4"}'
```

You’ll see revision `2` and the review page. Keep the same Task ID to continue the same ride. Send the revision the user is currently looking at, and reuse the action ID when retrying the same selection.

</details>

<details>
<summary>Save the same page as a PNG</summary>

If you have a built `ink-open` executable, you can use it to render a page without opening a window. Stop the demo with Ctrl+C and start it again with the path to that executable. [PNG renderer adapter](examples/ride/png.ts)

```sh
INK_OPEN=/absolute/path/to/ink-open npm run demo
```

Ask the same URL for a PNG. The command saves the image as `ride.png` in your current folder.

```sh
curl -f http://127.0.0.1:9000/rides/ride_123/preview \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: image/png' \
  -o ride.png
```

</details>

## How the ride example works

| Piece           | What it does                                                               | Example                                                                                                    |
| --------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Page**        | Describes one screen and the data it needs.                                | [Fare list](examples/ride/pages/ride-options.tsx) and [order review](examples/ride/pages/order-review.tsx) |
| **Task**        | Decides which page to show, where to wait for input, and where to go next. | [The ride’s steps and branches](examples/ride/task.ts)                                                     |
| **HTTP routes** | Let your app start a ride, submit a selection, or request a preview.       | [The demo routes](examples/ride/app.ts)                                                                    |
| **MCP**         | Gives an AI agent a standard way to discover and call those capabilities.  | [The demo agent](examples/ride/agent.ts)                                                                   |

In the ride Task’s `main()` method, read the steps from top to bottom. Unfold loads the fares, shows the options page, and waits for the user. Selecting a fare opens the review page. If the fares expire, `stay()` refreshes the list and waits for another selection.

```ts
main() {
  return step('quote', this.loadQuotes).to(
    waitForInput('options', RideOptionsPage, this.chooseOffer)
      .on('selected', end('review', OrderReviewPage))
      .on('refreshed', stay()),
  );
}
```

The demo keeps tasks in memory, so restarting the server clears them. Applications can provide their own storage to keep task state across server restarts.

An HTTP request returns the first page. When an agent calls `generate_view`, Unfold continues reading the page’s `yield` statements and delivers updates as Ink Snippets.

### Connect your own MCP client

Point a client that supports MCP over HTTP at `http://127.0.0.1:9000/mcp` and set the `Authorization` header to `Bearer unfold-demo`. [MCP introduction](https://modelcontextprotocol.io/docs/getting-started/intro)

These three tool calls take the ride from the first request to the order review.

1. `start_task` returns the options page and a Task ID.
2. `generate_view` takes the page’s `pageUri` and returns the page with the generated tips.
3. `send_task_input` takes the same Task ID, the displayed revision, and the user’s answer to continue the ride.

Clients that support resource subscriptions on MCP version `2026-07-28` can read Ink Snippets as generation runs. Older MCP clients receive the complete result when the tool finishes.

## Contribute

A good first contribution is improving an example or reporting a step that was hard to follow. For a bug report, include the command you ran, what you expected, and what you saw. [Open an issue](https://github.com/yodaos-project/unfold/issues)

Run these checks after making changes.

```sh
npm test
npm run format:check
```

Set `INK_OPEN` when running `npm test` to include the native PNG rendering check.
