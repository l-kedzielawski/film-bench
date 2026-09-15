#!/usr/bin/env python3
"""film-bench — a canvas for making short AI films, one shot at a time.

Shots are boards laid out in film order; takes are cards on the board. One
prompt bar at the bottom generates stills and clips through OpenRouter's media
API, fans out over several models and styles at once, and shows the live log of
every call on the board where its result is going to land.

Disk is the source of truth and this server is its only writer. Every take
keeps its own sidecar with the model, the full prompt, the parameters and the
cost, so any card on screen can answer "what made you, from what prompt, for
how much".

Spending
--------
The bench is DISARMED at startup. Disarmed, every Generate runs `gen --dry-run`:
you get the exact request body and the cost estimate, and nothing is charged.
Only ARM lets a call reach the API. The key itself is never read here — bin/gen
owns it, so nothing in this process or its logs can leak it.

Usage:  python3 bench.py [--port 8781] [--bind 127.0.0.1]
"""
import argparse, base64, json, mimetypes, os, queue, re, shutil, subprocess, sys, threading, time, uuid
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, 'web')
FILMS = os.path.join(HERE, 'films')
BIN = os.path.join(HERE, 'bin')


def _resolve_gen():
    """The generator this bench drives: bin/gen, or $FILMBENCH_GEN to point elsewhere."""
    return os.environ.get('FILMBENCH_GEN') or os.path.join(BIN, 'gen')


def _resolve_env():
    """The key file: $FILMBENCH_ENV, otherwise .env next to this file."""
    for cand in (os.environ.get('FILMBENCH_ENV'), os.path.join(HERE, '.env')):
        if cand and os.path.exists(cand):
            return cand
    return None


GEN = _resolve_gen()
KEY_FILE = _resolve_env()
LOG_FILE = os.environ.get('FILMBENCH_LOG') or os.path.join(HERE, 'genlog.jsonl')
PROJECT = HERE
# Every gen the bench spawns inherits these, so it resolves the same paths this
# process did instead of falling back to its own defaults.
GEN_ENV = {k: v for k, v in (('FILMBENCH_ENV', KEY_FILE), ('FILMBENCH_LOG', LOG_FILE)) if v}

mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('text/javascript', '.js')

SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,63}$')

# Models worth trying first (checked against the live catalogue, September
# 2026). Order is the order they appear in the picker; everything else follows.
PICKS_IMAGE = [
    'google/gemini-3.1-flash-image',      # cheap, fast, takes a reference image — the iteration workhorse
    'bytedance-seed/seedream-4.5',        # ~9s image-to-image — 5-0-pro cannot finish inside the 60s cut
    'openai/gpt-image-2.5-flare',         # speed tier of GPT Image 2.5; streams, so the cut cannot bite
    'openai/gpt-image-2.5-sunburst',      # precision tier of the same, same parameters and rates
    'google/gemini-3-pro-image',
    'black-forest-labs/flux.2-pro',
    'qwen/qwen-image-3-pro',
    'krea/krea-2-large',
    'microsoft/mai-image-2.6',
    'x-ai/grok-imagine-image-2.0',
    'recraft/recraft-v4.1-pro',
]
PICKS_VIDEO = [
    'google/veo-3.1-lite',                # $0.03/s at 720p without audio — the draft loop
    'minimax/hailuo-3-max',               # $0.05/s at 480p
    'minimax/hailuo-2.3',
    'minimax/hailuo-3',                   # 2K only; takes reference images
    'bytedance/seedance-2.0',
    'kwaivgi/kling-v3.0-std',
    'alibaba/wan-2.7',
    'runway/gen-4.5',
    'google/veo-3.1-fast',
    'google/veo-3.1',                     # $0.40/s — finals only
]
# A new shot starts cheap on purpose: one careless click should not fan out
# ten paid calls.
DEFAULT_IMAGE_MODELS = ['google/gemini-3.1-flash-image']
DEFAULT_VIDEO_MODELS = ['google/veo-3.1-lite']

# ---------------------------------------------------------------- state ----

ARMED = False           # nothing reaches the API until this is True
JOBS = {}               # id -> job dict
JOBS_LOCK = threading.Lock()
CLIENTS = set()         # SSE listener queues
CLIENTS_LOCK = threading.Lock()
SPEND = {'at': 0, 'data': None}
MODELS = {}             # kind -> (at, [rows])


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%S')


def publish(event, payload):
    """Push one event to every attached browser."""
    msg = json.dumps({'event': event, 'payload': payload}, ensure_ascii=False)
    with CLIENTS_LOCK:
        dead = []
        for q in CLIENTS:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            CLIENTS.discard(q)


