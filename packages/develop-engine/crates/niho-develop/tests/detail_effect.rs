//! How v6 detail acts on every input kind (Issue #32), measured on public
//! synthetic charts only: a vertical step edge with seeded, per-channel
//! independent noise on both flat halves.
//!
//! - edge acutance (sum of squared luma steps across the edge band) rises
//!   strictly with the sharpening amount;
//! - the flat half's luma standard deviation falls with luminance NR and its
//!   chroma standard deviation falls with color NR;
//! - an all-zero `detail` object is byte-identical to no `detail`;
//! - Interactive frames omit sharpening (drag policy: Final only) while NR
//!   stays visible;
//! - a crop keeps the whole-photo radius: it is the same cut of the whole
//!   frame.
//!
//! Inputs: JPEG and PNG originals, a legacy (unsigned) RAW working copy and a
//! signed RAW working copy, each on the engines that render it.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy};
use niho_develop::settings::{DetailSettings, DevelopSettings, SharpeningSettings};
use niho_develop::{encode, Filter, LinearImage, Quality, Rendered, Session};

const WIDTH: usize = 512;
const HEIGHT: usize = 256;

/// xorshift32 in -0.5..0.5.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0 as f32 / u32::MAX as f32 - 0.5
    }
}

/// Linear chart: left 0.10, right 0.42 (slightly warm), noise per channel.
fn linear_chart(amplitude: f32) -> LinearImage {
    let mut noise = Noise(0x5eed_d37a);
    let mut data = Vec::with_capacity(WIDTH * HEIGHT * 3);
    for _y in 0..HEIGHT {
        for x in 0..WIDTH {
            let base: [f32; 3] = if x >= WIDTH / 2 {
                [0.44, 0.42, 0.38]
            } else {
                [0.10, 0.10, 0.11]
            };
            for value in base {
                data.push(value + noise.next() * amplitude * value.max(0.12));
            }
        }
    }
    LinearImage {
        width: WIDTH,
        height: HEIGHT,
        data,
    }
}

/// 8-bit sRGB chart for JPEG / PNG originals.
fn raster_rgba() -> Vec<u8> {
    let mut noise = Noise(0x0bad_cafe);
    let mut rgba = Vec::with_capacity(WIDTH * HEIGHT * 4);
    for _y in 0..HEIGHT {
        for x in 0..WIDTH {
            let base: [f32; 3] = if x >= WIDTH / 2 {
                [182.0, 178.0, 170.0]
            } else {
                [88.0, 88.0, 92.0]
            };
            for value in base {
                rgba.push((value + noise.next() * 26.0).round().clamp(0.0, 255.0) as u8);
            }
            rgba.push(255);
        }
    }
    rgba
}

const UNSIGNED_RAW_META: &str = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474},"dcpSha256":"test","lookTableIncluded":true}"#;

fn signed_raw_meta(ceiling: f64) -> String {
    format!(
        r#"{{"kind":"raw","baselineEV":-0.2,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{ceiling}}}}}"#
    )
}

#[derive(Clone)]
enum Source {
    Raster(Vec<u8>),
    WorkingCopy(Vec<u8>, String),
}

#[derive(Clone)]
struct Case {
    name: &'static str,
    source: Source,
    engine: &'static str,
    look: &'static str,
}

impl Case {
    fn open(&self) -> Session {
        match &self.source {
            Source::Raster(bytes) => Session::open_raster(bytes, 0, Filter::Lanczos3).unwrap(),
            Source::WorkingCopy(png, meta) => {
                Session::open_working_copy(png, meta, Filter::Lanczos3).unwrap()
            }
        }
    }

    fn settings(&self, detail: Option<DetailSettings>) -> DevelopSettings {
        let mut settings = DevelopSettings::neutral();
        settings.engine = self.engine.into();
        settings.look = self.look.into();
        settings.detail = detail;
        settings.v = settings.required_version();
        settings
    }

    fn render(&self, session: &mut Session, detail: Option<DetailSettings>) -> Rendered {
        self.render_at(session, detail, Quality::Final)
    }

    fn render_at(
        &self,
        session: &mut Session,
        detail: Option<DetailSettings>,
        quality: Quality,
    ) -> Rendered {
        let settings = self.settings(detail);
        assert!(
            settings.validate().is_empty(),
            "{}: {:?}",
            self.name,
            settings.validate()
        );
        session.render(&settings, 0, quality).unwrap()
    }
}

fn jpeg() -> Source {
    Source::Raster(encode::encode_jpeg(&raster_rgba(), WIDTH, HEIGHT, 95).unwrap())
}

fn png() -> Source {
    Source::Raster(encode::encode_png(&raster_rgba(), WIDTH, HEIGHT).unwrap())
}

fn unsigned_raw() -> Source {
    Source::WorkingCopy(
        encode_working_copy(&linear_chart(0.5)),
        UNSIGNED_RAW_META.to_string(),
    )
}

