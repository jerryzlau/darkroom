//! End-to-end backend tests on synthetic files: raw decode, orientation,
//! import, thumbnails, previews, regions.

use darkroom_lib::{db, decode, import, samples, source, state::AppState};
use std::path::Path;

const W: usize = 600;
const H: usize = 400;

fn chart_patch_mean(img: &decode::SourceImage, idx: usize) -> [f64; 3] {
    let (cx, cy, s) = samples::chart_layout(W, H);
    let col = idx % 6;
    let row = idx / 6;
    let (x0, y0) = (cx + col * s + s / 3, cy + row * s + s / 3);
    let mut acc = [0.0; 3];
    let mut n = 0.0;
    for y in y0..y0 + s / 3 {
        for x in x0..x0 + s / 3 {
            for c in 0..3 {
                acc[c] += img.data[(y * img.width + x) * 3 + c] as f64 / 65535.0;
            }
            n += 1.0;
        }
    }
    acc.map(|v| v / n)
}

#[test]
fn raw_decode_white_balance_and_orientation() {
    let dir = tempfile::tempdir().unwrap();
    let set = samples::generate(dir.path(), W, H).unwrap();

    let day = decode::decode_raw(&set.dng_daylight).unwrap();
    assert_eq!((day.width, day.height), (W, H));
    assert!(day.color.is_raw);
    // white patch (index 18) becomes neutral after as-shot multipliers
    let wp = chart_patch_mean(&day, 18);
    let m = day.color.as_shot_mul;
    let bal = [wp[0] * m[0] as f64, wp[1] * m[1] as f64, wp[2] * m[2] as f64];
    assert!((bal[0] / bal[1] - 1.0).abs() < 0.04, "{bal:?}");
    assert!((bal[2] / bal[1] - 1.0).abs() < 0.04, "{bal:?}");
    // diffuse white sits around 38% of the raw range
    assert!(bal[1] > 0.25 && bal[1] < 0.5, "{bal:?}");

    let tung = decode::decode_raw(&set.dng_tungsten).unwrap();
    // stored rotated, orientation 6 brings it back to landscape
    assert_eq!((tung.width, tung.height), (W, H));
    let tm = tung.color.as_shot_mul;
    assert!(tm[2] > m[2] * 1.4, "tungsten should need more blue gain: {tm:?} vs {m:?}");
    let wp = chart_patch_mean(&tung, 18);
    let bal = [wp[0] * tm[0] as f64, wp[1], wp[2] * tm[2] as f64];
    assert!((bal[0] / bal[1] - 1.0).abs() < 0.05, "{bal:?}");
    assert!((bal[2] / bal[1] - 1.0).abs() < 0.05, "{bal:?}");

    let jr = decode::decode_raster(&set.jpeg_rotated).unwrap();
    assert_eq!((jr.width, jr.height), (W, H));
    let j = decode::decode_raster(&set.jpeg).unwrap();
    // rotated JPEG matches the upright one after orientation
    let a = chart_patch_mean(&j, 14);
    let b = chart_patch_mean(&jr, 14);
    for c in 0..3 {
        assert!((a[c] - b[c]).abs() < 0.02, "{a:?} {b:?}");
    }
    if let Some(heic) = &set.heic {
        let hi = decode::decode_file(heic, "heic").unwrap();
        assert_eq!((hi.width, hi.height), (W, H));
    }
}

