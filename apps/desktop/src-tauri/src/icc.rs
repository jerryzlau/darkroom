//! ICC profiles embedded in exported files.

use lcms2::{CIExyY, CIExyYTRIPLE, Locale, Profile, Tag, TagSignature, ToneCurve, MLU};
use std::sync::OnceLock;

fn xy(x: f64, y: f64) -> CIExyY {
    CIExyY { x, y, Y: 1.0 }
}

fn build(desc: &str, white: CIExyY, prim: CIExyYTRIPLE, curve: ToneCurve) -> Vec<u8> {
    let mut p = Profile::new_rgb(&white, &prim, &[&curve, &curve, &curve]).expect("icc profile");
    p.remove_tag(TagSignature::ProfileDescriptionTag);
    let mut mlu = MLU::new(1);
    mlu.set_text(desc, Locale::none());
    p.write_tag(TagSignature::ProfileDescriptionTag, Tag::MLU(&mlu));
    p.icc().expect("icc serialize")
}

fn srgb_curve() -> ToneCurve {
    // IEC 61966-2-1 parametric type 4
    ToneCurve::new_parametric(4, &[2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045]).expect("curve")
}

pub fn profile(space: &str) -> &'static [u8] {
    static SRGB: OnceLock<Vec<u8>> = OnceLock::new();
    static P3: OnceLock<Vec<u8>> = OnceLock::new();
    static PRO: OnceLock<Vec<u8>> = OnceLock::new();
    let d65 = xy(0.3127, 0.3290);
    match space {
        "p3" => P3.get_or_init(|| {
            build(
                "Display P3",
                d65,
                CIExyYTRIPLE { Red: xy(0.680, 0.320), Green: xy(0.265, 0.690), Blue: xy(0.150, 0.060) },
                srgb_curve(),
            )
        }),
        "prophoto" => PRO.get_or_init(|| {
            build(
                "ProPhoto RGB",
                xy(0.3457, 0.3585),
                CIExyYTRIPLE { Red: xy(0.7347, 0.2653), Green: xy(0.1596, 0.8404), Blue: xy(0.0366, 0.0001) },
                ToneCurve::new(1.8),
            )
        }),
        _ => SRGB.get_or_init(|| {
            build(
                "sRGB IEC61966-2.1",
                d65,
                CIExyYTRIPLE { Red: xy(0.64, 0.33), Green: xy(0.30, 0.60), Blue: xy(0.15, 0.06) },
                srgb_curve(),
            )
        }),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn profiles_build() {
        for s in ["srgb", "p3", "prophoto"] {
            let p = super::profile(s);
            assert!(p.len() > 300);
            assert_eq!(&p[36..40], b"acsp");
        }
    }
}
