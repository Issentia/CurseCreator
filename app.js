// =====================================================================
// cursecreator
// Layers: text and image. Canvas = document; images are resizable layers.
// Layer positions (x, y) are the CENTRE of the layer, in canvas pixels.
// =====================================================================

const BASE_FONTS = [
  // Meme / display
  "Impact", "Anton", "Bebas Neue", "Bangers", "Oswald", "Russo One", "Righteous",
  // Handwritten / script
  "Permanent Marker", "Lobster", "Pacifico", "Dancing Script", "Caveat", "Shadows Into Light",
  // Clean sans-serif
  "Roboto", "Montserrat", "Open Sans", "Lato",
  // System fonts (available on most computers)
  "Arial", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Times New Roman",
  "Courier New", "Comic Sans MS",
];

const STORAGE_KEY = "cursecreator-project-v1";

const TEXT_DEFAULTS = {
  type: "text",
  text: "YOUR TEXT",
  font: "Impact",
  size: 72,
  color: "#ffffff",
  color2: "#ffd23f",
  gradient: false,
  bold: true,
  italic: false,
  align: "center",
  letterSpacing: 0,
  lineHeight: 1.2,
  curve: 0,
  outline: true,
  outlineColor: "#000000",
  outlineWidth: 4,
  shadow: false,
  shadowColor: "#000000",
  shadowBlur: 8,
  shadowX: 4,
  shadowY: 4,
  glow: false,
  glowColor: "#00e5ff",
  glowBlur: 20,
};

const IMAGE_DEFAULTS = {
  type: "image",
  brightness: 100,
  contrast: 100,
  saturation: 100,
  grayscale: 0,
  blur: 0,
  flipH: false,
  flipV: false,
};

// ---------- DOM ----------

const ui = {};
document.querySelectorAll("[id]").forEach((el) => (ui[el.id] = el));

const canvas = ui.stage;
const ctx = canvas.getContext("2d");
// Offscreen context used only for measuring text.
const mctx = document.createElement("canvas").getContext("2d");

// ---------- state ----------

const state = {
  doc: { w: 800, h: 450 },
  layers: [],        // bottom -> top
  selectedId: null,
  nextId: 1,
  customFonts: [],   // { name, data } where data is a data URL
  cropping: false,
  crop: null,        // { x1, y1, x2, y2 } in canvas pixels, possibly unordered while dragging
  drag: null,        // active pointer interaction
};

const history = { past: [], future: [], key: null, t: 0 };

// ---------- small helpers ----------

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const rad = (deg) => (deg * Math.PI) / 180;
const selected = () => state.layers.find((l) => l.id === state.selectedId) || null;

// Canvas pixels per on-screen CSS pixel, so handles stay the same size on screen.
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

