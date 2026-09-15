'use strict';
/* film-bench — the canvas.
 *
 * Shots are boards laid out left to right in film order. Takes are cards on
 * the board. One prompt bar at the bottom writes to the board you last
 * clicked; a card you select gets a toolbar and a right-hand panel. Disk is
 * the source of truth and bench.py is its only writer — this file only asks.
 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const api = async (m, p, b) => {
  const r = await fetch(p, b === undefined ? { method: m } : {
    method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
  });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const slugify = (s, n) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, n);
const short = id => (id || '').split('/').pop();
// setPointerCapture throws on a pointer that is already gone (or synthetic); never let that abort a handler
const capture = (n, e) => { try { n.setPointerCapture(e.pointerId); } catch {} };
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
};

/* In-page dialogs. window.prompt/confirm/alert are not usable here: Chrome
   offers "prevent this page from creating additional dialogs", and once that is
   ticked every prompt() returns null and every button that used one becomes a
   silent no-op. */
function ask(message, value) {
  return new Promise(resolve => {
    const box = $('#ask'), input = $('#askInput');
    $('#askMsg').textContent = message;
    input.hidden = value === undefined;
    input.value = value === undefined ? '' : (value || '');
    $('#askYes').textContent = value === undefined ? 'Yes' : 'OK';
    box.hidden = false;
    if (!input.hidden) { input.focus(); input.select(); }
    const done = v => {
      box.hidden = true;
      $('#askYes').onclick = $('#askNo').onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    $('#askYes').onclick = () => done(input.hidden ? true : input.value.trim());
    $('#askNo').onclick = () => done(input.hidden ? false : null);
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
  });
}
const confirmIn = msg => ask(msg);

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

/* ------------------------------------------------------------------ state */
const S = {
  film: null, shotId: null, sel: null,         // sel = take id on the active shot
  armed: false, jobs: new Map(),
  mode: 'frame',                               // 'frame' (still) | 'clip' — stills first, on purpose
  cat: { video: [], image: [] }, filter: '', showAll: false,
  view: { x: 60, y: 60, z: 1 }, side: { open: false, tab: 'take' },
  styleId: null, lb: null, drag: null, space: false,
  fold: 'full'                                 // 'full' | 'compact' | 'folded' — see foldBar()
};
try { S.fold = localStorage.getItem('fb.fold') || 'full'; } catch {}
const KIND = { clip: 'video', frame: 'image' };
S.costs = {};              // per model: what it has actually billed (from /api/costs)
S.batches = [];            // fan-outs in flight, so a finished dry run can be summed
const money = v => v == null ? '?' : '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2));
const BW = 760, GAP = 90, X0 = 60, Y0 = 60;

const shot = () => S.film && S.film.shots.find(s => s.id === S.shotId);
const styles = () => (S.film && S.film.styles) || [];
const takeById = (s, id) => s && s.takes.find(t => t.id === id);

/* ------------------------------------------------------------------- boot */
async function boot() {
  const st = await api('GET', '/api/state');
  S.armed = st.armed; paintArm(); paintSpend(st.spend);
  st.jobs.forEach(j => S.jobs.set(j.id, j));
  loadCosts();
  fillModels();

  paintFilmList(st.films);
  const want = location.hash.slice(1) || (st.films[0] && st.films[0].slug);
  $('#canvasEmpty').hidden = !!want;
  if (want) { $('#filmPick').value = want; await openFilm(want, true); }
  paintJobs(); paintRunning(); paintFold();
  listen();
}

async function loadCosts() {
  try { S.costs = (await api('GET', '/api/costs')).models || {}; } catch { S.costs = {}; }
  paintCost();
}

async function fillModels() {
  for (const kind of ['video', 'image']) {
    try { S.cat[kind] = (await api('GET', `/api/models/${kind}`)).models; } catch { S.cat[kind] = []; }
  }
  paintBar();
}

/* ------------------------------------------------------------------- film */
function paintFilmList(films, want) {
  const pick = $('#filmPick'); pick.innerHTML = '';
  (films || []).forEach(f => { const o = el('option', null, `${f.title}  (${f.shots})`); o.value = f.slug; pick.append(o); });
  if (want) pick.value = want;
  pick.disabled = !(films || []).length;   // the ⋯ menu stays live: it always offers "new film"
  if (!(films || []).length) { const o = el('option', null, 'no films yet'); o.value = ''; pick.append(o); }
}
const refreshFilms = async () => paintFilmList((await api('GET', '/api/state')).films, S.film && S.film.slug);

async function newFilm() {
  const title = await ask('Name for the new film', '');
  if (!title) return;
  const slug = slugify(title, 48) || 'film-' + Date.now().toString(36);
  try {
    await api('POST', '/api/films', { slug, title });
    S.shotId = null; S.sel = null;
    await openFilm(slug, true);
    await refreshFilms();
    toast(`film "${title}" created — add a shot`);
  } catch (e) { toast(e.message, true); }
}

async function renameFilm() {
  if (!S.film) return;
  const title = await ask('Name for this film', S.film.title || S.film.slug);
  if (!title) return;
  await api('POST', `/api/film/${S.film.slug}`, { title });
  S.film.title = title;
  await refreshFilms();
}

/* A film is every take ever generated for it, which is real money. Ask for the
   name, and the server moves it to films/_trash rather than deleting it. */
async function deleteFilm() {
  if (!S.film) return;
  const f = S.film;
  const takes = f.shots.reduce((a, sh) => a + (sh.takes || []).length, 0);
  const typed = await ask(
    `Delete the film "${f.title}"?\n\n${f.shots.length} shot(s) and ${takes} take(s) move to films/_trash — they are not gone, but nothing regenerates for free.\n\nType the film name to confirm.`, '');
  if (typed == null) return;
  const want = [(f.title || '').trim().toLowerCase(), f.slug];
  if (!want.includes(typed.trim().toLowerCase())) { toast('name did not match — nothing was deleted', true); return; }
  try {
    const r = await api('POST', `/api/film/${f.slug}/delete`);
    toast(`"${f.title}" moved to ${r.trash}`);
    const st = await api('GET', '/api/state');
    paintFilmList(st.films);
    if (st.films[0]) { S.shotId = null; S.sel = null; $('#filmPick').value = st.films[0].slug; await openFilm(st.films[0].slug, true); }
    else closeFilm();
  } catch (e) { toast(e.message, true); }
}

function closeFilm() {
  S.film = null; S.shotId = null; S.sel = null;
  location.hash = '';
  closeSide(); paintFilm(); paintBar();
  $('#canvasEmpty').hidden = false;
}

function filmMenu(anchor) {
  const m = el('div', 'menu');
  const add = (label, fn, cls) => { const b = el('button', cls || '', label); b.onclick = async () => { closePop(); try { await fn(); } catch (e) { toast(e.message, true); } }; m.append(b); };
  add('new film   (shift + N)', newFilm);
  if (S.film) {
    add('rename this film', renameFilm);
    m.append(el('hr'));
    add(freeMode() ? 'tidy every node back into a row' : 'place nodes freely', () => freeMode() ? tidyLayout() : startFree());
    m.append(el('hr'));
    add('delete this film…', deleteFilm, 'danger');
  }
  openPop(anchor, m, { below: true });
}

async function openFilm(slug, first) {
  S.film = await api('GET', `/api/film/${slug}`);
  location.hash = slug;
  if (!S.film.shots.some(s => s.id === S.shotId)) S.shotId = S.film.shots[0] ? S.film.shots[0].id : null;
  if (S.sel && !takeById(shot(), S.sel)) S.sel = null;
  $('#canvasEmpty').hidden = true;
  $('#filmPick').disabled = false;
  paintFilm();
  if (first) {
    // Open readable: the first board at 100%, top-left. `fit` is one key away.
    const saved = loadView(slug);
    S.view = saved || { x: 40 - X0, y: 40 - Y0, z: 1 };
    applyView();
  }
  paintBar(); paintSide();
  clampToCaps().catch(() => {});   // the shot open on load may already be out of bounds
}
const reload = () => S.film && openFilm(S.film.slug);

/* ------------------------------------------------------------- the canvas */
const REF_W = 210, REF_GAP = 18, REF_H = 250;
/* Two layouts in one function. By default nodes sit in film order, left to
   right, and nothing is stored. Once a node carries an x/y — you dragged one
   off the row, or pressed "place nodes freely" — that node stays where it was
   put and only the ones without a position keep taking row slots. Film order
   is never the geometry: it is the order of S.film.shots, shown on the badge. */
const freeMode = () => !!(S.film && (S.film.shots.some(s => s.x != null) || (S.film.refs || []).some(r => r.x != null)));
const refById = id => (S.film.refs || []).find(r => r.id === id);

function layout() {
  if (!S.film) return;
  const refs = $$('#world .refcard');
  let ri = 0;
  for (const r of refs) {
    const o = refById(r.dataset.ref);
    if (o && o.x != null) { r.style.left = o.x + 'px'; r.style.top = o.y + 'px'; }
    else { r.style.left = (X0 + ri++ * (REF_W + REF_GAP)) + 'px'; r.style.top = Y0 + 'px'; }
  }
  const top = refs.length ? Y0 + REF_H + 60 : Y0;
  let slot = 0, right = X0;
  for (const b of $$('#world .board:not(.adder)')) {
    const o = S.film.shots.find(x => x.id === b.dataset.id);
    const x = o && o.x != null ? o.x : X0 + slot++ * (BW + GAP);
    const y = o && o.x != null ? o.y : top;
    b.style.left = x + 'px'; b.style.top = y + 'px';
    right = Math.max(right, x + BW + GAP);
  }
  const add = $('#world .board.adder');
  if (add) { add.style.left = right + 'px'; add.style.top = top + 'px'; }
  requestAnimationFrame(drawWires);
}

/* Read every node's position off the canvas and onto the film. The one place
   free placement is written, so a drag, a "place freely" and a reload all end
   up saying the same thing. */
function captureLayout() {
  const out = { shots: {}, refs: {} };
  $$('#world .board:not(.adder)').forEach(b => {
    const o = S.film.shots.find(x => x.id === b.dataset.id); if (!o) return;
    o.x = Math.round(parseFloat(b.style.left) || 0); o.y = Math.round(parseFloat(b.style.top) || 0);
    out.shots[o.id] = [o.x, o.y];
  });
  $$('#world .refcard').forEach(n => {
    const o = refById(n.dataset.ref); if (!o) return;
    o.x = Math.round(parseFloat(n.style.left) || 0); o.y = Math.round(parseFloat(n.style.top) || 0);
    out.refs[o.id] = [o.x, o.y];
  });
  return out;
}
const saveLayout = () => api('POST', `/api/film/${S.film.slug}/layout`, captureLayout());

async function startFree() {
  await saveLayout();
  toast('free placement on — drag a node by its head, the number badge is still the film order');
}

async function tidyLayout() {
  await api('POST', `/api/film/${S.film.slug}/layout`, { reset: true });
  S.film.shots.concat(S.film.refs || []).forEach(n => { delete n.x; delete n.y; });
  layout();
  toast('nodes tidied back into film order');
}

async function moveShot(s, d) {
  const ids = S.film.shots.map(x => x.id);
  const i = ids.indexOf(s.id), j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  await api('POST', `/api/film/${S.film.slug}/reorder`, { order: ids });
  await reload();
}

function stepShot(d) {
  if (!S.film || !S.film.shots.length) return;
  const ids = S.film.shots.map(s => s.id);
  let i = ids.indexOf(S.shotId);
  i = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + d));
  setActive(ids[i]); centerOn(ids[i]);
}

/* One wire per (reference, board) link, Comfy style: from the bottom of the
   node to the top edge of every board that sends it. */
