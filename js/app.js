/* Enhanced collaborative whiteboard with expanded Miro-like tools */
(function(){
  // Firebase init
  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();

  // Config
  const BOARD_ID = "default";
  const base = (path) => db.ref("board/" + BOARD_ID + "/" + path);
  const refs = {
    strokes: base("strokes"),
    notes: base("notes"),
    images: base("images"),
    shapes: base("shapes"),
    connectors: base("connectors"),
    presence: base("presence")
  };
  const connectedRef = db.ref(".info/connected");

  // DOM
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const miniCanvas = document.getElementById("mini");
  const miniCtx = miniCanvas ? miniCanvas.getContext("2d") : null;
  const toolButtons = Array.from(document.querySelectorAll(".miro-tool[data-tool]"));
  const strokeInput = document.getElementById("strokeColor");
  const fillInput = document.getElementById("fillColor");
  const widthInput = document.getElementById("width");
  const opacityInput = document.getElementById("opacity");
  const undoBtn = document.getElementById("undo");
  const redoBtn = document.getElementById("redo");
  const duplicateBtn = document.getElementById("duplicate");
  const deleteBtn = document.getElementById("delete");
  const saveBtn = document.getElementById("save");
  const swatches = Array.from(document.querySelectorAll("#sticky-swatches .miro-swatch"));
  const fileInput = document.getElementById("file");
  const zoomEl = document.getElementById("zoom");
  const usersEl = document.getElementById("users");

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const WORLD = { minX: 0, minY: 0, maxX: 20000, maxY: 20000 };
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;
  const GRID_BASE = 120;
  const SECRET_CLICK_COUNT = 5;
  const SECRET_CLICK_WINDOW = 1500;

  const state = {
    tool: "select",
    stroke: strokeInput ? strokeInput.value : "#e5e7eb",
    fill: fillInput ? fillInput.value : "#1f2937",
    width: +(widthInput ? widthInput.value : 4),
    opacity: +(opacityInput ? opacityInput.value : 1),
    drawing: false,
    path: [],
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    panning: null,
    selection: null,
    draggingItem: null,
    dragCreate: null,
    connector: null,
    items: {
      strokes: [],
      notes: [],
      images: [],
      shapes: [],
      connectors: []
    },
    lastClick: { x: 200, y: 200 }
  };

  const history = [];
  const redoStack = [];
  const MAX_HISTORY = 150;
  const cache = { images: new Map() };
  let dirty = true;
  let miniDirty = true;
  let eraseClicks = [];
  let inspectorLock = false;

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
    markDirty();
  }

  async function redo() {
    const action = redoStack.pop();
    if (!action) return;
    await action.redo();
    history.push(action);
    markDirty();
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

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    clampViewport();
    markDirty();
    if (miniCanvas) {
      miniCanvas.width = miniCanvas.clientWidth * DPR;
      miniCanvas.height = miniCanvas.clientHeight * DPR;
      miniCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      miniDirty = true;
    }
    updateZoom();
  }
  window.addEventListener("resize", resize);

  function markDirty() {
    dirty = true;
    miniDirty = true;
  }

  function loop() {
    if (dirty) {
      redraw();
      dirty = false;
    }
    if (miniDirty && miniCtx) {
      drawMinimap();
      miniDirty = false;
    }
    requestAnimationFrame(loop);
  }
  loop();

  function updateCursor() {
    if (state.panning) {
      canvas.style.cursor = "grabbing";
      return;
    }
    if (state.tool === "select") {
      canvas.style.cursor = "default";
    } else if (state.tool === "erase") {
      canvas.style.cursor = "crosshair";
    } else if (state.tool === "line" || state.tool === "arrow") {
      canvas.style.cursor = "crosshair";
    } else if (state.tool === "image") {
      canvas.style.cursor = "copy";
    } else {
      canvas.style.cursor = "crosshair";
    }
  }

  function setTool(name) {
    state.tool = name;
    state.drawing = false;
    state.dragCreate = null;
    state.connector = null;
    state.path = [];
    state.draggingItem = null;
    toolButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.tool === name));
    if (name === "image") {
      fileInput?.click();
    }
    if (name === "highlighter") {
      state.opacity = Math.min(state.opacity, 0.45);
      if (opacityInput) {
        inspectorLock = true;
        opacityInput.value = state.opacity;
        inspectorLock = false;
      }
    }
    updateCursor();
    markDirty();
  }

  function setSelection(sel) {
    if (sel && sel.id && sel.type) {
      state.selection = sel;
    } else {
      state.selection = null;
    }
    updateInspector();
    markDirty();
  }

  function updateZoom() {
    if (!zoomEl) return;
    zoomEl.textContent = Math.round(state.viewport.scale * 100) + "%";
  }

  function updateInspector() {
    if (inspectorLock) return;
    const sel = state.selection;
    if (!strokeInput || !fillInput || !opacityInput || !widthInput) return;
    inspectorLock = true;
    strokeInput.value = state.stroke;
    fillInput.value = state.fill;
    opacityInput.value = state.opacity;
    widthInput.value = state.width;
    if (sel) {
      const item = getItemBySelection(sel);
      if (item) {
        if (sel.type === "shape" || sel.type === "connector" || sel.type === "stroke") {
          strokeInput.value = item.stroke || state.stroke;
          widthInput.value = item.width || state.width;
        }
        if (sel.type === "shape" || sel.type === "note") {
          const fill = item.fill ?? item.bg ?? state.fill;
          if (fill) {
            fillInput.value = fill;
          }
        }
        if (sel.type === "shape" || sel.type === "connector" || sel.type === "stroke" || sel.type === "note") {
          opacityInput.value = item.opacity != null ? item.opacity : state.opacity;
        }
      }
    }
    inspectorLock = false;
  }

  function getItemBySelection(sel) {
    if (!sel) return null;
    const list = state.items[sel.type + "s"];
    if (Array.isArray(list)) {
      return list.find(item => item.id === sel.id) || null;
    }
    if (sel.type === "connector") {
      return state.items.connectors.find(c => c.id === sel.id) || null;
    }
    return null;
  }

  // Tool button actions
  toolButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tool === "erase") trackEraseClick();
      setTool(btn.dataset.tool);
    });
  });
  setTool("select");
  strokeInput?.addEventListener("input", e => {
    if (inspectorLock) return;
    state.stroke = e.target.value;
    const sel = state.selection;
    if (sel && ["shape", "connector", "stroke"].includes(sel.type)) {
      const item = getItemBySelection(sel);
      if (!item) return;
      const ref = getRefForSelection(sel);
      const before = { stroke: item.stroke || state.stroke };
      const updates = { stroke: state.stroke };
      ref.child(sel.id).update(updates);
      recordAction({
        undo: () => ref.child(sel.id).update(before),
        redo: () => ref.child(sel.id).update(updates)
      });
    }
    markDirty();
  });

  fillInput?.addEventListener("input", e => {
    if (inspectorLock) return;
    state.fill = e.target.value;
    const sel = state.selection;
    if (sel && (sel.type === "shape" || sel.type === "note")) {
      const item = getItemBySelection(sel);
      if (!item) return;
      const ref = getRefForSelection(sel);
      const key = sel.type === "note" ? "bg" : "fill";
      const before = {};
      before[key] = item[key] ?? null;
      const updates = {};
      updates[key] = state.fill;
      ref.child(sel.id).update(updates);
      recordAction({
        undo: () => ref.child(sel.id).update(before),
        redo: () => ref.child(sel.id).update(updates)
      });
    }
    markDirty();
  });

  opacityInput?.addEventListener("input", e => {
    if (inspectorLock) return;
    state.opacity = parseFloat(e.target.value);
    const sel = state.selection;
    if (sel && ["shape", "connector", "stroke", "note"].includes(sel.type)) {
      const item = getItemBySelection(sel);
      if (!item) return;
      const ref = getRefForSelection(sel);
      const before = { opacity: item.opacity != null ? item.opacity : null };
      const updates = { opacity: state.opacity };
      ref.child(sel.id).update(updates);
      recordAction({
        undo: () => ref.child(sel.id).update(before),
        redo: () => ref.child(sel.id).update(updates)
      });
    }
    markDirty();
  });

  widthInput?.addEventListener("input", e => {
    if (inspectorLock) return;
    state.width = parseInt(e.target.value, 10) || 1;
    const sel = state.selection;
    if (sel && ["shape", "connector", "stroke"].includes(sel.type)) {
      const item = getItemBySelection(sel);
      if (!item) return;
      const ref = getRefForSelection(sel);
      const before = { width: item.width || 1 };
      const updates = { width: state.width };
      ref.child(sel.id).update(updates);
      recordAction({
        undo: () => ref.child(sel.id).update(before),
        redo: () => ref.child(sel.id).update(updates)
      });
    }
    markDirty();
  });

  swatches.forEach(btn => {
    const fill = btn.getAttribute("data-fill");
    btn.style.background = fill;
    btn.addEventListener("click", () => {
      state.fill = fill;
      if (fillInput) {
        inspectorLock = true;
        fillInput.value = fill;
        inspectorLock = false;
      }
      const sel = state.selection;
      if (sel && sel.type === "note") {
        const ref = getRefForSelection(sel);
        const before = { bg: getItemBySelection(sel).bg || null };
        const updates = { bg: fill };
        ref.child(sel.id).update(updates);
        recordAction({
          undo: () => ref.child(sel.id).update(before),
          redo: () => ref.child(sel.id).update(updates)
        });
      }
      markDirty();
    });
  });

  undoBtn?.addEventListener("click", () => { undo().catch(console.error); });
  redoBtn?.addEventListener("click", () => { redo().catch(console.error); });

  duplicateBtn?.addEventListener("click", () => {
    duplicateSelection().catch(console.error);
  });

  deleteBtn?.addEventListener("click", () => {
    deleteSelection().catch(console.error);
  });

  saveBtn?.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "board.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  fileInput?.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (f) await handleImageFile(f, clampWorldPoint(state.lastClick));
    fileInput.value = "";
    setTool("select");
  });

  window.addEventListener("paste", async e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    if (!item) return;
    const f = item.getAsFile();
    if (f) await handleImageFile(f, state.lastClick);
  });

  window.addEventListener("dragover", e => e.preventDefault());
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
    updateZoom();
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
      updateCursor();
      return;
    }
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const worldP = getWorldXY(e);
    state.lastClick = worldP;

    if (state.tool === "draw" || state.tool === "highlighter") {
      state.drawing = true;
      state.path = [worldP];
      markDirty();
      return;
    }

    if (state.tool === "erase") {
      state.drawing = true;
      state.path = [worldP];
      return;
    }

    if (state.tool === "text") {
      const text = prompt("Enter text");
      if (!text) return;
      await createNote(worldP, { text, kind: "text", color: state.stroke, bg: null });
      setTool("select");
      return;
    }

    if (state.tool === "sticky") {
      await createNote(worldP, {
        text: "New sticky",
        kind: "sticky",
        color: chooseTextColor(state.fill),
        bg: state.fill,
        size: 20
      });
      setTool("select");
      return;
    }

    if (state.tool === "rect" || state.tool === "ellipse") {
      state.dragCreate = {
        type: state.tool,
        start: worldP,
        current: worldP
      };
      markDirty();
      return;
    }

    if (state.tool === "line" || state.tool === "arrow") {
      state.connector = {
        type: state.tool,
        start: worldP,
        current: worldP
      };
      markDirty();
      return;
    }

    if (state.tool === "image") {
      return;
    }

    const pick = pickItem(worldP);
    if (pick) {
      setSelection({ type: pick.type, id: pick.item.id });
      state.draggingItem = {
        ...pick,
        start: worldP,
        original: cloneItemSnapshot(pick),
        current: null,
        pointerId: e.pointerId
      };
    } else {
      setSelection(null);
    }
  });

  canvas.addEventListener("pointermove", e => {
    if (state.panning && state.panning.pointerId === e.pointerId) {
      if (!(e.buttons & 2)) {
        state.panning = null;
        updateCursor();
        return;
      }
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

    if (state.drawing && (state.tool === "draw" || state.tool === "highlighter")) {
      state.path.push(worldP);
      markDirty();
      return;
    }

    if (state.drawing && state.tool === "erase") {
      state.path[0] = worldP;
      markDirty();
      return;
    }

    if (state.dragCreate) {
      state.dragCreate.current = worldP;
      markDirty();
      return;
    }

    if (state.connector) {
      state.connector.current = worldP;
      markDirty();
      return;
    }

    if (state.draggingItem && state.draggingItem.pointerId === e.pointerId) {
      updateDrag(state.draggingItem, worldP);
      return;
    }
  });
  canvas.addEventListener("pointerup", async e => {
    if (state.panning && state.panning.pointerId === e.pointerId) {
      state.panning = null;
      updateCursor();
      return;
    }

    const worldP = getWorldXY(e);

    if ((state.tool === "draw" || state.tool === "highlighter") && state.drawing) {
      state.drawing = false;
      if (state.path.length > 1) {
        const points = toWire(simplify(quantize(state.path, 0.5), 1.2));
        const stroke = {
          color: state.stroke,
          width: state.width,
          points,
          opacity: state.opacity,
          mode: state.tool === "highlighter" ? "multiply" : "normal"
        };
        const ref = refs.strokes.push();
        await ref.set(stroke);
        recordAction({
          undo: () => ref.remove(),
          redo: () => ref.set(stroke)
        });
      }
      state.path = [];
    } else if (state.tool === "erase" && state.drawing) {
      state.drawing = false;
      const target = findStrokeAt(worldP);
      if (target) {
        const ref = refs.strokes.child(target.id);
        const prev = stripId(target);
        await ref.remove();
        recordAction({
          undo: () => ref.set(prev),
          redo: () => ref.remove()
        });
      }
      state.path = [];
    } else if (state.dragCreate) {
      const created = await commitShapeCreate(state.dragCreate);
      state.dragCreate = null;
      if (created) {
        setSelection(created);
      }
    } else if (state.connector) {
      const created = await commitConnectorCreate(state.connector);
      state.connector = null;
      if (created) {
        setSelection(created);
      }
    }

    if (state.draggingItem && state.draggingItem.pointerId === e.pointerId) {
      await commitDrag(state.draggingItem);
      state.draggingItem = null;
    }

    state.drawing = false;
    updateCursor();
    markDirty();
  });

  canvas.addEventListener("pointercancel", () => {
    state.drawing = false;
    state.dragCreate = null;
    state.connector = null;
    state.draggingItem = null;
    state.panning = null;
    state.path = [];
    updateCursor();
  });

  canvas.addEventListener("pointerleave", e => {
    if (e.buttons) return;
    state.drawing = false;
    state.dragCreate = null;
    state.connector = null;
    state.draggingItem = null;
    state.panning = null;
    state.path = [];
    updateCursor();
  });

  canvas.addEventListener("dblclick", async e => {
    const worldP = getWorldXY(e);
    const noteHit = findNoteAt(worldP);
    if (noteHit) {
      const { note } = noteHit;
      const text = prompt("Edit note text", note.text || "");
      if (text === null) return;
      const ref = refs.notes.child(note.id);
      const before = { text: note.text || "" };
      const updates = { text };
      await ref.update(updates);
      recordAction({
        undo: () => ref.update(before),
        redo: () => ref.update(updates)
      });
      markDirty();
    }
  });

  window.addEventListener("keydown", e => {
    const key = (e.key || "").toLowerCase();
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo().catch(console.error);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ((key === "z" && e.shiftKey) || key === "y")) {
      e.preventDefault();
      redo().catch(console.error);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "d") {
      e.preventDefault();
      duplicateSelection().catch(console.error);
      return;
    }
    if (key === "delete" || key === "backspace") {
      if (state.selection) {
        e.preventDefault();
        deleteSelection().catch(console.error);
      }
      return;
    }
    if (!e.ctrlKey && !e.metaKey) {
      if (key === "v") setTool("select");
      if (key === "p") setTool("draw");
      if (key === "h") setTool("highlighter");
      if (key === "n") setTool("sticky");
      if (key === "t") setTool("text");
      if (key === "r") setTool("rect");
      if (key === "e") setTool("ellipse");
      if (key === "l") setTool("line");
      if (key === "a") setTool("arrow");
      if (key === "i") setTool("image");
    }
  });

  async function createNote(point, opts) {
    const note = {
      x: Math.round(point.x),
      y: Math.round(point.y),
      text: opts.text || "Note",
      color: opts.color || state.stroke,
      bg: opts.bg ?? null,
      size: opts.size || 20,
      kind: opts.kind || "text",
      opacity: opts.opacity != null ? opts.opacity : 1
    };
    const ref = refs.notes.push();
    await ref.set(note);
    recordAction({
      undo: () => ref.remove(),
      redo: () => ref.set(note)
    });
    setSelection({ type: "note", id: ref.key });
    markDirty();
  }

  async function commitShapeCreate(drag) {
    const dx = drag.current.x - drag.start.x;
    const dy = drag.current.y - drag.start.y;
    const w = Math.max(24, Math.abs(Math.round(dx)));
    const h = Math.max(24, Math.abs(Math.round(dy)));
    if (w < 4 || h < 4) return null;
    const shape = {
      type: drag.type,
      x: Math.round(dx >= 0 ? drag.start.x : drag.start.x + dx),
      y: Math.round(dy >= 0 ? drag.start.y : drag.start.y + dy),
      w,
      h,
      stroke: state.stroke,
      fill: state.fill,
      opacity: state.opacity,
      width: state.width
    };
    const ref = refs.shapes.push();
    await ref.set(shape);
    recordAction({
      undo: () => ref.remove(),
      redo: () => ref.set(shape)
    });
    return { type: "shape", id: ref.key };
  }

  async function commitConnectorCreate(conn) {
    const dx = conn.current.x - conn.start.x;
    const dy = conn.current.y - conn.start.y;
    if (Math.hypot(dx, dy) < 8) return null;
    const data = {
      ax: Math.round(conn.start.x),
      ay: Math.round(conn.start.y),
      bx: Math.round(conn.current.x),
      by: Math.round(conn.current.y),
      arrow: conn.type === "arrow",
      stroke: state.stroke,
      width: state.width,
      opacity: state.opacity
    };
    const ref = refs.connectors.push();
    await ref.set(data);
    recordAction({
      undo: () => ref.remove(),
      redo: () => ref.set(data)
    });
    return { type: "connector", id: ref.key };
  }

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
    const ref = refs.images.push();
    await ref.set(img);
    recordAction({
      undo: () => ref.remove(),
      redo: () => ref.set(img)
    });
    setSelection({ type: "image", id: ref.key });
    markDirty();
  }

  async function duplicateSelection() {
    const sel = state.selection;
    if (!sel) return;
    const item = getItemBySelection(sel);
    if (!item) return;
    const ref = getRefForSelection(sel);
    const cloneRef = ref.push();
    const offset = 32;
    let cloneData = null;
    if (sel.type === "note") {
      cloneData = {
        ...stripId(item),
        x: clamp(item.x + offset, WORLD.minX, WORLD.maxX),
        y: clamp(item.y + offset, WORLD.minY, WORLD.maxY)
      };
    } else if (sel.type === "shape") {
      cloneData = {
        ...stripId(item),
        x: clamp(item.x + offset, WORLD.minX, WORLD.maxX),
        y: clamp(item.y + offset, WORLD.minY, WORLD.maxY)
      };
    } else if (sel.type === "image") {
      cloneData = {
        ...stripId(item),
        x: clamp(item.x + offset, WORLD.minX, WORLD.maxX),
        y: clamp(item.y + offset, WORLD.minY, WORLD.maxY)
      };
    } else if (sel.type === "connector") {
      cloneData = {
        ...stripId(item),
        ax: clamp(item.ax + offset, WORLD.minX, WORLD.maxX),
        ay: clamp(item.ay + offset, WORLD.minY, WORLD.maxY),
        bx: clamp(item.bx + offset, WORLD.minX, WORLD.maxX),
        by: clamp(item.by + offset, WORLD.minY, WORLD.maxY)
      };
    } else if (sel.type === "stroke") {
      cloneData = {
        ...stripId(item),
        points: (item.points || []).map(pt => [pt[0] + offset, pt[1] + offset])
      };
    } else {
      return;
    }
    await cloneRef.set(cloneData);
    recordAction({
      undo: () => cloneRef.remove(),
      redo: () => cloneRef.set(cloneData)
    });
    setSelection({ type: sel.type, id: cloneRef.key });
    markDirty();
  }

  async function deleteSelection() {
    const sel = state.selection;
    if (!sel) return;
    const ref = getRefForSelection(sel);
    const item = getItemBySelection(sel);
    if (!item) return;
    const snapshot = stripId(item);
    await ref.child(sel.id).remove();
    recordAction({
      undo: () => ref.child(sel.id).set(snapshot),
      redo: () => ref.child(sel.id).remove()
    });
    setSelection(null);
    markDirty();
  }

  function getRefForSelection(sel) {
    switch (sel.type) {
      case "note": return refs.notes;
      case "shape": return refs.shapes;
      case "image": return refs.images;
      case "connector": return refs.connectors;
      case "stroke": return refs.strokes;
      default: return refs.notes;
    }
  }
  function cloneItemSnapshot(pick) {
    const { item, type } = pick;
    if (type === "stroke") {
      return {
        points: (item.points || []).map(pt => [pt[0], pt[1]])
      };
    }
    if (type === "connector") {
      return { ax: item.ax, ay: item.ay, bx: item.bx, by: item.by };
    }
    if (type === "shape") {
      return { x: item.x, y: item.y, w: item.w, h: item.h };
    }
    if (type === "note") {
      return { x: item.x, y: item.y, size: item.size || 20 };
    }
    if (type === "image") {
      return { x: item.x, y: item.y, w: item.w, h: item.h };
    }
    return {};
  }

  function updateDrag(drag, worldP) {
    const list = state.items[drag.type === "note" ? "notes" :
      drag.type === "shape" ? "shapes" :
      drag.type === "image" ? "images" :
      drag.type === "stroke" ? "strokes" : "connectors"];
    const item = list.find(x => x.id === drag.item.id);
    if (!item) return;
    const dx = worldP.x - drag.start.x;
    const dy = worldP.y - drag.start.y;
    if (drag.type === "connector") {
      const tolerance = nearConnectorEnd(worldP, item);
      if (drag.mode === "endA" || (drag.mode === "auto" && tolerance === "A")) {
        item.ax = clamp(Math.round(drag.original.ax + dx), WORLD.minX, WORLD.maxX);
        item.ay = clamp(Math.round(drag.original.ay + dy), WORLD.minY, WORLD.maxY);
        drag.current = { ax: item.ax, ay: item.ay };
      } else if (drag.mode === "endB" || (drag.mode === "auto" && tolerance === "B")) {
        item.bx = clamp(Math.round(drag.original.bx + dx), WORLD.minX, WORLD.maxX);
        item.by = clamp(Math.round(drag.original.by + dy), WORLD.minY, WORLD.maxY);
        drag.current = { bx: item.bx, by: item.by };
      } else {
        item.ax = clamp(Math.round(drag.original.ax + dx), WORLD.minX, WORLD.maxX);
        item.ay = clamp(Math.round(drag.original.ay + dy), WORLD.minY, WORLD.maxY);
        item.bx = clamp(Math.round(drag.original.bx + dx), WORLD.minX, WORLD.maxX);
        item.by = clamp(Math.round(drag.original.by + dy), WORLD.minY, WORLD.maxY);
        drag.current = { ax: item.ax, ay: item.ay, bx: item.bx, by: item.by };
      }
    } else if (drag.type === "stroke") {
      item.points = (drag.original.points || []).map(pt => [pt[0] + Math.round(dx), pt[1] + Math.round(dy)]);
      drag.current = { offsetX: Math.round(dx), offsetY: Math.round(dy) };
    } else if (drag.mode === "move") {
      let nx = Math.round(drag.original.x + dx);
      let ny = Math.round(drag.original.y + dy);
      if (drag.type === "image") {
        const maxX = Math.max(WORLD.minX, WORLD.maxX - item.w);
        const maxY = Math.max(WORLD.minY, WORLD.maxY - item.h);
        nx = clamp(nx, WORLD.minX, maxX);
        ny = clamp(ny, WORLD.minY, maxY);
      } else {
        nx = clamp(nx, WORLD.minX, WORLD.maxX);
        ny = clamp(ny, WORLD.minY, WORLD.maxY);
      }
      item.x = nx;
      item.y = ny;
      drag.current = { x: nx, y: ny };
    } else {
      if (drag.type === "image" || drag.type === "shape") {
        const nw = clamp(Math.round(drag.original.w + dx), 16, WORLD.maxX - drag.original.x);
        const nh = clamp(Math.round(drag.original.h + dy), 16, WORLD.maxY - drag.original.y);
        item.w = nw;
        item.h = nh;
        drag.current = { w: nw, h: nh };
      } else if (drag.type === "note") {
        const delta = Math.max(dx, dy);
        const size = clamp(Math.round((drag.original.size || 20) + delta * 0.5), 10, 400);
        item.size = size;
        drag.current = { size };
      }
    }
    markDirty();
  }

  async function commitDrag(drag) {
    const sel = state.selection;
    if (!drag || !sel) return;
    if (!drag.current) return;
    const ref = getRefForSelection(sel).child(sel.id);
    let updates = null;
    let undoData = null;
    if (drag.type === "connector") {
      updates = drag.current;
      undoData = { ax: drag.original.ax, ay: drag.original.ay, bx: drag.original.bx, by: drag.original.by };
    } else if (drag.type === "stroke") {
      const item = getItemBySelection(sel);
      updates = { points: item.points || [] };
      undoData = { points: (drag.original.points || []).map(pt => [pt[0], pt[1]]) };
    } else if (drag.mode === "move") {
      updates = { x: drag.current.x, y: drag.current.y };
      undoData = { x: drag.original.x, y: drag.original.y };
    } else if (drag.type === "image" || drag.type === "shape") {
      updates = { w: drag.current.w, h: drag.current.h };
      undoData = { w: drag.original.w, h: drag.original.h };
    } else if (drag.type === "note") {
      updates = { size: drag.current.size };
      undoData = { size: drag.original.size };
    }
    if (!updates) return;
    await ref.update(updates);
    recordAction({
      undo: () => ref.update(undoData),
      redo: () => ref.update(updates)
    });
  }

  function pickItem(point) {
    const stroke = findStrokeAt(point);
    if (stroke) {
      return { type: "stroke", item: stroke, mode: "move" };
    }
    const shape = findShapeAt(point);
    if (shape) return shape;
    const noteEntry = findNoteAt(point);
    if (noteEntry) return noteEntry;
    const image = findImageAt(point);
    if (image) return image;
    const connector = findConnectorAt(point);
    if (connector) return connector;
    return null;
  }

  function findShapeAt(p) {
    for (let i = state.items.shapes.length - 1; i >= 0; i--) {
      const shape = state.items.shapes[i];
      const bounds = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
      if (pointInRect(p, bounds)) {
        const nearCorner = nearBottomRight(p, bounds);
        return {
          type: "shape",
          item: shape,
          mode: nearCorner ? "scale" : "move"
        };
      }
    }
    return null;
  }

  function findImageAt(p) {
    for (let i = state.items.images.length - 1; i >= 0; i--) {
      const img = state.items.images[i];
      if (pointInRect(p, { x: img.x, y: img.y, w: img.w, h: img.h })) {
        const nearCorner = nearBottomRight(p, img);
        return {
          type: "image",
          item: img,
          mode: nearCorner ? "scale" : "move"
        };
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
    const ascent = metrics.actualBoundingBoxAscent || size;
    const descent = metrics.actualBoundingBoxDescent || size * 0.2;
    const height = ascent + descent;
    const padding = note.kind === "sticky" ? 16 : 6;
    return {
      width: Math.max(metrics.width + padding * 2, 16),
      height: Math.max(height + padding * 2, size + padding)
    };
  }

  function getNoteBounds(note) {
    const dims = measureNote(note);
    return { x: note.x, y: note.y, w: dims.width, h: dims.height };
  }

  function findNoteAt(p) {
    for (let i = state.items.notes.length - 1; i >= 0; i--) {
      const note = state.items.notes[i];
      const bounds = getNoteBounds(note);
      if (pointInRect(p, bounds)) {
        const nearCorner = nearBottomRight(p, bounds);
        return {
          type: "note",
          item: note,
          bounds,
          mode: nearCorner ? "scale" : "move"
        };
      }
    }
    return null;
  }

  function findConnectorAt(p) {
    for (let i = state.items.connectors.length - 1; i >= 0; i--) {
      const conn = state.items.connectors[i];
      const dist = distanceToSegment(p, { x: conn.ax, y: conn.ay }, { x: conn.bx, y: conn.by });
      const endA = Math.hypot(p.x - conn.ax, p.y - conn.ay);
      const endB = Math.hypot(p.x - conn.bx, p.y - conn.by);
      const tolerance = 18 / state.viewport.scale;
      if (endA < tolerance) {
        return { type: "connector", item: conn, mode: "endA" };
      }
      if (endB < tolerance) {
        return { type: "connector", item: conn, mode: "endB" };
      }
      if (dist < tolerance) {
        return { type: "connector", item: conn, mode: "move" };
      }
    }
    return null;
  }

  function nearConnectorEnd(p, conn) {
    const tolerance = 18 / state.viewport.scale;
    if (Math.hypot(p.x - conn.ax, p.y - conn.ay) < tolerance) return "A";
    if (Math.hypot(p.x - conn.bx, p.y - conn.by) < tolerance) return "B";
    return null;
  }

  function nearBottomRight(p, bounds) {
    const tolerance = 24 / state.viewport.scale;
    const cornerX = bounds.x + bounds.w;
    const cornerY = bounds.y + bounds.h;
    return Math.hypot(p.x - cornerX, p.y - cornerY) <= tolerance;
  }

  function pointInRect(p, rect) {
    return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
  }

  function distanceToSegment(p, a, b) {
    const l2 = Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2);
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    return Math.hypot(p.x - proj.x, p.y - proj.y);
  }

  function stripId(obj) {
    if (!obj) return null;
    const { id, ...rest } = obj;
    return JSON.parse(JSON.stringify(rest));
  }

  function findStrokeAt(p) {
    const tolerance = 24 / state.viewport.scale;
    for (let i = state.items.strokes.length - 1; i >= 0; i--) {
      const stroke = state.items.strokes[i];
      const pts = stroke.points || [];
      for (let j = 0; j < pts.length - 1; j++) {
        const a = { x: pts[j][0], y: pts[j][1] };
        const b = { x: pts[j+1][0], y: pts[j+1][1] };
        if (distanceToSegment(p, a, b) <= tolerance) {
          return stroke;
        }
      }
    }
    return null;
  }
  function resetBoardLocal() {
    state.items.strokes.length = 0;
    state.items.notes.length = 0;
    state.items.images.length = 0;
    state.items.shapes.length = 0;
    state.items.connectors.length = 0;
    cache.images.clear();
    state.drawing = false;
    state.draggingItem = null;
    state.path = [];
    history.length = 0;
    redoStack.length = 0;
    setSelection(null);
    markDirty();
  }

  async function requestSecureClear() {
    const pass = prompt("Enter password to clear the board for everyone:");
    if (pass === null) return;
    if (pass === "chatchoo123") {
      try {
        await Promise.all([
          refs.strokes.remove(),
          refs.notes.remove(),
          refs.images.remove(),
          refs.shapes.remove(),
          refs.connectors.remove()
        ]);
      } catch (err) {
        console.error("Failed to clear board:", err);
        alert("Failed to clear board. Check console for details.");
        return;
      }
      resetBoardLocal();
      alert("Board cleared for everyone.");
    } else {
      alert("Incorrect password.");
    }
  }

  function trackEraseClick() {
    const now = Date.now();
    eraseClicks = eraseClicks.filter(t => now - t <= SECRET_CLICK_WINDOW);
    eraseClicks.push(now);
    if (eraseClicks.length >= SECRET_CLICK_COUNT) {
      eraseClicks = [];
      requestSecureClear();
    }
  }

  function redraw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h);
    drawConnectors(ctx);
    drawShapes(ctx);
    drawImages(ctx);
    drawNotes(ctx);
    drawStrokes(ctx);
    drawDrawingPreview(ctx);
    drawSelectionOutline(ctx);
    ctx.restore();
  }

  function drawGrid(context, w, h) {
    const scale = state.viewport.scale;
    const spacing = GRID_BASE * scale;
    if (spacing < 16) return;
    const offsetX = (-state.viewport.offsetX * scale) % spacing;
    const offsetY = (-state.viewport.offsetY * scale) % spacing;
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = "rgba(148, 163, 184, 0.1)";
    context.beginPath();
    for (let x = offsetX; x < w; x += spacing) {
      context.moveTo(x, 0);
      context.lineTo(x, h);
    }
    for (let y = offsetY; y < h; y += spacing) {
      context.moveTo(0, y);
      context.lineTo(w, y);
    }
    context.stroke();
    context.restore();
  }

  function drawStrokes(context) {
    for (const s of state.items.strokes) {
      const pts = s.points;
      if (!pts || pts.length < 2) continue;
      context.save();
      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = s.color;
      context.lineWidth = (s.width || 1) * state.viewport.scale;
      context.globalAlpha = s.opacity != null ? s.opacity : 1;
      if (s.mode === "multiply") {
        context.globalCompositeOperation = "multiply";
      }
      context.beginPath();
      for (let i = 1; i < pts.length; i++) {
        const a = worldToScreen({ x: pts[i-1][0], y: pts[i-1][1] });
        const b = worldToScreen({ x: pts[i][0], y: pts[i][1] });
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
      }
      context.stroke();
      context.restore();
    }
    if (state.drawing && (state.tool === "draw" || state.tool === "highlighter") && state.path.length > 1) {
      context.save();
      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = state.stroke;
      context.lineWidth = state.width * state.viewport.scale;
      context.globalAlpha = state.opacity;
      context.beginPath();
      for (let i = 1; i < state.path.length; i++) {
        const a = worldToScreen(state.path[i-1]);
        const b = worldToScreen(state.path[i]);
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
      }
      context.stroke();
      context.restore();
    }
  }

  function drawNotes(context) {
    for (const note of state.items.notes) {
      const bounds = getNoteBounds(note);
      const screen = worldToScreen({ x: bounds.x, y: bounds.y });
      const scale = state.viewport.scale;
      const w = bounds.w * scale;
      const h = bounds.h * scale;
      context.save();
      context.globalAlpha = note.opacity != null ? note.opacity : 1;
      if (note.kind === "sticky") {
        const radius = 12 * scale;
        context.fillStyle = note.bg || "#fef08a";
        roundRect(context, screen.x, screen.y, w, h, radius);
        context.fill();
      }
      context.fillStyle = note.color || "#0f172a";
      context.font = ((note.size || 20) * scale) + "px \"Inter\", sans-serif";
      context.textBaseline = "top";
      const padding = note.kind === "sticky" ? 16 * scale : 6 * scale;
      wrapText(context, note.text || "", screen.x + padding, screen.y + padding, w - padding * 2, (note.size || 20) * scale * 1.4);
      context.restore();
    }
  }

  function drawShapes(context) {
    for (const shape of state.items.shapes) {
      const screen = worldToScreen({ x: shape.x, y: shape.y });
      const w = shape.w * state.viewport.scale;
      const h = shape.h * state.viewport.scale;
      context.save();
      context.globalAlpha = shape.opacity != null ? shape.opacity : 1;
      context.lineWidth = Math.max((shape.width || 1) * state.viewport.scale, 1);
      context.strokeStyle = shape.stroke || "#e5e7eb";
      context.fillStyle = shape.fill || "transparent";
      if (shape.type === "ellipse") {
        context.beginPath();
        context.ellipse(screen.x + w / 2, screen.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      } else {
        roundRect(context, screen.x, screen.y, w, h, 12 * state.viewport.scale);
        context.fill();
        context.stroke();
      }
      context.restore();
    }
    if (state.dragCreate) {
      const start = state.dragCreate.start;
      const current = state.dragCreate.current;
      const rect = {
        x: Math.min(start.x, current.x),
        y: Math.min(start.y, current.y),
        w: Math.max(8, Math.abs(current.x - start.x)),
        h: Math.max(8, Math.abs(current.y - start.y))
      };
      const screen = worldToScreen({ x: rect.x, y: rect.y });
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "rgba(96, 165, 250, 0.9)";
      ctx.lineWidth = 1.5;
      if (state.dragCreate.type === "ellipse") {
        ctx.beginPath();
        const w = rect.w * state.viewport.scale;
        const h = rect.h * state.viewport.scale;
        ctx.ellipse(screen.x + w / 2, screen.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const w = rect.w * state.viewport.scale;
        const h = rect.h * state.viewport.scale;
        roundRect(ctx, screen.x, screen.y, w, h, 12 * state.viewport.scale);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawImages(context) {
    for (const m of state.items.images) {
      let img = cache.images.get(m.id);
      if (!img) {
        img = new Image();
        img.onload = () => { markDirty(); };
        img.src = m.data;
        cache.images.set(m.id, img);
      }
      if (!img.complete) continue;
      const screen = worldToScreen({ x: m.x, y: m.y });
      context.save();
      context.drawImage(img, screen.x, screen.y, m.w * state.viewport.scale, m.h * state.viewport.scale);
      context.restore();
    }
  }

  function drawConnectors(context) {
    for (const conn of state.items.connectors) {
      const a = worldToScreen({ x: conn.ax, y: conn.ay });
      const b = worldToScreen({ x: conn.bx, y: conn.by });
      context.save();
      context.strokeStyle = conn.stroke || "#e5e7eb";
      context.lineWidth = Math.max((conn.width || 2) * state.viewport.scale, 1);
      context.lineCap = "round";
      context.globalAlpha = conn.opacity != null ? conn.opacity : 1;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      if (conn.arrow) {
        drawArrowHead(context, a, b);
      }
      context.restore();
    }
    if (state.connector) {
      const a = worldToScreen(state.connector.start);
      const b = worldToScreen(state.connector.current);
      ctx.save();
      ctx.setLineDash([10, 6]);
      ctx.strokeStyle = "rgba(96, 165, 250, 0.9)";
      ctx.lineWidth = Math.max(state.width * state.viewport.scale, 1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (state.connector.type === "arrow") {
        drawArrowHead(ctx, a, b);
      }
      ctx.restore();
    }
  }

  function drawArrowHead(context, a, b) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const size = Math.max(14 * state.viewport.scale, 6);
    context.beginPath();
    context.moveTo(b.x, b.y);
    context.lineTo(b.x - size * Math.cos(angle - Math.PI / 6), b.y - size * Math.sin(angle - Math.PI / 6));
    context.moveTo(b.x, b.y);
    context.lineTo(b.x - size * Math.cos(angle + Math.PI / 6), b.y - size * Math.sin(angle + Math.PI / 6));
    context.stroke();
  }

  function drawDrawingPreview(context) {
    if (state.tool === "line" || state.tool === "arrow" || state.tool === "rect" || state.tool === "ellipse") {
      return;
    }
    if (state.tool === "erase" && state.drawing && state.path.length > 0) {
      const screen = worldToScreen(state.path[0]);
      const size = 20 * state.viewport.scale;
      context.save();
      context.strokeStyle = "rgba(248, 113, 113, 0.7)";
      context.lineWidth = 1.5;
      context.setLineDash([4, 4]);
      context.strokeRect(screen.x - size / 2, screen.y - size / 2, size, size);
      context.restore();
    }
  }

  function drawSelectionOutline(context) {
    const sel = state.selection;
    if (!sel) return;
    const item = getItemBySelection(sel);
    if (!item) return;
    context.save();
    context.strokeStyle = "rgba(96, 165, 250, 0.9)";
    context.setLineDash([8, 6]);
    context.lineWidth = 1.5;
    const handles = [];
    if (sel.type === "note") {
      const bounds = getNoteBounds(item);
      const screen = worldToScreen({ x: bounds.x, y: bounds.y });
      const w = bounds.w * state.viewport.scale;
      const h = bounds.h * state.viewport.scale;
      context.strokeRect(screen.x, screen.y, w, h);
      handles.push({ x: screen.x + w, y: screen.y + h });
    } else if (sel.type === "shape" || sel.type === "image") {
      const screen = worldToScreen({ x: item.x, y: item.y });
      const w = item.w * state.viewport.scale;
      const h = item.h * state.viewport.scale;
      context.strokeRect(screen.x, screen.y, w, h);
      handles.push({ x: screen.x + w, y: screen.y + h });
    } else if (sel.type === "connector") {
      const a = worldToScreen({ x: item.ax, y: item.ay });
      const b = worldToScreen({ x: item.bx, y: item.by });
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      handles.push(a, b);
    } else if (sel.type === "stroke") {
      const pts = item.points || [];
      if (pts.length) {
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        const bounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys)
        };
        const screen = worldToScreen({ x: bounds.x, y: bounds.y });
        context.strokeRect(screen.x, screen.y, bounds.w * state.viewport.scale, bounds.h * state.viewport.scale);
      }
    }
    context.restore();

    if (handles.length) {
      context.save();
      context.fillStyle = "#60a5fa";
      handles.forEach(h => {
        context.beginPath();
        context.arc(h.x, h.y, 5, 0, Math.PI * 2);
        context.fill();
      });
      context.restore();
    }
  }
  function drawMinimap() {
    if (!miniCtx || !miniCanvas) return;
    const width = miniCanvas.clientWidth;
    const height = miniCanvas.clientHeight;
    miniCtx.save();
    miniCtx.clearRect(0, 0, width, height);
    miniCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
    miniCtx.fillRect(0, 0, width, height);
    const worldWidth = WORLD.maxX - WORLD.minX;
    const worldHeight = WORLD.maxY - WORLD.minY;
    const scaleX = width / worldWidth;
    const scaleY = height / worldHeight;
    function mapPoint(p) {
      return {
        x: (p.x - WORLD.minX) * scaleX,
        y: (p.y - WORLD.minY) * scaleY
      };
    }
    miniCtx.lineWidth = 1;
    miniCtx.strokeStyle = "rgba(96, 165, 250, 0.45)";
    state.items.shapes.forEach(shape => {
      const topLeft = mapPoint({ x: shape.x, y: shape.y });
      miniCtx.strokeRect(topLeft.x, topLeft.y, shape.w * scaleX, shape.h * scaleY);
    });
    state.items.notes.forEach(note => {
      const bounds = getNoteBounds(note);
      const topLeft = mapPoint({ x: bounds.x, y: bounds.y });
      miniCtx.strokeRect(topLeft.x, topLeft.y, bounds.w * scaleX, bounds.h * scaleY);
    });
    state.items.strokes.forEach(stroke => {
      const pts = stroke.points || [];
      if (pts.length < 2) return;
      miniCtx.beginPath();
      pts.forEach((pt, idx) => {
        const mapped = mapPoint({ x: pt[0], y: pt[1] });
        if (idx === 0) miniCtx.moveTo(mapped.x, mapped.y);
        else miniCtx.lineTo(mapped.x, mapped.y);
      });
      miniCtx.stroke();
    });
    state.items.connectors.forEach(conn => {
      const a = mapPoint({ x: conn.ax, y: conn.ay });
      const b = mapPoint({ x: conn.bx, y: conn.by });
      miniCtx.beginPath();
      miniCtx.moveTo(a.x, a.y);
      miniCtx.lineTo(b.x, b.y);
      miniCtx.stroke();
    });
    const viewW = canvas.clientWidth / state.viewport.scale;
    const viewH = canvas.clientHeight / state.viewport.scale;
    const viewRect = {
      x: (state.viewport.offsetX - WORLD.minX) * scaleX,
      y: (state.viewport.offsetY - WORLD.minY) * scaleY,
      w: viewW * scaleX,
      h: viewH * scaleY
    };
    miniCtx.strokeStyle = "rgba(34, 197, 94, 0.8)";
    miniCtx.strokeRect(viewRect.x, viewRect.y, viewRect.w, viewRect.h);
    miniCtx.restore();
  }

  function wrapText(context, text, x, y, maxWidth, lineHeight) {
    const words = text.split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line + word + " ";
      const metrics = context.measureText(test);
      if (metrics.width > maxWidth && line) {
        context.fillText(line, x, y);
        line = word + " ";
        y += lineHeight;
      } else {
        line = test;
      }
    }
    context.fillText(line.trimEnd(), x, y);
  }

  function roundRect(context, x, y, w, h, r) {
    const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + w - radius, y);
    context.quadraticCurveTo(x + w, y, x + w, y + radius);
    context.lineTo(x + w, y + h - radius);
    context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    context.lineTo(x + radius, y + h);
    context.quadraticCurveTo(x, y + h, x, y + h - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  }

  function chooseTextColor(bg) {
    if (!bg) return "#0f172a";
    const hex = bg.replace("#", "");
    const num = parseInt(hex, 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.6 ? "#0f172a" : "#f8fafc";
  }

  function simplify(points, eps) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let last = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i], n = points[i+1];
      const d = perpDist(last, n, p);
      if (d > eps) { out.push(p); last = p; }
    }
    out.push(points[points.length-1]);
    return out;
  }

  function quantize(points, q) {
    return points.map(p => ({ x: Math.round(p.x / q) * q, y: Math.round(p.y / q) * q }));
  }

  function perpDist(a, b, p) {
    const A = b.y - a.y, B = a.x - b.x, C = b.x*a.y - a.x*b.y;
    return Math.abs(A*p.x + B*p.y + C) / Math.hypot(A,B);
  }

  function toWire(points) {
    return points.map(p => [p.x|0, p.y|0]);
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

  function attachList(ref, key) {
    const arr = state.items[key];
    ref.on("child_added", snap => {
      const val = snap.val() || {};
      arr.push(Object.assign({ id: snap.key }, val));
      if (key === "images") cache.images.delete(snap.key);
      markDirty();
    });
    ref.on("child_removed", snap => {
      const i = arr.findIndex(x => x.id === snap.key);
      if (i >= 0) arr.splice(i, 1);
      cache.images.delete(snap.key);
      if (state.selection && state.selection.id === snap.key && state.selection.type + "s" === key) {
        setSelection(null);
      }
      markDirty();
    });
    ref.on("child_changed", snap => {
      const i = arr.findIndex(x => x.id === snap.key);
      if (i >= 0) { arr[i] = Object.assign({ id: snap.key }, snap.val()); }
      cache.images.delete(snap.key);
      markDirty();
    });
  }

  function attachPresence() {
    const myId = (crypto.randomUUID && crypto.randomUUID()) || (Math.random().toString(36).slice(2));
    connectedRef.on("value", snap => {
      if (!snap.val()) return;
      const me = refs.presence.child(myId);
      me.onDisconnect().remove();
      me.set({ t: firebase.database.ServerValue.TIMESTAMP });
    });
    refs.presence.on("value", snap => {
      const users = snap.val() || {};
      usersEl.textContent = "Users: " + Object.keys(users).length;
    });
  }

  // Start
  resize();
  attachList(refs.strokes, "strokes");
  attachList(refs.notes, "notes");
  attachList(refs.images, "images");
  attachList(refs.shapes, "shapes");
  attachList(refs.connectors, "connectors");
  attachPresence();
})();