def atomic_write(path, data, binary=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb' if binary else 'w', **({} if binary else {'encoding': 'utf-8'})) as f:
        f.write(data)
    os.replace(tmp, path)


# ---------------------------------------------------------------- films ----

def film_dir(slug):
    if not SLUG.match(slug or ''):
        raise ValueError('bad slug')
    return os.path.join(FILMS, slug)


def film_path(slug):
    return os.path.join(film_dir(slug), 'film.json')


def load_film(slug):
    with open(film_path(slug), encoding='utf-8') as f:
        film = json.load(f)
    film['slug'] = slug
    # A reference is the one file whose path stays the same while its bytes
    # change, so a browser goes on painting the old picture out of cache. Stamp
    # the version the canvas puts in the URL — derived from the file itself, so
    # it is never written to film.json, never a spurious diff, and still correct
    # if an image is swapped underneath the bench.
    for ref in film.get('refs', []):
        try:
            # milliseconds: whole seconds would collide on two replacements
            # inside the same second and the cache would bite again
            ref['v'] = int(os.path.getmtime(os.path.join(film_dir(slug), ref['file'])) * 1000)
        except (OSError, KeyError):
            ref.pop('v', None)
    for shot in film.get('shots', []):
        shot['takes'] = list_takes(slug, shot['id'])
    return film


def save_film(film):
    slug = film['slug']
    out = {k: v for k, v in film.items() if k != 'slug'}
    for shot in out.get('shots', []):
        shot.pop('takes', None)
    for ref in out.get('refs', []):
        ref.pop('v', None)          # derived from the file's mtime, never stored
    atomic_write(film_path(slug), json.dumps(out, ensure_ascii=False, indent=2) + '\n')


def list_films():
    if not os.path.isdir(FILMS):
        return []
    out = []
    for name in sorted(os.listdir(FILMS)):
        if os.path.isfile(os.path.join(FILMS, name, 'film.json')):
            try:
                with open(film_path(name), encoding='utf-8') as f:
                    meta = json.load(f)
                out.append({'slug': name, 'title': meta.get('title', name),
                            'lane': meta.get('lane', ''), 'shots': len(meta.get('shots', []))})
            except (OSError, ValueError):
                pass
    return out


def takes_dir(slug, shot_id):
    return os.path.join(film_dir(slug), 'takes', re.sub(r'[^a-z0-9-]', '', shot_id))


def list_takes(slug, shot_id):
    d = takes_dir(slug, shot_id)
    if not os.path.isdir(d):
        return []
    takes = []
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json'):
            continue
        try:
            with open(os.path.join(d, name), encoding='utf-8') as f:
                t = json.load(f)
        except (OSError, ValueError):
            continue
        t['id'] = name[:-5]
        base = os.path.join(d, t['id'])
        for ext in ('.mp4', '.png', '.jpg', '.webp'):
            if os.path.exists(base + ext):
                t['file'] = f'/media/{slug}/takes/{os.path.basename(d)}/{t["id"]}{ext}'
                t['ext'] = ext
                break
        if os.path.exists(base + '.poster.jpg'):
            t['poster'] = f'/media/{slug}/takes/{os.path.basename(d)}/{t["id"]}.poster.jpg'
        takes.append(t)
    takes.sort(key=lambda t: t.get('at', ''), reverse=True)
    return takes


def compose(style_prompt, content):
    """Fold a style prompt and a content prompt into the one string sent out.

    Keeping them apart is the point: content says what happens, style says what
    it looks like, so the same beat can be rendered in two lanes without
    retyping it — and a lane can be changed everywhere at once.

    A style may place the content explicitly with {content}; otherwise the
    style leads and the content follows, because most models weight what comes
    first.
    """
    style_prompt = (style_prompt or '').strip()
    content = (content or '').strip()
    if not style_prompt:
        return content
    if '{content}' in style_prompt:
        return style_prompt.replace('{content}', content).strip()
    return (style_prompt + '\n\n' + content).strip()


def compose_full(style_prompt, content, refs=None):
    out = compose(style_prompt, content)
    block = refs_block(refs)
    return (out + '\n\n' + block).strip() if block else out


def film_styles(film):
    return film.get('styles') or []


def film_refs(film):
    return film.get('refs') or []


def shot_refs(film, shot):
    """The reference images this shot sends, in order. Order matters: the
    numbered block in the prompt refers to them by position."""
    by = {r['id']: r for r in film_refs(film)}
    return [by[i] for i in (shot.get('refs') or []) if i in by]


def refs_block(refs):
    """The sentence that ties each attached image to what the model should
    take from it. Appended to the composed prompt for image calls only — no
    video model on this API accepts reference images."""
    if not refs:
        return ''
    lines = ['Reference images are attached, in this order:']
    for i, r in enumerate(refs, 1):
        lines.append('%d. %s' % (i, (r.get('tag') or '').strip() or 'Use this image as a reference.'))
    return '\n'.join(lines)


def ref_path(slug, ref):
    return os.path.join(film_dir(slug), ref['file'])


def shot_styles(film, shot):
    """The styles this shot renders in, as records. No style = content alone."""
    by_id = {s['id']: s for s in film_styles(film)}
    picked = [by_id[i] for i in (shot.get('styles') or []) if i in by_id]
    return picked or [{'id': '', 'name': 'no style', 'prompt': ''}]


def find_shot(film, shot_id):
    for s in film.get('shots', []):
        if s['id'] == shot_id:
            return s
    return None


# ------------------------------------------------------------ generating ----

def shot_models(shot, kind):
    """Every model this shot should be tried on, in order.

    A shot carries a list, not one model — comparing the same prompt across
    models is the normal case here, not a special one.
    """
    spec = shot.get('clip' if kind == 'video' else 'frame', {}) or {}
    out = [m.strip() for m in (spec.get('models') or []) if m and m.strip()]
    if not out and spec.get('model'):
        out = [spec['model'].strip()]
    seen, uniq = set(), []
    for m in out:
        if m not in seen:
            seen.add(m); uniq.append(m)
    return uniq


def build_cmd(film, shot, kind, out_path, dry, model, style=None, refs=None):
    """Translate a shot into an gen invocation for one model and one style."""
    spec = shot.get('clip' if kind == 'video' else 'frame', {}) or {}
    content = (spec.get('prompt') or '').strip()
    if not content:
        raise ValueError('the content prompt is empty')
    refs = refs if kind == 'image' else []
    prompt = compose_full((style or {}).get('prompt'), content, refs)
    model = (model or '').strip()
    if not model:
        raise ValueError('no model chosen')
    cmd = [sys.executable, GEN, kind, '--model', model, '--prompt', prompt, '--out', out_path]
    if kind == 'video':
        cmd += ['--duration', str(spec.get('duration') or 8)]
        if spec.get('resolution'):
            cmd += ['--resolution', str(spec['resolution'])]
        if spec.get('aspect'):
            cmd += ['--aspect', str(spec['aspect'])]
        if not spec.get('audio'):
            cmd += ['--no-audio']
        if spec.get('seed') not in (None, '', 0):
            cmd += ['--seed', str(spec['seed'])]
        for slot, flag in (('first_frame', '--first-frame'), ('last_frame', '--last-frame')):
            rel = shot.get(slot)
            if not rel:
                continue
            p = rel if os.path.isabs(rel) else os.path.join(film_dir(film['slug']), rel)
            if os.path.exists(p):
                cmd += [flag, p]
    else:
        n = int(spec.get('n') or 1)
        if n > 1:
            cmd += ['-n', str(n)]
        if spec.get('resolution'):
            cmd += ['--resolution', str(spec['resolution'])]
        if spec.get('aspect'):
            cmd += ['--aspect', str(spec['aspect'])]
        for r in refs or []:
            p = ref_path(film['slug'], r)
            if os.path.exists(p):
                cmd += ['--ref', p]
    if spec.get('extra'):
        cmd += ['--extra', spec['extra'] if isinstance(spec['extra'], str)
                else json.dumps(spec['extra'])]
    if dry:
        cmd += ['--dry-run']
    return cmd, prompt, model, spec


def run_job(job, cmd, out_path, sidecar, film_slug, shot_id):
    def emit(line):
        job['lines'].append(line)
        del job['lines'][:-400]
        publish('job.line', {'id': job['id'], 'line': line})

    emit('$ ' + ' '.join(x if ' ' not in x else repr(x) for x in cmd[1:]))
    try:
        p = subprocess.Popen(cmd, cwd=PROJECT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, bufsize=1,
                             env={**os.environ, 'PYTHONUNBUFFERED': '1', **GEN_ENV})
    except OSError as e:
        job['state'] = 'error'; job['error'] = str(e); emit('! ' + str(e))
        publish('job.end', job_public(job)); return

    stdout_lines = []

    def pump_out():
        for line in p.stdout:
            stdout_lines.append(line.rstrip('\n'))
            emit(line.rstrip('\n'))

    t = threading.Thread(target=pump_out, daemon=True)
    t.start()
    for line in p.stderr:
        emit(line.rstrip('\n'))
    p.wait()
    t.join(timeout=5)

    job['ended'] = now()
    if p.returncode != 0:
        job['state'] = 'error'
        job['error'] = 'gen exited %d' % p.returncode
    elif job['dry']:
        job['state'] = 'estimated'
        for line in job['lines']:
            if 'cost' in line:
                m = re.search(r'\$([\d.]+)', line)
                if m:
                    job['cost_est'] = float(m.group(1))
        seen = costs().get(job['model'])
        count = int(job.get('count') or 1)
        if job['cost_est'] is None and seen:
            # no list price for this model (all image models) — use what it billed before
            job['cost_est'] = round(seen['median'] * count, 5)
            emit('cost ≈ $%.4f%s  (measured: median of %d real call%s on this model, not a list price)'
                 % (job['cost_est'], ' for %d images' % count if count > 1 else '',
                    seen['n'], '' if seen['n'] == 1 else 's'))
        elif job['cost_est'] is None:
            emit('cost unknown — no list price and no previous real call on this model')
        elif seen and seen.get('ratio'):
            job['cost_expect'] = round(job['cost_est'] * seen['ratio'], 4)
            emit('expect ≈ $%.4f billed  (measured %.2f× the floor over %d call%s)'
                 % (job['cost_expect'], seen['ratio'], seen['ratio_n'], '' if seen['ratio_n'] == 1 else 's'))
    else:
        job['state'] = 'done'
        for line in job['lines']:
            if 'cost' in line:
                m = re.search(r'\$([\d.]+)', line)
                if m:
                    sidecar['cost_usd'] = float(m.group(1))
                    job['cost'] = float(m.group(1))
        produced = [x for x in stdout_lines if x.strip() and os.path.exists(x.strip())]
        real = produced[0].strip() if produced else (out_path if os.path.exists(out_path) else None)
        if real and os.path.abspath(real) != os.path.abspath(out_path):
            try:
                os.replace(real, out_path)
            except OSError:
                out_path = real
        if os.path.exists(out_path):
            sidecar['at'] = now()
            atomic_write(os.path.splitext(out_path)[0] + '.json',
                         json.dumps(sidecar, ensure_ascii=False, indent=2) + '\n')
            if out_path.endswith('.mp4'):
                make_poster(out_path)
            job['out'] = out_path
        else:
            job['state'] = 'error'
            job['error'] = 'gen reported success but no file landed'
        SPEND['at'] = 0     # force a refresh
        COSTS['at'] = 0
    publish('job.end', job_public(job))
    publish('film.changed', {'slug': film_slug, 'shot': shot_id})


def make_poster(mp4):
    try:
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', mp4,
                        '-frames:v', '1', '-q:v', '4', os.path.splitext(mp4)[0] + '.poster.jpg'],
                       timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        pass