function drawWires() {
  const svg = $('#wires'); if (!svg || !S.film) return;
  svg.innerHTML = '';
  const byRef = {}; $$('#world .refcard').forEach(n => { byRef[n.dataset.ref] = n; });
  let maxX = 0, maxY = 0;
  S.film.shots.forEach(s => {
    const b = document.querySelector(`.board[data-id="${s.id}"]`); if (!b) return;
    (s.refs || []).forEach((rid, k) => {
      const r = byRef[rid]; if (!r) return;
      const x1 = parseFloat(r.style.left) + r.offsetWidth / 2, y1 = parseFloat(r.style.top) + r.offsetHeight;
      const x2 = parseFloat(b.style.left) + 26 + k * 18, y2 = parseFloat(b.style.top);
      const dy = Math.max(30, (y2 - y1) / 2);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`);
      svg.append(p);
      for (const [x, y] of [[x1, y1], [x2, y2]]) { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 3); svg.append(c); }
      maxX = Math.max(maxX, x1, x2); maxY = Math.max(maxY, y2);
    });
  });
  svg.setAttribute('width', maxX + 100); svg.setAttribute('height', maxY + 100);
}
const boardSizes = new ResizeObserver(() => drawWires());

function paintFilm() {
  const w = $('#world'); w.innerHTML = '';
  if (!S.film) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'wires'; w.append(svg);
  (S.film.refs || []).forEach(r => w.append(renderRef(r)));
  S.film.shots.forEach((s, i) => { const b = renderBoard(s, i); w.append(b); boardSizes.observe(b); });
  const add = el('div', 'board adder'); add.dataset.adder = '1';
  add.append(el('b', null, '+'), el('span', null, S.film.shots.length ? 'add a shot' : 'add the first shot'));
  add.onclick = newShot;
  w.append(add);
  layout();
  paintGhosts();
}

function renderBoard(s, i) {
  const b = el('div', 'board' + (s.id === S.shotId ? ' on' : '')); b.dataset.id = s.id;

  // head: number · title · meta · menu
  const head = el('div', 'bhead');
  head.append(el('span', 'num', String(i + 1)));
  const title = el('input', 'btitle'); title.value = s.title || ''; title.placeholder = 'shot title';
  title.oninput = () => { s.title = title.value; queueSave(s, { title: title.value }); paintTarget(); };
  head.append(title);
  const meta = el('span', 'bmeta'); paintBoardMeta(meta, s); head.append(meta);
  const menu = el('button', 'ghost tiny', '⋯'); menu.title = 'shot menu';
  menu.onclick = e => { e.stopPropagation(); boardMenu(menu, s); };
  const del = el('button', 'ghost tiny bdel', '✕'); del.title = 'delete this shot   (Del)';
  del.onclick = e => { e.stopPropagation(); deleteShot(s).catch(err => toast(err.message, true)); };
  head.append(menu, del);
  b.append(head);

  const note = el('textarea', 'bnote'); note.rows = 1; note.value = s.note || '';
  note.placeholder = 'why this beat is in the film';
  note.oninput = () => { s.note = note.value; autosize(note); queueSave(s, { note: note.value }); };
  b.append(note);
  requestAnimationFrame(() => autosize(note));

  // frame slots — drop targets
  const slots = el('div', 'slots');
  for (const [slot, key, label] of [['first', 'first_frame', 'FIRST FRAME'], ['last', 'last_frame', 'LAST FRAME']]) {
    const d = el('div', 'slot' + (s[key] ? ' has' : '')); d.dataset.slot = slot; d.dataset.shot = s.id;
    const img = el('img'); if (s[key]) img.src = `/media/${S.film.slug}/${s[key]}?t=${Date.now()}`;
    d.append(img, el('span', null, s[key] ? label : 'drop a still · ' + label));
    const x = el('button', 'x', '✕'); x.title = 'clear';
    x.onclick = async e => { e.stopPropagation(); await api('POST', `/api/film/${S.film.slug}/shot/${s.id}`, { [key]: null }); await reload(); };
    d.append(x);
    d.onclick = () => { if (s[key]) openLightbox({ title: `${s.title || s.id} · ${label.toLowerCase()}`, file: `/media/${S.film.slug}/${s[key]}`, video: false, plain: true }); };
    slots.append(d);
    if (slot === 'first') { const a = el('div', 'arr'); a.append(el('b', null, '→')); a.append(document.createTextNode('clip')); slots.append(a); }
  }
  const why = el('p', 'why');
  why.innerHTML = 'The clip is generated <em>between</em> these two. No model takes a middle frame — a first / mid / last storyboard is two shots sharing the middle one.';
  slots.append(why);
  b.append(slots);

  // takes
  const grid = el('div', 'grid'); grid.dataset.shot = s.id;
  if (!s.takes.length) {
    const none = el('div', 'none');
    none.innerHTML = '<b>Nothing here yet.</b><br>Describe the frame in the bar below and press Generate. Stills first — they cost cents.';
    grid.append(none);
  }
  s.takes.forEach(t => grid.append(renderCard(s, t)));
  b.append(grid);
  return b;
}

const refUrl = r => `/media/${S.film.slug}/${r.file}`;
function refUsers(r) { return S.film.shots.filter(s => (s.refs || []).includes(r.id)); }

function renderRef(r) {
  const n = el('div', 'refcard'); n.dataset.ref = r.id;
  const th = el('div', 'rthumb'); const img = el('img'); img.src = refUrl(r); img.alt = r.name || r.id;
  th.append(img, el('span', 'kind', 'REF')); th.title = 'drag onto a board to link it · double-click to open it and change the picture';
  n.append(th);
  const name = el('input', 'rname'); name.value = r.name || ''; name.placeholder = 'name';
  n.append(name);
  const tag = el('textarea', 'rtag'); tag.rows = 2; tag.value = r.tag || '';
  tag.placeholder = 'What to take from it. "Take the texture of the hull from this image." "Match this lighting." It goes into the prompt, numbered.';
  n.append(tag);
  requestAnimationFrame(() => autosize(tag));
  const foot = el('div', 'rfoot');
  const grip = el('span', 'grip', '⠿'); grip.title = 'drag to move this node';
  foot.append(grip);
  const used = el('span', 'used'); const paintUsed = () => { const u = refUsers(r); used.textContent = u.length ? `→ ${u.length} shot${u.length === 1 ? '' : 's'}` : 'not linked — drag onto a board'; };
  paintUsed();
  const saved = el('span', 'saved', 'saved');
  const del = el('button', 'ghost', '✕'); del.title = 'remove this reference and unlink it everywhere';
  del.onclick = async e => {
    e.stopPropagation();
    const u = refUsers(r);
    if (!await confirmIn(`Remove reference "${r.name || r.id}"?` + (u.length ? `\n\n${u.length} shot(s) send it and will stop.` : ''))) return;
    await api('POST', `/api/film/${S.film.slug}/refs`, { id: r.id, delete: true }); await reload();
  };
  del.onpointerdown = e => e.stopPropagation();
  foot.append(used, el('span', 'grow'), saved, del);
  n.append(foot);
  let t = null;
  const save = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      r.name = name.value; r.tag = tag.value;
      await api('POST', `/api/film/${S.film.slug}/refs`, { id: r.id, name: name.value, tag: tag.value });
      saved.classList.add('show'); setTimeout(() => saved.classList.remove('show'), 1200);
      paintBarRefs();
    }, 450);
  };
  name.oninput = save; tag.oninput = () => { autosize(tag); save(); };
  return n;
}

/* Upload: files dropped on the canvas, pasted, or picked with +. Each becomes a
   node; dropped on a board, it is linked to that board straight away. */
async function addRefFiles(files, linkTo) {
  if (!S.film) { toast('Create or pick a film first', true); return; }
  const list = [...files].filter(f => f.type.startsWith('image/'));
  if (!list.length) { toast('Drop image files.', true); return; }
  let lastId = null;
  for (const f of list) {
    const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f); });
    try {
      const r = await api('POST', `/api/film/${S.film.slug}/refs`, { data, name: f.name.replace(/\.[^.]+$/, ''), tag: '', link: linkTo ? [linkTo] : [] });
      lastId = r.ref.id;
    } catch (e) { toast(e.message, true); }
  }
  await reload();
  if (lastId) { const ta = document.querySelector(`.refcard[data-ref="${lastId}"] .rtag`); if (ta) ta.focus(); }
  toast(`${list.length} reference${list.length === 1 ? '' : 's'} added` + (linkTo ? ' and linked' : ' — drag onto a board to link, and say what to take from it'));
}

async function toggleRef(s, rid) {
  const next = new Set(s.refs || []);
  next.has(rid) ? next.delete(rid) : next.add(rid);
  s.refs = [...next];
  await api('POST', `/api/film/${S.film.slug}/shot/${s.id}`, { refs: s.refs });
  paintBarRefs(); drawWires();
  $$('#world .refcard').forEach(n => { const r = (S.film.refs || []).find(x => x.id === n.dataset.ref); if (r) { const u = refUsers(r); n.querySelector('.rfoot .used').textContent = u.length ? `→ ${u.length} shot${u.length === 1 ? '' : 's'}` : 'not linked — drag onto a board'; } });
  const meta = document.querySelector(`.board[data-id="${s.id}"] .bmeta`); if (meta) paintBoardMeta(meta, s);
}

function paintBoardMeta(node, s) {
  node.innerHTML = '';
  const n = s.takes.length;
  node.append(document.createTextNode(`${n} take${n === 1 ? '' : 's'}`));
  const cut = takeById(s, s.selected_take);
  if (cut) { node.append(document.createTextNode(' · ')); node.append(el('span', 'cut', '★ ' + short(cut.model))); }
  const nr = (s.refs || []).length;
  if (nr) node.append(document.createTextNode(` · ${nr} ref${nr === 1 ? '' : 's'}`));
}

function renderCard(s, t) {
  const c = el('div', 'card' + (t.id === S.sel && s.id === S.shotId ? ' sel' : '') + (t.id === s.selected_take ? ' picked' : ''));
  c.dataset.take = t.id; c.dataset.shot = s.id;
  const th = el('div', 'thumb');
  let media = null;
  if (t.ext === '.mp4') {
    media = el('video'); media.src = t.file; media.preload = 'metadata'; media.muted = true; media.loop = true;
    if (t.poster) media.poster = t.poster;
    c.onmouseenter = () => { media.play().catch(() => {}); };
    c.onmouseleave = () => { media.pause(); };
  } else if (t.file) { media = el('img'); media.src = t.file; media.loading = 'lazy'; }
  if (media) th.append(media);
  th.append(el('span', 'star', '★'));
  th.append(el('span', 'kind', t.ext === '.mp4' ? 'CLIP' : (t.style_name === 'edit' ? 'EDIT' : 'STILL')));
  const tags = el('div', 'tags');
  tags.append(el('span', 'm', short(t.model) || '?'));
  if (t.style_name && t.style_name !== 'edit') tags.append(el('span', 's', t.style_name));
  tags.append(el('span', 'c' + (t.cost_usd == null ? ' dry' : ''), t.cost_usd != null ? `$${t.cost_usd}` : 'dry'));
  th.append(tags);
  c.append(th);
  c.append(cardTools(s, t, media));
  return c;
}

/* The actions a take can take. Shared by the card toolbar and the side panel. */
function takeActions(s, t, media) {
  const acts = [];
  const isV = t.ext === '.mp4';
  acts.push({ label: t.id === s.selected_take ? '★ picked' : '☆ pick', on: t.id === s.selected_take,
    title: isV ? 'use this clip in the cut' : 'mark this as the chosen take',
    run: async () => { await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/select`, { take: t.id === s.selected_take ? null : t.id }); await reload(); } });
  for (const slot of ['first', 'last']) {
    acts.push({ label: `↑ ${slot}`, title: isV ? `grab the frame showing now as this shot's ${slot} frame` : `use this still as this shot's ${slot} frame`,
      run: async () => {
        const body = { take: t.id, slot };
        if (isV) body.time = media ? media.currentTime : 0;
        await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/promote`, body);
        toast(`${slot} frame set`); await reload();
      } });
  }
  acts.push({ label: 'edit', title: 'enlarge, paint a region, say what to change', run: () => openLightbox(s, t) });
  acts.push({ label: '→ ref', title: 'turn this take into a reference image for other shots',
    run: async () => {
      const body = { from_take: { shot: s.id, take: t.id, time: isV && media ? media.currentTime : 0 }, name: `${short(t.model)}${t.style_name && t.style_name !== 'edit' ? ' · ' + t.style_name : ''}`, tag: 'Match this image.' };
      await api('POST', `/api/film/${S.film.slug}/refs`, body); await reload();
      toast('added as a reference — drag it onto a board, and say what to take from it');
    } });
  if (t.style_name !== 'edit') acts.push({ label: 'again', title: `run the current ${isV ? 'clip' : 'still'} prompt on ${short(t.model)}${t.style_name ? ' · ' + t.style_name : ''} once more`,
    run: () => generate('generate', isV ? 'clip' : 'frame', s, [t.model], t.style_id ? [t.style_id] : []) });
  if (isV) acts.push({ label: 'chain →', title: 'pick this take and push its last frame into the next shot as first frame',
    run: async () => {
      const r = await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/select`, { take: t.id, chain: true });
      await reload();
      if (!r.chained) toast('Nothing to chain into — this is the last shot.', true); else toast('chained into the next shot');
    } });
  acts.push({ label: '✕', cls: 'x', title: 'delete this take — the file goes for good',
    run: async () => {
      if (!await confirmIn('Delete this take?\n\nThe file goes for good.')) return;
      await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/take/${t.id}/delete`);
      if (S.sel === t.id) S.sel = null;
      await reload();
    } });
  return acts;
}

function cardTools(s, t, media) {
  const bar = el('div', 'ctools');
  takeActions(s, t, media).forEach(a => {
    const b = el('button', (a.cls || '') + (a.on ? ' on' : ''), a.label); b.title = a.title || '';
    b.onclick = async e => { e.stopPropagation(); try { await a.run(); } catch (err) { toast(err.message, true); } };
    b.onpointerdown = e => e.stopPropagation();
    b.ondblclick = e => e.stopPropagation();
    bar.append(b);
  });
  return bar;
}

/* Running jobs appear on the board where their result will land. */
function paintGhosts() {
  $$('#world .card.ghost').forEach(n => n.remove());
  if (!S.film) return;
  const running = [...S.jobs.values()].filter(j => j.film === S.film.slug && (j.state === 'running' || j.state === 'error'));
  running.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
  running.forEach(j => {
    const grid = document.querySelector(`.grid[data-shot="${j.shot}"]`); if (!grid) return;
    const none = grid.querySelector('.none'); if (none) none.remove();
    const g = el('div', 'card ghost' + (j.dry ? ' dry' : '') + (j.state === 'error' ? ' error' : '')); g.dataset.job = j.id;
    const th = el('div', 'thumb');
    const who = el('div', 'who');
    who.append(el('b', null, short(j.model)));
    who.append(document.createTextNode((j.style ? j.style + ' · ' : '') + (j.kind === 'video' ? 'clip' : 'still')));
    if (j.dry) who.append(el('span', 'dryt', ' · dry run'));
    th.append(who); g.append(th);
    const line = el('div', 'line'); line.dataset.jobline = j.id;
    line.textContent = j.state === 'error' ? (j.error || 'failed — open Activity') : ((j.lines || []).slice(-1)[0] || 'starting…');
    g.append(line);
    g.onclick = e => { e.stopPropagation(); openSide('activity'); focusJob(j.id); };
    if (j.state === 'error') {
      const x = el('button', 'ghost tiny', 'dismiss'); x.style.cssText = 'position:absolute;right:4px;top:4px';
      x.onclick = e => { e.stopPropagation(); S.jobs.delete(j.id); paintGhosts(); paintJobs(); paintRunning(); };
      x.onpointerdown = e => e.stopPropagation();
      g.append(x);
    }
    grid.prepend(g);
  });
}

function boardMenu(anchor, s) {
  const m = el('div', 'menu');
  const add = (label, fn, cls) => { const b = el('button', cls || '', label); b.onclick = async () => { closePop(); try { await fn(); } catch (e) { toast(e.message, true); } }; m.append(b); };
  add('centre on this shot', () => centerOn(s.id));
  add('duplicate shot   (D)', () => duplicateShot(s));
  m.append(el('hr'));
  add('move earlier   (alt + ←)', () => moveShot(s, -1));
  add('move later   (alt + →)', () => moveShot(s, 1));
  add(freeMode() ? 'tidy every node back into a row' : 'place nodes freely', () => freeMode() ? tidyLayout() : startFree());
  m.append(el('hr'));
  add('delete shot   (Del)', () => deleteShot(s), 'danger');
  openPop(anchor, m, { below: true });
}

/* One deletion path, three ways in: the ✕ on the head, the menu, and Del. */
async function deleteShot(s) {
  if (!S.film) return;
  const n = (s.takes || []).length;
  if (!await confirmIn(`Delete shot "${s.title || s.id}"?` +
      (n ? `\n\nIts ${n} take${n === 1 ? '' : 's'} stay on disk, under films/${S.film.slug}/takes/.` : ''))) return;
  await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/delete`);
  if (S.shotId === s.id) { S.shotId = null; S.sel = null; }
  await reload();
  toast(`shot "${s.title || s.id}" deleted`);
}

async function duplicateShot(s) {
  let id = s.id + '-2', n = 2;
  while (S.film.shots.some(x => x.id === id)) id = `${s.id}-${++n}`;
  const made = await api('POST', `/api/film/${S.film.slug}/shots`, { id, title: (s.title || s.id) + ' copy' });
  const clip = Object.assign({}, s.clip), frame = Object.assign({}, s.frame);
  await api('POST', `/api/film/${S.film.slug}/shot/${made.id}`, { note: s.note || '', styles: s.styles || [], clip, frame });
  if (freeMode() && s.x != null) await api('POST', `/api/film/${S.film.slug}/layout`, { shots: { [made.id]: [s.x + 60, s.y + 60] } });
  S.shotId = made.id; S.sel = null;
  await reload(); centerOn(made.id);
}

async function newShot() {
  if (!S.film) { toast('Create or pick a film first', true); return; }
  const title = await ask('What happens in this shot?', '');
  if (!title) return;
  // In free placement the row slot is meaningless — put the new node where the
  // + card the user just pressed is sitting.
  const add = $('#world .board.adder');
  const at = freeMode() && add ? [Math.round(parseFloat(add.style.left)), Math.round(parseFloat(add.style.top))] : null;
  try {
    const s = await api('POST', `/api/film/${S.film.slug}/shots`, { id: slugify(title, 40), title });
    if (at) await api('POST', `/api/film/${S.film.slug}/layout`, { shots: { [s.id]: at } });
    S.shotId = s.id; S.sel = null;
    await reload(); centerOn(s.id);
    $('#prompt').focus();
  } catch (e) { toast(e.message, true); }
}

function setActive(id) {
  if (S.shotId === id) return;
  S.shotId = id; S.sel = null;
  $$('#world .board').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  $$('#world .card.sel').forEach(c => c.classList.remove('sel'));
  paintBar();
  clampToCaps().catch(() => {});   // this shot may carry settings its model refuses
  if (S.side.open && S.side.tab === 'take') paintSide();
}

function selectTake(shotId, takeId) {
  setActive(shotId);
  S.sel = takeId;
  $$('#world .card').forEach(c => c.classList.toggle('sel', c.dataset.take === takeId && c.dataset.shot === shotId));
  openSide('take');
}

/* -------------------------------------------------------- view: pan/zoom */
function applyView() {
  const v = S.view;
  $('#world').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  $('#zoomPct').textContent = Math.round(v.z * 100) + '%';
  saveView();
}
let viewTimer = null;
function saveView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { try { if (S.film) localStorage.setItem('fb.view.' + S.film.slug, JSON.stringify(S.view)); } catch {} }, 300);
}
function loadView(slug) {
  try { const v = JSON.parse(localStorage.getItem('fb.view.' + slug)); return v && isFinite(v.z) ? v : null; } catch { return null; }
}
function zoomAt(cx, cy, factor) {
  const v = S.view, z = Math.min(2.5, Math.max(0.2, v.z * factor));
  const wx = (cx - v.x) / v.z, wy = (cy - v.y) / v.z;
  v.z = z; v.x = cx - wx * z; v.y = cy - wy * z;
  applyView();
}
function canvasCenter() { const r = $('#canvas').getBoundingClientRect(); return [r.width / 2, r.height / 2 - 60]; }
function fit() {
  const boards = $$('#world .board, #world .refcard'); if (!boards.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  boards.forEach(b => {
    const l = parseFloat(b.style.left), t = parseFloat(b.style.top);
    x1 = Math.min(x1, l); y1 = Math.min(y1, t);
    x2 = Math.max(x2, l + b.offsetWidth); y2 = Math.max(y2, t + b.offsetHeight);
  });
  const r = $('#canvas').getBoundingClientRect();
  const pad = 60, availH = r.height - 190;    // the prompt bar sits over the bottom
  const z = Math.min(1.25, Math.max(0.2, Math.min((r.width - pad * 2) / (x2 - x1), (availH - pad) / (y2 - y1))));
  S.view = { z, x: (r.width - (x2 - x1) * z) / 2 - x1 * z, y: pad - y1 * z };
  applyView();
}
function centerOn(id) {
  const b = document.querySelector(`.board[data-id="${id}"]`); if (!b) return;
  const r = $('#canvas').getBoundingClientRect();
  const z = S.view.z;
  const cx = parseFloat(b.style.left) + b.offsetWidth / 2, cy = parseFloat(b.style.top) + Math.min(b.offsetHeight / 2, 260);
  S.view.x = r.width / 2 - cx * z; S.view.y = (r.height - 170) / 2 - cy * z;
  applyView();
}

/* One pointer handler for the whole canvas: pan the background, lift a board
   by its head to reorder, or drag a card onto a frame slot. */
(function pointer() {
  const cv = $('#canvas');
  let start = null;
  const isControl = t => t.closest('input,textarea,select,button,video,.slot .x');

  cv.addEventListener('pointerdown', e => {
    if (e.button === 1 || (e.button === 0 && S.space)) { start = { kind: 'pan', x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y }; capture(cv, e); cv.classList.add('panning'); e.preventDefault(); return; }
    if (e.button !== 0) return;
    closePop();
    const t = e.target;
    const board = t.closest('.board');
    if (board && board.dataset.id) setActive(board.dataset.id);
    // Ctrl (or ⌘) + drag picks a node up from anywhere on it — over its title,
    // its notes, its cards — instead of hunting for the head or the grip.
    if ((e.ctrlKey || e.metaKey) && !S.space) {
      const node = t.closest('.refcard') || (board && !board.dataset.adder ? board : null);
      if (node) {
        start = { kind: 'node', x: e.clientX, y: e.clientY, node, moved: false,
                  becameFree: !freeMode(),
                  left: parseFloat(node.style.left), top: parseFloat(node.style.top) };
        capture(cv, e); e.preventDefault(); return;
      }
    }
    const refNode = t.closest('.refcard');
    if (refNode) {
      if (t.closest('.grip')) {                                // the grip moves the node itself
        start = { kind: 'node', x: e.clientX, y: e.clientY, node: refNode, moved: false,
                  left: parseFloat(refNode.style.left), top: parseFloat(refNode.style.top) };
        capture(cv, e); e.preventDefault(); return;
      }
      if (!t.closest('.rthumb')) return;                       // name / tag / buttons: leave them alone
      start = { kind: 'ref', x: e.clientX, y: e.clientY, node: refNode, moved: false };
      capture(cv, e); e.preventDefault(); return;
    }
    const card = t.closest('.card');
    if (card && !card.classList.contains('ghost') && !t.closest('.ctools')) {
      start = { kind: 'card', x: e.clientX, y: e.clientY, card, moved: false };
      capture(cv, e); e.preventDefault(); return;
    }
    if (t.closest('.bhead') && !isControl(t) && board) {
      start = { kind: 'board', x: e.clientX, y: e.clientY, board, moved: false,
                left: parseFloat(board.style.left), top: parseFloat(board.style.top) };
      capture(cv, e); e.preventDefault(); return;
    }
    if (isControl(t) || t.closest('.adder') || t.closest('.slot')) return;
    start = { kind: 'pan', x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y, onBoard: !!board };
    capture(cv, e); cv.classList.add('panning');
    if (!board) { S.sel = null; $$('#world .card.sel').forEach(c => c.classList.remove('sel')); if (S.side.open && S.side.tab === 'take') paintSide(); }
  });

  cv.addEventListener('pointermove', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (start.kind === 'pan') { S.view.x = start.vx + dx; S.view.y = start.vy + dy; applyView(); return; }
    if (Math.hypot(dx, dy) < 6 && !start.moved) return;
    if (start.kind === 'card') {
      if (!start.moved) {
        start.moved = true; start.card.classList.add('dragging');
        const g = $('#dragGhost'); const m = start.card.querySelector('img,video');
        g.style.backgroundImage = `url("${(m && (m.poster || m.currentSrc || m.src)) || ''}")`; g.hidden = false;
      }
      const g = $('#dragGhost'); g.style.left = (e.clientX + 14) + 'px'; g.style.top = (e.clientY + 14) + 'px';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const slot = under && under.closest('.slot');
      $$('.slot.over').forEach(s => { if (s !== slot) s.classList.remove('over'); });
      if (slot) slot.classList.add('over');
      return;
    }
    if (start.kind === 'node') {
      if (!start.moved) { start.moved = true; start.node.classList.add('lifting'); }
      start.node.style.left = (start.left + dx / S.view.z) + 'px';
      start.node.style.top = (start.top + dy / S.view.z) + 'px';
      requestAnimationFrame(drawWires);
      return;
    }
    if (start.kind === 'ref') {
      if (!start.moved) {
        start.moved = true; start.node.classList.add('lifting');
        const g = $('#dragGhost'); g.style.backgroundImage = `url("${start.node.querySelector('img').src}")`; g.hidden = false;
      }
      const g = $('#dragGhost'); g.style.left = (e.clientX + 14) + 'px'; g.style.top = (e.clientY + 14) + 'px';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const board = under && under.closest('.board:not(.adder)');
      $$('.board.dropref').forEach(b => { if (b !== board) b.classList.remove('dropref'); });
      if (board) board.classList.add('dropref');
      return;
    }
    if (start.kind === 'board') {
      if (!start.moved) { start.moved = true; start.board.classList.add('lifting'); }
      // Along the row a drag reorders, as it always has. A deliberate pull
      // downwards breaks the film out into free placement, and from then on a
      // drag just moves the node — order stays on the number badge.
      if (!start.free && (freeMode() || Math.abs(dy / S.view.z) > 46)) {
        start.becameFree = !freeMode();
        captureLayout();
        start.free = true;
      }
      if (start.free) {
        start.board.style.left = (start.left + dx / S.view.z) + 'px';
        start.board.style.top = (start.top + dy / S.view.z) + 'px';
        requestAnimationFrame(drawWires);
        return;
      }
      start.board.style.left = (start.left + dx / S.view.z) + 'px';
      // slide the others out of the way as the lifted one passes their centres
      const others = $$('#world .board').filter(b => b !== start.board && !b.classList.contains('adder'));
      const cx = start.left + dx / S.view.z + BW / 2;
      let idx = others.filter(b => parseFloat(b.style.left) + BW / 2 < cx).length;
      others.forEach((b, i) => { b.style.left = (X0 + (i < idx ? i : i + 1) * (BW + GAP)) + 'px'; });
      const adder = document.querySelector('.board.adder'); if (adder) adder.style.left = (X0 + (others.length + 1) * (BW + GAP)) + 'px';
      start.idx = idx;
    }
  });

  // With the pointer captured, click and dblclick fire on the canvas rather than on
  // the card under it, so double-clicks are recognised here from two quick taps.
  let lastTap = { t: 0, key: null };
  const tap = key => { const now = performance.now(); const dbl = key && lastTap.key === key && now - lastTap.t < 420; lastTap = dbl ? { t: 0, key: null } : { t: now, key }; return dbl; };
  const finish = async e => {
    if (!start) return;
    const st = start; start = null;
    cv.classList.remove('panning');
    try { cv.releasePointerCapture(e.pointerId); } catch {}
    if (st.kind === 'pan') {
      // a still double-tap on the background fits the film; any real movement resets the tap
      const still = Math.hypot(e.clientX - st.x, e.clientY - st.y) < 4;
      if (!still) lastTap = { t: 0, key: null };
      else if (!st.onBoard && tap('bg')) fit();
      return;
    }
    if (st.kind === 'card') {
      $('#dragGhost').hidden = true; st.card.classList.remove('dragging');
      const slot = $$('.slot.over')[0]; $$('.slot.over').forEach(s => s.classList.remove('over'));
      if (!st.moved) {
        selectTake(st.card.dataset.shot, st.card.dataset.take);
        if (tap('card:' + st.card.dataset.shot + '/' + st.card.dataset.take)) {
          const s = S.film.shots.find(x => x.id === st.card.dataset.shot), t = takeById(s, st.card.dataset.take);
          if (t) openLightbox(s, t);
        }
        return;
      }
      if (slot) {
        const s = S.film.shots.find(x => x.id === st.card.dataset.shot), t = takeById(s, st.card.dataset.take);
        const body = { take: t.id, slot: slot.dataset.slot, to: slot.dataset.shot };
        if (t.ext === '.mp4') { const v = st.card.querySelector('video'); body.time = slot.dataset.slot === 'last' && v && isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : (v ? v.currentTime : 0); }
        try { await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/promote`, body); toast(`${slot.dataset.slot} frame set`); await reload(); }
        catch (err) { toast(err.message, true); }
      }
      return;
    }
    if (st.kind === 'node') {
      st.node.classList.remove('lifting');
      if (!st.moved) return;
      try {
        await saveLayout();
        if (st.becameFree) toast('free placement on — order is the number badge (alt + ← →); “tidy” in the ⋯ menu puts the row back');
      } catch (err) { toast(err.message, true); }
      layout();
      return;
    }
    if (st.kind === 'ref') {
      $('#dragGhost').hidden = true; st.node.classList.remove('lifting');
      const board = $$('.board.dropref')[0]; $$('.board.dropref').forEach(b => b.classList.remove('dropref'));
      if (st.moved && board) {
        const s = S.film.shots.find(x => x.id === board.dataset.id);
        if (s) { await toggleRef(s, st.node.dataset.ref); toast((s.refs || []).includes(st.node.dataset.ref) ? `linked to ${s.title || s.id}` : `unlinked from ${s.title || s.id}`); }
        return;
      }
      if (!st.moved && tap('ref:' + st.node.dataset.ref)) {
        const r = refById(st.node.dataset.ref);
        if (r) openLightbox({ ref: r });
      }
      return;
    }
    if (st.kind === 'board') {
      st.board.classList.remove('lifting');
      if (!st.moved) { layout(); return; }
      if (st.free) {
        try {
          await saveLayout();
          if (st.becameFree) toast('free placement on — order is the number badge (alt + ← →); “tidy” in the ⋯ menu puts the row back');
        } catch (err) { toast(err.message, true); }
        layout(); return;
      }
      const others = S.film.shots.map(s => s.id).filter(id => id !== st.board.dataset.id);
      others.splice(st.idx, 0, st.board.dataset.id);
      layout();
      if (JSON.stringify(others) !== JSON.stringify(S.film.shots.map(s => s.id))) {
        try { await api('POST', `/api/film/${S.film.slug}/reorder`, { order: others }); await reload(); }
        catch (err) { toast(err.message, true); }
      } else layout();
    }
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);

  /* A long note inside a board used to be unreachable: the canvas swallowed
     every wheel event to pan, so nothing on a node could ever scroll. Give the
     wheel to a scrollable thing under the pointer, and pan with what's left. */
  const scrollableUnder = (node, dy) => {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n.id === 'canvas' || n.id === 'world') break;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const room = n.scrollHeight - n.clientHeight;
      if (room < 2) continue;
      if (dy < 0 ? n.scrollTop > 0 : n.scrollTop < room - 1) return true;
    }
    return false;
  };

  cv.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey && e.deltaY && scrollableUnder(e.target, e.deltaY)) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
    else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView(); }
  }, { passive: false });
})();

/* ------------------------------------------------------------- prompt bar */
function paintTarget() {
  const s = shot();
  const i = s ? S.film.shots.indexOf(s) + 1 : 0;
  $('#target').textContent = s ? `${i}. ${s.title || s.id}` : 'no shot — add one on the canvas';
}

function paintBar() {
  const s = shot();
  $('#bar').classList.toggle('off', !s);
  paintTarget();
  $$('.mode').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('#clipParams').hidden = S.mode !== 'clip';
  $('#frameParams').hidden = S.mode !== 'frame';
  const ta = $('#prompt');
  ta.placeholder = S.mode === 'clip'
    ? 'What HAPPENS in this clip — action, staging, camera move, timing. Not how it looks; the look is the style.  ⌘/Ctrl+Enter generates.'
    : 'What is IN this frame — subject, staging, camera. Not how it looks; the look is the style.  ⌘/Ctrl+Enter generates.';
  if (s) {
    const c = s.clip || {}, f = s.frame || {};
    ta.value = (S.mode === 'clip' ? c.prompt : f.prompt) || '';
    $('#clipDuration').value = c.duration ?? 6;
    $('#clipResolution').value = c.resolution || '720p';
    $('#clipAspect').value = c.aspect || '16:9';
    $('#clipSeed').value = c.seed ?? '';
    $('#clipAudio').checked = !!c.audio;
    $('#frameN').value = f.n ?? 1;
  } else ta.value = '';
  ta.disabled = !s;
  autosize(ta);
  paintBarStyles(); paintBarRefs(); paintBarModels(); paintFrameCaps(); paintCost(); paintGenLabel();
  paintFold();
}

/* Folding the bar. Three steps down, because the two things in the way are not
   the same thing: the styles / refs / models rows are settings you set once,
   the prompt is what you are working in.

     full     everything
     compact  settings rows folded away — prompt, Generate and the summary
     folded   one strip: what it will do, and the button that does it

   The settings stay in force when folded, and Generate still spends real money
   on them, so every folded step keeps a summary of what is set and what it will
   cost. Folding must never hide a charge. */
/* Two directional buttons, not one cycling one: going back a step should not
   mean pressing forward three more times. Both clamp at the ends. */
const FOLDS = ['full', 'compact', 'folded', 'gone'];
const FOLD_DOWN = {
  full: 'fold the styles, refs and model rows away   (B)',
  compact: 'fold the prompt away too   (B)',
  folded: 'hide the bar completely   (B)',
  gone: '',
};
const FOLD_UP = {
  full: '',
  compact: 'bring the styles, refs and model rows back   (shift + B)',
  folded: 'bring the prompt back   (shift + B)',
  gone: 'show the bar again   (shift + B)',
};
function paintFold() {
  const bar = $('#bar');
  bar.classList.toggle('compact', S.fold === 'compact');
  bar.classList.toggle('folded', S.fold === 'folded');
  bar.classList.toggle('gone', S.fold === 'gone');
  $('#barShow').hidden = S.fold !== 'gone';
  $('#barShow').title = 'show the prompt bar   (B)';
  const i = FOLDS.indexOf(S.fold);
  const down = $('#barFold'), up = $('#barUnfold');
  down.disabled = i >= FOLDS.length - 1;
  up.disabled = i <= 0;
  down.title = FOLD_DOWN[S.fold];
  up.title = FOLD_UP[S.fold];
  paintBarSummary();
}
function foldBar(step) {
  setFold(FOLDS[Math.max(0, Math.min(FOLDS.length - 1, FOLDS.indexOf(S.fold) + (step || 1)))]);
}
function setFold(to) {
  if (to === S.fold) return;
  S.fold = to;
  try { localStorage.setItem('fb.fold', S.fold); } catch {}
  paintFold();
  if (S.fold === 'full' || S.fold === 'compact') autosize($('#prompt'));
}
const showBar = () => { if (S.fold === 'gone' || S.fold === 'folded') setFold('full'); };

function paintBarSummary() {
  const out = $('#barSummary');
  if (S.fold === 'full' || S.fold === 'gone') { out.textContent = ''; return; }
  const s = shot();
  if (!s) { out.textContent = 'no shot'; out.title = ''; return; }
  const spec = s[sect()] || {}, n = chosen().length, st = (s.styles || []).length, rf = (s.refs || []).length;
  const bits = [`${n} model${n === 1 ? '' : 's'}`];
  if (st) bits.push(`${st} style${st === 1 ? '' : 's'}`);   // a zero is noise on one line
  if (S.mode === 'frame' && rf) bits.push(`${rf} ref${rf === 1 ? '' : 's'}`);
  bits.push(S.mode === 'clip'
    ? `${spec.duration ?? 6}s · ${spec.resolution || '720p'} · ${spec.aspect || '16:9'}`
    : `n ${spec.n ?? 1}`);
  const cost = $('#cost').textContent;
  if (cost) bits.push(cost);
  out.textContent = '· ' + bits.join('  ·  ');
  const prompt = (S.mode === 'clip' ? spec.prompt : spec.prompt) || '';
  out.title = S.fold === 'folded' && prompt ? 'prompt: ' + prompt.slice(0, 400) : 'what this bar will send — the folded rows are still in force';
}

function paintBarRefs() {
  const box = $('#barRefs'); if (!box) return; box.innerHTML = '';
  const s = shot(); const refs = (S.film && S.film.refs) || [];
  if (!refs.length) { box.append(el('span', 'hint', 'none — drop images on the canvas, or press +')); return; }
  const set = new Set((s && s.refs) || []);
  refs.forEach(r => {
    const c = el('div', 'chip-m rf' + (set.has(r.id) ? ' on' : ''));
    const img = el('img'); img.src = refUrl(r); c.append(img, el('span', null, r.name || r.id));
    c.title = (r.tag || '(no tag yet — say what to take from it)') + (S.mode === 'clip' ? '\n\nReferences go with stills only; no video model on this API takes them. Ground the clip in a still instead.' : '');
    c.onclick = () => { if (s) toggleRef(s, r.id); };
    box.append(c);
  });
  if (S.mode === 'clip') box.append(el('span', 'hint', 'stills only'));
}

function paintBarStyles() {
  const box = $('#barStyles'); box.innerHTML = '';
  const s = shot();
  if (!styles().length) { box.append(el('span', 'hint', 'none yet — prompts go as written')); return; }
  const set = new Set((s && s.styles) || []);
  styles().forEach(st => {
    const c = el('div', 'chip-m st' + (set.has(st.id) ? ' on' : ''), st.name || st.id);
    c.title = (st.prompt || '(empty style prompt)').slice(0, 300);
    c.onclick = async () => {
      if (!s) return;
      const next = new Set(s.styles || []);
      next.has(st.id) ? next.delete(st.id) : next.add(st.id);
      s.styles = [...next]; paintBarStyles(); paintCost();
      await api('POST', `/api/film/${S.film.slug}/shot/${s.id}`, { styles: s.styles });
    };
    box.append(c);
  });
}

const sect = () => S.mode;                        // 'clip' | 'frame'
function chosen(sc) {
  const s = shot(); if (!s) return [];
  const spec = s[sc || sect()] || {};
  if (Array.isArray(spec.models)) return spec.models;
  return spec.model ? [spec.model] : [];
}
async function setModels(list) {
  const s = shot(); if (!s) return;
  const sc = sect();
  s[sc] = Object.assign({}, s[sc], { models: list }); delete s[sc].model;
  paintBarModels(); paintCost();
  await api('POST', `/api/film/${S.film.slug}/shot/${s.id}`, { [sc]: { models: list, model: null } });
  await clampToCaps().catch(() => {});
}
function paintBarModels() {
  const box = $('#barModels'); box.innerHTML = '';
  const list = chosen(), kind = KIND[sect()];
  if (!list.length) { box.append(el('span', 'hint', 'none — press + to pick')); return; }
  list.forEach(id => {
    const m = (S.cat[kind] || []).find(x => x.id === id) || {};
    const c = el('div', 'chip-m on');
    c.append(el('span', null, short(id)));
    if (m.price) c.append(el('span', 'p', `$${m.price}/s`));
    if (kind === 'video' && m.frames && m.frames.length && !m.frames.includes('last')) c.append(el('span', 'nf', 'first only'));
    const rm = el('span', 'rm', '×'); rm.title = 'remove';
    rm.onclick = e => { e.stopPropagation(); setModels(list.filter(x => x !== id)); };
    c.append(rm);
    c.title = id + (m.note ? '\n' + m.note : '');
    c.onclick = () => openModelPicker($('#pickModels'));
    box.append(c);
  });
}

function openModelPicker(anchor) {
  const kind = KIND[sect()];
  const wrap = el('div');
  const head = el('div', 'pop-head');
  head.append(el('span', null, kind === 'video' ? 'VIDEO MODELS' : 'IMAGE MODELS'));
  const filter = el('input', 'filter'); filter.placeholder = 'filter the catalogue…'; filter.value = S.filter;
  const picks = el('button', 'ghost tiny', 'picks'), none = el('button', 'ghost tiny', 'none');
  const all = el('label', 'cb'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = S.showAll; all.append(cb, document.createTextNode('show all'));
  head.append(filter, picks, none, all);
  wrap.append(head);
  const chips = el('div', 'chips'); wrap.append(chips);
  const paint = () => {
    chips.innerHTML = '';
    const set = new Set(chosen()), q = S.filter.toLowerCase();
    let rows = S.cat[kind] || [];
    if (!S.showAll) rows = rows.filter(m => m.pick || set.has(m.id));
    if (q) rows = rows.filter(m => m.id.toLowerCase().includes(q));
    if (!rows.length) chips.append(el('p', 'hint', 'Nothing matches.'));
    rows.forEach(m => {
      const c = el('div', 'chip-m' + (set.has(m.id) ? ' on' : '') + (m.gone ? ' gone' : ''));
      c.append(el('span', null, short(m.id)));
      if (m.price) c.append(el('span', 'p', `$${m.price}/s`));
      if (kind === 'video' && m.frames && m.frames.length && !m.frames.includes('last')) c.append(el('span', 'nf', 'first only'));
      c.title = m.id + (m.note ? '\n' + m.note : '');
      c.onclick = async () => { const next = new Set(chosen()); next.has(m.id) ? next.delete(m.id) : next.add(m.id); await setModels([...next]); paint(); };
      chips.append(c);
    });
  };
  filter.oninput = () => { S.filter = filter.value; paint(); };
  cb.onchange = () => { S.showAll = cb.checked; paint(); };
  picks.onclick = async () => { await setModels((S.cat[kind] || []).filter(m => m.pick && !m.gone).map(m => m.id)); paint(); };
  none.onclick = async () => { await setModels([]); paint(); };
  paint();
  openPop(anchor, wrap, { above: true, wide: true });
  filter.focus();
}

function composeWith(stylePrompt, content) {
  stylePrompt = (stylePrompt || '').trim(); content = (content || '').trim();
  if (!stylePrompt) return content;
  if (stylePrompt.includes('{content}')) return stylePrompt.replace('{content}', content).trim();
  return (stylePrompt + '\n\n' + content).trim();
}
function openComposed(anchor) {
  const s = shot(); if (!s) return;
  const picked = styles().filter(st => (s.styles || []).includes(st.id));
  const content = $('#prompt').value;
  const pre = el('pre', 'pop-composed');
  const refs = S.mode === 'frame' ? ((S.film.refs || []).filter(r => (s.refs || []).includes(r.id))) : [];
  const block = refs.length ? '\n\nReference images are attached, in this order:\n' + refs.map((r, i) => `${i + 1}. ${(r.tag || '').trim() || 'Use this image as a reference.'}`).join('\n') : '';
  if (!picked.length) pre.textContent = (content.trim() || '(empty)') + block;
  else picked.forEach((st, i) => {
    if (i) pre.append(document.createTextNode('\n\n'));
    pre.append(el('b', null, `── ${st.name || st.id} ──\n`));
    pre.append(document.createTextNode(composeWith(st.prompt, content) + block));
  });
  const wrap = el('div'); wrap.append(el('div', 'pop-head', 'COMPOSED — WHAT ACTUALLY GETS SENT'), pre);
  openPop(anchor, wrap, { above: true, wide: true });
}

function paintCost() {
  const out = $('#cost'), warn = $('#warn'); warn.hidden = true;
  setTimeout(paintBarSummary, 0);            // the summary quotes this line back
  const s = shot(); if (!s) { out.textContent = ''; return; }
  const list = chosen(), kind = KIND[sect()];
  if (!list.length) { out.textContent = 'no model selected'; return; }
  if (kind === 'image') {
    const caps = capsFor(list), used = (s.refs || []).length;
    if (caps.refs !== Infinity && used > caps.refs) {
      warn.hidden = false;
      warn.textContent = `This shot sends ${used} references, but ${list.map(short).join(', ')} accept${list.length === 1 ? 's' : ''} at most ${caps.refs}. The call will be refused.`;
    }
  }
  const nS = Math.max(1, (s.styles || []).length);
  if (kind === 'image') {
    // no list prices for images — what each model has billed before, per still
    const n = Math.max(1, Number($('#frameN').value) || 1);
    let total = 0, unknown = [];
    list.forEach(id => { const c = S.costs[id]; if (c) total += c.median * n * nS; else unknown.push(short(id)); });
    const calls = nS * list.length, stills = calls * n;
    let t = `${nS} × ${list.length}${n > 1 ? ` × n${n}` : ''} = ${stills} still${stills === 1 ? '' : 's'}`;
    if (total) t += ` ≈ ${money(total)} measured`;
    if (unknown.length) t += (total ? ' +' : ' ·') + ` no price data for ${unknown.join(', ')}`;
    out.textContent = t; out.title = 'image models publish no list price; this is the median of what the same model actually billed on this key';
    return;
  }
  if (s.last_frame) {
    const noLast = list.filter(id => { const m = S.cat.video.find(x => x.id === id); return m && m.frames && m.frames.length && !m.frames.includes('last'); });
    if (noLast.length) { warn.hidden = false; warn.textContent = `This shot has a last frame, but ${noLast.map(short).join(', ')} take${noLast.length === 1 ? 's' : ''} a first frame only — the generator will refuse those calls.`; }
  }
  const dur = Number($('#clipDuration').value) || 6;
  const res = $('#clipResolution').value.trim(), audio = $('#clipAudio').checked;
  // the floor for THIS call — same SKU choice as bin/gen (720p, audio), fetched once per combination
  const key = `${dur}|${res}|${audio}`;
  const floors = S.floors[key] || {};
  const missing = list.filter(id => !(id in floors));
  if (missing.length) {
    out.textContent = `${nS} × ${list.length} × ${dur}s · pricing…`;
    fetchFloors(key, missing, dur, res, audio);
    return;
  }
  let listTotal = 0, expect = 0, unpriced = 0, unmeasured = [];
  list.forEach(id => {
    const floor = floors[id];
    if (floor == null) { unpriced++; return; }
    const line = floor * nS; listTotal += line;
    const c = S.costs[id];
    if (c && c.ratio) expect += line * c.ratio; else { expect += line; unmeasured.push(short(id)); }
  });
  let t = `${nS} × ${list.length} × ${dur}s ≈ ${money(listTotal)} at list`;
  if (unpriced) t += ` (+${unpriced} unpriced)`;
  if (listTotal) {
    t += unmeasured.length < list.length - unpriced
      ? (Math.abs(expect - listTotal) > 0.0005 ? ` · expect ≈ ${money(expect)} billed` : ' · bills at list here') + (unmeasured.length ? ` (${unmeasured.join(', ')} unmeasured)` : '')
      : ' · no billing measured yet on these models';
  }
  out.textContent = t;
  out.title = 'list = the floor bin/gen prices for exactly this call (duration, resolution, audio), per style and model. expect = list × the ratio this model has actually billed over its real calls on this key';
}
S.floors = {};             // "dur|res|audio" -> { model: floor_usd | null }
let floorsBusy = null;
async function fetchFloors(key, models, dur, res, audio) {
  if (floorsBusy === key + models.join()) return;
  floorsBusy = key + models.join();
  try {
    const q = new URLSearchParams({ duration: dur, resolution: res, audio: audio ? '1' : '0' });
    models.forEach(m => q.append('model', m));
    const r = await api('GET', '/api/price?' + q);
    S.floors[key] = Object.assign({}, S.floors[key], r.floor);
    models.forEach(m => { if (!(m in S.floors[key])) S.floors[key][m] = null; });
  } catch { S.floors[key] = Object.assign({}, S.floors[key]); models.forEach(m => { S.floors[key][m] = null; }); }
  floorsBusy = null;
  paintCost();
}
function paintGenLabel() {
  const b = $('#gen');
  b.classList.toggle('dry', !S.armed);
  b.textContent = S.armed ? (S.mode === 'clip' ? 'Generate clip' : 'Generate still') : 'Dry run';
  b.title = S.armed ? 'charged against the key  (⌘/Ctrl+Enter)' : 'DISARMED — prints the exact request and cost, charges nothing. Arm in the top bar to spend.  (⌘/Ctrl+Enter)';
}

function autosize(ta) {
  ta.style.height = 'auto';
  const want = ta.scrollHeight + 2, cap = 220;
  ta.style.height = Math.min(cap, want) + 'px';
  // Past the cap the box stops growing — so let it scroll, or the rest of the
  // text is simply unreachable.
  ta.style.overflowY = want > cap ? 'auto' : 'hidden';
}

/* saving — debounced per shot, patches only what changed */
const saveTimers = new Map();
function queueSave(s, patch) {
  const key = s.id;
  const pending = Object.assign(saveTimers.get(key)?.patch || {}, patch);
  clearTimeout(saveTimers.get(key)?.t);
  saveTimers.set(key, { patch: pending, t: setTimeout(async () => {
    saveTimers.delete(key);
    try {
      const r = await api('POST', `/api/film/${S.film.slug}/shot/${s.id}`, pending);
      const live = S.film && S.film.shots.find(x => x.id === s.id);
      if (live) { const takes = live.takes; Object.assign(live, r); live.takes = takes; }
    } catch (e) { toast('save failed: ' + e.message, true); }
  }, 500) });
}
/* ------------------------------------------------- what a model will accept */
/* The catalogue publishes real limits per model: how many images in one call,
   which resolutions and aspect ratios, how many references. Two of this
   morning's failures were 400s for asking a model to do something it says
   plainly it cannot. So the bar offers only what the picked models accept, and
   anything already stored outside those limits is pulled back inside before it
   can be spent on. A parameter only one model of several understands is not
   offered at all — it would be sent to the others too. */
const limitsOf = id => {
  const m = (S.cat[KIND[sect()]] || []).find(x => x.id === id);
  return (m && m.limits) || {};
};
function capsFor(list) {
  const caps = { n: Infinity, refs: Infinity, resolution: null, aspect_ratio: null, unknown: 0 };
  if (!list.length) return caps;
  for (const id of list) {
    const l = limitsOf(id);
    if (!Object.keys(l).length) { caps.unknown++; continue; }
    if (l.n) caps.n = Math.min(caps.n, l.n[1] || 1);
    if (l.input_references) caps.refs = Math.min(caps.refs, l.input_references[1] ?? Infinity);
    for (const key of ['resolution', 'aspect_ratio']) {
      if (!l[key]) { caps[key] = []; continue; }              // this one cannot take it: offer nothing
      if (caps[key] === null) caps[key] = l[key].slice();
      else caps[key] = caps[key].filter(v => l[key].includes(v));
    }
  }
  if (caps.unknown === list.length) { caps.n = Infinity; caps.refs = Infinity; }
  return caps;
}

function paintFrameCaps() {
  if (S.mode !== 'frame') return;
  const s = shot(), caps = capsFor(chosen());
  const nBox = $('#frameN');
  const nMax = caps.n === Infinity ? 4 : Math.max(1, caps.n);
  nBox.max = nMax;
  nBox.disabled = nMax === 1;
  nBox.title = nMax === 1
    ? 'the picked model makes one image per call — press Generate again for another candidate'
    : `up to ${nMax} in one call`;
  if (Number(nBox.value) > nMax) nBox.value = nMax;

  for (const [key, sel, wrap, label] of [
    ['resolution', '#frameResolution', '#frameResWrap', 'resolution'],
    ['aspect_ratio', '#frameAspect', '#frameAspectWrap', 'aspect'],
  ]) {
    const values = caps[key] === null ? [] : caps[key];
    $(wrap).hidden = !values.length;
    const box = $(sel);
    const want = s ? (key === 'resolution' ? s.frame && s.frame.resolution : s.frame && s.frame.aspect) : '';
    box.innerHTML = '';
    const none = el('option', null, '—'); none.value = ''; box.append(none);
    values.forEach(v => { const o = el('option', null, v); o.value = v; box.append(o); });
    box.value = values.includes(want) ? want : '';
    box.title = values.length ? `${label}: what every picked model accepts` : '';
  }
}

/* Enforce, don't just display: a value stored outside the limits is written back
   inside them, once, with a line saying so. Silently sending it costs money. */
async function clampToCaps() {
  const s = shot(); if (!s || S.mode !== 'frame') return;
  const caps = capsFor(chosen()), patch = {};
  const n = Number(s.frame && s.frame.n) || 1;
  if (caps.n !== Infinity && n > caps.n) patch.n = caps.n;
  for (const [key, field] of [['resolution', 'resolution'], ['aspect_ratio', 'aspect']]) {
    const have = s.frame && s.frame[field];
    if (!have) continue;
    const values = caps[key];
    if (values !== null && !values.includes(have)) patch[field] = null;
  }
  if (!Object.keys(patch).length) return;
  s.frame = Object.assign({}, s.frame, patch);
  await api('POST', `/api/film/${S.film.slug}/shot/${s.id}`, { frame: patch });
  const said = Object.entries(patch).map(([k, v]) => v === null ? `${k} cleared` : `${k} → ${v}`);
  toast(`${short(chosen()[0] || '')} will not take that: ${said.join(', ')}`, true);
  paintBar();
}

function barPatch() {
  const s = shot(); if (!s) return;
  const num = v => v === '' ? null : Number(v);
  if (S.mode === 'clip') {
    const clip = { prompt: $('#prompt').value, duration: num($('#clipDuration').value), resolution: $('#clipResolution').value.trim(),
      aspect: $('#clipAspect').value.trim(), seed: num($('#clipSeed').value), audio: $('#clipAudio').checked };
    s.clip = Object.assign({}, s.clip, clip); queueSave(s, { clip });
  } else {
    const frame = { prompt: $('#prompt').value, n: num($('#frameN').value) || 1,
      resolution: $('#frameResolution').value || null, aspect: $('#frameAspect').value || null };
    s.frame = Object.assign({}, s.frame, frame); queueSave(s, { frame });
  }
}
async function flushSaves() {
  for (const [key, v] of [...saveTimers.entries()]) {
    clearTimeout(v.t); saveTimers.delete(key);
    await api('POST', `/api/film/${S.film.slug}/shot/${key}`, v.patch);
  }
}

/* generating ---------------------------------------------------------- */
async function generate(how, sc, s, models, stylesWanted) {
  s = s || shot(); if (!s) { toast('Pick a shot first.', true); return; }
  sc = sc || sect();
  await flushSaves();
  const list = models || chosen(sc);
  if (!list.length) { toast('Pick at least one model.', true); return; }
  const content = ((s[sc] || {}).prompt || '').trim();
  if (!content) { toast(`The ${sc === 'clip' ? 'clip' : 'still'} prompt is empty.`, true); $('#prompt').focus(); return; }
  const stylesUsed = stylesWanted !== undefined ? stylesWanted : (s.styles || []);
  const nStyles = Math.max(1, stylesUsed.length), calls = list.length * nStyles;
  if (how === 'generate' && S.armed && calls > 1 &&
      !await confirmIn(`${nStyles} style(s) × ${list.length} model(s) = ${calls} calls, each charged.\n\n${list.join('\n')}\n\nGo ahead?`)) return;
  try {
    const r = await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/${how}`, { kind: KIND[sc], models: list, styles: stylesUsed });
    // show the placeholders now rather than when the stream catches up
    (r.jobs || []).forEach(j => S.jobs.set(j.id, j)); paintGhosts(); paintJobs(); paintRunning();
    if (r.jobs && r.jobs.length) S.batches.push({ ids: r.jobs.map(j => j.id), kind: KIND[sc] });
    // an estimate is about the numbers, so show the log; a real run shows on the board
    if (how === 'estimate') { openSide('activity'); if (r.jobs && r.jobs[0]) focusJob(r.jobs[0].id); }
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------- popover */
function openPop(anchor, content, opt = {}) {
  const p = $('#pop'); p.innerHTML = ''; p.append(content); p.hidden = false;
  p.style.maxWidth = opt.wide ? 'min(720px, calc(100vw - 32px))' : '';
  const r = anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
  let left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left));
  let top = opt.above ? r.top - ph - 8 : r.bottom + 8;
  if (top < 50) top = r.bottom + 8;
  if (top + ph > window.innerHeight - 8) top = Math.max(50, window.innerHeight - ph - 8);
  p.style.left = left + 'px'; p.style.top = top + 'px';
  p.dataset.anchor = anchor.id || '';
}
function closePop() { const p = $('#pop'); if (!p.hidden) { p.hidden = true; p.innerHTML = ''; } }
document.addEventListener('pointerdown', e => {
  const p = $('#pop'); if (p.hidden) return;
  if (p.contains(e.target)) return;
  if (p.dataset.anchor && e.target.closest('#' + p.dataset.anchor)) return;
  closePop();
}, true);

/* ------------------------------------------------------------- side panel */
function openSide(tab) {
  S.side.open = true; S.side.tab = tab || S.side.tab;
  $('#side').hidden = false;
  paintSide();
}
function closeSide() { S.side.open = false; $('#side').hidden = true; }
function paintSide() {
  if (!S.side.open) return;
  $$('.stab').forEach(b => b.classList.toggle('on', b.dataset.t === S.side.tab));
  $$('.spane').forEach(p => { p.hidden = p.dataset.t !== S.side.tab; });
  if (S.side.tab === 'take') paintTake();
  if (S.side.tab === 'styles') paintStyleCards();
  if (S.side.tab === 'activity') paintJobs();
}

function paintTake() {
  const pane = $('#takePane'); pane.innerHTML = '';
  const s = shot(), t = takeById(s, S.sel);
  if (!t) { pane.append(el('p', 'hint pad', s && s.takes.length ? 'Click a card to see what made it. Double-click to enlarge.' : 'Nothing generated on this shot yet.')); return; }
  const media = el('div', 'tk-media');
  let m;
  if (t.ext === '.mp4') { m = el('video'); m.src = t.file; m.controls = true; m.muted = true; m.loop = true; if (t.poster) m.poster = t.poster; }
  else { m = el('img'); m.src = t.file; }
  media.append(m); media.onclick = e => { if (t.ext !== '.mp4') openLightbox(s, t); };
  pane.append(media);
  const body = el('div', 'tk-body');
  body.append(el('h3', 'tk-title', `${short(t.model)}`));
  const sub = el('div', 'tk-sub');
  sub.append(el('span', null, s.title || s.id));
  if (t.style_name) sub.append(el('span', 'st', t.style_name));
  sub.append(el('span', 'cost', t.cost_usd != null ? `$${t.cost_usd}` : 'dry run'));
  sub.append(el('span', null, (t.at || '').replace('T', ' ')));
  body.append(sub);
  const acts = el('div', 'tk-acts');
  takeActions(s, t, m).forEach(a => {
    const b = el('button', (a.cls === 'x' ? 'ghost danger' : 'ghost') + (a.on ? ' on' : ''), a.label === '✕' ? 'delete' : a.label); b.title = a.title || '';
    b.onclick = async () => { try { await a.run(); } catch (err) { toast(err.message, true); } };
    acts.append(b);
  });
  body.append(acts);
  const sec = (title, text, extra, small) => {
    if (!text) return;
    const d = el('div', 'sec'); const h = el('h4', null, title); if (extra) h.append(extra); d.append(h);
    d.append(el('pre', small ? 'small' : '', text)); body.append(d);
  };
  const use = el('button', 'ghost tiny', 'use as prompt');
  use.title = `copy this into the ${t.ext === '.mp4' ? 'clip' : 'still'} prompt of the shot`;
  use.onclick = () => {
    S.mode = t.ext === '.mp4' ? 'clip' : 'frame'; paintBar();
    $('#prompt').value = t.content_prompt || t.prompt || ''; autosize($('#prompt')); barPatch(); $('#prompt').focus();
    toast('prompt copied into the bar');
  };
  sec(t.style_name === 'edit' ? 'INSTRUCTION' : 'CONTENT', t.content_prompt, use);
  sec('STYLE' + (t.style_name ? ' · ' + t.style_name : ''), t.style_prompt);
  sec('SENT', t.prompt, null, true);
  const p = Object.assign({}, t.params || {}); delete p.prompt;
  sec('PARAMS', JSON.stringify(p), null, true);
  if (t.first_frame || t.last_frame) {
    const d = el('div', 'sec'); d.append(el('h4', null, 'FRAMES USED'));
    const fr = el('div', 'tk-frames');
    for (const f of [t.first_frame, t.last_frame]) { if (!f) continue; const i = el('img'); i.src = `/media/${S.film.slug}/${f}`; i.title = f; fr.append(i); }
    d.append(fr); body.append(d);
  }
  if (t.refs && t.refs.length) {
    const d = el('div', 'sec'); d.append(el('h4', null, 'REFERENCES SENT'));
    const box = el('div', 'tk-refs');
    t.refs.forEach((r, i) => { const row = el('div'); const im = el('img'); im.src = `/media/${S.film.slug}/${r.file}`; const tx = el('span'); tx.append(el('b', null, `${i + 1}. ${r.name || r.id}`), document.createTextNode(r.tag || '')); row.append(im, tx); box.append(row); });
    d.append(box); body.append(d);
  }
  if (t.edit_of) sec('EDIT OF', t.edit_of + (t.masked ? '  (region-marked)' : ''), null, true);
  sec('FILE', (t.file || '').replace('/media/', 'films/'), null, true);
  pane.append(body);
}

/* styles ---------------------------------------------------------------- */
function styleSwatch(st) {
  for (const s of S.film.shots) for (const t of s.takes) {
    if (t.style_id === st.id && (t.poster || (t.ext !== '.mp4' && t.file))) return t.poster || t.file;
  }
  return null;
}
function paintStyleCards() {
  const box = $('#styleCards'); if (!box) return; box.innerHTML = '';
  if (!S.film) return;
  if (!styles().length) { box.append(el('p', 'hint pad', 'No styles yet. Add two — one per lane — and the same shot renders both ways without retyping the content.')); return; }
  styles().forEach(st => {
    const card = el('div', 'scard' + (st.id === S.styleId ? ' on' : ''));
    const head = el('div', 'scard-head');
    const sw = el('div', 'sw'); const img = styleSwatch(st); if (img) sw.style.backgroundImage = `url("${img}")`; sw.title = img ? 'latest take in this style' : 'no take in this style yet';
    const name = el('input'); name.value = st.name || ''; name.placeholder = 'style name';
    const used = S.film.shots.filter(s => (s.styles || []).includes(st.id));
    head.append(sw, name, el('span', 'used', used.length ? `${used.length} shot${used.length === 1 ? '' : 's'}` : 'unused'));
    card.append(head);
    const ta = el('textarea'); ta.rows = 6; ta.value = st.prompt || '';
    ta.placeholder = 'How it looks. Medium, rendering, lighting, lens, finish — everything true of every shot in this lane.\n\nUse {content} to place the shot content explicitly; otherwise the style leads and the content follows.';
    card.append(ta);
    const foot = el('div', 'foot');
    const saved = el('span', 'saved', 'saved');
    foot.append(el('span', null, (st.prompt || '').includes('{content}') ? '{content} in use' : 'content appended after'), el('span', 'grow'), saved);
    const dup = el('button', 'ghost tiny', 'duplicate'); dup.title = 'copy this style as a starting point for a variant';
    dup.onclick = async () => {
      let id = (st.id + '-2').slice(0, 30), n = 2;
      while (styles().some(x => x.id === id)) id = `${st.id}-${++n}`;
      await api('POST', `/api/film/${S.film.slug}/styles`, { id, name: (st.name || st.id) + ' copy', prompt: st.prompt || '' });
      S.styleId = id; await reload();
    };
    const del = el('button', 'ghost tiny danger', 'delete');
    del.onclick = async () => {
      if (!await confirmIn(`Delete "${st.name || st.id}"?\n\n` + (used.length ? `${used.length} shot(s) use it and will fall back to their content prompt alone.` : 'No shot uses it.'))) return;
      await api('POST', `/api/film/${S.film.slug}/styles`, { id: st.id, delete: true });
      if (S.styleId === st.id) S.styleId = null;
      await reload();
    };
    foot.append(dup, del); card.append(foot);
    let t = null;
    const save = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        st.name = name.value; st.prompt = ta.value;
        await api('POST', `/api/film/${S.film.slug}/styles`, { id: st.id, name: name.value, prompt: ta.value });
        saved.classList.add('show'); setTimeout(() => saved.classList.remove('show'), 1200);
        paintBarStyles();
      }, 450);
    };
    name.oninput = save; ta.oninput = save;
    card.onpointerdown = () => { if (S.styleId !== st.id) { S.styleId = st.id; $$('.scard').forEach(c => c.classList.toggle('on', c === card)); } };
    box.append(card);
  });
}
async function newStyle() {
  if (!S.film) { toast('Create or pick a film first', true); return; }
  const name = await ask('Name the style — the lane, e.g. "Hyperreal" or "Drawn"', '');
  if (!name) return;
  const id = slugify(name, 32) || 'style-' + Date.now().toString(36);
  try {
    await api('POST', `/api/film/${S.film.slug}/styles`, { id, name });
    S.styleId = id; await reload(); openSide('styles');
    const ta = $('#styleCards .scard.on textarea'); if (ta) ta.focus();
  } catch (e) { toast(e.message, true); }
}

