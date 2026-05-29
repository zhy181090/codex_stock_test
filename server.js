const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || "deepseek";
const DEFAULT_API_BASE_URL = process.env.DEFAULT_API_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const FINANCE_API_BASE_URL = process.env.FINANCE_API_BASE_URL || "";
const FINANCE_API_KEY = process.env.FINANCE_API_KEY || "";
const NEWS_API_BASE_URL = process.env.NEWS_API_BASE_URL || "";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function ensureDeepSeekBaseUrl(url) {
  const raw = String(url || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://api.deepseek.com/v1";
  if (/\/v1$/i.test(raw)) return raw;
  if (/^https?:\/\/api\.deepseek\.com$/i.test(raw)) return `${raw}/v1`;
  return raw;
}

function joinUrl(base, suffix) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function getModelConfig(modelName, apiKey, apiBaseUrl) {
  const model = String(modelName || "").trim().toLowerCase();
  const inputKey = String(apiKey || "").trim();
  const baseUrl = String(apiBaseUrl || "").trim();

  if (model === "deepseek") {
    const key = inputKey || DEEPSEEK_API_KEY;
    if (!key) throw new Error("API Key is required (input key or DEEPSEEK_API_KEY env)");
    return {
      endpoint: joinUrl(ensureDeepSeekBaseUrl(baseUrl || DEFAULT_API_BASE_URL), "/chat/completions"),
      payloadModel: "deepseek-chat",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      }
    };
  }
  throw new Error(`Unsupported model provider: ${modelName}`);
}

function normalizeGraph(raw, centerEntity) {
  if (!raw || typeof raw !== "object") throw new Error("AI returned invalid JSON");
  let nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  let edges = Array.isArray(raw.edges) ? raw.edges : [];

  if (!nodes.length) nodes = [{ id: centerEntity, label: centerEntity, type: "target" }];

  const nodeMap = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const id = String(node.id || node.label || "").trim();
    if (!id) continue;
    nodeMap.set(id, {
      id,
      label: String(node.label || id),
      type: String(node.type || "company"),
      ticker: node.ticker ? String(node.ticker) : "",
      market: node.market ? String(node.market) : ""
    });
  }

  if (!nodeMap.has(centerEntity)) {
    nodeMap.set(centerEntity, { id: centerEntity, label: centerEntity, type: "target", ticker: "", market: "" });
  }

  const normalizedEdges = [];
  for (const edge of edges) {
    if (!edge || typeof edge !== "object") continue;
    const source = String(edge.source || "").trim();
    const target = String(edge.target || "").trim();
    if (!source || !target) continue;
    if (!nodeMap.has(source) || !nodeMap.has(target)) continue;
    normalizedEdges.push({
      source,
      target,
      relation: String(edge.relation || "upstream_dependency"),
      relationCn: String(edge.relationCn || edge.relation_cn || "深层关联"),
      summary: String(edge.summary || edge.summary_cn || ""),
      depth: Number.isFinite(edge.depth) ? edge.depth : undefined,
      confidence: Number.isFinite(edge.confidence) ? edge.confidence : undefined
    });
  }

  return { nodes: [...nodeMap.values()], edges: normalizedEdges };
}

