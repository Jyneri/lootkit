/* ============================================================
   DEV JOURNAL — app logic
   Pages: Reference board · My assets · Quick links (+ left menu)
   Data lives in IndexedDB (browser database, much roomier than
   localStorage). Old localStorage data is copied over on first run.
   The board can also be saved as a file on the user's computer.
   ============================================================ */
(() => {
  const $  = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtMoney = (n) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const fmtDate = (iso) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const fmtTime = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v) => (Number.isFinite(v) ? v : undefined);

  // Accept "fab.com" or "https://fab.com/x"; return a safe http(s) URL or "".
  function normalizeUrl(raw) {
    const s = (raw || "").trim();
    if (!s) return "";
    try {
      const typedProtocol = /^https?:\/\//i.test(s);
      const u = new URL(typedProtocol ? s : "https://" + s);
      // "fab" alone is probably a typo, but http://localhost:5173 is a real address
      const hostOk = u.hostname.includes(".") || (typedProtocol && /^[a-z0-9-]+$/i.test(u.hostname)) || u.hostname === "localhost";
      return /^https?:$/.test(u.protocol) && hostOk ? u.href : "";
    } catch { return ""; }
  }
  const urlKey = (u) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  const nameKey = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  function download(text, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- storage (IndexedDB key-value) ---------------- */
  const DB = (() => {
    let dbp;
    const open = () => dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open("dev-journal", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
      const t = db.transaction("kv", mode);
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => res(req.result);
      t.onerror = t.onabort = () => rej(t.error);
    }));
    const prefix = (p) => IDBKeyRange.bound(p, p + "￿");
    return {
      get: (k) => run("readonly", s => s.get(k)),
      set: (k, v) => run("readwrite", s => s.put(v, k)),
      // several writes/deletes in one go: [[key, value], …] and [key, …]
      batch: (puts, dels = []) => run("readwrite", s => { puts.forEach(([k, v]) => s.put(v, k)); dels.forEach(k => s.delete(k)); return s.count(); }),
      // every [key, value] whose key starts with p
      getPrefix: (p) => open().then(db => new Promise((res, rej) => {
        const s = db.transaction("kv").objectStore("kv");
        const kq = s.getAllKeys(prefix(p)), vq = s.getAll(prefix(p));
        vq.onsuccess = () => res(kq.result.map((k, i) => [k, vq.result[i]]));
        vq.onerror = () => rej(vq.error);
      })),
    };
  })();

  const state = { boards: [], refs: [], assets: [], links: [] };
  let dbOk = true;

  // Pictures are big, so each one is stored once in its own slot ("img:<id>"), and the
  // board list ("refs") holds only the small details. Moving a picture then saves a few
  // kilobytes instead of every picture again.
  const storedImgs = new Set();
  function saveRefsStore() {
    const meta = state.refs.map(({ img, thumb, ...m }) => m);
    const fresh = state.refs.filter(r => r.img && !storedImgs.has(r.id));
    const live = new Set(state.refs.map(r => r.id));
    // pictures removed for good (not just waiting on Undo) are cleaned up at the next start
    return DB.batch([["refs", meta], ...fresh.map(r => ["img:" + r.id, { img: r.img, thumb: r.thumb }])])
      .then(() => fresh.forEach(r => live.has(r.id) && storedImgs.add(r.id)));
  }

  function save(key) {
    if (key === "refs") scheduleFileSave();
    if (key === "assets") shareOwned(); // keep the store-page "You own this" badges up to date
    // the folder backup runs even when the browser's own storage fails — that's when it matters most
    if (!dbOk) { scheduleBackup(); return Promise.resolve(); }
    return (key === "refs" ? saveRefsStore() : DB.set(key, state[key])).then(() => scheduleBackup(), () => {
      scheduleBackup();
      // shown just after any "Saved…" message, so the warning isn't hidden by it
      setTimeout(() => toast("Couldn't save in this browser — storage may be full. Your folder backup still runs if it's on."), 0);
    });
  }
  // for rapid changes (dragging): save once things settle
  let refsTimer;
  const saveRefsSoon = () => { clearTimeout(refsTimer); refsTimer = setTimeout(() => { refsTimer = 0; save("refs"); }, 350); };
  // leaving or hiding the page: save a just-finished drag right away
  const flushRefs = () => { if (refsTimer) { clearTimeout(refsTimer); refsTimer = 0; save("refs"); } };
  window.addEventListener("pagehide", flushRefs);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushRefs(); });

  // Quick-link groups, in the order they show on the page
  const LINK_GROUPS = [
    { name: "Asset stores", icon: "🛒", hosts: ["fab.com", "unity.com", "itch.io", "gumroad.com", "sketchfab.com", "cgtrader.com",
      "humblebundle.com", "turbosquid.com", "kitbash3d.com", "polyhaven.com", "quixel.com", "kenney.nl", "opengameart.org", "unrealengine.com"] },
    { name: "Inspiration", icon: "✨", hosts: ["artstation.com", "pinterest.com", "behance.net", "dribbble.com", "instagram.com", "are.na", "cosmos.so"] },
    { name: "Learn & watch", icon: "🎬", hosts: ["youtube.com", "vimeo.com", "udemy.com", "skillshare.com", "docs.unity3d.com", "dev.epicgames.com"] },
    { name: "My links", icon: "📌", hosts: [] },
  ];
  function guessGroup(url) {
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    const g = LINK_GROUPS.find(g => g.hosts.some(h => host === h || host.endsWith("." + h)));
    return g ? g.name : "My links";
  }

  const DEFAULT_LINKS = [
    ["Fab", "https://www.fab.com/"],
    ["Unity Asset Store", "https://assetstore.unity.com/"],
    ["itch.io assets", "https://itch.io/game-assets"],
    ["Gumroad", "https://gumroad.com/"],
    ["Sketchfab", "https://sketchfab.com/"],
    ["ArtStation", "https://www.artstation.com/"],
    ["Pinterest", "https://www.pinterest.com/"],
    ["YouTube", "https://www.youtube.com/"],
  ].map(([name, url]) => ({ id: uid(), name, url, group: guessGroup(url) }));

  function loadOld(k) {
    try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; }
  }

  /* ---------------- images ---------------- */
  function loadImg(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  // Shrink an image file to a JPEG data-URL so hundreds fit in storage.
  async function shrinkImage(file, maxW) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImg(url);
      const scale = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width  = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; // transparent PNGs get a white backing, not black
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.85);
    } finally { URL.revokeObjectURL(url); }
  }

  // Pull up to 5 main colors out of an image.
  async function extractPalette(dataUrl) {
    const img = await loadImg(dataUrl);
    const c = document.createElement("canvas");
    c.width = c.height = 48;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 48, 48);
    const px = ctx.getImageData(0, 0, 48, 48).data;
    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const key = (px[i] >> 4) << 8 | (px[i + 1] >> 4) << 4 | (px[i + 2] >> 4);
      const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++; b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2];
      buckets.set(key, b);
    }
    const picked = [];
    for (const b of [...buckets.values()].sort((x, y) => y.n - x.n)) {
      const rgb = [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round);
      if (picked.every(p => Math.hypot(p[0] - rgb[0], p[1] - rgb[1], p[2] - rgb[2]) > 48)) picked.push(rgb);
      if (picked.length === 5) break;
    }
    return picked.map(p => "#" + p.map(v => v.toString(16).padStart(2, "0")).join(""));
  }

  /* ---------------- toast (with optional undo) ---------------- */
  const toastEl = $("#toast"), toastMsg = $("#toast-msg"), toastUndo = $("#toast-undo");
  // Undos stack up while the toast is showing, so one click brings everything back.
  let toastTimer, undoStack = [];
  // `undo` is the button's action; `label` names it when it isn't an undo (e.g. "Find similar")
  function toast(msg, undo, label = "Undo") {
    clearTimeout(toastTimer);
    toastUndo.textContent = label;
    // only deletes stack up; any other message starts fresh
    const stacks = undo && msg.startsWith("Removed") && undoStack.stacking;
    if (!stacks) undoStack = [];
    if (undo) { undoStack.push(undo); undoStack.stacking = msg.startsWith("Removed"); }
    toastMsg.textContent = undoStack.length > 1 && msg.startsWith("Removed")
      ? `${msg} (${undoStack.length} removed)` : msg;
    toastUndo.hidden = !undoStack.length;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; undoStack = []; }, undo ? 7000 : 3000);
  }
  toastUndo.addEventListener("click", () => {
    while (undoStack.length) undoStack.pop()();
    toastEl.hidden = true;
  });

  // Remove an item from a list, with a 7-second undo.
  function removeWithUndo(key, id, label, after) {
    const list = state[key];
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    const [item] = list.splice(i, 1);
    save(key); after();
    toast(`Removed ${label}`, () => {
      state[key].splice(Math.min(i, state[key].length), 0, item);
      save(key); after();
    });
  }

  /* ================= LEFT MENU + PAGES ================= */
  const VIEWS = { board: "Reference Board", assets: "My Assets", links: "Quick Links" };
  const isNarrow = () => matchMedia("(max-width: 899px)").matches;
  let currentView = "board";

  function setMenu(open, remember = true) {
    document.body.classList.toggle("menu-open", open);
    $("#menu-btn").setAttribute("aria-expanded", open);
    if (remember && !isNarrow()) { try { localStorage.setItem("dj_menu", open ? "1" : "0"); } catch {} }
    // the board gets wider/narrower once the menu finishes sliding
    setTimeout(sizeBoard, 420);
  }
  $("#menu-btn").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  $("#scrim").addEventListener("click", () => setMenu(false));
  // shrinking to phone size closes the menu so it doesn't cover the page
  matchMedia("(max-width: 899px)").addEventListener("change", (e) => { if (e.matches) setMenu(false, false); });
  // on phones, any link in the menu closes it (even the page you're already on)
  $("#side").addEventListener("click", (e) => { if (e.target.closest("a") && isNarrow()) setMenu(false, false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isNarrow() && document.body.classList.contains("menu-open")) setMenu(false);
  });

  function route() {
    let v = location.hash.slice(1);
    if (v === "refs") v = "board"; // old link name
    if (!(v in VIEWS)) v = "board";
    currentView = v;
    $$(".view").forEach(s => s.hidden = s.dataset.view !== v);
    $$(".side-nav a").forEach(a => a.classList.toggle("active", a.dataset.view === v));
    $("#page-title").textContent = VIEWS[v];
    document.title = `${VIEWS[v]} — Lootkit`;
    window.scrollTo({ top: 0, behavior: "instant" });
    if (isNarrow()) setMenu(false, false);
    if (v === "board") requestAnimationFrame(sizeBoard);
    if (v === "links") renderLinks(true); // tiles ripple in each time you open the page
  }
  window.addEventListener("hashchange", route);

  /* ================= REFERENCE BOARDS ================= */
  // Many boards. Each picture or sticky note belongs to one board (boardId).
  // The board can be zoomed: the cork is scaled, and a "sizer" box around it
  // gives the scroll area the zoomed size.
  const wrap = $("#board-wrap"), sizer = $("#board-sizer"), board = $("#ref-board");
  const PAD = 40, GAP = 34, PIN_W = 280, NOTE_W = 220;
  const NOTE_COLORS = ["#ffe58a", "#ffc9d6", "#c3e4ff", "#cdeeb4", "#f3d9b1"];
  let topZ = 1, zoom = 1, curBoard = null;
  const zoomByBoard = {};

  const boardById = (id) => state.boards.find(b => b.id === id);
  const boardRefs = (id = curBoard) => state.refs.filter(r => r.boardId === id);
  const refById = (id) => state.refs.find(r => r.id === id);
  const isNote = (r) => r.kind === "note";
  const imgLook = (r) => [r.flip ? "is-flipped" : "", r.gray ? "is-gray" : ""].join(" ").trim();
  // quick lookups, so a full board doesn't get slower with every picture
  const pinMap = new Map();          // id → its element on the board
  const heightCache = new WeakMap(); // item → { w, key, h } as last measured
  const pinEl = (id) => pinMap.get(id);

  function pinHeight(r) {
    const key = isNote(r) ? r.text : r.caption; // what changes an item's height besides its width
    const c = heightCache.get(r);
    if (c && c.w === r.w && c.key === key) return c.h;
    const el = pinEl(r.id);
    if (el && Math.abs(el.offsetWidth - r.w) < 2) { // measure when we can, then remember it
      const h = el.offsetHeight;
      if (h) heightCache.set(r, { w: r.w, key, h });
      return h || 0;
    }
    if (isNote(r)) return Math.max(130, 70 + Math.ceil((r.text || "").length * 8.5 / Math.max(80, r.w - 40)) * 24);
    return r.w * (r.ar || 0.75) + 22 + (r.caption ? 34 : 0);
  }
  // the board shows a small copy; a picture made big on the board gets the full one
  const BIG_PIN = 420;
  const pinSrc = (r) => (r.w > BIG_PIN || !r.thumb ? r.img : r.thumb);
  async function makeThumb(dataUrl) {
    const img = await loadImg(dataUrl);
    const scale = Math.min(1, 560 / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  }
  const applyPos = (el, r) => {
    el.style.setProperty("--x", r.x + "px");
    el.style.setProperty("--y", r.y + "px");
    el.style.setProperty("--w", r.w + "px");
    el.style.zIndex = r.z || 1;
  };
  const toBoard = (cx, cy) => { const b = board.getBoundingClientRect(); return { x: (cx - b.left) / zoom, y: (cy - b.top) / zoom }; };
  const viewCenter = () => ({ x: (wrap.scrollLeft + wrap.clientWidth / 2) / zoom, y: (wrap.scrollTop + wrap.clientHeight / 2) / zoom });

  function pinHTML(r, i) {
    const tools = `<button class="del" type="button" title="Remove" data-id="${esc(r.id)}">✕</button>
      <span class="grip" title="Drag to resize"></span>`;
    if (isNote(r)) {
      const color = NOTE_COLORS.includes(r.color) ? r.color : NOTE_COLORS[0];
      return `
      <figure class="ref-pin is-note" data-id="${esc(r.id)}" style="--i:${i}">
        <div class="ref-card note-card" style="--tilt:${num(r.tilt) ?? 0}deg;--note:${color}">
          <span class="pin"></span>
          <div class="note-text" data-placeholder="Write something…">${esc(r.text)}</div>
          <button class="note-color" type="button" title="Change color" data-id="${esc(r.id)}"></button>
          ${tools}
        </div>
      </figure>`;
    }
    return `
      <figure class="ref-pin" data-id="${esc(r.id)}" style="--i:${i}">
        <div class="ref-card" style="--tilt:${num(r.tilt) ?? 0}deg">
          <span class="pin"></span>
          <img src="${esc(pinSrc(r))}" alt="${esc(r.caption)}" draggable="false" decoding="async" class="${imgLook(r)}">
          ${r.caption ? `<figcaption>${esc(r.caption)}</figcaption>` : ""}
          ${tools}
        </div>
      </figure>`;
  }

  function renderRefs(fresh = false) {
    $$(".ref-pin", board).forEach(el => el.remove());
    pinMap.clear();
    const list = boardRefs();
    board.classList.toggle("fresh", fresh); // pins fade in one by one when you switch boards
    board.insertAdjacentHTML("beforeend", list.map(pinHTML).join(""));
    $$(".ref-pin", board).forEach((el, i) => { pinMap.set(list[i].id, el); applyPos(el, list[i]); });
    $("#ref-empty").hidden = list.length > 0;
    if (fresh) setTimeout(() => board.classList.remove("fresh"), 900);
    sizeBoard();
    renderBoardTabs();
    applySearch();
  }
  // add just the new items to the board (no redraw of everything already there)
  function addPins(list) {
    const start = pinMap.size;
    board.insertAdjacentHTML("beforeend", list.map((r, i) => pinHTML(r, start + i)).join(""));
    const els = $$(".ref-pin", board).slice(-list.length);
    els.forEach((el, i) => { pinMap.set(list[i].id, el); applyPos(el, list[i]); el.classList.add("pop"); });
    $("#ref-empty").hidden = true;
    sizeBoard();
    renderBoardTabs();
    applySearch();
  }

  // The cork always fills the screen and grows past the furthest item.
  function sizeBoard() {
    let right = 0, bottom = 0;
    boardRefs().forEach(r => {
      right = Math.max(right, r.x + r.w);
      bottom = Math.max(bottom, r.y + pinHeight(r));
    });
    const W = Math.max(right + 120, Math.floor((wrap.clientWidth || 0) / zoom));
    const H = Math.max(bottom + 120, Math.floor((wrap.clientHeight || 0) / zoom));
    board.style.width = W + "px";
    board.style.height = H + "px";
    board.style.setProperty("--zoom", zoom);
    sizer.style.width = Math.floor(W * zoom) + "px";
    sizer.style.height = Math.floor(H * zoom) + "px";
  }

  // Lay things out in neat columns (shortest column first).
  function flowPlace(list, startY = PAD) {
    const width = (wrap.clientWidth || 1000) / zoom;
    const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (PIN_W + GAP)));
    const hs = Array(cols).fill(startY);
    list.forEach(r => {
      const c = hs.indexOf(Math.min(...hs));
      r.w = isNote(r) ? NOTE_W : PIN_W;
      r.x = PAD + c * (PIN_W + GAP);
      r.y = hs[c];
      hs[c] += pinHeight(r) + GAP;
    });
  }
  const lowestEdge = (list) => list.reduce((m, r) => Math.max(m, r.y + pinHeight(r) + GAP), PAD);
  const placedOk = (r) => num(r.x) !== undefined && num(r.y) !== undefined && num(r.w);

  // give older pins (and imported ones) a shape, tilt and spot on their board
  async function preparePins() {
    let changed = false;
    for (const [i, r] of state.refs.entries()) {
      if (!isNote(r) && !Array.isArray(r.palette)) { // needed for search by color
        try { r.palette = await extractPalette(r.img); } catch { r.palette = []; }
        changed = true;
      }
      if (!isNote(r) && !num(r.ar)) {
        try { const im = await loadImg(r.img); r.ar = im.naturalHeight / im.naturalWidth; } catch { r.ar = 0.75; }
        changed = true;
      }
      if (!isNote(r) && !r.thumb) { // small copy for the board (older pictures don't have one yet)
        try { r.thumb = await makeThumb(r.img); storedImgs.delete(r.id); changed = true; } catch {}
      }
      if (num(r.tilt) === undefined) { r.tilt = ((i * 37) % 13) - 6; changed = true; }
      topZ = Math.max(topZ, r.z || 1);
    }
    for (const b of state.boards) {
      const mine = boardRefs(b.id);
      const loose = mine.filter(r => !placedOk(r));
      if (loose.length) { flowPlace(loose, lowestEdge(mine.filter(placedOk))); changed = true; }
    }
    if (changed) save("refs");
  }

  // pick a spot: where you dropped it, else the middle of what you see, else under everything
  function placeNew(r, at, n) {
    const h = pinHeight(r);
    if (at) { r.x = at.x - r.w / 2 + n * 30; r.y = at.y - h / 2 + n * 30; }
    else if (wrap.clientWidth) { const c = viewCenter(); r.x = c.x - r.w / 2 + n * 30; r.y = c.y - h / 2 + n * 30; }
    else { r.x = PAD; r.y = lowestEdge(boardRefs()) + n * 30; }
    r.x = Math.max(0, r.x); r.y = Math.max(0, r.y);
    // don't land exactly on top of something else
    while (boardRefs().some(o => Math.abs(o.x - r.x) < 12 && Math.abs(o.y - r.y) < 12)) { r.x += 32; r.y += 32; }
  }

  async function addRefs(files, at) {
    const imgs = [...files].filter(f => f && f.type.startsWith("image/"));
    if (!imgs.length) return;
    let n = 0;
    const added = [];
    for (const f of imgs) {
      try {
        const img = await shrinkImage(f, 1600);
        const im = await loadImg(img);
        const caption = /^image\.\w+$/i.test(f.name) ? "" : f.name.replace(/\.[^.]+$/, "").slice(0, 40);
        const r = { id: uid(), boardId: curBoard, img, thumb: await makeThumb(img), caption, tags: [],
          ar: im.naturalHeight / im.naturalWidth, w: PIN_W,
          tilt: ((state.refs.length * 37) % 13) - 6, z: ++topZ,
          palette: await extractPalette(img), date: new Date().toISOString() };
        placeNew(r, at, n);
        state.refs.push(r);
        added.push(r);
        n++;
      } catch { toast(`Couldn't read ${f.name}`); }
    }
    await save("refs");
    const here = added.filter(r => r.boardId === curBoard); // you may have switched boards meanwhile
    if (here.length) addPins(here); else renderBoardTabs();
    const where = currentView === "board" ? "" : " — see Reference Board";
    const name = boardById(curBoard)?.name || "your board";
    if (n) toast((n === 1 ? `Pinned to “${name}”` : `Pinned ${n} pictures to “${name}”`) + where);
  }

  /* ---------- sticky notes ---------- */
  function addNote() {
    const r = { id: uid(), boardId: curBoard, kind: "note", text: "", w: NOTE_W,
      color: NOTE_COLORS[boardRefs().filter(isNote).length % NOTE_COLORS.length],
      tilt: ((state.refs.length * 37) % 9) - 4, z: ++topZ, date: new Date().toISOString() };
    placeNew(r, null, 0);
    state.refs.push(r);
    save("refs");
    addPins([r]);
    editNote(r.id);
  }
  function editNote(id) {
    const t = pinEl(id)?.querySelector(".note-text");
    if (!t) return;
    t.contentEditable = "plaintext-only";
    if (t.contentEditable !== "plaintext-only") t.contentEditable = "true";
    t.closest(".ref-pin").classList.add("editing");
    t.focus();
    const sel = getSelection(); sel.selectAllChildren(t); sel.collapseToEnd();
  }
  board.addEventListener("focusout", (e) => {
    const t = e.target.closest?.(".note-text");
    if (!t) return;
    t.contentEditable = "false";
    const el = t.closest(".ref-pin");
    el.classList.remove("editing");
    const r = refById(el.dataset.id);
    if (!r) return;
    const text = t.innerText.replace(/ /g, " ").trim().slice(0, 2000);
    if (!text) { // a note left empty just goes away
      state.refs = state.refs.filter(x => x !== r);
      el.remove(); // just this one, so a drag you're starting on another pin isn't disturbed
      pinMap.delete(r.id);
      $("#ref-empty").hidden = boardRefs().length > 0;
      save("refs"); sizeBoard(); renderBoardTabs();
      return;
    }
    r.text = text;
    save("refs"); sizeBoard(); applySearch();
  });
  board.addEventListener("keydown", (e) => {
    if (e.target.classList?.contains("note-text") && e.key === "Escape") e.target.blur();
  });
  // pressing the color dot must not pull focus out of the note (an empty note would vanish)
  board.addEventListener("mousedown", (e) => { if (e.target.closest(".note-color")) e.preventDefault(); });
  // save while typing too, so nothing is lost if you close the page mid-note
  board.addEventListener("input", (e) => {
    const t = e.target.closest?.(".note-text");
    const r = t && refById(t.closest(".ref-pin").dataset.id);
    if (!r) return;
    r.text = t.innerText.replace(/ /g, " ").trim().slice(0, 2000);
    saveRefsSoon();
  });
  $("#note-add").addEventListener("click", addNote);

  /* ---------- drag to move, corner to resize, click to view/edit, empty space to pan ---------- */
  board.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".del, .note-color")) return;
    if (e.target.isContentEditable) return; // typing in a note
    const typing = document.activeElement;
    if (typing?.classList?.contains("note-text")) typing.blur();
    const el = e.target.closest(".ref-pin");
    if (!el) { if (e.pointerType === "mouse") startPan(e); return; }
    const r = refById(el.dataset.id);
    if (!r) return;
    e.preventDefault();
    const mode = e.target.closest(".grip") ? "resize" : "move";
    el.setPointerCapture(e.pointerId);
    if ((r.z || 0) < topZ) r.z = ++topZ; // bring to front
    el.style.zIndex = r.z;
    const s = { px: e.clientX, py: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, x: r.x, y: r.y, w: r.w, moved: false };
    let frame = 0;

    const move = (ev) => {
      const dx = (ev.clientX - s.px + wrap.scrollLeft - s.sl) / zoom;
      const dy = (ev.clientY - s.py + wrap.scrollTop - s.st) / zoom;
      if (!s.moved && Math.hypot(dx * zoom, dy * zoom) < 5) return;
      if (!s.moved) { s.moved = true; el.classList.add("dragging"); }
      if (mode === "move") { r.x = Math.max(0, s.x + dx); r.y = Math.max(0, s.y + dy); }
      else r.w = clamp(s.w + dx, isNote(r) ? 140 : 120, 1000);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; applyPos(el, r); sizeBoard(); });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      cancelAnimationFrame(frame);
      el.classList.remove("dragging");
      applyPos(el, r);
      sizeBoard();
      saveRefsSoon();
      if (mode === "resize" && !isNote(r)) { // made big: show the full picture; made small: the light copy
        const img = el.querySelector("img"), want = pinSrc(r);
        if (img && img.getAttribute("src") !== want) img.src = want;
      }
      if (!s.moved && mode === "move") isNote(r) ? editNote(r.id) : openViewer(r.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });

  function startPan(e) {
    e.preventDefault();
    const s = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
    board.setPointerCapture(e.pointerId);
    wrap.classList.add("panning");
    const move = (ev) => wrap.scrollTo({ left: s.l - (ev.clientX - s.x), top: s.t - (ev.clientY - s.y), behavior: "instant" });
    const up = () => {
      board.removeEventListener("pointermove", move);
      board.removeEventListener("pointerup", up);
      board.removeEventListener("pointercancel", up);
      wrap.classList.remove("panning");
    };
    board.addEventListener("pointermove", move);
    board.addEventListener("pointerup", up);
    board.addEventListener("pointercancel", up);
  }

  board.addEventListener("click", (e) => {
    const del = e.target.closest(".del");
    if (del) {
      const r = refById(del.dataset.id);
      removeWithUndo("refs", del.dataset.id, r && isNote(r) ? "note" : "picture", () => renderRefs());
      return;
    }
    const dot = e.target.closest(".note-color");
    if (dot) {
      const r = refById(dot.dataset.id);
      if (!r) return;
      r.color = NOTE_COLORS[(NOTE_COLORS.indexOf(r.color) + 1) % NOTE_COLORS.length];
      dot.closest(".note-card").style.setProperty("--note", r.color);
      save("refs");
    }
  });

  const refInput = $("#ref-input");
  $("#ref-add").addEventListener("click", () => refInput.click());
  refInput.addEventListener("change", () => { addRefs(refInput.files).then(() => refInput.value = ""); });

  // Tidy up: slide everything on this board into neat columns (with undo).
  $("#board-tidy").addEventListener("click", () => {
    const list = boardRefs();
    if (!list.length) return;
    const before = list.map(r => ({ r, x: r.x, y: r.y, w: r.w }));
    const animate = () => {
      board.classList.add("animating");
      $$(".ref-pin", board).forEach(el => { const r = refById(el.dataset.id); if (r) applyPos(el, r); });
      sizeBoard();
      setTimeout(() => board.classList.remove("animating"), 650);
    };
    flowPlace(list);
    wrap.scrollTo({ top: 0, left: 0 });
    animate();
    save("refs");
    toast("Board tidied", () => {
      before.forEach(b => Object.assign(b.r, { x: b.x, y: b.y, w: b.w }));
      animate();
      save("refs");
    });
  });

  /* ---------- zoom ---------- */
  const zoomLabel = $("#zoom-level");
  function showZoom() { zoomLabel.textContent = Math.round(zoom * 100) + "%"; }
  // zoom around a point (cx, cy measured from the board window's top-left)
  function setZoom(z, cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2) {
    z = clamp(Math.round(z * 100) / 100, 0.2, 2.5);
    const bx = (wrap.scrollLeft + cx) / zoom, by = (wrap.scrollTop + cy) / zoom;
    zoom = z; zoomByBoard[curBoard] = z;
    sizeBoard();
    wrap.scrollTo({ left: bx * z - cx, top: by * z - cy, behavior: "instant" });
    showZoom();
  }
  function fitBoard() {
    const list = boardRefs();
    if (!list.length || !wrap.clientWidth) { setZoom(1); return; }
    const l = Math.min(...list.map(r => r.x)), t = Math.min(...list.map(r => r.y));
    const rr = Math.max(...list.map(r => r.x + r.w)), b = Math.max(...list.map(r => r.y + pinHeight(r)));
    zoom = clamp(Math.round(Math.min((wrap.clientWidth - 60) / (rr - l), (wrap.clientHeight - 60) / (b - t), 1.5) * 100) / 100, 0.2, 2.5);
    zoomByBoard[curBoard] = zoom;
    sizeBoard();
    wrap.scrollTo({ left: l * zoom - 30, top: t * zoom - 30, behavior: "instant" });
    showZoom();
  }
  $("#zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  $("#zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
  zoomLabel.addEventListener("click", () => setZoom(1));
  $("#zoom-fit").addEventListener("click", fitBoard);
  // Ctrl + mouse wheel (or trackpad pinch) zooms where the pointer is
  wrap.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect(); // minus the wooden frame, so the spot under the pointer stays put
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left - wrap.clientLeft, e.clientY - rect.top - wrap.clientTop);
  }, { passive: false });

  /* ---------- board tabs: switch, new, rename, delete ---------- */
  const tabsEl = $("#board-tabs"), sideBoards = $("#side-boards");

  function renderBoardTabs() {
    tabsEl.innerHTML = state.boards.map(b => {
      const active = b.id === curBoard;
      return `<button class="board-tab${active ? " active" : ""}" type="button" role="tab" aria-selected="${active}"
          data-board="${esc(b.id)}" title="${active ? "Double-click to rename" : "Open this board"}">
          <span class="tab-name">${esc(b.name)}</span><span class="tab-count">${boardRefs(b.id).length}</span>
          ${active && state.boards.length > 1 ? `<span class="tab-del" data-del-board="${esc(b.id)}" title="Delete this board">✕</span>` : ""}
        </button>`;
    }).join("") + `<button class="board-tab add" id="board-new" type="button">+ New board</button>`;
    sideBoards.innerHTML = state.boards.map(b =>
      `<a href="#board" data-board="${esc(b.id)}" class="${b.id === curBoard ? "active" : ""}">${esc(b.name)}</a>`).join("");
  }

  tabsEl.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-board]");
    if (del) { deleteBoard(del.dataset.delBoard); return; }
    if (e.target.closest("#board-new")) { newBoard(); return; }
    const t = e.target.closest("[data-board]");
    if (t && t.dataset.board !== curBoard) switchBoard(t.dataset.board);
  });
  tabsEl.addEventListener("dblclick", (e) => {
    const t = e.target.closest("[data-board]");
    if (t && t.dataset.board === curBoard) renameBoard(t.dataset.board);
  });
  sideBoards.addEventListener("click", (e) => {
    const a = e.target.closest("[data-board]");
    if (a && a.dataset.board !== curBoard) switchBoard(a.dataset.board);
  });

  async function switchBoard(id) {
    if (!boardById(id)) return;
    flushRefs();            // a drag that just ended is saved…
    await flushFileSave();  // …and written to this board's file before we leave it
    zoomByBoard[curBoard] = zoom;
    curBoard = id;
    try { localStorage.setItem("dj_board", id); } catch {}
    zoom = zoomByBoard[id] || 1;
    showZoom();
    await loadBoardFile(id);
    renderRefs(true);
    wrap.scrollTo({ left: 0, top: 0, behavior: "instant" });
  }

  function renameBoard(id) {
    const b = boardById(id);
    const label = tabsEl.querySelector(`[data-board="${CSS.escape(id)}"] .tab-name`);
    if (!b || !label) return;
    label.contentEditable = "plaintext-only";
    if (label.contentEditable !== "plaintext-only") label.contentEditable = "true";
    label.focus();
    getSelection().selectAllChildren(label);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const name = label.innerText.replace(/\s+/g, " ").trim().slice(0, 40);
      if (keep && name && name !== b.name) {
        b.name = name;
        save("boards");
        if (id === curBoard) scheduleFileSave(); // the file stores the board's name too
      }
      renderBoardTabs();
    };
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") finish(false);
    });
    label.addEventListener("blur", () => finish(true), { once: true });
  }

  async function newBoard() {
    const b = { id: uid(), name: "New board" };
    state.boards.push(b);
    await save("boards");
    await switchBoard(b.id);
    renameBoard(b.id);
  }

  async function deleteBoard(id) {
    if (state.boards.length < 2) return;
    const bi = state.boards.findIndex(b => b.id === id);
    const b = state.boards[bi];
    // move away first, so this board's file is never written empty
    await switchBoard(state.boards[bi > 0 ? bi - 1 : 1].id);
    const refs = state.refs.filter(r => r.boardId === id);
    state.boards.splice(bi, 1);
    state.refs = state.refs.filter(r => r.boardId !== id);
    save("boards"); save("refs");
    renderBoardTabs();
    toast(`Removed board “${b.name}”`, async () => {
      state.boards.splice(Math.min(bi, state.boards.length), 0, b);
      state.refs.push(...refs);
      save("boards"); save("refs");
      await switchBoard(b.id);
    });
  }

  /* ---------- search across all boards ---------- */
  const bSearch = $("#board-search"), bHits = $("#board-hits");
  const refHay = (r) => [r.caption, r.text, ...(r.tags || [])].join(" ").toLowerCase();
  const isHex = (t) => /^#[0-9a-f]{6}$/.test(t);
  // how different two colors look (a quick "red-mean" formula that roughly follows the eye)
  function colorDistance(a, b) {
    const p = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b), rm = (r1 + r2) / 2;
    return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
  }
  const hasColor = (r, hex) => !isNote(r) && (r.palette || []).some(p => typeof p === "string" && isHex(p.toLowerCase()) && colorDistance(p.toLowerCase(), hex) < 110);

  function applySearch() {
    const terms = bSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
    board.classList.toggle("searching", terms.length > 0);
    if (!terms.length) { bHits.innerHTML = ""; $$(".ref-pin.hit", board).forEach(el => el.classList.remove("hit")); return; }
    const colors = terms.filter(isHex), words = terms.filter(t => !isHex(t));
    const hit = (r) => words.every(t => refHay(r).includes(t)) && colors.every(c => hasColor(r, c));
    $$(".ref-pin", board).forEach(el => { const r = refById(el.dataset.id); el.classList.toggle("hit", !!r && hit(r)); });
    const here = boardRefs().filter(hit).length;
    const others = state.boards.filter(b => b.id !== curBoard)
      .map(b => [b, boardRefs(b.id).filter(hit).length]).filter(([, n]) => n);
    bHits.innerHTML = `<span class="hit-here">${here} here</span>` + others.map(([b, n]) =>
      `<button type="button" class="hit-chip" data-board="${esc(b.id)}">${n} in ${esc(b.name)} →</button>`).join("");
  }
  bSearch.addEventListener("input", applySearch);
  // search by color: put the color in the search box (replacing any earlier color)
  function searchColor(hex) {
    const words = bSearch.value.split(/\s+/).filter(t => t && !isHex(t.toLowerCase()));
    bSearch.value = [...words, hex.toLowerCase()].join(" ");
    applySearch();
  }
  $("#board-color").addEventListener("input", (e) => searchColor(e.target.value));
  bHits.addEventListener("click", (e) => {
    const c = e.target.closest("[data-board]");
    if (c) switchBoard(c.dataset.board);
  });

  /* ---------- save a board as a file on your computer ---------- */
  const canPickFiles = "showSaveFilePicker" in window;
  const fileStatus = $("#file-status");
  const fileKey = (id) => "boardFile:" + id;
  let fileHandle = null, fileLive = false, fileTimer = 0;

  function setFileStatus(text, ok) {
    fileStatus.textContent = text;
    fileStatus.classList.toggle("ok", !!ok);
  }
  const boardFileText = () => JSON.stringify({
    app: "dev-journal", kind: "board", version: 2, name: boardById(curBoard)?.name || "Board",
    saved: new Date().toISOString(), refs: boardRefs().map(({ thumb, ...r }) => r) });
  const safeFileName = () => (boardById(curBoard)?.name || "reference-board").replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "reference-board";

  async function writeBoardFile() {
    const w = await fileHandle.createWritable();
    await w.write(boardFileText());
    await w.close();
  }

  // After the first save, every change to this board is written to the same file automatically.
  function scheduleFileSave() {
    if (!fileHandle || !fileLive) return;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(async () => {
      fileTimer = 0;
      try { await writeBoardFile(); setFileStatus(`Auto-saved to ${fileHandle.name} · ${fmtTime()}`, true); }
      catch { fileLive = false; setFileStatus(`Click Save to keep ${fileHandle.name} updated`); }
    }, 1200);
  }
  async function flushFileSave() {
    if (fileTimer && fileHandle && fileLive) {
      clearTimeout(fileTimer); fileTimer = 0;
      await writeBoardFile().catch(() => {});
    }
  }
  // each board remembers its own file
  async function loadBoardFile(id) {
    fileHandle = null; fileLive = false; setFileStatus("");
    const h = await DB.get(fileKey(id)).catch(() => undefined);
    if (!h) return;
    fileHandle = h;
    const perm = await h.queryPermission?.({ mode: "readwrite" }).catch(() => "denied");
    fileLive = perm === "granted";
    setFileStatus(fileLive ? `Saving to ${h.name}` : `Click Save to keep ${h.name} updated`, fileLive);
  }
  function linkFile(handle) {
    fileHandle = handle;
    fileLive = true;
    DB.set(fileKey(curBoard), handle).catch(() => {});
  }

  $("#board-save").addEventListener("click", async () => {
    if (!canPickFiles) { // browsers without file access (Firefox, Safari): download a copy
      download(boardFileText(), safeFileName() + ".json");
      setFileStatus(`Downloaded ${safeFileName()}.json`, true);
      return;
    }
    try {
      let handle = fileHandle;
      if (handle && (await handle.queryPermission({ mode: "readwrite" })) !== "granted"
                 && (await handle.requestPermission({ mode: "readwrite" })) !== "granted") handle = null;
      if (!handle) handle = await showSaveFilePicker({
        suggestedName: safeFileName() + ".json",
        types: [{ description: "Reference board", accept: { "application/json": [".json"] } }],
      });
      linkFile(handle);
      await writeBoardFile();
      setFileStatus(`Saved to ${handle.name} · ${fmtTime()} — changes now save there too`, true);
    } catch (err) {
      if (err?.name !== "AbortError") toast("Couldn't save the file");
    }
  });

  // Opening a board file adds it as a NEW board (nothing you have is replaced).
  async function openBoardText(text, handle, fileName = "") {
    let data;
    try { data = JSON.parse(text); } catch { toast("That file isn't a board file"); return; }
    if (!Array.isArray(data?.refs)) { toast("That file isn't a board file"); return; }
    const refs = sanitize("refs", data.refs);
    const skipped = data.refs.length - refs.length;
    const prev = curBoard;
    const name = String(data.name || fileName.replace(/\.json$/i, "") || "Opened board").trim().slice(0, 40) || "Opened board";
    const b = { id: uid(), name };
    refs.forEach(r => { r.id = uid(); r.boardId = b.id; });
    state.boards.push(b);
    state.refs.push(...refs);
    await save("boards");
    await switchBoard(b.id);
    await preparePins();
    await save("refs"); // the new board has no file yet, so the opened file is not touched
    renderRefs(true);
    // Link the file only now, so nothing is written to it until you actually change something.
    // If some items couldn't be read, keep it as a copy so those items aren't lost from your file.
    if (handle && !skipped) { linkFile(handle); setFileStatus(`Working in ${handle.name} — your changes save there`, true); }
    else if (handle) setFileStatus(`${skipped} item${skipped === 1 ? "" : "s"} couldn't be read — opened as a copy, your file is unchanged`);
    toast(`Opened “${name}” as a new board (${refs.length} ${refs.length === 1 ? "item" : "items"})`, async () => {
      await switchBoard(prev); // leaves the opened file as it was
      state.boards = state.boards.filter(x => x.id !== b.id);
      state.refs = state.refs.filter(r => r.boardId !== b.id);
      DB.set(fileKey(b.id), null).catch(() => {});
      save("boards"); save("refs");
      renderBoardTabs();
    });
  }

  const boardInput = $("#board-input");
  $("#board-open").addEventListener("click", async () => {
    if (!("showOpenFilePicker" in window)) { boardInput.click(); return; }
    try {
      const [handle] = await showOpenFilePicker({
        types: [{ description: "Reference board", accept: { "application/json": [".json"] } }],
      });
      const perm = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
      await openBoardText(await (await handle.getFile()).text(), perm === "granted" ? handle : null, handle.name);
    } catch (err) {
      if (err?.name !== "AbortError") toast("Couldn't open that file");
    }
  });
  boardInput.addEventListener("change", async () => {
    const f = boardInput.files[0];
    boardInput.value = "";
    if (f) openBoardText(await f.text(), null, f.name);
  });

  /* ---------- big-picture viewer (pictures on this board) ---------- */
  const viewer = $("#viewer"), vImg = $("#v-img"), vCap = $("#v-caption"), vTags = $("#v-tags"), vPal = $("#v-palette");
  let vId = null;
  const viewList = () => boardRefs().filter(r => !isNote(r));
  const parseTags = (s) => [...new Set(String(s).split(",").map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

  async function openViewer(id) {
    const r = refById(id);
    if (!r || isNote(r)) { viewer.close(); return; }
    vId = id;
    vImg.src = r.img;
    vCap.value = r.caption || "";
    vTags.value = (r.tags || []).join(", ");
    if (!r.palette) { // older pins have no palette yet
      try { r.palette = await extractPalette(r.img); save("refs"); } catch { r.palette = []; }
    }
    vPal.innerHTML = r.palette.filter(h => typeof h === "string" && /^#[0-9a-f]{6}$/i.test(h)).map(h =>
      `<button class="swatch" type="button" style="background:${h}" title="${h} — click to copy" data-hex="${h}"></button>`).join("");
    showLook(r);
    $("#v-prev").hidden = $("#v-next").hidden = viewList().length < 2;
    if (!viewer.open) viewer.showModal();
  }
  const step = (d) => {
    const l = viewList();
    if (!l.length) return;
    const i = l.findIndex(r => r.id === vId);
    openViewer(l[(i + d + l.length) % l.length].id);
  };

  $("#v-close").addEventListener("click", () => viewer.close());
  $("#v-prev").addEventListener("click", () => step(-1));
  $("#v-next").addEventListener("click", () => step(1));
  viewer.addEventListener("click", (e) => { if (e.target === viewer) viewer.close(); });
  viewer.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave Ctrl+F etc. to the browser
    if (e.key.toLowerCase() === "f") toggleLook("flip"); // F = flip
    if (e.key.toLowerCase() === "g") toggleLook("gray"); // G = black and white
  });
  vCap.addEventListener("change", () => {
    const r = refById(vId);
    if (!r) return;
    r.caption = vCap.value.trim();
    save("refs"); renderRefs();
  });
  vTags.addEventListener("change", () => {
    const r = refById(vId);
    if (!r) return;
    r.tags = parseTags(vTags.value);
    vTags.value = r.tags.join(", ");
    save("refs"); applySearch();
  });
  // a color: copy its code, and offer to find other pictures with that color
  vPal.addEventListener("click", (e) => {
    const hex = e.target.dataset?.hex;
    if (!hex) return;
    const findSimilar = () => { viewer.close(); searchColor(hex); };
    navigator.clipboard?.writeText(hex).then(
      () => toast(`Copied ${hex}`, findSimilar, "Find similar"),
      () => toast(hex, findSimilar, "Find similar"));
  });

  // Flip and black-and-white: saved on the picture, shown in the viewer and on the board
  function showLook(r) {
    vImg.className = imgLook(r);
    $("#v-flip").setAttribute("aria-pressed", !!r.flip);
    $("#v-gray").setAttribute("aria-pressed", !!r.gray);
    const img = pinEl(r.id)?.querySelector("img");
    if (img) img.className = imgLook(r);
  }
  function toggleLook(key) {
    const r = refById(vId);
    if (!r) return;
    r[key] = !r[key];
    showLook(r);
    save("refs");
  }
  $("#v-flip").addEventListener("click", () => toggleLook("flip"));
  $("#v-gray").addEventListener("click", () => toggleLook("gray"));
  $("#v-delete").addEventListener("click", () => {
    const r = refById(vId);
    viewer.close();
    if (r) removeWithUndo("refs", r.id, "picture", () => renderRefs());
  });

  /* ================= ASSETS ================= */
  const grid = $("#asset-grid");
  const form = $("#asset-form");
  const fName = $("#a-name"), fPrice = $("#a-price"), fStore = $("#a-store"), fUrl = $("#a-url"), fTags = $("#a-tags");
  const fUsed = $("#a-used"), fLicense = $("#a-license"), fSubmit = $("#asset-submit"), fCancel = $("#asset-cancel");
  const fDate = $("#a-date");
  const dayOf = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-CA"); }; // YYYY-MM-DD, your time zone
  const search = $("#a-search"), filter = $("#a-filter"), sort = $("#a-sort");
  const dupeWarn = $("#dupe-warn");
  let pendingShot = null, editingId = null; // editingId: the asset being changed, if any
  // license choices: label shown on the card + its color
  const LICENSES = {
    commercial:  { label: "Commercial OK",      tone: "ok" },
    attribution: { label: "Credit required",    tone: "warn" },
    personal:    { label: "Personal use only",  tone: "bad" },
    editorial:   { label: "Editorial only",     tone: "bad" },
    unknown:     { label: "License: check",     tone: "warn" },
  };
  // only our own five choices count (not built-in names like "constructor")
  const licenseOf = (k) => (typeof k === "string" && Object.hasOwn(LICENSES, k) ? LICENSES[k] : undefined);
  const splitList = (s, max) => [...new Set(String(s).split(",").map(t => t.trim()).filter(Boolean))].slice(0, max);

  function renderStats() {
    const total = state.assets.reduce((s, a) => s + a.price, 0);
    const now = new Date();
    const month = state.assets
      .filter(a => { const d = new Date(a.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
      .reduce((s, a) => s + a.price, 0);
    const byStore = {};
    state.assets.forEach(a => { const k = a.store || "Other"; byStore[k] = (byStore[k] || 0) + a.price; });
    const top = Object.entries(byStore).sort((x, y) => y[1] - x[1])[0];

    $$(".js-total").forEach(el => el.textContent = fmtMoney(total));
    $("#stat-count").textContent = state.assets.length;
    $("#stat-month").textContent = fmtMoney(month);
    const topEl = $("#stat-top");
    topEl.textContent = top ? top[0] : "—";
    topEl.title = top ? `${top[0]}: ${fmtMoney(top[1])}` : "";

    // store filter options follow the data
    const stores = [...new Set(state.assets.map(a => a.store).filter(Boolean))].sort();
    const cur = filter.value;
    filter.innerHTML = `<option value="">All stores</option>` +
      stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    filter.value = stores.includes(cur) ? cur : "";
  }

  function visibleAssets() {
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const store = filter.value;
    const list = state.assets.filter(a => {
      if (store && a.store !== store) return false;
      const hay = [a.name, a.store, ...(a.tags || []), ...(a.usedIn || []), licenseOf(a.license)?.label || ""].join(" ").toLowerCase();
      return terms.every(t => hay.includes(t));
    });
    const by = {
      new:  (x, y) => new Date(y.date) - new Date(x.date),
      old:  (x, y) => new Date(x.date) - new Date(y.date),
      high: (x, y) => y.price - x.price,
      low:  (x, y) => x.price - y.price,
      name: (x, y) => x.name.localeCompare(y.name),
    }[sort.value];
    return list.sort(by);
  }

  function renderAssets() {
    renderStats();
    const list = visibleAssets();
    const all = state.assets.length;
    const sum = list.reduce((s, a) => s + a.price, 0);
    $("#result-line").textContent = !all ? "" :
      list.length === all ? `${all} ${all === 1 ? "asset" : "assets"} · ${fmtMoney(sum)}`
                          : `Showing ${list.length} of ${all} · ${fmtMoney(sum)}`;

    if (!all) {
      grid.innerHTML = `<p class="empty" style="grid-column:1/-1">No assets yet. Fill in the form above to save your first one.</p>`;
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<p class="empty" style="grid-column:1/-1">Nothing matches that search.</p>`;
      return;
    }
    grid.innerHTML = list.map(a => {
      const lic = licenseOf(a.license);
      return `
      <article class="asset-card${a.id === editingId ? " editing" : ""}">
        ${a.img ? `<img class="asset-shot" src="${esc(a.img)}" alt="" loading="lazy">`
                : `<div class="asset-shot asset-shot--blank">${esc(a.name.charAt(0).toUpperCase())}</div>`}
        ${lic ? `<span class="license license--${lic.tone}">${esc(lic.label)}</span>` : ""}
        <div class="asset-body">
          <div class="asset-top">
            <h3>${esc(a.name)}</h3>
            <span class="price">${esc(fmtMoney(a.price))}</span>
          </div>
          <p class="asset-meta">${esc(a.store || "No store")} · ${fmtDate(a.date)}</p>
          ${(a.usedIn || []).length ? `<p class="used-in">Used in ${a.usedIn.map(p => `<button class="tag tag--project" type="button" data-tag="${esc(p)}">${esc(p)}</button>`).join("")}</p>` : ""}
          ${(a.tags || []).length ? `<div class="tags">${a.tags.map(t => `<button class="tag" type="button" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
          <div class="asset-links">
            ${a.url ? `<a class="open-link" href="${esc(a.url)}" target="_blank" rel="noopener">Open store page ↗</a>` : ""}
            <button class="edit-link" type="button" data-edit="${esc(a.id)}">Edit</button>
          </div>
        </div>
        <button class="del" type="button" title="Remove" data-id="${esc(a.id)}">✕</button>
      </article>`;
    }).join("");
  }

  grid.addEventListener("click", (e) => {
    const del = e.target.closest(".del");
    if (del) {
      const a = state.assets.find(x => x.id === del.dataset.id);
      if (del.dataset.id === editingId) endEdit();
      removeWithUndo("assets", del.dataset.id, a ? `“${a.name}”` : "asset", renderAssets);
      return;
    }
    const tag = e.target.closest(".tag");
    if (tag) { search.value = tag.dataset.tag; renderAssets(); return; }
    const edit = e.target.closest("[data-edit]");
    if (edit) startEdit(edit.dataset.edit);
  });

  // Edit: load the asset into the form above; Save then updates it instead of adding a new one.
  function startEdit(id) {
    const a = state.assets.find(x => x.id === id);
    if (!a) return;
    editingId = id;
    fName.value = a.name; fPrice.value = a.price; fStore.value = a.store || ""; fUrl.value = a.url || "";
    fTags.value = (a.tags || []).join(", "); fUsed.value = (a.usedIn || []).join(", "); fLicense.value = a.license || "";
    fDate.value = dayOf(a.date);
    pendingShot = a.img || null;
    if (pendingShot) { preview.src = pendingShot; drop.classList.add("has-shot"); }
    else { preview.removeAttribute("src"); drop.classList.remove("has-shot"); }
    fSubmit.textContent = "Update asset";
    fCancel.hidden = false;
    form.classList.add("is-editing");
    dupeWarn.hidden = true;
    renderAssets();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    fName.focus({ preventScroll: true });
  }
  function endEdit() {
    editingId = null;
    form.reset();
    pendingShot = null;
    preview.removeAttribute("src");
    drop.classList.remove("has-shot");
    dupeWarn.hidden = true;
    fSubmit.textContent = "Save asset";
    fCancel.hidden = true;
    form.classList.remove("is-editing");
  }
  fCancel.addEventListener("click", () => { endEdit(); renderAssets(); });
  search.addEventListener("input", renderAssets);
  filter.addEventListener("change", renderAssets);
  sort.addEventListener("change", renderAssets);

  // "You already own this" check while typing
  function findDupe() {
    const n = nameKey(fName.value);
    const u = normalizeUrl(fUrl.value);
    return state.assets.find(a => {
      if (a.id === editingId) return false; // not a duplicate of itself
      if (u && a.url && urlKey(a.url) === urlKey(u)) return true;
      const k = nameKey(a.name);
      if (!n || !k) return false;
      return k === n || (n.length >= 4 && k.length >= 4 && (k.includes(n) || n.includes(k)));
    });
  }
  function checkDupe() {
    const d = findDupe();
    dupeWarn.hidden = !d;
    if (d) dupeWarn.textContent =
      `Heads up: you may already own this — “${d.name}” (${d.store || "no store"}, ${fmtMoney(d.price)}, ${fmtDate(d.date)}).`;
  }
  fName.addEventListener("input", checkDupe);
  fUrl.addEventListener("input", checkDupe);

  // screenshot drop zone
  const drop = $("#shot-drop"), shotIn = $("#shot-input"), preview = $("#shot-preview");
  async function stageShot(file) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      pendingShot = await shrinkImage(file, 900);
      preview.src = pendingShot;
      drop.classList.add("has-shot");
    } catch { toast("Couldn't read that image"); }
  }
  drop.addEventListener("click", () => shotIn.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); shotIn.click(); } });
  shotIn.addEventListener("change", () => { stageShot(shotIn.files[0]); shotIn.value = ""; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = fName.value.trim();
    const price = parseFloat(fPrice.value);
    if (!name || isNaN(price) || price < 0) return;
    const url = normalizeUrl(fUrl.value);
    if (fUrl.value.trim() && !url) { toast("That store link doesn't look right"); fUrl.focus(); return; }
    const fields = {
      name, price: Math.round(price * 100) / 100, store: fStore.value.trim(), url,
      tags: splitList(fTags.value.toLowerCase(), 8),
      usedIn: splitList(fUsed.value, 10).map(p => p.slice(0, 60)),
      license: licenseOf(fLicense.value) ? fLicense.value : "",
      img: pendingShot,
    };
    const existing = editingId && state.assets.find(a => a.id === editingId);
    // "Bought on": the day you picked (at noon, so time zones can't shift it a day), else keep the old date / today
    const picked = /^\d{4}-\d{2}-\d{2}$/.test(fDate.value) ? new Date(fDate.value + "T12:00:00") : null;
    fields.date = picked && !isNaN(picked) ? picked.toISOString() : (existing?.date || new Date().toISOString());
    if (existing) Object.assign(existing, fields); // keeps its id
    else state.assets.push({ id: uid(), ...fields });
    await save("assets");
    endEdit();
    renderAssets();
    toast(existing ? `Updated “${name}”` : `Saved “${name}”`);
    fName.focus();
  });

  /* ================= QUICK LINKS ================= */
  const linkGrid = $("#link-grid"), linkForm = $("#link-form");
  // sites that refuse to show their icon on other sites: use the first letter instead (no error)
  const NO_FAVICON = new Set(["fab.com"]);
  let newLinkId = null; // the link just added gets a little pop

  function renderLinks(stagger = false) {
    linkGrid.classList.toggle("stagger", stagger);
    let n = 0;
    linkGrid.innerHTML = LINK_GROUPS.map(g => {
      const list = state.links.filter(l => l.group === g.name);
      if (!list.length) return "";
      return `
        <section class="link-group">
          <h2 class="group-title"><span class="group-icon">${g.icon}</span>${esc(g.name)}<span class="group-count">${list.length}</span></h2>
          <div class="link-grid">${list.map(l => {
            let host = "", origin = "";
            try { const u = new URL(l.url); host = u.hostname.replace(/^www\./, ""); origin = u.origin; } catch {}
            const letter = esc(l.name.charAt(0).toUpperCase());
            return `
              <a class="link-tile${l.id === newLinkId ? " is-new" : ""}" href="${esc(l.url)}" target="_blank" rel="noopener" style="--i:${n++}">
                <span class="link-icon" data-letter="${letter}">${origin && !NO_FAVICON.has(host) ? `<img src="${esc(origin)}/favicon.ico" alt="">` : letter}</span>
                <span class="link-text">
                  <span class="link-name">${esc(l.name)}</span>
                  <span class="link-host">${esc(host)}</span>
                </span>
                <span class="link-go" aria-hidden="true">↗</span>
                <button class="del" type="button" title="Remove" data-id="${esc(l.id)}">✕</button>
              </a>`;
          }).join("")}</div>
        </section>`;
    }).join("") || `<p class="empty">No links yet. Click “+ Add link” to save your first one.</p>`;
    newLinkId = null;
  }
  // a site without a favicon gets its first letter instead
  linkGrid.addEventListener("error", (e) => {
    if (e.target.tagName !== "IMG") return;
    const box = e.target.parentElement;
    box.textContent = box.dataset.letter;
  }, true);

  linkGrid.addEventListener("click", (e) => {
    const del = e.target.closest(".del");
    if (!del) return;
    e.preventDefault();
    const tile = del.closest(".link-tile");
    const l = state.links.find(x => x.id === del.dataset.id);
    tile.classList.add("leaving"); // shrink away, then remove
    setTimeout(() => removeWithUndo("links", del.dataset.id, l ? l.name : "link", () => renderLinks()), 220);
  });

  const lGroup = $("#l-group");
  lGroup.innerHTML = LINK_GROUPS.map(g => `<option>${esc(g.name)}</option>`).join("");
  const lUrl = $("#l-url");
  // pick the likely group as you type the address — unless you already picked one yourself
  let groupPicked = false;
  lGroup.addEventListener("change", () => { groupPicked = true; });
  lUrl.addEventListener("input", () => { const u = normalizeUrl(lUrl.value); if (u && !groupPicked) lGroup.value = guessGroup(u); });
  linkForm.addEventListener("reset", () => { groupPicked = false; });

  $("#link-add").addEventListener("click", () => {
    linkForm.hidden = !linkForm.hidden;
    if (!linkForm.hidden) $("#l-name").focus();
  });
  linkForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#l-name").value.trim();
    const url = normalizeUrl(lUrl.value);
    if (!name) return;
    if (!url) { toast("That link doesn't look right"); lUrl.focus(); return; }
    const group = groupPicked && LINK_GROUPS.some(g => g.name === lGroup.value) ? lGroup.value : guessGroup(url);
    const link = { id: uid(), name, url, group };
    state.links.push(link);
    save("links");
    linkForm.reset();
    linkForm.hidden = true;
    newLinkId = link.id;
    renderLinks();
    toast(`Added ${name} to ${group}`);
  });
  $("#link-cancel").addEventListener("click", () => { linkForm.reset(); linkForm.hidden = true; });

  /* ================= paste & drop routing ================= */
  // On the Assets page, images become the asset screenshot. Anywhere else they go on the board.
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter(i => i.kind === "file" && i.type.startsWith("image/"))
      .map(i => i.getAsFile());
    if (!files.length) return;
    e.preventDefault();
    if (currentView === "assets") stageShot(files[0]);
    else addRefs(files);
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // stop the browser from opening the image instead
    drop.classList.toggle("drag", currentView === "assets");
    board.classList.toggle("drag", currentView !== "assets");
  });
  const clearDrag = () => { drop.classList.remove("drag"); board.classList.remove("drag"); };
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) clearDrag(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    clearDrag();
    if (currentView === "assets") { stageShot(e.dataTransfer.files[0]); return; }
    let at;
    if (currentView === "board" && e.target.closest?.("#board-wrap")) at = toBoard(e.clientX, e.clientY);
    addRefs(e.dataTransfer.files, at);
  });

  /* ================= checking data from outside ================= */
  // Used for old saved data and files: keep only good items, rebuilt from
  // known fields, with links, images, colors and numbers re-checked.
  const isImg = (s) => typeof s === "string" && s.startsWith("data:image/");
  const strList = (v, max, len) => Array.isArray(v) ? [...new Set(v.map(t => String(t).trim().slice(0, len)).filter(Boolean))].slice(0, max) : [];
  const valid = {
    boards: (b) => b && typeof b.id === "string" && b.id && typeof b.name === "string",
    assets: (a) => a && typeof a.name === "string" && Number.isFinite(a.price) && a.price >= 0,
    refs:   (r) => r && (isImg(r.img) || (r.kind === "note" && typeof r.text === "string")),
    links:  (l) => l && typeof l.name === "string" && normalizeUrl(l.url),
  };
  const clean = {
    boards: (b) => ({ id: b.id.slice(0, 40), name: b.name.trim().slice(0, 40) || "Board" }),
    assets: (a) => ({ id: String(a.id || uid()), name: a.name, price: a.price, store: String(a.store || ""),
      url: normalizeUrl(a.url), tags: strList(a.tags, 8, 40).map(t => t.toLowerCase()),
      usedIn: strList(a.usedIn, 10, 60), license: licenseOf(a.license) ? a.license : "",
      img: isImg(a.img) ? a.img : null, date: isNaN(new Date(a.date)) ? new Date().toISOString() : a.date }),
    refs: (r) => {
      const base = { id: String(r.id || uid()), boardId: typeof r.boardId === "string" ? r.boardId : "",
        x: num(r.x), y: num(r.y), z: num(r.z),
        tilt: num(r.tilt) !== undefined ? clamp(r.tilt, -12, 12) : undefined,
        date: typeof r.date === "string" ? r.date : undefined };
      if (r.kind === "note") return { ...base, kind: "note", text: r.text.slice(0, 2000),
        color: NOTE_COLORS.includes(r.color) ? r.color : NOTE_COLORS[0], w: num(r.w) && clamp(r.w, 140, 1000) };
      return { ...base, img: r.img, caption: String(r.caption || "").slice(0, 60),
        tags: strList(r.tags, 12, 30).map(t => t.toLowerCase()),
        palette: Array.isArray(r.palette) ? r.palette.filter(h => typeof h === "string" && /^#[0-9a-f]{6}$/i.test(h)) : undefined,
        thumb: isImg(r.thumb) ? r.thumb : undefined,
        w: num(r.w) && clamp(r.w, 120, 1000), ar: num(r.ar) && r.ar > 0 ? r.ar : undefined,
        flip: r.flip === true, gray: r.gray === true };
    },
    links: (l) => ({ id: String(l.id || uid()), name: l.name, url: normalizeUrl(l.url),
      group: LINK_GROUPS.some(g => g.name === l.group) ? l.group : guessGroup(normalizeUrl(l.url)) }),
  };
  // two items count as "the same" even without matching ids
  const sameKey = {
    boards: (b) => b.id,
    assets: (a) => `${a.name}|${a.price}|${a.store}`.toLowerCase(),
    refs:   (r) => isNote(r) ? `note|${r.boardId}|${r.text}` : r.img,
    links:  (l) => l.url,
  };
  // anything pointing at a board that doesn't exist goes on the board you're looking at
  const fixBoardIds = () => state.refs.forEach(r => { if (!boardById(r.boardId)) r.boardId = curBoard || state.boards[0]?.id; });
  const sanitize = (key, list) => (Array.isArray(list) ? list : []).filter(valid[key]).map(clean[key]);

  /* ================= backup (everything) ================= */
  $("#backup-export").addEventListener("click", () => {
    const data = { app: "dev-journal", version: 1, exported: new Date().toISOString(), ...state };
    download(JSON.stringify(data), `lootkit-backup-${new Date().toISOString().slice(0, 10)}.json`);
  });

  const backupIn = $("#backup-input");
  $("#backup-import").addEventListener("click", () => backupIn.click());
  backupIn.addEventListener("change", async () => {
    const file = backupIn.files[0];
    backupIn.value = "";
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a backup"); return; }
    if (Array.isArray(data)) data = { assets: data }; // old "export .json" ledger file
    let added = 0;
    for (const key of ["boards", "assets", "refs", "links"]) {
      if (!Array.isArray(data[key])) continue;
      // merge: only add what isn't here yet, never overwrite
      const haveId = new Set(state[key].map(x => x.id));
      const haveSame = new Set(state[key].map(sameKey[key]));
      const fresh = [];
      for (const x of sanitize(key, data[key])) {
        if (haveId.has(x.id) || haveSame.has(sameKey[key](x))) continue;
        haveId.add(x.id); haveSame.add(sameKey[key](x));
        fresh.push(x);
      }
      if (!fresh.length) continue;
      state[key].push(...fresh);
      added += fresh.length;
      if (key === "refs") { fixBoardIds(); await preparePins(); }
      await save(key);
    }
    renderAll();
    toast(added ? `Loaded ${added} new ${added === 1 ? "item" : "items"} from backup` : "Nothing new in that backup");
  });

  /* ================= auto-backup to a folder on your computer ================= */
  // You pick a folder once. After every change (once things settle for a few seconds)
  // the full backup is written there as lootkit-backup.json, plus one dated copy
  // per day; only the newest 7 dated copies are kept. No other files are touched.
  const canPickFolder = "showDirectoryPicker" in window;
  const abStatus = $("#ab-status"), abBtn = $("#ab-choose"), abDot = $("#ab-dot");
  const KEEP_DAILY = 7, DATED = /^lootkit-\d{4}-\d{2}-\d{2}\.json$/;
  let backupDir = null, backupLive = false, backupTimer = 0, backupBusy = false;

  function setBackupUI(mode, text, button) {
    abDot.className = "ab-dot " + mode; // on / warn / off
    abStatus.textContent = text;
    abBtn.hidden = !button;
    if (button) abBtn.textContent = button;
  }
  // small board copies are left out of files; they are remade when a file is loaded
  const withoutThumbs = (refs) => refs.map(({ thumb, ...r }) => r);
  const backupText = () => JSON.stringify({ app: "dev-journal", version: 2, exported: new Date().toISOString(),
    ...state, refs: withoutThumbs(state.refs) });

  async function writeBackup() {
    if (!backupDir || !backupLive) return;
    if (backupBusy) { scheduleBackup(); return; }
    backupBusy = true;
    try {
      const text = backupText();
      const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
      for (const name of ["lootkit-backup.json", `lootkit-${today}.json`]) {
        const fh = await backupDir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      }
      const dated = [];
      for await (const [name, h] of backupDir.entries()) if (h.kind === "file" && DATED.test(name)) dated.push(name);
      for (const old of dated.sort().slice(0, -KEEP_DAILY)) await backupDir.removeEntry(old).catch(() => {});
      setBackupUI("on", `On — saved to “${backupDir.name}” · ${fmtTime()}`, "Change folder");
    } catch {
      backupLive = false;
      setBackupUI("warn", `Paused — click to keep backing up to “${backupDir.name}”`, "Resume auto-backup");
    } finally { backupBusy = false; }
  }
  function scheduleBackup() {
    if (!backupDir || !backupLive) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => { backupTimer = 0; writeBackup(); }, 4000);
  }

  abBtn.addEventListener("click", async () => {
    if (!canPickFolder) return;
    try {
      // after a restart the browser asks again before writing to the same folder
      if (backupDir && !backupLive) {
        if ((await backupDir.requestPermission({ mode: "readwrite" })) === "granted") {
          backupLive = true;
          await writeBackup();
        }
        return; // said no: stay paused, don't jump to a folder picker
      }
      const dir = await showDirectoryPicker({ id: "dev-journal-backup", mode: "readwrite", startIn: "documents" });
      backupDir = dir;
      backupLive = true;
      DB.set("backupDir", dir).catch(() => {});
      await writeBackup();
      if (backupLive) toast(`Auto-backup is on — saving to “${dir.name}”`);
    } catch (err) {
      if (err?.name !== "AbortError") toast("Couldn't use that folder");
    }
  });

  async function loadBackupDir() {
    if (!canPickFolder) {
      setBackupUI("off", "This browser can't save to a folder. Use Download backup below now and then.", "");
      return;
    }
    const dir = await DB.get("backupDir").catch(() => undefined);
    if (!dir) return; // stays "Off" with the Choose button
    backupDir = dir;
    const perm = await dir.queryPermission?.({ mode: "readwrite" }).catch(() => "denied");
    backupLive = perm === "granted";
    if (backupLive) setBackupUI("on", `On — saving to “${dir.name}”`, "Change folder");
    else setBackupUI("warn", `Paused — click to keep backing up to “${dir.name}”`, "Resume auto-backup");
  }

  /* ================= saved from the web (Lootkit Saver extension) ================= */
  // The extension right-click saves images/links into its inbox; its bridge script
  // posts them here. Everything is re-checked like any other outside data.
  const FROM_EXT = "dev-journal-saver", FROM_APP = "dev-journal-app";
  // ids already taken in — kept in storage, so a reload can't add the same thing twice
  const inboxSeen = new Set();
  const rememberSeen = () => DB.set("inboxSeen", [...inboxSeen].slice(-500)).catch(() => {});
  // same page = same address, ignoring "www.", a trailing "/" and "#part" (but not "?v=…")
  const sameLink = (a, b) => {
    const k = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "").toLowerCase() + x.pathname.replace(/\/+$/, "") + x.search; } catch { return u; } };
    return k(a) === k(b);
  };
  let booted = false;
  const tellExt = (msg) => window.postMessage({ source: FROM_APP, ...msg }, location.origin);
  // Lootkit Saver keeps a copy of what you bought (names, store links, prices, dates, projects —
  // no screenshots) on your computer, to show "You own this" on store pages.
  function shareOwned() {
    if (!booted) return;
    tellExt({ type: "owned", items: state.assets.map(a => ({
      name: a.name, url: a.url || "", store: a.store || "", price: a.price, date: a.date, usedIn: a.usedIn || [] })) });
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== FROM_EXT) return;
    if (d.type === "hello") { if (booted) { tellExt({ type: "ready" }); shareOwned(); } return; }
    if (!Array.isArray(d.items)) return;

    const done = [], imgs = [];
    let added = 0, already = 0, failed = 0, lastName = "";
    for (const it of d.items) {
      if (!it || typeof it.id !== "string") continue;
      if (inboxSeen.has(it.id)) { done.push(it.id); continue; } // taken in before: just clear it
      inboxSeen.add(it.id);
      done.push(it.id);
      if (it.type === "image") {
        if (!isImg(it.dataUrl)) { failed++; continue; }
        try {
          const blob = await (await fetch(it.dataUrl)).blob();
          const name = String(it.caption || "").replace(/[\\/]/g, " ").slice(0, 40) || "image";
          imgs.push(new File([blob], name + ".img", { type: blob.type }));
        } catch { failed++; }
      }
      if (it.type === "link") {
        const url = normalizeUrl(it.url);
        if (!url) { failed++; continue; }
        if (state.links.some(l => sameLink(l.url, url))) { already++; continue; }
        let name = String(it.name || "").trim().slice(0, 60);
        if (!name) name = new URL(url).hostname.replace(/^www\./, "");
        const link = { id: uid(), name, url, group: guessGroup(url) };
        state.links.push(link);
        newLinkId = link.id;
        lastName = name;
        added++;
      }
    }
    if (added) {
      await save("links");
      renderLinks();
      toast(added === 1 ? `Added “${lastName}” to Quick Links` : `Added ${added} links to Quick Links`);
    } else if (already) toast("That link is already in your Quick Links");
    if (imgs.length) await addRefs(imgs);
    if (failed) toast(`${failed === 1 ? "One saved item" : `${failed} saved items`} couldn't be added (not a picture or a web link)`);
    if (done.length) { await rememberSeen(); tellExt({ type: "ack", ids: done }); }
  });

  /* ================= welcome screen + help ================= */
  // Chrome Web Store page of the right-click saver; the tip stays hidden until it's published.
  const EXTENSION_URL = "";
  const welcome = $("#welcome");
  if (EXTENSION_URL) { $("#welcome-ext-link").href = EXTENSION_URL; $("#welcome-ext").hidden = false; }
  const openWelcome = () => { if (!welcome.open) welcome.showModal(); };
  function closeWelcome() {
    welcome.close();
    try { localStorage.setItem("dj_welcomed", "1"); } catch {}
  }
  $("#welcome-start").addEventListener("click", closeWelcome);
  welcome.addEventListener("cancel", () => { try { localStorage.setItem("dj_welcomed", "1"); } catch {} }); // Esc
  // close only on a click truly outside the box (its own padding counts as inside)
  welcome.addEventListener("click", (e) => {
    if (e.target !== welcome) return;
    const r = welcome.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeWelcome();
  });
  $("#help-btn").addEventListener("click", openWelcome);
  $("#help-open").addEventListener("click", openWelcome);
  function maybeWelcome() {
    let seen = null;
    try { seen = localStorage.getItem("dj_welcomed"); } catch {}
    if (!seen) openWelcome();
  }

  /* ================= works offline / installs as an app ================= */
  // A small service worker keeps a copy of the page, so it opens even without internet
  // (or, on your own computer, without the local server running).
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    // register right away (waiting for "load" can take long while web fonts download)
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* ================= boot ================= */
  function renderAll() { renderRefs(); renderAssets(); renderLinks(currentView === "links"); }

  async function boot() {
    // menu starts open on big screens (unless you closed it), closed on phones
    let menuPref = null;
    try { menuPref = localStorage.getItem("dj_menu"); } catch {}
    document.body.classList.toggle("menu-open", !isNarrow() && menuPref !== "0");
    route();

    try {
      const [boards, refs, assets, links, oldHandle, seen, imgs] = await Promise.all(
        [DB.get("boards"), DB.get("refs"), DB.get("assets"), DB.get("links"),
         DB.get("boardFile").catch(() => undefined), DB.get("inboxSeen").catch(() => undefined),
         DB.getPrefix("img:")]);
      if (Array.isArray(seen)) seen.forEach(id => typeof id === "string" && inboxSeen.add(id));
      // put each picture back with its details (older saves kept the picture inside the list itself)
      const imgById = new Map(imgs.map(([k, v]) => [k.slice(4), v]));
      const withImgs = Array.isArray(refs) ? refs.map(r => {
        const stored = r && !r.img && imgById.get(r.id);
        return stored ? { ...r, img: stored.img, thumb: stored.thumb } : r;
      }) : refs;
      // first run: bring over anything saved by the old version of the page
      // everything is re-checked on load, whether new storage or old
      state.boards = sanitize("boards", boards);
      if (!state.boards.length) state.boards = [{ id: "main", name: "My board" }];
      state.refs   = sanitize("refs",   withImgs ?? loadOld("gg_refs_v1"));
      // pictures already in their own slot don't need writing again
      state.refs.forEach(r => { const s = imgById.get(r.id); if (s && s.img === r.img) storedImgs.add(r.id); });
      // slots of pictures that were deleted (and not undone) are cleared out
      const orphans = [...imgById.keys()].filter(id => !state.refs.some(r => r.id === id)).map(id => "img:" + id);
      if (orphans.length) await DB.batch([], orphans);
      state.assets = sanitize("assets", assets ?? loadOld("gg_ledger_v1"));
      state.links  = links ? sanitize("links", links) : DEFAULT_LINKS;
      let pref = null;
      try { pref = localStorage.getItem("dj_board"); } catch {}
      curBoard = boardById(pref) ? pref : state.boards[0].id;
      fixBoardIds(); // pictures from before "many boards" land on the first board
      if (boards === undefined) await save("boards");
      if (assets === undefined) await save("assets");
      if (links === undefined) await save("links");
      await preparePins();
      await save("refs");
      if (oldHandle) { // the one-board version's linked file now belongs to the first board
        await DB.set(fileKey(state.boards[0].id), oldHandle);
        await DB.set("boardFile", null);
      }
      await loadBoardFile(curBoard);
      navigator.storage?.persist?.(); // ask the browser not to auto-clear our data
    } catch {
      dbOk = false;
      if (!state.boards.length) state.boards = [{ id: "main", name: "My board" }];
      curBoard = curBoard || state.boards[0].id;
      state.links = DEFAULT_LINKS;
      toast("This browser can't save data here. Turn on Auto-backup so your work isn't lost.");
    }
    await loadBackupDir().catch(() => {}); // runs even if browser storage failed above
    showZoom();
    renderAll();
    booted = true;
    tellExt({ type: "ready" }); // the extension can now hand over anything saved
    shareOwned();
    maybeWelcome();
  }
  window.addEventListener("resize", () => { if (currentView === "board") sizeBoard(); });
  boot();
})();
