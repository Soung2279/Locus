# Screenshot spatial snapshots

Screenshot messages include an image, capture ID and a small spatial summary.
The message also includes a minimal `get` / `pick` example. Camera and view facts
remain attached if object/depth capture fails; check `capture.spatial` before
querying those fields. Missing historical depth cannot be reconstructed by this SDK.
Use `locus.captures` only when more spatial information is useful. Queries read
the immutable screenshot snapshot, require its current session and checkout,
and never start Unity. Use the Python tool with `readonly=true`.

```python
capture = await locus.captures.get("capture-id-from-the-message")
hit = await capture.pick(uv=(0.5, 0.5), fields=["object", "world"])
print(hit)
```

`get` returns a small handle with `id` and `spatial`; it does not load large
arrays into the result. `uv` is normalized to the screenshot, top-left origin.
`pick` selects `object`, `world`, and/or `depth`. Background returns `hit=false`.
World positions and view depth use Unity units. Object `ref` values such as
`o2` are scoped to the capture, not Unity instance IDs.

```python
page = await capture.objects(rect=(0.2, 0.2, 0.8, 0.8),
                             fields=["ref", "name"], limit=8)
print(page)
```

`rect` is `(left, top, right, bottom)` in normalized screenshot coordinates.
The default region is the whole image. Fields: `ref`, `name`, `path`, `bounds`.
Objects are ordered by visible pixel coverage; results have `items` and
`next_offset`. Use `offset` explicitly to continue. Limit defaults to 8,
maximum 32. Filter and summarize in Python before printing; do not dump all
objects, matrices or per-pixel data into the conversation.

Spatial results describe editor picking geometry, not arbitrary transparency,
shader displacement or post-processing. `spatial=false` means only the image
is available. Never substitute current scene raycasts for a historical capture.
