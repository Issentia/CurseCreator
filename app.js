const FONTS = ["Impact", "Anton", "Bangers", "Oswald", "Pacifico", "Arial", "Georgia", "Courier New", "Comic Sans MS"];

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const ctx = canvas.getContext("2d");

const ui = {
  file: $("file"),
  cropBtn: $("cropBtn"),
  applyCropBtn: $("applyCropBtn"),
  cancelCropBtn: $("cancelCropBtn"),
  cropHint: $("cropHint"),
  addTextBtn: $("addTextBtn"),
  deleteTextBtn: $("deleteTextBtn"),
  layerList: $("layerList"),
  editor: $("editor"),
  text: $("text"),
  font: $("font"),
  size: $("size"),
  sizeVal: $("sizeVal"),
  color: $("color"),
  bold: $("bold"),
  italic: $("italic"),
  outline: $("outline"),
  outlineColor: $("outlineColor"),
  outlineWidth: $("outlineWidth"),
  outlineWidthVal: $("outlineWidthVal"),
  download: $("downloadBtn"),
};

const state = {
  base: null,        // canvas holding the current (possibly cropped) image
  layers: [],        // text layers, drawn in order (last = on top)
  selectedId: null,
  nextId: 1,
  cropping: false,
  crop: null,        // {x1, y1, x2, y2} in image pixels (may be unordered while dragging)
  drag: null,        // active pointer interaction
};

// ---------- setup ----------

FONTS.forEach((f) => {
  const o = document.createElement("option");
  o.value = f;
  o.textContent = f;
  o.style.fontFamily = `"${f}", sans-serif`;
  ui.font.appendChild(o);
});

// ---------- helpers ----------

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const selected = () => state.layers.find((l) => l.id === state.selectedId) || null;

// Ratio between canvas pixels and on-screen CSS pixels (used to keep handles a constant on-screen size).
function scale() {
  const r = canvas.getBoundingClientRect();
  return r.width ? canvas.width / r.width : 1;
}

function toImg(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * canvas.width) / r.width,
    y: ((e.clientY - r.top) * canvas.height) / r.height,
  };
}

function fontString(l, size) {
  return `${l.italic ? "italic " : ""}${l.bold ? "bold " : ""}${size}px "${l.font}", sans-serif`;
}

// Measures the layer's text; leaves ctx.font set for the layer.
function measure(l) {
  ctx.font = fontString(l, l.size);
  const lines = l.text.split("\n");
  const lh = l.size * 1.2;
  let w = 0;
  for (const t of lines) w = Math.max(w, ctx.measureText(t).width);
  return { lines, lh, w, h: lines.length * lh };
}

function hitTest(l, p) {
  const { w, h } = measure(l);
  const pad = (l.outline ? l.outlineWidth : 0) + 6 * scale();
  return Math.abs(p.x - l.x) <= w / 2 + pad && Math.abs(p.y - l.y) <= h / 2 + pad;
}

// Loads the font used by a layer, then redraws so the canvas picks it up.
function loadFont(l) {
  document.fonts.load(fontString(l, 40)).then(() => render()).catch(() => {});
}

// ---------- drawing ----------