/* activity -------------------------------------------------------------- */
function paintJobs() {
  const box = $('#jobs'); if (!box) return; box.innerHTML = '';
  const list = [...S.jobs.values()].sort((a, b) => (b.started || '').localeCompare(a.started || ''));
  if (!list.length) { box.append(el('p', 'idle', 'Nothing running.\nGenerate prints every line the generator writes, right here.')); return; }
  list.forEach(j => {
    const d = el('div', 'job' + (j.id === S.focusJob ? ' focus' : '')); d.dataset.job = j.id;
    const h = el('div', 'h');
    h.append(el('span', 'st ' + j.state, j.state.toUpperCase()),
             el('b', null, `${j.shot_title || j.shot}${j.style ? ' · ' + j.style : ''} · ${short(j.model)}`));
    h.append(el('span', 'x', j.dry ? (j.cost_est != null ? '≈ ' + money(j.cost_est) + (j.cost_expect != null && j.cost_expect !== j.cost_est ? ' → ' + money(j.cost_expect) : '') + ' dry' : 'dry')
                                : (j.cost != null ? '$' + j.cost : '')));
    d.append(h);
    const pre = el('pre'); pre.textContent = (j.lines || []).join('\n'); pre.dataset.job = j.id;
    d.append(pre); box.append(d); pre.scrollTop = pre.scrollHeight;
  });
}
function focusJob(id) {
  S.focusJob = id;
  $$('.job').forEach(j => j.classList.toggle('focus', j.dataset.job === id));
  const n = document.querySelector(`.job[data-job="${id}"]`); if (n) n.scrollIntoView({ block: 'nearest' });
}
/* One toast per fan-out, once every job in it has ended: the sum of what the
   dry runs estimate, or of what the real calls billed. */
