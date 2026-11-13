// CI-only probe. Compile with the baseline CPU, independently of Cargo config.
// Keep all AVX state (including compiler-inserted cleanup) out of the baseline
// entry point. Only the explicit negative-control branch enters this function.
#[inline(never)]
#[target_feature(enable = "avx2")]
unsafe fn avx2_negative_control() {
    std::arch::asm!("vpbroadcastd ymm0, xmm0", out("ymm0") _, options(nomem, nostack));
}

fn main() {
    if std::env::args().any(|arg| arg == "--avx2-negative-control") {
        // Deliberately unguarded: the emulator must trap this instruction.
        // Checking CPUID alone would allow an emulator that hides AVX2 but
        // still executes it to give the compatibility gate a false green.
        unsafe {
            avx2_negative_control();
        }
        panic!("emulator executed AVX2 despite the selected CPU model");
    }
    println!(
        "{{\"avx\":{},\"avx2\":{},\"f16c\":{},\"popcnt\":{}}}",
        std::is_x86_feature_detected!("avx"),
        std::is_x86_feature_detected!("avx2"),
        std::is_x86_feature_detected!("f16c"),
        std::is_x86_feature_detected!("popcnt"),
    );
}