// Converts a canvas point into a layer's local (unrotated, centred) frame.
function toLocal(l, p) {
  const dx = p.x - l.x;
  const dy = p.y - l.y;
  const a = -rad(l.rotation);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

function fontString(l, size = l.size) {
  return `${l.italic ? "italic " : ""}${l.bold ? "bold " : ""}${size}px "${l.font}", sans-serif`;
}

// ---------- text measuring and layout ----------

function lineWidth(t, sp) {
  if (!t) return 0;
  if (!sp) return mctx.measureText(t).width;
  const chars = [...t];
  return chars.reduce((acc, c) => acc + mctx.measureText(c).width, 0) + sp * (chars.length - 1);
}

function textLayout(l) {
  mctx.font = fontString(l, l.size);
  const lines = l.text.split("\n");
  const lh = l.size * l.lineHeight;
  const widths = lines.map((t) => lineWidth(t, l.letterSpacing));
  const w = Math.max(0, ...widths);
  const h = lines.length * lh;
  return { lines, lh, widths, w, h };
}

// How far a curved text bulges beyond its straight box (used for hit testing and selection).
function curveBulge(l, w) {
  const k = Math.abs(l.curve) / 100;
  if (!k || !w) return 0;
  const theta = k * Math.PI;
  const R = w / theta;
  return R * (1 - Math.cos(theta / 2));
}

// Returns one glyph per character (or per line when there is no spacing/curve).
// Each glyph: { t, x, y, rot, align } in the layer's local frame.
function buildGlyphs(l, L) {
  const glyphs = [];
  const sp = l.letterSpacing || 0;
  const k = Math.abs(l.curve) / 100;
  const sgn = l.curve < 0 ? -1 : 1;

  L.lines.forEach((t, i) => {
    const yc = -L.h / 2 + L.lh / 2 + i * L.lh;
    const lw = L.widths[i];

    if (k > 0) {
      const theta = k * Math.PI;
      const R = Math.max(lw, 1) / theta;
      let cursor = 0;
      for (const c of [...t]) {
        const cw = mctx.measureText(c).width;
        const s = cursor + cw / 2 - lw / 2;
        const phi = s / R;
        glyphs.push({
          t: c,
          x: R * Math.sin(phi),
          y: yc + sgn * R * (1 - Math.cos(phi)),
          rot: sgn * phi,
          align: "center",
        });
        cursor += cw + sp;
      }
      return;
    }

    const startX = l.align === "left" ? -L.w / 2 : l.align === "right" ? L.w / 2 - lw : -lw / 2;

    if (sp) {
      let cx = startX;
      for (const c of [...t]) {
        glyphs.push({ t: c, x: cx, y: yc, rot: 0, align: "left" });
        cx += mctx.measureText(c).width + sp;
      }
    } else {
      glyphs.push({ t, x: startX, y: yc, rot: 0, align: "left" });
    }
  });

  return glyphs;
}

// ---------- drawing ----------

function filterString(l) {
  if (l.brightness === 100 && l.contrast === 100 && l.saturation === 100 && l.grayscale === 0 && l.blur === 0) {
    return "none";
  }
  return `brightness(${l.brightness}%) contrast(${l.contrast}%) saturate(${l.saturation}%) grayscale(${l.grayscale}%) blur(${l.blur}px)`;
}

function drawImageLayer(g, l) {
  if (!l.img) return;
  g.save();
  g.translate(l.x, l.y);
  g.rotate(rad(l.rotation));
  g.scale(l.flipH ? -1 : 1, l.flipV ? -1 : 1);
  g.filter = filterString(l); // ignored by browsers without ctx.filter support
  g.drawImage(l.img, -l.w / 2, -l.h / 2, l.w, l.h);
  g.restore();
}

// Fill colour for a glyph; gradient is defined relative to the layer's box.
function fillStyleFor(g, l, glyphY, h) {
  if (!l.gradient) return l.color;
  const grad = g.createLinearGradient(0, -h / 2 - glyphY, 0, h / 2 - glyphY);
  grad.addColorStop(0, l.color);
  grad.addColorStop(1, l.color2);
  return grad;
}

// Paints all glyphs: outline first (so it never covers neighbouring letters), then fill.
// `shadow` is null or { color, blur, x, y }.
function paintGlyphs(g, l, glyphs, h, shadow) {
  const setShadow = (on) => {
    if (on && shadow) {
      g.shadowColor = shadow.color;
      g.shadowBlur = shadow.blur;
      g.shadowOffsetX = shadow.x;
      g.shadowOffsetY = shadow.y;
    } else {
      g.shadowColor = "rgba(0,0,0,0)";
      g.shadowBlur = 0;
      g.shadowOffsetX = 0;
      g.shadowOffsetY = 0;
    }
  };

  g.font = fontString(l, l.size);
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.miterLimit = 2;

  if (l.outline && l.outlineWidth > 0) {
    setShadow(true);
    g.strokeStyle = l.outlineColor;
    g.lineWidth = l.outlineWidth * 2; // stroke is centred on the glyph edge, so double it
    for (const gl of glyphs) {
      g.save();
      g.translate(gl.x, gl.y);
      g.rotate(gl.rot);
      g.textAlign = gl.align;
      g.strokeText(gl.t, 0, 0);
      g.restore();
    }
  }

  // Drop shadow goes on the fill only when there is no outline (the outline already casts it).
  setShadow(!l.outline);
  for (const gl of glyphs) {
    g.save();
    g.translate(gl.x, gl.y);
    g.rotate(gl.rot);
    g.textAlign = gl.align;
    g.fillStyle = fillStyleFor(g, l, gl.y, h);
    g.fillText(gl.t, 0, 0);
    g.restore();
  }

  setShadow(false);
}

function drawTextLayer(g, l) {
  const L = textLayout(l);
  const glyphs = buildGlyphs(l, L);

  g.save();
  g.translate(l.x, l.y);
  g.rotate(rad(l.rotation));

  if (l.glow) {
    paintGlyphs(g, l, glyphs, L.h, { color: l.glowColor, blur: l.glowBlur, x: 0, y: 0 });
  }
  if (l.shadow) {
    paintGlyphs(g, l, glyphs, L.h, { color: l.shadowColor, blur: l.shadowBlur, x: l.shadowX, y: l.shadowY });
  }
  paintGlyphs(g, l, glyphs, L.h, null);

  g.restore();
}

function renderComposition(g) {
  for (const l of state.layers) {
    if (l.type === "image") drawImageLayer(g, l);
    else drawTextLayer(g, l);
  }
}

// ---------- hit testing and selection visuals ----------

function layerSize(l) {
  if (l.type === "image") return { w: l.w, h: l.h };
  const L = textLayout(l);
  const bulge = curveBulge(l, L.w);
  return { w: L.w, h: L.h + 2 * bulge };
}

function hitLayer(l, p) {
  const s = scale();
  const { w, h } = layerSize(l);
  const q = toLocal(l, p);
  const pad = 6 * s + (l.type === "text" && l.outline ? l.outlineWidth : 0);
  return (
    Math.abs(q.x) <= Math.max(w, 20 * s) / 2 + pad &&
    Math.abs(q.y) <= Math.max(h, 20 * s) / 2 + pad
  );
}

// Corner handle hit test for the selected image layer.
function handleHit(l, p) {
  const tol = 12 * scale();
  const q = toLocal(l, p);
  const hw = l.w / 2;
  const hh = l.h / 2;
  return [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].some(
    ([x, y]) => Math.abs(q.x - x) < tol && Math.abs(q.y - y) < tol
  );
}

function drawSelection(g, l) {
  const s = scale();
  const { w, h } = layerSize(l);
  const pad = 6 * s;

  g.save();
  g.translate(l.x, l.y);
  g.rotate(rad(l.rotation));

  g.strokeStyle = "#5b6cff";
  g.lineWidth = 2 * s;
  g.setLineDash([6 * s, 4 * s]);
  g.strokeRect(-w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2);
  g.setLineDash([]);

  if (l.type === "image") {
    const hs = 10 * s;
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#5b6cff";
    g.lineWidth = 1.5 * s;
    for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) {
      g.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      g.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
    }
  }

  g.restore();
}