function drawLayer(l) {
  const { lines, lh, h } = measure(l);
  ctx.font = fontString(l, l.size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  const y0 = l.y - h / 2 + lh / 2;

  // Outline first (all lines), then fill, so outlines never cover neighbouring text.
  if (l.outline && l.outlineWidth > 0) {
    ctx.strokeStyle = l.outlineColor;
    ctx.lineWidth = l.outlineWidth * 2; // stroke is centred on the glyph edge, so double it
    lines.forEach((t, i) => ctx.strokeText(t, l.x, y0 + i * lh));
  }

  ctx.fillStyle = l.color;
  lines.forEach((t, i) => ctx.fillText(t, l.x, y0 + i * lh));
}

function drawSelection(l) {
  const { w, h } = measure(l);
  const s = scale();
  const pad = 8 * s + (l.outline ? l.outlineWidth : 0);
  ctx.save();
  ctx.strokeStyle = "#5b6cff";
  ctx.lineWidth = 2 * s;
  ctx.setLineDash([6 * s, 4 * s]);
  ctx.strokeRect(l.x - w / 2 - pad, l.y - h / 2 - pad, w + pad * 2, h + pad * 2);
  ctx.restore();
}

function normCrop() {
  const c = state.crop;
  return {
    x: Math.round(Math.min(c.x1, c.x2)),
    y: Math.round(Math.min(c.y1, c.y2)),
    w: Math.round(Math.abs(c.x2 - c.x1)),
    h: Math.round(Math.abs(c.y2 - c.y1)),
  };
}

const corners = (r) => [
  [r.x, r.y, "nw"],
  [r.x + r.w, r.y, "ne"],
  [r.x, r.y + r.h, "sw"],
  [r.x + r.w, r.y + r.h, "se"],
];

function drawCropOverlay() {
  const r = normCrop();
  const s = scale();

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Redraw the selected region at full brightness.
  ctx.drawImage(state.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(r.x, r.y, r.w, r.h);

  const hs = 10 * s;
  ctx.fillStyle = "#ffffff";
  for (const [hx, hy] of corners(r)) {
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
  }
}

function render(forExport = false) {
  if (!state.base) {
    ctx.fillStyle = "#1c1f28";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#8a93a6";
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Upload an image to get started", canvas.width / 2, canvas.height / 2);
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.base, 0, 0);

  if (state.cropping) {
    drawCropOverlay();
    return;
  }

  state.layers.forEach(drawLayer);

  const l = selected();
  if (l && !forExport) drawSelection(l);
}

// ---------- image loading, base swapping ----------

function setBase(c) {
  state.base = c;
  canvas.width = c.width;
  canvas.height = c.height;
  ui.size.max = Math.max(60, Math.round(c.height / 2));
  render();
}

ui.file.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;

  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);

    setCropping(false);
    state.layers = [];
    state.selectedId = null;
    setBase(c);
    renderLayers();
    syncEditor();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(f);
  ui.file.value = ""; // allow re-selecting the same file later
});

// ---------- cropping ----------

function setCropping(on) {
  if (on && !state.base) return;

  state.cropping = on;
  state.drag = null;

  if (on) {
    const W = state.base.width, H = state.base.height;
    state.crop = { x1: W * 0.1, y1: H * 0.1, x2: W * 0.9, y2: H * 0.9 };
  } else {
    state.crop = null;
  }

  ui.cropBtn.hidden = on;
  ui.applyCropBtn.hidden = !on;
  ui.cancelCropBtn.hidden = !on;
  ui.cropHint.hidden = !on;
  ui.addTextBtn.disabled = on;

  syncEditor();
  render();
}

function applyCrop() {
  const r = normCrop();
  if (r.w < 10 || r.h < 10) {
    alert("The crop area is too small.");
    return;
  }

  const c = document.createElement("canvas");
  c.width = r.w;
  c.height = r.h;
  c.getContext("2d").drawImage(state.base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);

  // Keep text in the same place on the image after cropping.
  state.layers.forEach((l) => {
    l.x -= r.x;
    l.y -= r.y;
  });

  setBase(c);
  setCropping(false);
}

function startCropDrag(p) {
  const r = normCrop();
  const tol = 14 * scale();

  const hit = corners(r).find(([x, y]) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol);

  if (hit) {
    state.drag = { type: "crop", mode: hit[2] };
  } else if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) {
    state.drag = { type: "crop", mode: "move", ox: p.x - r.x, oy: p.y - r.y };
  } else {
    state.crop = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    state.drag = { type: "crop", mode: "new" };
  }
  render();
}

function cropMove(p, d) {
  const W = state.base.width, H = state.base.height;
  const c = state.crop;
  const x = clamp(p.x, 0, W);
  const y = clamp(p.y, 0, H);

  if (d.mode === "new") {
    c.x2 = x;
    c.y2 = y;
    return;
  }

  const r = normCrop();

  if (d.mode === "move") {
    const nx = clamp(p.x - d.ox, 0, W - r.w);
    const ny = clamp(p.y - d.oy, 0, H - r.h);
    Object.assign(c, { x1: nx, y1: ny, x2: nx + r.w, y2: ny + r.h });
    return;
  }

  // Corner resize: move only the edges that this corner touches.
  let left = r.x, right = r.x + r.w, top = r.y, bottom = r.y + r.h;
  if (d.mode.includes("w")) left = x; else right = x;
  if (d.mode.includes("n")) top = y; else bottom = y;
  Object.assign(c, { x1: left, y1: top, x2: right, y2: bottom });
}

// ---------- text layers ----------

function select(id) {
  state.selectedId = id;
  renderLayers();
  syncEditor();
  render();
}

