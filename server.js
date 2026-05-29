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
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function normalizeGraph(raw, centerEntity) {
  if (!raw || typeof raw !== "object") {
    throw new Error("AI returned invalid JSON");
  }

  let nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  let edges = Array.isArray(raw.edges) ? raw.edges : [];

  if (nodes.length === 0) {
    nodes = [{ id: centerEntity, label: centerEntity, type: "target" }];
  }

  const nodeMap = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const id = String(node.id || node.label || "").trim();
    if (!id) continue;
    nodeMap.set(id, {
      id,
      label: String(node.label || id),
      type: String(node.type || "company"),
      ticker: node.ticker ? String(node.ticker) : ""
    });
  }

  if (!nodeMap.has(centerEntity)) {
    nodeMap.set(centerEntity, { id: centerEntity, label: centerEntity, type: "target", ticker: "" });
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
      relation: String(edge.relation || "related"),
      confidence: Number.isFinite(edge.confidence) ? edge.confidence : undefined
    });
  }

  return { nodes: [...nodeMap.values()], edges: normalizedEdges };
}

function ensureDeepSeekBaseUrl(url) {
  const raw = String(url || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://api.deepseek.com/v1";
  if (/\/v1$/i.test(raw)) return raw;
  if (/^https?:\/\/api\.deepseek\.com$/i.test(raw)) return `${raw}/v1`;
  return raw;
}

function getModelConfig(modelName, apiKey, apiBaseUrl) {
  const model = String(modelName || "").trim().toLowerCase();
  const inputKey = String(apiKey || "").trim();
  const baseUrl = String(apiBaseUrl || "").trim();

  const joinUrl = (base, suffix) => `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;

  if (model === "deepseek") {
    const key = inputKey || DEEPSEEK_API_KEY;
    if (!key) {
      throw new Error("API Key is required (input key or DEEPSEEK_API_KEY env)");
    }
    const normalizedBase = ensureDeepSeekBaseUrl(baseUrl || DEFAULT_API_BASE_URL);
    return {
      endpoint: joinUrl(normalizedBase, "/chat/completions"),
      payloadModel: "deepseek-chat",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      }
    };
  }

  throw new Error(`Unsupported model provider: ${modelName}`);
}

async function fetchGraphFromAI({ modelName, apiKey, apiBaseUrl, centerEntity, context }) {
  const cfg = getModelConfig(modelName, apiKey, apiBaseUrl);

  const systemPrompt = [
    "You are a financial knowledge graph generator.",
    "Return strict JSON only, no markdown and no extra text.",
    "Build company relationship graph around the target stock/company.",
    "Allowed relation examples: supplier, customer, competitor, investor, partner, index_member, subsidiary, regulator_impact.",
    "Output format:",
    "{",
    '  "nodes":[{"id":"NVIDIA","label":"NVIDIA","type":"target","ticker":"NVDA"}],',
    '  "edges":[{"source":"TSMC","target":"NVIDIA","relation":"supplier","confidence":0.84}]',
    "}",
    "Rules:",
    "1) Include 6-15 nodes.",
    "2) Node id must be unique and stable text.",
    "3) Edge source and target must reference existing node ids.",
    "4) Use confidence in [0,1] when known; omit if uncertain."
  ].join("\n");

  const userPrompt = [
    `Target: ${centerEntity}`,
    context ? `Existing context: ${context}` : "Existing context: none",
    "Generate only the next-hop meaningful graph around target."
  ].join("\n");

  const requestBody = {
    model: cfg.payloadModel,
    temperature: 0.2,
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
  if (!content || typeof content !== "string") {
    throw new Error("Model API returned empty content");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("Model output is not valid JSON");
  }

  return normalizeGraph(parsed, centerEntity);
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
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      const centerEntity = String(body.centerEntity || "").trim();
      if (!centerEntity) {
        sendJson(res, 400, { error: "centerEntity is required" });
        return;
      }
      const graph = await fetchGraphFromAI({
        modelName: body.modelName,
        apiKey: body.apiKey,
        apiBaseUrl: body.apiBaseUrl,
        centerEntity,
        context: body.context || ""
      });
      sendJson(res, 200, { graph });
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