#[test]
fn import_thumbnails_previews_regions() {
    let dir = tempfile::tempdir().unwrap();
    let photos = dir.path().join("photos");
    let set = samples::generate(&photos.join("trip"), W, H).unwrap();
    let state = AppState::new(dir.path().join("data"), dir.path().join("cache")).unwrap();
    let noop = |_p: import::ImportProgress| {};
    let (summary, thumbs) = import::import_paths(&state, &[photos.clone()], &noop).unwrap();
    let expected = 5 + set.heic.is_some() as usize;
    assert_eq!(summary.added, expected, "{summary:?}");
    assert!(summary.errors.is_empty(), "{summary:?}");
    assert_eq!(thumbs.len(), expected, "{summary:?}");

    let rows = db::list_images(&state.db.lock(), &db::ImageQuery { source: "all".into(), ..Default::default() }).unwrap();
    assert_eq!(rows.len(), expected);
    let dng = rows.iter().find(|r| r.meta.filename == "synthetic-tungsten-portrait.dng").unwrap();
    assert_eq!(dng.meta.format, "raw");
    assert_eq!(dng.meta.make.as_deref(), Some("Darkroom"));
    assert!(Path::new(&darkroom_lib::thumbs::thumb_path(&state.cache_dir, dng.photo_id)).exists());
    let rotated = rows.iter().find(|r| r.meta.filename == "synthetic-rotated.jpg").unwrap();
    assert_eq!((rotated.meta.width, rotated.meta.height), (W as i64, H as i64));
    let thumb = image::open(darkroom_lib::thumbs::thumb_path(&state.cache_dir, rotated.photo_id)).unwrap();
    assert!(thumb.width() > thumb.height(), "rotated JPEG thumbnail should be upright");

    // folders: photos/trip nested under the imported root
    let folders = db::list_folders(&state.db.lock()).unwrap();
    assert!(folders.iter().any(|f| f.path.ends_with("trip") && f.parent_id.is_some()));

    // preview: header + data, and a cached second read
    let f = state.photo_file(dng.photo_id).unwrap();
    let (bytes, dims) = source::preview(&state.cache_dir, &state.sources, &f).unwrap();
    assert_eq!(dims, Some((W, H)));
    let hlen = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let header: serde_json::Value = serde_json::from_slice(bytes[4..4 + hlen].trim_ascii_end()).unwrap();
    assert_eq!(header["previewWidth"], W);
    assert_eq!(bytes.len(), 4 + hlen + W * H * 6);
    let (bytes2, dims2) = source::preview(&state.cache_dir, &state.sources, &f).unwrap();
    assert!(dims2.is_none(), "second read should hit the disk cache");
    assert_eq!(bytes, bytes2);

    // region: exact crop and a downscaled region
    let r = source::region(&state.sources, &f, 10.0, 20.0, 100.0, 50.0, 100, 50).unwrap();
    assert_eq!(r.len(), 8 + 100 * 50 * 6);
    let r = source::region(&state.sources, &f, 0.0, 0.0, W as f64, H as f64, 150, 100).unwrap();
    assert_eq!(u32::from_le_bytes(r[0..4].try_into().unwrap()), 150);

    // re-import is idempotent
    let (again, _) = import::import_paths(&state, &[photos], &noop).unwrap();
    assert_eq!(again.added, 0);
    assert_eq!(again.unchanged, expected);
}

#[test]
fn sidecar_restores_edits_after_catalog_loss() {
    use darkroom_lib::xmp;
    let dir = tempfile::tempdir().unwrap();
    let photos = dir.path().join("photos");
    samples::generate(&photos, 300, 200).unwrap();
    let noop = |_p: import::ImportProgress| {};
    let params = r#"{"version":1,"exposure":1.25,"contrast":30}"#;
    {
        let state = AppState::new(dir.path().join("data1"), dir.path().join("cache1")).unwrap();
        import::import_paths(&state, &[photos.clone()], &noop).unwrap();
        let conn = state.db.lock();
        let rows = db::list_images(&conn, &db::ImageQuery { source: "all".into(), ..Default::default() }).unwrap();
        let img = rows.iter().find(|r| r.meta.filename == "synthetic-daylight.dng").unwrap();
        db::save_params(&conn, img.id, params, true, Some("Edit")).unwrap();
        db::set_rating(&conn, &[img.id], 5).unwrap();
        db::set_color_label(&conn, &[img.id], "green").unwrap();
        db::add_keywords(&conn, &[img.photo_id], &["iceland".into()]).unwrap();
        let path = img.meta.path.clone();
        xmp::write(
            Path::new(&path),
            &xmp::SidecarData { rating: 5, label: "green".into(), keywords: db::photo_keywords(&conn, img.photo_id).unwrap(), params: db::get_params(&conn, img.id).unwrap() },
        )
        .unwrap();
    }
    // a brand-new catalog imports the same folder and picks the sidecar up
    let state = AppState::new(dir.path().join("data2"), dir.path().join("cache2")).unwrap();
    import::import_paths(&state, &[photos], &noop).unwrap();
    let conn = state.db.lock();
    let rows = db::list_images(&conn, &db::ImageQuery { source: "all".into(), ..Default::default() }).unwrap();
    let img = rows.iter().find(|r| r.meta.filename == "synthetic-daylight.dng").unwrap();
    assert_eq!(img.rating, 5);
    assert_eq!(img.color_label, "green");
    assert!(img.edited);
    assert_eq!(db::get_params(&conn, img.id).unwrap().as_deref(), Some(params));
    assert_eq!(db::photo_keywords(&conn, img.photo_id).unwrap(), vec!["iceland"]);
    // other photos are untouched
    assert!(rows.iter().filter(|r| r.id != img.id).all(|r| !r.edited && r.rating == 0));
}