// ---------- rendering ----------

// The canvas is shown at its real pixel size. Only its height is limited to the space
// available in the window; if the image is shorter than that, it stays at full size.
// Width is never scaled, so wide images simply take up more horizontal room.
function fitCanvas() {
  const wrap = canvas.closest(".stage-wrap");
  const hint = canvas.parentElement.querySelector(".hint");
  const cs = getComputedStyle(wrap);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const narrow = window.innerWidth <= 900;

  const availH = narrow
    ? window.innerHeight * 0.7
    : wrap.clientHeight - padY - (hint ? hint.offsetHeight : 0) - 12;

  const s = Math.max(0.05, Math.min(availH / state.doc.h, 1));
  canvas.style.width = `${Math.floor(state.doc.w * s)}px`;
  canvas.style.height = `${Math.floor(state.doc.h * s)}px`;
}

function render() {
  if (canvas.width !== state.doc.w || canvas.height !== state.doc.h) {
    canvas.width = state.doc.w;
    canvas.height = state.doc.h;
  }
  fitCanvas();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.cropping) {
    renderComposition(ctx);
    const r = normCrop();
    const s = scale();

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Show the area inside the crop box at full brightness.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    renderComposition(ctx);
    ctx.restore();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * s;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    const hs = 10 * s;
    ctx.fillStyle = "#ffffff";
    for (const [x, y] of corners(r)) ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
    return;
  }

  renderComposition(ctx);

  if (!state.layers.length) {
    ctx.fillStyle = "#8a93a6";
    ctx.font = "22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Add an image or some text to start", canvas.width / 2, canvas.height / 2);
  }

  const sel = selected();
  if (sel) drawSelection(ctx, sel);
}

// ---------- cropping (canvas-level) ----------

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

