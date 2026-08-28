# WebUI 浏览器标签页图标（favicon）

## 用户需求

用户在 `public/icon.jpg` 放了一个 logo，希望浏览器打开 WebUI 时标签页能显示该图标。

## 改动小结

1. `public/index.html`：在 `<head>` 中新增 `<link rel="icon" type="image/jpeg" href="/icon.jpg">`
2. `src/server.ts`：后端原先只托管 `/` 单个路由，`/icon.jpg` 会 404；新增 `GET /icon.jpg` 路由，读取 `public/icon.jpg` 并以 `image/jpeg` 返回

`npm run typecheck` 通过。重启服务后刷新页面即可看到标签页图标。
