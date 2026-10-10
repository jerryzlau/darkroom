pub mod commands;
pub mod db;
pub mod decode;
pub mod error;
pub mod export;
pub mod icc;
pub mod import;
pub mod logger;
pub mod metadata;
pub mod samples;
pub mod source;
pub mod state;
pub mod thumbs;
pub mod xmp;

use state::AppState;
use tauri::http::{header, Response, StatusCode};
use tauri::Manager;

/// Serve thumbnails at thumb://localhost/<image_id>?rev=<n>
fn serve_thumb(app: &tauri::AppHandle, uri: &str) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    let path = uri.split('?').next().unwrap_or("");
    let Some(id) = path.rsplit('/').next().and_then(|s| s.parse::<i64>().ok()) else { return not_found() };
    let state = app.state::<AppState>();
    let row = match db::get_image(&state.db.lock(), id) {
        Ok(r) => r,
        Err(_) => return not_found(),
    };
    let edit = thumbs::edit_thumb_path(&state.cache_dir, id);
    let file = if row.thumb_rev > 0 && edit.exists() {
        edit
    } else {
        let p = thumbs::thumb_path(&state.cache_dir, row.photo_id);
        if !p.exists() {
            if let Err(e) = thumbs::generate(&state.cache_dir, row.photo_id, std::path::Path::new(&row.meta.path), &row.meta.format) {
                log::warn!("thumb {}: {e}", row.meta.path);
                return not_found();
            }
            let _ = db::set_thumb_ok(&state.db.lock(), row.photo_id, true);
        }
        p
    };
    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap(),
        Err(_) => not_found(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let uri = request.uri().to_string();
            rayon::spawn(move || responder.respond(serve_thumb(&app, &uri)));
        })
        .setup(|app| {
            // DARKROOM_DATA_DIR isolates the catalog and caches (used by the self-test).
            let (data, cache) = match std::env::var("DARKROOM_DATA_DIR") {
                Ok(d) if !d.is_empty() => {
                    let d = std::path::PathBuf::from(d);
                    (d.clone(), d.join("cache"))
                }
                _ => (app.path().app_data_dir()?, app.path().app_cache_dir()?),
            };
            logger::init(&data);
            log::info!("Darkroom starting; data dir {}", data.display());
            let state = AppState::new(data, cache.clone())?;
            app.manage(state);
            std::thread::spawn(move || source::trim_preview_cache(&cache, 6 * 1024 * 1024 * 1024));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_folders,
            commands::list_collections,
            commands::list_images,
            commands::get_image,
            commands::save_params,
            commands::list_history,
            commands::clear_history,
            commands::list_snapshots,
            commands::create_snapshot,
            commands::delete_snapshot,
            commands::list_presets,
            commands::save_preset,
            commands::update_preset,
            commands::delete_preset,
            commands::create_collection,
            commands::update_collection,
            commands::delete_collection,
            commands::add_to_collection,
            commands::remove_from_collection,
            commands::set_rating,
            commands::set_flag,
            commands::set_color_label,
            commands::get_keywords,
            commands::all_keywords,
            commands::add_keywords,
            commands::remove_keyword,
            commands::create_virtual_copy,
            commands::remove_images,
            commands::remove_folder,
            commands::import_paths,
            commands::rescan_folder,
            commands::get_setting,
            commands::set_setting,
            commands::write_sidecars,
            commands::reveal_in_finder,
            commands::app_info,
            commands::log_frontend,
            commands::get_preview,
            commands::get_region,
            commands::save_edit_thumb,
            commands::reset_edit_thumb,
            commands::export_begin,
            commands::export_tile,
            commands::export_finish,
            commands::export_cancel,
            commands::selftest_config,
            commands::exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Darkroom");
}
