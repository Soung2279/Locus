use super::*;
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Instant,
};

fn scalar(name: &str) -> UnitySerializedPropertySnapshot {
    UnitySerializedPropertySnapshot {
        name: name.into(),
        property_path: name.into(),
        property_type: "Integer".into(),
        value: serde_json::json!(42),
        display_value: "42".into(),
        editable: true,
        ..Default::default()
    }
}

fn branch(
    name: &str,
    children: Vec<UnitySerializedPropertySnapshot>,
) -> UnitySerializedPropertySnapshot {
    UnitySerializedPropertySnapshot {
        name: name.into(),
        property_path: name.into(),
        has_children: !children.is_empty(),
        children,
        ..Default::default()
    }
}

fn target(id: i64) -> UnitySerializedPropertyTarget {
    UnitySerializedPropertyTarget {
        kind: "component".into(),
        path: Some("Assets/Test.prefab".into()),
        target_file_id: Some(id),
        ..Default::default()
    }
}

fn reference(name: &str, id: i64) -> UnitySerializedPropertySnapshot {
    UnitySerializedPropertySnapshot {
        reference_target: Some(target(id)),
        ..scalar(name)
    }
}

fn fixtures() -> Vec<UnitySerializedPropertySnapshot> {
    let mut result = vec![
        scalar("value"),
        branch("empty", vec![]),
        branch("shallow", vec![scalar("child")]),
    ];
    let mut chain = scalar("tip");
    for level in 0..16 {
        chain = branch(&format!("level{level}"), vec![chain]);
    }
    result.push(chain);
    result.push(branch(
        "wide",
        (0..1024).map(|i| scalar(&format!("field{i}"))).collect(),
    ));
    let mut root = branch(
        "",
        vec![
            scalar("m_Name"),
            scalar("m_EditorHideFlags"),
            scalar("repeat"),
            scalar("Repeat"),
            scalar("slash/~name"),
            reference("ref", 7),
            reference("again", 7),
        ],
    );
    root.children.push(UnitySerializedPropertySnapshot {
        property_path: String::new(),
        binding_target: Some(target(7)),
        ..branch("component", vec![scalar("hidden")])
    });
    result.push(root);
    let mut array = branch(
        "items",
        (0..12)
            .map(|i| scalar(&format!("items.Array.data[{i}]")))
            .collect(),
    );
    array.is_array = true;
    array.array_size = 12;
    array.children_truncated = true;
    result.push(array);
    let mut compact = branch("position", vec![scalar("x"), scalar("y"), scalar("z")]);
    compact.property_type = "UnityEngine.Vector3".into();
    compact.display_value = "(1, 2, 3)".into();
    compact.children_truncated = true;
    result.push(compact);
    let managed = |name: &str| UnitySerializedPropertySnapshot {
        is_managed_reference: true,
        managed_reference_id: 99,
        binding_target: Some(target(10)),
        ..branch(name, vec![scalar("child")])
    };
    result.push(branch("managed", vec![managed("first"), managed("second")]));
    // Existing canonical values and stale presentation fields must be overwritten.
    let mut stale = reference("stale", 7);
    stale.canonical_path = "obsolete".into();
    stale.visible_child_count = 99;
    result.push(stale);
    result
}

fn reader(
    delayed: bool,
    calls: Arc<Mutex<Vec<(i64, usize)>>>,
) -> impl FnMut(
    UnitySerializedPropertyTarget,
    usize,
) -> std::pin::Pin<
    Box<dyn Future<Output = Result<UnitySerializedPropertySnapshot, String>> + Send>,
> {
    move |target, depth| {
        let calls = calls.clone();
        Box::pin(async move {
            if delayed {
                tokio::task::yield_now().await;
            }
            let id = target.target_file_id.unwrap_or_default();
            calls.lock().unwrap().push((id, depth));
            if id == -1 {
                return Err("reader failed".into());
            }
            Ok(branch(
                "",
                vec![
                    scalar("payload"),
                    reference("cycle", id),
                    reference("shared", 8),
                ],
            ))
        })
    }
}

#[tokio::test]
async fn live_projection_matches_recursive_output_and_read_order() {
    for delayed in [false, true] {
        for source in fixtures() {
            for depth in [0, 1, 2, 4, 16] {
                for array_limit in [0, 1, 4, 1024] {
                    let calls_before = Arc::new(Mutex::new(Vec::new()));
                    let calls_after = Arc::new(Mutex::new(Vec::new()));
                    let mut before = HashMap::new();
                    let mut after = HashMap::new();
                    let expected = live_projection_baseline::recursive(
                        source.clone(),
                        "Assets/Test.prefab".into(),
                        depth,
                        array_limit,
                        &mut before,
                        &mut reader(delayed, calls_before.clone()),
                    )
                    .await
                    .unwrap();
                    let actual = live_projection::project(
                        source.clone(),
                        "Assets/Test.prefab".into(),
                        depth,
                        array_limit,
                        &mut after,
                        reader(delayed, calls_after.clone()),
                    )
                    .await
                    .unwrap();
                    assert_eq!(
                        serde_json::to_value(actual).unwrap(),
                        serde_json::to_value(expected).unwrap(),
                        "source={} depth={depth} array_limit={array_limit} delayed={delayed}",
                        source.name
                    );
                    assert_eq!(before, after);
                    assert_eq!(*calls_before.lock().unwrap(), *calls_after.lock().unwrap());
                }
            }
        }
    }
}

