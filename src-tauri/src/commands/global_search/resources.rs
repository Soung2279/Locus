use super::{bounded_title, excerpt, GlobalSearchHit, GlobalSearchPage};
use crate::commands::workspace::{
    is_allowed_linked_asset_rel_path, normalize_workspace_sub_path,
    should_skip_workspace_entry_with_hidden,
};
use std::{
    path::Path,
    time::{Duration, Instant, UNIX_EPOCH},
};

fn resource_hit(
    kind: &'static str,
    id: String,
    title: &str,
    path: String,
    query: &str,
    modified_at: i64,
) -> GlobalSearchHit {
    GlobalSearchHit {
        kind,
        id,
        title: bounded_title(title, query),
        excerpt: path.clone(),
        field: "title",
        doc_type: None,
        path: Some(path),
        message_id: None,
        checkout_id: None,
        archived: false,
        modified_at,
    }
}

pub(super) fn search_files_page(
    root: &Path,
    query: &str,
    cursor: Option<&str>,
) -> Result<GlobalSearchPage, String> {
    if let Some(cursor) = cursor {
        if cursor.len() > 8192
            || cursor.is_empty()
            || normalize_workspace_sub_path(cursor).map_err(|e| e.to_string())? != cursor
        {
            return Err("Invalid file search cursor".into());
        }
    }
    let started = Instant::now();
    let mut matches = Vec::new();
    let mut scanned = 0;
    // Component ordering is the same as sorted depth-first traversal (a/x
    // precedes a.cs). Prune completed branches when resuming a page.
    let walk = walkdir::WalkDir::new(root)
        .min_depth(1)
        .max_depth(64)
        .follow_links(true)
        .sort_by(|left, right| {
            left.file_name()
                .to_string_lossy()
                .cmp(&right.file_name().to_string_lossy())
        })
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            let is_dir = entry.file_type().is_dir();
            if should_skip_workspace_entry_with_hidden(&name, is_dir, false, None)
                || (is_dir && name.eq_ignore_ascii_case("target"))
            {
                return false;
            }
            let rel = entry
                .path()
                .strip_prefix(root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            if is_dir && entry.path_is_symlink() && !is_allowed_linked_asset_rel_path(&rel) {
                return false;
            }
            !is_dir
                || cursor.is_none_or(|after| {
                    rel.split('/').cmp(after.split('/')).is_gt()
                        || after.starts_with(&format!("{rel}/"))
                        || rel == after
                })
        });
    for entry in walk {
        let entry = match entry {
            Ok(entry) => entry,
            // Files may disappear during a scan; linked asset cycles are not results.
            Err(error)
                if error.loop_ancestor().is_some()
                    || error
                        .io_error()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue
            }
            Err(error) => return Err(format!("File search failed: {error}")),
        };
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if cursor.is_some_and(|after| !rel.split('/').cmp(after.split('/')).is_gt()) {
            continue;
        }
        scanned += 1;
        if entry.file_type().is_file() && excerpt(&rel, query).is_some() {
            let modified_at = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
                .unwrap_or(0);
            matches.push(resource_hit(
                "file",
                rel.clone(),
                &entry.file_name().to_string_lossy(),
                rel.clone(),
                query,
                modified_at,
            ));
        }
        if matches.len() >= 20 || scanned >= 256 || started.elapsed() >= Duration::from_millis(60) {
            return Ok(GlobalSearchPage {
                matches,
                next_cursor: Some(rel),
            });
        }
    }
    Ok(GlobalSearchPage {
        matches,
        next_cursor: None,
    })
}