function setCropping(on) {
  state.cropping = on;
  state.drag = null;
  state.crop = on
    ? { x1: state.doc.w * 0.1, y1: state.doc.h * 0.1, x2: state.doc.w * 0.9, y2: state.doc.h * 0.9 }
    : null;

  ui.cropBtn.hidden = on;
  ui.cropActions.hidden = !on;
  ui.cropHint.hidden = !on;
  ui.addTextBtn.disabled = on;
  document.body.classList.toggle("cropping", on);

  render();
}

function applyCrop() {
  const r = normCrop();
  if (r.w < 10 || r.h < 10) {
    alert("The crop area is too small.");
    return;
  }

  checkpoint(null);
  state.layers.forEach((l) => {
    l.x -= r.x;
    l.y -= r.y;
  });
  state.doc = { w: r.w, h: r.h };

  setCropping(false);
  refreshAll();
  scheduleSave();
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
  const W = state.doc.w;
  const H = state.doc.h;
  const c = state.crop;
  const x = clamp(p.x, 0, W);
  const y = clamp(p.y, 0, H);

  if (d.mode === "new") {
    c.x2 = x;
    c.y2 = y;
  } else if (d.mode === "move") {
    const r = normCrop();
    const nx = clamp(p.x - d.ox, 0, W - r.w);
    const ny = clamp(p.y - d.oy, 0, H - r.h);
    Object.assign(c, { x1: nx, y1: ny, x2: nx + r.w, y2: ny + r.h });
  } else {
    const r = normCrop();
    let left = r.x, right = r.x + r.w, top = r.y, bottom = r.y + r.h;
    if (d.mode.includes("w")) left = x; else right = x;
    if (d.mode.includes("n")) top = y; else bottom = y;
    Object.assign(c, { x1: left, y1: top, x2: right, y2: bottom });
  }
  render();
}

// ---------- history (undo / redo) ----------

function snapshot() {
  return {
    doc: { ...state.doc },
    layers: state.layers.map((l) => ({ ...l })),
    selectedId: state.selectedId,
  };
}

function pushPast(snap) {
  history.past.push(snap);
  if (history.past.length > 100) history.past.shift();
  history.future = [];
  updateUndoButtons();
}

// Call BEFORE changing state. Consecutive changes with the same key (e.g. typing
// or dragging a slider) are merged into one undo step.
function checkpoint(key) {
  const now = Date.now();
  if (key && key === history.key && now - history.t < 800) {
    history.t = now;
    return;
  }
  pushPast(snapshot());
  history.key = key;
  history.t = now;
}

function restore(snap) {
  state.doc = { ...snap.doc };
  state.layers = snap.layers.map((l) => ({ ...l }));
  state.selectedId = state.layers.some((l) => l.id === snap.selectedId) ? snap.selectedId : null;
  history.key = null;
  refreshAll();
  scheduleSave();
}

function undo() {
  if (!history.past.length) return;
  history.future.push(snapshot());
  restore(history.past.pop());
}

function redo() {
  if (!history.future.length) return;
  history.past.push(snapshot());
  restore(history.future.pop());
}

function updateUndoButtons() {
  ui.undoBtn.disabled = !history.past.length;
  ui.redoBtn.disabled = !history.future.length;
}

// ---------- layer operations ----------

function select(id) {
  state.selectedId = id;
  renderLayers();
  syncEditor();
  render();
}

function labelFor(l, index) {
  if (l.type === "text") {
    const first = l.text.split("\n")[0].slice(0, 32);
    return `Text: ${first || "(empty)"}`;
  }
  return `Image ${index + 1}`;
}

function renderLayers() {
  ui.layerList.innerHTML = "";
  if (!state.layers.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No layers yet";
    ui.layerList.appendChild(li);
    updateLayerButtons();
    return;
  }

  // Top layer first in the list.
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = labelFor(l, i);
    if (l.id === state.selectedId) b.classList.add("active");
    b.onclick = () => select(l.id);
    li.appendChild(b);
    ui.layerList.appendChild(li);
  }
  updateLayerButtons();
}

function updateLayerButtons() {
  const l = selected();
  const i = l ? state.layers.indexOf(l) : -1;
  ui.layerUp.disabled = !l || i >= state.layers.length - 1;
  ui.layerDown.disabled = !l || i <= 0;
  ui.layerDup.disabled = !l;
  ui.layerCenter.disabled = !l;
  ui.layerDel.disabled = !l;
}