def last_frame(mp4, out_png):
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-sseof', '-0.2', '-i', mp4,
                        '-update', '1', '-frames:v', '1', out_png], timeout=120, check=False)
    return r.returncode == 0 and os.path.exists(out_png)


def job_public(job):
    return {k: v for k, v in job.items() if k != 'lines'} | {'lines': job['lines'][-60:]}


def start_generate(slug, shot_id, kind, force_dry=False, models_wanted=None,
                   styles_wanted=None):
    """Fan one shot out across every requested model — one job each."""
    film = load_film(slug)
    shot = find_shot(film, shot_id)
    if not shot:
        raise ValueError('no such shot')
    wanted = [m.strip() for m in (models_wanted or shot_models(shot, kind)) if m and m.strip()]
    if not wanted:
        raise ValueError('no model chosen — pick at least one')
    styles = shot_styles(film, shot)
    if styles_wanted is not None:
        by_id = {s['id']: s for s in film_styles(film)}
        styles = [by_id[i] for i in styles_wanted if i in by_id] or \
                 [{'id': '', 'name': 'no style', 'prompt': ''}]
    return [start_one(film, shot, kind, force_dry, m, st)
            for st in styles for m in wanted]


def start_one(film, shot, kind, force_dry, model, style):
    slug, shot_id = film['slug'], shot['id']
    dry = force_dry or not ARMED
    d = takes_dir(slug, shot_id)
    os.makedirs(d, exist_ok=True)
    def tag(s):
        return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:24]
    bits = [time.strftime('%Y%m%d-%H%M%S')]
    if style and style.get('id'):
        bits.append(tag(style['id']))
    bits += [tag(model.split('/')[-1]), uuid.uuid4().hex[:3]]
    take_id = '-'.join(bits)
    ext = '.mp4' if kind == 'video' else '.png'
    out_path = os.path.join(d, take_id + ext)
    refs = shot_refs(film, shot) if kind == 'image' else []
    cmd, prompt, model, spec = build_cmd(film, shot, kind, out_path, dry, model, style, refs)
    sidecar = {'kind': kind, 'model': model, 'prompt': prompt,
               'refs': [{'id': r['id'], 'name': r.get('name'), 'tag': r.get('tag'), 'file': r['file']} for r in refs],
               'style_id': (style or {}).get('id') or None,
               'style_name': (style or {}).get('name') or None,
               'style_prompt': (style or {}).get('prompt') or None,
               'content_prompt': (spec.get('prompt') or '').strip(),
               'params': {k: v for k, v in spec.items() if k != 'prompt'},
               'first_frame': shot.get('first_frame'),
               'last_frame': shot.get('last_frame'), 'cost_usd': None,
               'film': slug, 'shot': shot_id, 'at': now()}
    job = {'id': uuid.uuid4().hex[:8], 'film': slug, 'shot': shot_id, 'shot_title': shot.get('title', ''),
           'style': (style or {}).get('name') or '',
           'kind': kind, 'model': model, 'dry': dry, 'state': 'running', 'started': now(),
           'ended': None, 'cost': None, 'cost_est': None, 'cost_expect': None, 'out': None, 'error': None,
           'count': int(spec.get('n') or 1) if kind == 'image' else 1,
           'take': take_id, 'lines': []}
    with JOBS_LOCK:
        JOBS[job['id']] = job
    publish('job.start', job_public(job))
    threading.Thread(target=run_job, args=(job, cmd, out_path, sidecar, slug, shot_id),
                     daemon=True).start()
    return job


COSTS = {'at': 0, 'data': None}


def costs():
    """What each model has actually billed, from the provenance log.

    The image catalogue carries no prices and an image dry run prints none, so
    the only honest estimate for a still is what the same model billed before.
    For video the log also carries gen's floor estimate next to the real
    charge, which gives a measured list-to-bill ratio per model instead of a
    number remembered from another project.
    """
    if time.time() - COSTS['at'] < 30 and COSTS['data'] is not None:
        return COSTS['data']
    per = {}
    log = LOG_FILE
    try:
        with open(log, encoding='utf-8') as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                m, c = r.get('model'), r.get('cost_usd')
                if not m or c is None:
                    continue
                d = per.setdefault(m, {'costs': [], 'ratios': []})
                d['costs'].append(float(c))
                e = r.get('estimated_usd')
                if e:
                    d['ratios'].append(float(c) / float(e))
    except OSError:
        pass
    out = {}
    for m, d in per.items():
        cs = sorted(d['costs']); rs = sorted(d['ratios'])
        med = lambda xs: xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2
        out[m] = {'n': len(cs), 'median': round(med(cs), 5), 'min': cs[0], 'max': cs[-1],
                  'ratio': round(med(rs), 3) if rs else None, 'ratio_n': len(rs)}
    COSTS['at'] = time.time(); COSTS['data'] = out
    return out