function settleBatches(endedId) {
  S.batches = S.batches.filter(b => {
    if (!b.ids.includes(endedId)) return true;
    const jobs = b.ids.map(id => S.jobs.get(id)).filter(Boolean);
    if (jobs.some(j => j.state === 'running')) return true;
    const ok = jobs.filter(j => j.state !== 'error'), failed = jobs.length - ok.length;
    if (!ok.length) return false;
    const n = ok.length, call = n === 1 ? 'call' : 'calls';
    if (ok[0].dry) {
      const est = ok.reduce((a, j) => a + (j.cost_est || 0), 0), unknown = ok.filter(j => j.cost_est == null).length;
      const exp = ok.reduce((a, j) => a + (j.cost_expect != null ? j.cost_expect : (j.cost_est || 0)), 0);
      let t = `Dry run · ${n} ${call} ≈ ${money(est)}`;
      t += b.kind === 'image' ? ' measured' : ' at list';
      if (b.kind === 'video' && Math.abs(exp - est) > 0.0005) t += ` · expect ≈ ${money(exp)} billed`;
      if (unknown) t += ` · ${unknown} without price data`;
      if (failed) t += ` · ${failed} failed`;
      toast(t + ' · nothing charged');
    } else {
      const billed = ok.reduce((a, j) => a + (j.cost || 0), 0);
      toast(`${n} ${call} billed ${money(billed)}` + (failed ? ` · ${failed} failed` : ''));
      loadCosts();
    }
    return false;
  });
}

