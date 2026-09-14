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
  styleId: null, lb: null, drag: null, space: false
};
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

  const pick = $('#filmPick'); pick.innerHTML = '';
  st.films.forEach(f => { const o = el('option', null, `${f.title}  (${f.shots})`); o.value = f.slug; pick.append(o); });
  const want = location.hash.slice(1) || (st.films[0] && st.films[0].slug);
  $('#canvasEmpty').hidden = !!want;
  if (want) { pick.value = want; await openFilm(want, true); }
  paintJobs(); paintRunning();
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
async function openFilm(slug, first) {
  S.film = await api('GET', `/api/film/${slug}`);
  location.hash = slug;
  if (!S.film.shots.some(s => s.id === S.shotId)) S.shotId = S.film.shots[0] ? S.film.shots[0].id : null;
  if (S.sel && !takeById(shot(), S.sel)) S.sel = null;
  paintFilm();
  if (first) {
    // Open readable: the first board at 100%, top-left. `fit` is one key away.
    const saved = loadView(slug);
    S.view = saved || { x: 40 - X0, y: 40 - Y0, z: 1 };
    applyView();
  }
  paintBar(); paintSide();
}
const reload = () => S.film && openFilm(S.film.slug);

/* ------------------------------------------------------------- the canvas */
function layout() {
  $$('#world .board').forEach((b, i) => { b.style.left = (X0 + i * (BW + GAP)) + 'px'; b.style.top = Y0 + 'px'; });
}

