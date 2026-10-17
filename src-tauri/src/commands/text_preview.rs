//! Content detection for files whose extension cannot establish a text format.
//! Callers supply a bounded prefix and say whether EOF was reached. Detection
//! is deliberately conservative: undecodable bytes are never replaced silently.

pub(super) struct DecodedTextPreview {
    pub text: String,
    // The existing editor writes UTF-8 only; transcoded previews stay read-only.
    pub utf8: bool,
}

pub(super) fn decode_text_preview(bytes: &[u8], truncated: bool) -> Option<DecodedTextPreview> {
    if has_binary_signature(bytes) {
        return None;
    }

    // Check UTF-32 before UTF-16 since their little-endian BOMs overlap.
    if bytes.starts_with(&[0xff, 0xfe, 0, 0]) || bytes.starts_with(&[0, 0, 0xfe, 0xff]) {
        return None;
    }
    let utf16 = if bytes.starts_with(&[0xff, 0xfe]) {
        Some((true, &bytes[2..]))
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some((false, &bytes[2..]))
    } else {
        guess_utf16(bytes).map(|little_endian| (little_endian, bytes))
    };
    let (text, utf8) = if let Some((little_endian, content)) = utf16 {
        (decode_utf16(content, little_endian, truncated)?, false)
    } else {
        let text = match std::str::from_utf8(bytes) {
            Ok(text) => text,
            // A byte-limited read can end in the middle of a code point.
            Err(error) if truncated && error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()?
            }
            Err(_) => return None,
        };
        // Preserve a UTF-8 BOM in the document so a later save preserves it too.
        (text.to_owned(), true)
    };

    if !looks_like_text(&text) {
        return None;
    }
    Some(DecodedTextPreview { text, utf8 })
}

fn guess_utf16(bytes: &[u8]) -> Option<bool> {
    let sample = &bytes[..bytes.len().min(512)];
    let pairs = sample.len() / 2;
    if pairs < 4 {
        return None;
    }
    let mut even_zeros = 0;
    let mut odd_zeros = 0;
    for pair in sample.chunks_exact(2) {
        even_zeros += usize::from(pair[0] == 0);
        odd_zeros += usize::from(pair[1] == 0);
    }
    // Require a strong alternating-zero pattern. BOM-less non-ASCII UTF-16
    // cannot always be distinguished from arbitrary binary and is not guessed.
    if odd_zeros * 5 >= pairs * 4 && even_zeros == 0 {
        Some(true)
    } else if even_zeros * 5 >= pairs * 4 && odd_zeros == 0 {
        Some(false)
    } else {
        None
    }
}

fn decode_utf16(bytes: &[u8], little_endian: bool, truncated: bool) -> Option<String> {
    if bytes.len() % 2 != 0 && !truncated {
        return None;
    }
    let mut units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    if truncated
        && units
            .last()
            .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
    {
        units.pop();
    }
    String::from_utf16(&units).ok()
}

fn looks_like_text(text: &str) -> bool {
    let mut characters = 0;
    let mut controls = 0;
    for character in text.chars() {
        if character == '\0' {
            return false;
        }
        characters += 1;
        if character.is_control() && !matches!(character, '\t' | '\r' | '\n' | '\u{c}') {
            controls += 1;
        }
    }
    // Count Unicode characters, not bytes, so CJK and emoji are ordinary text.
    controls * 100 <= characters
}

fn has_binary_signature(bytes: &[u8]) -> bool {
    const SIGNATURES: &[&[u8]] = &[
        b"%PDF-",
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF87a",
        b"GIF89a",
        b"PK\x03\x04",
        b"PK\x05\x06",
        b"PK\x07\x08",
        b"\x1f\x8b",
        b"7z\xbc\xaf\x27\x1c",
        b"Rar!\x1a\x07",
        b"\xfd7zXZ\0",
        b"\x7fELF",
        b"SQLite format 3\0",
    ];
    SIGNATURES
        .iter()
        .any(|signature| bytes.starts_with(signature))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16_bytes(text: &str, little_endian: bool, bom: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        if bom {
            bytes.extend(if little_endian {
                [0xff, 0xfe]
            } else {
                [0xfe, 0xff]
            });
        }
        for unit in text.encode_utf16() {
            bytes.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        bytes
    }

    #[test]
    fn text_preview_accepts_empty_unicode_and_utf8_bom() {
        for text in [
            "",
            "name,value\r\n事件,1\r\n",
            "中文 🎮\t\n",
            "\u{feff}{\"version\":1}",
        ] {
            let preview = decode_text_preview(text.as_bytes(), false).expect("text");
            assert_eq!(preview.text, text);
            assert!(preview.utf8);
        }
    }

    #[test]
    fn text_preview_decodes_utf16_without_mistaking_zero_bytes_for_binary() {
        for little_endian in [true, false] {
            for (text, bom) in [("事件：开始 🎮\r\n", true), ("name,value\n", false)] {
                let preview = decode_text_preview(&utf16_bytes(text, little_endian, bom), false)
                    .expect("utf16");
                assert_eq!(preview.text, text);
                assert!(!preview.utf8);
            }
        }
    }

    #[test]
    fn text_preview_rejects_binary_signatures_controls_and_invalid_encodings() {
        for bytes in [
            b"hello\0world".as_slice(),
            b"\x01\x02\x03readable",
            b"bad\xffutf8",
            b"%PDF-1.4\nplain ASCII header",
            b"GIF89a",
            b"PK\x03\x04text",
            &[0xff, 0xfe, 0, 0, 0x41, 0, 0, 0],
            &[0xff, 0xfe, 0, 0xd8],
            &[0xff, 0xfe, 0x41],
        ] {
            assert!(decode_text_preview(bytes, false).is_none(), "{bytes:?}");
        }
    }

    #[test]
    fn text_preview_only_tolerates_incomplete_characters_at_a_truncated_boundary() {
        let text = "prefix中";
        for end in text.len() - 2..text.len() {
            let bytes = &text.as_bytes()[..end];
            assert_eq!(decode_text_preview(bytes, true).unwrap().text, "prefix");
            assert!(decode_text_preview(bytes, false).is_none());
        }
        assert!(decode_text_preview(b"invalid\xffprefix\xe4", true).is_none());
        for little_endian in [true, false] {
            let bytes = utf16_bytes("prefix🎮", little_endian, true);
            for end in bytes.len() - 3..bytes.len() {
                assert_eq!(
                    decode_text_preview(&bytes[..end], true).unwrap().text,
                    "prefix"
                );
                assert!(decode_text_preview(&bytes[..end], false).is_none());
            }
        }
    }
}
