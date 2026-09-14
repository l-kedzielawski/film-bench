#!/usr/bin/env python3
"""film-bench MCP server — lets an agent work the bench the way a person does.

Speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and forwards every call
to the running bench's HTTP API, so the bench stays the only writer and the
files on disk stay the source of truth. Nothing here touches the key.

The arm switch is deliberately NOT exposed. While the bench is disarmed every
generate an agent asks for runs as a dry run: exact request, cost estimate, no
charge. A person arms the bench in the browser when they want money spent.

Register with Claude Code:
    claude mcp add film-bench -- python3 /path/to/film-bench/mcp.py
Point it at another port with FILMBENCH_URL=http://127.0.0.1:8781.

Usage:  python3 mcp.py   (stdin/stdout are the transport)
"""
import base64, json, mimetypes, os, sys, urllib.error, urllib.request

BASE = os.environ.get('FILMBENCH_URL', 'http://127.0.0.1:8781').rstrip('/')
PROTOCOL = '2024-11-05'


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        try:
            detail = json.loads(detail).get('error', detail)
        except ValueError:
            pass
        raise RuntimeError('%s %s -> HTTP %d: %s' % (method, path, e.code, detail))
    except urllib.error.URLError as e:
        raise RuntimeError('the bench is not reachable at %s (%s). Start it with: python3 bench.py' % (BASE, e.reason))


def slim_film(f):
    """A film without the per-take prompt text, which is long and repeats."""
    out = dict(f)
    out['shots'] = []
    for s in f.get('shots', []):
        s2 = {k: v for k, v in s.items() if k != 'takes'}
        s2['takes'] = [{'id': t['id'], 'kind': t.get('kind'), 'model': t.get('model'), 'style': t.get('style_name'),
                        'cost_usd': t.get('cost_usd'), 'file': t.get('file'), 'at': t.get('at')} for t in s.get('takes', [])]
        out['shots'].append(s2)
    return out


# ------------------------------------------------------------------- tools

def t_bench_status(a):
    st = http('GET', '/api/state')
    return {'armed': st['armed'],
            'note': 'armed=false means every generate runs as a dry run and charges nothing; a person arms the bench in the browser',
            'spend': st.get('spend'), 'films': st['films'],
            'running': [j['id'] for j in st['jobs'] if j['state'] == 'running'],
            'measured_costs': http('GET', '/api/costs')['models']}

def t_films_list(a):
    return http('GET', '/api/state')['films']

def t_film_get(a):
    return slim_film(http('GET', '/api/film/%s' % a['slug']))

def t_film_create(a):
    return http('POST', '/api/films', {'slug': a['slug'], 'title': a.get('title') or a['slug']})

def t_shot_add(a):
    s = http('POST', '/api/film/%s/shots' % a['slug'], {'id': a.get('id') or '', 'title': a['title']})
    patch = {k: a[k] for k in ('note',) if k in a}
    if patch:
        s = http('POST', '/api/film/%s/shot/%s' % (a['slug'], s['id']), patch)
    return s

def t_shot_update(a):
    body = {}
    for k in ('title', 'note', 'styles', 'refs', 'selected_take'):
        if k in a:
            body[k] = a[k]
    frame = {k[6:]: a[k] for k in ('frame_prompt', 'frame_models', 'frame_n') if k in a}
    clip = {k[5:]: a[k] for k in ('clip_prompt', 'clip_models') if k in a}
    for k in ('duration', 'resolution', 'aspect', 'audio', 'seed'):
        if k in a:
            clip[k] = a[k]
    if frame:
        body['frame'] = frame
    if clip:
        body['clip'] = clip
    if a.get('clear_first_frame'):
        body['first_frame'] = None
    if a.get('clear_last_frame'):
        body['last_frame'] = None
    return http('POST', '/api/film/%s/shot/%s' % (a['slug'], a['shot']), body)

