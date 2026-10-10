//! cargo run --release --example make_samples -- <output dir> [width height]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).cloned().unwrap_or_else(|| "../../../test-images/generated".into());
    let w: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(4032);
    let h: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(2688);
    let set = darkroom_lib::samples::generate(std::path::Path::new(&dir), w, h).expect("generate samples");
    println!("wrote samples to {}", set.dir.display());
    if set.heic.is_none() {
        println!("(HEIC skipped: sips could not encode HEIC)");
    }
}
