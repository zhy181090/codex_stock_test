const CACHE_KEY = "stock_graph_cache_v2";
const CONFIG_KEY = "stock_graph_config";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 30;
const TOUCH_PAN_GAIN = 1.35;

const state = {
  nodes: new Map(),
  edges: [],
  positions: new Map(),
  activeNodeId: "",
  currentCenter: "",
  history: [],
  viewport: { x: 0, y: 0, scale: 1 },
  serverKeyConfigured: false,
  cache: new Map(),
  pointers: new Map(),
  gesture: null,
  nodeMetrics: {}
};

const ui = {
  modelName: document.getElementById("modelName"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  centerEntity: document.getElementById("centerEntity"),
  buildBtn: document.getElementById("buildBtn"),
  backBtn: document.getElementById("backBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  svg: document.getElementById("graphSvg"),
  defs: document.getElementById("lineDefs"),
  viewport: document.getElementById("viewport"),
  edges: document.getElementById("edges"),
  edgeLabels: document.getElementById("edgeLabels"),
  nodes: document.getElementById("nodes"),
  newsList: document.getElementById("newsList"),
  newsTag: document.getElementById("newsTag"),
  newsCommentary: document.getElementById("newsCommentary")
};

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
}

function toId(value) {
  return String(value || "").trim();
}

function getSavedConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveConfig() {
  const cfg = {
    modelName: ui.modelName.value,
    apiBaseUrl: ui.apiBaseUrl.value.trim(),
    apiKey: ui.apiKey.value.trim()
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function loadConfigToForm(serverCfg) {
  const saved = getSavedConfig();
  ui.modelName.value = saved.modelName || serverCfg.defaultProvider || "deepseek";
  ui.apiBaseUrl.value = saved.apiBaseUrl || serverCfg.defaultApiBaseUrl || "https://api.deepseek.com/v1";
  ui.apiKey.value = saved.apiKey || "";
  state.serverKeyConfigured = Boolean(serverCfg.serverKeyConfigured);
}

async function loadServerConfig() {
  const resp = await fetch("/api/config");
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "加载服务器配置失败");
  return data;
}

function cacheConfigKey() {
  return `${ui.modelName.value}|${ui.apiBaseUrl.value.trim()}`;
}

function graphCacheKey(centerEntity) {
  return `${cacheConfigKey()}|${toId(centerEntity).toLowerCase()}`;
}

function loadCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    const now = Date.now();
    const valid = raw.filter((item) => item && item.key && item.ts && now - item.ts < CACHE_TTL_MS);
    state.cache = new Map(valid.map((item) => [item.key, item]));
    persistCache();
  } catch {
    state.cache = new Map();
  }
}

function persistCache() {
  const arr = [...state.cache.values()].sort((a, b) => b.ts - a.ts).slice(0, CACHE_MAX_ENTRIES);
  localStorage.setItem(CACHE_KEY, JSON.stringify(arr));
}

function getCachedPayload(centerEntity) {
  const key = graphCacheKey(centerEntity);
  const item = state.cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts >= CACHE_TTL_MS) {
    state.cache.delete(key);
    persistCache();
    return null;
  }
  item.ts = Date.now();
  state.cache.set(key, item);
  persistCache();
  return item.payload;
}

function setCachedPayload(centerEntity, payload) {
  const key = graphCacheKey(centerEntity);
  state.cache.set(key, { key, ts: Date.now(), payload });
  persistCache();
}