PRICES = {}             # (model, duration, resolution, audio) -> (at, floor_usd or None)


def price(model, duration, resolution, audio):
    """The floor gen itself would print for this exact call — same SKU choice
    (720p / audio), so the bar and the dry run agree."""
    key = (model, int(duration or 6), resolution or '', bool(audio))
    hit = PRICES.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    cmd = [sys.executable, GEN, 'price', model, '--duration', str(key[1])]
    if resolution:
        cmd += ['--resolution', resolution]
    if audio:
        cmd += ['--audio']
    floor = None
    try:
        r = subprocess.run(cmd, cwd=PROJECT, capture_output=True, text=True, timeout=60,
                           env={**os.environ, **GEN_ENV})
        m = re.search(r'->.*=\s*\$([\d.]+)', r.stdout)
        if m:
            floor = float(m.group(1))
    except (OSError, subprocess.SubprocessError):
        pass
    PRICES[key] = (time.time(), floor)
    return floor


def spend():
    if time.time() - SPEND['at'] < 20 and SPEND['data']:
        return SPEND['data']
    data = {}
    try:
        r = subprocess.run([sys.executable, GEN, 'spend'], cwd=PROJECT, capture_output=True,
                           text=True, timeout=30, env={**os.environ, **GEN_ENV})
        for line in r.stdout.splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2:
                data[parts[0]] = parts[1].strip()
    except (OSError, subprocess.SubprocessError) as e:
        data = {'error': str(e)}
    SPEND['at'] = time.time(); SPEND['data'] = data
    return data


def model_limits(kind):
    """What each model will actually accept — n range, resolutions, aspects, how
    many references. Published by the catalogue and otherwise thrown away, which
    is why an n of 2 on a model capped at 1 could only be discovered by paying
    for the 400."""
    try:
        r = subprocess.run([sys.executable, GEN, 'models', kind, '--json'], cwd=PROJECT,
                           capture_output=True, text=True, timeout=60,
                           env={**os.environ, **GEN_ENV})
        out = {}
        for m in json.loads(r.stdout or '[]'):
            sp = m.get('supported_parameters') or {}
            lim = {}
            for key in ('n', 'input_references'):
                rng = sp.get(key)
                if isinstance(rng, dict) and rng.get('type') == 'range':
                    lim[key] = [rng.get('min', 1), rng.get('max')]
            for key in ('resolution', 'aspect_ratio'):
                enum = sp.get(key)
                if isinstance(enum, dict) and enum.get('values'):
                    lim[key] = enum['values']
            if m.get('supports_streaming') is not None:
                lim['streaming'] = bool(m['supports_streaming'])
            if lim:
                out[m['id']] = lim
        return out
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def models(kind):
    hit = MODELS.get(kind)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    rows = []
    try:
        r = subprocess.run([sys.executable, GEN, 'models', kind], cwd=PROJECT,
                           capture_output=True, text=True, timeout=60,
                           env={**os.environ, **GEN_ENV})
        for line in r.stdout.splitlines():
            parts = line.split(None, 1)
            if parts and '/' in parts[0]:
                note = (parts[1] if len(parts) > 1 else '').strip()
                m = re.search(r'\$([\d.]+)/s', note)
                fm = re.search(r'frames=(\S+)', note)
                rows.append({'id': parts[0], 'note': note,
                             'price': float(m.group(1)) if m else None,
                             'frames': fm.group(1).split(',') if fm else []})
    except (OSError, subprocess.SubprocessError):
        pass
    limits = model_limits(kind)
    picks = PICKS_VIDEO if kind == 'video' else PICKS_IMAGE
    have = {r['id'] for r in rows}
    for r in rows:
        r['pick'] = r['id'] in picks
        r['limits'] = limits.get(r['id']) or {}
    # picked models first, in the order above; everything else alphabetical after
    rows.sort(key=lambda r: (picks.index(r['id']) if r['id'] in picks else 999, r['id']))
    for missing in [p for p in picks if p not in have]:
        rows.insert(0, {'id': missing, 'note': '(not in the live catalogue)', 'price': None,
                        'frames': [], 'pick': True, 'gone': True, 'limits': {}})
    MODELS[kind] = (time.time(), rows)
    return rows