def t_shot_delete(a):
    return http('POST', '/api/film/%s/shot/%s/delete' % (a['slug'], a['shot']))

def t_shots_reorder(a):
    return http('POST', '/api/film/%s/reorder' % a['slug'], {'order': a['order']})

def t_style_set(a):
    body = {'id': a['id']}
    for k in ('name', 'prompt', 'note', 'delete'):
        if k in a:
            body[k] = a[k]
    return http('POST', '/api/film/%s/styles' % a['slug'], body)

def t_ref_set(a):
    body = {}
    if a.get('id'):
        body['id'] = a['id']
        for k in ('name', 'tag', 'delete'):
            if k in a:
                body[k] = a[k]
    elif a.get('path'):
        p = a['path']
        if not os.path.isfile(p):
            raise RuntimeError('no such file: %s' % p)
        mime = mimetypes.guess_type(p)[0] or 'image/png'
        with open(p, 'rb') as f:
            body['data'] = 'data:%s;base64,%s' % (mime, base64.b64encode(f.read()).decode())
    elif a.get('from_take'):
        body['from_take'] = a['from_take']
    else:
        raise RuntimeError('give id (to retag/delete), path (to upload) or from_take')
    for k in ('name', 'tag', 'link'):
        if k in a and k not in body:
            body[k] = a[k]
    return http('POST', '/api/film/%s/refs' % a['slug'], body)

def t_generate(a):
    kind = a.get('kind', 'image')
    how = 'estimate' if a.get('estimate') else 'generate'
    body = {'kind': kind}
    if a.get('models'):
        body['models'] = a['models']
    if 'styles' in a:
        body['styles'] = a['styles']
    r = http('POST', '/api/film/%s/shot/%s/%s' % (a['slug'], a['shot'], how), body)
    armed = http('GET', '/api/state')['armed']
    jobs = [{'id': j['id'], 'model': j['model'], 'style': j.get('style'), 'dry': j['dry'], 'take': j['take']} for j in r['jobs']]
    return {'jobs': jobs, 'dry_run': not armed or how == 'estimate',
            'note': 'poll job_get until state is done, estimated or error' + ('' if armed else '. The bench is DISARMED, so these are dry runs; a person arms it in the browser')}

def t_job_get(a):
    return http('GET', '/api/job/%s' % a['id'])

def t_take_pick(a):
    body = {'take': a.get('take')}
    if a.get('chain'):
        body['chain'] = True
    return http('POST', '/api/film/%s/shot/%s/select' % (a['slug'], a['shot']), body)

def t_frame_set(a):
    body = {'take': a['take'], 'slot': a.get('slot', 'first')}
    for k in ('time', 'to'):
        if k in a:
            body[k] = a[k]
    return http('POST', '/api/film/%s/shot/%s/promote' % (a['slug'], a['shot']), body)

def t_edit(a):
    body = {'take': a['take'], 'instruction': a['instruction']}
    for k in ('models', 'time', 'mask'):
        if k in a:
            body[k] = a[k]
    r = http('POST', '/api/film/%s/shot/%s/edit' % (a['slug'], a['shot']), body)
    return {'jobs': [{'id': j['id'], 'model': j['model'], 'dry': j['dry']} for j in r['jobs']]}

def t_stitch(a):
    return http('POST', '/api/film/%s/stitch' % a['slug'])

def t_models(a):
    rows = http('GET', '/api/models/%s' % a.get('kind', 'image'))['models']
    return [{'id': m['id'], 'price_per_s': m.get('price'), 'frames': m.get('frames'), 'pick': m.get('pick'), 'note': m.get('note')} for m in rows]

def t_price(a):
    q = '&'.join(['model=%s' % m for m in a['models']] + ['duration=%s' % a.get('duration', 6), 'resolution=%s' % a.get('resolution', '720p'), 'audio=%s' % ('1' if a.get('audio') else '0')])
    return http('GET', '/api/price?' + q)


