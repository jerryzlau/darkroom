//! Export: the UI renders the final image in tiles with the same GPU pipeline
//! used for preview, streams the tiles here, and we encode the result.

use crate::db::PhotoMeta;
use crate::error::{AppError, AppResult};
use crate::icc;
use exif::experimental::Writer as ExifWriter;
use exif::{Field, In, Rational, Tag, Value};
use img_parts::{Bytes, ImageEXIF, ImageICC};
use serde::Deserialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub path: String,
    /// "jpeg" | "png" | "tiff"
    pub format: String,
    pub quality: u8,
    /// 8 or 16
    pub bit_depth: u8,
    pub width: u32,
    pub height: u32,
    /// "srgb" | "p3" | "prophoto"
    pub color_space: String,
    pub image_id: i64,
    pub include_metadata: bool,
    pub include_location: bool,
    pub overwrite: bool,
}

pub struct ExportJob {
    pub spec: ExportSpec,
    pub buf8: Vec<u8>,
    pub buf16: Vec<u16>,
}

impl ExportJob {
    pub fn new(spec: ExportSpec) -> AppResult<Self> {
        let n = spec.width as usize * spec.height as usize * 3;
        if spec.width == 0 || spec.height == 0 || n > 3 * 200_000_000 {
            return Err(AppError::Other("invalid export size".into()));
        }
        let (buf8, buf16) = if spec.bit_depth == 16 && spec.format != "jpeg" { (vec![], vec![0u16; n]) } else { (vec![0u8; n], vec![]) };
        Ok(Self { spec, buf8, buf16 })
    }

    /// Copy an RGBA tile (top-down rows) into the output buffer.
    pub fn put_tile(&mut self, x: u32, y: u32, w: u32, h: u32, data: &[u8]) -> AppResult<()> {
        let (ow, oh) = (self.spec.width, self.spec.height);
        if x + w > ow || y + h > oh {
            return Err(AppError::Other("tile out of bounds".into()));
        }
        let sixteen = !self.buf16.is_empty();
        let bpp = if sixteen { 8 } else { 4 };
        if data.len() < (w * h) as usize * bpp {
            return Err(AppError::Other(format!("tile data too short: {} < {}", data.len(), w * h * bpp as u32)));
        }
        for row in 0..h as usize {
            let dst_row = (y as usize + row) * ow as usize + x as usize;
            for col in 0..w as usize {
                let si = (row * w as usize + col) * bpp;
                let di = (dst_row + col) * 3;
                if sixteen {
                    for c in 0..3 {
                        self.buf16[di + c] = u16::from_le_bytes([data[si + c * 2], data[si + c * 2 + 1]]);
                    }
                } else {
                    self.buf8[di..di + 3].copy_from_slice(&data[si..si + 3]);
                }
            }
        }
        Ok(())
    }
}

pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let dir = path.parent().unwrap_or(Path::new("."));
    for i in 1..10000 {
        let p = dir.join(format!("{stem}-{i}.{ext}"));
        if !p.exists() {
            return p;
        }
    }
    path.to_path_buf()
}

fn parse_exposure(s: &str) -> Option<Rational> {
    let s = s.trim().trim_end_matches('s');
    if let Some((n, d)) = s.split_once('/') {
        return Some(Rational { num: n.trim().parse().ok()?, denom: d.trim().parse().ok()? });
    }
    let v: f64 = s.parse().ok()?;
    Some(Rational { num: (v * 1000.0).round() as u32, denom: 1000 })
}

fn rat(v: f64, denom: u32) -> Rational {
    Rational { num: (v * denom as f64).round().max(0.0) as u32, denom }
}

fn ascii(tag: Tag, s: &str) -> Field {
    Field { tag, ifd_num: In::PRIMARY, value: Value::Ascii(vec![s.as_bytes().to_vec()]) }
}

