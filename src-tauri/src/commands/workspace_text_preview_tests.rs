use super::*;

fn registry(config_dir: &Path) -> Arc<ProjectRegistry> {
    let config = Arc::new(crate::config::AppConfig::load_from_path(
        &config_dir.join("config.json"),
    ));
    let policy =
        Arc::new(crate::resource_policy::ResourcePolicyStore::from_config(config).unwrap());
    ProjectRegistry::new(policy, Vec::new())
}

#[test]
fn unknown_extensions_and_extensionless_files_preview_and_save_as_text() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry(root.path());
    let project_id = ProjectId::new("text-preview-test").unwrap();
    for name in [
        "事件大纲表.csv.view",
        "settings.unrecognized",
        "README",
        ".custom",
        "empty.unknown",
    ] {
        let path = root.path().join(name);
        let original = if name.starts_with("empty") {
            ""
        } else {
            "名称,值\r\n开始,1\r\n"
        };
        std::fs::write(&path, original).unwrap();
        let preview = build_file_preview(&registry, &project_id, &path).unwrap();
        assert_eq!(preview.kind, "text", "{name}");
        assert_eq!(preview.text.as_deref(), Some(original));
        assert!(preview.editable);
        assert!(!preview.truncated);
        let saved = write_text_file(
            &registry,
            &project_id,
            &path,
            "next\r\n",
            preview.content_hash.as_deref().unwrap(),
            "test",
        )
        .unwrap();
        assert_eq!(saved.text.as_deref(), Some("next\r\n"));
        assert_eq!(std::fs::read(&path).unwrap(), b"next\r\n");
    }
}

#[test]
fn utf16_preview_is_read_only_and_cannot_be_saved_as_utf8() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry(root.path());
    let project_id = ProjectId::new("text-preview-test").unwrap();
    let path = root.path().join("unicode.custom");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "事件开始\n".encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    std::fs::write(&path, &bytes).unwrap();
    let preview = build_file_preview(&registry, &project_id, &path).unwrap();
    assert_eq!(preview.kind, "text");
    assert_eq!(preview.text.as_deref(), Some("事件开始\n"));
    assert!(!preview.editable);
    let error = write_text_file(
        &registry,
        &project_id,
        &path,
        "changed",
        preview.content_hash.as_deref().unwrap(),
        "test",
    )
    .unwrap_err();
    assert_eq!(error.code, "workspace.explorer_file_not_editable");
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn binary_content_stays_binary_even_with_a_text_extension() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry(root.path());
    let project_id = ProjectId::new("text-preview-test").unwrap();
    for (name, bytes) in [
        ("binary.txt", b"hello\0world".as_slice()),
        ("controls.custom", b"\x01\x02\x03hello"),
        ("pdf.custom", b"%PDF-1.4\nASCII payload"),
        ("invalid.custom", b"broken\xffencoding"),
    ] {
        let path = root.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        let preview = build_file_preview(&registry, &project_id, &path).unwrap();
        assert_eq!(preview.kind, "binary", "{name}");
        assert!(!preview.editable);
        assert!(preview.text.is_none());
    }
}

#[test]
fn truncated_multibyte_text_remains_a_read_only_preview() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry(root.path());
    let project_id = ProjectId::new("text-preview-test").unwrap();
    let path = root.path().join("large.custom");
    let prefix = "x".repeat(MAX_TEXT_PREVIEW_BYTES as usize - 1);
    std::fs::write(&path, format!("{prefix}中tail")).unwrap();
    let preview = build_file_preview(&registry, &project_id, &path).unwrap();
    assert_eq!(preview.kind, "text");
    assert_eq!(preview.text.as_deref(), Some(prefix.as_str()));
    assert!(preview.truncated);
    assert!(!preview.editable);
    assert!(preview.content_hash.is_none());
}

#[test]
fn unity_assets_still_use_the_existing_inspector_route() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("Assets")).unwrap();
    let registry = registry(root.path());
    let runtime = registry.open_workspace(root.path()).unwrap();
    let path = runtime.root().join("Assets/Object.prefab");
    std::fs::write(&path, "%YAML 1.1\n").unwrap();
    let preview = build_file_preview(&registry, runtime.project_id(), &path).unwrap();
    assert_eq!(preview.kind, "unity");
    assert!(!preview.editable);
}