function clearGroup(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function resetViewport() {
  state.viewport = { x: 0, y: 0, scale: 1 };
  applyViewport();
}

function nodeBaseColor(node, metric) {
  if (metric && metric.color) return metric.color;
  if (node.type === "target") return "#ffb347";
  return "#3ea3ff";
}

function setGraph(centerEntity, graph, metrics) {
  state.nodes.clear();
  state.edges = [];
  state.positions.clear();
  state.activeNodeId = centerEntity;
  state.currentCenter = centerEntity;
  state.nodeMetrics = metrics || {};

  for (const node of graph.nodes || []) {
    const id = toId(node.id);
    if (!id) continue;
    const normalized = {
      id,
      label: node.label || id,
      type: node.type || "company",
      ticker: node.ticker || "",
      market: node.market || ""
    };
    state.nodes.set(id, normalized);
    if (!state.positions.has(id)) {
      state.positions.set(id, { x: Math.random() * 1320 + 120, y: Math.random() * 760 + 100 });
    }
  }

  const edgeSet = new Set();
  for (const edge of graph.edges || []) {
    const source = toId(edge.source);
    const target = toId(edge.target);
    if (!source || !target) continue;
    const key = `${source}|${target}|${edge.relation || "related"}|${edge.summary || ""}|${edge.depth || ""}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    state.edges.push({
      source,
      target,
      relation: edge.relation || "upstream_dependency",
      relationCn: edge.relationCn || "深层关联",
      summary: edge.summary || "",
      depth: Number.isFinite(edge.depth) ? edge.depth : null,
      confidence: typeof edge.confidence === "number" ? edge.confidence : null
    });
  }
}

function layout(iterations = 160) {
  const nodes = [...state.nodes.values()];
  if (!nodes.length) return;

  const width = 1600;
  const height = 980;
  const area = width * height;
  const k = Math.sqrt(area / nodes.length);

  for (let step = 0; step < iterations; step += 1) {
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const pa = state.positions.get(a.id);
        const pb = state.positions.get(b.id);
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const force = (k * k) / dist;
        dx /= dist;
        dy /= dist;
        disp.get(a.id).x += dx * force;
        disp.get(a.id).y += dy * force;
        disp.get(b.id).x -= dx * force;
        disp.get(b.id).y -= dy * force;
      }
    }

    for (const edge of state.edges) {
      const pa = state.positions.get(edge.source);
      const pb = state.positions.get(edge.target);
      if (!pa || !pb) continue;
      let dx = pa.x - pb.x;
      let dy = pa.y - pb.y;
      let dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      dx /= dist;
      dy /= dist;
      disp.get(edge.source).x -= dx * force;
      disp.get(edge.source).y -= dy * force;
      disp.get(edge.target).x += dx * force;
      disp.get(edge.target).y += dy * force;
    }

    const temp = Math.max(1, 50 * (1 - step / iterations));
    for (const n of nodes) {
      const p = state.positions.get(n.id);
      const d = disp.get(n.id);
      const dist = Math.hypot(d.x, d.y) || 0.01;
      p.x += (d.x / dist) * Math.min(dist, temp);
      p.y += (d.y / dist) * Math.min(dist, temp);
      p.x = Math.min(width - 60, Math.max(60, p.x));
      p.y = Math.min(height - 60, Math.max(60, p.y));
    }
  }
}

function edgePathId(index) {
  return `edge-path-${index}`;
}

function relationLabel(edge) {
  const depthText = edge.depth ? `L${edge.depth}` : "L?";
  const summary = edge.summary ? ` | ${edge.summary}` : "";
  return `${depthText} ${edge.relationCn}${summary}`;
}

function renderNews(news, commentary) {
  ui.newsCommentary.textContent = commentary || "暂无解读";
  while (ui.newsList.firstChild) ui.newsList.removeChild(ui.newsList.firstChild);
  for (const item of news || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = item.title || "未命名新闻";
    a.href = item.url || "#";
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    li.appendChild(a);
    const meta = document.createElement("div");
    meta.className = "news-meta";
    meta.textContent = `${item.source || "未知来源"} ${item.publishedAt ? `| ${item.publishedAt}` : ""}`;
    li.appendChild(meta);
    ui.newsList.appendChild(li);
  }
  ui.newsTag.textContent = `共 ${news?.length || 0} 条`;
}

function render() {
  clearGroup(ui.defs);
  clearGroup(ui.edges);
  clearGroup(ui.edgeLabels);
  clearGroup(ui.nodes);

  state.edges.forEach((e, i) => {
    const sp = state.positions.get(e.source);
    const tp = state.positions.get(e.target);
    if (!sp || !tp) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const pathId = edgePathId(i);
    const curveSign = i % 2 === 0 ? 1 : -1;
    const mx = (sp.x + tp.x) / 2;
    const my = (sp.y + tp.y) / 2;
    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (16 + (i % 3) * 8) * curveSign;
    const ny = (dx / len) * (16 + (i % 3) * 8) * curveSign;
    const d = `M ${sp.x} ${sp.y} Q ${mx + nx} ${my + ny} ${tp.x} ${tp.y}`;

    path.setAttribute("id", pathId);
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("class", "edge");
    ui.edges.appendChild(path);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "edge-label");
    const textPath = document.createElementNS("http://www.w3.org/2000/svg", "textPath");
    textPath.setAttributeNS("http://www.w3.org/1999/xlink", "href", `#${pathId}`);
    textPath.setAttribute("startOffset", `${40 + (i % 4) * 8}%`);
    textPath.textContent = relationLabel(e);
    text.appendChild(textPath);
    ui.edgeLabels.appendChild(text);
  });

  for (const node of state.nodes.values()) {
    const p = state.positions.get(node.id);
    if (!p) continue;
    const metric = state.nodeMetrics[node.ticker] || null;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute(
      "class",
      `node ${node.type === "target" ? "target" : "company"} ${state.activeNodeId === node.id ? "active" : ""}`
    );
    g.setAttribute("transform", `translate(${p.x}, ${p.y})`);
    g.dataset.nodeId = node.id;

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", node.type === "target" ? "21" : "17");
    circle.setAttribute("fill", nodeBaseColor(node, metric));
    g.appendChild(circle);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("dy", node.type === "target" ? "36" : "31");
    text.textContent = node.label.length > 16 ? `${node.label.slice(0, 16)}...` : node.label;
    g.appendChild(text);

    if (metric) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", "4");
      dot.setAttribute("cx", "14");
      dot.setAttribute("cy", "-14");
      dot.setAttribute("class", metric.dataWeek === "last_week" ? "data-dot-last" : "data-dot-this");
      g.appendChild(dot);

      const l1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
      l1.setAttribute("class", `node-metric ${String(metric.weeklyReturnText || "").startsWith("-") ? "metric-down" : "metric-up"}`);
      l1.setAttribute("x", "24");
      l1.setAttribute("y", "-2");
      l1.textContent = `周涨跌: ${metric.weeklyReturnText || "-"}`;
      g.appendChild(l1);

      const fundNegative = Number(metric.mainFundNetInflow || 0) < 0;
      const l2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
      l2.setAttribute("class", `node-metric ${fundNegative ? "metric-outflow" : "metric-inflow"}`);
      l2.setAttribute("x", "24");
      l2.setAttribute("y", "11");
      l2.textContent = `主力净流入: ${metric.mainFundText || "-"}`;
      g.appendChild(l2);
    }

    g.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      const nextCenter = node.label || node.id;
      if (nextCenter === state.currentCenter) return;
      if (state.currentCenter) state.history.push(state.currentCenter);
      await showCenterGraph(nextCenter, { useCache: true, resetView: true, forceRefresh: false });
    });
    ui.nodes.appendChild(g);
  }
  ui.backBtn.disabled = state.history.length === 0;
}

