use super::*;
use std::fs;

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("Assets")).unwrap();
    fs::write(root.path().join("Assets/Config.cs"), "using UnityEngine; public class Config : ScriptableObject { public float speed; public string code; }").unwrap();
    fs::write(root.path().join("Assets/Config.cs.meta"), "guid: 11111111111111111111111111111111\n").unwrap();
    fs::write(root.path().join("Assets/Config.asset"), "%YAML 1.1\n--- !u!114 &11400000\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: 11111111111111111111111111111111, type: 3}\n  speed: 1.25\n  code: 007\n").unwrap();
    fs::write(root.path().join("Assets/Config.asset.meta"), "guid: 22222222222222222222222222222222\n").unwrap();
    root
}
fn scan(root: &Path) {
    let mut db = crate::asset_db::AssetDb::open(root).unwrap();
    db.full_scan(|_| {}).unwrap();
}
fn read_request(field: &str) -> Value {
    json!({"action":"read_property","backend":"yaml","profile":true,
        "target":{"kind":"asset","path":"Assets/Config.asset","targetFileId":"11400000","propertyPath":field}})
}

#[tokio::test]
async fn asset_database_reads_match_fallback_and_never_scan_the_project() {
    let root = fixture();
    let fallback = execute(root.path(), read_request("code")).await.unwrap();
    assert_eq!(fallback["value"], "007");
    assert_eq!(fallback["profile"]["fullProjectScans"], 1);
    scan(root.path());
    for _ in 0..3 {
        let indexed = execute(root.path(), read_request("code")).await.unwrap();
        assert_eq!(indexed["value"], fallback["value"]);
        assert_eq!(indexed["revision"], fallback["revision"]);
        assert_eq!(indexed["dependencies"], fallback["dependencies"]);
        assert_eq!(indexed["profile"]["indexSource"], "asset_database");
        assert_eq!(indexed["profile"]["fullProjectScans"], 0);
    }
    let before = execute(root.path(), read_request("speed")).await.unwrap();
    let saved = execute(root.path(), json!({"action":"apply_properties","profile":true,"writes":[{
        "target":before["target"],"value":2.5,"expectedRevision":before["revision"],"expectedDependencies":before["dependencies"]
    }]})).await.unwrap();
    assert_eq!(saved["results"][0]["value"], 2.5);
    assert_eq!(saved["profile"]["fullProjectScans"], 0);
}

#[tokio::test]
async fn indexed_noop_keeps_conflict_checks_without_creating_a_transaction() {
    let root = fixture(); scan(root.path());
    let before = execute(root.path(), read_request("speed")).await.unwrap();
    let path = root.path().join("Assets/Config.asset");
    let bytes = fs::read(&path).unwrap();
    let request = json!({"action":"apply_properties","writes":[{
        "target":before["target"],"value":1.25,"expectedRevision":before["revision"],"expectedDependencies":before["dependencies"]
    }]});
    let result = execute(root.path(), request.clone()).await.unwrap();
    assert_eq!(result["ok"], true);
    assert!(result["transactionId"].is_null());
    assert_eq!(bytes, fs::read(&path).unwrap());
    fs::write(&path, String::from_utf8(bytes).unwrap().replace("1.25", "2.5")).unwrap();
    assert!(execute(root.path(), request).await.unwrap_err().contains("stale_revision"));
}

#[tokio::test]
async fn indexed_source_bytes_are_current_and_guid_changes_fail_closed() {
    let root = fixture(); scan(root.path());
    // Stored source metadata is a locator, not a stale field-type authority.
    fs::write(root.path().join("Assets/Config.cs"), "using UnityEngine; public class Config : ScriptableObject { public string speed; public string code; }").unwrap();
    let changed = execute(root.path(), read_request("speed")).await.unwrap();
    assert_eq!(changed["value"], "1.25");
    fs::write(root.path().join("Assets/Config.cs.meta"), "guid: 33333333333333333333333333333333\n").unwrap();
    let error = execute(root.path(), read_request("speed")).await.unwrap_err();
    assert!(error.contains("stale_asset_index"), "{error}");
}

#[tokio::test]
async fn indexed_duplicate_guids_remain_ambiguous_without_mutation() {
    let root = fixture();
    fs::write(root.path().join("Assets/Duplicate.cs"), "class Duplicate {}").unwrap();
    fs::write(root.path().join("Assets/Duplicate.cs.meta"), "guid: 11111111111111111111111111111111\n").unwrap();
    scan(root.path());
    let before = execute(root.path(), read_request("speed")).await.unwrap();
    let bytes = fs::read(root.path().join("Assets/Config.asset")).unwrap();
    let result = execute(root.path(), json!({"action":"apply_properties","writes":[{
        "target":before["target"],"value":2,"expectedRevision":before["revision"]
    }]})).await;
    assert!(result.is_err());
    assert_eq!(fs::read(root.path().join("Assets/Config.asset")).unwrap(), bytes);
}

