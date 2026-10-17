// Compiled into an isolated test assembly with the bridge; never shipped in the Unity package.
using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Unity.Profiling;
using UnityEditor;
using UnityEditor.Profiling;
using UnityEditorInternal;
using UnityEngine;

namespace Locus
{
    public static partial class LocusBridge
    {
        private static int _profilerChecks;
        private static void ProfileCheck(bool condition, string message)
        {
            if (!condition) throw new Exception("Profiler check failed: " + message);
            _profilerChecks++;
        }

        public static async void RunProfilerApiChecks()
        {
            try
            {
                var s = ProfilerStatistics.Calculate(new[] { 1.0, double.NaN, 2, 3, 4, double.PositiveInfinity });
                ProfileCheck(s.SampleCount == 4 && s.MissingCount == 2 && s.Average == 2.5 && s.P95 == 4 && s.Median == 2, "finite statistics and nearest rank");
                ProfileCheck(s.Delta == 3 && Math.Abs(s.StandardDeviation.Value - Math.Sqrt(1.25)) < 1e-9, "delta and population deviation");
                var empty = ProfilerStatistics.Calculate(new[] { double.NaN });
                ProfileCheck(empty.Average == null && empty.P99 == null && empty.SampleCount == 0, "empty is not zero");

                int tick = 0, reads = 0;
                using (var api = new ProfilerApi(() => tick, _ => {}, "test", false))
                {
                    var options = new ProfilerCaptureOptions { Clock = "editor_update", WarmupFrames = 1, SampleEveryFrames = 2, MaxSamples = 3 };
                    var metrics = new[] { api.ProfilerMetric("sparse", () => ++reads == 2 ? (double?)null : reads * 10, "count"),
                        api.ProfilerMetric("tiny", () => 0.000000123456789, "units") };
                    api.StartProfiler("baseline", metrics, options);
                    options.MaxSamples = 1; // The running capture owns a validated snapshot of its options.
                    for (tick = 1; tick <= 6; tick++) api.SampleProfilers();
                    ProfileCheck(api.IsProfilerStopped("baseline"), "bounded recording stops");
                    var points = api.GetProfilerSamples("baseline", "sparse");
                    ProfileCheck(points.Length == 3 && points[0].SessionFrame == 2 && points[1].SessionFrame == 4 && points[2].SessionFrame == 6, "warmup and interval");
                    ProfileCheck(points[1].Value == null && points[2].Value == 30, "missing values retain row alignment");
                    var summary = api.GetProfilerSummary("baseline", "sparse");
                    ProfileCheck(summary.SampleCount == 2 && summary.Average == 20 && summary.Statistics.MissingCount == 1, "missing values excluded from statistics");
                    var budget = api.GetProfilerBudget("baseline", "sparse", 20);
                    ProfileCheck(budget.SampleCount == 2 && budget.ExceededCount == 1 && budget.ExceededPercent == 50, "budget denominator excludes missing");
                    api.StartProfiler("candidate", new[] { api.ProfilerMetric("sparse", () => 40, "count") }, new ProfilerCaptureOptions { Clock = "editor_update", SampleEveryFrames = 2, MaxSamples = 1 });
                    tick++; api.SampleProfilers();
                    var comparison = api.CompareProfilers("baseline", "candidate", "sparse");
                    ProfileCheck(comparison.Error == "" && comparison.AverageDelta == 20 && comparison.AveragePercent == 100, "baseline comparison");
                    tick += 100;
                    ProfileCheck(api.RecordProfilerSpikeTop("baseline", "sparse", 20, "spike", 2), "spike recorded");
                    ProfileCheck(api.GetProfilerSpikes("baseline")[0].SessionFrame == 6, "spike uses observation frame, not call frame");
                    ProfileCheck(!api.RecordProfilerSpikeTop("baseline", "sparse", 20, "spike", 2), "same observation not duplicated");
                    string csv = api.SaveProfiler("baseline");
                    var rows = File.ReadAllLines(csv);
                    ProfileCheck(rows.Length == 4 && rows[2].Split(',')[5] == "" && double.Parse(rows[3].Split(',')[6], System.Globalization.CultureInfo.InvariantCulture) == 0.000000123456789, "CSV gaps and precision");
                    var catalog = api.DiscoverMetrics(limit: 2);
                    ProfileCheck(catalog.TotalMatches > 2 && catalog.Items.Length == 2 && catalog.HasMore, "metric discovery pagination");
                    ProfileCheck(api.DiscoverMetrics(limit: 2, offset: 2).Items[0].Name != catalog.Items[0].Name, "discovery deterministic offset");
                    ProfileCheck(api.ProfilerMetrics("overview", "memory").Length > 10, "domain composition");
                    var frame = api.GetProfilerFrame(int.MaxValue);
                    ProfileCheck(frame.Error != "" && frame.Rows.Count == 0, "expired frame is explicit");
                    ProfileCheck(api.GetFrameTimings().Frames != null, "frame timing availability result");
                    try { api.StartProfiler("duplicate", new[] { metrics[0], metrics[0] }); throw new Exception("Expected duplicate rejection"); }
                    catch (ArgumentException) { _profilerChecks++; }
                    api.StartProfiler("zero", new[] { api.ProfilerMetric("z", () => 0, "count") }, new ProfilerCaptureOptions { Clock = "editor_update", MaxSamples = 1 });
                    api.StartProfiler("one", new[] { api.ProfilerMetric("z", () => 1, "count") }, new ProfilerCaptureOptions { Clock = "editor_update", MaxSamples = 1 });
                    tick++; api.SampleProfilers();
                    var zeroComparison = api.CompareProfilers("zero", "one", "z");
                    ProfileCheck(zeroComparison.AverageDelta == 1 && zeroComparison.AveragePercent == null, "zero baseline has no percentage");
                    var canceled = new CancellationToken(true);
                    try { await api.SaveMemorySnapshotAsync("canceled", canceled); throw new Exception("Expected cancellation"); }
                    catch (OperationCanceledException) { _profilerChecks++; }
                }

                ProfilerDriver.enabled = false;
                using (var a = new ProfilerApi(() => tick, _ => {}, "test", false))
                using (var b = new ProfilerApi(() => tick, _ => {}, "test", false))
                {
                    var options = new ProfilerCaptureOptions { CaptureHierarchy = true };
                    a.StartProfiler("a", new[] { a.ProfilerMetric("x", () => 1, "count") }, options);
                    b.StartProfiler("b", new[] { b.ProfilerMetric("x", () => 1, "count") }, options);
                    a.StopProfiler("a"); ProfileCheck(ProfilerDriver.enabled, "overlapping recording lease");
                    b.StopProfiler("b"); ProfileCheck(!ProfilerDriver.enabled, "recording state restored");
                }
                ProfilerDriver.enabled = true;
                using (var api = new ProfilerApi(() => tick, _ => {}, "test", false))
                    api.StartProfiler("existing", new[] { api.ProfilerMetric("x", () => 1, "count") }, new ProfilerCaptureOptions { CaptureHierarchy = true });
                ProfileCheck(ProfilerDriver.enabled, "pre-existing user recording preserved");
                ProfilerDriver.enabled = false;

                CheckProfilerSamplingAllocations();
                await CheckProfilerWorkers();

                await CheckExecuteProfiler(false, false);
                await CheckExecuteProfiler(true, false);
                await CheckExecuteProfiler(false, true);
                await CheckStateProfiler();

                EditorSettings.enterPlayModeOptionsEnabled = true;
                EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
                EditorApplication.isPlaying = true;
                await ProfileWaitTicks(12);
                ProfileCheck(EditorApplication.isPlaying, "entered isolated Play Mode");
                await CheckExecuteProfiler(false, false);
                EditorApplication.isPlaying = false;
                await ProfileWaitTicks(8);

                Debug.Log("LOCUS_PROFILER_TEST_JSON {\"ok\":true,\"checks\":" + _profilerChecks + ",\"unity\":\"" + Application.unityVersion + "\"}");
                EditorApplication.Exit(0);
            }
            catch (Exception ex)
            {
                Debug.LogError("LOCUS_PROFILER_TEST_JSON {\"ok\":false,\"checks\":" + _profilerChecks + "}\n" + ex);
                EditorApplication.Exit(1);
            }
        }

