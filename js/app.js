/* Miro-lite no-auth board: GitHub Pages + Firebase RTDB (public read/write) */
(function(){
  // Firebase init
  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();

  // Config
  const BOARD_ID = "default";
  const base = (p) => db.ref("board/" + BOARD_ID + "/" + p);
  const strokesRef = base("strokes");
  const notesRef   = base("notes");
  const imagesRef  = base("images");
  const presenceRef= base("presence");
  const connectedRef = db.ref(".info/connected");

  // Canvas
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const WORLD = { minX: 0, minY: 0, maxX: 20000, maxY: 20000 };
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    clampViewport();
    markDirty();
  }
  window.addEventListener("resize", resize);

  // State
  const state = {
    tool: "draw",
    color: "#e5e7eb",
    width: 4,
    drawing: false,
    path: [],
    lastClick: { x: 100, y: 100 },
    items: { strokes: [], notes: [], images: [] },
    draggingItem: null,
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    panning: null
  };

  const history = [];
  const redoStack = [];
  const MAX_HISTORY = 100;

  function recordAction(action) {
    if (!action) return;
    history.push(action);
    if (history.length > MAX_HISTORY) history.shift();
    redoStack.length = 0;
  }

  async function undo() {
    const action = history.pop();
    if (!action) return;
    await action.undo();
    redoStack.push(action);
  }

  async function redo() {
    const action = redoStack.pop();
    if (!action) return;
    await action.redo();
    history.push(action);
  }

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  function clampWorldPoint(p) {
    return {
      x: clamp(p.x, WORLD.minX, WORLD.maxX),
      y: clamp(p.y, WORLD.minY, WORLD.maxY)
    };
  }

  function clampViewport() {
    const scale = state.viewport.scale;
    const viewW = canvas.clientWidth / scale;
    const viewH = canvas.clientHeight / scale;
    const worldW = WORLD.maxX - WORLD.minX;
    const worldH = WORLD.maxY - WORLD.minY;
    const maxOffsetX = viewW >= worldW ? WORLD.minX : WORLD.maxX - viewW;
    const maxOffsetY = viewH >= worldH ? WORLD.minY : WORLD.maxY - viewH;
    state.viewport.offsetX = clamp(state.viewport.offsetX, WORLD.minX, maxOffsetX);
    state.viewport.offsetY = clamp(state.viewport.offsetY, WORLD.minY, maxOffsetY);
  }

  function screenToWorld(p) {
    const { scale, offsetX, offsetY } = state.viewport;
    return clampWorldPoint({
      x: p.x / scale + offsetX,
      y: p.y / scale + offsetY
    });
  }

  function worldToScreen(p) {
    const { scale, offsetX, offsetY } = state.viewport;
    return {
      x: (p.x - offsetX) * scale,
      y: (p.y - offsetY) * scale
    };
  }

  // UI
  const toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
  function setTool(t) {
    state.tool = t;
    state.drawing = false;
    state.draggingItem = null;
    state.path = [];
    toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === t));
    if (t === "image") document.getElementById("file").click();
  }
  toolButtons.forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  setTool("draw");

  document.getElementById("color").addEventListener("input", e => state.color = e.target.value);
  document.getElementById("width").addEventListener("input", e => state.width = +e.target.value);

  document.getElementById("save").addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "board.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  // Pointer helpers
  function getXY(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function getWorldXY(evt) {
    return screenToWorld(getXY(evt));
  }

  canvas.addEventListener("contextmenu", e => e.preventDefault());

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const delta = e.deltaY || 0;
    if (!delta) return;
    const pointer = getXY(e);
    const worldBefore = screenToWorld(pointer);
    const scale = state.viewport.scale;
    const nextScale = clamp(scale * Math.exp(-delta / 500), MIN_SCALE, MAX_SCALE);
    if (Math.abs(nextScale - scale) < 1e-4) return;
    state.viewport.scale = nextScale;
    state.viewport.offsetX = worldBefore.x - pointer.x / nextScale;
    state.viewport.offsetY = worldBefore.y - pointer.y / nextScale;
    clampViewport();
    markDirty();
  }, { passive: false });

  canvas.addEventListener("pointerdown", async e => {
    if (e.button === 2) {
      canvas.setPointerCapture(e.pointerId);
      state.panning = {
        pointerId: e.pointerId,
        start: getXY(e),
        offset: { x: state.viewport.offsetX, y: state.viewport.offsetY }
      };
      return;
    }
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const worldP = getWorldXY(e);
    if (state.tool === "draw") {
      state.drawing = true;
      state.path = [worldP];
      markDirty();
    } else if (state.tool === "erase") {
      state.drawing = true;
      state.path = [worldP];
    } else if (state.tool === "text") {
      const text = prompt("Enter text:");
      if (!text) return;
      const note = { x: worldP.x|0, y: worldP.y|0, text, color:state.color, size:20 };
      const ref = notesRef.push();
      await ref.set(note);
      recordAction({
        undo: () => ref.remove(),
        redo: () => ref.set(note)
      });
    } else if (state.tool === "image") {
      state.lastClick = { x: worldP.x, y: worldP.y };
    } else if (state.tool === "move") {
      state.draggingItem = pickMovable(worldP);
      if (state.draggingItem) {
        state.draggingItem.start = worldP;
      } else {
        state.draggingItem = null;
      }
    }
  });

  canvas.addEventListener("pointermove", e => {
    if (state.panning && state.panning.pointerId === e.pointerId) {
      const current = getXY(e);
      const dx = current.x - state.panning.start.x;
      const dy = current.y - state.panning.start.y;
      const scale = state.viewport.scale;
      state.viewport.offsetX = state.panning.offset.x - dx / scale;
      state.viewport.offsetY = state.panning.offset.y - dy / scale;
      clampViewport();
      markDirty();
      return;
    }
    const worldP = getWorldXY(e);
    if (state.tool === "draw" && state.drawing) {
      state.path.push(worldP);
      markDirty();
    } else if (state.tool === "erase" && state.drawing) {
      state.path[0] = worldP;
    } else if (state.tool === "move" && state.draggingItem) {
      updateDrag(worldP);
    }
  });

  canvas.addEventListener("pointerup", async e => {
    if (state.panning && state.panning.pointerId === e.pointerId) {
      state.panning = null;
      return;
    }
    if (state.tool === "draw" && state.drawing) {
      state.drawing = false;
      if (state.path.length > 1) {
        const pts = toWire(simplify(quantize(state.path, 0.5), 1.2));
        const stroke = { color: state.color, width: state.width, points: pts };
        const ref = strokesRef.push();
        await ref.set(stroke);
        recordAction({
          undo: () => ref.remove(),
          redo: () => ref.set(stroke)
        });
      }
    }
    if (state.tool === "erase" && state.drawing) {
      state.drawing = false;
      const p = state.path[state.path.length - 1] || state.path[0] || getWorldXY(e);
      const hit = findStrokeAt(p);
      if (hit) {
        const data = stripId(hit);
        const ref = strokesRef.child(hit.id);
        const idx = state.items.strokes.findIndex(s => s.id === hit.id);
        if (idx >= 0) {
          state.items.strokes.splice(idx, 1);
          markDirty();
        }
        await ref.remove();
        recordAction({
          undo: () => ref.set(data),
          redo: () => ref.remove()
        });
      }
    }
    if (state.draggingItem) {
      await commitDrag(state.draggingItem);
    }
    state.path = [];
    state.drawing = false;
    markDirty();
  });

  canvas.addEventListener("pointercancel", () => {
    state.drawing = false;
    state.draggingItem = null;
    state.path = [];
    state.panning = null;
  });

  canvas.addEventListener("pointerleave", e => {
    if (e.buttons) return;
    state.drawing = false;
    state.draggingItem = null;
    state.path = [];
    state.panning = null;
  });

  window.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (shouldIgnoreHotkey(e)) return;
    const key = (e.key || "").toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo().catch(console.error);
    } else if (key === "z" && e.shiftKey) {
      e.preventDefault();
      redo().catch(console.error);
    } else if (key === "y") {
      e.preventDefault();
      redo().catch(console.error);
    }
  });

  // File input + paste + drop for images
  const fileInput = document.getElementById("file");
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (f) await handleImageFile(f, clampWorldPoint(state.lastClick));
    fileInput.value = "";
    setTool("draw");
  });

  window.addEventListener("paste", async e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    if (!item) return;
    const f = item.getAsFile();
    if (f) await handleImageFile(f, state.lastClick);
  });

  window.addEventListener("dragover", e => { e.preventDefault(); });
  window.addEventListener("drop", async e => {
    e.preventDefault();
    const f = (e.dataTransfer?.files || [])[0];
    if (f && /^image\//.test(f.type)) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const world = screenToWorld(screen);
      await handleImageFile(f, world);
    }
  });

  async function handleImageFile(file, at) {
    const { dataURL, w, h } = await compressToDataURL(file, 1024);
    const maxX = Math.max(WORLD.minX, WORLD.maxX - w);
    const maxY = Math.max(WORLD.minY, WORLD.maxY - h);
    const img = {
      x: clamp(Math.round(at.x), WORLD.minX, maxX),
      y: clamp(Math.round(at.y), WORLD.minY, maxY),
      w,
      h,
      data: dataURL
    };
    const ref = imagesRef.push();
    await ref.set(img);
    recordAction({
      undo: () => ref.remove(),
      redo: () => ref.set(img)
    });
  }

  async function compressToDataURL(file, maxDim) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const cx = off.getContext("2d");
    cx.drawImage(bmp, 0, 0, w, h);
    let dataURL = "";
    try { dataURL = off.toDataURL("image/webp", 0.85); }
    catch { dataURL = off.toDataURL("image/png"); }
    return { dataURL, w, h };
  }

  // Simplification utilities
  function quantize(points, q) {
    return points.map(p => ({ x: Math.round(p.x / q) * q, y: Math.round(p.y / q) * q }));
  }
  function simplify(pts, eps) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let last = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], n = pts[i+1];
      const d = perpDist(last, n, p);
      if (d > eps) { out.push(p); last = p; }
    }
    out.push(pts[pts.length-1]);
    return out;
  }
  function perpDist(a, b, p) {
    const A = b.y - a.y, B = a.x - b.x, C = b.x*a.y - a.x*b.y;
    return Math.abs(A*p.x + B*p.y + C) / Math.hypot(A,B);
  }
  function toWire(points) { return points.map(p => [p.x|0, p.y|0]); }

  function stripId(obj) {
    const { id, ...rest } = obj || {};
    if (typeof structuredClone === "function") return structuredClone(rest);
    return JSON.parse(JSON.stringify(rest));
  }

  function findStrokeAt(p) {
    for (let i = state.items.strokes.length - 1; i >= 0; i--) {
      const s = state.items.strokes[i];
      const pts = s.points || [];
      if (!pts.length) continue;
      const xs = pts.map(pt => pt[0]);
      const ys = pts.map(pt => pt[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs);
      const miny = Math.min(...ys), maxy = Math.max(...ys);
      const pad = (s.width || 1) / 2 + 4;
      if (p.x >= minx - pad && p.x <= maxx + pad && p.y >= miny - pad && p.y <= maxy + pad) {
        return s;
      }
    }
    return null;
  }

  function findImageAt(p) {
    for (let i = state.items.images.length - 1; i >= 0; i--) {
      const img = state.items.images[i];
      if (p.x >= img.x && p.x <= img.x + img.w && p.y >= img.y && p.y <= img.y + img.h) {
        return img;
      }
    }
    return null;
  }

  function measureNote(note) {
    const size = note.size || 20;
    const text = note.text || "";
    ctx.save();
    ctx.font = size + "px sans-serif";
    const metrics = ctx.measureText(text);
    ctx.restore();
    const height = (metrics.actualBoundingBoxAscent && metrics.actualBoundingBoxDescent)
      ? metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
      : size;
    return {
      width: Math.max(metrics.width, 1),
      height: Math.max(height, size)
    };
  }

  function getNoteBounds(note) {
    const { width, height } = measureNote(note);
    return { x: note.x, y: note.y, w: width, h: height };
  }

  function findNoteAt(p) {
    for (let i = state.items.notes.length - 1; i >= 0; i--) {
      const note = state.items.notes[i];
      const bounds = getNoteBounds(note);
      if (p.x >= bounds.x && p.x <= bounds.x + bounds.w && p.y >= bounds.y && p.y <= bounds.y + bounds.h) {
        return { note, bounds };
      }
    }
    return null;
  }

  function nearCorner(p, bounds) {
    const cornerX = bounds.x + bounds.w;
    const cornerY = bounds.y + bounds.h;
    const tolerance = 20 / state.viewport.scale;
    return Math.hypot(p.x - cornerX, p.y - cornerY) <= tolerance;
  }

  function pickMovable(p) {
    const img = findImageAt(p);
    if (img) {
      const bounds = { x: img.x, y: img.y, w: img.w, h: img.h };
      const mode = nearCorner(p, bounds) ? "scale" : "move";
      return {
        type: "image",
        id: img.id,
        mode,
        offset: { x: p.x - img.x, y: p.y - img.y },
        original: { x: img.x, y: img.y, w: img.w, h: img.h },
        start: p,
        current: null
      };
    }
    const noteEntry = findNoteAt(p);
    if (noteEntry) {
      const { note, bounds } = noteEntry;
      const mode = nearCorner(p, bounds) ? "scale" : "move";
      return {
        type: "note",
        id: note.id,
        mode,
        offset: { x: p.x - note.x, y: p.y - note.y },
        original: { x: note.x, y: note.y, size: note.size || 20 },
        start: p,
        current: null
      };
    }
    return null;
  }

  function updateDrag(p) {
    const drag = state.draggingItem;
    if (!drag) return;
    const list = drag.type === "image" ? state.items.images : state.items.notes;
    const item = list.find(x => x.id === drag.id);
    if (!item) return;
    if (drag.mode === "move") {
      const nx = Math.round(p.x - drag.offset.x);
      const ny = Math.round(p.y - drag.offset.y);
      if (drag.current && drag.current.x === nx && drag.current.y === ny) return;
      drag.current = { x: nx, y: ny };
      item.x = nx;
      item.y = ny;
    } else if (drag.type === "image") {
      const newW = Math.max(16, Math.round(drag.original.w + (p.x - drag.start.x)));
      const newH = Math.max(16, Math.round(drag.original.h + (p.y - drag.start.y)));
      if (drag.current && drag.current.w === newW && drag.current.h === newH) return;
      drag.current = { w: newW, h: newH };
      item.w = newW;
      item.h = newH;
    } else {
      const delta = Math.max(p.x - drag.start.x, p.y - drag.start.y);
      const newSize = Math.max(8, Math.round(drag.original.size + delta * 0.5));
      if (drag.current && drag.current.size === newSize) return;
      drag.current = { size: newSize };
      item.size = newSize;
    }
    markDirty();
  }

  async function commitDrag(drag) {
    state.draggingItem = null;
    if (!drag || !drag.current) return;
    const ref = (drag.type === "image" ? imagesRef : notesRef).child(drag.id);
    let updates = {};
    let undoData = {};
    if (drag.mode === "move") {
      updates = { x: drag.current.x, y: drag.current.y };
      undoData = { x: Math.round(drag.original.x), y: Math.round(drag.original.y) };
    } else if (drag.type === "image") {
      updates = { w: drag.current.w, h: drag.current.h };
      undoData = { w: Math.round(drag.original.w), h: Math.round(drag.original.h) };
    } else {
      updates = { size: drag.current.size };
      undoData = { size: Math.round(drag.original.size) };
    }
    const isSame = Object.keys(updates).every(k => updates[k] === undoData[k]);
    if (isSame) return;
    await ref.update(updates);
    recordAction({
      undo: () => ref.update(undoData),
      redo: () => ref.update(updates)
    });
  }

  function shouldIgnoreHotkey(e) {
    const target = e.target;
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  }

  // Rendering
  const cache = { images: new Map() };
  let dirty = true;
  function markDirty(){ dirty = true; }
  function loop(){ if (dirty) { redraw(); dirty = false; } requestAnimationFrame(loop); }
  loop();

  function redraw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    // strokes
    for (const s of state.items.strokes) {
      const pts = s.points;
      if (!pts || pts.length < 2) continue;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = (s.width || 1) * state.viewport.scale;
      ctx.beginPath();
      for (let i = 1; i < pts.length; i++) {
        const a = worldToScreen({ x: pts[i-1][0], y: pts[i-1][1] });
        const b = worldToScreen({ x: pts[i][0], y: pts[i][1] });
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    if (state.drawing && state.tool === "draw" && state.path.length > 1) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = state.color;
      ctx.lineWidth = state.width * state.viewport.scale;
      ctx.beginPath();
      for (let i = 1; i < state.path.length; i++) {
        const a = worldToScreen(state.path[i-1]);
        const b = worldToScreen(state.path[i]);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    // notes
    for (const n of state.items.notes) {
      const screen = worldToScreen({ x: n.x, y: n.y });
      ctx.fillStyle = n.color || "#e5e7eb";
      ctx.font = ((n.size || 20) * state.viewport.scale) + "px sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(n.text, screen.x, screen.y);
    }
    // images
    for (const m of state.items.images) {
      let img = cache.images.get(m.id);
      if (!img) {
        img = new Image();
        img.onload = () => { markDirty(); };
        img.src = m.data;
        cache.images.set(m.id, img);
      }
      if (img.complete) {
        const screen = worldToScreen({ x: m.x, y: m.y });
        ctx.drawImage(img, screen.x, screen.y, m.w * state.viewport.scale, m.h * state.viewport.scale);
      }
    }
  }

  function attachList(ref, key) {
    const arr = state.items[key];
    ref.on("child_added", snap => {
      const val = snap.val() || {};
      arr.push(Object.assign({ id:snap.key }, val));
      markDirty();
    });
    ref.on("child_removed", snap => {
      const i = arr.findIndex(x => x.id === snap.key);
      if (i >= 0) arr.splice(i, 1);
      cache.images.delete(snap.key);
      markDirty();
    });
    ref.on("child_changed", snap => {
      const i = arr.findIndex(x => x.id === snap.key);
      if (i >= 0) { arr[i] = Object.assign({ id:snap.key }, snap.val()); }
      cache.images.delete(snap.key);
      markDirty();
    });
  }

  // Presence count
  const usersEl = document.getElementById("users");
  const myId = (crypto.randomUUID && crypto.randomUUID()) || (Math.random().toString(36).slice(2));
  connectedRef.on("value", s => {
    if (!s.val()) return;
    const me = presenceRef.child(myId);
    me.onDisconnect().remove();
    me.set(true);
  });
  presenceRef.on("value", snap => {
    const v = snap.val() || {};
    usersEl.textContent = "Users: " + Object.keys(v).length;
  });

  // Start
  resize();
  attachList(strokesRef, "strokes");
  attachList(notesRef, "notes");
  attachList(imagesRef, "images");
})();