#[tokio::test]
async fn database_class_aliases_resolve_helper_types_in_differently_named_files() {
    let root = fixture();
    fs::write(root.path().join("Assets/SharedConfig.cs"), "public class NestedConfig { public string code; }").unwrap();
    fs::write(root.path().join("Assets/SharedConfig.cs.meta"), "guid: 44444444444444444444444444444444\n").unwrap();
    fs::write(root.path().join("Assets/Config.cs"), "using UnityEngine; public class Config : ScriptableObject { public NestedConfig nested; }").unwrap();
    let path = root.path().join("Assets/Config.asset");
    let data = fs::read_to_string(&path).unwrap();
    fs::write(&path, data + "  nested:\n    code: 007\n").unwrap();
    scan(root.path());
    let result = execute(root.path(), read_request("nested.code")).await.unwrap();
    assert_eq!(result["value"], "007");
    assert!(result["dependencies"]["Assets/SharedConfig.cs"].is_string());
}

#[tokio::test]
async fn indexed_prefab_dependencies_are_still_read_and_rechecked_before_write() {
    let root = fixture();
    fs::write(root.path().join("Assets/Base.prefab"), "--- !u!114 &10\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: 11111111111111111111111111111111, type: 3}\n  speed: 7\n").unwrap();
    fs::write(root.path().join("Assets/Base.prefab.meta"), "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n").unwrap();
    fs::write(root.path().join("Assets/Variant.prefab"), "--- !u!1001 &100\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n  m_Modification:\n    m_Modifications: []\n    m_RemovedComponents: []\n    m_RemovedGameObjects: []\n").unwrap();
    scan(root.path());
    let request = json!({"action":"read_property","backend":"yaml","profile":true,"target":{"kind":"asset","path":"Assets/Variant.prefab","targetFileId":"110","propertyPath":"speed"}});
    let before = execute(root.path(), request.clone()).await.unwrap();
    assert_eq!(before["value"], 7.0);
    assert_eq!(before["profile"]["fullProjectScans"], 0);
    let base_path = root.path().join("Assets/Base.prefab");
    fs::write(&base_path, fs::read_to_string(&base_path).unwrap().replace("speed: 7", "speed: 9")).unwrap();
    let bytes = fs::read(root.path().join("Assets/Variant.prefab")).unwrap();
    let error = execute(root.path(), json!({"action":"apply_properties","writes":[{
        "target":before["target"],"value":2.5,"expectedRevision":before["revision"],"expectedDependencies":before["dependencies"]
    }]})).await.unwrap_err();
    assert!(error.contains("stale_dependency"), "{error}");
    assert_eq!(bytes, fs::read(root.path().join("Assets/Variant.prefab")).unwrap());
    assert_eq!(execute(root.path(), request).await.unwrap()["value"], 9.0);
}

/// Opt-in read-only benchmark against a real indexed project. Never writes its
/// assets, installs plugins, connects to Unity, or changes Editor state.
#[tokio::test]
#[ignore = "set LOCUS_PROPERTY_BENCH_ROOT and LOCUS_PROPERTY_BENCH_ASSET"]
async fn indexed_property_read_benchmark() {
    let root = std::path::PathBuf::from(std::env::var("LOCUS_PROPERTY_BENCH_ROOT").expect("benchmark root"));
    let path = std::env::var("LOCUS_PROPERTY_BENCH_ASSET").expect("benchmark asset");
    let field = std::env::var("LOCUS_PROPERTY_BENCH_FIELD").unwrap_or_else(|_| "navigation.waypointTolerance".into());
    let bytes = fs::read(root.join(&path)).unwrap();
    let mut results = vec![];
    for database in [false, true] {
        for _ in 0..3 {
            let start = std::time::Instant::now();
            let mut schema = super::schema::ProjectSchema::load_indexed(&root, database).unwrap();
            let hints = schema.scalar_hints(&bytes).unwrap();
            let _snapshot = crate::unity_asset_core::inspect_with_hints(&bytes, &hints).unwrap();
            results.push(json!({"database":database,"indexSource":schema.index_source,"indexMs":schema.index_load_ms,"readMs":start.elapsed().as_secs_f64()*1000.0}));
        }
    }
    let mut reads = vec![];
    for _ in 0..8 {
        let r = execute(&root, json!({"action":"read_property","backend":"yaml","profile":true,
            "target":{"kind":"asset","path":path,"targetFileId":"11400000","propertyPath":field}})).await.unwrap();
        assert_eq!(r["profile"]["fullProjectScans"], 0);
        reads.push(r["profile"].clone());
    }
    let mut full_reads = vec![];
    for _ in 0..8 {
        let r = execute(&root, json!({"action":"read_property","backend":"yaml","profile":true,
            "target":{"kind":"asset","path":path,"targetFileId":"11400000","propertyPath":""}})).await.unwrap();
        full_reads.push(r["profile"].clone());
    }
    std::println!("PROPERTY_READ_BENCH {}", json!({"schemaComparison":results,"logicalReads":reads,"fullReads":full_reads}));
    assert_eq!(bytes, fs::read(root.join(path)).unwrap());
}
