const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || "deepseek";
const DEFAULT_API_BASE_URL = process.env.DEFAULT_API_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

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

async function fetchGraphFromAI({ modelName, apiKey, apiBaseUrl, centerEntity }) {
  const cfg = getModelConfig(modelName, apiKey, apiBaseUrl);

  const systemPrompt = [
    "你是股票深层垄断产业链图谱生成器。",
    "只返回 JSON，不要 markdown，不要解释。",
    "严格执行链路：",
    "【标的主营业务 -> 核心生产环节 -> 不可替代关键物料/设备/工艺 -> 全球寡头垄断环节 -> 细分冷门上游标的】",
    "禁止仅给竞争对手/一级客户等表层关系。",
    "必须向上追溯 2~4 级。",
    "边 relationCn 只允许：刚需垄断 / 技术壁垒 / 国产替代 / 缺货催化。",
    "输出结构：",
    "{",
    '  "nodes":[{"id":"英伟达","label":"英伟达","type":"target","ticker":"NVDA","market":"US"}],',
    '  "edges":[{"source":"高端光刻胶树脂","target":"台积电","relation":"tech_barrier","relationCn":"技术壁垒","summary":"EUV窗口窄且验证周期长","depth":3,"confidence":0.81}]',
    "}",
    "要求：",
    "1) 节点 10~16 个。",
    "2) 深层上游节点占比 >= 60%。",
    "3) summary 12~28字中文。"
  ].join("\n");
  const userPrompt = [`目标公司: ${centerEntity}`, "按规则输出。"].join("\n");
  const raw = await deepseekChatJSON(cfg, systemPrompt, userPrompt, 0.15);
  return normalizeGraph(raw, centerEntity);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status} ${txt.slice(0, 160)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function weekReturnColor(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v >= 10) return "#FF0000";
  if (v >= 5) return "#FF4444";
  if (v >= 2) return "#FF8888";
  if (v >= 0) return "#FFBBBB";
  if (v > -2) return "#88FF88";
  if (v > -5) return "#44FF44";
  if (v > -10) return "#00CC00";
  return "#00FF00";
}

function formatMoneyCN(amount) {
  if (amount == null || Number.isNaN(amount)) return "-";
  const abs = Math.abs(amount);
  if (abs >= 1e8) return `${(amount / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(amount / 1e4).toFixed(2)}万`;
  return amount.toFixed(0);
}

function normalizeTicker(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^\d{6}$/.test(raw)) return raw;
  return raw.replace(/\s+/g, "");
}

function guessSecid(ticker) {
  if (!/^\d{6}$/.test(ticker)) return "";
  const f = ticker[0];
  if (f === "6" || f === "9") return `1.${ticker}`;
  return `0.${ticker}`;
}

function parseDateYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
}

function mondayOfWeek(d = new Date()) {
  const dt = new Date(d);
  const day = dt.getDay() || 7;
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - day + 1);
  return dt;
}

function enrichObject(weeklyReturnPct, mainFundNetInflow, dataWeek) {
  return {
    weeklyReturnPct: Number.isFinite(weeklyReturnPct) ? weeklyReturnPct : null,
    mainFundNetInflow: Number.isFinite(mainFundNetInflow) ? mainFundNetInflow : null,
    dataWeek: dataWeek === "this_week" ? "this_week" : "last_week",
    color: weekReturnColor(weeklyReturnPct),
    weeklyReturnText:
      Number.isFinite(weeklyReturnPct) ? `${weeklyReturnPct >= 0 ? "+" : ""}${weeklyReturnPct.toFixed(2)}%` : "-",
    mainFundText: formatMoneyCN(mainFundNetInflow)
  };
}