#[tokio::test]
async fn live_projection_preserves_seed_and_reader_errors() {
    for id in [7, -1] {
        for seeded in [false, true] {
            let source = branch(
                "root",
                vec![scalar("first"), reference("ref", id), scalar("last")],
            );
            let mut expected_map = HashMap::new();
            if seeded {
                expected_map.insert(
                    target_identity(&target(id)).unwrap(),
                    "Assets/Other.prefab/first".into(),
                );
            }
            let mut actual_map = expected_map.clone();
            let expected = live_projection_baseline::recursive(
                source.clone(),
                "root".into(),
                4,
                4,
                &mut expected_map,
                &mut reader(true, Arc::default()),
            )
            .await;
            let actual = live_projection::project(
                source,
                "root".into(),
                4,
                4,
                &mut actual_map,
                reader(true, Arc::default()),
            )
            .await;
            assert_eq!(
                actual.map(|v| serde_json::to_value(v).unwrap()),
                expected.map(|v| serde_json::to_value(v).unwrap())
            );
            assert_eq!(actual_map, expected_map);
        }
    }
}

#[test]
fn live_projection_deep_tree_on_small_stack() {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let mut root = scalar("tip");
            for _ in 0..128 {
                root = branch("node", vec![root]);
            }
            let projected = runtime.block_on(live_projection::project(
                root,
                "root".into(),
                128,
                4,
                &mut HashMap::new(),
                |_, _| std::future::ready(Err("unexpected reference".into())),
            ));
            drop(projected.unwrap());
        })
        .unwrap()
        .join()
        .unwrap();
}

#[tokio::test]
async fn live_projection_cancellation_drops_pending_read() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut canonical = HashMap::new();
    let mut work = Box::pin(live_projection::project(
        branch("root", vec![reference("ref", 7)]),
        "root".into(),
        4,
        4,
        &mut canonical,
        |_, _| {
            let guard = Guard(dropped.clone());
            async move {
                let _guard = guard;
                std::future::pending().await
            }
        },
    ));
    tokio::select! { biased; _ = &mut work => panic!("must remain pending"), _ = tokio::task::yield_now() => {} }
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    drop(work);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

// The focused harness supplies a thread-local counting mimalloc allocator for
// these hooks. The application test binary measures timings without changing
// its process-wide allocator.
fn allocation_start() {}
fn allocation_finish() -> (u64, u64) {
    (0, 0)
}

#[test]
#[ignore = "release-only before/after benchmark; run with the focused harness"]
fn live_projection_performance() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for source in fixtures() {
        let iterations = if source.name == "wide" {
            40
        } else if source.name == "level15" {
            500
        } else {
            5000
        };
        let mut samples = [Vec::new(), Vec::new()];
        let mut allocations = [(0_u64, 0_u64); 2];
        let run = |input, algorithm| {
            let mut read = |target: UnitySerializedPropertyTarget, _| {
                std::future::ready(Ok(branch(
                    "",
                    vec![
                        scalar("payload"),
                        reference("cycle", target.target_file_id.unwrap_or_default()),
                    ],
                )))
            };
            let mut canonical = HashMap::new();
            let result = if algorithm == 0 {
                runtime.block_on(live_projection_baseline::recursive(
                    input,
                    "root".into(),
                    16,
                    4,
                    &mut canonical,
                    &mut read,
                ))
            } else {
                runtime.block_on(live_projection::project(
                    input,
                    "root".into(),
                    16,
                    4,
                    &mut canonical,
                    &mut read,
                ))
            }
            .unwrap();
            std::hint::black_box(&result);
            drop(result);
        };
        for round in 0..10 {
            for algorithm in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                let inputs: Vec<_> = (0..iterations).map(|_| source.clone()).collect();
                let started = Instant::now();
                for input in inputs {
                    run(input, algorithm);
                }
                let elapsed = started.elapsed().as_nanos() as f64 / iterations as f64;
                if round > 1 {
                    samples[algorithm].push(elapsed);
                }
            }
        }
        for algorithm in [0, 1] {
            let input = source.clone();
            allocation_start();
            run(input, algorithm);
            allocations[algorithm] = allocation_finish();
        }
        for sample in &mut samples {
            sample.sort_by(f64::total_cmp);
        }
        let median = |values: &[f64]| (values[3] + values[4]) / 2.0;
        let before = median(&samples[0]);
        let after = median(&samples[1]);
        println!(
            "PROJECTION_BENCH {}",
            serde_json::json!({"case":source.name,
            "before_ns":before,"after_ns":after,"ratio":after/before,
            "before_allocations":allocations[0].0,"after_allocations":allocations[1].0,
            "before_bytes":allocations[0].1,"after_bytes":allocations[1].1})
        );
        assert!(
            after <= before * 1.05,
            "projection regression for {}: {} -> {} ns",
            source.name,
            before,
            after
        );
        if allocations[0].0 > 0 {
            assert!(
                allocations[1].0 <= allocations[0].0,
                "allocation count regression for {}",
                source.name
            );
            assert!(
                allocations[1].1 <= allocations[0].1,
                "allocation bytes regression for {}",
                source.name
            );
        }
    }
}
