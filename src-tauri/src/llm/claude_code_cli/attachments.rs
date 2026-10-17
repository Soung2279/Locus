//! User-supplied attachments enter the real terminal's paste/@file pipeline.
//! Project tools still execute in Locus; only immutable attachment bytes travel.
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_TOTAL: usize = 20 * 1024 * 1024;
const MAX_TEXT_FILE: u64 = 256 * 1024;

pub(super) struct PreparedInput {
    pub text: String,
    pub files: Vec<Value>,
}
impl PreparedInput {
    pub fn image_count(&self) -> usize {
        self.files
            .iter()
            .filter(|file| file["image"] == true)
            .count()
    }
    pub fn paths(&self, root: &str, id: &str) -> Vec<String> {
        self.files
            .iter()
            .map(|file| {
                format!(
                    "{}/attachments/{}/{}",
                    root.replace('\\', "/"),
                    id,
                    file["name"].as_str().unwrap()
                )
            })
            .collect()
    }
    pub fn prompt(&self, paths: &[String]) -> String {
        let mut text = self.text.clone();
        for (file, path) in self.files.iter().zip(paths) {
            // Native image pastes already carry media blocks. @image preloading
            // silently skips images over Claude's 256 KiB text-file limit.
            if file["image"] == true { continue; }
            text.push_str(&format!(
                "\n\nAttachment snapshot for `{}`: @\"{}\"",
                file["source"].as_str().unwrap_or("file"),
                path
            ));
        }
        text
    }
    pub fn terminal_text(&self, id: &str, paths: &[String]) -> String {
        let mut text = id.to_string();
        for (file, path) in self.files.iter().zip(paths) {
            if file["image"] == true { continue; }
            text.push_str(&format!(" @\"{path}\""));
        }
        text
    }
    pub fn image_paths<'a>(&self, paths: &'a [String]) -> Vec<&'a str> {
        self.files.iter().zip(paths)
            .filter(|(file, _)| file["image"] == true)
            .map(|(_, path)| path.as_str()).collect()
    }
    pub fn mappings(&self, paths: &[String]) -> Value {
        json!(self
            .files
            .iter()
            .zip(paths)
            .map(|(file, path)| json!({"path":path,"label":file["source"]}))
            .collect::<Vec<_>>())
    }
    pub fn write(&self, root: &Path, id: &str) -> Result<(), String> {
        let target = root.join("attachments").join(id);
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for file in &self.files {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file["data"].as_str().unwrap())
                .map_err(|e| e.to_string())?;
            std::fs::write(target.join(file["name"].as_str().unwrap()), bytes)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub(super) fn image_paste(path: &str) -> Result<String, String> {
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err("Invalid Claude image paste path".into());
    }
    // ConPTY can strip bracketed-paste markers. Whitespace also selects the
    // native bulk-paste handler (>800 characters in Claude 2.1.299), which trims
    // it before reading the image path. Never use the shared OS clipboard.
    let padding = " ".repeat(1024);
    Ok(format!("\x1b[200~\"{}\"{padding}\x1b[201~", path.replace('\\', "/")))
}