function addTextLayer() {
  checkpoint(null);
  const H = state.doc.h;
  const layer = {
    ...TEXT_DEFAULTS,
    id: state.nextId++,
    x: state.doc.w / 2,
    y: state.doc.h / 2,
    rotation: 0,
    size: Math.max(12, Math.round(H / 10)),
    outlineWidth: Math.min(30, Math.max(2, Math.round(H / 150))),
  };
  state.layers.push(layer);
  loadFont(layer);
  select(layer.id);
  scheduleSave();
}

function addImageFile(file) {
  if (!file.type.startsWith("image/")) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      checkpoint(null);

      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const isFirstImage = !state.layers.some((l) => l.type === "image");

      let w, h;
      if (isFirstImage) {
        // The first image sets the canvas size, so it fills the canvas exactly.
        state.doc = { w: nw, h: nh };
        w = nw;
        h = nh;
      } else {
        // Later images start at up to 80% of the canvas, keeping their aspect ratio.
        const k = Math.min(1, (state.doc.w * 0.8) / nw, (state.doc.h * 0.8) / nh);
        w = nw * k;
        h = nh * k;
      }

      const layer = {
        ...IMAGE_DEFAULTS,
        id: state.nextId++,
        x: state.doc.w / 2,
        y: state.doc.h / 2,
        rotation: 0,
        src: reader.result,
        img,
        nw,
        nh,
        w,
        h,
      };
      state.layers.push(layer);
      select(layer.id);
      refreshAll();
      scheduleSave();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function deleteSelected() {
  const l = selected();
  if (!l) return;
  checkpoint(null);
  state.layers = state.layers.filter((x) => x.id !== l.id);
  select(null);
  scheduleSave();
}

function duplicateSelected() {
  const l = selected();
  if (!l) return;
  checkpoint(null);
  const copy = { ...l, id: state.nextId++, x: l.x + 20, y: l.y + 20 };
  state.layers.push(copy);
  select(copy.id);
  scheduleSave();
}

function moveSelected(delta) {
  const l = selected();
  if (!l) return;
  const i = state.layers.indexOf(l);
  const j = i + delta;
  if (j < 0 || j >= state.layers.length) return;
  checkpoint(null);
  state.layers.splice(i, 1);
  state.layers.splice(j, 0, l);
  renderLayers();
  render();
  scheduleSave();
}

function centerSelected() {
  const l = selected();
  if (!l) return;
  checkpoint(null);
  l.x = state.doc.w / 2;
  l.y = state.doc.h / 2;
  render();
  scheduleSave();
}

// Applies one or more property changes to the selected layer.
// `key` decides whether consecutive changes merge into one undo step.
function setProps(changes, key = null) {
  const l = selected();
  if (!l) return;
  checkpoint(key);
  Object.assign(l, changes);
  if ("font" in changes || "bold" in changes || "italic" in changes) loadFont(l);
  if ("text" in changes) renderLayers();
  render();
  scheduleSave();
}

function setProp(prop, value) {
  const l = selected();
  if (!l) return;
  setProps({ [prop]: value }, `${l.id}:${prop}`);
}

// ---------- fonts ----------

// Loads a font used by a layer, then redraws so the canvas can use it.
function loadFont(l) {
  document.fonts.load(fontString(l, 40)).then(() => render()).catch(() => {});
}

function refreshFontOptions() {
  const names = [
    ...BASE_FONTS,
    ...state.customFonts.map((f) => f.name).filter((n) => !BASE_FONTS.includes(n)),
  ];
  ui.tFont.innerHTML = "";
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    o.style.fontFamily = `"${n}", sans-serif`;
    ui.tFont.appendChild(o);
  }
}

function registerFont(f) {
  const face = new FontFace(f.name, `url(${f.data})`);
  return face
    .load()
    .then(() => {
      document.fonts.add(face);
      render();
    })
    .catch(() => {});
}

function handleFontFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[^\w\- ]/g, "").trim() || "CustomFont";
    try {
      const face = new FontFace(name, `url(${reader.result})`);
      await face.load();
      document.fonts.add(face);
    } catch (e) {
      alert("That font file could not be loaded.");
      return;
    }
    if (!state.customFonts.some((f) => f.name === name)) {
      state.customFonts.push({ name, data: reader.result });
    }
    refreshFontOptions();
    const l = selected();
    if (l && l.type === "text") setProp("font", name);
    syncEditor();
    scheduleSave();
  };
  reader.readAsDataURL(file);
}

