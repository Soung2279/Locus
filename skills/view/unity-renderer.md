# Unity GPU output

`locus.unity.renderer` and `UnityRenderSurface` display a caller-rendered Unity texture inside a Locus desktop View. The SDK owns shared textures, synchronization, native windows, input, layout and cleanup. Your C# owns scenes, cameras, animation, rendering and the original texture. This path requires Windows x64, a connected D3D11 Unity Editor and the updated bundled native plugin. Restart Unity after upgrading an already loaded DLL. Unity-hosted HTTP Views are not supported by this backend.

## Connect

```vue
<script setup lang="ts">
import { shallowRef, onMounted } from "vue";
import { locus } from "@locus/frontend";
import { view } from "@locus/view-runtime";
import { UnityRenderSurface } from "@locus/components";
const output = shallowRef(null);
onMounted(async () => {
  const capability = await locus.unity.renderer.capabilities();
  if (!capability.supported) throw new Error(capability.reason);
  output.value = await locus.unity.renderer.createOutput();
  await view.callScript("preview", "Open", { outputId: output.value.id });
});
</script>
<template><UnityRenderSurface :source="output" /></template>
```

The manifest must declare your `preview` C# script as usual. Resolve its output with `Locus.Rendering.RenderOutput.Get(outputId)`. Read `RequestedSize` and `IsVisible` when attaching, then subscribe to `SizeRequested`, `VisibilityChanged`, `Input`, `FrameRequested` and `Closed`. The initial mount can precede your C# initialization; events describe subsequent changes. Give the component a parent with an explicit height.

```csharp
output.Input += HandleBusinessInput;
output.SizeRequested += ResizeMyRenderTarget;
output.FrameRequested += RenderMyFrame;
output.Closed += ReleaseMySceneAndTextures;

void RenderMyFrame()
{
    // Your project-specific pipeline/render entry point.
    RenderUsingMyPipeline(target);
    output.Publish(target);
}
```

`Publish` does not render a camera or change the project's pipeline. In a custom SRP callback, use `output.Publish(target, context)` to append the copy to that `ScriptableRenderContext`; the pipeline remains responsible for submitting it. The ordinary overload schedules the copy after graphics commands already submitted. Do not publish before the commands that draw the source, or publish from a background thread.

The [complete example](../../examples/unity-renderer/Renderer.vue) uses the existing View C# compiler. Its [C# implementation](../../examples/unity-renderer/unity/RendererExample.cs) owns an isolated preview scene, orbit/zoom and procedural animation with play/pause/seek. Its Built-in rendering path has been integration-tested. The optional SRP `StandardRequest` branch is example code and requires a compatible project pipeline/material; the SDK itself has no URP/HDRP dependency. Adapt that business rendering method for your scene/camera. Do not duplicate native sharing logic in the View.

## Contract

- Textures: created 2D RGBA8/BGRA8, single sample, one mip, maximum 4096 per dimension. Resolve MSAA, tonemap HDR and choose display color encoding in your View before publishing. The surface stretches the source over its rectangle and displays it opaquely; source alpha is not blended with DOM.
- `Publish` returns `false` while hidden, detached, backpressured or concurrently closing. Source changes start a new texture generation. The SDK retains the native resource for queued copies but never releases/destroys your managed `RenderTexture`. If you `Release()`/`Create()` the same object, call `InvalidateSource()` before publishing again.
- Input and lifecycle callbacks run on the Unity main thread. Positions/deltas use top-left origin; `Position` is normalized, `SurfacePosition` is physical surface pixels and `TexturePosition` is source pixels. Captured positions may leave the rectangle. Wheel deltas are detents; buttons use left=1/right=2/middle=4, modifiers shift=1/control=2/alt=4, key events carry Windows virtual key codes. This is a key channel, not text/IME input.
- Consecutive moves coalesce; button/key edges remain ordered. Overflow yields `Cancel`; clear your drag state on cancel. The native surface captures drag and cancels on focus loss, hiding or destruction. `FrameRequested` is a notification, not an instruction to change camera or animate.
- `output.mount(element)` is the non-Vue API; it returns `dispose`, `setVisible` and `refreshLayout`. Mount only into the creating desktop window. One surface per output; at most 16 outputs in a Unity process/window. Use multiple outputs for multiple panes.
- Layout tracks DPI, viewport/ancestor clipping and common DOM menus/dialogs. Mark custom overlays with `data-native-surface-occluder`. HWND regions cut rectangular holes: translucent DOM compositing over the live texture, rounded CSS masks, rotated/skewed/3D transforms and browser screenshots of the native pixels are not supported. Do not promise arbitrary CSS composition.
- `status()`/`subscribe()` expose readiness, dimensions, generation, frame/input counts, failure and `inputToPresentP95Ms`. The latter measures native WM dispatch to the first Present call containing processed input, excluding mouse hardware, GPU completion after Present and display scanout. It is not photon latency.
- The component releases its mount; the View execution scope closes all its outputs on disposal/reload. Explicit `output.dispose()` closes earlier. The host also expires orphaned outputs after a 15-second lease. Callers using `createFrontendSdk` outside a View must pass an AbortSignal or dispose the renderer themselves.
- Unity reload, Play Mode transition (also with domain reload disabled), device loss or Unity exit invalidates outputs. `Closed` releases your business resources. Create a new output and reinitialize business state; old domain references are not automatically replayed. Reattaching a valid output is supported after awaiting surface disposal.

For native diagnostics run `bun run locus:test:renderer`. It creates its own project under `LOCUS_TEST_ROOT` (default: `LocusTemp` in the system temp folder; pass `--unity <Unity.exe>` or set `LOCUS_TEST_UNITY_EDITOR`), performs real mouse dragging and covers two outputs, source resize, hiding/showing and closure. It temporarily takes foreground focus for the input test and aborts if another window takes it during dragging.
