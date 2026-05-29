# 股票关系图谱（移动端优化版）

主要特性：

- 中文关系展示：`关系中文名 + 中文简述`
- 单中心视图：点击节点后，清空旧图并以该节点重建新图
- 历史回退：可返回上一步中心公司
- 本地缓存：同一公司短期内优先读缓存，减少 token 消耗
- 手动刷新：需要最新关系时可强制重拉
- 触控优化：单指拖动、双指捏合缩放、滚轮缩放

## 本地运行

要求：Node.js 18+

```bash
node server.js
```

访问：[http://localhost:3000](http://localhost:3000)

## 云端部署（Render）

项目可直接部署到 Render，手机可长期访问公网链接。

环境变量：

- `DEEPSEEK_API_KEY`（必填，建议仅服务端保存）
- `DEFAULT_PROVIDER=deepseek`
- `DEFAULT_API_BASE_URL=https://api.deepseek.com/v1`

## 缓存策略

- 缓存键：`中心公司 + 模型 + API Base URL`
- TTL：6 小时
- 上限：30 个图谱（超出按最近使用保留）

## 接口

- `GET /api/config`：默认配置与密钥状态
- `POST /api/graph`：生成图谱
  - 入参：`modelName`、`apiBaseUrl`、`apiKey`、`centerEntity`
  - 出参：`{ graph: { nodes, edges } }`