pub(super) fn prepare(user: &Value, cwd: &str) -> Result<PreparedInput, String> {
    let mut text = String::new();
    let mut files = Vec::new();
    let mut total = 0usize;
    if let Some(value) = user["content"].as_str() {
        text = value.into();
    } else {
        for block in user["content"]
            .as_array()
            .ok_or("Invalid Claude user message")?
        {
            match block["type"].as_str() {
                Some("text") => {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(block["text"].as_str().ok_or("Invalid text attachment")?);
                }
                Some("image") => {
                    let source = &block["source"];
                    if source["type"] != "base64" {
                        return Err("Claude image attachment requires base64 data".into());
                    }
                    let extension = match source["media_type"].as_str() {
                        Some("image/png") => "png",
                        Some("image/jpeg") => "jpg",
                        Some("image/gif") => "gif",
                        Some("image/webp") => "webp",
                        _ => return Err("Unsupported image attachment format".into()),
                    };
                    let data = source["data"].as_str().ok_or("Missing image data")?;
                    if data.len() > MAX_TOTAL * 4 / 3 + 4 {
                        return Err("Claude attachments exceed 20 MiB".into());
                    }
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .map_err(|_| "Invalid image attachment data")?;
                    imagesize::blob_size(&bytes)
                        .map_err(|_| "Invalid or unsupported image attachment")?;
                    total += bytes.len();
                    if total > MAX_TOTAL {
                        return Err("Claude attachments exceed 20 MiB".into());
                    }
                    let index = files.len() + 1;
                    files.push(json!({"name":format!("image-{index}.{extension}"),"data":data,"image":true,"source":format!("Locus image attachment {index}")}));
                }
                _ => return Err("Unsupported Claude input attachment".into()),
            }
        }
    }
    // These blocks are emitted by the composer for explicitly attached local
    // files. Do not scan arbitrary @ paths in user text or any model output.
    let blocks =
        regex::Regex::new(r"(?s)<locus-local-files>\n(.*?)\n</locus-local-files>").unwrap();
    let paths = regex::Regex::new(r"(?m)^- (file|folder): `([^`\r\n]+)`").unwrap();
    let mut seen = std::collections::HashSet::new();
    // Earlier pending user rows are appended before this prompt. Their file
    // snapshots and images travel with this last native input so the first
    // model request sees the complete batch, including all attachments.
    let mut attachment_text = text.clone();
    for prior in user["locusPendingUsers"].as_array().into_iter().flatten() {
        attachment_text.push('\n');
        attachment_text.push_str(prior["text"].as_str().ok_or("Invalid pending Claude text")?);
    }
    for block in blocks.captures_iter(&attachment_text) {
        for entry in paths.captures_iter(&block[1]) {
            let path = PathBuf::from(&entry[2]);
            let path = if path.is_absolute() {
                path
            } else {
                Path::new(cwd).join(path)
            };
            let path = std::fs::canonicalize(&path)
                .map_err(|e| format!("Attachment {}: {e}", &entry[2]))?;
            if !seen.insert(path.clone()) {
                continue;
            }
            if files.len() >= 24 {
                return Err("Too many Claude attachments".into());
            }
            let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            let bytes = if metadata.is_dir() {
                let mut names = std::fs::read_dir(&path)
                    .map_err(|e| e.to_string())?
                    .take(256)
                    .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                names.sort();
                format!(
                    "Directory snapshot (at most 256 entries):\n{}",
                    names.join("\n")
                )
                .into_bytes()
            } else if metadata.len() <= MAX_TEXT_FILE {
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                if std::str::from_utf8(&bytes).is_err() || bytes.contains(&0) {
                    continue;
                }
                bytes
            } else {
                continue;
            }; // Like native @files, larger/binary files remain references.
            total += bytes.len();
            if total > MAX_TOTAL {
                return Err("Claude attachments exceed 20 MiB".into());
            }
            files.push(json!({"name":format!("file-{}.txt",files.len()+1),"data":base64::engine::general_purpose::STANDARD.encode(bytes),"image":false,"source":entry[2].to_string()}));
        }
    }
    // The composer is backend-neutral; resolve its tool guidance here.
    text = text
        .replace(
            "using `read` for files and `list` for folders",
            "using native `Read` for files and `mcp__locus__list` for folders",
        )
        .replace("(use `read`)", "(use native `Read`)");
    Ok(PreparedInput { text, files })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn images_use_native_pastes_while_text_files_keep_at_references() {
        let input = PreparedInput { text: "Inspect both images and the file".into(), files: vec![
            json!({"name":"image-1.png","image":true,"source":"Locus image attachment 1"}),
            json!({"name":"file-2.txt","image":false,"source":"notes.txt"}),
            json!({"name":"image-3.jpg","image":true,"source":"Locus image attachment 3"}),
        ] };
        let paths = input.paths("C:\\test profile", "input");
        assert_eq!(input.image_count(), 2);
        assert_eq!(input.image_paths(&paths), vec![paths[0].as_str(), paths[2].as_str()]);
        assert_eq!(input.terminal_text("input", &paths), format!("input @\"{}\"", paths[1]));
        assert_eq!(input.prompt(&paths), format!("Inspect both images and the file\n\nAttachment snapshot for `notes.txt`: @\"{}\"", paths[1]));
        for (path, expected) in [(&paths[0][..], "\"C:/test profile/attachments/input/image-1.png\""), ("C:\\图片 目录\\image.png", "\"C:/图片 目录/image.png\"")] {
            let paste = image_paste(path).unwrap();
            let body = paste.strip_prefix("\x1b[200~").unwrap().strip_suffix("\x1b[201~").unwrap();
            assert_eq!(body.trim(), expected);
            assert!(body.chars().count() > 800, "ConPTY needs native bulk-paste detection even without escape markers");
        }
        for invalid in ["", "image.png\r", "image.png\n", "image\x1b[201~.png", "image\0.png"] {
            assert!(image_paste(invalid).is_err());
        }
    }
    #[test]
    fn explicit_files_use_bounded_local_snapshots_and_native_names() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("space name.txt"), "LOCAL_FILE_MARKER").unwrap();
        let user = json!({"content":"Read this\n<locus-local-files>\nRead contents only when needed, using `read` for files and `list` for folders.\n- file: `space name.txt`\n</locus-local-files>"});
        let input = prepare(&user, root.path().to_str().unwrap()).unwrap();
        assert_eq!(input.files.len(), 1);
        assert_eq!(input.image_count(), 0);
        assert!(input.text.contains("native `Read`"));
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(input.files[0]["data"].as_str().unwrap())
                .unwrap(),
            b"LOCAL_FILE_MARKER"
        );
        assert!(prepare(
            &json!({"content":"@/not/a/user/attachment"}),
            root.path().to_str().unwrap()
        )
        .unwrap()
        .files
        .is_empty());
    }
    #[test]
    fn malformed_images_fail_before_terminal_submission() {
        assert!(prepare(&json!({"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"bm90IGEgcG5n"}}]}),".").is_err());
    }
}