fn signed_raw() -> Source {
    let (png, encoding) = encode_signed_working_copy(&linear_chart(0.5)).unwrap();
    Source::WorkingCopy(png, signed_raw_meta(encoding.ceiling()))
}

/// The engine each input kind is opened with today plus the older engines
/// still stored on saved edits.
fn cases() -> Vec<Case> {
    let (jpeg, png, unsigned, signed) = (jpeg(), png(), unsigned_raw(), signed_raw());
    let case = |name, source: &Source, engine, look| Case {
        name,
        source: source.clone(),
        engine,
        look,
    };
    vec![
        case("jpeg niho-10", &jpeg, "niho-10", "niho-standard-1"),
        case("png niho-10", &png, "niho-10", "niho-standard-1"),
        case("png niho-1", &png, "niho-1", "niho-interim-1"),
        case("png niho-2", &png, "niho-2", "niho-standard-1"),
        case("png niho-6", &png, "niho-6", "niho-standard-1"),
        case("png niho-8", &png, "niho-8", "niho-standard-1"),
        case("unsigned raw niho-1", &unsigned, "niho-1", "niho-interim-1"),
        case(
            "unsigned raw niho-2",
            &unsigned,
            "niho-2",
            "niho-standard-1",
        ),
        case("signed raw niho-3", &signed, "niho-3", "niho-standard-2"),
        case("signed raw niho-4", &signed, "niho-4", "niho-standard-3"),
        case("signed raw niho-5", &signed, "niho-5", "niho-standard-4"),
        case("signed raw niho-7", &signed, "niho-7", "niho-standard-5"),
        case("signed raw niho-11", &signed, "niho-11", "niho-standard-5"),
    ]
}

fn luma(pixel: &[u8]) -> f64 {
    0.2126 * f64::from(pixel[0]) + 0.7152 * f64::from(pixel[1]) + 0.0722 * f64::from(pixel[2])
}

fn pixel(frame: &Rendered, x: usize, y: usize) -> &[u8] {
    let i = (y * frame.width + x) * 4;
    &frame.rgba[i..i + 4]
}

/// Sum of squared horizontal luma steps across the edge band.
fn edge_acutance(frame: &Rendered) -> f64 {
    let middle = frame.width / 2;
    let mut total = 0.0;
    for y in 32..frame.height - 32 {
        for x in middle - 12..middle + 12 {
            let step = luma(pixel(frame, x + 1, y)) - luma(pixel(frame, x, y));
            total += step * step;
        }
    }
    total
}

fn standard_deviation(values: &[f64]) -> f64 {
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
}

/// The dark flat half, away from the edge and the frame border.
fn flat(frame: &Rendered) -> impl Iterator<Item = &[u8]> {
    (32..frame.height - 32)
        .flat_map(move |y| (32..frame.width / 2 - 48).map(move |x| pixel(frame, x, y)))
}

fn flat_luma_sd(frame: &Rendered) -> f64 {
    standard_deviation(&flat(frame).map(luma).collect::<Vec<_>>())
}

fn flat_chroma_sd(frame: &Rendered) -> f64 {
    let red: Vec<f64> = flat(frame)
        .map(|p| f64::from(p[0]) - f64::from(p[1]))
        .collect();
    let blue: Vec<f64> = flat(frame)
        .map(|p| f64::from(p[2]) - f64::from(p[1]))
        .collect();
    standard_deviation(&red).hypot(standard_deviation(&blue))
}

fn sharpening(amount: f64) -> DetailSettings {
    DetailSettings {
        sharpening: SharpeningSettings {
            amount,
            // The radius is authored at a 1500 px long edge; 3.0 is about
            // one output pixel on this 512 px chart.
            radius: 3.0,
            detail: 25.0,
            masking: 0.0,
        },
        ..DetailSettings::default()
    }
}

fn luminance(amount: f64) -> DetailSettings {
    DetailSettings {
        luminance_noise_reduction: amount,
        ..DetailSettings::default()
    }
}

fn color(amount: f64) -> DetailSettings {
    DetailSettings {
        color_noise_reduction: Some(amount),
        ..DetailSettings::default()
    }
}

/// Byte equality without dumping whole frames on failure.
fn assert_same(a: &Rendered, b: &Rendered, name: &str) {
    assert_eq!((a.width, a.height), (b.width, b.height), "{name}");
    let differing = a.rgba.iter().zip(&b.rgba).filter(|(x, y)| x != y).count();
    assert_eq!(differing, 0, "{name}: {differing} bytes differ");
}

fn strictly_increasing(values: &[f64]) -> bool {
    values.windows(2).all(|pair| pair[1] > pair[0])
}

#[test]
fn zero_detail_is_byte_identical_to_no_detail_on_every_input() {
    for case in cases() {
        let mut session = case.open();
        let old = case.render(&mut session, None);
        let zero = case.render(&mut session, Some(DetailSettings::default()));
        assert_same(&old, &zero, case.name);
        // Amount 0 keeps the authored radius / detail / masking inert.
        let inert = DetailSettings {
            sharpening: SharpeningSettings {
                amount: 0.0,
                radius: 2.5,
                detail: 80.0,
                masking: 60.0,
            },
            ..DetailSettings::default()
        };
        let inert = case.render(&mut session, Some(inert));
        assert_same(&old, &inert, case.name);
    }
}

