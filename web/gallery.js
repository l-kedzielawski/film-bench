'use strict';
/* film-bench — the gallery.
 *
 * Every take the bench has made, newest first, across every film. The canvas is
 * one shot at a time on purpose; this is the other half of that — finding the
 * still you remember rather than the one you are working on. Disk is still the
 * source of truth and bench.py is still its only writer: this page only asks.
 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const api = async (m, p, b) => {
  const r = await fetch(p, b === undefined ? { method: m } : {
    method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const short = id => (id || '').split('/').pop();
const money = v => v == null ? '' : '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2));
const tagOf = t => '#' + String(t.id || '').split('-').pop();
const fileOf = t => (t.file || '').split('/').pop();
const pathOf = t => (G.root ? G.root.replace(/\/$/, '') + '/' : 'films/') + (t.file || '').replace('/media/', '');

const G = { takes: [], root: '', favOnly: false, q: '', film: '', model: '', kind: '', lb: null };

let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  t.classList.toggle('bad', !!bad);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { toast('could not copy — ' + text, true); ta.remove(); return; }
    ta.remove();
  }
  toast(`${what} copied — ${text.length > 60 ? '…' + text.slice(-54) : text}`);
}
/* Same rule as the canvas: a click gives you text, a modifier gives you the path.
   Pasting a path to a PNG at an agent makes most terminals attach the image. */
const copyTake = (t, e) => (e && (e.shiftKey || e.altKey))
  ? copyText(pathOf(t), tagOf(t) + ' path') : copyText(fileOf(t), tagOf(t));