# --------------------------------------------------------------- server ----

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'film-bench'

    def log_message(self, fmt, *args):
        msg = fmt % args
        if '/media/' not in msg and '/web/' not in msg:
            sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), msg))

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # -- helpers
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _html(self, text):
        data = text.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _read(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads((self.rfile.read(n) if n else b'').decode() or '{}')

    # -- GET
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == '/' or path == '/index.html':
                return self._file(os.path.join(WEB, 'index.html'))
            if path == '/agent':
                return self._html(agent_page())
            if path == '/skill.md':
                return self._file(os.path.join(HERE, 'skills', 'film-bench', 'SKILL.md'))
            if path.startswith('/web/'):
                return self._file(os.path.join(WEB, path[5:].lstrip('/')), root=WEB)
            if path.startswith('/media/'):
                return self._file(os.path.join(FILMS, path[7:].lstrip('/')), root=FILMS)
            if path == '/api/state':
                with JOBS_LOCK:
                    jobs = [job_public(j) for j in sorted(JOBS.values(),
                            key=lambda j: j['started'], reverse=True)[:25]]
                return self._json(200, {'films': list_films(), 'armed': ARMED,
                                        'spend': spend(), 'jobs': jobs})
            if path == '/api/price':
                qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                out = {}
                for m in qs.get('model', [])[:12]:
                    out[m] = price(m, (qs.get('duration') or ['6'])[0], (qs.get('resolution') or [''])[0],
                                   (qs.get('audio') or ['0'])[0] in ('1', 'true'))
                return self._json(200, {'floor': out})
            m = re.fullmatch(r'/api/job/([0-9a-f]+)', path)
            if m:
                with JOBS_LOCK:
                    j = JOBS.get(m.group(1))
                if not j:
                    return self._json(404, {'error': 'no such job (the bench keeps jobs in memory; a restart forgets them)'})
                return self._json(200, {k: v for k, v in j.items() if k != 'lines'} | {'lines': j['lines'][-120:]})
            if path == '/api/costs':
                return self._json(200, {'models': costs()})
            if path == '/api/spend':
                SPEND['at'] = 0
                return self._json(200, spend())
            m = re.fullmatch(r'/api/models/(image|video)', path)
            if m:
                return self._json(200, {'models': models(m.group(1))})
            m = re.fullmatch(r'/api/film/([a-z0-9-]+)', path)
            if m:
                return self._json(200, load_film(m.group(1)))
            if path == '/api/stream':
                return self._stream()
            return self._json(404, {'error': 'unknown endpoint'})
        except FileNotFoundError:
            return self._json(404, {'error': 'not found'})
        except ValueError as e:
            return self._json(400, {'error': str(e)})

    # -- POST
    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        global ARMED
        try:
            body = self._read()
            if path == '/api/arm':
                ARMED = bool(body.get('armed'))
                publish('armed', {'armed': ARMED})
                return self._json(200, {'armed': ARMED})

            if path == '/api/films':
                slug = (body.get('slug') or '').strip().lower()
                if not SLUG.match(slug):
                    return self._json(400, {'error': 'slug must be lowercase letters, digits, dashes'})
                if os.path.exists(film_path(slug)):
                    return self._json(409, {'error': 'that film already exists'})
                film = {'slug': slug, 'title': body.get('title') or slug,
                        'lane': body.get('lane') or '', 'note': '', 'shots': []}
                save_film(film)
                return self._json(200, film)

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)', path)
            if m:
                film = load_film(m.group(1))
                for k in ('title', 'note', 'lane'):
                    if k in body:
                        film[k] = body[k]
                save_film(film)
                return self._json(200, load_film(m.group(1)))

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/styles', path)
            if m:
                film = load_film(m.group(1))
                film.setdefault('styles', [])
                sid = re.sub(r'[^a-z0-9-]', '', (body.get('id') or '').lower())
                if not sid:
                    return self._json(400, {'error': 'a style needs an id'})
                existing = next((s for s in film['styles'] if s['id'] == sid), None)
                if body.get('delete'):
                    film['styles'] = [s for s in film['styles'] if s['id'] != sid]
                    for sh in film['shots']:
                        sh['styles'] = [x for x in (sh.get('styles') or []) if x != sid]
                elif existing:
                    existing.update({k: body[k] for k in ('name', 'prompt', 'note') if k in body})
                else:
                    film['styles'].append({'id': sid, 'name': body.get('name') or sid,
                                           'prompt': body.get('prompt') or '',
                                           'note': body.get('note') or ''})
                save_film(film)
                publish('film.changed', {'slug': film['slug']})
                return self._json(200, {'styles': film['styles']})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/refs', path)
            if m:
                return self._json(200, save_ref(m.group(1), body))

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)/edit', path)
            if m:
                jobs = start_edit(m.group(1), m.group(2), body)
                return self._json(200, {'jobs': [job_public(j) for j in jobs]})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shots', path)
            if m:
                film = load_film(m.group(1))
                sid = re.sub(r'[^a-z0-9-]', '', (body.get('id') or '').lower()) or \
                    '%02d-shot' % (len(film['shots']) + 1)
                if find_shot(film, sid):
                    sid = sid + '-' + uuid.uuid4().hex[:3]
                shot = {'id': sid, 'title': body.get('title') or sid, 'note': '',
                        'first_frame': None, 'last_frame': None, 'selected_take': None,
                        'styles': [s['id'] for s in film_styles(film)][:1],
                        'frame': {'prompt': '', 'models': list(DEFAULT_IMAGE_MODELS), 'n': 1},
                        'clip': {'prompt': '', 'models': list(DEFAULT_VIDEO_MODELS), 'duration': 6,
                                 'resolution': '720p', 'aspect': '16:9', 'audio': False, 'seed': None}}
                film['shots'].append(shot)
                save_film(film)
                publish('film.changed', {'slug': film['slug']})
                return self._json(200, shot)

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)', path)
            if m:
                film = load_film(m.group(1))
                shot = find_shot(film, m.group(2))
                if not shot:
                    return self._json(404, {'error': 'no such shot'})
                for k in ('title', 'note', 'first_frame', 'last_frame', 'selected_take',
                          'styles', 'refs'):
                    if k in body:
                        shot[k] = body[k]
                for section in ('frame', 'clip'):
                    if section in body and isinstance(body[section], dict):
                        sec = shot.setdefault(section, {})
                        sec.update(body[section])
                        # null is how the bar clears an optional parameter; keep
                        # it out of the file rather than storing "no value" twice
                        for key in ('resolution', 'aspect'):
                            if key in sec and sec[key] is None:
                                sec.pop(key)
                save_film(film)
                return self._json(200, shot)

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)/(generate|estimate)', path)
            if m:
                kind = body.get('kind') or 'video'
                if kind not in ('image', 'video'):
                    return self._json(400, {'error': 'kind must be image or video'})
                jobs = start_generate(m.group(1), m.group(2), kind,
                                      force_dry=(m.group(3) == 'estimate'),
                                      models_wanted=body.get('models'),
                                      styles_wanted=body.get('styles'))
                return self._json(200, {'jobs': [job_public(j) for j in jobs]})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)/select', path)
            if m:
                slug, sid = m.group(1), m.group(2)
                film = load_film(slug)
                shot = find_shot(film, sid)
                if not shot:
                    return self._json(404, {'error': 'no such shot'})
                shot['selected_take'] = body.get('take')
                save_film(film)
                out = {'shot': shot, 'chained': None}
                if body.get('chain') and shot['selected_take']:
                    out['chained'] = chain_forward(slug, sid, shot['selected_take'])
                publish('film.changed', {'slug': slug, 'shot': sid})
                return self._json(200, out)

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)/promote', path)
            if m:
                slug, sid = m.group(1), m.group(2)
                slot = 'last_frame' if body.get('slot') == 'last' else 'first_frame'
                film = load_film(slug); shot = find_shot(film, sid)
                srcf = find_take_file(slug, sid, body.get('take'))
                if not srcf:
                    return self._json(404, {'error': 'no such take'})
                # a frame may land on a different shot than the take it came from
                tgt_id = body.get('to') or sid
                shot = find_shot(film, tgt_id)
                if not shot:
                    return self._json(404, {'error': 'no such target shot'})
                if srcf.endswith('.mp4'):
                    rel = os.path.join('frames', '%s-%s.png' % (tgt_id, slot.split('_')[0]))
                    dst = os.path.join(film_dir(slug), rel)
                    if not grab_frame(srcf, float(body.get('time') or 0), dst):
                        return self._json(500, {'error': 'ffmpeg could not read that frame'})
                else:
                    rel = os.path.join('frames', '%s-%s%s' % (tgt_id, slot.split('_')[0],
                                                             os.path.splitext(srcf)[1]))
                    dst = os.path.join(film_dir(slug), rel)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copyfile(srcf, dst)
                shot[slot] = rel
                sid = tgt_id
                save_film(film)
                publish('film.changed', {'slug': slug, 'shot': sid})
                return self._json(200, {slot: rel})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/reorder', path)
            if m:
                # Board order on the canvas IS the film order. Unknown ids are
                # ignored and anything not named keeps its place at the end.
                film = load_film(m.group(1))
                by = {s['id']: s for s in film['shots']}
                order = [x for x in (body.get('order') or []) if x in by]
                rest = [s['id'] for s in film['shots'] if s['id'] not in order]
                film['shots'] = [by[i] for i in order + rest]
                save_film(film)
                publish('film.changed', {'slug': film['slug']})
                return self._json(200, {'order': [s['id'] for s in film['shots']]})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/stitch', path)
            if m:
                return self._json(200, stitch(m.group(1)))

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/layout', path)
            if m:
                # Where the nodes sit on the canvas. Purely presentation: film
                # order stays the order of film['shots'], which is what stitch
                # and the number badges use. No publish() — a drag must not
                # bounce a full reload back at the browser doing the dragging.
                film = load_film(m.group(1))
                if body.get('reset'):
                    for node in film['shots'] + film.get('refs', []):
                        node.pop('x', None)
                        node.pop('y', None)
                else:
                    for key, nodes in (('shots', film['shots']), ('refs', film.get('refs', []))):
                        want = body.get(key) or {}
                        for node in nodes:
                            xy = want.get(node['id'])
                            if xy:
                                node['x'], node['y'] = int(round(float(xy[0]))), int(round(float(xy[1])))
                save_film(film)
                return self._json(200, {'ok': True, 'free': any('x' in n for n in film['shots'])})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/delete', path)
            if m:
                slug = m.group(1)
                src = film_dir(slug)
                if not os.path.isdir(src):
                    return self._json(404, {'error': 'no such film'})
                # Not rm -rf: a film carries every take ever generated for it,
                # which is real money. Move it aside and say where it went.
                trash = os.path.join(FILMS, '_trash')
                os.makedirs(trash, exist_ok=True)
                dest = os.path.join(trash, '%s-%s' % (slug, time.strftime('%Y%m%d-%H%M%S')))
                os.rename(src, dest)
                publish('films.changed', {'slug': slug, 'deleted': True})
                return self._json(200, {'ok': True, 'trash': os.path.relpath(dest, HERE)})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)/delete', path)
            if m:
                film = load_film(m.group(1))
                film['shots'] = [s for s in film['shots'] if s['id'] != m.group(2)]
                save_film(film)
                publish('film.changed', {'slug': m.group(1)})
                return self._json(200, {'ok': True})

            m = re.fullmatch(r'/api/film/([a-z0-9-]+)/shot/([a-z0-9-]+)/take/([\w.-]+)/delete', path)
            if m:
                d = takes_dir(m.group(1), m.group(2))
                tid = os.path.basename(m.group(3))
                for name in os.listdir(d):
                    if name.startswith(tid + '.'):
                        os.remove(os.path.join(d, name))
                publish('film.changed', {'slug': m.group(1), 'shot': m.group(2)})
                return self._json(200, {'ok': True})

            return self._json(404, {'error': 'unknown endpoint'})
        except ValueError as e:
            return self._json(400, {'error': str(e)})
        except OSError as e:
            return self._json(500, {'error': str(e)})

    # -- SSE
    def _stream(self):
        q = queue.Queue(maxsize=500)
        with CLIENTS_LOCK:
            CLIENTS.add(q)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(('data: %s\n\n' % msg).encode())
                except queue.Empty:
                    self.wfile.write(b': ping\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ValueError):
            pass
        finally:
            with CLIENTS_LOCK:
                CLIENTS.discard(q)
            self.close_connection = True

    # -- static with Range (videos must seek)
    def _file(self, path, root=None):
        path = os.path.normpath(path)
        if root and not path.startswith(os.path.normpath(root) + os.sep):
            return self._json(403, {'error': 'outside root'})
        if not os.path.isfile(path):
            return self._json(404, {'error': 'not found'})
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        rng = self.headers.get('Range')
        if not rng:
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            with open(path, 'rb') as f:
                shutil.copyfileobj(f, self.wfile)
            return
        m = re.fullmatch(r'bytes=(\d*)-(\d*)', rng.strip())
        if not m or m.group(1) == m.group(2) == '':
            self.send_response(416); self.send_header('Content-Length', '0'); self.end_headers(); return
        a, b = m.groups()
        start = max(0, size - int(b)) if a == '' else int(a)
        end = size - 1 if (a == '' or not b) else min(size - 1, int(b))
        if start > end or start >= size:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.send_header('Content-Length', '0'); self.end_headers(); return
        self.send_response(206)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


def find_take_file(slug, shot_id, take_id):
    d = takes_dir(slug, shot_id)
    if not take_id:
        return None
    for ext in ('.mp4', '.png', '.jpg', '.webp'):
        p = os.path.join(d, os.path.basename(take_id) + ext)
        if os.path.exists(p):
            return p
    return None


def chain_forward(slug, shot_id, take_id):
    """Last frame of this take becomes the next shot's first frame.

    This is what keeps a chained film continuous — the next clip starts on the
    exact pixels the last one ended on, instead of on a fresh invention.
    """
    src = find_take_file(slug, shot_id, take_id)
    if not src or not src.endswith('.mp4'):
        return None
    film = load_film(slug)
    ids = [s['id'] for s in film['shots']]
    if shot_id not in ids or ids.index(shot_id) + 1 >= len(ids):
        return None
    nxt = ids[ids.index(shot_id) + 1]
    rel = os.path.join('frames', '%s-first.png' % nxt)
    dst = os.path.join(film_dir(slug), rel)
    if not last_frame(src, dst):
        return None
    shot = find_shot(film, nxt)
    shot['first_frame'] = rel
    save_film(film)
    return {'shot': nxt, 'first_frame': rel}


def grab_frame(mp4, seconds, out_png):
    """One frame out of a clip at a chosen moment."""
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y',
                        '-ss', '%.3f' % max(0.0, seconds), '-i', mp4,
                        '-update', '1', '-frames:v', '1', out_png],
                       timeout=120, check=False)
    return r.returncode == 0 and os.path.exists(out_png)