        private static async Task CheckExecuteProfiler(bool fail, bool cancel)
        {
            var execution = new AsyncSnippetExecution();
            var snippet = new CompiledAsyncSnippet(async (globals, ctx, token) =>
            {
                var p = ctx.Profiler;
                SetProfilerCheckDoubleCounter();
                var metrics = p.ProfilerMetrics("cpu", "memory", "gpu").Concat(new[] {
                    p.ProfilerMetric("double", ProfilerCategory.Scripts, "Locus.Check.Double", 1, "count")
                });
                p.StartProfiler("native", metrics,
                    new ProfilerCaptureOptions { MaxSamples = 12, CaptureHierarchy = true, CaptureGpu = true });
                if (cancel) execution.Cancel();
                await ctx.WaitFrames(40);
                if (fail) throw new InvalidOperationException("intentional profiler test failure");
                var samples = p.GetProfilerSamples("native", "main_thread_ms");
                ProfileCheck(samples.Length == 12, "native execute capture bounded: " + samples.Length);
                if (EditorApplication.isPlaying)
                    ProfileCheck(samples.Select(x => x.UnityTimeFrameCount).Distinct().Count() == samples.Length, "Play Mode uses distinct Unity frames");
                ProfileCheck(p.GetProfilerSummary("native", "Memory/Total Used Memory").SampleCount >= 3, "native memory recorder continues across frames");
                var gpu = p.GetProfilerSummary("native", "gpu_frame_ms");
                ProfileCheck(!gpu.Available || gpu.Average > 0, "unavailable GPU timings are not zero");
                var doubleSummary = p.GetProfilerSummary("native", "double");
                ProfileCheck(doubleSummary.SampleCount > 0 && doubleSummary.Average == 1.25, "native double counter values");
                p.SaveProfiler("native");
                int frame = p.LatestProfilerFrameIndex();
                var threads = p.GetProfilerThreads(frame);
                ProfileCheck(threads.Length > 0, "native frame thread data available: " + frame);
                if (threads.Length > 0)
                {
                    ProfileCheck(p.GetProfilerFrame(frame, new ProfilerFrameOptions { ThreadName = "does-not-exist" }).Error != "", "thread mismatch never falls back");
                    var data = p.GetProfilerFrame(frame, new ProfilerFrameOptions { ThreadIndex = threads[0].Index, SortBy = "self_ms" });
                    ProfileCheck(data.ThreadMatched && data.Error == "", "frame selection by index");
                }
                if (!EditorApplication.isPlaying)
                {
                    string snapshot = await p.SaveMemorySnapshotAsync("native-memory", token);
                    ProfileCheck(File.Exists(snapshot) && new FileInfo(snapshot).Length > 0, "native memory snapshot artifact");
                }
                return null;
            });
            RunAsyncSnippetOnMainThread(snippet, execution, null);
            string result = await execution.Completion.Task;
            await ProfileWaitTicks(1); // completion is signaled before the execution finally block.
            ProfileCheck(fail || cancel ? result.StartsWith("__ERROR__:") : !result.StartsWith("__ERROR__:"), "execute result: " + result);
            ProfileCheck(_profilerRecordingLeases == 0 && !ProfilerDriver.enabled, "execute cleanup after success/failure/cancellation");
        }