function paintFilm() {
  const w = $('#world'); w.innerHTML = '';
  if (!S.film) return;
  S.film.shots.forEach((s, i) => w.append(renderBoard(s, i)));
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
  head.append(menu);
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

function paintBoardMeta(node, s) {
  node.innerHTML = '';
  const n = s.takes.length;
  node.append(document.createTextNode(`${n} take${n === 1 ? '' : 's'}`));
  const cut = takeById(s, s.selected_take);
  if (cut) { node.append(document.createTextNode(' · ')); node.append(el('span', 'cut', '★ ' + short(cut.model))); }
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
  add('duplicate shot', () => duplicateShot(s));
  m.append(el('hr'));
  add('delete shot', async () => {
    if (!await confirmIn(`Delete shot "${s.title || s.id}"?\n\nIts takes stay on disk.`)) return;
    await api('POST', `/api/film/${S.film.slug}/shot/${s.id}/delete`);
    if (S.shotId === s.id) { S.shotId = null; S.sel = null; }
    await reload();
  }, 'danger');
  openPop(anchor, m, { below: true });
}

async function duplicateShot(s) {
  let id = s.id + '-2', n = 2;
  while (S.film.shots.some(x => x.id === id)) id = `${s.id}-${++n}`;
  const made = await api('POST', `/api/film/${S.film.slug}/shots`, { id, title: (s.title || s.id) + ' copy' });
  const clip = Object.assign({}, s.clip), frame = Object.assign({}, s.frame);
  await api('POST', `/api/film/${S.film.slug}/shot/${made.id}`, { note: s.note || '', styles: s.styles || [], clip, frame });
  S.shotId = made.id; S.sel = null;
  await reload(); centerOn(made.id);
}

async function newShot() {
  if (!S.film) { toast('Create or pick a film first', true); return; }
  const title = await ask('What happens in this shot?', '');
  if (!title) return;
  try {
    const s = await api('POST', `/api/film/${S.film.slug}/shots`, { id: slugify(title, 40), title });
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
  const boards = $$('#world .board'); if (!boards.length) return;
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
    const card = t.closest('.card');
    if (card && !card.classList.contains('ghost') && !t.closest('.ctools')) {
      start = { kind: 'card', x: e.clientX, y: e.clientY, card, moved: false };
      capture(cv, e); e.preventDefault(); return;
    }
    if (t.closest('.bhead') && !isControl(t) && board) {
      start = { kind: 'board', x: e.clientX, y: e.clientY, board, left: parseFloat(board.style.left), moved: false };
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
    if (start.kind === 'board') {
      if (!start.moved) { start.moved = true; start.board.classList.add('lifting'); }
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
    if (st.kind === 'board') {
      st.board.classList.remove('lifting');
      if (!st.moved) { layout(); return; }
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

  cv.addEventListener('wheel', e => {
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
  paintBarStyles(); paintBarModels(); paintCost(); paintGenLabel();
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
  if (!picked.length) pre.textContent = content.trim() || '(empty)';
  else picked.forEach((st, i) => {
    if (i) pre.append(document.createTextNode('\n\n'));
    pre.append(el('b', null, `── ${st.name || st.id} ──\n`));
    pre.append(document.createTextNode(composeWith(st.prompt, content)));
  });
  const wrap = el('div'); wrap.append(el('div', 'pop-head', 'COMPOSED — WHAT ACTUALLY GETS SENT'), pre);
  openPop(anchor, wrap, { above: true, wide: true });
}

function paintCost() {
  const out = $('#cost'), warn = $('#warn'); warn.hidden = true;
  const s = shot(); if (!s) { out.textContent = ''; return; }
  const list = chosen(), kind = KIND[sect()];
  if (!list.length) { out.textContent = 'no model selected'; return; }
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

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; }

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
function barPatch() {
  const s = shot(); if (!s) return;
  const num = v => v === '' ? null : Number(v);
  if (S.mode === 'clip') {
    const clip = { prompt: $('#prompt').value, duration: num($('#clipDuration').value), resolution: $('#clipResolution').value.trim(),
      aspect: $('#clipAspect').value.trim(), seed: num($('#clipSeed').value), audio: $('#clipAudio').checked };
    s.clip = Object.assign({}, s.clip, clip); queueSave(s, { clip });
  } else {
    const frame = { prompt: $('#prompt').value, n: num($('#frameN').value) || 1 };
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
  if (s && s.plain) { S.lb = { plain: s, video: !!s.video }; }
  else S.lb = { take: t, shot: s, video: t.ext === '.mp4', list: s.takes, idx: s.takes.indexOf(t) };
  const lb = S.lb;
  const title = lb.plain ? lb.plain.title : `${s.title || s.id} · ${short(t.model)}${t.style_name ? ' · ' + t.style_name : ''}${t.cost_usd != null ? ' · $' + t.cost_usd : ''}`;
  $('#lbTitle').textContent = title;
  $('#lbNote').textContent = ''; $('#lbInstr').value = '';
  const img = $('#lbImg'), vid = $('#lbVid'), cv = $('#lbCanvas');
  img.hidden = lb.video; vid.hidden = !lb.video; cv.hidden = lb.video || !!lb.plain;
  $('#lbMaskTools').style.display = (lb.video || lb.plain) ? 'none' : '';
  $('#lbFoot').hidden = !!lb.plain;
  $('#lbPrev').hidden = $('#lbNext').hidden = !!lb.plain || (lb.list || []).length < 2;
  $('#lbGrabFirst').hidden = $('#lbGrabLast').hidden = !lb.video;
  const file = lb.plain ? lb.plain.file : t.file;
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
  if (e.key === 'f' || e.key === 'F') fit();
  if (e.key === '1') { S.mode = 'frame'; paintBar(); }
  if (e.key === '2') { S.mode = 'clip'; paintBar(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
    const s = shot(), t = takeById(s, S.sel); if (!t) return;
    takeActions(s, t).find(a => a.cls === 'x').run().catch(err => toast(err.message, true));
  }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { S.space = false; $('#canvas').classList.remove('spacing'); } });
$('#ask').addEventListener('pointerdown', e => { if (e.target.id === 'ask') $('#askNo').click(); });

/* ----------------------------------------------------------------- wiring */
$('#filmPick').onchange = e => { S.shotId = null; S.sel = null; openFilm(e.target.value, true); };
$('#newFilm').onclick = async () => {
  const title = await ask('Name for the new film', '');
  if (!title) return;
  const slug = slugify(title, 48) || 'film-' + Date.now().toString(36);
  try {
    await api('POST', '/api/films', { slug, title });
    const o = el('option', null, title); o.value = slug; $('#filmPick').append(o); $('#filmPick').value = slug;
    S.shotId = null; S.sel = null; $('#canvasEmpty').hidden = true;
    await openFilm(slug, true); toast(`film "${title}" created — add a shot`);
  } catch (e) { toast(e.message, true); }
};
$('#zoomIn').onclick = () => { const [x, y] = canvasCenter(); zoomAt(x, y, 1.25); };
$('#zoomOut').onclick = () => { const [x, y] = canvasCenter(); zoomAt(x, y, 0.8); };
$('#zoomPct').onclick = () => { const [x, y] = canvasCenter(); zoomAt(x, y, 1 / S.view.z); };
$('#fit').onclick = fit;
$('#running').onclick = () => openSide('activity');
$('#stylesBtn').onclick = () => S.side.open && S.side.tab === 'styles' ? closeSide() : openSide('styles');
$('#manageStyles').onclick = () => styles().length ? openSide('styles') : newStyle();
$('#addStyle').onclick = newStyle;
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
$('#target').onclick = () => { if (S.shotId) centerOn(S.shotId); };
$$('.mode').forEach(b => { b.onclick = () => { S.mode = b.dataset.mode; paintBar(); $('#prompt').focus(); }; });
$('#prompt').oninput = () => { autosize($('#prompt')); barPatch(); };
['#clipDuration', '#clipResolution', '#clipAspect', '#clipSeed', '#clipAudio', '#frameN'].forEach(sel => { $(sel).oninput = () => { barPatch(); paintCost(); }; });
$('#pickModels').onclick = () => $('#pop').hidden || $('#pop').dataset.anchor !== 'pickModels' ? openModelPicker($('#pickModels')) : closePop();
$('#composedBtn').onclick = () => $('#pop').hidden || $('#pop').dataset.anchor !== 'composedBtn' ? openComposed($('#composedBtn')) : closePop();
$('#gen').onclick = () => generate('generate');
$('#est').onclick = () => generate('estimate');
window.addEventListener('resize', () => { /* view stays; nothing to do */ });

boot().catch(e => { document.body.innerHTML = `<p style="padding:40px;color:#e8564a">${e.message}</p>`; });
