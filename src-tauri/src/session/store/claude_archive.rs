use super::*;
use crate::llm::claude_code_cli::{archive::{ArchiveInfo,Delta,Manifest,LIMIT},ssh::SshConfig};
use std::collections::BTreeMap;
use serde_json::Value;

impl SessionStore {
    pub(super) fn migrate_claude_native_identity(conn:&Connection)->rusqlite::Result<()> {
        if !Self::table_has_column(conn,"claude_native_bindings","native_id")? {
            conn.execute_batch("ALTER TABLE claude_native_bindings ADD COLUMN native_id TEXT;")?;
        }
        // Backfill from the latest acknowledged message before consulting an
        // older archive. Never move an explicitly bound session to another host.
        let mut stmt=conn.prepare("SELECT m.session_id,m.metadata_json,p.payload_json FROM messages m LEFT JOIN response_request_payloads p ON p.id=m.response_request_id ORDER BY m.rowid DESC")?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (id,metadata,payload) in rows {
            let Some(metadata)=metadata.and_then(|s|serde_json::from_str::<MessageMetadata>(&s).ok()) else {continue;};
            let Some(native)=metadata.cli_session_ids.as_ref().and_then(|v|v.get("claude_code")) else {continue;};
            if Uuid::parse_str(native).is_err(){continue;}
            let payload=payload.and_then(|s|serde_json::from_str::<Value>(&s).ok()).or(metadata.response_request);
            let Some(remote)=payload.and_then(|v|serde_json::from_value::<SshConfig>(v["claude_connection"].clone()).ok()) else {continue;};
            let remote=serde_json::to_string(&remote).unwrap();
            conn.execute("INSERT INTO claude_native_bindings(session_id,connection_json,native_id) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET native_id=excluded.native_id WHERE claude_native_bindings.native_id IS NULL AND claude_native_bindings.connection_json=excluded.connection_json",params![id,remote,native])?;
        }
        conn.execute_batch("INSERT INTO claude_native_bindings(session_id,connection_json,native_id)
            SELECT session_id,source_connection_json,json_extract(info_json,'$.nativeId') FROM claude_native_archives WHERE json_valid(info_json)
            ON CONFLICT(session_id) DO UPDATE SET native_id=excluded.native_id
            WHERE claude_native_bindings.native_id IS NULL AND claude_native_bindings.connection_json=excluded.connection_json;")?;
        Ok(())
    }
    pub(crate) fn claude_native_binding(&self,id:&str)->Result<Option<(SshConfig,Option<String>)>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let row:Option<(String,Option<String>)>=conn.query_row("SELECT connection_json,native_id FROM claude_native_bindings WHERE session_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        row.map(|(remote,native)|{
            if native.as_deref().is_some_and(|id|Uuid::parse_str(id).is_err()) {return Err("Invalid saved Claude native identity".into());}
            Ok((serde_json::from_str(&remote).map_err(|e|e.to_string())?,native))
        }).transpose()
    }
    pub(crate) fn bind_claude_native_session(&self,id:&str,remote:&SshConfig,native:&str)->Result<(),String> {
        Uuid::parse_str(native).map_err(|_|"Invalid Claude native identity")?;
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        conn.execute("INSERT INTO claude_native_bindings(session_id,connection_json,native_id) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET connection_json=excluded.connection_json,native_id=excluded.native_id",params![id,serde_json::to_string(remote).map_err(|e|e.to_string())?,native]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub(super) fn migrate_claude_native_archives(conn:&Connection)->rusqlite::Result<()> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS claude_native_archives (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            info_json TEXT NOT NULL,
            source_connection_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claude_native_archive_files (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            byte_count INTEGER NOT NULL CHECK(byte_count >= 0),
            payload_gzip BLOB NOT NULL,
            PRIMARY KEY(session_id,name)
        );
        CREATE TABLE IF NOT EXISTS claude_native_endpoints (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            fingerprint TEXT NOT NULL,
            connection_json TEXT NOT NULL,
            native_id TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            PRIMARY KEY(session_id,fingerprint)
        );
        CREATE TABLE IF NOT EXISTS claude_native_bindings (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            connection_json TEXT NOT NULL
        );")
    }
    pub(crate) fn claude_archive_info(&self,id:&str)->Result<Option<ArchiveInfo>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let raw:Option<String>=conn.query_row("SELECT info_json FROM claude_native_archives WHERE session_id=?1",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        raw.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose()
    }
    pub(crate) fn claude_archive_files(&self,id:&str)->Result<BTreeMap<String,Vec<u8>>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        Self::claude_archive_files_with_conn(&conn,id)
    }
    fn claude_archive_files_with_conn(conn:&Connection,id:&str)->Result<BTreeMap<String,Vec<u8>>,String> {
        let mut stmt=conn.prepare("SELECT name,sha256,byte_count,payload_gzip FROM claude_native_archive_files WHERE session_id=?1").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Vec<u8>>(3)?))).map_err(|e|e.to_string())?;
        let mut result=BTreeMap::new();let mut total=0usize;
        for row in rows {
            let (name,hash,size,compressed)=row.map_err(|e|e.to_string())?;
            if size<0 || size>LIMIT as i64 || !crate::llm::claude_code_cli::archive::valid_name(&name) {return Err("Invalid saved native archive file".into());}
            let mut bytes=Vec::new();
            GzDecoder::new(compressed.as_slice()).take(size as u64+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
            total=total.saturating_add(bytes.len());
            if bytes.len() as i64!=size || total>LIMIT || crate::llm::claude_code_cli::archive::digest(&bytes)!=hash {
                return Err("Saved native archive checksum mismatch".into());
            }
            result.insert(name,bytes);
        }
        Ok(result)
    }
    pub(crate) fn save_claude_archive(&self,id:&str,remote:&SshConfig,delta:&Delta,expected:&Manifest)->Result<ArchiveInfo,String> {
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let current:Option<String>=tx.query_row("SELECT info_json FROM claude_native_archives WHERE session_id=?1",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let current:Option<ArchiveInfo>=current.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose()?;
        let same_native=current.as_ref().is_some_and(|info|info.native_id==delta.native_id);
        let current_cursor=current.as_ref().filter(|_|same_native).map(|i|i.manifest.clone()).unwrap_or_default();
        if &current_cursor!=expected {return Err("Native archive changed during synchronization; retry".into());}
        let old=if same_native {Self::claude_archive_files_with_conn(&tx,id)?} else {BTreeMap::new()};
        let files=delta.apply(&old,&delta.native_id)?;
        if !same_native {tx.execute("DELETE FROM claude_native_archive_files WHERE session_id=?1",[id]).map_err(|e|e.to_string())?;}
        for name in old.keys().filter(|name|!files.contains_key(*name)) {
            tx.execute("DELETE FROM claude_native_archive_files WHERE session_id=?1 AND name=?2",params![id,name]).map_err(|e|e.to_string())?;
        }
        for change in &delta.changes {
            let mut encoder=GzEncoder::new(Vec::new(),Compression::fast());
            encoder.write_all(&files[&change.name]).map_err(|e|e.to_string())?;
            let compressed=encoder.finish().map_err(|e|e.to_string())?;
            let cursor=&delta.manifest[&change.name];
            tx.execute("INSERT INTO claude_native_archive_files(session_id,name,sha256,byte_count,payload_gzip) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(session_id,name) DO UPDATE SET sha256=excluded.sha256,byte_count=excluded.byte_count,payload_gzip=excluded.payload_gzip",params![id,change.name,cursor.sha256,cursor.size as i64,compressed]).map_err(|e|e.to_string())?;
        }
        let info=ArchiveInfo{version:1,native_id:delta.native_id.clone(),source_root:delta.source_root.clone(),manifest:delta.manifest.clone(),updated_at:Self::now_ts(),transferred_bytes:delta.transferred_bytes,incomplete_tail:delta.incomplete_tail};
        let remote_json=serde_json::to_string(remote).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO claude_native_archives(session_id,info_json,source_connection_json) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET info_json=excluded.info_json,source_connection_json=excluded.source_connection_json",params![id,serde_json::to_string(&info).map_err(|e|e.to_string())?,remote_json]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO claude_native_endpoints(session_id,fingerprint,connection_json,native_id,manifest_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(session_id,fingerprint) DO UPDATE SET connection_json=excluded.connection_json,native_id=excluded.native_id,manifest_json=excluded.manifest_json",params![id,remote.fingerprint(),remote_json,delta.native_id,serde_json::to_string(&delta.manifest).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
        Ok(info)
    }
    pub(crate) fn claude_active_remote(&self,id:&str)->Result<Option<SshConfig>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let raw:Option<String>=conn.query_row("SELECT connection_json FROM claude_native_bindings WHERE session_id=?1",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        raw.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose()
    }
    pub(crate) fn claude_endpoint_manifest(&self,id:&str,remote:&SshConfig,native:&str)->Result<Manifest,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let raw:Option<String>=conn.query_row("SELECT manifest_json FROM claude_native_endpoints WHERE session_id=?1 AND fingerprint=?2 AND native_id=?3",params![id,remote.fingerprint(),native],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        raw.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).transpose().map(Option::unwrap_or_default)
    }
    pub(crate) fn set_claude_active_remote(&self,id:&str,remote:&SshConfig)->Result<(),String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        conn.execute("INSERT INTO claude_native_bindings(session_id,connection_json) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET native_id=CASE WHEN connection_json=excluded.connection_json THEN native_id ELSE NULL END,connection_json=excluded.connection_json",params![id,serde_json::to_string(remote).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::claude_code_cli::archive::{digest,Change,Cursor};
    use base64::Engine;
    fn delta(native:&str,bytes:&[u8],offset:usize,base:Option<String>)->Delta {
        let name="transcript.jsonl".to_string();
        Delta{version:1,native_id:native.into(),source_root:"/remote/runtime".into(),
            manifest:BTreeMap::from([(name.clone(),Cursor{size:bytes.len() as u64,sha256:digest(bytes)})]),
            changes:vec![Change{name:name.clone(),offset:offset as u64,base_hash:base}],
            transferred_bytes:(bytes.len()-offset) as u64,incomplete_tail:false,
            chunks:BTreeMap::from([(name,vec![base64::engine::general_purpose::STANDARD.encode(&bytes[offset..])])])}
    }
    fn remote()->SshConfig {serde_json::from_value(serde_json::json!({"target":"test@host","port":22})).unwrap()}
    #[test]
    fn claude_identity_migrates_v50_survives_lost_messages_and_exports() {
        let root=tempfile::tempdir().unwrap();let store=SessionStore::new(root.path()).unwrap();
        let id=store.create_session("legacy native",None,None,"chat",None).unwrap();
        let native=Uuid::new_v4().to_string();
        let message=store.add_message(&id,MessageRole::User,"accepted input").unwrap();
        store.set_message_cli_session_id(&id,&message,"claude_code",&native).unwrap();
        store.set_message_response_request_metadata(&id,&message,&serde_json::json!({"backend":"claude_code_cli","claude_connection":remote()})).unwrap();
        let empty=store.create_session("older API",None,None,"chat",None).unwrap();
        store.add_message(&empty,MessageRole::User,"older history").unwrap();
        store.conn.lock().unwrap().execute_batch("ALTER TABLE claude_native_bindings DROP COLUMN native_id; PRAGMA user_version=50;").unwrap();
        drop(store);
        let store=SessionStore::new(root.path()).unwrap();
        assert_eq!(store.claude_native_binding(&id).unwrap(),Some((remote(),Some(native.clone()))));
        SessionStore::migrate_claude_native_identity(&store.conn.lock().unwrap()).unwrap();
        store.conn.lock().unwrap().execute("DELETE FROM messages WHERE session_id=?1",[&id]).unwrap();
        assert_eq!(crate::llm::claude_code_cli::recovery::native_session_id(&store,&id).unwrap(),Some(native.clone()));
        let output=root.path().join("binding.yaml");
        crate::session::context_export::export_session_context_yaml(&store,&id,"F:/test",None,None,&output).unwrap();
        assert!(std::fs::read_to_string(&output).unwrap().contains(&native));
        crate::session::context_export::export_session_context_yaml(&store,&empty,"F:/test",None,None,&output).unwrap();
        let yaml:serde_yaml::Value=serde_yaml::from_str(&std::fs::read_to_string(output).unwrap()).unwrap();
        assert_eq!(yaml["sessions"][0]["metadata"]["claudeNativeBinding"].as_str(),Some("empty"));
        store.commit_claude_rewind(&id,&[],0,None).unwrap();
        assert!(crate::llm::claude_code_cli::recovery::native_session_id(&store,&id).unwrap().is_none());
    }
    #[test]
    fn claude_archive_preserves_original_bytes_incrementally_and_rejects_corruption() {
        let root=tempfile::tempdir().unwrap();let store=SessionStore::new(root.path()).unwrap();
        let id=store.create_session("archive",None,None,"chat",None).unwrap();
        let native=Uuid::new_v4().to_string();let first=b"{\"type\":\"user\"}\n";
        let a=store.save_claude_archive(&id,&remote(),&delta(&native,first,0,None),&Manifest::new()).unwrap();
        assert_eq!(store.claude_archive_files(&id).unwrap()["transcript.jsonl"],first);
        let all=[first.as_slice(),b"{\"type\":\"assistant\"}\n"].concat();
        let change=delta(&native,&all,first.len(),Some(digest(first)));
        let b=store.save_claude_archive(&id,&remote(),&change,&a.manifest).unwrap();
        assert_eq!(b.transferred_bytes,(all.len()-first.len()) as u64);
        let before=store.claude_archive_files(&id).unwrap();
        let mut broken=delta(&native,b"wrong\n",0,None);broken.manifest.get_mut("transcript.jsonl").unwrap().sha256="0".repeat(64);
        assert!(store.save_claude_archive(&id,&remote(),&broken,&b.manifest).is_err());
        assert_eq!(store.claude_archive_files(&id).unwrap(),before);
        let unchanged=Delta{version:1,native_id:native.clone(),source_root:"/remote/runtime".into(),manifest:b.manifest.clone(),changes:vec![],chunks:BTreeMap::new(),transferred_bytes:0,incomplete_tail:false};
        store.save_claude_archive(&id,&remote(),&unchanged,&b.manifest).unwrap();
        drop(store);
        let store=SessionStore::new(root.path()).unwrap();
        assert_eq!(store.claude_archive_files(&id).unwrap()["transcript.jsonl"],all);
        let export=store.create_export_snapshot().unwrap();
        assert_eq!(export.claude_archive_files(&id).unwrap(),store.claude_archive_files(&id).unwrap());
    }
    #[test]
    fn claude_archive_migrates_v49_and_legacy_export_is_explicitly_empty() {
        let root=tempfile::tempdir().unwrap();let store=SessionStore::new(root.path()).unwrap();
        let id=store.create_session("old archive",None,None,"chat",None).unwrap();
        store.add_message(&id,MessageRole::User,"old message").unwrap();
        {
            let conn=store.conn.lock().unwrap();
            conn.execute_batch("DROP TABLE claude_native_archive_files; DROP TABLE claude_native_archives; DROP TABLE claude_native_endpoints; DROP TABLE claude_native_bindings; PRAGMA user_version=49;").unwrap();
        }
        drop(store);
        let store=SessionStore::new(root.path()).unwrap();
        assert!(store.claude_archive_info(&id).unwrap().is_none());
        SessionStore::migrate_claude_native_archives(&store.conn.lock().unwrap()).unwrap();
        let output=root.path().join("legacy.yaml");
        crate::session::context_export::export_session_context_yaml(&store,&id,"F:/test",None,None,&output).unwrap();
        let yaml:serde_yaml::Value=serde_yaml::from_str(&std::fs::read_to_string(output).unwrap()).unwrap();
        assert_eq!(yaml["sessions"][0]["metadata"]["claudeNativeArchive"].as_str(),Some("empty"));
        assert_eq!(store.get_messages(&id).unwrap()[0].content,"old message");
    }
}
