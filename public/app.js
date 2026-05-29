const state = {
  nodes: new Map(),
  edges: [],
  positions: new Map(),
  activeNodeId: "",
  viewport: { x: 0, y: 0, scale: 1 },
  serverKeyConfigured: false
};

const ui = {
  modelName: document.getElementById("modelName"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  centerEntity: document.getElementById("centerEntity"),
  buildBtn: document.getElementById("buildBtn"),
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
    return JSON.parse(localStorage.getItem("stock_graph_config") || "{}");
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
  localStorage.setItem("stock_graph_config", JSON.stringify(cfg));
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

function mergeGraph(graph) {
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

  const edgeSet = new Set(state.edges.map((e) => `${e.source}|${e.target}|${e.relation}`));
  for (const edge of graph.edges || []) {
    const source = toId(edge.source);
    const target = toId(edge.target);
    if (!source || !target) continue;
    const key = `${source}|${target}|${edge.relation || "related"}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    state.edges.push({
      source,
      target,
      relation: edge.relation || "related",
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
    const suffix = e.confidence != null ? ` ${(e.confidence * 100).toFixed(0)}%` : "";
    label.textContent = `${e.relation}${suffix}`;
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
    circle.setAttribute("r", node.type === "target" ? "20" : "15");
    g.appendChild(circle);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("dy", node.type === "target" ? "35" : "30");
    text.textContent = node.label.length > 16 ? `${node.label.slice(0, 16)}...` : node.label;
    g.appendChild(text);

    g.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      state.activeNodeId = node.id;
      render();
      await expandFromNode(node.id);
    });

    ui.nodes.appendChild(g);
  }
}

async function requestGraph(centerEntity, context = "") {
  saveConfig();
  const payload = {
    modelName: ui.modelName.value,
    apiBaseUrl: ui.apiBaseUrl.value.trim(),
    apiKey: ui.apiKey.value.trim(),
    centerEntity,
    context
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

async function buildInitialGraph() {
  const center = ui.centerEntity.value.trim();
  if (!center) {
    setStatus("请先输入股票名称或代码。", true);
    return;
  }
  if (!ui.apiKey.value.trim() && !state.serverKeyConfigured) {
    setStatus("请先输入 API Key，或在服务器环境变量配置 DEEPSEEK_API_KEY。", true);
    return;
  }

  ui.buildBtn.disabled = true;
  setStatus(`正在生成 ${center} 的关系图谱...`);
  try {
    state.nodes.clear();
    state.edges = [];
    state.positions.clear();
    state.activeNodeId = center;

    const graph = await requestGraph(center);
    mergeGraph(graph);
    layout(180);
    render();
    setStatus(`已生成 ${center} 关系图谱。点击任意节点继续扩展。`);
  } catch (err) {
    setStatus(`生成失败: ${err.message}`, true);
  } finally {
    ui.buildBtn.disabled = false;
  }
}

async function expandFromNode(nodeId) {
  setStatus(`正在扩展 ${nodeId} 相关关系...`);
  try {
    const context = `Current nodes: ${[...state.nodes.keys()].slice(0, 60).join(", ")}`;
    const graph = await requestGraph(nodeId, context);
    mergeGraph(graph);
    layout(100);
    render();
    setStatus(`已扩展 ${nodeId}。可继续点击其他节点。`);
  } catch (err) {
    setStatus(`扩展失败: ${err.message}`, true);
  }
}

function clearCanvas() {
  state.nodes.clear();
  state.edges = [];
  state.positions.clear();
  state.activeNodeId = "";
  render();
  setStatus("已清空画布。");
}

function applyViewport() {
  const { x, y, scale } = state.viewport;
  ui.viewport.setAttribute("transform", `translate(${x}, ${y}) scale(${scale})`);
}

function initPanZoom() {
  let dragging = false;
  let start = { x: 0, y: 0 };
  let origin = { x: 0, y: 0 };

  ui.svg.addEventListener("mousedown", (e) => {
    dragging = true;
    ui.svg.classList.add("dragging");
    start = { x: e.clientX, y: e.clientY };
    origin = { x: state.viewport.x, y: state.viewport.y };
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    ui.svg.classList.remove("dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    state.viewport.x = origin.x + (e.clientX - start.x);
    state.viewport.y = origin.y + (e.clientY - start.y);
    applyViewport();
  });

  ui.svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      state.viewport.scale = Math.max(0.3, Math.min(2.6, state.viewport.scale + delta));
      applyViewport();
    },
    { passive: false }
  );
}

ui.buildBtn.addEventListener("click", buildInitialGraph);
ui.clearBtn.addEventListener("click", clearCanvas);
ui.centerEntity.addEventListener("keydown", (e) => {
  if (e.key === "Enter") buildInitialGraph();
});

initPanZoom();
applyViewport();

loadServerConfig()
  .then((cfg) => {
    loadConfigToForm(cfg);
    setStatus(
      cfg.serverKeyConfigured
        ? "服务器已配置密钥，手机端可直接使用。"
        : "请输入 API Key（浏览器会自动保存）。"
    );
  })
  .catch((err) => {
    setStatus(`初始化失败: ${err.message}`, true);
  });
