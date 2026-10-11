//! Decode an image through Darkroom's decoder and write a quick-look PNG.
//!
//!   cargo run --release --example decode_png -- <input> <output.png> [format]
//!
//! format defaults to "raw". The PNG is downsampled 8x (nearest) and gets an
//! approximation of the engine's default look: linear sRGB x 2^0.5, sRGB gamma.
//! Prints per-channel means of the decoded linear data and the decode time.

use std::path::Path;
use std::time::Instant;

fn srgb(v: f32) -> f32 {
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        anyhow::bail!("usage: decode_png <input> <output.png> [format]");
    }
    let format = args.get(2).map(String::as_str).unwrap_or("raw");
    let t = Instant::now();
    let img = darkroom_lib::decode::decode_file(Path::new(&args[0]), format).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let dt = t.elapsed();
    let (w, h) = (img.width, img.height);
    let mut sum = [0f64; 3];
    for px in img.data.chunks_exact(3) {
        for c in 0..3 {
            sum[c] += px[c] as f64 / 65535.0;
        }
    }
    let n = (w * h) as f64;
    println!(
        "{}x{} space={} as_shot_mul={:?} decode={:.2}s means(lin)=[{:.4}, {:.4}, {:.4}]",
        w, h, img.color.space, img.color.as_shot_mul, dt.as_secs_f64(), sum[0] / n, sum[1] / n, sum[2] / n
    );

    let mut g: Vec<u16> = img.data.iter().skip(1).step_by(3).copied().collect();
    g.sort_unstable();
    let pct = |q: f64| g[((g.len() - 1) as f64 * q) as usize] as f64 / 65535.0;
    println!(
        "G percentiles: p1={:.4} p50={:.4} p99={:.4} p99.9={:.4} max={:.4} zeros={:.1}%",
        pct(0.01), pct(0.5), pct(0.99), pct(0.999), pct(1.0),
        g.iter().take_while(|v| **v == 0).count() as f64 * 100.0 / g.len() as f64
    );

    let step = 8;
    let (ow, oh) = (w / step, h / step);
    let gain = 2f32.powf(0.5);
    let mut out = image::RgbImage::new(ow as u32, oh as u32);
    for y in 0..oh {
        for x in 0..ow {
            let i = ((y * step) * w + x * step) * 3;
            let mut p = [0u8; 3];
            for c in 0..3 {
                let v = img.data[i + c] as f32 / 65535.0 * gain;
                p[c] = (srgb(v.clamp(0.0, 1.0)) * 255.0 + 0.5) as u8;
            }
            out.put_pixel(x as u32, y as u32, image::Rgb(p));
        }
    }
    out.save(&args[1])?;
    println!("wrote {}", args[1]);
    Ok(())
}
