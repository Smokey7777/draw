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

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
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
    items: { strokes: [], notes: [], images: [] }
  };

  // UI
  const toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
  function setTool(t) {
    state.tool = t;
    toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === t));
    if (t === "image") document.getElementById("file").click();
  }
  toolButtons.forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  setTool("draw");

  document.getElementById("color").addEventListener("input", e => state.color = e.target.value);
  document.getElementById("width").addEventListener("input", e => state.width = +e.target.value);

  document.getElementById("clear").addEventListener("click", async () => {
    if (!confirm("Clear board for everyone?")) return;
    await strokesRef.remove();
    await notesRef.remove();
    await imagesRef.remove();
  });

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

  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId);
    const p = getXY(e);
    if (state.tool === "draw") {
      state.drawing = true;
      state.path = [p];
    } else if (state.tool === "text") {
      const text = prompt("Enter text:");
      if (!text) return;
      const note = { x:p.x|0, y:p.y|0, text, color:state.color, size:20 };
      notesRef.push(note);
    } else if (state.tool === "image") {
      state.lastClick = p;
    }
  });

  canvas.addEventListener("pointermove", e => {
    if (!state.drawing || state.tool !== "draw") return;
    const p = getXY(e);
    state.path.push(p);
    // local incremental draw
    const n = state.path.length;
    if (n >= 2) {
      const a = state.path[n-2], b = state.path[n-1];
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = state.color;
      ctx.lineWidth = state.width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  });

  canvas.addEventListener("pointerup", async e => {
    if (state.tool === "draw" && state.drawing) {
      state.drawing = false;
      if (state.path.length > 1) {
        const pts = toWire(simplify(quantize(state.path, 0.5), 1.2));
        const stroke = { color: state.color, width: state.width, points: pts };
        await strokesRef.push(stroke);
      }
      state.path = [];
    }
  });

  // File input + paste + drop for images
  const fileInput = document.getElementById("file");
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (f) await handleImageFile(f, state.lastClick);
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
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      await handleImageFile(f, p);
    }
  });

  async function handleImageFile(file, at) {
    const { dataURL, w, h } = await compressToDataURL(file, 1024);
    const img = { x: at.x|0, y: at.y|0, w, h, data: dataURL };
    await imagesRef.push(img);
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
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      const pts = s.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i-1], b = pts[i];
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    }
    // notes
    for (const n of state.items.notes) {
      ctx.fillStyle = n.color || "#e5e7eb";
      ctx.font = (n.size || 20) + "px sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(n.text, n.x, n.y);
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
      if (img.complete) ctx.drawImage(img, m.x, m.y, m.w, m.h);
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