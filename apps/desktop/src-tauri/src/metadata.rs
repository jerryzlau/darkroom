//! Fast metadata extraction at import time (no full pixel decode).

use crate::db::PhotoMeta;
use crate::error::AppResult;
use rawler::decoders::RawDecodeParams;
use rawler::formats::tiff::Rational;
use rawler::rawsource::RawSource;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::process::Command;

fn rat(r: &Rational) -> Option<f64> {
    if r.d == 0 {
        None
    } else {
        Some(r.n as f64 / r.d as f64)
    }
}

fn exif_date_to_iso(s: &str) -> Option<String> {
    // "YYYY:MM:DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS"
    let s = s.trim().trim_matches('\0');
    if s.len() < 19 {
        return None;
    }
    let (d, t) = s.split_at(10);
    let d = d.replace(':', "-");
    if d.starts_with("0000") {
        return None;
    }
    Some(format!("{}T{}", d, t.trim()))
}

pub fn format_exposure(seconds: f64) -> String {
    if seconds <= 0.0 {
        return String::new();
    }
    if seconds >= 0.3 {
        let s = format!("{:.1}", seconds);
        return format!("{}s", s.trim_end_matches(".0"));
    }
    format!("1/{}", (1.0 / seconds).round() as i64)
}

fn gps_to_deg(v: &[Rational; 3], r: Option<&str>) -> Option<f64> {
    let d = rat(&v[0])? + rat(&v[1]).unwrap_or(0.0) / 60.0 + rat(&v[2]).unwrap_or(0.0) / 3600.0;
    Some(if matches!(r, Some("S") | Some("W")) { -d } else { d })
}

fn base_meta(path: &Path, format: &str) -> AppResult<PhotoMeta> {
    let md = std::fs::metadata(path)?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(PhotoMeta {
        path: path.to_string_lossy().to_string(),
        filename: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        format: format.to_string(),
        file_size: md.len() as i64,
        mtime,
        ..Default::default()
    })
}

pub fn read_meta(path: &Path, format: &str) -> AppResult<PhotoMeta> {
    let mut m = base_meta(path, format)?;
    let ok = if format == "raw" { read_raw_meta(path, &mut m) } else { read_exif_meta(path, format, &mut m) };
    if let Err(e) = ok {
        log::warn!("metadata for {}: {e}", path.display());
    }
    if m.captured_at.is_none() && m.mtime > 0 {
        m.captured_at = chrono::DateTime::from_timestamp(m.mtime, 0)
            .map(|t| t.with_timezone(&chrono::Local).naive_local().format("%Y-%m-%dT%H:%M:%S").to_string());
    }
    Ok(m)
}

fn read_raw_meta(path: &Path, m: &mut PhotoMeta) -> AppResult<()> {
    let src = RawSource::new(path)?;
    let decoder = rawler::get_decoder(&src)?;
    let params = RawDecodeParams::default();
    if let Ok(md) = decoder.raw_metadata(&src, &params) {
        let e = &md.exif;
        m.make = Some(md.make.clone()).filter(|s| !s.is_empty());
        m.model = Some(md.model.clone()).filter(|s| !s.is_empty());
        m.lens = md
            .lens
            .as_ref()
            .map(|l| format!("{} {}", l.lens_make, l.lens_model).trim().to_string())
            .or_else(|| e.lens_model.clone())
            .filter(|s| !s.is_empty());
        m.captured_at = e.date_time_original.as_deref().or(e.create_date.as_deref()).and_then(exif_date_to_iso);
        m.focal_length = e.focal_length.as_ref().and_then(rat);
        m.fnumber = e.fnumber.as_ref().and_then(rat);
        m.exposure_time = e.exposure_time.as_ref().and_then(rat).map(format_exposure);
        m.iso = e
            .iso_speed_ratings
            .map(|v| v as i64)
            .or(e.iso_speed.map(|v| v as i64))
            .or(e.recommended_exposure_index.map(|v| v as i64));
        if let Some(g) = &e.gps {
            if let (Some(lat), Some(lon)) = (&g.gps_latitude, &g.gps_longitude) {
                m.gps_lat = gps_to_deg(lat, g.gps_latitude_ref.as_deref());
                m.gps_lon = gps_to_deg(lon, g.gps_longitude_ref.as_deref());
            }
        }
    }
    if let Ok(raw) = decoder.raw_image(&src, &params, true) {
        let (mut w, mut h) = match raw.crop_area.or(raw.active_area) {
            Some(r) => (r.d.w, r.d.h),
            None => (raw.width, raw.height),
        };
        if raw.orientation.to_u16() >= 5 {
            std::mem::swap(&mut w, &mut h);
        }
        m.width = w as i64;
        m.height = h as i64;
    }
    Ok(())
}

