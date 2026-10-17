//! Read-only authoring projection of the existing asset database. This is a
//! discovery index, never authority for file contents or mutation admission.
//! Keep the connection short-lived: rescans may replace the cache on Windows.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::io::Read;
use rusqlite::{Connection, OpenFlags};

#[derive(Clone, Default)]
pub(crate) struct AuthoringIndex {
    pub guids: Arc<BTreeMap<String, Vec<PathBuf>>>,
    pub scripts: Arc<BTreeMap<String, Vec<PathBuf>>>,
    pub meta_guids: Arc<BTreeMap<PathBuf, String>>,
}

// Cache only discovery maps, never asset/source bytes or write admission. No
// SQLite handle survives a request (Windows rescans replace the database).
// Include SQLite/WAL generation headers: WAL recycling can retain its length,
// and Windows last-write timestamps alone can lag while a writer is open.
#[derive(PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    header: Vec<u8>,
}
fn stamp(path: &Path, header_len: u64) -> Option<FileStamp> {
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let mut header = Vec::new();
    file.take(header_len).read_to_end(&mut header).ok()?;
    Some(FileStamp { len: meta.len(), modified: meta.modified().ok(), created: meta.created().ok(), header })
}
type Stamp = (Option<FileStamp>, Option<FileStamp>);
fn database_stamp(root: &Path) -> Stamp {
    let file = super::db::db_path(root);
    (stamp(&file, 100), stamp(&PathBuf::from(format!("{}-wal", file.display())), 32))
}
struct CachedIndex { root: PathBuf, stamp: Stamp, index: AuthoringIndex }
static CACHE: LazyLock<Mutex<Vec<CachedIndex>>> = LazyLock::new(|| Mutex::new(Vec::new()));

pub(crate) fn read(root: &Path) -> Result<Option<AuthoringIndex>, String> {
    let before = database_stamp(root);
    if before.0.is_none() { return Ok(None); }
    {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = cache.iter().position(|entry| entry.root == root && entry.stamp == before) {
            let entry = cache.remove(i);
            let result = entry.index.clone();
            cache.push(entry);
            return Ok(Some(result));
        }
    }
    let result = read_uncached(root)?;
    // A concurrent index commit must not label an older SQL snapshot as new.
    if before == database_stamp(root) {
        if let Some(index) = &result {
            let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            cache.retain(|entry| entry.root != root);
            if cache.len() >= 4 { cache.remove(0); }
            cache.push(CachedIndex { root: root.to_path_buf(), stamp: before, index: index.clone() });
        }
    }
    Ok(result)
}

fn read_uncached(root: &Path) -> Result<Option<AuthoringIndex>, String> {
    let file = super::db::db_path(root);
    if !file.is_file() { return Ok(None); }
    let connection = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("property.asset_index: {e}"))?;
    connection.busy_timeout(std::time::Duration::from_millis(100)).map_err(|e| e.to_string())?;
    connection.execute_batch("BEGIN DEFERRED TRANSACTION").map_err(|e| e.to_string())?;
    if super::db::read_user_version(&connection)? != super::db::ASSET_DB_VERSION { return Ok(None); }
    let mut result = AuthoringIndex::default();
    // files, rather than assets (GUID primary key), preserves duplicate GUIDs.
    let mut query = connection.prepare("SELECT path, owner_guid FROM files WHERE file_role = ?1 AND owner_guid IS NOT NULL")
        .map_err(|e| format!("property.asset_index: {e}"))?;
    let rows = query.query_map([super::types::FileRole::Meta as i32], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
    }).map_err(|e| e.to_string())?;
    for row in rows {
        let (meta, guid) = row.map_err(|e| e.to_string())?;
        let Some(relative) = meta.strip_suffix(".meta") else { continue };
        if !(relative.starts_with("Assets/") || relative.starts_with("Packages/"))
            || relative.contains(':') || relative.contains('\\') || relative.split('/').any(|p| p == ".." || p == "." || p.is_empty()) || guid.len() != 16 { continue; }
        let guid = guid.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let path = root.join(relative);
        if path.extension().and_then(|s| s.to_str()) == Some("cs") {
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                Arc::make_mut(&mut result.scripts).entry(name.to_string()).or_default().push(path.clone());
            }
        }
        Arc::make_mut(&mut result.guids).entry(guid.clone()).or_default().push(path);
        Arc::make_mut(&mut result.meta_guids).insert(root.join(meta), guid);
    }
    // Use the scanner's parsed primary class too: Unity projects commonly keep
    // configuration helper classes in a differently named source file. Values
    // and field types are still parsed from current bytes by ProjectSchema.
    let mut scripts = connection.prepare("SELECT path, script_class_name FROM assets WHERE script_class_name <> ''")
        .map_err(|e| e.to_string())?;
    let rows = scripts.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, name) = row.map_err(|e| e.to_string())?;
        if !path.ends_with(".cs") || !(path.starts_with("Assets/") || path.starts_with("Packages/"))
            || path.contains('\\') || path.contains(':') || path.split('/').any(|p| p == ".." || p == "." || p.is_empty()) { continue; }
        let candidates = Arc::make_mut(&mut result.scripts).entry(name).or_default();
        let path = root.join(path);
        if !candidates.contains(&path) { candidates.push(path); }
    }
    // Empty/new databases are not complete discovery indexes. Preserve offline
    // fixture/CLI behavior until the existing scanner has populated the cache.
    Ok((!result.meta_guids.is_empty()).then_some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_duplicate_guids_and_isolates_roots_without_reading_meta_contents() {
        let a = tempfile::tempdir().unwrap(); let b = tempfile::tempdir().unwrap();
        let conn = super::super::db::open_db(a.path()).unwrap();
        for path in ["Assets/A.cs.meta", "Assets/B.asset.meta"] {
            conn.execute("INSERT INTO files(path,file_role,mtime_ns,size,hash128,owner_guid) VALUES(?1,?2,0,0,?3,?3)",
                rusqlite::params![path, super::super::types::FileRole::Meta as i32, vec![0x11u8;16]]).unwrap();
        }
        let index = read(a.path()).unwrap().unwrap();
        assert_eq!(index.guids[&"11".repeat(16)].len(), 2);
        assert_eq!(index.scripts["A"], vec![a.path().join("Assets/A.cs")]);
        assert!(read(b.path()).unwrap().is_none());
        assert!(!b.path().join("Library").exists());
        assert!(Arc::ptr_eq(&index.guids, &read(a.path()).unwrap().unwrap().guids));
        // Subsequent reads observe DB commits without retaining SQLite handles.
        conn.execute("DELETE FROM files WHERE path='Assets/B.asset.meta'", []).unwrap();
        assert_eq!(read(a.path()).unwrap().unwrap().guids[&"11".repeat(16)].len(), 1);
    }
}
