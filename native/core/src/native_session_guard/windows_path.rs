//! Node `path.win32.dirname` semantics for host-supplied session directories.
//! Keep drive and UNC roots on their original volume, and preserve the input
//! spelling rather than resolving or canonicalizing a possibly missing path.

fn separator(byte: u8) -> bool {
    matches!(byte, b'/' | b'\\')
}

pub(super) fn dirname(path: &str) -> String {
    let bytes = path.as_bytes();
    let len = bytes.len();
    if len == 0 {
        return ".".into();
    }
    if len == 1 {
        return if separator(bytes[0]) { path } else { "." }.into();
    }
    let mut root_end = None;
    let mut offset = 0;
    if separator(bytes[0]) {
        root_end = Some(1);
        offset = 1;
        if separator(bytes[1]) {
            let mut index = 2;
            while index < len && !separator(bytes[index]) {
                index += 1;
            }
            if index < len && index > 2 {
                while index < len && separator(bytes[index]) {
                    index += 1;
                }
                let share_start = index;
                while index < len && !separator(bytes[index]) {
                    index += 1;
                }
                if share_start < len {
                    if index == len {
                        return path.into();
                    }
                    root_end = Some(index + 1);
                    offset = index + 1;
                }
            }
        }
    } else if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let end = if len > 2 && separator(bytes[2]) { 3 } else { 2 };
        root_end = Some(end);
        offset = end;
    }
    let mut matched_slash = true;
    for index in (offset..len).rev() {
        if separator(bytes[index]) {
            if !matched_slash {
                return path[..index].into();
            }
        } else {
            matched_slash = false;
        }
    }
    root_end.map_or_else(|| ".".into(), |end| path[..end].into())
}
