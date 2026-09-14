---
name: film-bench
description: Make a short AI film on a running film-bench through its MCP tools — lay out shots, write styles, attach reference images with tags, generate stills first and clips second, edit a take, pick takes and stitch the cut. Use when the user asks for a film, a shot, a clip, a storyboard, a look test across models, or to "work the bench". Not for generating media outside the bench: the bench is where the prompts, costs and files are kept.
argument-hint: <film or shot> [→ what to make or change]
---

# film-bench — work the film one shot at a time

The bench keeps the film on disk: shots in order, styles, reference images,
every take with the model, the full prompt and the cost that made it. Your job
is to move the film forward through the tools and leave a trail a person can
read on the canvas afterwards.

## Step 0 — state check

Call `bench_status` first. Three things come back that decide how you work:

- **Not reachable** → say so and stop. The bench runs with `python3 bench.py`;
  do not generate media any other way.
- **`armed: false`** → every `generate` is a **dry run**: exact request, price,
  nothing charged. Say this to the user once. Never ask them to arm the bench
  for you; arming is a decision a person makes in the browser.
- **`measured_costs`** → what each model has actually billed here. Quote these
  when you talk about money, not list prices from memory.

## Step 1 — read the film before touching it

`film_get` returns styles, references, and shots in order with prompts, models,
frames and takes. Read it. Do not add a shot that exists, do not rewrite a
style the user wrote, do not re-generate what a board already has unless asked.

## Step 2 — the loop, in this order

1. **Content and look are separate.** The shot prompt says what happens. A style
   says what it looks like (`style_set`). One beat rendered in two styles is two
   styles on one shot, not two shots.
2. **References with tags.** `ref_set` with a `tag` that says what to take from
   the image: "Take the texture of the hull from this image." Link it to the
   shots that need it. References go with stills only.
3. **Stills first.** `generate` with `kind: image`. Use `estimate: true` before a
   fan-out of more than two calls and report the price. Poll `job_get` until
   `done`, `estimated` or `error`.
4. **Ground the clip.** `frame_set` puts a still on a shot's FIRST (or LAST)
   frame. Only then `generate` with `kind: video`. A clip generated from text
   alone is how a subject stops being the same subject between shots.
5. **Fix, do not regenerate.** `edit` takes an existing still and an instruction
   ("change this and this, leave the rest"). It is cheaper and keeps what worked.
6. **Pick and stitch.** `take_pick` on the take that goes in the cut; `stitch`
   joins the picked clips in shot order.

## Step 3 — models

Never invent a model id. `models` lists the live catalogue with per-second
prices and which video models take a last frame. `price` gives the floor for an
exact call. Start cheap (the picks at the top of the catalogue) and go up only
when the cheap one is the problem.

## Step 4 — report

When you stop, say: which shots changed, which takes you made (model, style,
cost from `job_get`), which frames you set, and what is still open. File paths
in results are served by the bench under `/media/`, and the person sees every
take you made as a card on the canvas.

## Do not

- Do not ask to arm the bench, and do not treat a dry run as a failure.
- Do not delete takes or shots unless the user asked for that exact thing.
- Do not send a clip prompt that describes a look; the look is the style.
- Do not generate outside the bench. Its whole value is that every file can
  answer "what made you, from what prompt, for how much".