function paintRunning() {
  const n = [...S.jobs.values()].filter(j => j.state === 'running').length;
  const b = $('#running'); b.hidden = !n; b.textContent = `● ${n} running`;
  $('#actCount').textContent = n ? `· ${n}` : '';
}

function paintSpend(sp) {
  const c = $('#spend');
  if (!sp || sp.error) { c.textContent = 'spend ?'; return; }
  const left = parseFloat(sp.limit_remaining), lim = parseFloat(sp.limit);
  c.textContent = `$${(+sp.usage).toFixed(2)} used · $${left.toFixed(2)} left of $${lim}`;
  c.className = 'chip' + (left <= 0 ? ' out' : left < lim * 0.2 ? ' low' : '');
}
function paintArm() {
  const b = $('#arm');
  b.dataset.armed = S.armed ? '1' : '0';
  b.textContent = S.armed ? 'ARMED — calls cost money' : 'DISARMED — dry runs only';
  paintGenLabel();
}

function listen() {
  // ?nostream leaves the live feed off. An open EventSource never lets a page
  // finish "loading", which makes headless screenshots impossible.
  if (location.search.includes('nostream')) return;
  const es = new EventSource('/api/stream');
  es.onmessage = ev => {
    const { event, payload } = JSON.parse(ev.data);
    if (event === 'job.start') { S.jobs.set(payload.id, payload); paintJobs(); paintGhosts(); paintRunning(); }
    else if (event === 'job.line') {
      const j = S.jobs.get(payload.id); if (!j) return;
      j.lines = (j.lines || []).concat(payload.line).slice(-60);
      const pre = document.querySelector(`pre[data-job="${payload.id}"]`);
      if (pre) { pre.textContent = j.lines.join('\n'); pre.scrollTop = pre.scrollHeight; }
      const gl = document.querySelector(`[data-jobline="${payload.id}"]`); if (gl) gl.textContent = payload.line;
    }
    else if (event === 'job.end') {
      S.jobs.set(payload.id, payload); paintJobs(); paintRunning();
      settleBatches(payload.id);
      if (payload.state === 'error') { paintGhosts(); toast(`${short(payload.model)}: ${payload.error || 'failed'}`, true); }
      else if (S.film && payload.film === S.film.slug) reload();
      api('GET', '/api/state').then(st => paintSpend(st.spend)).catch(() => {});
    }
    else if (event === 'film.changed') { if (S.film && payload.slug === S.film.slug) reload(); }
    else if (event === 'films.changed') { refreshFilms().catch(() => {}); }
    else if (event === 'armed') { S.armed = payload.armed; paintArm(); }
  };
  es.onerror = () => { /* EventSource reconnects on its own */ };
}