        private static async Task CheckStateProfiler()
        {
            var definition = new RuntimeStateMachineDefinition();
            definition.AddState("sample", ctx => ctx.Profiler.StartProfiler("state",
                new[] { ctx.Profiler.ProfilerMetric("x", () => 1, "count") }, new ProfilerCaptureOptions { Clock = "editor_update" }),
                ctx => {
                    if (ctx.TotalFrames == 1) ctx.Sleep(2);
                    ProfileCheck(ctx.GetProfilerSummary("state", "x").SampleCount == 3, "run_states samples while sleeping");
                    ctx.Done("ok");
                }, null);
            var completion = new TaskCompletionSource<RunStatesCompletion>();
            var session = new RuntimeStateMachineSession(definition, "sample", completion);
            for (int i = 0; i < 4; i++) session.Tick();
            var result = await completion.Task;
            ProfileCheck(result.Ok, "run_states completion: " + result.Message);
        }

        private static Task ProfileWaitTicks(int count)
        {
            var completion = new TaskCompletionSource<bool>();
            EditorApplication.CallbackFunction callback = null;
            callback = () => { if (--count <= 0) { EditorApplication.update -= callback; completion.TrySetResult(true); } };
            EditorApplication.update += callback;
            return completion.Task;
        }

        private static IntPtr _profilerCheckDoubleCounter;