def mark_region(base_png, overlay_data_url, out_png):
    """Burn a painted region onto a copy of the image.

    No image model on this API takes a mask (checked September 2026), so a region
    is shown rather than uploaded: the model gets the clean original AND this
    marked copy, and the instruction tells it the marked area is the part to
    change. ffmpeg does the compositing so the bench keeps its zero
    dependencies.
    """
    head, _, b64 = overlay_data_url.partition(',')
    if 'base64' not in head or not b64:
        return False
    tmp = out_png + '.overlay.png'
    with open(tmp, 'wb') as f:
        f.write(base64.b64decode(b64))
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', base_png, '-i', tmp,
                        '-filter_complex', '[1:v]scale=rw:rh[o];[0:v][o]overlay=0:0',
                        '-frames:v', '1', out_png], timeout=120, check=False)
    try:
        os.remove(tmp)
    except OSError:
        pass
    return r.returncode == 0 and os.path.exists(out_png)


def start_edit(slug, shot_id, body):
    """Re-generate a still from an existing one plus an instruction.

    This is the edit path that actually exists on this API: input_references,
    not inpainting. The original goes in as a reference, optionally with a
    marked copy showing which part to change.
    """
    film = load_film(slug)
    shot = find_shot(film, shot_id)
    if not shot:
        raise ValueError('no such shot')
    srcf = find_take_file(slug, shot_id, body.get('take'))
    if not srcf:
        raise ValueError('no such take')
    if srcf.endswith('.mp4'):
        still = os.path.join(takes_dir(slug, shot_id), 'grab-%s.png' % uuid.uuid4().hex[:6])
        if not grab_frame(srcf, float(body.get('time') or 0), still):
            raise ValueError('could not read that frame out of the clip')
        srcf = still
    instruction = (body.get('instruction') or '').strip()
    if not instruction:
        raise ValueError('say what to change')
    wanted = [m for m in (body.get('models') or ['google/gemini-3.1-flash-image']) if m]
    dry = bool(body.get('estimate')) or not ARMED

    refs = [srcf]
    prompt = instruction
    if body.get('mask'):
        marked = os.path.join(takes_dir(slug, shot_id), 'mark-%s.png' % uuid.uuid4().hex[:6])
        if mark_region(srcf, body['mask'], marked):
            refs.append(marked)
            prompt = ('The first image is the original. The second is the same image with an '
                      'area painted over in bright magenta. Change only what lies under the '
                      'magenta and keep every other pixel as it is in the first image. '
                      'Do not draw magenta in the result.\n\n' + instruction)

    jobs = []
    for model in wanted:
        d = takes_dir(slug, shot_id)
        take_id = '%s-edit-%s' % (time.strftime('%Y%m%d-%H%M%S'), uuid.uuid4().hex[:3])
        out_path = os.path.join(d, take_id + '.png')
        cmd = [sys.executable, GEN, 'image', '--model', model,
               '--prompt', prompt, '--out', out_path]
        for r in refs:
            cmd += ['--ref', r]
        if dry:
            cmd += ['--dry-run']
        sidecar = {'kind': 'image', 'model': model, 'prompt': prompt,
                   'edit_of': body.get('take'), 'instruction': instruction,
                   'masked': len(refs) > 1, 'refs': [os.path.basename(r) for r in refs],
                   'style_id': None, 'style_name': 'edit', 'style_prompt': None,
                   'content_prompt': instruction, 'params': {}, 'cost_usd': None,
                   'first_frame': None, 'last_frame': None,
                   'film': slug, 'shot': shot_id, 'at': now()}
        job = {'id': uuid.uuid4().hex[:8], 'film': slug, 'shot': shot_id,
               'shot_title': shot.get('title', ''), 'style': 'edit', 'kind': 'image',
               'model': model, 'dry': dry, 'state': 'running', 'started': now(),
               'ended': None, 'cost': None, 'cost_est': None, 'out': None, 'error': None,
               'take': take_id, 'lines': []}
        with JOBS_LOCK:
            JOBS[job['id']] = job
        publish('job.start', job_public(job))
        threading.Thread(target=run_job, args=(job, cmd, out_path, sidecar, slug, shot_id),
                         daemon=True).start()
        jobs.append(job)
    return jobs


