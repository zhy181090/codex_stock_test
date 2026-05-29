const CACHE_KEY = "stock_graph_cache_v3";
const CONFIG_KEY = "stock_graph_config";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 30;
const TOUCH_PAN_GAIN = 1.35;
const MOUSE_PAN_GAIN = 1.0;

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
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({
      modelName: ui.modelName.value,
      apiBaseUrl: ui.apiBaseUrl.value.trim(),
      apiKey: ui.apiKey.value.trim()
    })
  );
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
    const valid = raw.filter((x) => x && x.key && x.ts && now - x.ts < CACHE_TTL_MS);
    state.cache = new Map(valid.map((x) => [x.key, x]));
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
    state.nodes.set(id, {
      id,
      label: node.label || id,
      type: node.type || "company",
      ticker: (node.ticker || "").toUpperCase(),
      market: node.market || ""
    });
  }

  const edgeSet = new Set();
  for (const edge of graph.edges || []) {
    const source = toId(edge.source);
    const target = toId(edge.target);
    if (!source || !target || !state.nodes.has(source) || !state.nodes.has(target)) continue;
    const key = `${source}|${target}|${edge.relation || ""}|${edge.summary || ""}|${edge.depth || ""}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    state.edges.push({
      source,
      target,
      relationCn: edge.relationCn || "深层关联",
      summary: edge.summary || "",
      depth: Number.isFinite(edge.depth) ? edge.depth : null
    });
  }
}

function buildLayers(centerId) {
  const incoming = new Map();
  for (const n of state.nodes.keys()) incoming.set(n, []);
  for (const e of state.edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e.source);
  }

  const depthMap = new Map([[centerId, 0]]);
  const q = [centerId];
  while (q.length) {
    const cur = q.shift();
    const d = depthMap.get(cur) || 0;
    const parents = incoming.get(cur) || [];
    for (const p of parents) {
      if (!depthMap.has(p)) {
        depthMap.set(p, d + 1);
        q.push(p);
      }
    }
  }

  for (const id of state.nodes.keys()) {
    if (!depthMap.has(id)) depthMap.set(id, 1);
  }

  const layers = new Map();
  for (const [id, d] of depthMap.entries()) {
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(id);
  }
  return { depthMap, layers };
}

function layeredLayout() {
  const width = 1600;
  const height = 980;
  const centerId = state.currentCenter;
  const { depthMap, layers } = buildLayers(centerId);
  const maxDepth = Math.max(...layers.keys());
  const xStep = maxDepth > 0 ? (width - 220) / maxDepth : width / 2;

  for (const [depth, ids] of layers.entries()) {
    ids.sort((a, b) => {
      const da = state.edges.filter((e) => e.source === a).length;
      const db = state.edges.filter((e) => e.source === b).length;
      if (da !== db) return db - da;
      return a.localeCompare(b);
    });

    const laneCount = ids.length;
    const yGap = laneCount <= 1 ? 0 : (height - 140) / (laneCount - 1);
    ids.forEach((id, idx) => {
      const x = 90 + depth * xStep;
      const y = laneCount <= 1 ? height / 2 : 70 + idx * yGap;
      state.positions.set(id, { x, y });
    });
  }

  if (state.positions.has(centerId)) {
    const p = state.positions.get(centerId);
    state.positions.set(centerId, { x: 90, y: p.y });
  }

  for (const depth of [...layers.keys()]) {
    if (depth === 0 || !layers.has(depth - 1)) continue;
    const ids = layers.get(depth);
    ids.sort((a, b) => {
      const ta = state.edges.find((e) => e.source === a)?.target || "";
      const tb = state.edges.find((e) => e.source === b)?.target || "";
      const ya = state.positions.get(ta)?.y || 0;
      const yb = state.positions.get(tb)?.y || 0;
      return ya - yb;
    });
    const laneCount = ids.length;
    const yGap = laneCount <= 1 ? 0 : (height - 140) / (laneCount - 1);
    ids.forEach((id, idx) => {
      const pos = state.positions.get(id);
      state.positions.set(id, { x: pos.x, y: laneCount <= 1 ? height / 2 : 70 + idx * yGap });
    });
  }
}

function relationLabel(edge) {
  const depthText = edge.depth ? `L${edge.depth}` : "L?";
  const sm = edge.summary ? ` | ${edge.summary}` : "";
  return `${depthText} ${edge.relationCn}${sm}`;
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
  clearGroup(ui.edges);
  clearGroup(ui.edgeLabels);
  clearGroup(ui.nodes);

  state.edges.forEach((e, i) => {
    const sp = state.positions.get(e.source);
    const tp = state.positions.get(e.target);
    if (!sp || !tp) return;

    const mx = (sp.x + tp.x) / 2;
    const my = (sp.y + tp.y) / 2;
    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (12 + (i % 2) * 6);
    const ny = (dx / len) * (12 + (i % 2) * 6);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${sp.x} ${sp.y} Q ${mx + nx} ${my + ny} ${tp.x} ${tp.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("class", "edge");
    ui.edges.appendChild(path);

    const angle = (Math.atan2(tp.y - sp.y, tp.x - sp.x) * 180) / Math.PI;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "edge-label");
    label.setAttribute("x", mx + nx * 0.6);
    label.setAttribute("y", my + ny * 0.6 - 3);
    label.setAttribute("transform", `rotate(${angle}, ${mx + nx * 0.6}, ${my + ny * 0.6 - 3})`);
    label.textContent = relationLabel(e);
    ui.edgeLabels.appendChild(label);
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
    circle.setAttribute("r", node.type === "target" ? "20" : "16");
    circle.setAttribute("fill", nodeBaseColor(node, metric));
    g.appendChild(circle);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.setAttribute("x", "0");
    title.setAttribute("y", "30");
    title.textContent = node.label.length > 16 ? `${node.label.slice(0, 16)}...` : node.label;
    g.appendChild(title);

    if (metric) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", "4");
      dot.setAttribute("cx", "12");
      dot.setAttribute("cy", "-12");
      dot.setAttribute("class", metric.dataWeek === "last_week" ? "data-dot-last" : "data-dot-this");
      g.appendChild(dot);

      const l1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
      l1.setAttribute(
        "class",
        `node-metric ${String(metric.weeklyReturnText || "").startsWith("-") ? "metric-down" : "metric-up"}`
      );
      l1.setAttribute("x", "26");
      l1.setAttribute("y", "-5");
      l1.textContent = `周涨跌: ${metric.weeklyReturnText || "-"}`;
      g.appendChild(l1);

      const l2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
      l2.setAttribute(
        "class",
        `node-metric ${Number(metric.mainFundNetInflow || 0) < 0 ? "metric-outflow" : "metric-inflow"}`
      );
      l2.setAttribute("x", "26");
      l2.setAttribute("y", "10");
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
  const resp = await fetch("/api/graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelName: ui.modelName.value,
      apiBaseUrl: ui.apiBaseUrl.value.trim(),
      apiKey: ui.apiKey.value.trim(),
      centerEntity
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "请求图谱失败");
  return data.graph;
}

async function requestEnrich(centerEntity, nodes) {
  const resp = await fetch("/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelName: ui.modelName.value,
      apiBaseUrl: ui.apiBaseUrl.value.trim(),
      apiKey: ui.apiKey.value.trim(),
      centerEntity,
      nodes
    })
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
    } else {
      const enrichFresh = await requestEnrich(center, payload.graph?.nodes || []).catch(() => null);
      if (enrichFresh) {
        payload.enrich = enrichFresh;
        setCachedPayload(center, payload);
      }
    }

    setGraph(center, payload.graph, payload.enrich?.nodeMetrics || {});
    layeredLayout();
    if (resetView) resetViewport();
    render();
    renderNews(payload.enrich?.news || [], payload.enrich?.commentary || "");
    ui.centerEntity.value = center;
    setStatus(`当前中心：${center}。同一股票跨端布局保持一致。`);
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

function initMousePan() {
  let drag = null;
  ui.svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    drag = { startX: e.clientX, startY: e.clientY, originX: state.viewport.x, originY: state.viewport.y };
    ui.svg.classList.add("dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) * MOUSE_PAN_GAIN;
    const dy = (e.clientY - drag.startY) * MOUSE_PAN_GAIN;
    state.viewport.x = drag.originX + dx;
    state.viewport.y = drag.originY + dy;
    applyViewport();
  });
  window.addEventListener("mouseup", () => {
    drag = null;
    ui.svg.classList.remove("dragging");
  });
}

function initTouchGestures() {
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
    if (!state.pointers.size) {
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
initMousePan();
initTouchGestures();
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