#[test]
fn edge_acutance_rises_strictly_with_the_sharpening_amount_on_every_input() {
    for case in cases() {
        let mut session = case.open();
        let acutance: Vec<f64> = [0.0, 50.0, 100.0, 150.0]
            .into_iter()
            .map(|amount| edge_acutance(&case.render(&mut session, Some(sharpening(amount)))))
            .collect();
        assert!(
            strictly_increasing(&acutance),
            "{}: {acutance:?}",
            case.name
        );
        assert!(
            acutance[3] > acutance[0] * 1.2,
            "{}: sharpening barely acts {acutance:?}",
            case.name
        );
    }
}

#[test]
fn luminance_and_color_noise_reduction_lower_flat_deviation_on_every_input() {
    for case in cases() {
        let mut session = case.open();
        let luma_sd: Vec<f64> = [0.0, 50.0, 100.0]
            .into_iter()
            .map(|amount| flat_luma_sd(&case.render(&mut session, Some(luminance(amount)))))
            .collect();
        assert!(
            luma_sd.windows(2).all(|pair| pair[1] < pair[0]),
            "{}: luminance NR {luma_sd:?}",
            case.name
        );
        let chroma_sd: Vec<f64> = [0.0, 50.0, 100.0]
            .into_iter()
            .map(|amount| flat_chroma_sd(&case.render(&mut session, Some(color(amount)))))
            .collect();
        assert!(
            chroma_sd[1] < chroma_sd[0] && chroma_sd[2] <= chroma_sd[1],
            "{}: color NR {chroma_sd:?}",
            case.name
        );
        // Luminance NR does not stand in for color NR and vice versa: the
        // other statistic moves much less.
        let base = case.render(&mut session, None);
        let lnr = case.render(&mut session, Some(luminance(100.0)));
        let cnr = case.render(&mut session, Some(color(100.0)));
        assert!(
            (flat_luma_sd(&cnr) - flat_luma_sd(&base)).abs()
                < (flat_luma_sd(&lnr) - flat_luma_sd(&base)).abs(),
            "{}: color NR moved luma more than luminance NR",
            case.name
        );
    }
}

#[test]
fn interactive_frames_omit_sharpening_and_keep_noise_reduction() {
    for case in cases() {
        let mut session = case.open();
        let mut both = sharpening(120.0);
        both.luminance_noise_reduction = 60.0;
        let mut nr_only = both;
        nr_only.sharpening.amount = 0.0;
        let dragging = case.render_at(&mut session, Some(both), Quality::Interactive);
        let nr_dragging = case.render_at(&mut session, Some(nr_only), Quality::Interactive);
        assert_same(&dragging, &nr_dragging, case.name);
        let plain = case.render_at(&mut session, None, Quality::Interactive);
        assert!(
            dragging.rgba != plain.rgba,
            "{}: NR missing while dragging",
            case.name
        );
        let released = case.render_at(&mut session, Some(both), Quality::Final);
        let released_nr = case.render_at(&mut session, Some(nr_only), Quality::Final);
        assert!(
            edge_acutance(&released) > edge_acutance(&released_nr),
            "{}: Final must sharpen",
            case.name
        );
    }
}

#[test]
fn a_crop_keeps_the_whole_photo_radius_on_every_input() {
    for case in cases() {
        let mut detail = sharpening(120.0);
        detail.luminance_noise_reduction = 40.0;
        detail.color_noise_reduction = Some(40.0);
        let whole = case.render(&mut case.open(), Some(detail));
        let mut value = case.settings(Some(detail)).to_value();
        // The crop edge sits right on the step edge, where sharpening acts.
        value["geometry"] = serde_json::json!({
            "crop": {"left": 0.25, "top": 0.125, "right": 0.75, "bottom": 0.875}
        });
        let mut cropped_settings = DevelopSettings::from_json(&value.to_string()).unwrap();
        cropped_settings.v = cropped_settings.required_version();
        let cropped = case
            .open()
            .render(&cropped_settings, 0, Quality::Final)
            .unwrap();
        assert_eq!((cropped.width, cropped.height), (256, 192), "{}", case.name);
        let mut worst = 0u8;
        for y in 0..cropped.height {
            for x in 0..cropped.width {
                let a = pixel(&cropped, x, y);
                let b = pixel(&whole, x + 128, y + 32);
                for c in 0..3 {
                    worst = worst.max(a[c].abs_diff(b[c]));
                }
            }
        }
        // The same cut of the whole frame: the windowed filters see the
        // same neighbours at the same scale, up to one LSB of float order.
        assert!(worst <= 1, "{}: crop differs by {worst}", case.name);
    }
}