/// Build a TIFF-structured EXIF block (without the "Exif\0\0" prefix).
pub fn build_exif(meta: &PhotoMeta, w: u32, h: u32, space: &str, include_location: bool) -> AppResult<Vec<u8>> {
    let mut fields: Vec<Field> = vec![];
    if let Some(m) = &meta.make {
        fields.push(ascii(Tag::Make, m));
    }
    if let Some(m) = &meta.model {
        fields.push(ascii(Tag::Model, m));
    }
    fields.push(ascii(Tag::Software, "Darkroom"));
    fields.push(Field { tag: Tag::Orientation, ifd_num: In::PRIMARY, value: Value::Short(vec![1]) });
    if let Some(d) = &meta.captured_at {
        // "YYYY-MM-DDTHH:MM:SS" -> "YYYY:MM:DD HH:MM:SS"
        if d.len() >= 19 {
            let s = format!("{} {}", d[..10].replace('-', ":"), &d[11..19]);
            fields.push(ascii(Tag::DateTimeOriginal, &s));
            fields.push(ascii(Tag::DateTime, &s));
        }
    }
    if let Some(r) = meta.exposure_time.as_deref().and_then(parse_exposure) {
        fields.push(Field { tag: Tag::ExposureTime, ifd_num: In::PRIMARY, value: Value::Rational(vec![r]) });
    }
    if let Some(f) = meta.fnumber {
        fields.push(Field { tag: Tag::FNumber, ifd_num: In::PRIMARY, value: Value::Rational(vec![rat(f, 10)]) });
    }
    if let Some(f) = meta.focal_length {
        fields.push(Field { tag: Tag::FocalLength, ifd_num: In::PRIMARY, value: Value::Rational(vec![rat(f, 10)]) });
    }
    if let Some(iso) = meta.iso {
        fields.push(Field {
            tag: Tag::PhotographicSensitivity,
            ifd_num: In::PRIMARY,
            value: Value::Short(vec![iso.clamp(0, 65535) as u16]),
        });
    }
    if let Some(l) = &meta.lens {
        fields.push(ascii(Tag::LensModel, l));
    }
    fields.push(Field {
        tag: Tag::ColorSpace,
        ifd_num: In::PRIMARY,
        value: Value::Short(vec![if space == "srgb" { 1 } else { 0xFFFF }]),
    });
    fields.push(Field { tag: Tag::PixelXDimension, ifd_num: In::PRIMARY, value: Value::Long(vec![w]) });
    fields.push(Field { tag: Tag::PixelYDimension, ifd_num: In::PRIMARY, value: Value::Long(vec![h]) });
    if include_location {
        if let (Some(lat), Some(lon)) = (meta.gps_lat, meta.gps_lon) {
            let dms = |v: f64| {
                let v = v.abs();
                let d = v.floor();
                let m = ((v - d) * 60.0).floor();
                let s = (v - d - m / 60.0) * 3600.0;
                vec![rat(d, 1), rat(m, 1), rat(s, 1000)]
            };
            fields.push(ascii(Tag::GPSLatitudeRef, if lat >= 0.0 { "N" } else { "S" }));
            fields.push(Field { tag: Tag::GPSLatitude, ifd_num: In::PRIMARY, value: Value::Rational(dms(lat)) });
            fields.push(ascii(Tag::GPSLongitudeRef, if lon >= 0.0 { "E" } else { "W" }));
            fields.push(Field { tag: Tag::GPSLongitude, ifd_num: In::PRIMARY, value: Value::Rational(dms(lon)) });
        }
    }
    let mut writer = ExifWriter::new();
    for f in &fields {
        writer.push_field(f);
    }
    let mut buf = Cursor::new(Vec::new());
    writer.write(&mut buf, false).map_err(|e| AppError::Other(format!("exif: {e}")))?;
    Ok(buf.into_inner())
}

