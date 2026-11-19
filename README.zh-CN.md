# Unfold

[English](README.md) · 简体中文

**让界面随着多轮对话更新。**

你说「帮我打车去西湖」，应用列出四个报价。你接着说「第四个」，服务端就能根据刚才展示的列表打开对应的订单确认页。你可以在应用里发起这次打车，也可以交给 AI Agent（智能体）发起。

Unfold 是一个 TypeScript 库，用来构建这样的交互。

- **让应用返回界面。** 给页面定义一个网址，就可以返回 `.ink` 源码，也可以把同一页渲染成 PNG 图片。
- **在页面之间记住进度。** 每次打车都是一个 Task。它记录展示过哪些报价，以及用户选了哪一个。
- **让 AI Agent 调用你的应用。** Agent 可以通过模型上下文协议（MCP）调用已有的页面和任务，也可以在内容生成时逐块更新页面。

## 试跑打车示例

示例使用固定报价和模拟生成器，所有代码都在你的电脑上运行。

### 1. 启动服务

打开终端。你需要 [Git](https://git-scm.com/install/) 下载代码，以及 [Node.js 22 或更新版本](https://nodejs.org/en/download) 运行项目。Node.js 自带的 `npm` 会安装项目所需的依赖。下面的命令可以在 macOS 终端、Linux 终端或 Windows 的 Git Bash 中运行。

```sh
git clone https://github.com/yodaos-project/unfold.git
cd unfold
npm ci
npm run demo
```

保持这个终端打开。看到 `Unfold ride demo at http://127.0.0.1:9000` 时，服务就启动好了。

### 2. 体验 AI Agent 的工作流程

打开第二个终端，进入同一个 `unfold` 文件夹。运行下面的命令，示例客户端会模拟 AI Agent 向服务端发送请求。

```sh
npm run demo:mcp
```

客户端先请求打车去西湖，再给页面补充两条出行提示，最后说「第四个」。终端会依次显示报价列表、页面更新通知和订单确认页。

```text
rideOptions, revision 1
Ink resource updated
…
orderReview, revision 2
```

`rideOptions` 是报价列表，`orderReview` 是第四个报价的确认页。出行提示以 **Ink Snippet（局部更新片段）** 的形式返回，Ink 客户端可以用它更新已打开页面的一部分。

### 3. 通过 HTTP 获取页面

在第二个终端用 `curl` 发送请求。`-i` 会同时显示响应头和页面源码。`Accept: text/ink` 表示你希望收到 Ink 页面，响应里的 `Content-Type` 会告诉你实际返回的格式。

```sh
curl -i http://127.0.0.1:9000/rides/ride_123/preview \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink'
```

你会看到 `Content-Type: text/ink; charset=utf-8`，以及以 `<page>` 开头的内容。这段内容就是页面源码，可以交给集成了 Ink Runtime 的应用显示。

<details>
<summary>通过 HTTP 开始打车并选择报价</summary>

先发起一次打车。响应头里会有 `Ride-Task-Id` 和 `Ride-Revision`，分别表示任务编号和页面版本。

```sh
curl -i http://127.0.0.1:9000/rides \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink' \
  -H 'Content-Type: application/json' \
  -d '{"destination":"西湖"}'
```

把下面的 `PASTE_THE_TASK_ID_HERE` 换成刚才返回的 `Ride-Task-Id`。新任务从版本 `1` 开始。

```sh
TASK_ID='PASTE_THE_TASK_ID_HERE'
curl -i "http://127.0.0.1:9000/rides/${TASK_ID}/selection" \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: text/ink' \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"actionId":"pick-4","offerId":"offer_4"}'
```

这次会返回版本 `2` 和订单确认页。继续同一次打车时，始终使用同一个任务编号，并带上用户正在看的页面版本。重试同一次选择时，沿用原来的 `actionId`。

</details>

<details>
<summary>把同一页面保存为 PNG 图片</summary>

如果你已经编译了 `ink-open`，就可以用它在后台渲染图片。先用 Ctrl+C 停止示例服务，再带上可执行文件的路径重新启动。[PNG 渲染适配器](examples/ride/png.ts)

```sh
INK_OPEN=/absolute/path/to/ink-open npm run demo
```

对同一个网址请求 PNG。下面的命令会把图片保存为当前文件夹里的 `ride.png`。

```sh
curl -f http://127.0.0.1:9000/rides/ride_123/preview \
  -H 'Authorization: Bearer unfold-demo' \
  -H 'Accept: image/png' \
  -o ride.png
```

</details>

## 写出第一个页面

用编辑器打开项目，创建 `examples/hello.tsx`。下面的例子用 Hono 接收请求，再让 Unfold 渲染页面。路由就是应用接收请求的地址。这里的 `/hello/:name` 会把地址末尾的名字交给页面。

```tsx
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

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 9001 });
```

在终端中运行这个例子。

```sh
npm run build
npm exec -- tsx examples/hello.tsx
```

保持这个终端打开，再从另一个终端请求页面。

```sh
curl -H 'Accept: text/ink' http://127.0.0.1:9001/hello/Ada
```

你会看到 `<page><view><text>Hello, Ada!</text></view></page>`。可以把地址里的 `Ada` 改成别的名字，也可以修改 `<Text>` 里的文案。页面布局写在 `render()` 里，第一次 `yield` 把页面交给 Unfold 返回。

## 打车示例是怎么工作的

| 组成部分         | 负责什么                                         | 对应代码                                                                                             |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Page（页面）** | 定义一个界面，以及它需要的数据。                 | [报价列表](examples/ride/pages/ride-options.tsx)和[订单确认页](examples/ride/pages/order-review.tsx) |
| **Task（任务）** | 决定展示哪个页面、何时等待输入，以及下一步去哪。 | [打车的步骤和分支](examples/ride/task.ts)                                                            |
| **HTTP 路由**    | 让应用发起打车、提交选择或预览页面。             | [示例路由](examples/ride/app.ts)                                                                     |
| **MCP**          | 让 AI Agent 发现并调用这些能力。                 | [示例客户端](examples/ride/agent.ts)                                                                 |

从上到下看打车任务的 `main()`。Unfold 查询报价，展示列表，然后等用户选择。选中报价就打开确认页。报价过期时，`stay()` 会刷新列表并等待用户重新选择。

```ts
main() {
  return step('quote', this.loadQuotes).to(
    waitForInput('options', RideOptionsPage, this.chooseOffer)
      .on('selected', end('review', OrderReviewPage))
      .on('refreshed', stay()),
  );
}
```

示例把任务存放在内存中，重启服务会清空这些任务。你也可以接入自己的存储，让任务在服务重启后继续。

HTTP 请求返回页面的首屏。Agent 调用 `generate_view` 时，Unfold 会继续读取页面中后续的 `yield`，并以 Ink Snippet 的形式提供局部更新。

### 接入你自己的 MCP 客户端

如果客户端支持通过 HTTP 连接 MCP，把服务地址设为 `http://127.0.0.1:9000/mcp`，并将 `Authorization` 请求头设为 `Bearer unfold-demo`。[MCP 入门介绍](https://modelcontextprotocol.io/docs/getting-started/intro)

下面三个工具调用会把打车从首次请求推进到订单确认。

1. `start_task` 返回报价列表和任务编号。
2. `generate_view` 接收页面的 `pageUri`，返回包含生成提示的页面。
3. `send_task_input` 接收同一个任务编号、正在展示的页面版本和用户回答，继续这次打车。

支持 MCP `2026-07-28` 版本资源订阅的客户端，可以在生成过程中读取 Ink Snippet。较早版本的客户端会在工具调用结束时收到完整结果。

## 参与贡献

改进示例或指出难以跟上的步骤，都是很好的第一次贡献。反馈问题时，请带上你运行的命令、预期结果和实际看到的结果。[提交 Issue](https://github.com/yodaos-project/unfold/issues)

修改完成后，运行下面的检查。

```sh
npm test
npm run format:check
```

运行 `npm test` 时设置 `INK_OPEN`，还可以验证 Ink 的 PNG 渲染。
