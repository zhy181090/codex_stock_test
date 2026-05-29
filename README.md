# 股票关系图谱（可手机访问）

这是一个 AI 驱动的股票关系图谱应用，支持：

- 输入股票名称/代码（如 `英伟达`、`NVIDIA`、`NVDA`）
- 生成公司关系图谱（供应链/客户/竞争等）
- 点击节点继续围绕该公司扩展
- 适配云端部署，手机可直接打开公网链接使用

## 本地启动

要求：Node.js 18+

```bash
node server.js
```

打开 [http://localhost:3000](http://localhost:3000)

## 手机上长期访问（推荐：Render）

1. 把项目上传到你的 GitHub 仓库  
2. 登录 [Render](https://render.com/) 并创建 `Web Service`，连接该仓库  
3. 构建命令：`npm install`  
4. 启动命令：`node server.js`  
5. 在环境变量里设置：
   - `DEEPSEEK_API_KEY` = 你的 deepseek key（必填）
   - `DEFAULT_PROVIDER` = `deepseek`
   - `DEFAULT_API_BASE_URL` = `https://api.deepseek.com/v1`
6. 部署完成后会得到 `https://xxx.onrender.com`，手机直接打开就能用

项目已包含 [render.yaml](C:\Users\Administrator\Documents\Codex\2026-05-29\codex-2\render.yaml)，也可以走 Blueprint 导入。

## API

- `GET /api/config`：读取默认配置与服务端是否已配置密钥
- `POST /api/graph`：生成图谱
  - 入参：`modelName`、`apiBaseUrl`、`apiKey`、`centerEntity`、`context`
  - 出参：`{ graph: { nodes: [], edges: [] } }`

## 安全建议

- 正式使用建议把 `DEEPSEEK_API_KEY` 配在服务端环境变量，不要暴露在前端。
- 前端填写的 Key 仅保存在当前浏览器 `localStorage`。
