/// Metadata accepts a Lucide name or an inline SVG document. SVG parsing and
/// sanitizing happen in the renderer; never inject this source directly into DOM.
pub(super) fn validate_view_icon(icon: &str) -> Result<(), String> {
    if icon.starts_with('<') {
        if icon.len() > 32 * 1024 {
            return Err("View SVG icon exceeds 32 KiB.".into());
        }
        let svg = icon.strip_prefix("<svg");
        let has_svg_root = svg.is_some_and(|tail| {
            tail.starts_with('>') || tail.starts_with('/')
                || tail.starts_with(|ch: char| ch.is_ascii_whitespace())
        });
        if !has_svg_root || !(icon.ends_with("</svg>") || icon.ends_with("/>")) {
            return Err("View icon must be a Lucide name or an inline <svg> document.".into());
        }
        return Ok(());
    }
    if icon.is_empty() || icon.len() > 64 {
        return Err("View Lucide icon name must be between 1 and 64 characters.".into());
    }
    if !icon.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return Err("View icon must be a Lucide name or an inline <svg> document.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_view_icon;

    #[test]
    fn accepts_lucide_names_and_inline_svg() {
        for value in ["InspectionPanel", "Swords", "alarm-clock", "FileCode2", "<svg/>",
            r#"<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2 2h20v20H2z"/></svg>"#] {
            assert!(validate_view_icon(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn rejects_other_payloads_and_oversize_svg() {
        for value in ["", "icons/custom.svg", "https://example.com/icon.svg", "data:image/svg+xml,<svg/>",
            "<script/>", "<svg-icon/>", "<svg>"] {
            assert!(validate_view_icon(value).is_err(), "{value}");
        }
        assert!(validate_view_icon(&"A".repeat(65)).is_err());
        assert!(validate_view_icon(&format!("<svg>{}</svg>", " ".repeat(32 * 1024))).is_err());
        assert!(validate_view_icon(&format!("<svg>{}</svg>", "中".repeat(12 * 1024))).is_err());
    }
}
