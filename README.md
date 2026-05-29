# 股票深层垄断关系图谱

本版本能力：

- 深层垄断链路挖掘（2~4级上游隐藏节点）
- 关系类型固定为：`刚需垄断 / 技术壁垒 / 国产替代 / 缺货催化`
- 关系文本沿连线方向显示，减少堆叠
- 单中心图谱切换 + 回退 + 本地缓存
- 节点周涨跌染色、主力净流入两行标注、周数据状态点
- 图谱下方展示近期新闻与 AI 简析

## 启动

```bash
node server.js
```

访问 `http://localhost:3000`

## 环境变量

核心（必须其一：前端输入 key 或服务端变量）：

- `DEEPSEEK_API_KEY`
- `DEFAULT_PROVIDER=deepseek`
- `DEFAULT_API_BASE_URL=https://api.deepseek.com/v1`

增强数据（可选，建议你接自己的聚合服务）：

- `FINANCE_API_BASE_URL`：提供 `GET /enrich?ticker=...`
- `FINANCE_API_KEY`：可选鉴权
- `NEWS_API_BASE_URL`：提供 `GET /news?q=...&limit=8`
- `NEWS_API_KEY`：可选鉴权

## 增强数据接口约定

### 1) 金融增强接口

`GET {FINANCE_API_BASE_URL}/enrich?ticker=000001`

返回示例：

```json
{
  "weeklyReturnPct": 5.2,
  "mainFundNetInflow": 135000000,
  "dataWeek": "this_week"
}
```

### 2) 新闻接口

`GET {NEWS_API_BASE_URL}/news?q=英伟达&limit=8`

返回示例：

```json
{
  "items": [
    {
      "title": "标题",
      "url": "https://...",
      "source": "来源",
      "publishedAt": "2026-05-29"
    }
  ]
}
```

## 染色规则

- `>= +10%` `#FF0000`
- `+5% ~ +9.99%` `#FF4444`
- `+2% ~ +4.99%` `#FF8888`
- `0% ~ +1.99%` `#FFBBBB`
- `-1.99% ~ 0%` `#88FF88`
- `-4.99% ~ -2%` `#44FF44`
- `-9.99% ~ -5%` `#00CC00`
- `<= -10%` `#00FF00`