/* --------------------------------------------------------------- lightbox */
/* Enlarge a take, paint over the part you want changed, and send it back as
   an edit. No image model on this API takes a mask, so the painted area is
   communicated by sending a marked copy alongside the clean original — see
   mark_region() in bench.py. ← → step through the shot's takes. */
function openLightbox(s, t) {
  if (s && s.ref) { S.lb = { ref: s.ref, video: false }; }
  else if (s && s.plain) { S.lb = { plain: s, video: !!s.video }; }
  else S.lb = { take: t, shot: s, video: t.ext === '.mp4', list: s.takes, idx: s.takes.indexOf(t) };
  const lb = S.lb;
  const title = lb.ref ? `${lb.ref.name || lb.ref.id} · reference`
    : lb.plain ? lb.plain.title
    : `${s.title || s.id} · ${short(t.model)}${t.style_name ? ' · ' + t.style_name : ''}${t.cost_usd != null ? ' · $' + t.cost_usd : ''}`;
  $('#lbTitle').textContent = title;
  $('#lbNote').textContent = ''; $('#lbInstr').value = '';
  const img = $('#lbImg'), vid = $('#lbVid'), cv = $('#lbCanvas');
  const simple = !!lb.plain || !!lb.ref;
  img.hidden = lb.video; vid.hidden = !lb.video; cv.hidden = lb.video || simple;
  $('#lbMaskTools').style.display = (lb.video || simple) ? 'none' : '';
  $('#lbFoot').hidden = simple;
  $('#lbRefFoot').hidden = !lb.ref;
  $('#lbPrev').hidden = $('#lbNext').hidden = simple || (lb.list || []).length < 2;
  $('#lbGrabFirst').hidden = $('#lbGrabLast').hidden = !lb.video;
  if (lb.ref) {
    $('#lbRefName').value = lb.ref.name || '';
    $('#lbRefTag').value = lb.ref.tag || '';
    $('#lbRefNote').textContent = (() => { const u = refUsers(lb.ref); return u.length ? `sent by ${u.length} shot${u.length === 1 ? '' : 's'}` : 'not linked to any board yet'; })();
  }
  const file = lb.ref ? refUrl(lb.ref) + '?t=' + Date.now() : lb.plain ? lb.plain.file : t.file;
  if (lb.video) { vid.src = file; vid.currentTime = 0; vid.play().catch(() => {}); }
  else {
    img.src = file;
    img.onload = () => {
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.style.width = img.clientWidth + 'px'; cv.style.height = img.clientHeight + 'px';
      cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    };
  }
  $('#lb').hidden = false;
}
function closeLightbox() { $('#lb').hidden = true; $('#lbVid').pause(); S.lb = null; }
function lbStep(d) {
  const lb = S.lb; if (!lb || lb.plain || !lb.list) return;
  const i = (lb.idx + d + lb.list.length) % lb.list.length;
  openLightbox(lb.shot, lb.list[i]);
}