pub(super) fn search_views_page(
    working_dir: &str,
    query: &str,
    cursor: Option<&str>,
) -> Result<GlobalSearchPage, String> {
    if cursor.is_some_and(|value| value.len() > 1024) {
        return Err("Invalid view search cursor".into());
    }
    let mut views = crate::view::list_views_sync(working_dir)?;
    views.sort_by(|left, right| left.id.cmp(&right.id));
    let mut matches = Vec::new();
    for view in views {
        if cursor.is_some_and(|after| view.id.as_str() <= after) {
            continue;
        }
        let fields = [
            &view.name,
            &view.display_path,
            &view.id,
            &view.package_rel_path,
        ];
        if !fields.iter().any(|value| excerpt(value, query).is_some()) {
            continue;
        }
        // Prefer the matching path/identifier on the second line, otherwise
        // show the display path used by the View explorer.
        let detail = fields[1..]
            .iter()
            .find(|value| excerpt(value, query).is_some())
            .copied()
            .unwrap_or(&view.display_path)
            .clone();
        let mut hit = resource_hit(
            "view",
            view.id.clone(),
            &view.name,
            view.manifest_path,
            query,
            view.updated_at,
        );
        hit.excerpt = detail;
        matches.push(hit);
        if matches.len() >= 20 {
            return Ok(GlobalSearchPage {
                matches,
                next_cursor: Some(view.id),
            });
        }
    }
    Ok(GlobalSearchPage {
        matches,
        next_cursor: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_search_matches_names_paths_and_ids_and_pages_without_duplicates() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        for i in 0..23 {
            crate::view::create_view_sync(
                root,
                crate::view::ViewCreateRequest {
                    id: format!("search-panel-{i:03}"),
                    name: Some(format!("角色 Character {i}")),
                    display_path: Some(format!("角色工具/Panel {i}")),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let first = search_views_page(root, "character", None).unwrap();
        assert_eq!(first.matches.len(), 20);
        let second = search_views_page(root, "character", first.next_cursor.as_deref()).unwrap();
        assert_eq!(second.matches.len(), 3);
        assert!(second.next_cursor.is_none());
        let mut ids = std::collections::HashSet::new();
        for hit in first.matches.into_iter().chain(second.matches) {
            assert_eq!(hit.kind, "view");
            assert!(hit.modified_at > 0);
            assert!(Path::new(hit.path.as_deref().unwrap()).is_file());
            assert!(ids.insert(hit.id));
        }
        let path = search_views_page(root, "角色工具", None).unwrap();
        assert_eq!(path.matches.len(), 20);
        assert!(path
            .matches
            .iter()
            .all(|hit| hit.excerpt.contains("角色工具")));
        let id = search_views_page(root, "search-panel-022", None).unwrap();
        assert_eq!(id.matches.len(), 1);
        assert_eq!(id.matches[0].excerpt, "search-panel-022");
    }

    #[test]
    fn file_search_pages_through_paths_without_duplicates_and_skips_generated_folders() {
        let temp = tempfile::tempdir().unwrap();
        for folder in [
            "a",
            "a.cs",
            "Assets/Scripts",
            "node_modules",
            ".git",
            "Library",
            "target",
        ] {
            std::fs::create_dir_all(temp.path().join(folder)).unwrap();
            for i in 0..45 {
                std::fs::write(
                    temp.path()
                        .join(folder)
                        .join(format!("Character-中文-{i:03}.cs")),
                    "",
                )
                .unwrap();
            }
        }
        let mut cursor = None;
        let mut paths = std::collections::HashSet::new();
        loop {
            let page = search_files_page(temp.path(), "character-中文", cursor.as_deref()).unwrap();
            assert!(page.matches.len() <= 20);
            for hit in page.matches {
                assert_eq!(hit.kind, "file");
                assert!(hit.modified_at > 0);
                assert!(paths.insert(hit.path.unwrap()));
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(paths.len(), 135);
        let page = search_files_page(temp.path(), "assets/scripts/character", None).unwrap();
        assert_eq!(page.matches.len(), 20);
        assert!(search_files_page(temp.path(), "character.*", None)
            .unwrap()
            .matches
            .is_empty());
        assert!(search_files_page(temp.path(), "x", Some("../outside")).is_err());
    }

    #[test]
    fn file_search_can_resume_after_a_page_without_matches() {
        let temp = tempfile::tempdir().unwrap();
        for i in 0..300 {
            std::fs::write(temp.path().join(format!("a-{i:03}.txt")), "").unwrap();
        }
        std::fs::write(temp.path().join("z-needle.txt"), "").unwrap();
        let first = search_files_page(temp.path(), "needle", None).unwrap();
        assert!(first.matches.is_empty());
        assert!(first.next_cursor.is_some());
        let mut cursor = first.next_cursor;
        let mut hits = Vec::new();
        while let Some(after) = cursor {
            let page = search_files_page(temp.path(), "needle", Some(&after)).unwrap();
            hits.extend(page.matches);
            cursor = page.next_cursor;
        }
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "z-needle.txt");
    }
}
