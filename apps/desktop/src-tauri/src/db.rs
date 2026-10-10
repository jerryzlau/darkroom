//! SQLite catalog: folders, photos (files), images (a photo's master edit and
//! its virtual copies), history, snapshots, presets, collections, keywords.

use crate::error::{AppError, AppResult};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE folders (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE
    );
    CREATE TABLE photos (
        id INTEGER PRIMARY KEY,
        folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        format TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        captured_at TEXT,
        make TEXT, model TEXT, lens TEXT,
        focal_length REAL, fnumber REAL, exposure_time TEXT, iso INTEGER,
        gps_lat REAL, gps_lon REAL,
        imported_at TEXT NOT NULL,
        import_batch INTEGER NOT NULL DEFAULT 0,
        thumb_ok INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX photos_folder ON photos(folder_id);
    CREATE TABLE images (
        id INTEGER PRIMARY KEY,
        photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        copy_name TEXT,
        params TEXT,
        edited INTEGER NOT NULL DEFAULT 0,
        rating INTEGER NOT NULL DEFAULT 0,
        flag INTEGER NOT NULL DEFAULT 0,
        color_label TEXT NOT NULL DEFAULT '',
        thumb_rev INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX images_photo ON images(photo_id);
    CREATE TABLE history (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        params TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX history_image ON history(image_id);
    CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        params TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE presets (
        id INTEGER PRIMARY KEY,
        group_name TEXT NOT NULL,
        name TEXT NOT NULL,
        params TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE collections (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'manual',
        rules TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE collection_images (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, image_id)
    );
    CREATE TABLE keywords (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE photo_keywords (
        photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
        PRIMARY KEY (photo_id, keyword_id)
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2: preset metadata (description, favorite, source, updated_at)
    r#"
    ALTER TABLE presets ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE presets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE presets ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE presets ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
    UPDATE presets SET updated_at = created_at;
    "#,
];

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let v = i as i64 + 1;
        if v > version {
            conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {v}; COMMIT;"))?;
        }
    }
    Ok(())
}

pub fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub parent_id: Option<i64>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoMeta {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub file_size: i64,
    pub mtime: i64,
    pub width: i64,
    pub height: i64,
    pub captured_at: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub focal_length: Option<f64>,
    pub fnumber: Option<f64>,
    pub exposure_time: Option<String>,
    pub iso: Option<i64>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRow {
    pub id: i64,
    pub photo_id: i64,
    pub folder_id: i64,
    pub copy_name: Option<String>,
    pub edited: bool,
    pub rating: i64,
    pub flag: i64,
    pub color_label: String,
    pub thumb_rev: i64,
    pub thumb_ok: bool,
    pub missing: bool,
    pub updated_at: String,
    pub imported_at: String,
    #[serde(flatten)]
    pub meta: PhotoMeta,
}

const IMAGE_COLS: &str = "i.id, i.photo_id, p.folder_id, i.copy_name, i.edited, i.rating, i.flag, i.color_label, \
    i.thumb_rev, p.thumb_ok, p.missing, i.updated_at, p.imported_at, \
    p.path, p.filename, p.format, p.file_size, p.mtime, p.width, p.height, p.captured_at, p.make, p.model, p.lens, \
    p.focal_length, p.fnumber, p.exposure_time, p.iso, p.gps_lat, p.gps_lon";

fn image_from_row(r: &Row) -> rusqlite::Result<ImageRow> {
    Ok(ImageRow {
        id: r.get(0)?,
        photo_id: r.get(1)?,
        folder_id: r.get(2)?,
        copy_name: r.get(3)?,
        edited: r.get::<_, i64>(4)? != 0,
        rating: r.get(5)?,
        flag: r.get(6)?,
        color_label: r.get(7)?,
        thumb_rev: r.get(8)?,
        thumb_ok: r.get::<_, i64>(9)? != 0,
        missing: r.get::<_, i64>(10)? != 0,
        updated_at: r.get(11)?,
        imported_at: r.get(12)?,
        meta: PhotoMeta {
            path: r.get(13)?,
            filename: r.get(14)?,
            format: r.get(15)?,
            file_size: r.get(16)?,
            mtime: r.get(17)?,
            width: r.get(18)?,
            height: r.get(19)?,
            captured_at: r.get(20)?,
            make: r.get(21)?,
            model: r.get(22)?,
            lens: r.get(23)?,
            focal_length: r.get(24)?,
            fnumber: r.get(25)?,
            exposure_time: r.get(26)?,
            iso: r.get(27)?,
            gps_lat: r.get(28)?,
            gps_lon: r.get(29)?,
        },
    })
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/// Ensure a folder row exists for `path` and each ancestor up to `root`.
pub fn ensure_folder(conn: &Connection, path: &Path, root: &Path) -> AppResult<i64> {
    let p = path.to_string_lossy().to_string();
    if let Some(id) = conn
        .query_row("SELECT id FROM folders WHERE path = ?1", [&p], |r| r.get::<_, i64>(0))
        .optional()?
    {
        return Ok(id);
    }
    let parent_id = if path != root {
        match path.parent() {
            Some(parent) if parent.starts_with(root) => Some(ensure_folder(conn, parent, root)?),
            _ => None,
        }
    } else {
        // A root may be nested inside an existing imported folder.
        match path.parent() {
            Some(parent) => conn
                .query_row("SELECT id FROM folders WHERE path = ?1", [parent.to_string_lossy()], |r| r.get(0))
                .optional()?,
            None => None,
        }
    };
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
    conn.execute(
        "INSERT INTO folders (path, name, parent_id) VALUES (?1, ?2, ?3)",
        params![p, name, parent_id],
    )?;
    let id = conn.last_insert_rowid();
    // Adopt existing folders that are children of this new folder.
    conn.execute(
        "UPDATE folders SET parent_id = ?1 WHERE parent_id IS NULL AND id != ?1 \
         AND substr(path, 1, length(?2) + 1) = ?2 || '/' AND instr(substr(path, length(?2) + 2), '/') = 0",
        params![id, p],
    )?;
    Ok(id)
}

pub fn list_folders(conn: &Connection) -> AppResult<Vec<Folder>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.name, f.parent_id, \
         (SELECT COUNT(*) FROM images i JOIN photos p ON p.id = i.photo_id WHERE p.folder_id = f.id) \
         FROM folders f ORDER BY f.path",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Folder { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, parent_id: r.get(3)?, count: r.get(4)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn folder_and_descendants(conn: &Connection, id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id) SELECT id FROM t",
    )?;
    let ids = stmt.query_map([id], |r| r.get(0))?.collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

pub struct ExistingPhoto {
    pub id: i64,
    pub mtime: i64,
    pub file_size: i64,
}

pub fn find_photo_by_path(conn: &Connection, path: &str) -> AppResult<Option<ExistingPhoto>> {
    Ok(conn
        .query_row("SELECT id, mtime, file_size FROM photos WHERE path = ?1", [path], |r| {
            Ok(ExistingPhoto { id: r.get(0)?, mtime: r.get(1)?, file_size: r.get(2)? })
        })
        .optional()?)
}

pub fn insert_photo(conn: &Connection, folder_id: i64, m: &PhotoMeta, batch: i64) -> AppResult<(i64, i64)> {
    let now = now();
    conn.execute(
        "INSERT INTO photos (folder_id, path, filename, format, file_size, mtime, width, height, captured_at, make, model, lens, \
         focal_length, fnumber, exposure_time, iso, gps_lat, gps_lon, imported_at, import_batch) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            folder_id, m.path, m.filename, m.format, m.file_size, m.mtime, m.width, m.height, m.captured_at, m.make,
            m.model, m.lens, m.focal_length, m.fnumber, m.exposure_time, m.iso, m.gps_lat, m.gps_lon, now, batch
        ],
    )?;
    let photo_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO images (photo_id, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![photo_id, now],
    )?;
    Ok((photo_id, conn.last_insert_rowid()))
}

pub fn update_photo_meta(conn: &Connection, id: i64, m: &PhotoMeta) -> AppResult<()> {
    conn.execute(
        "UPDATE photos SET file_size=?2, mtime=?3, width=?4, height=?5, captured_at=?6, make=?7, model=?8, lens=?9, \
         focal_length=?10, fnumber=?11, exposure_time=?12, iso=?13, gps_lat=?14, gps_lon=?15, thumb_ok=0, missing=0 WHERE id=?1",
        params![
            id, m.file_size, m.mtime, m.width, m.height, m.captured_at, m.make, m.model, m.lens, m.focal_length, m.fnumber,
            m.exposure_time, m.iso, m.gps_lat, m.gps_lon
        ],
    )?;
    Ok(())
}

pub fn set_photo_dims(conn: &Connection, id: i64, w: i64, h: i64) -> AppResult<()> {
    conn.execute("UPDATE photos SET width=?2, height=?3 WHERE id=?1 AND (width != ?2 OR height != ?3)", params![id, w, h])?;
    Ok(())
}

pub fn set_thumb_ok(conn: &Connection, id: i64, ok: bool) -> AppResult<()> {
    conn.execute("UPDATE photos SET thumb_ok=?2 WHERE id=?1", params![id, ok as i64])?;
    Ok(())
}

pub fn set_missing(conn: &Connection, id: i64, missing: bool) -> AppResult<()> {
    conn.execute("UPDATE photos SET missing=?2 WHERE id=?1", params![id, missing as i64])?;
    Ok(())
}

pub fn photo_path(conn: &Connection, photo_id: i64) -> AppResult<(String, String, i64)> {
    conn.query_row("SELECT path, format, mtime FROM photos WHERE id=?1", [photo_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("photo {photo_id}")))
}

pub fn photos_in_folders(conn: &Connection, folder_ids: &[i64]) -> AppResult<Vec<(i64, String)>> {
    if folder_ids.is_empty() {
        return Ok(vec![]);
    }
    let q = format!(
        "SELECT id, path FROM photos WHERE folder_id IN ({})",
        folder_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",")
    );
    let mut stmt = conn.prepare(&q)?;
    let rows = stmt.query_map(params_from_iter(folder_ids.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn next_import_batch(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COALESCE(MAX(import_batch), 0) + 1 FROM photos", [], |r| r.get(0))?)
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageQuery {
    /// "all" | "folder" | "collection" | "lastImport" | "edited"
    pub source: String,
    pub source_id: Option<i64>,
    pub recursive: Option<bool>,
    pub min_rating: Option<i64>,
    pub rating_op: Option<String>, // ">=" | "=" | "<="
    /// "all" | "picked" | "rejected" | "unflagged" | "notRejected"
    pub flag: Option<String>,
    pub color_label: Option<String>,
    pub text: Option<String>,
    pub edited: Option<bool>,
    pub format: Option<String>,
    pub keyword: Option<String>,
    /// "captured" | "filename" | "rating" | "imported" | "edited"
    pub sort: Option<String>,
    pub desc: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartRules {
    pub min_rating: Option<i64>,
    pub rating_op: Option<String>,
    pub flag: Option<String>,
    pub color_label: Option<String>,
    pub text: Option<String>,
    pub edited: Option<bool>,
    pub format: Option<String>,
    pub keyword: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
}

pub fn list_images(conn: &Connection, q: &ImageQuery) -> AppResult<Vec<ImageRow>> {
    let mut wh: Vec<String> = vec![];
    let mut args: Vec<rusqlite::types::Value> = vec![];
    use rusqlite::types::Value as V;
    let mut extra_rules: Option<SmartRules> = None;

    match q.source.as_str() {
        "folder" => {
            let id = q.source_id.unwrap_or(-1);
            let ids = if q.recursive.unwrap_or(true) { folder_and_descendants(conn, id)? } else { vec![id] };
            wh.push(format!("p.folder_id IN ({})", ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")));
        }
        "collection" => {
            let id = q.source_id.unwrap_or(-1);
            let (kind, rules): (String, Option<String>) = conn
                .query_row("SELECT kind, rules FROM collections WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?
                .unwrap_or(("manual".into(), None));
            if kind == "smart" {
                extra_rules = rules.and_then(|r| serde_json::from_str(&r).ok());
            } else {
                wh.push("i.id IN (SELECT image_id FROM collection_images WHERE collection_id = ?)".into());
                args.push(V::Integer(id));
            }
        }
        "lastImport" => {
            wh.push("p.import_batch = (SELECT MAX(import_batch) FROM photos)".into());
        }
        _ => {}
    }

    let add_rules = |r: &SmartRules, wh: &mut Vec<String>, args: &mut Vec<V>| {
        if let Some(min) = r.min_rating {
            if min > 0 || r.rating_op.as_deref() == Some("=") {
                let op = match r.rating_op.as_deref() {
                    Some("=") => "=",
                    Some("<=") => "<=",
                    _ => ">=",
                };
                wh.push(format!("i.rating {op} ?"));
                args.push(V::Integer(min));
            }
        }
        match r.flag.as_deref() {
            Some("picked") => wh.push("i.flag = 1".into()),
            Some("rejected") => wh.push("i.flag = -1".into()),
            Some("unflagged") => wh.push("i.flag = 0".into()),
            Some("notRejected") => wh.push("i.flag != -1".into()),
            _ => {}
        }
        if let Some(c) = r.color_label.as_deref().filter(|c| !c.is_empty()) {
            if c == "none" {
                wh.push("i.color_label = ''".into());
            } else {
                wh.push("i.color_label = ?".into());
                args.push(V::Text(c.to_string()));
            }
        }
        if let Some(t) = r.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            wh.push(
                "(p.filename LIKE ? OR p.make LIKE ? OR p.model LIKE ? OR p.lens LIKE ? OR i.copy_name LIKE ? OR \
                 p.id IN (SELECT pk.photo_id FROM photo_keywords pk JOIN keywords k ON k.id = pk.keyword_id WHERE k.name LIKE ?))"
                    .into(),
            );
            let like = format!("%{t}%");
            for _ in 0..6 {
                args.push(V::Text(like.clone()));
            }
        }
        if let Some(e) = r.edited {
            wh.push(format!("i.edited = {}", e as i64));
        }
        if let Some(f) = r.format.as_deref().filter(|f| !f.is_empty() && *f != "all") {
            wh.push("p.format = ?".into());
            args.push(V::Text(f.to_string()));
        }
        if let Some(k) = r.keyword.as_deref().filter(|k| !k.is_empty()) {
            wh.push(
                "p.id IN (SELECT pk.photo_id FROM photo_keywords pk JOIN keywords k ON k.id = pk.keyword_id WHERE k.name = ?)"
                    .into(),
            );
            args.push(V::Text(k.to_string()));
        }
        if let Some(c) = r.camera.as_deref().filter(|c| !c.is_empty()) {
            wh.push("(p.make || ' ' || p.model) LIKE ?".into());
            args.push(V::Text(format!("%{c}%")));
        }
        if let Some(l) = r.lens.as_deref().filter(|l| !l.is_empty()) {
            wh.push("p.lens LIKE ?".into());
            args.push(V::Text(format!("%{l}%")));
        }
    };

    if let Some(r) = &extra_rules {
        add_rules(r, &mut wh, &mut args);
    }
    let filter = SmartRules {
        min_rating: q.min_rating,
        rating_op: q.rating_op.clone(),
        flag: q.flag.clone(),
        color_label: q.color_label.clone(),
        text: q.text.clone(),
        edited: q.edited,
        format: q.format.clone(),
        keyword: q.keyword.clone(),
        camera: None,
        lens: None,
    };
    add_rules(&filter, &mut wh, &mut args);

    let order = match q.sort.as_deref() {
        Some("filename") => "p.filename COLLATE NOCASE",
        Some("rating") => "i.rating",
        Some("imported") => "p.imported_at",
        Some("edited") => "i.updated_at",
        _ => "COALESCE(p.captured_at, p.imported_at)",
    };
    let dir = if q.desc.unwrap_or(false) { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT {IMAGE_COLS} FROM images i JOIN photos p ON p.id = i.photo_id {} ORDER BY {order} {dir}, p.filename COLLATE NOCASE {dir}, i.id",
        if wh.is_empty() { String::new() } else { format!("WHERE {}", wh.join(" AND ")) }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), image_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_image(conn: &Connection, id: i64) -> AppResult<ImageRow> {
    conn.query_row(
        &format!("SELECT {IMAGE_COLS} FROM images i JOIN photos p ON p.id = i.photo_id WHERE i.id = ?1"),
        [id],
        image_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("image {id}")))
}

pub fn get_params(conn: &Connection, image_id: i64) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT params FROM images WHERE id = ?1", [image_id], |r| r.get(0)).optional()?.flatten())
}

pub fn save_params(conn: &Connection, image_id: i64, params_json: &str, edited: bool, label: Option<&str>) -> AppResult<Option<HistoryEntry>> {
    let now = now();
    conn.execute(
        "UPDATE images SET params = ?2, edited = ?3, updated_at = ?4 WHERE id = ?1",
        params![image_id, params_json, edited as i64, now],
    )?;
    let Some(label) = label else { return Ok(None) };
    conn.execute(
        "INSERT INTO history (image_id, label, params, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![image_id, label, params_json, now],
    )?;
    let id = conn.last_insert_rowid();
    // keep the most recent 300 steps
    conn.execute(
        "DELETE FROM history WHERE image_id = ?1 AND id NOT IN (SELECT id FROM history WHERE image_id = ?1 ORDER BY id DESC LIMIT 300)",
        [image_id],
    )?;
    Ok(Some(HistoryEntry { id, label: label.to_string(), params: params_json.to_string(), created_at: now }))
}

pub fn bump_thumb_rev(conn: &Connection, image_id: i64) -> AppResult<i64> {
    conn.execute("UPDATE images SET thumb_rev = thumb_rev + 1 WHERE id = ?1", [image_id])?;
    Ok(conn.query_row("SELECT thumb_rev FROM images WHERE id = ?1", [image_id], |r| r.get(0))?)
}

pub fn reset_thumb_rev(conn: &Connection, image_id: i64) -> AppResult<()> {
    conn.execute("UPDATE images SET thumb_rev = 0 WHERE id = ?1", [image_id])?;
    Ok(())
}

fn id_list(ids: &[i64]) -> String {
    ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
}

pub fn set_rating(conn: &Connection, ids: &[i64], rating: i64) -> AppResult<()> {
    conn.execute(&format!("UPDATE images SET rating = ?1 WHERE id IN ({})", id_list(ids)), [rating.clamp(0, 5)])?;
    Ok(())
}

pub fn set_flag(conn: &Connection, ids: &[i64], flag: i64) -> AppResult<()> {
    conn.execute(&format!("UPDATE images SET flag = ?1 WHERE id IN ({})", id_list(ids)), [flag.clamp(-1, 1)])?;
    Ok(())
}

pub fn set_color_label(conn: &Connection, ids: &[i64], label: &str) -> AppResult<()> {
    conn.execute(&format!("UPDATE images SET color_label = ?1 WHERE id IN ({})", id_list(ids)), [label])?;
    Ok(())
}

pub fn create_virtual_copy(conn: &Connection, image_id: i64) -> AppResult<i64> {
    let photo_id: i64 = conn.query_row("SELECT photo_id FROM images WHERE id=?1", [image_id], |r| r.get(0))?;
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM images WHERE photo_id=?1", [photo_id], |r| r.get(0))?;
    let now = now();
    conn.execute(
        "INSERT INTO images (photo_id, copy_name, params, edited, rating, flag, color_label, created_at, updated_at) \
         SELECT photo_id, ?2, params, edited, rating, flag, color_label, ?3, ?3 FROM images WHERE id = ?1",
        params![image_id, format!("Copy {}", n), now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Remove images from the catalog. Removing a master image removes the photo
/// and all of its virtual copies. Files on disk are never touched.
pub fn remove_images(conn: &Connection, ids: &[i64]) -> AppResult<Vec<i64>> {
    let mut removed_photos = vec![];
    for &id in ids {
        let row: Option<(i64, Option<String>)> = conn
            .query_row("SELECT photo_id, copy_name FROM images WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((photo_id, copy)) = row {
            if copy.is_some() {
                conn.execute("DELETE FROM images WHERE id=?1", [id])?;
            } else {
                conn.execute("DELETE FROM photos WHERE id=?1", [photo_id])?;
                removed_photos.push(photo_id);
            }
        }
    }
    Ok(removed_photos)
}

pub fn remove_folder(conn: &Connection, id: i64) -> AppResult<Vec<i64>> {
    let ids = folder_and_descendants(conn, id)?;
    let photos: Vec<i64> = photos_in_folders(conn, &ids)?.into_iter().map(|(id, _)| id).collect();
    conn.execute(&format!("DELETE FROM folders WHERE id IN ({})", id_list(&ids)), [])?;
    Ok(photos)
}

// ---------------------------------------------------------------------------
// History & snapshots
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub label: String,
    pub params: String,
    pub created_at: String,
}

pub fn list_history(conn: &Connection, image_id: i64) -> AppResult<Vec<HistoryEntry>> {
    let mut stmt =
        conn.prepare("SELECT id, label, params, created_at FROM history WHERE image_id = ?1 ORDER BY id ASC")?;
    let rows = stmt.query_map([image_id], |r| {
        Ok(HistoryEntry { id: r.get(0)?, label: r.get(1)?, params: r.get(2)?, created_at: r.get(3)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn clear_history(conn: &Connection, image_id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM history WHERE image_id = ?1", [image_id])?;
    Ok(())
}

/// Drop history entries newer than `keep_id` (used when editing after undo).
pub fn truncate_history_after(conn: &Connection, image_id: i64, keep_id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM history WHERE image_id = ?1 AND id > ?2", params![image_id, keep_id])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: i64,
    pub name: String,
    pub params: String,
    pub created_at: String,
}

pub fn list_snapshots(conn: &Connection, image_id: i64) -> AppResult<Vec<Snapshot>> {
    let mut stmt =
        conn.prepare("SELECT id, name, params, created_at FROM snapshots WHERE image_id = ?1 ORDER BY id ASC")?;
    let rows = stmt.query_map([image_id], |r| {
        Ok(Snapshot { id: r.get(0)?, name: r.get(1)?, params: r.get(2)?, created_at: r.get(3)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn create_snapshot(conn: &Connection, image_id: i64, name: &str, params_json: &str) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO snapshots (image_id, name, params, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![image_id, name, params_json, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_snapshot(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM snapshots WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: i64,
    pub group: String,
    pub name: String,
    pub params: String,
    pub description: String,
    pub favorite: bool,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Partial update for a preset; `None` fields are left unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetPatch {
    pub group: Option<String>,
    pub name: Option<String>,
    pub params: Option<String>,
    pub description: Option<String>,
    pub favorite: Option<bool>,
}

pub fn list_presets(conn: &Connection) -> AppResult<Vec<Preset>> {
    let mut stmt = conn.prepare(
        "SELECT id, group_name, name, params, description, favorite, source, created_at, updated_at
         FROM presets ORDER BY favorite DESC, group_name, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Preset {
            id: r.get(0)?,
            group: r.get(1)?,
            name: r.get(2)?,
            params: r.get(3)?,
            description: r.get(4)?,
            favorite: r.get::<_, i64>(5)? != 0,
            source: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Upsert by (group, name). An existing preset keeps its id (and favorite flag).
pub fn save_preset(
    conn: &Connection,
    group: &str,
    name: &str,
    params_json: &str,
    description: &str,
    source: &str,
) -> AppResult<i64> {
    let ts = now();
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM presets WHERE group_name = ?1 AND name = ?2 ORDER BY id LIMIT 1",
            params![group, name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE presets SET params = ?1, description = ?2, source = ?3, updated_at = ?4 WHERE id = ?5",
            params![params_json, description, source, ts, id],
        )?;
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO presets (group_name, name, params, description, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![group, name, params_json, description, source, ts],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_preset(conn: &Connection, id: i64, p: &PresetPatch) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE presets SET
            group_name = COALESCE(?1, group_name),
            name = COALESCE(?2, name),
            params = COALESCE(?3, params),
            description = COALESCE(?4, description),
            favorite = COALESCE(?5, favorite),
            updated_at = ?6
         WHERE id = ?7",
        params![p.group, p.name, p.params, p.description, p.favorite.map(i64::from), now(), id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("preset {id}")));
    }
    Ok(())
}

pub fn delete_preset(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM presets WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub rules: Option<String>,
    pub count: i64,
}

pub fn list_collections(conn: &Connection) -> AppResult<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.kind, c.rules, (SELECT COUNT(*) FROM collection_images ci WHERE ci.collection_id = c.id) \
         FROM collections c ORDER BY c.name COLLATE NOCASE",
    )?;
    let mut rows = stmt
        .query_map([], |r| {
            Ok(Collection { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, rules: r.get(3)?, count: r.get(4)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for c in rows.iter_mut().filter(|c| c.kind == "smart") {
        let q = ImageQuery { source: "collection".into(), source_id: Some(c.id), ..Default::default() };
        c.count = list_images(conn, &q)?.len() as i64;
    }
    Ok(rows)
}

pub fn create_collection(conn: &Connection, name: &str, kind: &str, rules: Option<&str>) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO collections (name, kind, rules, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, kind, rules, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_collection(conn: &Connection, id: i64, name: &str, rules: Option<&str>) -> AppResult<()> {
    conn.execute("UPDATE collections SET name = ?2, rules = COALESCE(?3, rules) WHERE id = ?1", params![id, name, rules])?;
    Ok(())
}

pub fn delete_collection(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM collections WHERE id = ?1", [id])?;
    Ok(())
}

pub fn add_to_collection(conn: &Connection, id: i64, image_ids: &[i64]) -> AppResult<()> {
    let now = now();
    for img in image_ids {
        conn.execute(
            "INSERT OR IGNORE INTO collection_images (collection_id, image_id, added_at) VALUES (?1, ?2, ?3)",
            params![id, img, now],
        )?;
    }
    Ok(())
}

pub fn remove_from_collection(conn: &Connection, id: i64, image_ids: &[i64]) -> AppResult<()> {
    conn.execute(
        &format!("DELETE FROM collection_images WHERE collection_id = ?1 AND image_id IN ({})", id_list(image_ids)),
        [id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

pub fn photo_keywords(conn: &Connection, photo_id: i64) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT k.name FROM keywords k JOIN photo_keywords pk ON pk.keyword_id = k.id WHERE pk.photo_id = ?1 ORDER BY k.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([photo_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn all_keywords(conn: &Connection) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT k.name, COUNT(pk.photo_id) FROM keywords k LEFT JOIN photo_keywords pk ON pk.keyword_id = k.id \
         GROUP BY k.id HAVING COUNT(pk.photo_id) > 0 ORDER BY k.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn add_keywords(conn: &Connection, photo_ids: &[i64], names: &[String]) -> AppResult<()> {
    for name in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        conn.execute("INSERT OR IGNORE INTO keywords (name) VALUES (?1)", [name])?;
        let kid: i64 = conn.query_row("SELECT id FROM keywords WHERE name = ?1", [name], |r| r.get(0))?;
        for pid in photo_ids {
            conn.execute("INSERT OR IGNORE INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![pid, kid])?;
        }
    }
    Ok(())
}

pub fn remove_keyword(conn: &Connection, photo_ids: &[i64], name: &str) -> AppResult<()> {
    conn.execute(
        &format!(
            "DELETE FROM photo_keywords WHERE photo_id IN ({}) AND keyword_id = (SELECT id FROM keywords WHERE name = ?1)",
            id_list(photo_ids)
        ),
        [name],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Copy the catalog to `dir/catalog-YYYY-MM-DD.sqlite` once a day, keeping the newest `keep`.
pub fn daily_backup(conn: &Connection, dir: &Path, keep: usize) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let name = format!("catalog-{}.sqlite", chrono::Local::now().format("%Y-%m-%d"));
    let target = dir.join(&name);
    if target.exists() {
        return Ok(());
    }
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy()])?;
    let mut backups: Vec<_> = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("catalog-")).unwrap_or(false))
        .collect();
    backups.sort();
    while backups.len() > keep {
        let _ = std::fs::remove_file(backups.remove(0));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(path: &str) -> PhotoMeta {
        PhotoMeta {
            path: path.into(),
            filename: Path::new(path).file_name().unwrap().to_string_lossy().into(),
            format: "jpeg".into(),
            width: 100,
            height: 50,
            ..Default::default()
        }
    }

    #[test]
    fn presets_v2_columns() {
        let c = open_in_memory().unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
        let id = save_preset(&c, "G", "N", "{}", "desc", "ai").unwrap();
        let p = list_presets(&c).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].id, id);
        assert_eq!(p[0].description, "desc");
        assert!(!p[0].favorite);
        assert_eq!(p[0].source, "ai");
        assert!(!p[0].updated_at.is_empty());
        assert_eq!(p[0].created_at, p[0].updated_at);
    }

    #[test]
    fn v1_catalog_migrates() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(&format!("{}; PRAGMA user_version = 1;", MIGRATIONS[0])).unwrap();
        c.execute(
            "INSERT INTO presets (group_name, name, params, created_at) VALUES ('G', 'N', '{}', '2024-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();
        migrate(&c).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        let p = list_presets(&c).unwrap();
        assert_eq!(p[0].description, "");
        assert_eq!(p[0].source, "user");
        assert!(!p[0].favorite);
        assert_eq!(p[0].updated_at, p[0].created_at);
        assert_eq!(p[0].updated_at, "2024-01-01T00:00:00+00:00");
    }

    #[test]
    fn save_preset_keeps_id() {
        let c = open_in_memory().unwrap();
        let a = save_preset(&c, "G", "N", r#"{"exposure":1}"#, "", "user").unwrap();
        let b = save_preset(&c, "G", "N", r#"{"exposure":2}"#, "new", "ai").unwrap();
        assert_eq!(a, b);
        let p = list_presets(&c).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].params, r#"{"exposure":2}"#);
        assert_eq!(p[0].description, "new");
        assert_eq!(p[0].source, "ai");
        // a different name is a different preset
        let other = save_preset(&c, "G", "M", "{}", "", "user").unwrap();
        assert_ne!(other, a);
    }

    #[test]
    fn update_preset_partial() {
        let c = open_in_memory().unwrap();
        let id = save_preset(&c, "G", "N", "{}", "d", "user").unwrap();
        // force a known old timestamp so the bump is observable
        c.execute("UPDATE presets SET updated_at = 'old' WHERE id = ?1", [id]).unwrap();
        update_preset(&c, id, &PresetPatch { favorite: Some(true), ..Default::default() }).unwrap();
        let p = &list_presets(&c).unwrap()[0];
        assert_eq!(p.name, "N");
        assert_eq!(p.group, "G");
        assert_eq!(p.description, "d");
        assert!(p.favorite);
        assert_ne!(p.updated_at, "old");
        update_preset(&c, id, &PresetPatch { name: Some("Renamed".into()), favorite: Some(false), ..Default::default() })
            .unwrap();
        let p = &list_presets(&c).unwrap()[0];
        assert_eq!((p.id, p.name.as_str(), p.favorite), (id, "Renamed", false));
        assert!(update_preset(&c, id + 999, &PresetPatch::default()).is_err());
    }

    #[test]
    fn folder_adoption_is_literal() {
        let c = open_in_memory().unwrap();
        ensure_folder(&c, Path::new("/x/2024-01/sub"), Path::new("/x/2024-01/sub")).unwrap();
        ensure_folder(&c, Path::new("/x/2024_01"), Path::new("/x/2024_01")).unwrap();
        let f = list_folders(&c).unwrap();
        let sub = f.iter().find(|x| x.path == "/x/2024-01/sub").unwrap();
        assert_eq!(sub.parent_id, None, "underscore must not match as a wildcard");
        // a real parent still adopts its child
        let parent = ensure_folder(&c, Path::new("/x/2024-01"), Path::new("/x/2024-01")).unwrap();
        let f = list_folders(&c).unwrap();
        assert_eq!(f.iter().find(|x| x.path == "/x/2024-01/sub").unwrap().parent_id, Some(parent));
    }

    #[test]
    fn backups_rotate() {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("catalog.sqlite")).unwrap();
        let b = dir.path().join("backups");
        for i in 0..9 {
            std::fs::create_dir_all(&b).unwrap();
            std::fs::write(b.join(format!("catalog-2020-01-0{i}.sqlite")), b"x").unwrap();
        }
        daily_backup(&c, &b, 7).unwrap();
        let n = std::fs::read_dir(&b).unwrap().count();
        assert_eq!(n, 7);
        let today = b.join(format!("catalog-{}.sqlite", chrono::Local::now().format("%Y-%m-%d")));
        assert!(today.exists());
        assert!(open(&today).is_ok());
    }

    #[test]
    fn folders_nest_and_count() {
        let c = open_in_memory().unwrap();
        let root = Path::new("/photos");
        let f = ensure_folder(&c, Path::new("/photos/2024/trip"), root).unwrap();
        let folders = list_folders(&c).unwrap();
        assert_eq!(folders.len(), 3);
        let trip = folders.iter().find(|x| x.id == f).unwrap();
        assert!(trip.parent_id.is_some());
        insert_photo(&c, f, &meta("/photos/2024/trip/a.jpg"), 1).unwrap();
        let root_id = folders.iter().find(|x| x.path == "/photos").unwrap().id;
        let q = ImageQuery { source: "folder".into(), source_id: Some(root_id), recursive: Some(true), ..Default::default() };
        assert_eq!(list_images(&c, &q).unwrap().len(), 1);
        let q2 = ImageQuery { recursive: Some(false), ..q };
        assert_eq!(list_images(&c, &q2).unwrap().len(), 0);
    }

    #[test]
    fn filters_and_virtual_copies() {
        let c = open_in_memory().unwrap();
        let f = ensure_folder(&c, Path::new("/p"), Path::new("/p")).unwrap();
        let (_, a) = insert_photo(&c, f, &meta("/p/a.jpg"), 1).unwrap();
        let (_, b) = insert_photo(&c, f, &meta("/p/b.jpg"), 1).unwrap();
        set_rating(&c, &[a], 4).unwrap();
        set_flag(&c, &[b], -1).unwrap();
        set_color_label(&c, &[a], "red").unwrap();
        let all = ImageQuery { source: "all".into(), ..Default::default() };
        assert_eq!(list_images(&c, &all).unwrap().len(), 2);
        let q = ImageQuery { min_rating: Some(3), ..all.clone() };
        assert_eq!(list_images(&c, &q).unwrap()[0].id, a);
        let q = ImageQuery { flag: Some("notRejected".into()), ..all.clone() };
        assert_eq!(list_images(&c, &q).unwrap().len(), 1);
        let q = ImageQuery { color_label: Some("red".into()), ..all.clone() };
        assert_eq!(list_images(&c, &q).unwrap().len(), 1);
        let vc = create_virtual_copy(&c, a).unwrap();
        assert_eq!(get_image(&c, vc).unwrap().rating, 4);
        assert_eq!(list_images(&c, &all).unwrap().len(), 3);
        remove_images(&c, &[vc]).unwrap();
        assert_eq!(list_images(&c, &all).unwrap().len(), 2);
        remove_images(&c, &[a]).unwrap();
        assert_eq!(list_images(&c, &all).unwrap().len(), 1);
    }

    #[test]
    fn history_and_collections() {
        let c = open_in_memory().unwrap();
        let f = ensure_folder(&c, Path::new("/p"), Path::new("/p")).unwrap();
        let (pid, a) = insert_photo(&c, f, &meta("/p/a.jpg"), 1).unwrap();
        let h1 = save_params(&c, a, "{\"exposure\":1}", true, Some("Exposure")).unwrap().unwrap();
        save_params(&c, a, "{\"exposure\":2}", true, Some("Exposure")).unwrap();
        assert_eq!(list_history(&c, a).unwrap().len(), 2);
        truncate_history_after(&c, a, h1.id).unwrap();
        assert_eq!(list_history(&c, a).unwrap().len(), 1);
        assert_eq!(get_params(&c, a).unwrap().unwrap(), "{\"exposure\":2}");

        let col = create_collection(&c, "Best", "manual", None).unwrap();
        add_to_collection(&c, col, &[a]).unwrap();
        let q = ImageQuery { source: "collection".into(), source_id: Some(col), ..Default::default() };
        assert_eq!(list_images(&c, &q).unwrap().len(), 1);

        add_keywords(&c, &[pid], &["beach".into(), "sunset".into()]).unwrap();
        assert_eq!(photo_keywords(&c, pid).unwrap(), vec!["beach", "sunset"]);
        let smart = create_collection(&c, "Beach", "smart", Some("{\"keyword\":\"beach\"}")).unwrap();
        let q = ImageQuery { source: "collection".into(), source_id: Some(smart), ..Default::default() };
        assert_eq!(list_images(&c, &q).unwrap().len(), 1);
        remove_keyword(&c, &[pid], "beach").unwrap();
        assert_eq!(list_images(&c, &q).unwrap().len(), 0);
    }
}
