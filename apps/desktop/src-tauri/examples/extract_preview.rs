//! Save every embedded preview rawler can find in a raw file (preview, full,
//! thumbnail) as PNGs, downscaled to a long edge of 900 px.
//!
//!   cargo run --release --example extract_preview -- <raw file> <out dir>

use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = Path::new(&args[0]);
    let out = Path::new(&args[1]);
    std::fs::create_dir_all(out).unwrap();
    let src = RawSource::new(path).unwrap();
    let dec = rawler::get_decoder(&src).unwrap();
    let p = RawDecodeParams::default();
    let items: Vec<(&str, rawler::Result<Option<image::DynamicImage>>)> = vec![
        ("preview", dec.preview_image(&src, &p)),
        ("full", dec.full_image(&src, &p)),
        ("thumbnail", dec.thumbnail_image(&src, &p)),
    ];
    for (name, r) in items {
        match r {
            Ok(Some(img)) => {
                let (w, h) = (img.width(), img.height());
                let rgb = img.to_rgb8();
                let n = (rgb.len() / 3) as f64;
                let mut s = [0f64; 3];
                for px in rgb.chunks_exact(3) {
                    for c in 0..3 {
                        s[c] += px[c] as f64;
                    }
                }
                println!("{name}: {w}x{h} mean sRGB R {:.1} G {:.1} B {:.1}", s[0] / n, s[1] / n, s[2] / n);
                let small = img.resize(900, 900, image::imageops::FilterType::Triangle);
                small.to_rgb8().save(out.join(format!("{name}.png"))).unwrap();
            }
            Ok(None) => println!("{name}: none"),
            Err(e) => println!("{name}: error {e}"),
        }
    }
}