function addLayer() {
  if (!state.base) {
    alert("Upload an image first.");
    return;
  }
  const H = state.base.height;
  const layer = {
    id: state.nextId++,
    text: "YOUR TEXT",
    x: state.base.width / 2,
    y: H / 2,
    font: "Impact",
    size: Math.max(12, Math.round(H / 10)),
    color: "#ffffff",
    bold: true,
    italic: false,
    outline: true,
    outlineColor: "#000000",
    outlineWidth: Math.min(30, Math.max(2, Math.round(H / 150))),
  };
  state.layers.push(layer);
  loadFont(layer);
  select(layer.id);
}

function deleteSelected() {
  const l = selected();
  if (!l) return;
  state.layers = state.layers.filter((x) => x.id !== l.id);
  select(null);
}

function renderLayers() {
  ui.layerList.innerHTML = "";
  state.layers.forEach((l) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = l.text.split("\n")[0].slice(0, 40) || "(empty)";
    if (l.id === state.selectedId) b.classList.add("active");
    b.onclick = () => select(l.id);
    li.appendChild(b);
    ui.layerList.appendChild(li);
  });
}

// Fills the editor with the selected layer's values, or disables it if nothing is selected.
function syncEditor() {
  const l = selected();
  const off = !l || state.cropping;
  ui.editor.disabled = off;
  ui.deleteTextBtn.disabled = off;

  if (!l) return;

  ui.text.value = l.text;
  ui.font.value = l.font;
  ui.size.value = l.size;
  ui.sizeVal.textContent = l.size;
  ui.color.value = l.color;
  ui.bold.checked = l.bold;
  ui.italic.checked = l.italic;
  ui.outline.checked = l.outline;
  ui.outlineColor.value = l.outlineColor;
  ui.outlineWidth.value = l.outlineWidth;
  ui.outlineWidthVal.textContent = l.outlineWidth;
}

// Applies one property change to the selected layer.
function update(prop, value) {
  const l = selected();
  if (!l) return;
  l[prop] = value;
  if (prop === "font" || prop === "bold" || prop === "italic") loadFont(l);
  render();
}

// ---------- editor bindings ----------

ui.text.addEventListener("input", () => {
  update("text", ui.text.value);
  renderLayers();
});

ui.font.addEventListener("change", () => update("font", ui.font.value));

ui.size.addEventListener("input", () => {
  const v = Number(ui.size.value);
  ui.sizeVal.textContent = v;
  update("size", v);
});

ui.color.addEventListener("input", () => update("color", ui.color.value));
ui.bold.addEventListener("change", () => update("bold", ui.bold.checked));
ui.italic.addEventListener("change", () => update("italic", ui.italic.checked));
ui.outline.addEventListener("change", () => update("outline", ui.outline.checked));
ui.outlineColor.addEventListener("input", () => update("outlineColor", ui.outlineColor.value));

ui.outlineWidth.addEventListener("input", () => {
  const v = Number(ui.outlineWidth.value);
  ui.outlineWidthVal.textContent = v;
  update("outlineWidth", v);
});

ui.addTextBtn.addEventListener("click", addLayer);
ui.deleteTextBtn.addEventListener("click", deleteSelected);
ui.cropBtn.addEventListener("click", () => setCropping(true));
ui.applyCropBtn.addEventListener("click", applyCrop);
ui.cancelCropBtn.addEventListener("click", () => setCropping(false));

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if ((e.key === "Delete" || e.key === "Backspace") && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
    deleteSelected();
  }
});

// ---------- canvas pointer interaction ----------

canvas.addEventListener("pointerdown", (e) => {
  if (!state.base) return;
  canvas.setPointerCapture(e.pointerId);
  const p = toImg(e);

  if (state.cropping) {
    startCropDrag(p);
    return;
  }

  // Topmost layer wins.
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (hitTest(l, p)) {
      state.drag = { type: "text", dx: p.x - l.x, dy: p.y - l.y };
      select(l.id);
      return;
    }
  }
  select(null);
});

canvas.addEventListener("pointermove", (e) => {
  const d = state.drag;
  if (!d || !state.base) return;
  const p = toImg(e);

  if (d.type === "text") {
    const l = selected();
    if (l) {
      l.x = p.x - d.dx;
      l.y = p.y - d.dy;
    }
  } else {
    cropMove(p, d);
  }
  render();
});

const endDrag = () => {
  state.drag = null;
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------- export ----------

ui.download.addEventListener("click", () => {
  if (!state.base) {
    alert("Upload an image first.");
    return;
  }
  if (state.cropping) {
    alert("Apply or cancel the crop first.");
    return;
  }

  render(true); // draw without the selection box
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cursecreator.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    render();
  }, "image/png");
});

// ---------- init ----------

renderLayers();
syncEditor();
render();
document.fonts.ready.then(() => render());