        private static void CheckProfilerSamplingAllocations()
        {
            int tick = 0;
            using (var api = new ProfilerApi(() => tick, _ => {}, "allocation-test", false))
            {
                api.StartProfiler("allocation-test", new[] {
                    api.ProfilerMetric("custom", () => tick, "count"),
                    api.ProfilerMetric("memory", ProfilerCategory.Memory, "Total Used Memory", 1, "bytes")
                }, new ProfilerCaptureOptions { Clock = "editor_update", MaxSamples = 2048 });
                for (; tick < 32; tick++) { api.SampleProfilers(); api.RecordProfilerSpikeTop("allocation-test", "custom", 0, null, 5); }
                long before = GC.GetAllocatedBytesForCurrentThread();
                for (; tick < 2048; tick++) { api.SampleProfilers(); api.RecordProfilerSpikeTop("allocation-test", "custom", 0, null, 5); }
                long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
                ProfileCheck(allocated == 0, "recorder sampling across 512/1024 boundaries allocated " + allocated + " bytes");
                ProfileCheck(api.GetProfilerSummary("allocation-test", "custom").SampleCount == 2047, "preallocated capture keeps every row");
                ProfileCheck(api.GetProfilerSpikes("allocation-test").Length == 5 && api.GetProfilerSpikes("allocation-test").Max(s => s.Value) == 2047,
                    "zero-allocation spike replacements preserve top observations");
                api.StartProfiler("spike-limit", new[] { api.ProfilerMetric("x", () => 1, "count") },
                    new ProfilerCaptureOptions { Clock = "editor_update", MaxSpikes = 1 });
                tick++; api.SampleProfilers(); api.RecordProfilerSpike("spike-limit", "x", 0, "x");
                tick++; api.SampleProfilers();
                ProfileCheck(!api.RecordProfilerSpike("spike-limit", "x", 0, "x") && api.GetProfilerDroppedSpikeCount("spike-limit") == 1,
                    "spike capacity does not grow silently");
                int failures = 0;
                api.StartProfiler("failed-reader", new[] { api.ProfilerMetric("x", () => { failures++; throw new Exception("test reader"); }, "count") },
                    new ProfilerCaptureOptions { Clock = "editor_update", MaxSamples = 2 });
                tick++; api.SampleProfilers(); tick++; api.SampleProfilers();
                ProfileCheck(failures == 1 && api.GetProfilerSummary("failed-reader", "x").SampleCount == 0, "failing readers are not repeatedly invoked");
                Debug.Log("LOCUS_PROFILER_ALLOCATION_JSON {\"sampling_bytes\":" + allocated + "}");
            }
        }

        private static readonly ProfilerMarker CheckWorkerParent = new ProfilerMarker("Locus.Check.Worker.Parent");
        private static readonly ProfilerMarker CheckWorkerChild = new ProfilerMarker("Locus.Check.Worker.Child");
        private static readonly ProfilerMarker CheckWorkerOther = new ProfilerMarker("Locus.Check.Worker.Other");
        private static object _profileAllocationSink;