function matches(t) {
  if (G.favOnly && !t.fav) return false;
  if (G.film && t.film !== G.film) return false;
  if (G.model && t.model !== G.model) return false;
  if (G.kind === 'img' && t.ext === '.mp4') return false;
  if (G.kind === 'vid' && t.ext !== '.mp4') return false;
  if (!G.q) return true;
  const hay = [t.model, t.style_name, t.shot_title, t.shot, t.film_title, t.film, t.id, t.prompt]
    .join(' ').toLowerCase();
  return G.q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function paint() {
  const grid = $('#grid'); grid.innerHTML = '';
  const rows = G.takes.filter(matches);
  $('#gempty').hidden = !!rows.length;
  if (!rows.length) {
    $('#gempty').textContent = G.takes.length
      ? 'Nothing matches those filters.'
      : 'No takes yet. Generate something on the canvas and it turns up here.';
  }
  const spend = rows.reduce((a, t) => a + (t.cost_usd || 0), 0);
  $('#gcount').textContent = `${rows.length} of ${G.takes.length} · ${money(spend) || '$0'}` +
    ` · ${G.takes.filter(t => t.fav).length} ★`;
  rows.forEach(t => grid.append(card(t)));
}

function card(t) {
  const isV = t.ext === '.mp4';
  const n = el('div', 'g' + (t.fav ? ' fav' : ''));
  const th = el('div', 'th');
  if (isV) { const v = el('video'); v.src = t.file; v.muted = true; v.loop = true; v.preload = 'metadata';
    if (t.poster) v.poster = t.poster;
    th.onmouseenter = () => v.play().catch(() => {}); th.onmouseleave = () => { v.pause(); v.currentTime = 0; };
    th.append(v); }
  else { const i = el('img'); i.src = t.file; i.loading = 'lazy'; i.alt = t.shot_title; th.append(i); }
  th.append(el('span', 'kind', isV ? 'CLIP' : 'STILL'));
  const star = el('button', 'star', t.fav ? '★' : '☆');
  star.title = t.fav ? 'remove from favourites' : 'keep this one';
  star.onclick = e => { e.stopPropagation(); toggleFav(t); };
  th.append(star);
  th.onclick = () => openLb(t);
  n.append(th);

  const meta = el('div', 'meta');
  const r1 = el('div', 'row');
  const tag = el('button', 'tk-tag', tagOf(t));
  tag.title = 'click: the file name, cheap to paste at an agent\nshift- or alt-click: the full path, which most terminals turn into the image itself';
  tag.onclick = e => copyTake(t, e);
  r1.append(tag, el('span', 'm', short(t.model) || '?'));
  if (t.cost_usd != null) r1.append(el('span', 'grow'), el('span', 'cost', money(t.cost_usd)));
  meta.append(r1);
  meta.append(el('div', 'sub', `${t.film_title} · ${t.shot_title}${t.style_name ? ' · ' + t.style_name : ''}`));
  if (t.picked) meta.append(el('div', 'sub', '★ picked for the cut'));
  n.append(meta);

  const acts = el('div', 'acts');
  const open = el('a', 'ghost tiny', 'canvas'); open.href = '/#' + t.film;
  open.title = 'open the film this came from';
  const name = el('button', 'ghost tiny', 'name'); name.onclick = () => copyText(fileOf(t), tagOf(t));
  const pth = el('button', 'ghost tiny', 'path'); pth.onclick = () => copyText(pathOf(t), tagOf(t) + ' path');
  acts.append(open, name, pth);
  n.append(acts);
  return n;
}

async function toggleFav(t) {
  try {
    const r = await api('POST', `/api/film/${t.film}/shot/${t.shot}/take/${t.id}/fav`, { fav: !t.fav });
    t.fav = r.fav; paint();
  } catch (e) { toast(e.message, true); }
}

function openLb(t) {
  G.lb = t;
  const isV = t.ext === '.mp4';
  $('#glbTitle').textContent = `${tagOf(t)} ${short(t.model)}${t.style_name ? ' · ' + t.style_name : ''}` +
    `${t.cost_usd != null ? ' · ' + money(t.cost_usd) : ''} — ${t.film_title} · ${t.shot_title}`;
  $('#glbImg').hidden = isV; $('#glbVid').hidden = !isV;
  if (isV) { $('#glbVid').src = t.file; $('#glbVid').play().catch(() => {}); } else $('#glbImg').src = t.file;
  $('#glbPrompt').textContent = t.prompt || '';
  $('#glbOpen').href = '/#' + t.film;
  $('#glb').classList.add('on');
}
function closeLb() { $('#glb').classList.remove('on'); $('#glbVid').pause(); G.lb = null; }

$('#glbClose').onclick = closeLb;
$('#glb').onclick = e => { if (e.target.id === 'glb') closeLb(); };
$('#glbName').onclick = () => G.lb && copyText(fileOf(G.lb), tagOf(G.lb));
$('#glbPath').onclick = () => G.lb && copyText(pathOf(G.lb), tagOf(G.lb) + ' path');
$('#gsearch').oninput = e => { G.q = e.target.value; paint(); };
$('#gfilm').onchange = e => { G.film = e.target.value; paint(); };
$('#gmodel').onchange = e => { G.model = e.target.value; paint(); };
$('#gkind').onchange = e => { G.kind = e.target.value; paint(); };
$('#gfav').onclick = () => { G.favOnly = !G.favOnly; $('#gfav').classList.toggle('on', G.favOnly); paint(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (G.lb) closeLb(); else if (document.activeElement === $('#gsearch')) $('#gsearch').blur(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === '/') { e.preventDefault(); $('#gsearch').focus(); }
  if (e.key === 'f' || e.key === 'F') $('#gfav').click();
});

(async function boot() {
  try {
    const d = await api('GET', '/api/gallery');
    G.takes = d.takes || []; G.root = d.root || '';
    const films = $('#gfilm');
    (d.films || []).forEach(f => { const o = el('option', null, `${f.title} (${f.shots})`); o.value = f.slug; films.append(o); });
    const models = [...new Set(G.takes.map(t => t.model).filter(Boolean))].sort();
    models.forEach(m => { const o = el('option', null, short(m)); o.value = m; $('#gmodel').append(o); });
    paint();
  } catch (e) {
    $('#grid').innerHTML = '';
    $('#gempty').hidden = false; $('#gempty').textContent = 'Could not read the gallery: ' + e.message;
  }
})();