// ---------- editor UI ----------

function setRange(id, value, digits = 0) {
  ui[id].value = value;
  ui[id + "Val"].textContent = digits ? Number(value).toFixed(digits) : value;
}

function syncEditor() {
  const l = selected();
  ui.textEditor.hidden = !l || l.type !== "text";
  ui.imageEditor.hidden = !l || l.type !== "image";
  updateLayerButtons();
  if (!l) return;

  if (l.type === "text") {
    ui.tText.value = l.text;
    ui.tFont.value = l.font;
    setRange("tSize", l.size);
    setRange("tSpacing", l.letterSpacing);
    setRange("tLineHeight", l.lineHeight, 2);
    setRange("tCurve", l.curve);
    setRange("tRotation", l.rotation);
    setRange("tOutlineWidth", l.outlineWidth);
    setRange("tShadowBlur", l.shadowBlur);
    setRange("tShadowX", l.shadowX);
    setRange("tShadowY", l.shadowY);
    setRange("tGlowBlur", l.glowBlur);
    ui.tColor.value = l.color;
    ui.tColor2.value = l.color2;
    ui.tGradient.checked = l.gradient;
    ui.tBold.checked = l.bold;
    ui.tItalic.checked = l.italic;
    ui.tAlign.value = l.align;
    ui.tOutline.checked = l.outline;
    ui.tOutlineColor.value = l.outlineColor;
    ui.tShadow.checked = l.shadow;
    ui.tShadowColor.value = l.shadowColor;
    ui.tGlow.checked = l.glow;
    ui.tGlowColor.value = l.glowColor;
  } else {
    updateImageSizeLabel(l);
    setRange("iRotation", l.rotation);
    setRange("iBright", l.brightness);
    setRange("iContrast", l.contrast);
    setRange("iSat", l.saturation);
    setRange("iGray", l.grayscale);
    setRange("iBlur", l.blur);
  }
}

function updateImageSizeLabel(l) {
  ui.iSize.textContent = `${Math.round(l.w)} × ${Math.round(l.h)} px (drag corners to resize)`;
}

function refreshAll() {
  ui.tSize.max = Math.max(60, Math.round(state.doc.h / 2));
  renderLayers();
  syncEditor();
  updateUndoButtons();
  render();
}

function setStatus(text) {
  ui.status.textContent = text;
}

// ---------- autosave (localStorage) ----------

let saveTimer = null;

function scheduleSave() {
  setStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 600);
}

function saveProject() {
  const data = {
    version: 1,
    doc: state.doc,
    nextId: state.nextId,
    customFonts: state.customFonts,
    // The image element itself is not saved; `src` (a data URL) is enough to rebuild it.
    layers: state.layers.map(({ img, ...rest }) => rest),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    setStatus("Saved in this browser");
  } catch (e) {
    setStatus("Could not save: browser storage is full (try smaller images)");
  }
}

function loadProject() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch (e) {
    data = null;
  }
  if (!data || !Array.isArray(data.layers)) return false;

  state.doc = data.doc || state.doc;
  state.nextId = data.nextId || 1;
  state.customFonts = data.customFonts || [];
  state.layers = data.layers.map((raw) => {
    if (raw.type === "image") {
      const img = new Image();
      img.onload = () => render();
      img.src = raw.src;
      return { ...IMAGE_DEFAULTS, ...raw, img };
    }
    return { ...TEXT_DEFAULTS, ...raw };
  });
  return true;
}

function newProject() {
  if (!confirm("Start a new project? The current layers will be removed (you can undo this).")) return;
  checkpoint(null);
  state.layers = [];
  state.doc = { w: 800, h: 450 };
  state.selectedId = null;
  refreshAll();
  scheduleSave();
}

// ---------- export ----------