        private static async Task CheckProfilerWorkers()
        {
            var go = new[] { new AutoResetEvent(false), new AutoResetEvent(false) };
            var done = new[] { new AutoResetEvent(false), new AutoResetEvent(false) };
            int stopping = 0;
            var workers = new Thread[2];
            for (int w = 0; w < workers.Length; w++)
            {
                int worker = w;
                workers[w] = new Thread(() => {
                    UnityEngine.Profiling.Profiler.BeginThreadProfiling("Locus.Check", "Worker " + worker);
                    try
                    {
                        while (true)
                        {
                            go[worker].WaitOne();
                            if (Volatile.Read(ref stopping) != 0) break;
                            using (CheckWorkerParent.Auto())
                                for (int j = 0; j < 64; j++)
                                    using (CheckWorkerChild.Auto())
                                    {
                                        Thread.SpinWait(1000);
                                        _profileAllocationSink = new byte[128 + worker * 128];
                                    }
                            // Same child marker under a different parent must remain a separate row.
                            using (CheckWorkerOther.Auto())
                                using (CheckWorkerChild.Auto()) Thread.SpinWait(1000);
                            done[worker].Set();
                        }
                    }
                    finally { UnityEngine.Profiling.Profiler.EndThreadProfiling(); }
                }) { IsBackground = true };
                workers[w].Start();
            }
            try
            {
                using (var api = new ProfilerApi(() => 0, _ => {}, "worker-test", false))
                {
                    var buffer = new ProfilerFrameBuffer(maxThreads: 512, maxRows: 65536, timelineCapacity: 32768);
                    using (var recording = new ProfilerRecordingLease())
                    {
                        ProfileCheck(api.ReadProfilerFrameInto(api.LatestProfilerFrameIndex(), buffer) == ProfilerScanStatus.Recording,
                            "allocating multi-thread views reject live recording");
                        ProfileCheck(api.GetProfilerFrame(api.LatestProfilerFrameIndex()).Error != "", "hierarchy export rejects live recording");
                        ProfileCheck(api.ResolveProfilerFrameNames(buffer) == ProfilerScanStatus.Recording, "name resolution rejects live recording");
                        for (int f = 0; f < 8; f++)
                        {
                            for (int w = 0; w < 2; w++) go[w].Set();
                            for (int w = 0; w < 2; w++)
                                if (!done[w].WaitOne(10000)) throw new Exception("Worker did not finish");
                            await ProfileWaitTicks(1);
                        }
                    }
                    int selected = -1;
                    for (int f = api.LatestProfilerFrameIndex(); f >= Math.Max(ProfilerDriver.firstFrameIndex, api.LatestProfilerFrameIndex() - 12); f--)
                    {
                        ProfileCheck(api.ReadProfilerFrameInto(f, buffer) == ProfilerScanStatus.Complete, "all-worker scan complete");
                        ProfileCheck(!buffer.NamesResolved && buffer.Rows[0].Name == null, "numeric scan does not resolve strings");
                        api.ResolveProfilerFrameNames(buffer);
                        if (buffer.Rows.Take(buffer.RowCount).Count(r => r.Name == "Locus.Check.Worker.Parent") == 2)
                        { selected = f; break; }
                    }
                    ProfileCheck(selected >= 0, "two independently profiled workers in one frame");
                    var threadInfo = buffer.Threads.Take(buffer.ThreadCount).Where(t => t.Group == "Locus.Check").ToArray();
                    ProfileCheck(threadInfo.Length == 2 && threadInfo[0].Id != threadInfo[1].Id, "stable distinct worker IDs");
                    string saved = api.SaveProfilerFrameAnalysis("workers", buffer);
                    var savedJson = Locus.Json.LocusJson.Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(saved));
                    ProfileCheck((string)savedJson["schema"] == "locus.profiler.raw_frame.v1"
                        && File.ReadAllText(saved).Contains("Locus.Check.Worker.Parent"), "raw analysis JSON parses and retains names");
                    foreach (var thread in threadInfo)
                    {
                        var rows = buffer.Rows.Skip(thread.FirstRow).Take(thread.RowCount).ToArray();
                        var parent = rows.Single(r => r.Name == "Locus.Check.Worker.Parent");
                        var children = rows.Where(r => r.Name == "Locus.Check.Worker.Child").ToArray();
                        ProfileCheck(children.Length == 2 && children.Sum(r => r.Calls) == 65, "call paths retain repeated markers under different parents");
                        ProfileCheck(parent.GcBytes >= 8192 && thread.GcBytes >= parent.GcBytes && thread.MissingGcMetadata == 0, "GC metadata propagates to parents and thread");
                        using (var raw = ProfilerDriver.GetRawFrameDataView(selected, thread.Index))
                        {
                            double total = 0, self = 0;
                            long gc = 0;
                            int gcId = raw.GetMarkerId("GC.Alloc");
                            for (int s = 0; s < raw.sampleCount; s++)
                            {
                                if (raw.GetSampleMarkerId(s) == gcId) gc += raw.GetSampleMetadataAsLong(s, 0);
                                if (raw.GetSampleMarkerId(s) != parent.MarkerId) continue;
                                total += raw.GetSampleTimeMs(s);
                                self += raw.GetSampleTimeMs(s);
                                int end = s + raw.GetSampleChildrenCountRecursive(s);
                                for (int child = s + 1; child <= end; child += 1 + raw.GetSampleChildrenCountRecursive(child))
                                    self -= raw.GetSampleTimeMs(child);
                            }
                            ProfileCheck(Math.Abs(parent.TotalMs - total) < 1e-6 && Math.Abs(parent.SelfMs - self) < 1e-6 && thread.GcBytes == gc,
                                "numeric tree agrees with independent raw timing/GC traversal");
                            var scratch = new ProfilerFrameBuffer(maxRows: 4096, timelineCapacity: 4096);
                            api.AnalyzeProfilerThreadInto(raw, scratch);
                            long before = GC.GetAllocatedBytesForCurrentThread();
                            for (int n = 0; n < 100; n++) api.AnalyzeProfilerThreadInto(raw, scratch);
                            long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
                            ProfileCheck(allocated == 0 && scratch.Status == ProfilerScanStatus.Complete, "reused numeric worker scan allocated " + allocated + " bytes");
                            ProfileCheck(scratch.SampleCount == raw.sampleCount && !scratch.TimelineTruncated, "optional timeline retains every sample");
                            for (int s = 0; s < scratch.SampleCount; s++)
                            {
                                var sample = scratch.Samples[s];
                                ProfileCheck(sample.ParentSample < s && sample.MarkerRow < scratch.RowCount, "timeline references are in bounds");
                            }
                            ProfileCheck(api.AnalyzeProfilerThreadInto(raw, new ProfilerFrameBuffer(maxRows: 1)) == ProfilerScanStatus.RowCapacity, "row overflow is explicit");
                            ProfileCheck(api.AnalyzeProfilerThreadInto(raw, new ProfilerFrameBuffer(maxDepth: 1)) == ProfilerScanStatus.DepthCapacity, "depth overflow is explicit");
                            ProfileCheck(api.AnalyzeProfilerThreadInto(raw, new ProfilerFrameBuffer(maxSamples: 1)) == ProfilerScanStatus.SampleLimit, "scan work limit is explicit");
                            var shortTimeline = new ProfilerFrameBuffer(timelineCapacity: 1);
                            ProfileCheck(api.AnalyzeProfilerThreadInto(raw, shortTimeline) == ProfilerScanStatus.Complete && shortTimeline.TimelineTruncated,
                                "timeline truncation preserves full aggregates");
                            Debug.Log("LOCUS_PROFILER_ALLOCATION_JSON {\"worker_scan_bytes\":" + allocated + ",\"samples_per_scan\":" + raw.sampleCount + ",\"iterations\":100}");
                        }
                        foreach (string sort in new[] { "total_ms", "self_ms", "gc_bytes", "calls" })
                        {
                            var top = api.GetProfilerFrame(selected, new ProfilerFrameOptions { ThreadIndex = thread.Index, SortBy = sort, TopCount = 1 });
                            var full = api.GetProfilerFrame(selected, new ProfilerFrameOptions { ThreadIndex = thread.Index, SortBy = sort, TopCount = 512 });
                            ProfileCheck(top.Rows.Count == 1 && top.Rows[0].Path == full.Rows[0].Path, "bounded top row matches full hierarchy: " + sort);
                        }
                        var filtered = api.GetProfilerFrame(selected, new ProfilerFrameOptions { ThreadIndex = thread.Index, NameContains = "Locus.Check.Worker.Parent", TopCount = 2 });
                        ProfileCheck(filtered.Rows.Count == 2 && filtered.Rows.All(r => r.Path.Contains("Locus.Check.Worker.Parent")), "path filter retained");
                    }
                    ProfileCheck(api.ReadProfilerFrameInto(selected, new ProfilerFrameBuffer(maxThreads: 1)) == ProfilerScanStatus.ThreadCapacity, "thread overflow is explicit");
                    ProfileCheck(api.ReadProfilerFrameInto(selected, buffer, int.MaxValue) == ProfilerScanStatus.ThreadUnavailable, "missing thread is explicit");
                    ProfileCheck(api.ReadProfilerFrameInto(int.MaxValue, buffer) == ProfilerScanStatus.FrameUnavailable && buffer.RowCount == 0, "expired frame clears previous results");
                }
            }
            finally
            {
                Volatile.Write(ref stopping, 1);
                for (int w = 0; w < 2; w++) go[w].Set();
                for (int w = 0; w < 2; w++) { workers[w].Join(); go[w].Dispose(); done[w].Dispose(); }
            }
        }

        private static unsafe void SetProfilerCheckDoubleCounter()
        {
            if (_profilerCheckDoubleCounter == IntPtr.Zero)
                _profilerCheckDoubleCounter = (IntPtr)Unity.Profiling.LowLevel.Unsafe.ProfilerUnsafeUtility.CreateCounterValue(
                    out _, "Locus.Check.Double", ProfilerCategory.Scripts, Unity.Profiling.LowLevel.MarkerFlags.Default,
                    (byte)Unity.Profiling.LowLevel.ProfilerMarkerDataType.Double, (byte)ProfilerMarkerDataUnit.Count,
                    sizeof(double), ProfilerCounterOptions.FlushOnEndOfFrame);
            *(double*)_profilerCheckDoubleCounter = 1.25;
        }
    }
}
