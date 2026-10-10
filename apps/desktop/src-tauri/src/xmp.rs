//! XMP sidecars: `<file>.xmp` next to the original, carrying rating, label,
//! keywords and the full Darkroom edit so edits survive catalog loss.

use crate::error::AppResult;
use std::path::{Path, PathBuf};

pub fn sidecar_path(photo_path: &Path) -> PathBuf {
    let mut s = photo_path.as_os_str().to_owned();
    s.push(".xmp");
    PathBuf::from(s)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn unesc(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

pub struct SidecarData {
    pub rating: i64,
    pub label: String,
    pub keywords: Vec<String>,
    pub params: Option<String>,
}

fn label_name(l: &str) -> &str {
    match l {
        "red" => "Red",
        "yellow" => "Yellow",
        "green" => "Green",
        "blue" => "Blue",
        "purple" => "Purple",
        _ => "",
    }
}

pub fn write(photo_path: &Path, d: &SidecarData) -> AppResult<PathBuf> {
    let kw = if d.keywords.is_empty() {
        String::new()
    } else {
        format!(
            "   <dc:subject>\n    <rdf:Bag>\n{}    </rdf:Bag>\n   </dc:subject>\n",
            d.keywords.iter().map(|k| format!("     <rdf:li>{}</rdf:li>\n", esc(k))).collect::<String>()
        )
    };
    let params = d.params.as_deref().map(|p| format!("\n    darkroom:Params=\"{}\"", esc(p))).unwrap_or_default();
    let xml = format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Darkroom">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:darkroom="https://darkroom.app/ns/1.0/"
    xmp:Rating="{}"
    xmp:Label="{}"{}>
{}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#,
        d.rating,
        label_name(&d.label),
        params,
        kw
    );
    let out = sidecar_path(photo_path);
    std::fs::write(&out, xml)?;
    Ok(out)
}

fn attr(xml: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = xml.find(&key)? + key.len();
    let end = xml[start..].find('"')? + start;
    Some(unesc(&xml[start..end]))
}

pub fn read(photo_path: &Path) -> Option<SidecarData> {
    let xml = std::fs::read_to_string(sidecar_path(photo_path)).ok()?;
    let rating = attr(&xml, "xmp:Rating").and_then(|r| r.parse().ok()).unwrap_or(0);
    let label = attr(&xml, "xmp:Label").map(|l| l.to_ascii_lowercase()).unwrap_or_default();
    let params = attr(&xml, "darkroom:Params");
    let mut keywords = vec![];
    if let Some(s) = xml.find("<dc:subject>") {
        if let Some(e) = xml[s..].find("</dc:subject>") {
            for part in xml[s..s + e].split("<rdf:li>").skip(1) {
                if let Some(end) = part.find("</rdf:li>") {
                    keywords.push(unesc(&part[..end]));
                }
            }
        }
    }
    Some(SidecarData { rating, label, keywords, params })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("a.jpg");
        let d = SidecarData {
            rating: 4,
            label: "red".into(),
            keywords: vec!["beach".into(), "a&b".into()],
            params: Some("{\"exposure\":1.5,\"name\":\"<x>\"}".into()),
        };
        write(&photo, &d).unwrap();
        let r = read(&photo).unwrap();
        assert_eq!(r.rating, 4);
        assert_eq!(r.label, "red");
        assert_eq!(r.keywords, vec!["beach", "a&b"]);
        assert_eq!(r.params.unwrap(), "{\"exposure\":1.5,\"name\":\"<x>\"}");
    }
}
