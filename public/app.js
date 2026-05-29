const CACHE_KEY = "stock_graph_cache_v1";
const CONFIG_KEY = "stock_graph_config";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 30;

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
  gesture: null
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
  nodes: document.getElementById("nodes")
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
  if (!resp.ok) {
    throw new Error(data.error || "加载服务器配置失败");
  }
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

function getCachedGraph(centerEntity) {
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
  return item.graph;
}

function setCachedGraph(centerEntity, graph) {
  const key = graphCacheKey(centerEntity);
  state.cache.set(key, { key, ts: Date.now(), graph });
  persistCache();
}

function resetViewport() {
  state.viewport = { x: 0, y: 0, scale: 1 };
  applyViewport();
}

function setGraph(centerEntity, graph) {
  state.nodes.clear();
  state.edges = [];
  state.positions.clear();
  state.activeNodeId = centerEntity;
  state.currentCenter = centerEntity;

  for (const node of graph.nodes || []) {
    const id = toId(node.id);
    if (!id) continue;
    state.nodes.set(id, {
      id,
      label: node.label || id,
      type: node.type || "company",
      ticker: node.ticker || ""
    });
    if (!state.positions.has(id)) {
      state.positions.set(id, { x: Math.random() * 1200 + 100, y: Math.random() * 700 + 100 });
    }
  }

  const edgeSet = new Set();
  for (const edge of graph.edges || []) {
    const source = toId(edge.source);
    const target = toId(edge.target);
    if (!source || !target) continue;
    const key = `${source}|${target}|${edge.relation || "related"}|${edge.summary || ""}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    state.edges.push({
      source,
      target,
      relation: edge.relation || "related",
      relationCn: edge.relationCn || "相关",
      summary: edge.summary || "",
      confidence: typeof edge.confidence === "number" ? edge.confidence : null
    });
  }
}

function layout(iterations = 140) {
  const nodes = [...state.nodes.values()];
  if (!nodes.length) return;

  const width = 1400;
  const height = 900;
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

    const temp = Math.max(1, 40 * (1 - step / iterations));
    for (const n of nodes) {
      const p = state.positions.get(n.id);
      const d = disp.get(n.id);
      const dist = Math.hypot(d.x, d.y) || 0.01;
      p.x += (d.x / dist) * Math.min(dist, temp);
      p.y += (d.y / dist) * Math.min(dist, temp);
      p.x = Math.min(width - 50, Math.max(50, p.x));
      p.y = Math.min(height - 50, Math.max(50, p.y));
    }
  }
}

function clearGroup(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function render() {
  clearGroup(ui.edges);
  clearGroup(ui.edgeLabels);
  clearGroup(ui.nodes);

  for (const e of state.edges) {
    const sp = state.positions.get(e.source);
    const tp = state.positions.get(e.target);
    if (!sp || !tp) continue;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", sp.x);
    line.setAttribute("y1", sp.y);
    line.setAttribute("x2", tp.x);
    line.setAttribute("y2", tp.y);
    line.setAttribute("class", "edge");
    ui.edges.appendChild(line);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", (sp.x + tp.x) / 2);
    label.setAttribute("y", (sp.y + tp.y) / 2 - 6);
    label.setAttribute("class", "edge-label");
    const shortSummary = e.summary ? ` | ${e.summary}` : "";
    label.textContent = `${e.relationCn}${shortSummary}`;
    ui.edgeLabels.appendChild(label);
  }

  for (const node of state.nodes.values()) {
    const p = state.positions.get(node.id);
    if (!p) continue;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute(
      "class",
      `node ${node.type === "target" ? "target" : node.type === "index" ? "index" : "company"} ${
        state.activeNodeId === node.id ? "active" : ""
      }`
    );
    g.setAttribute("transform", `translate(${p.x}, ${p.y})`);
    g.dataset.nodeId = node.id;

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", node.type === "target" ? "20" : "16");
    g.appendChild(circle);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("dy", node.type === "target" ? "35" : "30");
    text.textContent = node.label.length > 16 ? `${node.label.slice(0, 16)}...` : node.label;
    g.appendChild(text);

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
    centerEntity,
    context: ""
  };

  const resp = await fetch("/api/graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data.graph;
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
  setStatus(`正在加载 ${center} 关系图谱...`);

  try {
    let graph = null;
    if (useCache && !forceRefresh) {
      graph = getCachedGraph(center);
    }
    if (!graph) {
      graph = await requestGraph(center);
      setCachedGraph(center, graph);
      setStatus(`已获取 ${center} 最新图谱。`);
    } else {
      setStatus(`已使用缓存：${center}。`);
    }

    setGraph(center, graph);
    layout(160);
    if (resetView) resetViewport();
    render();
    ui.centerEntity.value = center;
    setStatus(`当前中心：${center}。点节点可切换到该公司新图谱。`);
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
  render();
  resetViewport();
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
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      zoomAroundPoint(e.clientX, e.clientY, factor);
    },
    { passive: false }
  );
}

function initPointerGestures() {
  ui.svg.addEventListener("pointerdown", (e) => {
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
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      state.gesture = {
        mode: "pinch",
        startDistance: dist,
        startScale: state.viewport.scale,
        centerX: cx,
        centerY: cy,
        originX: state.viewport.x,
        originY: state.viewport.y
      };
      ui.svg.classList.add("dragging");
    }
  });

  ui.svg.addEventListener("pointermove", (e) => {
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!state.gesture) return;

    if (state.gesture.mode === "pan" && state.pointers.size === 1) {
      const dx = e.clientX - state.gesture.startX;
      const dy = e.clientY - state.gesture.startY;
      state.viewport.x = state.gesture.originX + dx;
      state.viewport.y = state.gesture.originY + dy;
      applyViewport();
      return;
    }

    if (state.pointers.size >= 2) {
      const pts = [...state.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const factor = dist / (state.gesture.startDistance || dist);
      const targetScale = clampScale((state.gesture.startScale || 1) * factor);
      const p = svgPointFromClient(cx, cy);
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

  ui.svg.addEventListener("pointerup", (e) => endPointer(e.pointerId));
  ui.svg.addEventListener("pointercancel", (e) => endPointer(e.pointerId));
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