(function paintbrush() {
  const cv = $('#lbCanvas'); let drawing = false;
  const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
  const dab = e => {
    const ctx = cv.getContext('2d'); const [x, y] = at(e);
    const scale = cv.width / (cv.getBoundingClientRect().width || cv.width);
    ctx.fillStyle = 'rgba(255,0,220,1)'; ctx.beginPath();
    ctx.arc(x, y, (Number($('#lbBrush').value) / 2) * scale, 0, Math.PI * 2); ctx.fill();
  };
  cv.addEventListener('pointerdown', e => { drawing = true; capture(cv, e); dab(e); });
  cv.addEventListener('pointermove', e => { if (drawing) dab(e); });
  cv.addEventListener('pointerup', () => { drawing = false; });
  cv.addEventListener('pointerleave', () => { drawing = false; });
})();
function maskDataUrl() {
  const cv = $('#lbCanvas'); if (cv.hidden || !cv.width) return null;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return cv.toDataURL('image/png');
  return null;
}
$('#lbClose').onclick = closeLightbox;
$('#lbPrev').onclick = () => lbStep(-1);
$('#lbNext').onclick = () => lbStep(1);
$('#lbClear').onclick = () => { const cv = $('#lbCanvas'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); };
$('#lbEdit').onclick = async () => {
  const lb = S.lb; if (!lb || lb.plain) return;
  const instruction = $('#lbInstr').value.trim();
  if (!instruction) { $('#lbNote').textContent = 'Say what to change.'; return; }
  const mask = maskDataUrl();
  const models = chosen('frame');
  $('#lbNote').textContent = 'sending…';
  try {
    const r = await api('POST', `/api/film/${S.film.slug}/shot/${lb.shot.id}/edit`, {
      take: lb.take.id, instruction, mask, models: models.length ? models : undefined,
      time: lb.video ? $('#lbVid').currentTime : undefined
    });
    (r.jobs || []).forEach(j => S.jobs.set(j.id, j)); paintGhosts(); paintJobs(); paintRunning();
    $('#lbNote').textContent = (S.armed ? 'running' : 'dry run') + (mask ? ' — region-limited' : ' — whole image') + ' · result lands on the board';
  } catch (e) { $('#lbNote').textContent = e.message; }
};
for (const [id, slot] of [['#lbGrabFirst', 'first'], ['#lbGrabLast', 'last']]) {
  $(id).onclick = async () => {
    const lb = S.lb; if (!lb || lb.plain) return;
    await api('POST', `/api/film/${S.film.slug}/shot/${lb.shot.id}/promote`, { take: lb.take.id, slot, time: $('#lbVid').currentTime });
    $('#lbNote').textContent = `grabbed at ${$('#lbVid').currentTime.toFixed(2)}s as ${slot} frame`;
    await reload();
  };
}

