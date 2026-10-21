//! Mask surfaces (`brush` / `subject` / `sky`; `docs/local-adjustments.md`
//! "面の受け渡し", Epic #31 M4 = #68) through a Session: the store's checks
//! (`maskSurfaceInvalid`), a surface the settings need but the Session does
//! not hold (`maskSurfaceMissing`) or of another size
//! (`maskSurfaceMismatch`), the surface spread over the working image and
//! following the geometry, a brush mask blended with a linear one as the
//! independent frames and planes say, and settings without surface masks
//! drawn exactly as before.

use niho_develop::local_render::{self, SourceMap};
use niho_develop::mask_surface::{self, MaskSurface, SurfaceError};
use niho_develop::{
    encode, export_png, render, DevelopSettings, Error, Filter, Quality, RenderOptions, Session,
};
use serde_json::{json, Value};

fn photo_png(w: usize, h: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = (
                (30 + x * 180 / w) as u8,
                (40 + y * 150 / h) as u8,
                ((x + y) * 90 / (w + h) + 50) as u8,
            );
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

/// A surface PNG of `value(x, y)` and its id.
fn surface(w: u32, h: u32, value: impl Fn(u32, u32) -> u8) -> (String, Vec<u8>, MaskSurface) {
    let data = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| value(x, y));
    let surface = MaskSurface::new(w, h, data.collect()).unwrap();
    let png = mask_surface::encode_surface_png(&surface).unwrap();
    (mask_surface::surface_id(&png), png, surface)
}

/// The left half painted (60 x 40 over a 120 x 80 photo: output columns
/// 0..=58 are fully in, 61.. fully out).
fn left_half() -> (String, Vec<u8>, MaskSurface) {
    surface(60, 40, |x, _| if x < 30 { 255 } else { 0 })
}