async function requestGraph(centerEntity) {
  saveConfig();
  const payload = {
    modelName: ui.modelName.value,
    apiBaseUrl: ui.apiBaseUrl.value.trim(),
    apiKey: ui.apiKey.value.trim(),
    centerEntity
  };
  const resp = await fetch("/api/graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "请求图谱失败");
  return data.graph;
}

async function requestEnrich(centerEntity, nodes) {
  const payload = {
    modelName: ui.modelName.value,
    apiBaseUrl: ui.apiBaseUrl.value.trim(),
    apiKey: ui.apiKey.value.trim(),
    centerEntity,
    nodes
  };
  const resp = await fetch("/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "请求增强数据失败");
  return data;
}

async function showCenterGraph(centerEntity, options = {}) {
  const center = toId(centerEntity);
  if (!center) {
    setStatus("请先输入股票名称或代码。", true);
    return;
  }

  const useCache = options.useCache !== false;
  const forceRefresh = options.forceRefresh === true;
  const resetView = options.resetView === true;

  ui.buildBtn.disabled = true;
  ui.refreshBtn.disabled = true;
  setStatus(`正在加载 ${center} 深层关系图谱...`);

  try {
    let payload = null;
    if (useCache && !forceRefresh) payload = getCachedPayload(center);

    if (!payload) {
      const graph = await requestGraph(center);
      const enrich = await requestEnrich(center, graph.nodes || []);
      payload = { graph, enrich };
      setCachedPayload(center, payload);
      setStatus(`已获取 ${center} 最新深层图谱。`);
    } else {
      setStatus(`已使用缓存：${center}。`);
    }

    setGraph(center, payload.graph, payload.enrich?.nodeMetrics || {});
    layout(170);
    if (resetView) resetViewport();
    render();
    renderNews(payload.enrich?.news || [], payload.enrich?.commentary || "");
    ui.centerEntity.value = center;
    setStatus(`当前中心：${center}。点击节点将重建该公司深层图谱。`);
  } catch (err) {
    setStatus(`加载失败: ${err.message}`, true);
  } finally {
    ui.buildBtn.disabled = false;
    ui.refreshBtn.disabled = false;
  }
}

async function buildInitialGraph() {
  const center = ui.centerEntity.value.trim();
  if (!ui.apiKey.value.trim() && !state.serverKeyConfigured) {
    setStatus("请先输入 API Key，或在服务端配置 DEEPSEEK_API_KEY。", true);
    return;
  }
  state.history = [];
  await showCenterGraph(center, { useCache: true, resetView: true, forceRefresh: false });
}

async function refreshCurrentGraph() {
  if (!state.currentCenter) {
    setStatus("当前没有可刷新的图谱。", true);
    return;
  }
  await showCenterGraph(state.currentCenter, { useCache: false, resetView: false, forceRefresh: true });
}

async function goBack() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  await showCenterGraph(prev, { useCache: true, resetView: true, forceRefresh: false });
}

function clearCanvas() {
  state.nodes.clear();
  state.edges = [];
  state.positions.clear();
  state.activeNodeId = "";
  state.currentCenter = "";
  state.history = [];
  state.nodeMetrics = {};
  render();
  resetViewport();
  ui.newsCommentary.textContent = "暂无解读";
  ui.newsTag.textContent = "未加载";
  while (ui.newsList.firstChild) ui.newsList.removeChild(ui.newsList.firstChild);
  setStatus("已清空画布。");
}

function applyViewport() {
  const { x, y, scale } = state.viewport;
  ui.viewport.setAttribute("transform", `translate(${x}, ${y}) scale(${scale})`);
}

function svgPointFromClient(clientX, clientY) {
  const rect = ui.svg.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function clampScale(scale) {
  return Math.max(0.3, Math.min(3.2, scale));
}

function zoomAroundPoint(clientX, clientY, factor) {
  const oldScale = state.viewport.scale;
  const newScale = clampScale(oldScale * factor);
  if (newScale === oldScale) return;
  const p = svgPointFromClient(clientX, clientY);
  const worldX = (p.x - state.viewport.x) / oldScale;
  const worldY = (p.y - state.viewport.y) / oldScale;
  state.viewport.scale = newScale;
  state.viewport.x = p.x - worldX * newScale;
  state.viewport.y = p.y - worldY * newScale;
  applyViewport();
}

function initWheelZoom() {
  ui.svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAroundPoint(e.clientX, e.clientY, e.deltaY > 0 ? 0.92 : 1.08);
    },
    { passive: false }
  );
}

