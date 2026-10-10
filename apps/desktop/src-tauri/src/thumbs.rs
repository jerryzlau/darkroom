//! Grid thumbnails. Raw files use their embedded preview JPEG when it is large
//! enough; everything else is decoded and downscaled. Edited thumbnails are
//! rendered by the GPU pipeline in the UI and stored separately per image.

use crate::decode::{self, fit_dims};
use crate::error::{AppError, AppResult};
use image::{metadata::Orientation, DynamicImage, RgbImage};
use rawler::decoders::RawDecodeParams;
use rawler::imgop::develop::RawDevelop;
use rawler::rawsource::RawSource;
use std::path::{Path, PathBuf};

pub const THUMB_SIZE: u32 = 640;

pub fn thumb_path(cache: &Path, photo_id: i64) -> PathBuf {
    cache.join("thumbs").join(format!("{:03}", photo_id % 1000)).join(format!("{photo_id}.jpg"))
}

pub fn edit_thumb_path(cache: &Path, image_id: i64) -> PathBuf {
    cache.join("thumbs").join("edit").join(format!("{image_id}.jpg"))
}

pub fn write_jpeg(img: &RgbImage, out: &Path, quality: u8) -> AppResult<()> {
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = out.with_extension("tmp");
    {
        let f = std::fs::File::create(&tmp)?;
        let mut w = std::io::BufWriter::new(f);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, quality).encode_image(img)?;
    }
    std::fs::rename(&tmp, out)?;
    Ok(())
}

fn shrink(img: RgbImage, max: u32) -> AppResult<RgbImage> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let (ow, oh) = fit_dims(w, h, max as usize);
    if (ow, oh) == (w, h) {
        return Ok(img);
    }
    decode::resize_rgb8(&img, ow as u32, oh as u32)
}

/// Produce an sRGB thumbnail for any supported file.
pub fn render_thumb(path: &Path, format: &str, max: u32) -> AppResult<RgbImage> {
    match format {
        "raw" => raw_thumb(path, max),
        "heic" => {
            let tmp = decode::sips_convert(path, Some(max * 2))?;
            let r = decode::read_raster(&tmp).map(|(img, _)| img.into_rgb8());
            let _ = std::fs::remove_file(&tmp);
            shrink(r?, max)
        }
        _ => {
            let (img, _) = decode::read_raster(path)?;
            shrink(img.into_rgb8(), max)
        }
    }
}

fn raw_thumb(path: &Path, max: u32) -> AppResult<RgbImage> {
    let src = RawSource::new(path)?;
    let decoder = rawler::get_decoder(&src)?;
    let params = RawDecodeParams::default();
    let orientation = decoder
        .raw_image(&src, &params, true)
        .map(|r| r.orientation.to_u16())
        .unwrap_or(1);
    let embedded: Option<DynamicImage> = decoder
        .preview_image(&src, &params)
        .ok()
        .flatten()
        .or_else(|| decoder.full_image(&src, &params).ok().flatten())
        .or_else(|| decoder.thumbnail_image(&src, &params).ok().flatten());
    let min_ok = (max / 2).max(256);
    let img = match embedded {
        Some(img) if img.width().max(img.height()) >= min_ok => {
            let mut img = img;
            if let Some(o) = Orientation::from_exif(orientation as u8) {
                img.apply_orientation(o);
            }
            img.into_rgb8()
        }
        _ => {
            // No usable embedded preview: develop the raw with rawler's default pipeline.
            let raw = decoder.raw_image(&src, &params, false)?;
            let inter = RawDevelop::default().develop_intermediate(&raw)?;
            let img = inter.to_dynamic_image().ok_or_else(|| AppError::Raw("develop failed".into()))?;
            let mut img = DynamicImage::ImageRgb8(img.into_rgb8());
            if let Some(o) = Orientation::from_exif(orientation as u8) {
                img.apply_orientation(o);
            }
            img.into_rgb8()
        }
    };
    shrink(img, max)
}

pub fn generate(cache: &Path, photo_id: i64, path: &Path, format: &str) -> AppResult<()> {
    let img = render_thumb(path, format, THUMB_SIZE)?;
    write_jpeg(&img, &thumb_path(cache, photo_id), 82)
}