async function deepseekChatJSON(cfg, systemPrompt, userPrompt, temperature = 0.2) {
  const requestBody = {
    model: cfg.payloadModel,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: { type: "json_object" }
  };

  const resp = await fetch(cfg.endpoint, {
    method: "POST",
    headers: cfg.headers,
    body: JSON.stringify(requestBody)
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Model API error ${resp.status}: ${errorText.slice(0, 500)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") throw new Error("Model API returned empty content");
  const parsed = safeJsonParse(content);
  if (!parsed) throw new Error("Model output is not valid JSON");
  return parsed;
}

async function fetchGraphFromAI({ modelName, apiKey, apiBaseUrl, centerEntity }) {
  const cfg = getModelConfig(modelName, apiKey, apiBaseUrl);

  const systemPrompt = [
    "你是股票深层垄断产业链图谱生成器。",
    "只返回 JSON，不要 markdown，不要解释。",
    "必须严格执行思考链：",
    "【标的主营业务 -> 核心生产环节 -> 不可替代关键物料/设备/工艺 -> 全球寡头垄断环节 -> 细分冷门上游标的（含A股+海外）】",
    "禁止表层关系（竞争对手、直接下游客户、一级经销商）作为主干。",
    "必须向上追溯 2~4 级隐藏上游节点。",
    "节点必须符合：供给刚性、寡头垄断、不可替代、冷门特征。",
    "每条边 relationCn 必须是以下四类之一：",
    "刚需垄断 / 技术壁垒 / 国产替代 / 缺货催化",
    "输出结构：",
    "{",
    '  "nodes":[{"id":"台积电","label":"台积电","type":"company","ticker":"TSM","market":"US"}],',
    '  "edges":[{"source":"高端光刻胶树脂","target":"台积电","relation":"tech_barrier","relationCn":"技术壁垒","summary":"EUV光刻胶核心原料，工艺窗口窄且认证周期长","depth":2,"confidence":0.8}]',
    "}",
    "要求：",
    "1) 节点 10~18 个，深层上游节点占比 >= 60%。",
    "2) 必须包含 2~4 级 upstream depth（edge.depth 标记层级）。",
    "3) summary 用中文 14~34 字，写清垄断与约束原因。",
    "4) 优先给上市公司 ticker（A股用6位代码，海外用交易代码）。"
  ].join("\n");

  const userPrompt = [`目标公司: ${centerEntity}`, "请按规则输出完整深层垄断关系图谱。"].join("\n");

  const raw = await deepseekChatJSON(cfg, systemPrompt, userPrompt, 0.15);
  return normalizeGraph(raw, centerEntity);
}

function weekReturnColor(weeklyReturnPct) {
  if (weeklyReturnPct == null || Number.isNaN(weeklyReturnPct)) return null;
  if (weeklyReturnPct >= 10) return "#FF0000";
  if (weeklyReturnPct >= 5) return "#FF4444";
  if (weeklyReturnPct >= 2) return "#FF8888";
  if (weeklyReturnPct >= 0) return "#FFBBBB";
  if (weeklyReturnPct > -2) return "#88FF88";
  if (weeklyReturnPct > -5) return "#44FF44";
  if (weeklyReturnPct > -10) return "#00CC00";
  return "#00FF00";
}

function formatMoneyCN(amount) {
  if (amount == null || Number.isNaN(amount)) return "-";
  const abs = Math.abs(amount);
  if (abs >= 1e8) return `${(amount / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(amount / 1e4).toFixed(2)}万`;
  return amount.toFixed(0);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status} ${txt.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTicker(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^\d{6}$/.test(raw)) return raw;
  return raw;
}

function guessSecid(ticker) {
  if (!/^\d{6}$/.test(ticker)) return "";
  const first = ticker[0];
  if (first === "6" || first === "9") return `1.${ticker}`;
  return `0.${ticker}`;
}

function startOfWeekMonday(d = new Date()) {
  const dt = new Date(d);
  const day = dt.getDay() || 7;
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - day + 1);
  return dt;
}

function parseDateYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
}

async function fetchEastmoneyWeeklyAndFund(ticker) {
  const secid = guessSecid(ticker);
  if (!secid) return null;
  const klineUrl =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
    "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=102&fqt=1";
  const fundUrl =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${encodeURIComponent(secid)}` +
    "&lmt=30&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65";

  const [klineData, fundData] = await Promise.all([
    fetchJsonWithTimeout(klineUrl, {}, 12000).catch(() => null),
    fetchJsonWithTimeout(fundUrl, {}, 12000).catch(() => null)
  ]);

  const weekly = Array.isArray(klineData?.data?.klines) ? klineData.data.klines : [];
  const fund = Array.isArray(fundData?.data?.klines) ? fundData.data.klines : [];

  let weeklyReturnPct = null;
  let dataWeek = "last_week";
  if (weekly.length >= 2) {
    const last = String(weekly[weekly.length - 1]).split(",");
    const prev = String(weekly[weekly.length - 2]).split(",");
    const lastClose = Number(last[2]);
    const prevClose = Number(prev[2]);
    if (Number.isFinite(lastClose) && Number.isFinite(prevClose) && prevClose !== 0) {
      weeklyReturnPct = ((lastClose - prevClose) / prevClose) * 100;
    }
    const lastDate = parseDateYmd(last[0]);
    if (lastDate && lastDate >= startOfWeekMonday()) dataWeek = "this_week";
  }

  let mainFundNetInflow = null;
  if (fund.length >= 1) {
    const row = String(fund[fund.length - 1]).split(",");
    const v = Number(row[1]);
    if (Number.isFinite(v)) mainFundNetInflow = v;
  }

  return {
    weeklyReturnPct,
    mainFundNetInflow,
    dataWeek,
    color: weekReturnColor(weeklyReturnPct),
    weeklyReturnText:
      weeklyReturnPct == null ? "-" : `${weeklyReturnPct >= 0 ? "+" : ""}${weeklyReturnPct.toFixed(2)}%`,
    mainFundText: formatMoneyCN(mainFundNetInflow)
  };
}

async function fetchWeeklyAndFundData(nodes) {
  const out = {};
  const unique = new Set();
  for (const n of nodes || []) {
    const tk = normalizeTicker(n.ticker);
    if (tk) unique.add(tk);
  }

  for (const ticker of unique) {
    try {
      if (FINANCE_API_BASE_URL) {
        const url = joinUrl(FINANCE_API_BASE_URL, `/enrich?ticker=${encodeURIComponent(ticker)}`);
        const data = await fetchJsonWithTimeout(
          url,
          {
            headers: FINANCE_API_KEY ? { Authorization: `Bearer ${FINANCE_API_KEY}` } : {}
          },
          10000
        );
        const weeklyReturnPct = Number.isFinite(data?.weeklyReturnPct) ? data.weeklyReturnPct : null;
        const mainFundNetInflow = Number.isFinite(data?.mainFundNetInflow) ? data.mainFundNetInflow : null;
        const dataWeek = data?.dataWeek === "last_week" ? "last_week" : "this_week";
        out[ticker] = {
          weeklyReturnPct,
          mainFundNetInflow,
          dataWeek,
          color: weekReturnColor(weeklyReturnPct),
          weeklyReturnText:
            weeklyReturnPct == null ? "-" : `${weeklyReturnPct >= 0 ? "+" : ""}${weeklyReturnPct.toFixed(2)}%`,
          mainFundText: formatMoneyCN(mainFundNetInflow)
        };
      } else {
        out[ticker] = await fetchEastmoneyWeeklyAndFund(ticker);
      }
    } catch {
      out[ticker] = null;
    }
  }
  return out;
}

function fallbackNews(centerEntity) {
  return [
    {
      title: `${centerEntity} 产业链近期观察`,
      url: "",
      source: "系统占位",
      publishedAt: ""
    }
  ];
}

async function fetchNews(centerEntity) {
  if (!NEWS_API_BASE_URL) {
    const query = encodeURIComponent(`${centerEntity} 股票`);
    const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    try {
      const resp = await fetch(rssUrl);
      if (!resp.ok) return fallbackNews(centerEntity);
      const xml = await resp.text();
      const items = [];
      const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
      for (const block of blocks.slice(0, 8)) {
        const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] || block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim();
        const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
        const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
        const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "Google News").trim();
        if (!title) continue;
        items.push({ title, url: link, source, publishedAt: pubDate });
      }
      return items.length ? items : fallbackNews(centerEntity);
    } catch {
      return fallbackNews(centerEntity);
    }
  }
  try {
    const url = joinUrl(NEWS_API_BASE_URL, `/news?q=${encodeURIComponent(centerEntity)}&limit=8`);
    const data = await fetchJsonWithTimeout(
      url,
      { headers: NEWS_API_KEY ? { Authorization: `Bearer ${NEWS_API_KEY}` } : {} },
      12000
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
      .map((it) => ({
        title: String(it.title || "").trim(),
        url: String(it.url || "").trim(),
        source: String(it.source || "").trim(),
        publishedAt: String(it.publishedAt || "").trim()
      }))
      .filter((it) => it.title)
      .slice(0, 8);
  } catch {
    return fallbackNews(centerEntity);
  }
}

async function summarizeNewsWithAI({ modelName, apiKey, apiBaseUrl, centerEntity, newsItems }) {
  if (!Array.isArray(newsItems) || !newsItems.length) {
    return "暂无可用新闻数据，建议稍后刷新。";
  }
  const cfg = getModelConfig(modelName, apiKey, apiBaseUrl);
  const systemPrompt = [
    "你是股票新闻解读助手。",
    "仅输出 JSON：{\"summary\":\"...\"}",
    "要求：",
    "1) 80~160字中文",
    "2) 只做信息归纳，不给投资建议",
    "3) 点出产业链可能影响方向（供给、价格、订单、资本开支）"
  ].join("\n");
  const userPrompt = [
    `标的: ${centerEntity}`,
    "新闻列表:",
    ...newsItems.map((n, i) => `${i + 1}. ${n.title} | ${n.source} | ${n.publishedAt}`)
  ].join("\n");
  const parsed = await deepseekChatJSON(cfg, systemPrompt, userPrompt, 0.2);
  return String(parsed?.summary || "").trim() || "暂无解读。";
}

async function buildEnrichPayload({ modelName, apiKey, apiBaseUrl, centerEntity, nodes }) {
  const [financeMap, newsItems] = await Promise.all([fetchWeeklyAndFundData(nodes), fetchNews(centerEntity)]);
  const commentary = await summarizeNewsWithAI({
    modelName,
    apiKey,
    apiBaseUrl,
    centerEntity,
    newsItems
  }).catch(() => "新闻解读暂不可用。");
  return {
    nodeMetrics: financeMap,
    news: newsItems,
    commentary
  };
}

function serveStatic(pathname, res) {
  const reqPath = pathname === "/" ? "/public/index.html" : pathname;
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(process.cwd(), safePath);
  if (!filePath.startsWith(process.cwd())) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/config") {
    sendJson(res, 200, {
      defaultProvider: DEFAULT_PROVIDER,
      defaultApiBaseUrl: DEFAULT_API_BASE_URL,
      serverKeyConfigured: Boolean(DEEPSEEK_API_KEY),
      financeEnrichConfigured: Boolean(FINANCE_API_BASE_URL),
      newsConfigured: Boolean(NEWS_API_BASE_URL)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/graph") {
    try {
      const body = safeJsonParse(await readBody(req), {}) || {};
      const centerEntity = String(body.centerEntity || "").trim();
      if (!centerEntity) return sendJson(res, 400, { error: "centerEntity is required" });
      const graph = await fetchGraphFromAI({
        modelName: body.modelName,
        apiKey: body.apiKey,
        apiBaseUrl: body.apiBaseUrl,
        centerEntity
      });
      sendJson(res, 200, { graph });
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Unknown error" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/enrich") {
    try {
      const body = safeJsonParse(await readBody(req), {}) || {};
      const centerEntity = String(body.centerEntity || "").trim();
      if (!centerEntity) return sendJson(res, 400, { error: "centerEntity is required" });
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      const enrich = await buildEnrichPayload({
        modelName: body.modelName,
        apiKey: body.apiKey,
        apiBaseUrl: body.apiBaseUrl,
        centerEntity,
        nodes
      });
      sendJson(res, 200, enrich);
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Unknown error" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  serveStatic(pathname, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running: http://localhost:${PORT}`);
});