S = lambda **p: {'type': 'object', 'properties': p, 'required': [k for k, v in p.items() if v.pop('_req', False)]}
R = lambda t, d: {'type': t, 'description': d, '_req': True}
O = lambda t, d: {'type': t, 'description': d}
ARR = lambda d, req=False: {'type': 'array', 'items': {'type': 'string'}, 'description': d, '_req': req}

TOOLS = [
    ('bench_status', 'Whether the bench is armed (armed=false: generates are free dry runs), key spend, films, running jobs, and what each model has actually billed.', S(), t_bench_status),
    ('films_list', 'List films.', S(), t_films_list),
    ('film_get', 'One film: styles, reference images, shots in order with prompts, models, frames, and each take (id, model, style, cost, file).', S(slug=R('string', 'film slug')), t_film_get),
    ('film_create', 'Create an empty film.', S(slug=R('string', 'lowercase letters, digits, dashes'), title=O('string', 'title')), t_film_create),
    ('shot_add', 'Add a shot (a board) at the end of the film.', S(slug=R('string', 'film'), title=R('string', 'what happens in this shot'), id=O('string', 'optional id'), note=O('string', 'why this beat is in the film')), t_shot_add),
    ('shot_update', 'Change a shot: prompts, models, styles, references, clip params, title, note. frame_* is the still, clip_* is the video.',
     S(slug=R('string', 'film'), shot=R('string', 'shot id'), title=O('string', ''), note=O('string', ''),
       frame_prompt=O('string', 'what is IN the still — not how it looks, that is the style'), clip_prompt=O('string', 'what HAPPENS in the clip'),
       frame_models=ARR('image model ids'), clip_models=ARR('video model ids'), frame_n=O('integer', 'stills per call, 1-4'),
       duration=O('integer', 'seconds'), resolution=O('string', '720p | 1080p | 2k'), aspect=O('string', '16:9 | 9:16 | 1:1'), audio=O('boolean', ''), seed=O('integer', ''),
       styles=ARR('style ids this shot renders in; every generate runs once per style per model'), refs=ARR('reference ids this shot sends with stills, in order'),
       selected_take=O('string', 'take id picked for the cut'), clear_first_frame=O('boolean', ''), clear_last_frame=O('boolean', '')), t_shot_update),
    ('shot_delete', 'Delete a shot. Its takes stay on disk.', S(slug=R('string', ''), shot=R('string', '')), t_shot_delete),
    ('shots_reorder', 'Set the film order. Shots not named keep their place at the end.', S(slug=R('string', ''), order=ARR('shot ids in order', True)), t_shots_reorder),
    ('style_set', 'Create, edit or delete a style (a look: medium, rendering, lighting, lens, finish). Use {content} in the prompt to place the shot content explicitly.',
     S(slug=R('string', ''), id=R('string', 'style id'), name=O('string', ''), prompt=O('string', ''), note=O('string', ''), delete=O('boolean', '')), t_style_set),
    ('ref_set', 'Add a reference image (from a local file path, or from an existing take), retag it, or delete it. The tag is the sentence that tells the model what to take from it; it goes into the prompt, numbered, with stills only.',
     S(slug=R('string', ''), id=O('string', 'existing reference id, to retag or delete'), path=O('string', 'local image file to upload'),
       from_take=O('object', '{shot, take, time?} — a take becomes a reference'), name=O('string', ''), tag=O('string', 'e.g. "Take the texture of the hull from this image."'),
       link=ARR('shot ids to link it to'), delete=O('boolean', '')), t_ref_set),
    ('generate', 'Generate stills (kind=image) or clips (kind=video) for a shot, fanned out over its styles and models. estimate=true forces a free dry run. While the bench is disarmed every call is a dry run anyway.',
     S(slug=R('string', ''), shot=R('string', ''), kind=O('string', 'image | video (default image)'), models=ARR('override the shot\'s model list'), styles=ARR('override the shot\'s styles'), estimate=O('boolean', 'free: exact request + price, nothing charged')), t_generate),
    ('job_get', 'State, log lines, cost estimate and real cost of one job.', S(id=R('string', 'job id from generate/edit')), t_job_get),
    ('take_pick', 'Pick a take for the cut (take=null to unpick). chain=true also pushes a clip\'s last frame into the next shot as its first frame.', S(slug=R('string', ''), shot=R('string', ''), take=O('string', 'take id or null'), chain=O('boolean', '')), t_take_pick),
    ('frame_set', 'Use a take as a shot\'s first or last frame. For a clip, time picks the frame. to= lets the frame land on another shot (a shared middle still).',
     S(slug=R('string', ''), shot=R('string', 'shot the take belongs to'), take=R('string', ''), slot=O('string', 'first | last'), time=O('number', 'seconds into a clip'), to=O('string', 'target shot id')), t_frame_set),
    ('edit', 'Re-generate a still from an existing take plus an instruction: "change this, leave the rest". Whole image unless mask (a PNG data URL with the region painted) is given.',
     S(slug=R('string', ''), shot=R('string', ''), take=R('string', ''), instruction=R('string', 'what to change'), models=ARR('image models, default gemini-3.1-flash-image'), mask=O('string', 'data:image/png;base64,... marking the region'), time=O('number', 'for a clip: which frame to edit')), t_edit),
    ('stitch', 'Join the picked clip of every shot, in order, into films/<slug>/cut.mp4.', S(slug=R('string', '')), t_stitch),
    ('models', 'The live model catalogue with per-second prices and which frame slots each video model accepts.', S(kind=O('string', 'image | video')), t_models),
    ('price', 'The floor a video call would cost for these models at this duration, resolution and audio setting.', S(models=ARR('video model ids', True), duration=O('integer', ''), resolution=O('string', ''), audio=O('boolean', '')), t_price),
]
BY_NAME = {name: fn for name, _, _, fn in TOOLS}