fn exif_str(f: &exif::Field) -> Option<String> {
    match &f.value {
        exif::Value::Ascii(v) => v.first().map(|s| String::from_utf8_lossy(s).trim().trim_matches('\0').to_string()),
        _ => Some(f.display_value().to_string()),
    }
    .filter(|s| !s.is_empty())
}

fn exif_rat(f: &exif::Field) -> Option<f64> {
    match &f.value {
        exif::Value::Rational(v) => v.first().map(|r| r.to_f64()),
        exif::Value::SRational(v) => v.first().map(|r| r.to_f64()),
        exif::Value::Short(v) => v.first().map(|v| *v as f64),
        exif::Value::Long(v) => v.first().map(|v| *v as f64),
        _ => None,
    }
}

fn exif_gps(e: &exif::Exif, tag: exif::Tag, rtag: exif::Tag) -> Option<f64> {
    let f = e.get_field(tag, exif::In::PRIMARY)?;
    let r = e.get_field(rtag, exif::In::PRIMARY).and_then(exif_str);
    if let exif::Value::Rational(v) = &f.value {
        if v.len() >= 3 {
            let d = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
            return Some(if matches!(r.as_deref(), Some("S") | Some("W")) { -d } else { d });
        }
    }
    None
}

fn read_exif_meta(path: &Path, format: &str, m: &mut PhotoMeta) -> AppResult<()> {
    let mut orientation = 1u32;
    if let Ok(file) = File::open(path) {
        let mut r = BufReader::new(file);
        if let Ok(e) = exif::Reader::new().read_from_container(&mut r) {
            use exif::{In, Tag};
            let get = |t: Tag| e.get_field(t, In::PRIMARY);
            m.make = get(Tag::Make).and_then(exif_str);
            m.model = get(Tag::Model).and_then(exif_str);
            m.lens = get(Tag::LensModel).and_then(exif_str);
            m.captured_at = get(Tag::DateTimeOriginal)
                .or(get(Tag::DateTimeDigitized))
                .or(get(Tag::DateTime))
                .and_then(exif_str)
                .and_then(|s| exif_date_to_iso(&s));
            m.focal_length = get(Tag::FocalLength).and_then(exif_rat);
            m.fnumber = get(Tag::FNumber).and_then(exif_rat);
            m.exposure_time = get(Tag::ExposureTime).and_then(exif_rat).map(format_exposure);
            m.iso = get(Tag::PhotographicSensitivity).and_then(|f| f.value.get_uint(0)).map(|v| v as i64);
            orientation = get(Tag::Orientation).and_then(|f| f.value.get_uint(0)).unwrap_or(1);
            m.gps_lat = exif_gps(&e, Tag::GPSLatitude, Tag::GPSLatitudeRef);
            m.gps_lon = exif_gps(&e, Tag::GPSLongitude, Tag::GPSLongitudeRef);
            if format == "heic" {
                let w = get(Tag::PixelXDimension).and_then(|f| f.value.get_uint(0));
                let h = get(Tag::PixelYDimension).and_then(|f| f.value.get_uint(0));
                if let (Some(w), Some(h)) = (w, h) {
                    m.width = w as i64;
                    m.height = h as i64;
                }
            }
        }
    }
    if m.width == 0 {
        if format == "heic" {
            if let Some((w, h)) = sips_dims(path) {
                m.width = w;
                m.height = h;
                // sips reports stored dimensions
            }
        } else if let Ok((w, h)) = image::image_dimensions(path) {
            m.width = w as i64;
            m.height = h as i64;
        }
        if orientation >= 5 {
            std::mem::swap(&mut m.width, &mut m.height);
        }
    } else if orientation >= 5 {
        std::mem::swap(&mut m.width, &mut m.height);
    }
    Ok(())
}

fn sips_dims(path: &Path) -> Option<(i64, i64)> {
    let out = Command::new("/usr/bin/sips").args(["-g", "pixelWidth", "-g", "pixelHeight"]).arg(path).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let mut w = None;
    let mut h = None;
    for line in s.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("pixelWidth:") {
            w = v.trim().parse().ok();
        }
        if let Some(v) = l.strip_prefix("pixelHeight:") {
            h = v.trim().parse().ok();
        }
    }
    Some((w?, h?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exposure_format() {
        assert_eq!(format_exposure(1.0 / 250.0), "1/250");
        assert_eq!(format_exposure(2.0), "2s");
        assert_eq!(format_exposure(0.5), "0.5s");
    }
    #[test]
    fn date_format() {
        assert_eq!(exif_date_to_iso("2024:05:06 07:08:09").unwrap(), "2024-05-06T07:08:09");
        assert!(exif_date_to_iso("0000:00:00 00:00:00").is_none());
    }
}