function initPointerGestures() {
  ui.svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    ui.svg.setPointerCapture(e.pointerId);
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.pointers.size === 1) {
      state.gesture = {
        mode: "pan",
        startX: e.clientX,
        startY: e.clientY,
        originX: state.viewport.x,
        originY: state.viewport.y
      };
      ui.svg.classList.add("dragging");
    } else if (state.pointers.size === 2) {
      const pts = [...state.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      state.gesture = {
        mode: "pinch",
        startDistance: dist,
        startScale: state.viewport.scale,
        originX: state.viewport.x,
        originY: state.viewport.y
      };
      ui.svg.classList.add("dragging");
    }
  });

  ui.svg.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") return;
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!state.gesture) return;

    if (state.gesture.mode === "pan" && state.pointers.size === 1) {
      const dx = (e.clientX - state.gesture.startX) * TOUCH_PAN_GAIN;
      const dy = (e.clientY - state.gesture.startY) * TOUCH_PAN_GAIN;
      state.viewport.x = state.gesture.originX + dx;
      state.viewport.y = state.gesture.originY + dy;
      applyViewport();
      return;
    }

    if (state.pointers.size >= 2) {
      const pts = [...state.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const centerX = (pts[0].x + pts[1].x) / 2;
      const centerY = (pts[0].y + pts[1].y) / 2;
      const factor = dist / (state.gesture.startDistance || dist);
      const targetScale = clampScale((state.gesture.startScale || 1) * factor);
      const p = svgPointFromClient(centerX, centerY);
      const worldX = (p.x - state.gesture.originX) / (state.gesture.startScale || 1);
      const worldY = (p.y - state.gesture.originY) / (state.gesture.startScale || 1);
      state.viewport.scale = targetScale;
      state.viewport.x = p.x - worldX * targetScale;
      state.viewport.y = p.y - worldY * targetScale;
      applyViewport();
    }
  });

  function endPointer(pointerId) {
    state.pointers.delete(pointerId);
    if (state.pointers.size === 0) {
      state.gesture = null;
      ui.svg.classList.remove("dragging");
      return;
    }
    if (state.pointers.size === 1) {
      const [pt] = state.pointers.values();
      state.gesture = {
        mode: "pan",
        startX: pt.x,
        startY: pt.y,
        originX: state.viewport.x,
        originY: state.viewport.y
      };
    }
  }

  ui.svg.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    endPointer(e.pointerId);
  });
  ui.svg.addEventListener("pointercancel", (e) => {
    if (e.pointerType !== "touch") return;
    endPointer(e.pointerId);
  });
}

ui.buildBtn.addEventListener("click", buildInitialGraph);
ui.backBtn.addEventListener("click", goBack);
ui.refreshBtn.addEventListener("click", refreshCurrentGraph);
ui.clearBtn.addEventListener("click", clearCanvas);
ui.centerEntity.addEventListener("keydown", (e) => {
  if (e.key === "Enter") buildInitialGraph();
});

initWheelZoom();
initPointerGestures();
applyViewport();
loadCache();

loadServerConfig()
  .then((cfg) => {
    loadConfigToForm(cfg);
    setStatus(cfg.serverKeyConfigured ? "服务端密钥已配置，可直接使用。" : "请输入 API Key（将本地缓存）。");
  })
  .catch((err) => {
    setStatus(`初始化失败: ${err.message}`, true);
  });