def tool_list():
    return [{'name': n, 'description': d, 'inputSchema': schema} for n, d, schema, _ in TOOLS]


# --------------------------------------------------------------- transport

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def handle(msg):
    mid, method, params = msg.get('id'), msg.get('method'), msg.get('params') or {}
    if method == 'initialize':
        return {'protocolVersion': PROTOCOL, 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'film-bench', 'version': '1.0'},
                'instructions': 'Work the film one shot at a time. Stills first (kind=image), then set a first frame with frame_set and generate the clip. '
                                'Every generate is a dry run until a person arms the bench in the browser; use estimate=true to price a fan-out for free. '
                                'Poll job_get for results; file paths in results are served by the bench under /media/.'}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': tool_list()}
    if method == 'tools/call':
        name, args = params.get('name'), params.get('arguments') or {}
        fn = BY_NAME.get(name)
        if not fn:
            return {'content': [{'type': 'text', 'text': 'unknown tool %r' % name}], 'isError': True}
        try:
            out = fn(args)
            return {'content': [{'type': 'text', 'text': json.dumps(out, ensure_ascii=False, indent=1)}]}
        except (RuntimeError, KeyError, ValueError, TypeError) as e:
            return {'content': [{'type': 'text', 'text': '%s: %s' % (type(e).__name__, e)}], 'isError': True}
    if method and method.startswith('notifications/'):
        return None
    raise LookupError(method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if 'id' not in msg and msg.get('method', '').startswith('notifications/'):
            continue
        try:
            result = handle(msg)
        except LookupError as e:
            send({'jsonrpc': '2.0', 'id': msg.get('id'), 'error': {'code': -32601, 'message': 'method not found: %s' % e}})
            continue
        if result is None:
            continue
        send({'jsonrpc': '2.0', 'id': msg.get('id'), 'result': result})


if __name__ == '__main__':
    main()
