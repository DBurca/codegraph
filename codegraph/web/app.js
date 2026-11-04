'use strict';
/* CodeGraph viewer — vanilla JS, no build step.
 * World coordinates: nodes live in a big 2D plane; #world is CSS-transformed by (tx, ty, k).
 * Semantic zoom: the zoom factor k picks a level (overview → files → details → code) and
 * CSS swaps what each node shows. Edges are SVG paths recomputed each frame (cheap at ~100 nodes).
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const viewport = $('#viewport'), world = $('#world'), svg = $('#edges'), nodesEl = $('#nodes');
  const tooltip = $('#tooltip'), panel = $('#panel');
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const LEVEL_MAX = [0.55, 1.3, 2.6];          // k thresholds between levels 0|1|2|3
  const LEVEL_K = [0.3, 0.85, 1.75, 3.4];      // where the zoombar buttons take you
  const LEVEL_NAMES = ['Overview', 'Files', 'Details', 'Code'];
  const PALETTE = ['#58a6ff', '#f0a35e', '#5fd08e', '#e46b9a', '#b48cf2', '#e8c547', '#4fc9d9', '#f27b6b', '#9fc46a', '#d4a27e', '#7e9cf5', '#e88fd6'];
  const LANG_LABEL = { python: 'PY', cpp: 'C++', c: 'C', js: 'JS', ts: 'TS', html: 'HTML', css: 'CSS', ext: 'PKG' };
  const HLJS_LANG = { python: 'python', cpp: 'cpp', c: 'c', js: 'javascript', ts: 'typescript', html: 'xml', css: 'css' };
  const KIND_ICON = { class: 'C', function: 'ƒ', method: 'm', var: 'v', vars: 'v', macro: '#', type: 'T', decl: 'd', global: 'g', enum: 'E', hdr: '·' };
  const KIND_LABEL = { import: 'imports', include: '#include', script: '<script src>', style: 'stylesheet', global: 'shared global scope', ref: 'file path reference', external: 'package import' };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('codegraph:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('codegraph:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const S = {
    graph: null, version: 0,
    nodes: new Map(), edges: [],
    tx: 0, ty: 0, k: 1, level: -1,
    selected: null,
    opts: Object.assign({ orphans: true, externals: false, css: true, global: true, refs: true, transitive: false,
      wheel: IS_MAC ? 'pan' : 'zoom', mode: 'flow' }, store.get('opts', {})),
    hiddenGroups: new Set(),
    groupColors: new Map(),
    code: new Map(),
    bbox: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let vpRect = viewport.getBoundingClientRect();

  // ================================================================ data ingest
  async function loadGraph(initial) {
    const g = await fetch('/api/graph').then((r) => r.json());
    S.version = g.version;
    if (!g.root) { resetProject(); openPicker(true); return; }
    if (S.graph && S.graph.root !== g.root) { resetProject(); initial = true; }
    ingest(g, initial);
    if (initial) { picker.classList.add('hidden'); firstSize = false; applyHash(); }
    if (initial && g.truncated) toast(`This folder is very large, so only the first ${g.nodes.length} files are shown. Pick a subfolder for a full map.`, 6000);
    if (!initial && g.changed && g.changed.length) {
      toast(`↻ Updated ${g.changed.length} file${g.changed.length > 1 ? 's' : ''}: ${g.changed.slice(0, 3).map((p) => p.split('/').pop()).join(', ')}${g.changed.length > 3 ? '…' : ''}`);
    }
  }

  /* Views are linkable:  #select=path  ·  #at=path&k=1.6  ·  #code=path&line=41  ·  #mode=hubs
   * (also how the README screenshots are produced with headless Chrome). */
  function applyHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.toString()) return;
    if (h.get('mode') && h.get('mode') !== S.opts.mode && ['flow', 'hubs'].includes(h.get('mode'))) {
      S.opts.mode = h.get('mode');
      document.querySelectorAll('#layoutSeg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === S.opts.mode));
      for (const n of S.nodes.values()) n.placed = false;
      layout(false); positionAll(); fit(false);
    }
    const node = (key) => { const n = h.get(key) && S.nodes.get(h.get(key)); if (n) revealNode(n); return n; };
    const sel = node('select');
    if (sel) select(sel);
    const at = node('at');
    if (at) flyTo(at.x + (+h.get('dx') || 0), at.y + (+h.get('dy') || 0), +h.get('k') || 1, 0);
    const code = node('code');
    if (code) { if (!sel) select(code); openCode(code, +h.get('line') || code.symbols[0]?.line || 1, 0); }
  }
  function writeHash(n) {
    try { history.replaceState(null, '', n ? '#select=' + encodeURIComponent(n.id) : location.pathname); } catch { /* sandboxed */ }
  }

  /** Forget everything about the current project (before showing a different one). */
  function resetProject() {
    clearSelection();
    for (const n of S.nodes.values()) n.el?.remove();
    for (const e of S.edges) e.g?.remove();
    S.nodes = new Map();
    S.edges = [];
    S.graph = null;
    S.code.clear();
    S.hiddenGroups.clear();
    S.groupColors.clear();
    S.bbox = null;
    $('#projStats').textContent = '';
    $('#empty').classList.add('hidden');
    drawMinimap();
  }

  function groupColor(group) {
    if (!S.groupColors.has(group)) {
      if (group === 'external packages') S.groupColors.set(group, '#6b7686');
      else S.groupColors.set(group, PALETTE[S.groupColors.size % PALETTE.length]);
    }
    return S.groupColors.get(group);
  }

  function sizeFor(n) {
    if (n.ext) return [190, 56];
    const s = Math.min(1, Math.sqrt(n.lines || 1) / Math.sqrt(900));
    return [Math.round(250 + 120 * s), Math.round(165 + 95 * s)];
  }

  function ingest(g, initial) {
    S.graph = g;
    document.title = `${g.name} · CodeGraph`;
    $('#projName').textContent = g.name;
    $('#projName').title = g.root;
    const groups = [...new Set(g.nodes.map((n) => n.group))].sort((a, b) => (a === '(root)' ? -1 : b === '(root)' ? 1 : a.localeCompare(b)));
    groups.forEach(groupColor);

    const changed = new Set(g.changed || []);
    const next = new Map();
    let added = 0;
    for (const raw of g.nodes) {
      const prev = S.nodes.get(raw.id);
      const n = Object.assign(prev || {}, raw);
      [n.w, n.h] = sizeFor(n);
      if (!prev) added++;
      if (!prev || changed.has(n.id) || initial) buildNodeEl(n);
      else refreshNodeMeta(n);
      next.set(n.id, n);
    }
    for (const ex of g.externals) {
      const id = `ext:${ex.lang}:${ex.name}`;
      const prev = S.nodes.get(id);
      const n = Object.assign(prev || {}, { id, name: ex.name, lang: 'ext', extLang: ex.lang, ext: true, group: 'external packages',
        users: ex.users, symbols: [], lines: 0, depth: null, pagerank: 0, indeg: ex.users.length, outdeg: 0 });
      [n.w, n.h] = sizeFor(n);
      if (!prev) { added++; buildNodeEl(n); } else buildNodeEl(n);
      next.set(id, n);
    }
    for (const [id, n] of S.nodes) if (!next.has(id)) { n.el?.remove(); S.code.delete(id); }
    for (const id of changed) S.code.delete(id);
    S.nodes = next;

    for (const e of S.edges) e.g?.remove();
    S.edges = g.edges.map((raw) => makeEdge(raw)).filter(Boolean);
    for (const ex of g.externals) {
      const t = S.nodes.get(`ext:${ex.lang}:${ex.name}`);
      for (const u of ex.users) {
        const s = S.nodes.get(u);
        if (s && t) S.edges.push(makeEdge({ id: `${u}->${t.id}`, source: u, target: t.id, kinds: ['external'], symbols: [], uses: [], lines: [], cycle: false }));
      }
    }

    const ext = g.externals.length;
    $('#projStats').textContent = `${g.nodes.length} files · ${g.edges.length} links${ext ? ` · ${ext} packages` : ''}`;
    $('#empty').classList.toggle('hidden', g.nodes.length > 0);
    $('#empty').innerHTML = `No Python, C/C++, JS/TS, HTML or CSS files found in<br><code>${esc(g.root)}</code>`;

    refreshVisibility(false);
    if (initial) { layout(false); fit(false); }
    else if (added) layout(true);
    positionAll();
    renderLegend();
    if (S.selected) {
      const again = S.nodes.get(S.selected.id);
      if (again && again.visible) select(again, { keepPanel: false }); else clearSelection();
    }
    applyTransform();
  }

  function makeEdge(raw) {
    const s = S.nodes.get(raw.source), t = S.nodes.get(raw.target);
    if (!s || !t) return null;
    const ks = raw.kinds;
    const cls = ks.includes('import') || ks.includes('include') ? 'import'
      : ks.includes('script') || ks.includes('style') ? 'asset'
        : ks.includes('global') ? 'global' : ks.includes('ref') ? 'ref' : 'external';
    return Object.assign({}, raw, { s, t, cls, width: 1.1 + Math.min(3, Math.log2(1 + raw.symbols.length) * 0.6), pairs: null });
  }

  // ============================================================ node elements
  function buildNodeEl(n) {
    if (!n.el) {
      n.el = document.createElement('div');
      n.el.dataset.id = n.id;
      nodesEl.appendChild(n.el);
    }
    n.codeShown = null;
    n.geom = null;
    n.el.style.setProperty('--c', groupColor(n.group));
    n.el.style.width = n.w + 'px';
    n.el.style.height = n.h + 'px';
    refreshNodeMeta(n);

    if (n.ext) {
      n.el.innerHTML = `<div class="far">${esc(n.name)}</div>
        <div class="head" style="padding-top:9px"><span class="badge b-ext">PKG</span><span class="nm">${esc(n.name)}</span></div>
        <div class="sub">${n.users.length} file${n.users.length > 1 ? 's' : ''} · ${esc(n.extLang)}</div>`;
      n.symIndex = new Map(); n.ranges = [];
      return;
    }

    // symbol rows + lookup tables for symbol-level edges
    const rows = [];
    const symIndex = new Map();
    const ranges = [];
    const prio = { class: 0, function: 1, type: 2, enum: 2, decl: 3, method: 4, global: 5, macro: 6, var: 7 };
    const vars = [];
    n.symbols.forEach((s, i) => {
      if (s.kind === 'var') { vars.push(s); return; }
      const key = 's' + i;
      const short = s.name.split('::').pop();
      for (const nm of new Set([s.name, short])) {
        const cur = symIndex.get(nm);
        if (!cur || prio[s.kind] < cur.p) symIndex.set(nm, { key, p: prio[s.kind] ?? 9 });
      }
      if (s.kind !== 'decl' && s.kind !== 'macro' && s.kind !== 'global') ranges.push({ line: s.line, end: s.end, key });
      rows.push(`<div class="row k-${s.kind}" data-key="${key}" data-line="${s.line}" data-sym="${esc(s.name)}">` +
        `<span class="ic">${KIND_ICON[s.kind] || '•'}</span><span class="sn">${esc(s.kind === 'method' ? short : s.name)}</span>` +
        `${s.sig ? `<span class="sig">${esc(s.sig.length > 40 ? s.sig.slice(0, 38) + '…)' : s.sig)}</span>` : ''}<span class="ln">${s.line}</span></div>`);
    });
    if (vars.length) {
      vars.forEach((v) => { if (!symIndex.has(v.name)) symIndex.set(v.name, { key: 'vars', p: 9 }); });
      rows.push(`<div class="row k-vars" data-key="vars" data-line="${vars[0].line}" data-sym="${esc(vars.map((v) => v.name).join(', '))}">` +
        `<span class="ic">v</span><span class="sn">${esc(vars.map((v) => v.name).join(', '))}</span></div>`);
    }
    if (!rows.length) rows.push('<div class="row k-hdr" data-key="none"><span class="ic">·</span><span class="sn">no functions or classes</span></div>');
    n.symIndex = new Map([...symIndex].map(([k, v]) => [k, v.key]));
    n.ranges = ranges;

    const defs = n.symbols.filter((s) => s.kind === 'function' || s.kind === 'class').length;
    const flags = (n.entry ? '<span class="flag entry">★ entry</span>' : '') +
      (n.cycle ? '<span class="flag cyc">⟳ cycle</span>' : '') + (n.error ? '<span class="flag err">⚠</span>' : '');
    const chips = n.externals.length ? `<div class="chips">${n.externals.slice(0, 6).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}${n.externals.length > 6 ? `<span class="chip">+${n.externals.length - 6}</span>` : ''}</div>` : '';
    n.el.innerHTML = `
      <div class="far">${esc(n.name).replace(/([_.\-])/g, '$1<wbr>')}</div>
      <div class="head"><span class="badge b-${n.lang}">${LANG_LABEL[n.lang] || n.lang}</span><span class="nm">${esc(n.name)}</span>${flags}</div>
      <div class="sub">${esc(n.dir || '.')}/ · ${n.lines} lines</div>
      ${n.doc ? `<div class="doc">${esc(n.doc)}</div>` : ''}
      <div class="stats"><span><b>${n.outdeg}</b> imports</span><span><b>${n.indeg}</b> used by</span><span><b>${defs}</b> defs</span><span><b>${n.loc}</b> loc</span></div>
      ${chips}
      <div class="syms">${rows.join('')}</div>
      <div class="code"><div class="code-msg">Loading…</div></div>`;
    n.listEl = n.el.querySelector('.syms');
    n.headEl = n.el.querySelector('.head');
    n.codeEl = n.el.querySelector('.code');
  }

  function refreshNodeMeta(n) {
    n.el.className = 'node' + (n.entry ? ' entry' : '') + (n.orphan ? ' orphan' : '') + (n.cycle ? ' cycle' : '') + (n.ext ? ' ext' : '') +
      (S.selected && S.selected.id === n.id ? ' sel' : '');
  }

  function positionNode(n) {
    n.el.style.transform = `translate(${r1(n.x - n.w / 2)}px, ${r1(n.y - n.h / 2)}px)`;
  }
  function positionAll() { for (const n of S.nodes.values()) if (n.visible) positionNode(n); computeBBox(); }

  // ============================================================== visibility
  function isVisible(n) {
    if (S.hiddenGroups.has(n.group)) return false;
    if (n.ext) return S.opts.externals;
    if (n.orphan && !S.opts.orphans) return false;
    if (n.lang === 'css' && !S.opts.css) return false;
    return true;
  }
  function edgeAllowed(e) {
    return e.kinds.some((k) => (k === 'global' ? S.opts.global : k === 'ref' ? S.opts.refs : true));
  }
  function refreshVisibility(relayoutNew = true) {
    let newlyShown = 0;
    for (const n of S.nodes.values()) {
      const v = isVisible(n);
      if (v && !n.placed) newlyShown++;
      n.visible = v;
      n.el.style.display = v ? '' : 'none';
    }
    for (const e of S.edges) e.visible = e.s.visible && e.t.visible && edgeAllowed(e);
    if (relayoutNew && newlyShown) { layout(true); positionAll(); }
    computeBBox();
  }

  // ================================================================== layout
  /* Radial layout. Flow mode: ring = import depth from entry points (entry files in the middle).
   * Hubs mode: ring = PageRank order (most depended-upon in the middle).
   * Angular order follows already-placed neighbours, then a small force pass untangles & de-overlaps. */
  function layout(keep) {
    const vis = [...S.nodes.values()].filter((n) => n.visible);
    if (!vis.length) return;
    const visEdges = S.edges.filter((e) => e.visible);
    const adj = new Map(vis.map((n) => [n, []]));
    for (const e of visEdges) { adj.get(e.s)?.push(e.t); adj.get(e.t)?.push(e.s); }

    const ringOf = new Map();
    const core = vis.filter((n) => !n.ext && !n.orphan);
    if (S.opts.mode === 'hubs') {
      const sorted = core.slice().sort((a, b) => b.pagerank - a.pagerank || b.indeg - a.indeg);
      let ring = 0, cap = 1, used = 0;
      for (const n of sorted) {
        if (used >= cap) { ring++; used = 0; cap = ring === 1 ? 6 : Math.round(cap * 1.8); }
        ringOf.set(n, ring); used++;
      }
    } else {
      for (const n of core) ringOf.set(n, n.depth ?? 0);
    }
    let outer = Math.max(-1, ...ringOf.values()) + 1;
    const orphans = vis.filter((n) => !n.ext && n.orphan);
    if (orphans.length) { orphans.forEach((n) => ringOf.set(n, outer)); outer++; }
    vis.filter((n) => n.ext).forEach((n) => ringOf.set(n, outer));

    const ringIdx = [...new Set(ringOf.values())].sort((a, b) => a - b);
    const rings = ringIdx.map((i) => vis.filter((n) => ringOf.get(n) === i).sort((a, b) => a.id.localeCompare(b.id)));

    // ring radii: big enough to fit the ring's nodes around the circumference
    const radii = [];
    let prevR = 0, prevHalf = 0;
    rings.forEach((ring, i) => {
      const circ = ring.reduce((s, n) => s + Math.max(n.w, n.h * 1.4) + 90, 0);
      const half = Math.max(...ring.map((n) => Math.hypot(n.w, n.h) / 2));
      let R;
      if (i === 0) R = ring.length === 1 ? 0 : Math.max(circ / (2 * Math.PI), half * 1.3);
      else R = Math.max(circ / (2 * Math.PI), prevR + prevHalf + half + 170);
      radii.push(R); prevR = R; prevHalf = half;
    });

    const groups = [...S.groupColors.keys()];
    const groupAngle = (g) => (groups.indexOf(g) / Math.max(1, groups.length)) * Math.PI * 2;
    const angle = new Map();
    rings.forEach((ring) => {
      const desired = ring.map((n) => {
        const placed = adj.get(n).filter((m) => angle.has(m));
        if (placed.length) {
          let sx = 0, sy = 0;
          placed.forEach((m) => { sx += Math.cos(angle.get(m)); sy += Math.sin(angle.get(m)); });
          return { n, a: Math.atan2(sy, sx) };
        }
        return { n, a: groupAngle(n.group) - Math.PI + 0.001 * ring.indexOf(n) };
      });
      desired.sort((p, q) => p.a - q.a);
      const m = desired.length;
      let sx = 0, sy = 0;
      desired.forEach((d, j) => { const slot = (j * 2 * Math.PI) / m; sx += Math.cos(d.a - slot); sy += Math.sin(d.a - slot); });
      const off = Math.atan2(sy, sx) - Math.PI / 2 * (ring.length === 2 ? 0 : 0);
      desired.forEach((d, j) => angle.set(d.n, off + (j * 2 * Math.PI) / m));
    });

    const targetR = new Map();
    rings.forEach((ring, i) => ring.forEach((n) => targetR.set(n, radii[i])));
    const fixed = (n) => keep && n.placed;
    for (const n of vis) {
      if (fixed(n)) continue;
      const R = targetR.get(n), a = angle.get(n);
      n.x = R * Math.cos(a); n.y = R * Math.sin(a) * 0.85;
    }

    const movable = vis.filter((n) => !fixed(n));
    if (movable.length) {
      const iters = keep ? 140 : 320;
      for (let it = 0; it < iters; it++) {
        const alpha = 1 - it / iters;
        for (const e of visEdges) {
          const a = e.s, b = e.t;
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          const f = ((d - 460) / d) * 0.018 * alpha;
          if (!fixed(a)) { a.x += dx * f; a.y += dy * f; }
          if (!fixed(b)) { b.x -= dx * f; b.y -= dy * f; }
        }
        for (const n of movable) {
          const R = targetR.get(n);
          const d = Math.hypot(n.x, n.y / 0.85);
          if (R === 0) { n.x *= 0.85; n.y *= 0.85; continue; }
          if (d < 1e-3) { n.x = R; continue; }
          const f = ((R - d) / d) * 0.22;
          n.x += n.x * f; n.y += n.y * f;
        }
        collide(vis, fixed, 46);
      }
      for (let it = 0; it < 120; it++) if (!collide(vis, fixed, 46)) break;
    }
    vis.forEach((n) => { n.placed = true; });
  }

  function collide(list, fixed, pad) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + pad - Math.abs(dx);
        if (ox <= 0) continue;
        const oy = (a.h + b.h) / 2 + pad - Math.abs(dy);
        if (oy <= 0) continue;
        moved = true;
        const fa = fixed(a) ? 0 : fixed(b) ? 1 : 0.5;
        const fb = fixed(b) ? 0 : fixed(a) ? 1 : 0.5;
        if (ox < oy) {
          const s = (dx >= 0 ? 1 : -1) * (ox + 0.5);
          a.x -= s * fa; b.x += s * fb;
        } else {
          const s = (dy >= 0 ? 1 : -1) * (oy + 0.5);
          a.y -= s * fa; b.y += s * fb;
        }
      }
    }
    return moved;
  }

  function computeBBox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of S.nodes.values()) {
      if (!n.visible || n.x == null) continue;
      x0 = Math.min(x0, n.x - n.w / 2); y0 = Math.min(y0, n.y - n.h / 2);
      x1 = Math.max(x1, n.x + n.w / 2); y1 = Math.max(y1, n.y + n.h / 2);
    }
    S.bbox = x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  // ================================================================ camera
  function applyTransform() {
    world.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.k})`;
    world.style.setProperty('--inv', String(1 / S.k));
    const lv = S.k < LEVEL_MAX[0] ? 0 : S.k < LEVEL_MAX[1] ? 1 : S.k < LEVEL_MAX[2] ? 2 : 3;
    if (lv !== S.level) {
      viewport.classList.remove('lv0', 'lv1', 'lv2', 'lv3');
      viewport.classList.add('lv' + lv);
      S.level = lv;
      for (const n of S.nodes.values()) n.geom = null;
      document.querySelectorAll('#zoombar button').forEach((b) => b.classList.toggle('on', +b.dataset.lv === lv));
    }
    let gs = 24 * S.k;
    while (gs < 14) gs *= 2;
    while (gs > 40) gs /= 2;
    viewport.style.backgroundSize = `${gs}px ${gs}px`;
    viewport.style.backgroundPosition = `${S.tx}px ${S.ty}px`;
    scheduleFrame();
  }

  let frameQueued = false;
  function scheduleFrame() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      renderEdges();
      drawMinimap();
      if (S.level === 3) loadVisibleCode();
    });
  }

  function zoomAt(cx, cy, k) {
    k = clamp(k, 0.03, 9);
    S.tx = cx - (cx - S.tx) * (k / S.k);
    S.ty = cy - (cy - S.ty) * (k / S.k);
    S.k = k;
    applyTransform();
  }

  /** Screen point that counts as "the middle": left of the details panel when it is open. */
  function screenCenter() {
    const open = !panel.classList.contains('hidden') && window.innerWidth > 760;
    const pw = open ? panel.offsetWidth + 24 : 0;
    return { x: (vpRect.width - pw) / 2, y: vpRect.height / 2, w: vpRect.width - pw, h: vpRect.height };
  }

  let flight = null;
  function flyTo(x, y, k, ms = 520, done) {
    cancelAnimationFrame(flight);
    vpRect = viewport.getBoundingClientRect();
    const sc = screenCenter();
    const k0 = S.k, c0x = (sc.x - S.tx) / k0, c0y = (sc.y - S.ty) / k0;
    if (ms <= 0) { S.k = k; S.tx = sc.x - x * k; S.ty = sc.y - y * k; applyTransform(); done && done(); return; }
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = ease(t);
      const kt = Math.exp(Math.log(k0) + (Math.log(k) - Math.log(k0)) * e);
      const cx = c0x + (x - c0x) * e, cy = c0y + (y - c0y) * e;
      S.k = kt; S.tx = sc.x - cx * kt; S.ty = sc.y - cy * kt;
      applyTransform();
      if (t < 1) flight = requestAnimationFrame(step); else done && done();
    };
    flight = requestAnimationFrame(step);
  }

  function fit(animate = true) {
    vpRect = viewport.getBoundingClientRect();
    computeBBox();
    if (!S.bbox) return;
    const { x0, y0, x1, y1 } = S.bbox;
    const sc = screenCenter();
    const k = clamp(Math.min((sc.w - 60) / (x1 - x0), (sc.h - 90) / (y1 - y0)), 0.03, 1.1);
    flyTo((x0 + x1) / 2, (y0 + y1) / 2, k, animate ? 450 : 0);
  }

  function viewRectWorld(margin = 0) {
    return { x0: (-S.tx) / S.k - margin, y0: (-S.ty) / S.k - margin, x1: (vpRect.width - S.tx) / S.k + margin, y1: (vpRect.height - S.ty) / S.k + margin };
  }

  // ================================================================= edges
  function borderPoint(n, tx, ty) {
    const dx = tx - n.x, dy = ty - n.y;
    if (!dx && !dy) return { x: n.x, y: n.y };
    const s = Math.min((n.w / 2) / Math.abs(dx || 1e-9), (n.h / 2) / Math.abs(dy || 1e-9));
    return { x: n.x + dx * s, y: n.y + dy * s };
  }
  function arrowHead(p, ang, s) {
    const a1 = ang + Math.PI - 0.42, a2 = ang + Math.PI + 0.42;
    return `M${r1(p.x)},${r1(p.y)}L${r1(p.x + s * Math.cos(a1))},${r1(p.y + s * Math.sin(a1))}L${r1(p.x + s * Math.cos(a2))},${r1(p.y + s * Math.sin(a2))}Z`;
  }

  function borderPath(e, arrow) {
    const a = e.s, b = e.t;
    const p0 = borderPoint(a, b.x, b.y), p1 = borderPoint(b, a.x, a.y);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const cx = (p0.x + p1.x) / 2 - dy * 0.12, cy = (p0.y + p1.y) / 2 + dx * 0.12;
    const ang = Math.atan2(p1.y - cy, p1.x - cx);
    return [`M${r1(p0.x)},${r1(p0.y)}Q${r1(cx)},${r1(cy)} ${r1(p1.x)},${r1(p1.y)}`, arrowHead(p1, ang, arrow)];
  }

  function srcKey(n, line) {
    let best = null;
    for (const r of n.ranges) if (r.line <= line && line <= r.end && (!best || r.line >= best.line)) best = r;
    return best ? best.key : 'hdr';
  }
  function edgePairs(e) {
    if (e.pairs) return e.pairs;
    const m = new Map();
    for (const [line, sym] of e.uses) {
      const key = srcKey(e.s, line) + '|' + (e.t.symIndex.get(sym) || 'hdr');
      m.set(key, (m.get(key) || 0) + 1);
    }
    if (!m.size) m.set('hdr|hdr', 1);
    e.pairs = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, c]) => { const [sk, tk] = k.split('|'); return { sk, tk, c }; });
    return e.pairs;
  }
  function rowGeom(n) {
    if (n.geom) return n.geom;
    if (!n.listEl || n.listEl.offsetParent === null) return null;
    const rows = new Map();
    for (const r of n.listEl.children) rows.set(r.dataset.key, { top: r.offsetTop, h: r.offsetHeight });
    n.geom = { listTop: n.listEl.offsetTop, listH: n.listEl.clientHeight, rows, headY: n.headEl.offsetTop + n.headEl.offsetHeight / 2 };
    return n.geom;
  }
  function rowY(n, g, key) {
    const r = key !== 'hdr' && g.rows.get(key);
    if (!r) return n.y - n.h / 2 + g.headY;
    const y = clamp(r.top - n.listEl.scrollTop + r.h / 2, g.listTop + 2, g.listTop + g.listH - 2);
    return n.y - n.h / 2 + y;
  }
  function symbolPaths(e, arrow) {
    const a = e.s, b = e.t;
    const ga = rowGeom(a), gb = rowGeom(b);
    if (!ga || !gb) return null;
    const overlapX = Math.abs(b.x - a.x) < (a.w + b.w) / 2 + 30;
    const dir = b.x >= a.x ? 1 : -1;
    let line = '', head = '';
    for (const p of edgePairs(e)) {
      const y0 = rowY(a, ga, p.sk), y1 = rowY(b, gb, p.tk);
      let x0, x1, c0, c1, ang;
      if (overlapX) {           // stacked vertically: loop out of the right side of both
        x0 = a.x + a.w / 2; x1 = b.x + b.w / 2;
        const bulge = 60 + Math.abs(y1 - y0) * 0.12;
        c0 = Math.max(x0, x1) + bulge; c1 = c0; ang = Math.PI;
      } else {
        x0 = a.x + dir * a.w / 2; x1 = b.x - dir * b.w / 2;
        const c = Math.max(30, Math.abs(x1 - x0) * 0.45);
        c0 = x0 + dir * c; c1 = x1 - dir * c; ang = dir > 0 ? 0 : Math.PI;
      }
      line += `M${r1(x0)},${r1(y0)}C${r1(c0)},${r1(y0)} ${r1(c1)},${r1(y1)} ${r1(x1)},${r1(y1)}`;
      head += arrowHead({ x: x1, y: y1 }, ang, arrow * 0.7);
    }
    return [line, head];
  }

  function ensureEdgeEl(e) {
    if (e.g) return;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `edge k-${e.cls}${e.cycle ? ' cyc' : ''}`);
    const hit = document.createElementNS(NS, 'path'); hit.setAttribute('class', 'hit');
    const line = document.createElementNS(NS, 'path'); line.setAttribute('class', 'line');
    const arrow = document.createElementNS(NS, 'path'); arrow.setAttribute('class', 'arrow');
    g.append(line, arrow, hit);
    hit.addEventListener('pointerenter', (ev) => { g.classList.add('hover'); showEdgeTip(e, ev); });
    hit.addEventListener('pointermove', (ev) => moveTip(ev));
    hit.addEventListener('pointerleave', () => { g.classList.remove('hover'); hideTip(); });
    hit._edge = e;
    Object.assign(e, { g, hitEl: hit, lineEl: line, arrowEl: arrow, lastD: null });
    svg.appendChild(g);
  }

  function renderEdges() {
    const arrow = clamp(8 / S.k, 2.2, 30);
    const symbolMode = S.level === 2;
    for (const e of S.edges) {
      if (!e.visible) { if (e.g) e.g.style.display = 'none'; continue; }
      ensureEdgeEl(e);
      e.g.style.display = '';
      let res = symbolMode && !e.s.ext && !e.t.ext ? symbolPaths(e, arrow) : null;
      if (!res) res = borderPath(e, arrow);
      if (res[0] !== e.lastD) {
        e.lineEl.setAttribute('d', res[0]);
        e.hitEl.setAttribute('d', res[0]);
        e.lastD = res[0];
      }
      e.arrowEl.setAttribute('d', res[1]);
      e.lineEl.style.strokeWidth = (symbolMode ? 1.1 : e.width) + 'px';
    }
  }

  // ================================================================== code
  function highlight(text, lang) {
    const hl = window.hljs;
    if (hl && text.length < 600000) {
      try { return hl.highlight(text, { language: HLJS_LANG[lang] || 'plaintext', ignoreIllegals: true }).value; } catch { /* fall through */ }
    }
    return esc(text);
  }

  function loadVisibleCode() {
    const vr = viewRectWorld(200);
    for (const n of S.nodes.values()) {
      if (!n.visible || n.ext || n.codeShown === n.mtime) continue;
      if (n.x + n.w / 2 < vr.x0 || n.x - n.w / 2 > vr.x1 || n.y + n.h / 2 < vr.y0 || n.y - n.h / 2 > vr.y1) continue;
      renderCode(n);
    }
  }

  async function renderCode(n) {
    n.codeShown = n.mtime;
    let entry = S.code.get(n.id);
    if (!entry || entry.mtime !== n.mtime) {
      try {
        const r = await fetch('/api/file?id=' + encodeURIComponent(n.id)).then((x) => x.json());
        entry = { mtime: n.mtime, text: r.text ?? '' };
        S.code.set(n.id, entry);
      } catch {
        n.codeEl.innerHTML = '<div class="code-msg">Could not load this file.</div>';
        n.codeShown = null;
        return;
      }
    }
    const text = entry.text.replace(/\r\n?/g, '\n');
    const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const gutter = Array.from({ length: Math.max(1, count) }, (_, i) => i + 1).join('\n');
    n.codeEl.innerHTML = `<div class="code-inner"><pre class="gutter">${gutter}</pre><pre class="src hljs"><code>${highlight(text, n.lang)}</code></pre><div class="hlband hidden"></div></div>`;
    n.codeEl.scrollTop = 0;
    if (n.pendingLine) { scrollCodeTo(n, n.pendingLine); n.pendingLine = null; }
  }

  function scrollCodeTo(n, line) {
    const band = n.codeEl.querySelector('.hlband');
    if (!band) { n.pendingLine = line; return; }
    const lh = 5.4;
    band.style.top = (2 + (line - 1) * lh) + 'px';
    band.classList.remove('hidden');
    n.codeEl.scrollTop = Math.max(0, (line - 1) * lh - n.codeEl.clientHeight * 0.25);
  }

  function openCode(n, line, ms = 560) {
    if (n.ext) return;
    vpRect = viewport.getBoundingClientRect();
    const sc = screenCenter();
    const k = Math.max(LEVEL_MAX[2] + 0.2, Math.min((sc.w * 0.9) / n.w, (sc.h * 0.88) / n.h));
    if (line) n.pendingLine = line;
    // if the file is wider than the free space, keep its left edge (line numbers) on screen
    const cx = n.w * k > sc.w - 40 ? n.x - n.w / 2 + (sc.w / 2 - 20) / k : n.x;
    const cy = n.h * k > sc.h - 40 ? n.y - n.h / 2 + (sc.h / 2 - 20) / k : n.y;
    flyTo(cx, cy, k, ms, () => {
      if (line && n.codeShown === n.mtime && n.codeEl.querySelector('.hlband')) { scrollCodeTo(n, line); n.pendingLine = null; }
    });
  }

  // ============================================================== selection
  function select(n, { fly = false, keepPanel = false } = {}) {
    S.selected = n;
    const outN = new Set(), inN = new Set();
    const vis = S.edges.filter((e) => e.visible);
    if (S.opts.transitive) {
      const walk = (start, fwd, set) => {
        const q = [start];
        while (q.length) {
          const u = q.pop();
          for (const e of vis) {
            const [from, to] = fwd ? [e.s, e.t] : [e.t, e.s];
            if (from === u && to !== n && !set.has(to)) { set.add(to); q.push(to); }
          }
        }
      };
      walk(n, true, outN); walk(n, false, inN);
    } else {
      for (const e of vis) { if (e.s === n) outN.add(e.t); if (e.t === n) inN.add(e.s); }
    }
    viewport.classList.add('focusing');
    for (const m of S.nodes.values()) {
      m.el.classList.toggle('sel', m === n);
      m.el.classList.toggle('f-out', outN.has(m));
      m.el.classList.toggle('f-in', inN.has(m) && !outN.has(m));
    }
    for (const e of S.edges) {
      if (e.visible) ensureEdgeEl(e);
      if (!e.g) continue;
      const isOut = S.opts.transitive ? (e.s === n || outN.has(e.s)) && outN.has(e.t) : e.s === n;
      const isIn = S.opts.transitive ? (e.t === n || inN.has(e.t)) && inN.has(e.s) : e.t === n;
      e.g.classList.toggle('f-out', isOut);
      e.g.classList.toggle('f-in', isIn && !isOut);
    }
    // mark the symbols this file uses inside the files it imports
    document.querySelectorAll('.row.used').forEach((r) => r.classList.remove('used'));
    for (const e of vis) {
      if (e.s !== n) continue;
      for (const sym of e.symbols) {
        const key = e.t.symIndex.get(sym);
        if (key) e.t.listEl?.querySelector(`[data-key="${key}"]`)?.classList.add('used');
      }
    }
    renderPanel(n);
    writeHash(n);
    if (fly) {
      flyTo(n.x, n.y, clamp(Math.max(S.k, 0.75), 0.75, 1.25));
    }
    scheduleFrame();
  }

  function clearSelection() {
    S.selected = null;
    viewport.classList.remove('focusing');
    for (const m of S.nodes.values()) m.el.classList.remove('sel', 'f-out', 'f-in');
    for (const e of S.edges) e.g?.classList.remove('f-out', 'f-in');
    document.querySelectorAll('.row.used').forEach((r) => r.classList.remove('used'));
    if (!panel.classList.contains('hidden')) writeHash(null);
    panel.classList.add('hidden');
  }

  function revealNode(n) {
    if (n.visible) return;
    S.hiddenGroups.delete(n.group);
    if (n.orphan) S.opts.orphans = true;
    if (n.lang === 'css') S.opts.css = true;
    if (n.ext) S.opts.externals = true;
    syncOptionInputs(); saveOpts();
    refreshVisibility(); renderLegend(); positionAll(); scheduleFrame();
  }

  // ================================================================== panel
  function renderPanel(n) {
    panel.classList.remove('hidden');
    const outE = S.edges.filter((e) => e.s === n && e.cls !== 'external');
    const inE = S.edges.filter((e) => e.t === n);
    const link = (e, other) => `<div class="plink" data-goto="${esc(other.id)}"><div class="pn">${esc(other.name)} <span style="color:var(--faint);font-weight:400;font-size:11px">${esc(e.kinds.map((k) => KIND_LABEL[k] || k).join(', '))}</span></div>` +
      (e.symbols.length ? `<div class="ps">${esc(e.symbols.slice(0, 10).join(', '))}${e.symbols.length > 10 ? ` +${e.symbols.length - 10}` : ''}</div>` : '') + '</div>';
    if (n.ext) {
      panel.innerHTML = `<div class="p-head"><span class="badge b-ext">PKG</span><h2>${esc(n.name)}</h2><button class="x" data-close>×</button></div>
        <div class="path">external ${esc(n.extLang)} package</div>
        <h3><span class="dot" style="background:var(--in)"></span>Used by (${inE.length})</h3>${inE.map((e) => link(e, e.s)).join('') || '<div class="none">—</div>'}`;
      return;
    }
    const symHtml = n.symbols.filter((s) => s.kind !== 'var').slice(0, 300).map((s) =>
      `<div class="psym${s.kind === 'method' ? ' m' : ''}" data-line="${s.line}" title="${esc(s.doc || '')}"><span class="k">${KIND_ICON[s.kind] || '•'}</span><span class="n">${esc(s.kind === 'method' ? s.name.split('::').pop() : s.name)}${s.sig ? `<span style="color:var(--faint)">${esc(s.sig.length > 46 ? s.sig.slice(0, 44) + '…)' : s.sig)}</span>` : ''}</span><span class="l">${s.line}</span></div>`).join('');
    const vars = n.symbols.filter((s) => s.kind === 'var');
    panel.innerHTML = `
      <div class="p-head"><span class="badge b-${n.lang}">${LANG_LABEL[n.lang]}</span><h2 title="${esc(n.name)}">${esc(n.name)}</h2><button class="x" data-close title="Close (Esc)">×</button></div>
      <div class="path">${esc(n.id)}</div>
      ${n.doc ? `<p class="pdoc">${esc(n.doc)}</p>` : ''}
      ${n.error ? `<div class="perr">${esc(n.error)}</div>` : ''}
      <div class="acts"><button data-code>Read code</button><button data-open>Open in editor</button></div>
      <div class="grid">
        <div class="stat"><div class="v">${n.lines}</div><div class="l">lines</div></div>
        <div class="stat"><div class="v">${n.outdeg}</div><div class="l">imports</div></div>
        <div class="stat"><div class="v">${n.indeg}</div><div class="l">used by</div></div>
        <div class="stat"><div class="v">${n.depth ?? '—'}</div><div class="l">depth from entry</div></div>
        <div class="stat"><div class="v">${Math.round(n.pagerank * 100)}</div><div class="l">centrality</div></div>
        <div class="stat"><div class="v">${n.entry ? '★' : n.orphan ? '∅' : '·'}</div><div class="l">${n.entry ? 'entry point' : n.orphan ? 'unconnected' : 'module'}</div></div>
      </div>
      <h3><span class="dot" style="background:var(--out)"></span>Imports (${outE.length})</h3>
      ${outE.map((e) => link(e, e.t)).join('') || '<div class="none">Nothing in this project</div>'}
      <h3><span class="dot" style="background:var(--in)"></span>Used by (${inE.length})</h3>
      ${inE.map((e) => link(e, e.s)).join('') || '<div class="none">Nothing in this project</div>'}
      ${n.externals.length ? `<h3>Packages</h3><div class="pchips">${n.externals.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
      ${n.stdlib.length ? `<h3>Standard library</h3><div class="pchips">${n.stdlib.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
      <h3>Definitions (${n.symbols.length - vars.length})</h3>
      ${symHtml || '<div class="none">None found</div>'}
      ${vars.length ? `<h3>Module variables (${vars.length})</h3><div class="pchips">${vars.slice(0, 60).map((v) => `<span class="chip psym-var" data-line="${v.line}" style="cursor:pointer">${esc(v.name)}</span>`).join('')}</div>` : ''}`;
  }

  panel.addEventListener('click', (ev) => {
    const n = S.selected;
    if (!n) return;
    if (ev.target.closest('[data-close]')) return clearSelection();
    if (ev.target.closest('[data-code]')) return openCode(n, n.symbols[0]?.line || 1);
    if (ev.target.closest('[data-open]')) {
      fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: n.id, line: 1 }) })
        .then((r) => r.json()).then((r) => toast(r.ok ? `Opened in ${r.editor}` : 'Could not open the file'));
      return;
    }
    const go = ev.target.closest('[data-goto]');
    if (go) { const m = S.nodes.get(go.dataset.goto); if (m) { revealNode(m); select(m, { fly: true }); flash(m); } return; }
    const sym = ev.target.closest('[data-line]');
    if (sym) openCode(n, +sym.dataset.line);
  });

  function flash(n) { n.el.classList.remove('flash'); void n.el.offsetWidth; n.el.classList.add('flash'); }

  // ================================================================ tooltip
  function showEdgeTip(e, ev) {
    const kinds = e.kinds.map((k) => KIND_LABEL[k] || k).join(', ');
    const syms = e.symbols.slice(0, 14).join(', ') + (e.symbols.length > 14 ? `, +${e.symbols.length - 14} more` : '');
    tooltip.innerHTML = `<div class="tt-t">${esc(e.s.name)} → ${esc(e.t.name)}${e.cycle ? ' <span style="color:var(--cycle)">⟳ circular</span>' : ''}</div>` +
      `<div class="tt-s">${esc(kinds)}${e.symbols.length ? ` · ${e.symbols.length} name${e.symbols.length > 1 ? 's' : ''}` : ''}${syms ? '<br>' + esc(syms) : ''}</div>`;
    tooltip.classList.remove('hidden');
    moveTip(ev);
  }
  function showRowTip(n, row, ev) {
    const name = row.dataset.sym;
    const sym = n.symbols.find((s) => s.name === name);
    const users = S.edges.filter((e) => e.t === n && e.symbols.includes(name.split('::').pop())).map((e) => e.s.name);
    tooltip.innerHTML = `<div class="tt-t">${esc(name)}${sym?.sig ? `<span style="color:var(--muted);font-weight:400">${esc(sym.sig)}</span>` : ''}</div>` +
      `<div class="tt-s">${sym ? `${esc(sym.kind)} · lines ${sym.line}–${sym.end}` : ''}${sym?.doc ? '<br>' + esc(sym.doc) : ''}` +
      `${users.length ? `<br><span style="color:var(--in)">used by ${esc(users.join(', '))}</span>` : ''}<br><span style="color:var(--faint)">click to read code</span></div>`;
    tooltip.classList.remove('hidden');
    moveTip(ev);
  }
  function moveTip(ev) {
    const x = Math.min(ev.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
  }
  function hideTip() { tooltip.classList.add('hidden'); }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ========================================================= project picker
  const picker = $('#picker');
  const PK = { path: null, status: null, busy: false };
  const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  async function openPicker(solo = false) {
    picker.classList.remove('hidden');
    picker.classList.toggle('solo', solo || !S.graph);
    pkStatus(null);
    try { PK.status = await fetch('/api/status').then((r) => r.json()); } catch { PK.status = { recent: [], nativePicker: false }; }
    $('#pkNative').classList.toggle('hidden', !PK.status.nativePicker);
    renderRecent();
    const start = S.graph?.root ? S.graph.root.replace(/[\\/][^\\/]+$/, '') : (PK.status.recent[0] ? PK.status.recent[0].replace(/[\\/][^\\/]+$/, '') : null);
    await browseTo(PK.path || start);
    (PK.status.nativePicker ? $('#pkNative') : $('#pkPath')).focus();
  }
  function closePicker() {
    if (!S.graph) return; // nothing to go back to
    picker.classList.add('hidden');
  }
  function pkStatus(msg, err = false) {
    const el = $('#pkStatus');
    el.classList.toggle('hidden', !msg);
    el.classList.toggle('err', err);
    el.textContent = msg || '';
  }

  function renderRecent() {
    const rec = PK.status?.recent || [];
    $('#pkRecent').innerHTML = rec.length
      ? rec.map((p) => `<div class="pk-rec${S.graph?.root === p ? ' cur' : ''}" data-path="${esc(p)}" title="${esc(p)}"><div class="n">${esc(baseName(p))}</div><div class="p">${esc(p)}</div></div>`).join('')
      : '<div class="pk-empty">Projects you open will show up here.</div>';
  }

  async function browseTo(path) {
    let d;
    try { d = await fetch('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : '')).then((r) => r.json()); }
    catch { pkStatus('Could not reach the CodeGraph server.', true); return; }
    PK.path = d.path;
    $('#pkPath').value = d.path;
    // breadcrumbs
    const parts = d.path.split(/[\\/]/);
    const crumbs = [];
    let acc = '';
    parts.forEach((p, i) => {
      acc = i === 0 ? (p || d.sep) : (acc.endsWith(d.sep) ? acc + p : acc + d.sep + p);
      if (i > 0 && !p) return;
      crumbs.push(`<button data-path="${esc(acc)}">${esc(i === 0 ? (p || d.sep) : p)}</button>`);
    });
    const rootEndsWithSep = /[\\/]$/.test(parts[0] || d.sep);
    $('#pkCrumbs').innerHTML = crumbs.map((c, i) => (i === 0 || (i === 1 && rootEndsWithSep) ? '' : `<span class="sep">${esc(d.sep)}</span>`) + c).join('');
    const up = d.parent ? `<div class="pk-dir" data-path="${esc(d.parent)}">${FOLDER_ICON}<span class="nm">..</span></div>` : '';
    $('#pkList').innerHTML = d.error ? `${up}<div class="pk-empty">${esc(d.error)}</div>`
      : up + (d.dirs.length ? d.dirs.map((x) =>
        `<div class="pk-dir${x.project ? ' proj' : ''}" data-path="${esc(x.path)}" title="Click to open the folder · double-click to map it">${FOLDER_ICON}<span class="nm">${esc(x.name)}</span>` +
        `${x.project ? '<span class="tag">code</span>' : ''}<span class="go">double-click to map</span></div>`).join('') : '<div class="pk-empty">No subfolders here.</div>');
    $('#pkList').scrollTop = 0;
    $('#pkHereInfo').textContent = d.codeHere ? `${d.codeHere} source file${d.codeHere > 1 ? 's' : ''} directly in ${baseName(d.path)}` : d.isProject ? `${baseName(d.path)} looks like a project` : '';
    $('#pkOpenHere').textContent = `Map “${baseName(d.path)}”`;
  }

  async function openProject(path) {
    if (PK.busy || !path) return;
    PK.busy = true;
    $('#pkNative').disabled = true;
    pkStatus(`Mapping ${baseName(path)}…`);
    try {
      const r = await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
      const res = await r.json();
      if (!res.ok) { pkStatus(res.error || 'Could not open that folder.', true); return; }
      PK.path = null;
      await loadGraph(true);
      picker.classList.add('hidden');
      if (!res.files) toast('No Python, C/C++, JS/TS, HTML or CSS files in that folder.', 4000);
    } catch (err) {
      pkStatus('Could not open that folder: ' + err.message, true);
    } finally {
      PK.busy = false;
      $('#pkNative').disabled = false;
    }
  }

  $('#btnOpen').addEventListener('click', () => openPicker());
  $('#pkClose').addEventListener('click', closePicker);
  picker.addEventListener('mousedown', (ev) => { if (ev.target === picker) closePicker(); });
  $('#pkNative').addEventListener('click', async () => {
    if (PK.busy) return;
    $('#pkNative').disabled = true;
    pkStatus('A folder dialog is open. It may be behind this window.');
    try {
      const r = await fetch('/api/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: PK.path }) }).then((x) => x.json());
      $('#pkNative').disabled = false;
      if (!r.ok) { pkStatus(r.error || 'The folder dialog is not available. Browse below instead.', true); return; }
      if (!r.path) { pkStatus(null); return; } // cancelled
      await openProject(r.path);
    } catch {
      $('#pkNative').disabled = false;
      pkStatus('Could not open the folder dialog. Browse below instead.', true);
    }
  });
  $('#pkForm').addEventListener('submit', (ev) => { ev.preventDefault(); browseTo($('#pkPath').value.trim()); });
  $('#pkOpenHere').addEventListener('click', () => openProject(PK.path));
  $('#pkCrumbs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-path]'); if (b) browseTo(b.dataset.path); });
  $('#pkRecent').addEventListener('click', (ev) => { const r = ev.target.closest('[data-path]'); if (r) openProject(r.dataset.path); });
  let pkClickTimer = null;
  $('#pkList').addEventListener('click', (ev) => {
    const d = ev.target.closest('[data-path]');
    if (!d) return;
    clearTimeout(pkClickTimer);
    pkClickTimer = setTimeout(() => browseTo(d.dataset.path), 230);
  });
  $('#pkList').addEventListener('dblclick', (ev) => {
    const d = ev.target.closest('[data-path]');
    if (!d || d.querySelector('.nm').textContent === '..') return;
    clearTimeout(pkClickTimer);
    openProject(d.dataset.path);
  });

  // ============================================================ interaction
  let drag = null, lastClick = { id: null, t: 0 };
  viewport.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    hideTip();
    const nodeEl = ev.target.closest('.node');
    if (nodeEl && S.level === 3 && ev.target.closest('.code')) return; // let people select code text
    const edgeHit = ev.target.closest('.hit');
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, tx: S.tx, ty: S.ty, moved: false, target: ev.target,
      node: nodeEl ? S.nodes.get(nodeEl.dataset.id) : null, edge: edgeHit ? edgeHit._edge : null };
    if (drag.node) { drag.nx = drag.node.x; drag.ny = drag.node.y; }
    viewport.setPointerCapture(ev.pointerId);
  });
  viewport.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const row = S.level === 2 && ev.target.closest && ev.target.closest('.row[data-sym]');
      if (row) { const n = S.nodes.get(row.closest('.node').dataset.id); if (n) showRowTip(n, row, ev); }
      else if (!ev.target.closest?.('.hit')) hideTip();
      return;
    }
    if (ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.node) {
      drag.node.x = drag.nx + dx / S.k; drag.node.y = drag.ny + dy / S.k;
      positionNode(drag.node);
      scheduleFrame();
    } else {
      viewport.classList.add('panning');
      S.tx = drag.tx + dx; S.ty = drag.ty + dy;
      applyTransform();
    }
  });
  const endDrag = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag; drag = null;
    viewport.classList.remove('panning');
    if (d.moved) { if (d.node) computeBBox(); return; }
    if (d.node) {
      const now = performance.now();
      const dbl = lastClick.id === d.node.id && now - lastClick.t < 380;
      lastClick = { id: d.node.id, t: now };
      const row = d.target.closest && d.target.closest('.row[data-line]');
      if (row && S.level === 2) { select(d.node); openCode(d.node, +row.dataset.line); return; }
      if (dbl) { openCode(d.node, d.node.symbols[0]?.line); return; }
      select(d.node);
    } else if (d.edge) {
      select(d.edge.t, { fly: true }); flash(d.edge.t);
    } else {
      clearSelection();
    }
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  viewport.addEventListener('wheel', (ev) => {
    const sel = S.level === 3 ? '.code' : S.level === 2 ? '.syms' : null;
    const sc = sel && ev.target.closest && ev.target.closest(sel);
    if (sc && !ev.ctrlKey) {
      const canY = (ev.deltaY > 0 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) || (ev.deltaY < 0 && sc.scrollTop > 0);
      const canX = (ev.deltaX > 0 && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1) || (ev.deltaX < 0 && sc.scrollLeft > 0);
      if (canY || canX) return; // native scroll inside the code / symbol list
    }
    ev.preventDefault();
    const px = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? vpRect.height : 1;
    if (ev.ctrlKey || S.opts.wheel === 'zoom') {
      const f = Math.exp(-ev.deltaY * px * (ev.ctrlKey ? 0.009 : 0.0016));
      zoomAt(ev.clientX - vpRect.left, ev.clientY - vpRect.top, S.k * f);
    } else {
      S.tx -= ev.deltaX * px; S.ty -= ev.deltaY * px;
      applyTransform();
    }
  }, { passive: false });

  // Safari trackpad pinch
  let gestureK = 1;
  viewport.addEventListener('gesturestart', (ev) => { ev.preventDefault(); gestureK = S.k; });
  viewport.addEventListener('gesturechange', (ev) => { ev.preventDefault(); zoomAt(ev.clientX - vpRect.left, ev.clientY - vpRect.top, gestureK * ev.scale); });

  nodesEl.addEventListener('scroll', () => scheduleFrame(), true); // symbol lists move edge anchors

  let firstSize = true;
  new ResizeObserver(() => {
    const was = vpRect;
    vpRect = viewport.getBoundingClientRect();
    // the page may load while hidden (0×0); fit once we actually have a size
    if ((firstSize || was.width === 0) && vpRect.width > 0 && S.graph) { firstSize = false; fit(false); }
    applyTransform();
  }).observe(viewport);

  // ================================================================ toolbar
  document.querySelectorAll('#layoutSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === S.opts.mode);
    b.addEventListener('click', () => {
      S.opts.mode = b.dataset.mode; saveOpts();
      document.querySelectorAll('#layoutSeg button').forEach((x) => x.classList.toggle('on', x === b));
      relayout();
    });
  });
  function relayout() {
    for (const n of S.nodes.values()) n.placed = false;
    layout(false); positionAll(); fit(); scheduleFrame();
  }
  $('#btnFit').addEventListener('click', () => fit());
  $('#btnRelayout').addEventListener('click', relayout);
  $('#btnView').addEventListener('click', (ev) => { ev.stopPropagation(); $('#viewMenu').classList.toggle('hidden'); });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.menu-wrap')) $('#viewMenu').classList.add('hidden'); });

  function saveOpts() { store.set('opts', S.opts); }
  function syncOptionInputs() {
    document.querySelectorAll('#viewMenu [data-opt]').forEach((inp) => {
      if (inp.type === 'checkbox') inp.checked = !!S.opts[inp.dataset.opt]; else inp.value = S.opts[inp.dataset.opt];
    });
  }
  syncOptionInputs();
  document.querySelectorAll('#viewMenu [data-opt]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.opt;
      S.opts[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
      saveOpts();
      if (k === 'transitive') { if (S.selected) select(S.selected); return; }
      if (k === 'wheel') return;
      refreshVisibility(); positionAll(); renderLegend();
      if (S.selected) { if (S.selected.visible) select(S.selected); else clearSelection(); }
      scheduleFrame();
    });
  });

  document.querySelectorAll('#zoombar button').forEach((b) => b.addEventListener('click', () => {
    const lv = +b.dataset.lv;
    if (lv === 0) return fit();
    const n = S.selected;
    if (lv === 3 && n) return openCode(n, n.symbols[0]?.line);
    if (n) return flyTo(n.x, n.y, LEVEL_K[lv]);
    const sc = screenCenter();
    flyTo((sc.x - S.tx) / S.k, (sc.y - S.ty) / S.k, LEVEL_K[lv], 380);
  }));

  // ================================================================= legend
  function renderLegend() {
    const counts = new Map();
    for (const n of S.nodes.values()) if (!n.ext || S.opts.externals) counts.set(n.group, (counts.get(n.group) || 0) + 1);
    const items = [...S.groupColors.keys()].filter((g) => counts.has(g)).map((g) =>
      `<div class="lg${S.hiddenGroups.has(g) ? ' off' : ''}" data-group="${esc(g)}" title="Click to show/hide · double-click to show only this">` +
      `<span class="sw" style="background:${S.groupColors.get(g)}"></span><span>${esc(g === '(root)' ? '/ (top level)' : g + '/')}</span><span class="ct">${counts.get(g)}</span></div>`).join('');
    const eg = (cls, label, dash, color) => `<div class="lg-e"><svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''}/></svg>${label}</div>`;
    $('#legend').innerHTML = `<h4>Folders</h4>${items}<div class="lg-edges">
      ${eg('import', 'import / include', '', '#66748a')}
      ${eg('asset', 'script / stylesheet', '', '#b28f63')}
      ${S.opts.global ? eg('global', 'shared global scope', '5 4', '#a586e8') : ''}
      ${S.opts.refs ? eg('ref', 'file path in code', '2 4', '#7f9d6b') : ''}
      ${eg('cyc', 'circular import', '', '#f05d6c')}
      <div class="lg-e" style="margin-top:4px"><span class="sw" style="width:10px;height:10px;border-radius:50%;background:var(--out)"></span>imports (focus)</div>
      <div class="lg-e"><span class="sw" style="width:10px;height:10px;border-radius:50%;background:var(--in)"></span>used by (focus)</div></div>`;
  }
  let legendClickTimer = null;
  $('#legend').addEventListener('click', (ev) => {
    const it = ev.target.closest('[data-group]');
    if (!it) return;
    clearTimeout(legendClickTimer);
    legendClickTimer = setTimeout(() => {
      const g = it.dataset.group;
      if (S.hiddenGroups.has(g)) S.hiddenGroups.delete(g); else S.hiddenGroups.add(g);
      refreshVisibility(); positionAll(); renderLegend();
      if (S.selected && !S.selected.visible) clearSelection();
      scheduleFrame();
    }, 220);
  });
  $('#legend').addEventListener('dblclick', (ev) => {
    const it = ev.target.closest('[data-group]');
    if (!it) return;
    clearTimeout(legendClickTimer);
    const g = it.dataset.group;
    const others = [...S.groupColors.keys()].filter((x) => x !== g);
    const soloAlready = others.every((x) => S.hiddenGroups.has(x)) && !S.hiddenGroups.has(g);
    S.hiddenGroups = soloAlready ? new Set() : new Set(others);
    refreshVisibility(); positionAll(); renderLegend(); fit();
  });

  // ================================================================ minimap
  const mm = $('#minimap'), mctx = mm.getContext('2d');
  function mmScale() {
    const b = S.bbox; if (!b) return null;
    const W = mm.clientWidth, H = mm.clientHeight, pad = 10;
    const s = Math.min((W - 2 * pad) / (b.x1 - b.x0), (H - 2 * pad) / (b.y1 - b.y0));
    const ox = pad + ((W - 2 * pad) - (b.x1 - b.x0) * s) / 2 - b.x0 * s;
    const oy = pad + ((H - 2 * pad) - (b.y1 - b.y0) * s) / 2 - b.y0 * s;
    return { s, ox, oy };
  }
  function drawMinimap() {
    const dpr = window.devicePixelRatio || 1;
    const W = mm.clientWidth, H = mm.clientHeight;
    if (mm.width !== W * dpr) { mm.width = W * dpr; mm.height = H * dpr; }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, W, H);
    const t = mmScale(); if (!t) return;
    for (const n of S.nodes.values()) {
      if (!n.visible) continue;
      const dim = S.selected && !(n === S.selected || n.el.classList.contains('f-out') || n.el.classList.contains('f-in'));
      mctx.globalAlpha = dim ? 0.25 : 0.9;
      mctx.fillStyle = S.groupColors.get(n.group) || '#888';
      mctx.fillRect(n.x * t.s + t.ox - (n.w * t.s) / 2, n.y * t.s + t.oy - (n.h * t.s) / 2, Math.max(2, n.w * t.s), Math.max(1.5, n.h * t.s));
    }
    mctx.globalAlpha = 1;
    const v = viewRectWorld();
    mctx.strokeStyle = 'rgba(255,255,255,0.8)'; mctx.lineWidth = 1;
    mctx.strokeRect(v.x0 * t.s + t.ox, v.y0 * t.s + t.oy, (v.x1 - v.x0) * t.s, (v.y1 - v.y0) * t.s);
  }
  let mmDrag = false;
  const mmMove = (ev) => {
    const t = mmScale(); if (!t) return;
    const r = mm.getBoundingClientRect();
    const x = (ev.clientX - r.left - t.ox) / t.s, y = (ev.clientY - r.top - t.oy) / t.s;
    S.tx = vpRect.width / 2 - x * S.k; S.ty = vpRect.height / 2 - y * S.k;
    applyTransform();
  };
  mm.addEventListener('pointerdown', (ev) => { mmDrag = true; mm.setPointerCapture(ev.pointerId); mmMove(ev); });
  mm.addEventListener('pointermove', (ev) => { if (mmDrag) mmMove(ev); });
  mm.addEventListener('pointerup', () => { mmDrag = false; });

  // ================================================================= search
  const search = $('#search'), results = $('#results');
  let hits = [], hitIdx = 0;
  function score(name, q, path) {
    if (name === q) return 100;
    if (name.startsWith(q)) return 80 - name.length * 0.1;
    const i = name.indexOf(q);
    if (i >= 0) return 60 - i * 0.5;
    if (path && path.includes(q)) return 40;
    let j = 0;
    for (const ch of name) if (ch === q[j]) j++;
    return j === q.length ? 20 - name.length * 0.1 : 0;
  }
  function runSearch() {
    const q = search.value.trim().toLowerCase();
    hits = [];
    if (q) {
      for (const n of S.nodes.values()) {
        const fs = score(n.name.toLowerCase(), q, n.id.toLowerCase());
        if (fs > 0) hits.push({ n, s: fs + 6 });
        if (n.ext) continue;
        for (const sym of n.symbols) {
          if (sym.kind === 'var' && q.length < 3) continue;
          const ss = score(sym.name.toLowerCase(), q);
          if (ss > 0) hits.push({ n, sym, s: ss - (sym.kind === 'var' ? 8 : 0) });
        }
      }
      hits.sort((a, b) => b.s - a.s);
      hits = hits.slice(0, 14);
    }
    hitIdx = 0;
    renderHits();
  }
  function renderHits() {
    if (!hits.length) { results.classList.toggle('hidden', !search.value.trim()); results.innerHTML = search.value.trim() ? '<div class="none" style="padding:8px">No matches</div>' : ''; return; }
    results.classList.remove('hidden');
    results.innerHTML = hits.map((h, i) => h.sym
      ? `<div class="res${i === hitIdx ? ' on' : ''}" data-i="${i}"><span class="badge" style="font-size:10px">${KIND_ICON[h.sym.kind] || '•'}</span><span class="rn">${esc(h.sym.name)}</span><span class="rp">${esc(h.n.id)}:${h.sym.line}</span></div>`
      : `<div class="res${i === hitIdx ? ' on' : ''}" data-i="${i}"><span class="badge b-${h.n.lang}" style="font-size:10px">${LANG_LABEL[h.n.lang]}</span><span class="rn">${esc(h.n.name)}</span><span class="rp">${esc(h.n.dir || '')}</span></div>`).join('');
  }
  function pickHit(h) {
    if (!h) return;
    results.classList.add('hidden');
    search.blur();
    revealNode(h.n);
    select(h.n);
    if (h.sym) openCode(h.n, h.sym.line);
    else { flyTo(h.n.x, h.n.y, clamp(Math.max(S.k, 0.9), 0.9, 1.25)); flash(h.n); }
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('focus', runSearch);
  search.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 150));
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { hitIdx = Math.min(hits.length - 1, hitIdx + 1); renderHits(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { hitIdx = Math.max(0, hitIdx - 1); renderHits(); ev.preventDefault(); }
    else if (ev.key === 'Enter') pickHit(hits[hitIdx]);
    else if (ev.key === 'Escape') { search.value = ''; results.classList.add('hidden'); search.blur(); }
  });
  results.addEventListener('mousedown', (ev) => { const r = ev.target.closest('[data-i]'); if (r) { ev.preventDefault(); pickHit(hits[+r.dataset.i]); } });

  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'o') { ev.preventDefault(); openPicker(); return; }
    if (!picker.classList.contains('hidden')) { if (ev.key === 'Escape') closePicker(); return; }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); search.focus(); search.select(); return; }
    if (ev.target.closest && ev.target.closest('input, select, textarea')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const c = { x: vpRect.width / 2, y: vpRect.height / 2 };
    if (ev.key === '/') { ev.preventDefault(); search.focus(); }
    else if (ev.key === 'f' || ev.key === '0') fit();
    else if (ev.key === 'Escape') { clearSelection(); $('#viewMenu').classList.add('hidden'); }
    else if (ev.key === '+' || ev.key === '=') zoomAt(c.x, c.y, S.k * 1.3);
    else if (ev.key === '-' || ev.key === '_') zoomAt(c.x, c.y, S.k / 1.3);
    else if (['1', '2', '3', '4'].includes(ev.key)) document.querySelector(`#zoombar button[data-lv="${+ev.key - 1}"]`)?.click();
  });

  // ============================================================= live reload
  async function poll() {
    try {
      const { version } = await fetch('/api/version').then((r) => r.json());
      if (version !== S.version) await loadGraph(false);
    } catch { /* server stopped; keep the last view */ }
    setTimeout(poll, 1800);
  }

  // re-highlight any code rendered before highlight.js finished loading
  window.addEventListener('load', () => { for (const n of S.nodes.values()) if (n.codeShown) n.codeShown = null; if (S.level === 3) scheduleFrame(); });

  loadGraph(true).then(() => setTimeout(poll, 1800)).catch((err) => {
    $('#empty').classList.remove('hidden');
    $('#empty').textContent = 'Could not load the graph: ' + err.message;
  });
})();