def decode_image(data):
    """A data URL in, (bytes, extension) out. Raises on anything that is not one."""
    m = re.match(r'data:(image/[a-z+]+);base64,(.+)$', data or '', re.S)
    if not m:
        raise ValueError('send an image as a data URL')
    ext = {'image/jpeg': '.jpg', 'image/png': '.png',
           'image/webp': '.webp', 'image/gif': '.gif'}.get(m.group(1), '.png')
    raw = base64.b64decode(m.group(2))
    if len(raw) > 25 * 1024 * 1024:
        raise ValueError('reference images are capped at 25 MB')
    return raw, ext


def save_ref(slug, body):
    """Create, retag or delete a reference image.

    body: {data: dataURL, name, tag}            upload
          {from_take: {shot, take}, name, tag}  a take becomes a reference
          {id, name?, tag?}                     rename or retag
          {id, data: dataURL}                   swap the picture, keep the node
          {id, delete: true}                    remove it and unlink every shot
    Files live in films/<slug>/refs/; the film lists them in order and shots
    hold a list of ids, so one image can feed several boards.
    """
    film = load_film(slug)
    film.setdefault('refs', [])
    rid = re.sub(r'[^a-z0-9-]', '', (body.get('id') or '').lower())
    if rid:
        ref = next((r for r in film['refs'] if r['id'] == rid), None)
        if not ref:
            raise ValueError('no such reference')
        if body.get('delete'):
            # a reference is a pointer, not work: the file goes with the node
            try:
                os.remove(ref_path(slug, ref))
            except OSError:
                pass
            film['refs'] = [r for r in film['refs'] if r['id'] != rid]
            for sh in film['shots']:
                if sh.get('refs'):
                    sh['refs'] = [x for x in sh['refs'] if x != rid]
        else:
            if body.get('data'):
                # Swap the picture under an existing node. Deleting and re-adding
                # would lose the tag and unlink it from every board that sends it;
                # the id is what those links point at, so the id has to survive.
                raw, ext = decode_image(body['data'])
                old = ref_path(slug, ref)
                rel = os.path.join('refs', rid + ext)
                atomic_write(os.path.join(film_dir(slug), rel), raw, binary=True)
                if os.path.abspath(old) != os.path.abspath(os.path.join(film_dir(slug), rel)):
                    try:
                        os.remove(old)
                    except OSError:
                        pass
                ref['file'] = rel
            for k in ('name', 'tag'):
                if k in body:
                    ref[k] = body[k]
        save_film(film)
        publish('film.changed', {'slug': slug})
        return {'refs': film['refs']}
    d = os.path.join(film_dir(slug), 'refs')
    os.makedirs(d, exist_ok=True)
    name = (body.get('name') or 'reference').strip()
    base = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:24] or 'ref'
    rid = '%s-%s' % (base, uuid.uuid4().hex[:4])
    ft = body.get('from_take')
    if ft:
        src = find_take_file(slug, ft.get('shot'), ft.get('take'))
        if not src:
            raise ValueError('no such take')
        if src.endswith('.mp4'):
            src_png = os.path.join(d, rid + '.png')
            if not grab_frame(src, float(ft.get('time') or 0), src_png):
                raise ValueError('could not read a frame out of that clip')
            rel = os.path.join('refs', rid + '.png')
        else:
            rel = os.path.join('refs', rid + os.path.splitext(src)[1])
            shutil.copyfile(src, os.path.join(film_dir(slug), rel))
    else:
        if not body.get('data'):
            raise ValueError('send an image as a data URL, or from_take')
        raw, ext = decode_image(body['data'])
        rel = os.path.join('refs', rid + ext)
        with open(os.path.join(film_dir(slug), rel), 'wb') as f:
            f.write(raw)
    ref = {'id': rid, 'name': name, 'tag': (body.get('tag') or '').strip(), 'file': rel}
    film['refs'].append(ref)
    for sid in body.get('link') or []:
        sh = find_shot(film, sid)
        if sh and rid not in (sh.get('refs') or []):
            sh['refs'] = (sh.get('refs') or []) + [rid]
    save_film(film)
    publish('film.changed', {'slug': slug})
    return {'ref': ref, 'refs': film['refs']}