function exportImage() {
  if (state.cropping) {
    alert("Apply or cancel the crop first.");
    return;
  }

  const fmt = ui.exFormat.value;
  const quality = Number(ui.exQuality.value) / 100;
  const sc = Number(ui.exScale.value);

  const out = document.createElement("canvas");
  out.width = Math.round(state.doc.w * sc);
  out.height = Math.round(state.doc.h * sc);
  const g = out.getContext("2d");

  if (fmt === "jpg") {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
  }
  g.scale(sc, sc);
  renderComposition(g);

  const mime = fmt === "jpg" ? "image/jpeg" : "image/png";
  out.toBlob(
    (blob) => {
      if (!blob) {
        alert("Export failed.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cursecreator.${fmt}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    mime,
    quality
  );
}

// ---------- pointer interaction on the canvas ----------

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = toImg(e);

  if (state.cropping) {
    startCropDrag(p);
    return;
  }

  const sel = selected();
  if (sel && sel.type === "image" && handleHit(sel, p)) {
    state.drag = { type: "resize", id: sel.id, before: snapshot(), moved: false };
    return;
  }

  // Topmost layer wins.
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (hitLayer(l, p)) {
      state.drag = {
        type: "move",
        id: l.id,
        dx: p.x - l.x,
        dy: p.y - l.y,
        before: snapshot(),
        moved: false,
      };
      select(l.id);
      return;
    }
  }

  select(null);
});

canvas.addEventListener("pointermove", (e) => {
  const d = state.drag;
  if (!d) return;
  const p = toImg(e);

  if (d.type === "crop") {
    cropMove(p, d);
    return;
  }

  const l = state.layers.find((x) => x.id === d.id);
  if (!l) return;

  if (d.type === "move") {
    l.x = p.x - d.dx;
    l.y = p.y - d.dy;
  } else if (d.type === "resize") {
    const q = toLocal(l, p);
    const newW = Math.max(12, Math.abs(q.x) * 2);
    l.w = newW;
    l.h = (newW * l.nh) / l.nw; // keep aspect ratio
    updateImageSizeLabel(l);
  }

  d.moved = true;
  render();
});

const endDrag = () => {
  const d = state.drag;
  state.drag = null;
  if (d && d.before && d.moved) {
    pushPast(d.before);
    history.key = null;
    scheduleSave();
  }
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------- keyboard ----------

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : "";
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && key === "z" && !typing) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && key === "y" && !typing) {
    e.preventDefault();
    redo();
    return;
  }

  if (typing || state.cropping) return;

  if (e.key === "Delete" || e.key === "Backspace") {
    if (selected()) {
      e.preventDefault();
      deleteSelected();
    }
    return;
  }

  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const l = selected();
  if (arrows[e.key] && l) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const [dx, dy] = arrows[e.key];
    checkpoint(`nudge:${l.id}`);
    l.x += dx * step;
    l.y += dy * step;
    render();
    scheduleSave();
  }
});

// ---------- wiring the controls ----------

function bindRange(id, prop, digits = 0) {
  ui[id].addEventListener("input", () => {
    const v = Number(ui[id].value);
    ui[id + "Val"].textContent = digits ? v.toFixed(digits) : v;
    setProp(prop, v);
  });
}

function bindCheck(id, prop) {
  ui[id].addEventListener("change", () => setProp(prop, ui[id].checked));
}

function bindValue(id, prop, evt = "input") {
  ui[id].addEventListener(evt, () => setProp(prop, ui[id].value));
}

// Project
ui.undoBtn.addEventListener("click", undo);
ui.redoBtn.addEventListener("click", redo);
ui.newProjectBtn.addEventListener("click", newProject);
ui.addTextBtn.addEventListener("click", addTextLayer);
ui.imageInput.addEventListener("change", (e) => {
  Array.from(e.target.files).forEach(addImageFile);
  ui.imageInput.value = "";
});

// Crop
ui.cropBtn.addEventListener("click", () => setCropping(true));
ui.cropApply.addEventListener("click", applyCrop);
ui.cropCancel.addEventListener("click", () => setCropping(false));

// Layers
ui.layerUp.addEventListener("click", () => moveSelected(1));
ui.layerDown.addEventListener("click", () => moveSelected(-1));
ui.layerDup.addEventListener("click", duplicateSelected);
ui.layerCenter.addEventListener("click", centerSelected);
ui.layerDel.addEventListener("click", deleteSelected);