/* --------------------------------------------------------------- keyboard */
document.addEventListener('keydown', e => {
  if (e.key === ' ' && !typing()) { S.space = true; $('#canvas').classList.add('spacing'); if (e.target === document.body) e.preventDefault(); }
  if (e.key === 'Control' || e.key === 'Meta') $('#canvas').classList.add('moving');
  if (e.key === 'Escape') {
    if (!$('#ask').hidden) { $('#askNo').click(); return; }
    if (S.lb) { closeLightbox(); return; }
    if (!$('#pop').hidden) { closePop(); return; }
    if (typing()) { document.activeElement.blur(); return; }
    if (S.sel) { S.sel = null; $$('#world .card.sel').forEach(c => c.classList.remove('sel')); if (S.side.open && S.side.tab === 'take') paintSide(); return; }
    if (S.side.open) { closeSide(); return; }
  }
  if (S.lb && !typing()) {
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate('generate'); return; }
  if (typing() || S.lb) return;
  const oops = err => toast(err.message, true);
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const s = shot(); if (s) { e.preventDefault(); moveShot(s, e.key === 'ArrowLeft' ? -1 : 1).catch(oops); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepShot(e.key === 'ArrowLeft' ? -1 : 1); return; }
  if (e.key === '?') { e.preventDefault(); openHelp($('#help')); return; }
  if (e.key === '/') { e.preventDefault(); showBar(); $('#prompt').focus(); return; }
  if (e.key === 'f' || e.key === 'F') { fit(); return; }
  if (e.key === 'n') { newShot(); return; }
  if (e.key === 'N') { newFilm(); return; }
  if (e.key === 'b') { S.fold === 'gone' ? setFold('full') : foldBar(1); return; }
  if (e.key === 'B') { foldBar(-1); return; }
  if (e.key === 'd' || e.key === 'D') { const s = shot(); if (s) duplicateShot(s).catch(oops); return; }
  if (e.key === 's' || e.key === 'S') { S.side.open && S.side.tab === 'styles' ? closeSide() : openSide('styles'); return; }
  if (e.key === 'l' || e.key === 'L') { S.side.open && S.side.tab === 'activity' ? closeSide() : openSide('activity'); return; }
  if (e.key === '1') { S.mode = 'frame'; paintBar(); return; }
  if (e.key === '2') { S.mode = 'clip'; paintBar(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const s = shot(); if (!s) return;
    const t = S.sel && takeById(s, S.sel);
    if (t) { takeActions(s, t).find(a => a.cls === 'x').run().catch(oops); return; }
    deleteShot(s).catch(oops);                 // nothing selected: the shot itself
  }
});

/* ------------------------------------------------------------------- help */
const SHORTCUTS = [
  ['n', 'new shot'],
  ['shift + N', 'new film'],
  ['D', 'duplicate the active shot'],
  ['B', 'fold the bar a step: full → compact → strip → hidden'],
  ['shift + B', 'unfold a step'],
  ['Del  ⌫', 'delete the selected take — or the active shot, when no take is selected'],
  ['←  →', 'previous / next shot'],
  ['alt + ←  →', 'move the active shot earlier / later in the film'],
  ['1  2', 'still / clip'],
  ['/', 'jump into the prompt'],
  ['⌘ / ctrl + ⏎', 'Generate'],
  ['F', 'fit the whole film'],
  ['ctrl + wheel', 'zoom — space-drag or middle-drag pans'],
  ['S', 'styles panel'],
  ['L', 'activity log'],
  ['Esc', 'close: take, popover, panel, lightbox'],
  ['?', 'this list'],
];
function openHelp(anchor) {
  const d = el('div', 'keys');
  d.append(el('h4', null, 'Keyboard'));
  for (const [k, what] of SHORTCUTS) {
    const row = el('div', 'krow'); row.append(el('kbd', null, k), el('span', null, what)); d.append(row);
  }
  d.append(el('h4', null, 'Arranging nodes'));
  const p = el('p', 'hint');
  p.textContent = 'Drag a board by its head. Along the row that reorders the film; pull one down and the film switches to free placement, where a drag just moves the node and the number badge stays the film order. Hold ctrl (or ⌘) and you can pick any node up from anywhere on it — over its title, its notes, its cards. References also move by the ⠿ grip. “tidy every node back into a row” in either ⋯ menu undoes the lot.';
  d.append(p);
  openPop(anchor, d, { below: true, wide: true });
}
document.addEventListener('keyup', e => {
  if (e.key === ' ') { S.space = false; $('#canvas').classList.remove('spacing'); }
  if (e.key === 'Control' || e.key === 'Meta') $('#canvas').classList.remove('moving');
});
// a keyup that lands in another window never arrives, so the cursor would stick
window.addEventListener('blur', () => { S.space = false; $('#canvas').classList.remove('spacing', 'moving'); });
$('#ask').addEventListener('pointerdown', e => { if (e.target.id === 'ask') $('#askNo').click(); });

/* ----------------------------------------------------------------- wiring */
$('#filmPick').onchange = e => { S.shotId = null; S.sel = null; openFilm(e.target.value, true); };
$('#newFilm').onclick = newFilm;
$('#filmMenu').onclick = () => $('#pop').hidden || $('#pop').dataset.anchor !== 'filmMenu' ? filmMenu($('#filmMenu')) : closePop();
$('#help').onclick = () => $('#pop').hidden || $('#pop').dataset.anchor !== 'help' ? openHelp($('#help')) : closePop();
$('#zoomIn').onclick = () => { const [x, y] = canvasCenter(); zoomAt(x, y, 1.25); };
$('#zoomOut').onclick = () => { const [x, y] = canvasCenter(); zoomAt(x, y, 0.8); };
$('#zoomPct').onclick = () => { const [x, y] = canvasCenter(); zoomAt(x, y, 1 / S.view.z); };
$('#fit').onclick = fit;
$('#running').onclick = () => openSide('activity');
$('#stylesBtn').onclick = () => S.side.open && S.side.tab === 'styles' ? closeSide() : openSide('styles');
$('#manageStyles').onclick = () => styles().length ? openSide('styles') : newStyle();
$('#addStyle').onclick = newStyle;
$('#addRef').onclick = () => $('#refFile').click();
$('#refFile').onchange = async e => { await addRefFiles(e.target.files, S.shotId); e.target.value = ''; };
(function dropzone() {
  const cv = $('#canvas');
  cv.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); cv.classList.add('dropping'); } });
  cv.addEventListener('dragleave', e => { if (e.target === cv) cv.classList.remove('dropping'); });
  cv.addEventListener('drop', async e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault(); cv.classList.remove('dropping');
    const board = e.target.closest && e.target.closest('.board:not(.adder)');
    await addRefFiles(e.dataTransfer.files, board ? board.dataset.id : null);
  });
  document.addEventListener('paste', e => {
    if (typing()) return;
    const files = [...(e.clipboardData && e.clipboardData.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addRefFiles(files, S.shotId); }
  });
})();
$('#sideClose').onclick = closeSide;
$$('.stab').forEach(b => { b.onclick = () => openSide(b.dataset.t); });
$('#clearJobs').onclick = () => { [...S.jobs.values()].filter(j => j.state !== 'running').forEach(j => S.jobs.delete(j.id)); paintJobs(); paintGhosts(); paintRunning(); };
$('#spend').onclick = async () => paintSpend(await api('GET', '/api/spend'));
$('#arm').onclick = async () => {
  if (!S.armed && !await confirmIn('Arm the bench?\n\nEvery Generate from now on reaches the API and costs real money against the key.')) return;
  const r = await api('POST', '/api/arm', { armed: !S.armed });
  S.armed = r.armed; paintArm();
};
$('#stitch').onclick = async () => {
  if (!S.film) return;
  const btn = $('#stitch'); btn.disabled = true; btn.textContent = 'stitching…';
  try {
    const r = await api('POST', `/api/film/${S.film.slug}/stitch`);
    if (r.error) toast(r.error, true);
    else {
      toast(`${r.shots} shot${r.shots === 1 ? '' : 's'} joined${r.missing.length ? ` · ${r.missing.length} without a picked clip` : ''} · ${(r.bytes / 1e6).toFixed(1)} MB`);
      openLightbox({ plain: true, title: `${S.film.title} — the cut`, file: r.file + '?t=' + Date.now(), video: true });
    }
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'stitch';
};
/* The reference lightbox. Replacing the picture keeps the node — its id is what
   every linked board points at, so deleting and re-adding would silently unlink
   it everywhere and lose the tag. */
$('#lbRefReplace').onclick = () => $('#lbRefFile').click();
$('#lbRefFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  const lb = S.lb; if (!f || !lb || !lb.ref) return;
  $('#lbRefNote').textContent = 'replacing…';
  try {
    const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f); });
    await api('POST', `/api/film/${S.film.slug}/refs`, { id: lb.ref.id, data });
    await reload();
    const r = refById(lb.ref.id);
    if (r) openLightbox({ ref: r });
    toast(`“${(r && r.name) || lb.ref.id}” now uses ${f.name} — every board that sends it picks the new image up`);
  } catch (err) { $('#lbRefNote').textContent = ''; toast(err.message, true); }
};
$('#lbRefSave').onclick = async () => {
  const lb = S.lb; if (!lb || !lb.ref) return;
  try {
    await api('POST', `/api/film/${S.film.slug}/refs`, { id: lb.ref.id, name: $('#lbRefName').value, tag: $('#lbRefTag').value });
    await reload();
    const r = refById(lb.ref.id); if (r) { lb.ref = r; $('#lbTitle').textContent = `${r.name || r.id} · reference`; }
    $('#lbRefNote').textContent = 'saved';
  } catch (err) { toast(err.message, true); }
};

$('#barFold').onclick = () => foldBar(1);
$('#barUnfold').onclick = () => foldBar(-1);
$('#barShow').onclick = () => setFold('full');
$('#target').onclick = () => { if (S.shotId) centerOn(S.shotId); };
$$('.mode').forEach(b => { b.onclick = () => { S.mode = b.dataset.mode; paintBar(); $('#prompt').focus(); }; });
$('#prompt').oninput = () => { autosize($('#prompt')); barPatch(); };
['#clipDuration', '#clipResolution', '#clipAspect', '#clipSeed', '#clipAudio',
 '#frameN', '#frameResolution', '#frameAspect'].forEach(sel => { $(sel).oninput = () => { barPatch(); paintCost(); }; });
$('#pickModels').onclick = () => $('#pop').hidden || $('#pop').dataset.anchor !== 'pickModels' ? openModelPicker($('#pickModels')) : closePop();
$('#composedBtn').onclick = () => $('#pop').hidden || $('#pop').dataset.anchor !== 'composedBtn' ? openComposed($('#composedBtn')) : closePop();
$('#gen').onclick = () => generate('generate');
$('#est').onclick = () => generate('estimate');
window.addEventListener('resize', () => { /* view stays; nothing to do */ });

boot().catch(e => { document.body.innerHTML = `<p style="padding:40px;color:#e8564a">${e.message}</p>`; });