def stitch(slug):
    """Concatenate the selected take of every shot, in order, into one film.

    Takes come back at different resolutions and codecs depending on which
    model made them, so this re-encodes to a common format rather than using
    the stream-copy concat demuxer, which would fail on a mixed set.
    """
    film = load_film(slug)
    parts, missing = [], []
    for s in film['shots']:
        f = find_take_file(slug, s['id'], s.get('selected_take'))
        if f and f.endswith('.mp4'):
            parts.append(f)
        else:
            missing.append(s['id'])
    if not parts:
        return {'error': 'no shot has a selected clip yet', 'missing': missing}
    out = os.path.join(film_dir(slug), 'cut.mp4')
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
    for p in parts:
        cmd += ['-i', p]
    n = len(parts)
    chains = ''.join(
        '[%d:v]scale=1280:720:force_original_aspect_ratio=decrease,'
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v%d];' % (i, i)
        for i in range(n))
    cmd += ['-filter_complex',
            chains + ''.join('[v%d]' % i for i in range(n)) + 'concat=n=%d:v=1:a=0[out]' % n,
            '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-g', '12', out]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0 or not os.path.exists(out):
        return {'error': (r.stderr or 'ffmpeg failed')[-400:]}
    res = {'file': '/media/%s/cut.mp4' % slug, 'shots': len(parts), 'missing': missing,
           'bytes': os.path.getsize(out), 'at': now()}
    publish('film.changed', {'slug': slug})
    return res


def agent_page():
    """One page that writes the agent setup out with the real paths filled in,
    so it is pasted, not typed. Same idea as the taste library's /me screen:
    the server hands out the skill, so no consuming repo carries a stale copy."""
    import html, importlib.util
    mcp_path = os.path.join(HERE, 'mcp.py')
    tools = []
    try:
        spec = importlib.util.spec_from_file_location('filmbench_mcp', mcp_path)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        tools = [(n, d) for n, d, _, _ in mod.TOOLS]
    except Exception as e:                                        # the page still renders
        tools = [('(could not load mcp.py)', str(e))]
    port = getattr(H, 'port', 8781)
    url = 'http://127.0.0.1:%d' % port
    e = html.escape
    add_cmd = 'claude mcp add film-bench -- python3 %s' % mcp_path
    if port != 8781:
        add_cmd = 'claude mcp add film-bench -e FILMBENCH_URL=%s -- python3 %s' % (url, mcp_path)
    json_snippet = json.dumps({'mcpServers': {'film-bench': {'command': 'python3', 'args': [mcp_path],
                               **({'env': {'FILMBENCH_URL': url}} if port != 8781 else {})}}}, indent=2)
    skill_cmd = 'mkdir -p .claude/skills/film-bench && curl -s %s/skill.md > .claude/skills/film-bench/SKILL.md' % url
    rows = ''.join('<tr><td><code>%s</code></td><td>%s</td></tr>' % (e(n), e(d)) for n, d in tools)
    return '''<!doctype html><meta charset="utf-8"><title>film-bench · agent</title>
<style>
:root{--bg:#0e0f11;--panel:#16181c;--panel2:#1c1f24;--line:#282c33;--ink:#e6e8ec;--dim:#8b929d;--faint:#5d646e;--acc:#5ad1a0;--blue:#7fb0e0;
 --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:36px 20px 80px}
h1{font:600 22px/1.2 var(--mono);margin:0 0 6px}h1 b{color:var(--acc)}
h2{font:600 11px/1 var(--mono);letter-spacing:.14em;color:var(--faint);margin:34px 0 10px}
p{color:var(--dim);margin:0 0 10px;max-width:70ch}
.block{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0}
pre{margin:0;font:12.5px/1.6 var(--mono);color:var(--ink);white-space:pre-wrap;word-break:break-all}
button{position:absolute;right:8px;top:8px;font:11px/1 var(--mono);color:var(--dim);background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:5px 8px;cursor:pointer}
button:hover{color:var(--ink)}button.ok{color:var(--acc);border-color:#2f5c45}
table{border-collapse:collapse;width:100%%;font-size:13px}td{padding:7px 8px;border-top:1px solid var(--line);vertical-align:top;color:var(--dim)}
td:first-child{white-space:nowrap;color:var(--blue);font:12px/1.5 var(--mono)}
a{color:var(--blue)}.note{border-left:2px solid #4a3b1e;padding-left:12px;color:#c9a267}
</style>
<main>
<h1>film<b>bench</b> · for agents</h1>
<p>Everything on this page is written out with the real paths of <em>this</em> bench, so it is pasted rather than typed. The bench at <code>%(url)s</code> stays the only writer; the agent talks to it through <code>mcp.py</code>.</p>

<h2>1 · CONNECT CLAUDE CODE</h2>
<div class="block"><pre id="c1">%(add)s</pre><button data-for="c1">copy</button></div>
<p>Any other MCP client takes the same server as JSON:</p>
<div class="block"><pre id="c2">%(json)s</pre><button data-for="c2">copy</button></div>

<h2>2 · GIVE THE AGENT THE SKILL</h2>
<p>The skill is how the agent works the bench well: stills first, styles separate from content, references with tags, frame before clip, estimate before a fan-out, no arming. Fetch it into the project you are working in; the server hands it out, so it never goes stale in a checkout.</p>
<div class="block"><pre id="c3">%(skill)s</pre><button data-for="c3">copy</button></div>
<p><a href="/skill.md">Read the skill</a> · it is <code>skills/film-bench/SKILL.md</code> in this folder.</p>

<h2>3 · WHAT THE AGENT CAN DO</h2>
<table>%(rows)s</table>

<h2>WHAT IT CANNOT DO</h2>
<p class="note">Arm the bench. While the bench is disarmed every <code>generate</code> an agent asks for is a dry run: exact request, price, nothing charged. You arm it in the browser when money should move, and <code>generate</code> tells the agent <code>dry_run: true</code> until then.</p>
</main>
<script>
document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById(b.dataset.for).textContent);b.textContent='copied';b.classList.add('ok');setTimeout(()=>{b.textContent='copy';b.classList.remove('ok')},1400)}catch{b.textContent='select + copy'}});
</script>''' % {'url': e(url), 'add': e(add_cmd), 'json': e(json_snippet), 'skill': e(skill_cmd), 'rows': rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8781)
    ap.add_argument('--bind', default='127.0.0.1')
    args = ap.parse_args()
    os.makedirs(FILMS, exist_ok=True)
    H.port = args.port
    srv = ThreadingHTTPServer((args.bind, args.port), H)
    srv.daemon_threads = True
    print('film-bench on http://%s:%d' % (args.bind, args.port))
    print('  films      %s' % FILMS)
    print('  generator  %s' % GEN)
    print('  key file   %s' % (KEY_FILE or 'NONE FOUND — copy .env.example to .env'))
    print('  genlog     %s' % LOG_FILE)
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            print('  WARNING: %s is not on PATH — frame grabbing and stitching need it' % tool)
    print('DISARMED — Generate runs --dry-run until you arm it in the header.', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