/// Encode and write the finished job. Returns the path written.
pub fn finish(job: ExportJob, meta: &PhotoMeta) -> AppResult<PathBuf> {
    let s = &job.spec;
    let target = PathBuf::from(&s.path);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let out = if s.overwrite { target } else { unique_path(&target) };
    let icc_bytes = icc::profile(&s.color_space).to_vec();
    let exif = if s.include_metadata { Some(build_exif(meta, s.width, s.height, &s.color_space, s.include_location)?) } else { None };

    match s.format.as_str() {
        "jpeg" => {
            let mut enc_buf = Vec::new();
            {
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut enc_buf, s.quality.clamp(1, 100));
                enc.encode(&job.buf8, s.width, s.height, image::ExtendedColorType::Rgb8)?;
            }
            let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(Bytes::from(enc_buf)).map_err(|e| AppError::Other(e.to_string()))?;
            jpeg.set_icc_profile(Some(Bytes::from(icc_bytes)));
            if let Some(e) = exif {
                jpeg.set_exif(Some(Bytes::from(e)));
            }
            let f = std::fs::File::create(&out)?;
            jpeg.encoder().write_to(std::io::BufWriter::new(f))?;
        }
        "png" => {
            let mut enc_buf = Vec::new();
            {
                let enc = image::codecs::png::PngEncoder::new_with_quality(
                    &mut enc_buf,
                    image::codecs::png::CompressionType::Default,
                    image::codecs::png::FilterType::Adaptive,
                );
                use image::ImageEncoder;
                if job.buf16.is_empty() {
                    enc.write_image(&job.buf8, s.width, s.height, image::ExtendedColorType::Rgb8)?;
                } else {
                    // PNG stores 16-bit samples big-endian; image expects native u16 bytes.
                    let bytes: Vec<u8> = job.buf16.iter().flat_map(|v| v.to_ne_bytes()).collect();
                    enc.write_image(&bytes, s.width, s.height, image::ExtendedColorType::Rgb16)?;
                }
            }
            let mut png = img_parts::png::Png::from_bytes(Bytes::from(enc_buf)).map_err(|e| AppError::Other(e.to_string()))?;
            png.set_icc_profile(Some(Bytes::from(icc_bytes)));
            if let Some(e) = exif {
                png.set_exif(Some(Bytes::from(e)));
            }
            let f = std::fs::File::create(&out)?;
            png.encoder().write_to(std::io::BufWriter::new(f))?;
        }
        "tiff" => {
            use tiff::encoder::{colortype, compression::Lzw, TiffEncoder};
            use tiff::tags::Tag as TTag;
            let f = std::fs::File::create(&out)?;
            let mut enc = TiffEncoder::new(std::io::BufWriter::new(f))
                .map_err(|e| AppError::Other(e.to_string()))?
                .with_compression(tiff::encoder::Compression::Lzw);
            let _ = Lzw;
            let terr = |e: tiff::TiffError| AppError::Other(e.to_string());
            macro_rules! write_img {
                ($ct:ty, $data:expr) => {{
                    let mut img = enc.new_image::<$ct>(s.width, s.height).map_err(terr)?;
                    img.encoder().write_tag(TTag::Unknown(34675), &icc_bytes[..]).map_err(terr)?;
                    img.encoder().write_tag(TTag::Software, "Darkroom").map_err(terr)?;
                    if s.include_metadata {
                        if let Some(m) = &meta.make {
                            img.encoder().write_tag(TTag::Make, m.as_str()).map_err(terr)?;
                        }
                        if let Some(m) = &meta.model {
                            img.encoder().write_tag(TTag::Model, m.as_str()).map_err(terr)?;
                        }
                    }
                    img.write_data($data).map_err(terr)?;
                }};
            }
            if job.buf16.is_empty() {
                write_img!(colortype::RGB8, &job.buf8);
            } else {
                write_img!(colortype::RGB16, &job.buf16);
            }
        }
        other => return Err(AppError::Other(format!("unknown format {other}"))),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(dir: &Path, format: &str, depth: u8) -> ExportSpec {
        ExportSpec {
            path: dir.join(format!("out.{format}")).to_string_lossy().to_string(),
            format: format.into(),
            quality: 90,
            bit_depth: depth,
            width: 4,
            height: 2,
            color_space: "srgb".into(),
            image_id: 1,
            include_metadata: true,
            include_location: false,
            overwrite: false,
        }
    }

    fn meta() -> PhotoMeta {
        PhotoMeta {
            make: Some("Canon".into()),
            model: Some("EOS R5".into()),
            captured_at: Some("2024-05-06T07:08:09".into()),
            exposure_time: Some("1/250".into()),
            fnumber: Some(2.8),
            iso: Some(400),
            ..Default::default()
        }
    }

    #[test]
    fn writes_all_formats() {
        let dir = tempfile::tempdir().unwrap();
        for (fmt, depth) in [("jpeg", 8), ("png", 8), ("png", 16), ("tiff", 8), ("tiff", 16)] {
            let mut job = ExportJob::new(spec(dir.path(), fmt, depth)).unwrap();
            let bpp = if depth == 16 { 8 } else { 4 };
            let mut tile = vec![0u8; 4 * 2 * bpp];
            if depth == 16 {
                for px in tile.chunks_mut(8) {
                    px[0..2].copy_from_slice(&65535u16.to_le_bytes());
                }
            } else {
                for px in tile.chunks_mut(4) {
                    px[0] = 255;
                }
            }
            job.put_tile(0, 0, 4, 2, &tile).unwrap();
            let p = finish(job, &meta()).unwrap();
            let img = image::open(&p).unwrap();
            assert_eq!((img.width(), img.height()), (4, 2));
            let px = img.to_rgb8().get_pixel(1, 1).0;
            assert!(px[0] > 240 && px[1] < 15, "{fmt} {depth}: {px:?}");
            if fmt == "jpeg" {
                let f = std::fs::File::open(&p).unwrap();
                let e = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(f)).unwrap();
                let model = e.get_field(Tag::Model, In::PRIMARY).unwrap();
                assert!(model.display_value().to_string().contains("EOS R5"));
                assert!(e.get_field(Tag::ExposureTime, In::PRIMARY).is_some());
            }
        }
    }

    #[test]
    fn unique_paths() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(unique_path(&p), dir.path().join("a-1.jpg"));
    }
}