async function fetchAshareEastmoney(ticker) {
  const secid = guessSecid(ticker);
  if (!secid) return null;
  const wkUrl =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
    "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=102&fqt=1";
  const fundUrl =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${encodeURIComponent(secid)}` +
    "&lmt=30&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65";

  const [wkData, fundData] = await Promise.all([
    fetchJsonWithTimeout(wkUrl, {}, 10000).catch(() => null),
    fetchJsonWithTimeout(fundUrl, {}, 10000).catch(() => null)
  ]);
  const weekly = Array.isArray(wkData?.data?.klines) ? wkData.data.klines : [];
  const fund = Array.isArray(fundData?.data?.klines) ? fundData.data.klines : [];
  if (weekly.length < 2) return null;

  const last = String(weekly[weekly.length - 1]).split(",");
  const prev = String(weekly[weekly.length - 2]).split(",");
  const lastClose = Number(last[2]);
  const prevClose = Number(prev[2]);
  let weeklyReturnPct = null;
  if (Number.isFinite(lastClose) && Number.isFinite(prevClose) && prevClose !== 0) {
    weeklyReturnPct = ((lastClose - prevClose) / prevClose) * 100;
  }

  const lastDate = parseDateYmd(last[0]);
  const dataWeek = lastDate && lastDate >= mondayOfWeek() ? "this_week" : "last_week";
  let mainFundNetInflow = null;
  if (fund.length) {
    const row = String(fund[fund.length - 1]).split(",");
    const maybe = Number(row[1]);
    if (Number.isFinite(maybe)) mainFundNetInflow = maybe;
  }
  return enrichObject(weeklyReturnPct, mainFundNetInflow, dataWeek);
}

async function fetchYahooWeekly(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol || /^\d{6}$/.test(symbol)) return null;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    "?interval=1wk&range=3mo&includePrePost=false&events=div%2Csplits";
  const data = await fetchJsonWithTimeout(url, {}, 10000).catch(() => null);
  const quote = data?.chart?.result?.[0]?.indicators?.quote?.[0];
  const closes = Array.isArray(quote?.close) ? quote.close.filter((x) => Number.isFinite(x)) : [];
  const timestamps = Array.isArray(data?.chart?.result?.[0]?.timestamp) ? data.chart.result[0].timestamp : [];
  if (closes.length < 2) return null;
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const weeklyReturnPct = ((lastClose - prevClose) / prevClose) * 100;
  const ts = timestamps[timestamps.length - 1];
  const d = ts ? new Date(ts * 1000) : null;
  const dataWeek = d && d >= mondayOfWeek() ? "this_week" : "last_week";
  return enrichObject(weeklyReturnPct, null, dataWeek);
}

async function fetchTickerEnrich(ticker) {
  const tk = normalizeTicker(ticker);
  if (!tk) return null;
  if (/^\d{6}$/.test(tk)) {
    return (await fetchAshareEastmoney(tk)) || null;
  }
  const us = await fetchYahooWeekly(tk);
  if (us) return us;
  return null;
}

async function fetchWeeklyAndFundData(nodes) {
  const out = {};
  const tickers = [...new Set((nodes || []).map((n) => normalizeTicker(n.ticker)).filter(Boolean))];
  for (const tk of tickers) {
    try {
      out[tk] = await fetchTickerEnrich(tk);
    } catch {
      out[tk] = null;
    }
  }
  return out;
}

function fallbackNews(centerEntity) {
  return [{ title: `${centerEntity} 近期产业链观察`, url: "", source: "系统占位", publishedAt: "" }];
}

async function fetchNews(centerEntity) {
  const q = encodeURIComponent(`${centerEntity} 股票`);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  try {
    const resp = await fetch(rssUrl);
    if (!resp.ok) return fallbackNews(centerEntity);
    const xml = await resp.text();
    const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
    const items = [];
    for (const block of blocks.slice(0, 8)) {
      const title =
        (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ||
          block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ||
          "")
          .trim()
          .replace(/\s+/g, " ");
      if (!title) continue;
      const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "Google News").trim();
      items.push({ title, url: link, source, publishedAt: pubDate });
    }
    return items.length ? items : fallbackNews(centerEntity);
  } catch {
    return fallbackNews(centerEntity);
  }
}

async function summarizeNewsWithAI({ modelName, apiKey, apiBaseUrl, centerEntity, newsItems }) {
  if (!newsItems?.length) return "暂无可用新闻。";
  const cfg = getModelConfig(modelName, apiKey, apiBaseUrl);
  const systemPrompt = [
    "你是股票新闻解读助手。",
    "仅输出 JSON：{\"summary\":\"...\"}",
    "要求：80~160字，中文，只做信息归纳，不给投资建议。"
  ].join("\n");
  const userPrompt = [
    `标的: ${centerEntity}`,
    "新闻:",
    ...newsItems.map((n, i) => `${i + 1}. ${n.title} | ${n.source} | ${n.publishedAt}`)
  ].join("\n");
  const parsed = await deepseekChatJSON(cfg, systemPrompt, userPrompt, 0.2);
  return String(parsed?.summary || "").trim() || "暂无解读。";
}

async function buildEnrichPayload({ modelName, apiKey, apiBaseUrl, centerEntity, nodes }) {
  const [nodeMetrics, news] = await Promise.all([fetchWeeklyAndFundData(nodes), fetchNews(centerEntity)]);
  const commentary = await summarizeNewsWithAI({
    modelName,
    apiKey,
    apiBaseUrl,
    centerEntity,
    newsItems: news
  }).catch(() => "新闻解读暂不可用。");
  return { nodeMetrics, news, commentary };
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
      serverKeyConfigured: Boolean(DEEPSEEK_API_KEY)
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
      const payload = await buildEnrichPayload({
        modelName: body.modelName,
        apiKey: body.apiKey,
        apiBaseUrl: body.apiBaseUrl,
        centerEntity,
        nodes
      });
      sendJson(res, 200, payload);
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