// Text
bindValue("tText", "text");
bindValue("tFont", "font", "change");
bindRange("tSize", "size");
bindRange("tSpacing", "letterSpacing");
bindRange("tLineHeight", "lineHeight", 2);
bindRange("tCurve", "curve");
bindRange("tRotation", "rotation");
bindValue("tAlign", "align", "change");
bindCheck("tBold", "bold");
bindCheck("tItalic", "italic");
bindValue("tColor", "color");
bindCheck("tGradient", "gradient");
bindValue("tColor2", "color2");
bindCheck("tOutline", "outline");
bindValue("tOutlineColor", "outlineColor");
bindRange("tOutlineWidth", "outlineWidth");
bindCheck("tShadow", "shadow");
bindValue("tShadowColor", "shadowColor");
bindRange("tShadowBlur", "shadowBlur");
bindRange("tShadowX", "shadowX");
bindRange("tShadowY", "shadowY");
bindCheck("tGlow", "glow");
bindValue("tGlowColor", "glowColor");
bindRange("tGlowBlur", "glowBlur");
ui.tFontUpload.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) handleFontFile(f);
  ui.tFontUpload.value = "";
});

// Image
bindRange("iRotation", "rotation");
bindRange("iBright", "brightness");
bindRange("iContrast", "contrast");
bindRange("iSat", "saturation");
bindRange("iGray", "grayscale");
bindRange("iBlur", "blur");
ui.iRotLeft.addEventListener("click", () => {
  const l = selected();
  if (l) setProps({ rotation: ((l.rotation - 90) % 360 + 360) % 360 });
  syncEditor();
});
ui.iRotRight.addEventListener("click", () => {
  const l = selected();
  if (l) setProps({ rotation: ((l.rotation + 90) % 360 + 360) % 360 });
  syncEditor();
});
ui.iFlipH.addEventListener("click", () => {
  const l = selected();
  if (l) setProps({ flipH: !l.flipH });
});
ui.iFlipV.addEventListener("click", () => {
  const l = selected();
  if (l) setProps({ flipV: !l.flipV });
});
ui.iResetFilters.addEventListener("click", () => {
  setProps({ brightness: 100, contrast: 100, saturation: 100, grayscale: 0, blur: 0 });
  syncEditor();
});

// Export
ui.exQuality.addEventListener("input", () => {
  ui.exQualityVal.textContent = ui.exQuality.value;
});
ui.exDownload.addEventListener("click", exportImage);

// ---------- start ----------

window.addEventListener("resize", () => fitCanvas());

// ---------- settings panel width (drag the divider) ----------

const PANEL_KEY = "cursecreator-panel-width";
const PANEL_MIN = 260;
const PANEL_MAX_ABS = 720;

function setPanelWidth(w) {
  const max = Math.min(PANEL_MAX_ABS, window.innerWidth - 300);
  const width = Math.round(clamp(w, PANEL_MIN, Math.max(PANEL_MIN, max)));
  document.documentElement.style.setProperty("--panel-w", `${width}px`);
  return width;
}

try {
  const saved = Number(localStorage.getItem(PANEL_KEY));
  if (saved) setPanelWidth(saved);
} catch (e) {
  // localStorage unavailable; keep the default width.
}

let panelWidthNow = null;

ui.resizer.addEventListener("pointerdown", (e) => {
  ui.resizer.setPointerCapture(e.pointerId);
  ui.resizer.classList.add("active");
});

ui.resizer.addEventListener("pointermove", (e) => {
  if (!ui.resizer.hasPointerCapture(e.pointerId)) return;
  // The panel runs to the right edge of the window, so its width is the distance from the cursor to it.
  panelWidthNow = setPanelWidth(window.innerWidth - e.clientX - 3);
});

const endPanelDrag = (e) => {
  if (!ui.resizer.hasPointerCapture(e.pointerId)) return;
  ui.resizer.releasePointerCapture(e.pointerId);
  ui.resizer.classList.remove("active");
  if (panelWidthNow) {
    try {
      localStorage.setItem(PANEL_KEY, String(panelWidthNow));
    } catch (err) {
      // Ignore storage errors; the width still applies for this visit.
    }
  }
};
ui.resizer.addEventListener("pointerup", endPanelDrag);
ui.resizer.addEventListener("pointercancel", endPanelDrag);

function init() {
  refreshFontOptions();
  loadProject();
  state.customFonts.forEach(registerFont);
  refreshFontOptions();

  ui.exQualityVal.textContent = ui.exQuality.value;
  refreshAll();

  setStatus(state.layers.length ? "Restored your last project" : "Autosave is on");
  document.fonts.ready.then(() => render());
  state.layers.forEach((l) => {
    if (l.type === "text") loadFont(l);
  });
}

init();
