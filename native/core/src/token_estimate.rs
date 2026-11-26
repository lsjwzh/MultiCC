/// Estimate tokens using the memory and context budget policy, counted in UTF-16 code units.
pub fn estimate(units: impl IntoIterator<Item = u16>) -> u64 {
    let mut quarters = 0u64;
    for unit in units {
        quarters += match unit {
            0x3040..=0x30ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xac00..=0xd7af
            | 0xf900..=0xfaff => 6,
            _ => 1,
        };
    }
    if quarters == 0 {
        0
    } else {
        ((quarters + 2) / 4).max(1)
    }
}