fn base() -> Value {
    json!({"v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null, "shadows": 20})
}

fn settings(extra: Value) -> DevelopSettings {
    let mut v = base();
    for (k, value) in extra.as_object().unwrap() {
        v[k] = value.clone();
    }
    DevelopSettings::from_value(&v).unwrap()
}

fn brush(id: &str, surface_id: &str, w: u32, h: u32, adjust: Value) -> Value {
    json!({
        "id": id, "kind": "brush",
        "surface": {"id": surface_id, "width": w, "height": h},
        "adjust": adjust
    })
}

fn open(png: &[u8]) -> Session {
    Session::open_raster(png, 0, Filter::Lanczos3).unwrap()
}

#[test]
fn the_store_takes_only_the_surface_its_id_names() {
    let photo = photo_png(40, 30);
    let mut session = open(&photo);
    let (id, png, _) = left_half();
    let invalid = |error: Error| {
        assert!(
            error.to_string().starts_with("maskSurfaceInvalid"),
            "{error}"
        );
        match error {
            Error::MaskSurfaceInvalid { reason, .. } => reason,
            other => panic!("{other}"),
        }
    };
    // Another sha256, a bad id, too many bytes, not a PNG, not 8-bit gray.
    let wrong = "0".repeat(64);
    assert!(matches!(
        invalid(session.set_mask_surface(&wrong, &png).unwrap_err()),
        SurfaceError::HashMismatch { actual } if actual == id
    ));
    assert_eq!(
        invalid(
            session
                .set_mask_surface(&id.to_uppercase(), &png)
                .unwrap_err()
        ),
        SurfaceError::InvalidId
    );
    let large = vec![0u8; mask_surface::MAX_SURFACE_PNG_BYTES + 1];
    assert!(matches!(
        invalid(
            session
                .set_mask_surface(&mask_surface::surface_id(&large), &large)
                .unwrap_err()
        ),
        SurfaceError::TooLarge { .. }
    ));
    let rgb = photo_png(4, 4);
    assert!(matches!(
        invalid(
            session
                .set_mask_surface(&mask_surface::surface_id(&rgb), &rgb)
                .unwrap_err()
        ),
        SurfaceError::Format { .. }
    ));
    assert!(session.mask_surface_ids().is_empty(), "nothing was kept");
    session.set_mask_surface(&id, &png).unwrap();
    assert!(session.has_mask_surface(&id));
    // Again: only the bytes are checked against the id.
    session.set_mask_surface(&id, &png).unwrap();
    let mut other = png.clone();
    other.push(0);
    assert!(matches!(
        invalid(session.set_mask_surface(&id, &other).unwrap_err()),
        SurfaceError::HashMismatch { .. }
    ));
    assert_eq!(session.mask_surface_ids(), vec![id.clone()]);
    assert!(session.drop_mask_surface(&id));
    assert!(!session.drop_mask_surface(&id));
    assert!(!session.has_mask_surface(&id));
}

#[test]
fn a_surface_mask_whose_delta_is_clamped_away_needs_no_surface() {
    // Global exposure 5 with a local +1 stays 5: the layer is not drawn
    // (`render_layers`), so its missing surface is not an error and the frame
    // is the global one.
    let photo = photo_png(120, 80);
    let (id, _, _) = left_half();
    let clamped = settings(json!({
        "exposure": 5.0,
        "masks": [brush("b", &id, 60, 40, json!({"exposure": 1}))]
    }));
    let global = settings(json!({ "exposure": 5.0 }));
    let mut session = open(&photo);
    let frame = session.render(&clamped, 0, Quality::Final).unwrap();
    let plain = open(&photo).render(&global, 0, Quality::Final).unwrap();
    assert_eq!(frame.rgba, plain.rgba);
    // A delta that does change the settings still needs it.
    let drawn = settings(json!({
        "exposure": 4.5,
        "masks": [brush("b", &id, 60, 40, json!({"exposure": 1}))]
    }));
    assert!(session
        .render(&drawn, 0, Quality::Final)
        .unwrap_err()
        .to_string()
        .starts_with("maskSurfaceMissing"));
}

#[test]
fn a_surface_mask_needs_its_surface_of_its_size() {
    let photo = photo_png(120, 80);
    let (id, png, _) = left_half();
    let s = settings(json!({ "masks": [brush("b", &id, 60, 40, json!({"exposure": -1}))] }));
    let wrong_size =
        settings(json!({ "masks": [brush("b", &id, 60, 41, json!({"exposure": -1}))] }));
    let mut session = open(&photo);
    let missing = |error: Error| {
        assert!(
            matches!(&error, Error::MaskSurfaceMissing(m) if m == "b"),
            "{error}"
        );
        assert!(error.to_string().starts_with("maskSurfaceMissing"));
    };
    missing(session.render(&s, 0, Quality::Final).unwrap_err());
    missing(session.mask_plane(&s, "b", 0).unwrap_err());
    session.set_mask_surface(&id, &png).unwrap();
    let frame = session.render(&s, 0, Quality::Final).unwrap();
    assert_eq!((frame.width, frame.height), (120, 80));
    let (w, h, plane) = session.mask_plane(&s, "b", 0).unwrap();
    assert_eq!((w, h), (120, 80));
    assert_eq!((plane[0], plane[119]), (255, 0));
    for error in [
        session
            .render(&wrong_size, 0, Quality::Interactive)
            .unwrap_err(),
        session.mask_plane(&wrong_size, "b", 0).unwrap_err(),
    ] {
        assert!(
            error.to_string().starts_with("maskSurfaceMismatch"),
            "{error}"
        );
        assert!(matches!(
            error,
            Error::MaskSurfaceMismatch { ref mask, expected: (60, 41), actual: (60, 40), .. }
                if mask == "b"
        ));
    }
    // Dropped: missing again, at every quality.
    session.drop_mask_surface(&id);
    for quality in [Quality::Interactive, Quality::Final] {
        missing(session.render(&s, 0, quality).unwrap_err());
    }
    // The one-shot renders hold no surfaces; a thumbnail starts without.
    missing(render(&photo, &s.to_json(), &RenderOptions::default()).unwrap_err());
    missing(export_png(&photo, &s.to_json(), &RenderOptions::default()).unwrap_err());
    session.set_mask_surface(&id, &png).unwrap();
    missing(
        session
            .thumbnail(64)
            .render(&s, 0, Quality::Final)
            .unwrap_err(),
    );
    // A disabled (or empty) surface mask is not drawn and needs no
    // surface; its overlay plane does.
    let mut fresh = open(&photo);
    let mut disabled = s.clone();
    disabled.masks[0].enabled = false;
    assert_eq!(
        fresh.render(&disabled, 0, Quality::Final).unwrap().rgba,
        fresh
            .render(&settings(json!({})), 0, Quality::Final)
            .unwrap()
            .rgba
    );
    missing(fresh.mask_plane(&disabled, "b", 0).unwrap_err());
}

#[test]
fn a_left_half_surface_changes_only_the_left_and_follows_a_quarter_turn() {
    let photo = photo_png(120, 80);
    let (id, png, _) = left_half();
    let adjust = json!({"exposure": -1});
    for geometry in [Value::Null, json!({"rotate": 90})] {
        let extra = if geometry.is_null() {
            json!({})
        } else {
            json!({ "geometry": geometry })
        };
        let global = settings(extra.clone());
        let mut masked = extra.clone();
        masked["masks"] = json!([brush("b", &id, 60, 40, adjust.clone())]);
        let masked = settings(masked);
        let local = local_render::local_settings(&global, &masked.masks[0].adjust);
        let mut session = open(&photo);
        session.set_mask_surface(&id, &png).unwrap();
        let frame = session.render(&masked, 0, Quality::Final).unwrap();
        let r0 = open(&photo).render(&global, 0, Quality::Final).unwrap();
        let rk = open(&photo).render(&local, 0, Quality::Final).unwrap();
        let (w, h) = (frame.width, frame.height);
        let turned = !geometry.is_null();
        assert_eq!((w, h), if turned { (80, 120) } else { (120, 80) });
        // The photo's column of output (i, j): unturned i; turned
        // clockwise, the photo's left is the frame's top (column j).
        let mut darker = 0i64;
        for j in 0..h {
            for i in 0..w {
                let column = if turned { j } else { i };
                let p = (j * w + i) * 4;
                let pixel = &frame.rgba[p..p + 4];
                if column <= 58 {
                    assert_eq!(pixel, &rk.rgba[p..p + 4], "({i}, {j}) {geometry}");
                    darker += (0..3)
                        .map(|c| i64::from(r0.rgba[p + c]) - i64::from(rk.rgba[p + c]))
                        .sum::<i64>();
                } else if column >= 61 {
                    assert_eq!(pixel, &r0.rgba[p..p + 4], "({i}, {j}) {geometry}");
                }
            }
        }
        assert!(darker > 0, "the exposure darkens the painted part");
    }
}

#[test]
fn a_brush_and_a_linear_mask_blend_as_their_independent_frames_in_any_order() {
    let photo = photo_png(120, 80);
    // A soft blob off centre.
    let (id, png, decoded) = surface(48, 32, |x, y| {
        let (dx, dy) = (x as f64 - 14.0, y as f64 - 20.0);
        (255.0 - (dx * dx + dy * dy).sqrt() * 18.0).clamp(0.0, 255.0) as u8
    });
    let linear = json!({
        "id": "sky", "kind": "linear",
        "zero": {"x": 0.5, "y": 0.6}, "full": {"x": 0.5, "y": 0.1},
        "adjust": {"exposure": -0.6, "highlights": -30}
    });
    let painted = brush(
        "paint",
        &id,
        48,
        32,
        json!({"saturation": 40, "clarity": 20}),
    );
    let global = settings(json!({}));
    for quality in [Quality::Final, Quality::Interactive] {
        let size = if quality == Quality::Final { 0 } else { 96 };
        let ab = settings(json!({ "masks": [linear.clone(), painted.clone()] }));
        let ba = settings(json!({ "masks": [painted.clone(), linear.clone()] }));
        let mut session = open(&photo);
        session.set_mask_surface(&id, &png).unwrap();
        let frame = session.render(&ab, size, quality).unwrap();
        // R0, each R_k alone, and each plane as `mask_weights` makes it.
        let r0 = open(&photo).render(&global, size, quality).unwrap();
        let (w, h) = (r0.width, r0.height);
        let map = SourceMap::new(None, 120, 80).unwrap();
        let layers: Vec<(Vec<u8>, Vec<u32>)> = ab
            .masks
            .iter()
            .map(|mask| {
                let local = local_render::local_settings(&global, &mask.adjust);
                let rk = open(&photo).render(&local, size, quality).unwrap();
                let surface = (mask.id == "paint").then_some(&decoded);
                let weights = local_render::mask_weights(mask, &map, w, h, surface).unwrap();
                (rk.rgba, weights)
            })
            .collect();
        let terms: Vec<(&[u8], &[u32])> = layers
            .iter()
            .map(|(rgba, weights)| (rgba.as_slice(), weights.as_slice()))
            .collect();
        assert_eq!(
            frame.rgba,
            local_render::blend(&r0.rgba, &terms),
            "{quality:?}"
        );
        // The other order, in this Session and a new one.
        assert_eq!(session.render(&ba, size, quality).unwrap().rgba, frame.rgba);
        let mut other = open(&photo);
        other.set_mask_surface(&id, &png).unwrap();
        assert_eq!(other.render(&ba, size, quality).unwrap().rgba, frame.rgba);
        // The overlay plane is the blend's plane, quantised.
        let (_, _, plane) = session.mask_plane(&ab, "paint", size).unwrap();
        let expected: Vec<u8> = layers[1]
            .1
            .iter()
            .map(|w| local_render::weight_to_u8(*w))
            .collect();
        assert_eq!(plane, expected);
    }
}

#[test]
fn an_all_zero_surface_draws_nothing_and_settings_without_one_are_unchanged() {
    let photo = photo_png(120, 80);
    let (zero, zero_png, _) = surface(16, 16, |_, _| 0);
    let (id, png, _) = left_half();
    let plain = settings(json!({}));
    let linear = settings(json!({ "masks": [{
        "id": "sky", "kind": "linear",
        "zero": {"x": 0.5, "y": 0.6}, "full": {"x": 0.5, "y": 0.1},
        "adjust": {"exposure": -0.6}
    }] }));
    let empty = settings(json!({ "masks": [brush("z", &zero, 16, 16, json!({"exposure": 1}))] }));
    for (quality, size) in [(Quality::Final, 0usize), (Quality::Interactive, 64)] {
        let expected_plain = open(&photo).render(&plain, size, quality).unwrap();
        let expected_linear = open(&photo).render(&linear, size, quality).unwrap();
        let mut session = open(&photo);
        session.set_mask_surface(&id, &png).unwrap();
        session.set_mask_surface(&zero, &zero_png).unwrap();
        // Surfaces set but not used change no byte.
        assert_eq!(
            session.render(&plain, size, quality).unwrap().rgba,
            expected_plain.rgba
        );
        assert_eq!(
            session.render(&linear, size, quality).unwrap().rgba,
            expected_linear.rgba
        );
        // A surface of zeros: the global frame.
        assert_eq!(
            session.render(&empty, size, quality).unwrap().rgba,
            expected_plain.rgba
        );
    }
}

#[test]
fn a_session_exports_its_surfaced_frame_as_the_one_shot_encodes() {
    let photo = photo_png(120, 80);
    let (id, png, _) = left_half();
    let s = settings(json!({ "masks": [brush("b", &id, 60, 40, json!({"exposure": -1}))] }));
    let mut session = open(&photo);
    session.set_mask_surface(&id, &png).unwrap();
    let frame = session.render(&s, 64, Quality::Final).unwrap();
    let exported = session.export_png(&s, 64).unwrap();
    assert_eq!(exported, niho_develop::encode_frame_png(&frame).unwrap());
    let jpeg = session.export_jpeg(&s, 64, 90).unwrap();
    assert_eq!(jpeg, niho_develop::encode_frame_jpeg(&frame, 90).unwrap());
    assert_eq!(&jpeg[..3], &[0xff, 0xd8, 0xff]);
    // Without masks the Session's export is the one-shot's at its size.
    let plain = settings(json!({}));
    let options = RenderOptions {
        max_dimension: 0,
        ..Default::default()
    };
    assert_eq!(
        session.export_png(&plain, 0).unwrap(),
        export_png(&photo, &plain.to_json(), &options).unwrap()
    );
}
