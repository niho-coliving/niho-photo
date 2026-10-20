//! NIHO develop engine, stage 2 (`niho-develop`): Lightroom-style
//! adjustments and XMP presets on linear ProPhoto, one crate for the
//! browser (wasm), the API and NIHO Desktop (native).
//!
//! See `packages/develop-engine/README.md` and
//! `specs/initiatives/niho-develop-engine.md` ("段 2").

pub mod acr3;
pub mod auto;
pub mod camera_linear;
pub mod camera_linear_codec;
pub mod color;
pub mod color_ops;
pub mod convert;
pub mod decode;
pub mod effects;
pub mod encode;
pub mod exif;
pub mod fastmath;
pub mod frame;
pub mod geometry;
pub mod icc_lut;
mod jpeg_wb;
pub mod look;
pub mod lut;
mod niho3;
mod niho4;
#[allow(dead_code)] // Keep the frozen R317/R364 diagnostic surface intact.
mod niho4_response;
pub mod niho6;
pub mod niho6_response;
pub mod output;
pub mod pipeline;
pub mod raw_chroma;
mod raw_highlight_recovery;
mod raw_highlight_residual;
mod raw_highlight_shoulder;
pub mod raw_response;
#[path = "raw_response/simd.rs"]
mod raw_response_simd;
pub mod relative_wb;
pub mod resize;
pub mod settings;
pub mod spatial;
pub mod tone_ops;
pub mod wb_table;
pub mod xmp;

pub use camera_linear::{CameraLinearError, CameraLinearWorkMeta};
pub use decode::{
    AsShotWhite, DecodeError, LightroomWhite, LinearImage, Raster, SignedWorkingCopyEncodeError,
    WorkingCopyEncoding, WorkingCopyMeta,
};
pub use geometry::Geometry;
pub use pipeline::{RenderOptions, Rendered};
pub use resize::Filter;
pub use settings::{DevelopSettings, SettingsError};
pub use spatial::Quality;

use std::{fmt, sync::Arc};

/// Latest formula version this bundle can render. Settings constructors keep
/// their own compatibility defaults; this advertises reader capability.
pub const ENGINE_VERSION: &str = settings::ENGINE_NIHO_7;
/// Crate version (build artifacts are published per version).
pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug)]
pub enum Error {
    /// `developSettings` JSON unreadable or of an unknown version.
    Settings(SettingsError),
    /// Values outside the allowed ranges.
    InvalidSettings(Vec<SettingsError>),
    Decode(DecodeError),
    CameraLinear(CameraLinearError),
    Encode(String),
    IncompatibleWorkingCopy(String),
    Niho3Prepare(String),
    Niho4Prepare(String),
    Niho6Prepare(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Settings(e) => write!(f, "invalid_settings: {e}"),
            Error::InvalidSettings(list) => {
                let joined: Vec<String> = list.iter().map(|e| e.to_string()).collect();
                write!(f, "invalid_settings: {}", joined.join("; "))
            }
            Error::Decode(e) => write!(f, "{e}"),
            Error::CameraLinear(e) => write!(f, "camera_linear: {e}"),
            Error::Encode(e) => write!(f, "encode_failed: {e}"),
            Error::IncompatibleWorkingCopy(e) => write!(f, "incompatible_working_copy: {e}"),
            Error::Niho3Prepare(e) => write!(f, "niho3_prepare_failed: {e}"),
            Error::Niho4Prepare(e) => write!(f, "niho4_prepare_failed: {e}"),
            Error::Niho6Prepare(e) => write!(f, "niho6_prepare_failed: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<DecodeError> for Error {
    fn from(e: DecodeError) -> Self {
        Error::Decode(e)
    }
}

impl From<CameraLinearError> for Error {
    fn from(e: CameraLinearError) -> Self {
        Error::CameraLinear(e)
    }
}

/// Parses and validates `developSettings` for rendering.
pub fn parse_settings(settings_json: &str) -> Result<DevelopSettings, Error> {
    let settings = DevelopSettings::from_json(settings_json).map_err(Error::Settings)?;
    let issues = settings.validate();
    if !issues.is_empty() {
        return Err(Error::InvalidSettings(issues));
    }
    Ok(settings)
}

/// The geometry these settings render (`None` when it is the identity:
/// those settings render exactly as without one).
fn rendered_geometry(settings: &DevelopSettings) -> Option<&Geometry> {
    settings.geometry.as_ref().filter(|g| !g.is_identity())
}

fn geometry_error(e: SettingsError) -> Error {
    Error::InvalidSettings(vec![e])
}

/// "補正前": the color adjustments back to neutral, keeping `v`, `engine`,
/// `look`, `base` and `geometry` (the before view is the same frame, only
/// the colors are the original's).
pub fn before_settings(settings_json: &str) -> Result<String, Error> {
    let s = parse_settings(settings_json)?;
    let before = DevelopSettings {
        v: s.v,
        engine: s.engine,
        look: s.look,
        base: s.base,
        geometry: s.geometry,
        ..DevelopSettings::neutral()
    };
    Ok(before.to_json())
}

/// The long edge to decode a `width x height` JPEG / PNG original at (EXIF
/// orientation applied, [`frame::image_size`]) so the crop of `settings`
/// reaches `max_dimension` ([`frame::decode_long_edge`]; `cap` 0 = none).
/// A Session opened at this size renders `settings` at `max_dimension`.
pub fn raster_decode_size(
    settings: &DevelopSettings,
    width: usize,
    height: usize,
    max_dimension: usize,
    cap: usize,
) -> Result<usize, Error> {
    frame::decode_long_edge(
        rendered_geometry(settings),
        width,
        height,
        max_dimension,
        cap,
    )
    .map_err(geometry_error)
}

/// The size `settings` render at from a `width x height` source (a
/// Session's working image) at `max_dimension`, without rendering.
pub fn output_size(
    settings: &DevelopSettings,
    width: usize,
    height: usize,
    max_dimension: usize,
) -> Result<(usize, usize), Error> {
    frame::output_size(rendered_geometry(settings), width, height, max_dimension)
        .map_err(geometry_error)
}

/// One-shot render of a JPEG / PNG original. With a geometry the original
/// is decoded large enough for the crop to reach `max_dimension`
/// ([`raster_decode_size`], at most `decode_cap`) and rendered like a
/// Session opened at that size; without one it is decoded at
/// `max_dimension`.
pub fn render(
    input: &[u8],
    settings_json: &str,
    options: &RenderOptions,
) -> Result<Rendered, Error> {
    let settings = parse_settings(settings_json)?;
    if matches!(
        settings.engine.as_str(),
        settings::ENGINE_NIHO_4 | settings::ENGINE_NIHO_5 | settings::ENGINE_NIHO_7
    ) {
        return Err(Error::IncompatibleWorkingCopy(format!(
            "{} supports signed RAW working copies only",
            settings.engine
        )));
    }
    if rendered_geometry(&settings).is_none() {
        let raster = decode::decode_raster(input, options.max_dimension, options.filter)?;
        if settings.engine == settings::ENGINE_NIHO_6 && niho6::uses_response(&settings) {
            // The decoded size is the output size: the Session renders it as is.
            return Session::new(SessionSource::Raster(raster), options.filter).render(
                &settings,
                0,
                options.quality,
            );
        }
        return Ok(pipeline::render_raster(&raster, &settings, options.quality, None, None).0);
    }
    let (width, height) = frame::image_size(input)?;
    let long_edge = raster_decode_size(
        &settings,
        width,
        height,
        options.max_dimension,
        options.decode_cap,
    )?;
    let raster = decode::decode_raster(input, long_edge, options.filter)?;
    Session::new(SessionSource::Raster(raster), options.filter).render(
        &settings,
        options.max_dimension,
        options.quality,
    )
}

/// One-shot render of a RAW working-copy PNG and its metadata.
///
/// This follows the same metadata-aware decode and full-source NIHO 3
/// preparation path as [`Session`].
pub fn render_working_copy(
    png: &[u8],
    meta_json: &str,
    settings_json: &str,
    options: &RenderOptions,
) -> Result<Rendered, Error> {
    let settings = parse_settings(settings_json)?;
    Session::open_working_copy(png, meta_json, options.filter)?.render(
        &settings,
        options.max_dimension,
        options.quality,
    )
}

/// One-shot stage-2 render of an already-decoded camera-linear RGB image.
///
/// The exact DCP and camera identity are verified before the image is transformed to linear
/// ProPhoto. Absolute white balance is applied in camera RGB and disabled in the working-copy
/// tail, while as-shot and relative modes retain the existing stage-2 behavior.
pub fn render_camera_linear(
    camera: &LinearImage,
    dcp_bytes: &[u8],
    meta: &CameraLinearWorkMeta,
    settings: &DevelopSettings,
    options: &RenderOptions,
) -> Result<Rendered, Error> {
    let issues = settings.validate();
    if !issues.is_empty() {
        return Err(Error::InvalidSettings(issues));
    }
    if matches!(
        settings.engine.as_str(),
        settings::ENGINE_NIHO_4 | settings::ENGINE_NIHO_5 | settings::ENGINE_NIHO_7
    ) {
        return Err(Error::IncompatibleWorkingCopy(format!(
            "{} supports signed RAW working copies only",
            settings.engine
        )));
    }
    if settings.engine == settings::ENGINE_NIHO_6 {
        return Err(Error::IncompatibleWorkingCopy(
            "niho-6 supports JPEG / PNG originals and raster working copies only".into(),
        ));
    }
    camera_linear::validate_work_meta(meta)?;
    match settings.base.as_deref() {
        Some(base) if base == meta.base_version => {}
        None if settings.is_neutral() => {}
        _ => return Err(CameraLinearError::BaseVersionMismatch.into()),
    }

    let dcp = camera_linear::validated_dcp(
        dcp_bytes,
        &meta.expected_dcp_sha256,
        &meta.expected_unique_camera_model,
    )?;
    let baseline_ev = meta.raw_baseline_ev + dcp.baseline_exposure_offset;
    if !baseline_ev.is_finite() {
        return Err(CameraLinearError::NonFiniteBaselineExposure.into());
    }
    let exposure_gain = libm::exp2(baseline_ev + settings.exposure) as f32;
    if !exposure_gain.is_finite() || exposure_gain <= 0.0 {
        return Err(CameraLinearError::InvalidBaselineExposureGain.into());
    }

    let mut render_settings = settings.clone();
    let neutral = match settings.white_balance.mode {
        settings::WhiteBalanceMode::Absolute => {
            let temperature = settings
                .white_balance
                .temperature
                .ok_or(CameraLinearError::InvalidWhiteBalance)?;
            let tint = settings
                .white_balance
                .tint
                .ok_or(CameraLinearError::InvalidWhiteBalance)?;
            let neutral =
                camera_linear::neutral_for_absolute_white(&dcp.color_input(), temperature, tint)?;
            render_settings.white_balance.mode = settings::WhiteBalanceMode::AsShot;
            neutral
        }
        settings::WhiteBalanceMode::AsShot | settings::WhiteBalanceMode::Relative => {
            meta.as_shot_camera_neutral
        }
    };
    let image = camera_linear::to_linear_prophoto(camera, &dcp.color_input(), neutral)?;
    let working_meta = WorkingCopyMeta::Raw {
        baseline_ev,
        as_shot_white: meta.as_shot_white,
        as_shot_white_adobe: None,
        white_balance_table: None,
        dcp_sha256: meta.expected_dcp_sha256.clone(),
        look_table_included: false,
        encoding: None,
    };
    Session::with_source(
        SessionSource::WorkingCopy {
            image,
            meta: working_meta,
        },
        options.filter,
    )
    .render(&render_settings, options.max_dimension, options.quality)
}

/// One-shot render encoded as JPEG (`quality` 1..100).
pub fn export_jpeg(
    input: &[u8],
    settings_json: &str,
    options: &RenderOptions,
    quality: u8,
) -> Result<Vec<u8>, Error> {
    let frame = render(input, settings_json, options)?;
    encode::encode_jpeg(&frame.rgba, frame.width, frame.height, quality).map_err(Error::Encode)
}

/// One-shot render encoded as PNG.
pub fn export_png(
    input: &[u8],
    settings_json: &str,
    options: &RenderOptions,
) -> Result<Vec<u8>, Error> {
    let frame = render(input, settings_json, options)?;
    encode::encode_png(&frame.rgba, frame.width, frame.height).map_err(Error::Encode)
}

enum SessionSource {
    Raster(Raster),
    WorkingCopy {
        image: LinearImage,
        meta: WorkingCopyMeta,
    },
}

impl SessionSource {
    fn size(&self) -> (usize, usize) {
        let image = self.image();
        (image.width, image.height)
    }

    fn image(&self) -> &LinearImage {
        match self {
            SessionSource::Raster(r) => &r.image,
            SessionSource::WorkingCopy { image, .. } => image,
        }
    }

    /// The space of [`SessionSource::image`] for `niho-6` (raster working
    /// copies are linear ProPhoto; RAW sources are never prepared by it).
    fn space(&self) -> niho6::SourceSpace {
        match self {
            SessionSource::Raster(_) => niho6::SourceSpace::LinearSrgb,
            SessionSource::WorkingCopy { .. } => niho6::SourceSpace::LinearProPhoto,
        }
    }

    /// The same input reduced to `tw` x `th` in linear light (a copy when
    /// that is its size).
    fn reduced(&self, tw: usize, th: usize, filter: Filter) -> SessionSource {
        let (w, h) = self.size();
        let resized = |image: &LinearImage| {
            if (tw, th) == (w, h) {
                image.clone()
            } else {
                LinearImage {
                    width: tw,
                    height: th,
                    data: resize::resample(&image.data, w, h, tw, th, filter),
                }
            }
        };
        match self {
            SessionSource::Raster(r) => SessionSource::Raster(Raster {
                image: resized(&r.image),
                info: r.info.clone(),
            }),
            SessionSource::WorkingCopy { image, meta } => SessionSource::WorkingCopy {
                image: resized(image),
                meta: meta.clone(),
            },
        }
    }

    /// The same kind of source with another image.
    fn with_image(&self, image: LinearImage) -> Self {
        match self {
            SessionSource::Raster(r) => SessionSource::Raster(Raster {
                image,
                info: r.info.clone(),
            }),
            SessionSource::WorkingCopy { meta, .. } => SessionSource::WorkingCopy {
                image,
                meta: meta.clone(),
            },
        }
    }
}

/// Largest long side of [`Session::thumbnail`] (preset previews are drawn
/// at 256..384).
pub const THUMBNAIL_MAX_DIMENSION: usize = 512;

/// The working image of a geometry frame ([`frame::working_image`]) for
/// one geometry and size.
struct Framed {
    /// [`frame::frame_key`].
    key: String,
    /// `key` and the window (the kept local pass's input).
    window_key: String,
    plan: frame::Plan,
    /// `None`: the window is the source itself ([`frame::Plan::window_is_source`]).
    image: Option<SessionSource>,
}

struct PreparedNiho3 {
    key: String,
    /// Prepared from the full source (not a display-size preview).
    full: bool,
    source: SessionSource,
    settings: DevelopSettings,
    approximate_white_balance: bool,
    analysis: RawAnalysisCache,
}

enum RawAnalysisCache {
    Niho3(niho3::AnalysisCache),
    Niho4(niho4::AnalysisCache),
    /// The analysis is [`Session::niho6_analysis`] (shared by the sessions
    /// of one photo).
    Niho6,
}

impl RawAnalysisCache {
    fn downgrade(&self) -> RawAnalysisSeed {
        match self {
            Self::Niho3(cache) => RawAnalysisSeed::Niho3(cache.downgrade()),
            Self::Niho4(cache) => RawAnalysisSeed::Niho4(cache.downgrade()),
            Self::Niho6 => RawAnalysisSeed::Niho6,
        }
    }

    fn serves(
        &self,
        engine: RawEngine,
        image: &LinearImage,
        meta: &WorkingCopyMeta,
        settings: &DevelopSettings,
    ) -> bool {
        match (self, engine) {
            (Self::Niho3(cache), RawEngine::Niho3) => cache.serves(image, settings),
            (Self::Niho4(cache), RawEngine::Niho4) => {
                let baseline_ev = match meta {
                    WorkingCopyMeta::Raw { baseline_ev, .. } => *baseline_ev,
                    WorkingCopyMeta::Raster { .. } => 0.0,
                };
                niho4::camera(meta)
                    .is_some_and(|camera| cache.serves(image, settings, camera, baseline_ev))
            }
            (Self::Niho6, RawEngine::Niho6) => true,
            _ => false,
        }
    }
}

#[derive(Clone)]
enum RawAnalysisSeed {
    Niho3(niho3::AnalysisSeed),
    Niho4(niho4::AnalysisSeed),
    /// `niho-6` shares its analysis through [`Session::niho6_analysis`].
    Niho6,
}

impl RawAnalysisSeed {
    fn upgrade(&self, engine: RawEngine) -> Option<RawAnalysisCache> {
        match (self, engine) {
            (Self::Niho3(seed), RawEngine::Niho3) => seed.upgrade().map(RawAnalysisCache::Niho3),
            (Self::Niho4(seed), RawEngine::Niho4) => seed.upgrade().map(RawAnalysisCache::Niho4),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
struct RawPreparationTarget {
    width: usize,
    height: usize,
    filter: Filter,
}

impl RawPreparationTarget {
    fn niho3(self) -> niho3::PreparationTarget {
        niho3::PreparationTarget {
            width: self.width,
            height: self.height,
            filter: self.filter,
        }
    }

    fn niho4(self) -> niho4::PreparationTarget {
        niho4::PreparationTarget {
            width: self.width,
            height: self.height,
            filter: self.filter,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RawEngine {
    Niho3,
    Niho4,
    /// The raster `niho-6` (named with the RAW engines: it prepares a master
    /// the same way).
    Niho6,
}

/// The `niho-6` analysis shared by the sessions of one photo: its features
/// (once) and the coefficient maps of the last exposure.
#[derive(Default)]
struct Niho6AnalysisCache {
    features: std::sync::OnceLock<Result<Arc<niho6::SourceFeatures>, String>>,
    at_exposure: std::sync::Mutex<Option<Niho6AtExposure>>,
}

/// The analysis made at an exposure (its `f64` bits) and its result.
type Niho6AtExposure = (u64, Result<Arc<niho6::Analysis>, String>);

/// A full-source NIHO 3 master and its reduction, set aside while unframed
/// reduced Interactive frames draw from a display-size master. Releasing a
/// drag that left the master's inputs as they were (a slider of the tail)
/// takes it back instead of preparing the full source again; the key says
/// the pixels are the same.
struct ParkedNiho3 {
    key: String,
    source: SessionSource,
    approximate_white_balance: bool,
    sized: Option<(usize, SessionSource)>,
}

/// Statistics key of frames with a geometry: they read the source itself
/// (whatever the output size), as a frame at the working size does.
const SOURCE_STATS_KEY: usize = 0;

/// A decoded photo kept for repeated renders (slider drags): decode once,
/// keep the per-size reductions (or, with a geometry, the working image of
/// the window), the adaptive statistics, the cubes of the previous frame
/// and the effects' planes.
pub struct Session {
    source: Arc<SessionSource>,
    filter: Filter,
    /// Preview output cap while retaining the full signed source for NIHO 3
    /// canonical analysis. Raster and legacy working-copy thumbnails keep
    /// their historical eagerly-reduced representation.
    preview_max_dimension: Option<usize>,
    sized: Option<(usize, SessionSource)>,
    framed: Option<Framed>,
    stats: Vec<(usize, Quality, spatial::AdaptiveStats)>,
    cubes: Option<pipeline::SettingsCubes>,
    /// The last frame's local pass (reused by the next frames, see
    /// [`pipeline::LocalPass`]).
    local: Option<pipeline::LocalPass>,
    /// The effects' planes (vignette radius, grain field).
    effects: effects::EffectsCache,
    /// NIHO 3 master. Final and framed renders keep the full-source master;
    /// reduced unframed Interactive renders prepare at their display size.
    niho3: Option<PreparedNiho3>,
    /// The full-source master put aside by those Interactive renders (at
    /// most one full-source master in memory).
    parked_niho3: Option<ParkedNiho3>,
    /// The NIHO 3 analysis of the session this one was made from (a signed
    /// thumbnail, an auto candidate): the same source's CNR result and
    /// response coefficients, used while that session holds them by a
    /// preparation of the same CNR amount instead of computing them again.
    niho3_seed: Option<RawAnalysisSeed>,
    /// The `niho-6` analysis of the whole photo, shared with the sessions
    /// made from this one (preset previews, auto): the first that needs it
    /// computes it from [`Session::niho6_source`].
    niho6_analysis: Arc<Niho6AnalysisCache>,
    /// The whole photo the `niho-6` analysis reads (a preview's parent's
    /// source, not its own reduction).
    niho6_source: Arc<SessionSource>,
    /// The `niho-6` analysis this session's last frame used. While dragging
    /// (Interactive) this session's frames reuse it instead of making the
    /// analysis again at every exposure tick. It is this session's own: the
    /// shared cache also holds the analyses of preset previews and auto
    /// candidates at their exposures, which must not stand in for it.
    niho6_last_used: Option<Arc<niho6::Analysis>>,
    /// Whether Interactive frames may reuse [`Session::niho6_last_used`]. Off
    /// for sessions made from another one (preset previews, auto
    /// candidates): each of their frames is drawn at its own exposure.
    niho6_reuse_while_dragging: bool,
}

impl Session {
    fn new(source: SessionSource, filter: Filter) -> Self {
        Self::with_source(source, filter)
    }

    /// Opens a JPEG / PNG original, reduced to `working_max_dimension`
    /// (0 = original size; with a geometry, [`raster_decode_size`] gives
    /// the size its crop needs).
    pub fn open_raster(
        input: &[u8],
        working_max_dimension: usize,
        filter: Filter,
    ) -> Result<Self, Error> {
        let raster = decode::decode_raster(input, working_max_dimension, filter)?;
        Ok(Self::with_source(SessionSource::Raster(raster), filter))
    }

    fn with_source(source: SessionSource, filter: Filter) -> Self {
        Self::with_shared_source(Arc::new(source), filter)
    }

    fn with_shared_source(source: Arc<SessionSource>, filter: Filter) -> Self {
        Self {
            niho6_analysis: Arc::default(),
            niho6_source: Arc::clone(&source),
            niho6_last_used: None,
            niho6_reuse_while_dragging: true,
            source,
            filter,
            preview_max_dimension: None,
            sized: None,
            framed: None,
            stats: Vec::new(),
            cubes: None,
            local: None,
            effects: effects::EffectsCache::default(),
            niho3: None,
            parked_niho3: None,
            niho3_seed: None,
        }
    }

    /// Opens a working copy (16-bit PNG) with its metadata JSON.
    pub fn open_working_copy(png: &[u8], meta_json: &str, filter: Filter) -> Result<Self, Error> {
        let meta = WorkingCopyMeta::from_json(meta_json)?;
        let image = decode::decode_working_copy_with_meta(png, &meta, 0, filter)?;
        Ok(Self::with_source(
            SessionSource::WorkingCopy { image, meta },
            filter,
        ))
    }

    pub fn source_size(&self) -> (usize, usize) {
        self.source.size()
    }

    /// The working copy's metadata (`None` for a JPEG / PNG original).
    pub fn working_copy_meta(&self) -> Option<&WorkingCopyMeta> {
        match self.source.as_ref() {
            SessionSource::WorkingCopy { meta, .. } => Some(meta),
            SessionSource::Raster(_) => None,
        }
    }

    /// The as-shot white on Lightroom's scale (a RAW working copy that
    /// records it; [`WorkingCopyMeta::lightroom_as_shot_white`]), for
    /// [`xmp::apply_preset`].
    pub fn as_shot_white(&self) -> Option<LightroomWhite> {
        self.working_copy_meta()
            .and_then(WorkingCopyMeta::lightroom_as_shot_white)
    }

    /// A separate small session for preset previews: this session's input
    /// (the decoded original or working copy, not decoded again) rendered at
    /// a long side of `max_dimension` (at most
    /// [`THUMBNAIL_MAX_DIMENSION`]; 0 = that limit; never enlarged), with
    /// the working copy's metadata. A signed NIHO 3 copy retains its full
    /// source internally so canonical analysis is independent of preview
    /// size; legacy inputs are eagerly reduced as before. It shares only the
    /// immutable source and (signed) the NIHO 3 analysis of that source with
    /// this session (not reductions, statistics, local pass, cubes, masters
    /// or effects' planes), so
    /// drawing previews leaves the next drag frame as it was. Render it at
    /// its own size (`max_dimension` 0).
    pub fn thumbnail(&self, max_dimension: usize) -> Session {
        let limit = match max_dimension {
            0 => THUMBNAIL_MAX_DIMENSION,
            n => n.min(THUMBNAIL_MAX_DIMENSION),
        };
        let (w, h) = self.source_size();
        let (tw, th) = resize::fitted_size(w, h, limit);
        let signed = matches!(
            self.source.as_ref(),
            SessionSource::WorkingCopy {
                meta: WorkingCopyMeta::Raw {
                    encoding: Some(WorkingCopyEncoding::SignedGamma18V1 { .. }),
                    ..
                },
                ..
            }
        );
        let mut thumbnail = if signed {
            let mut thumbnail = Session::with_shared_source(Arc::clone(&self.source), self.filter);
            thumbnail.preview_max_dimension = Some(tw.max(th));
            thumbnail.niho3_seed = self.niho3_analysis();
            thumbnail
        } else {
            Session::with_source(self.source.reduced(tw, th, self.filter), self.filter)
        };
        thumbnail.share_niho6_analysis(self);
        thumbnail
    }

    /// Use `parent`'s `niho-6` analysis (the same photo's whole source). A
    /// session made from another one (a preset preview, an auto candidate)
    /// draws every frame at its own exposure: it does not reuse an analysis
    /// while dragging.
    fn share_niho6_analysis(&mut self, parent: &Session) {
        self.niho6_analysis = Arc::clone(&parent.niho6_analysis);
        self.niho6_source = Arc::clone(&parent.niho6_source);
        self.niho6_last_used = None;
        self.niho6_reuse_while_dragging = false;
    }

    /// The `niho-6` analysis of the whole photo at `exposure_ev` (shared: the
    /// features once per photo, the networks again only when the exposure
    /// changes).
    fn niho6_analysis(&self, exposure_ev: f64) -> Result<Arc<niho6::Analysis>, Error> {
        let features = self
            .niho6_analysis
            .features
            .get_or_init(|| {
                niho6::source_features(self.niho6_source.image(), self.niho6_source.space())
                    .map(Arc::new)
                    .map_err(|e| e.to_string())
            })
            .clone()
            .map_err(Error::Niho6Prepare)?;
        let mut cached = self
            .niho6_analysis
            .at_exposure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = exposure_ev.to_bits();
        if cached.as_ref().is_none_or(|(k, _)| *k != key) {
            let made = niho6::analysis_at(&features, exposure_ev)
                .map(Arc::new)
                .map_err(|e| e.to_string());
            *cached = Some((key, made));
        }
        cached
            .as_ref()
            .expect("niho6 analysis")
            .1
            .clone()
            .map_err(Error::Niho6Prepare)
    }

    /// The NIHO 3 analysis this session holds, for a session made from it.
    fn niho3_analysis(&self) -> Option<RawAnalysisSeed> {
        match &self.niho3 {
            Some(prepared) => Some(prepared.analysis.downgrade()),
            None => self.niho3_seed.clone(),
        }
    }

    fn capped_dimension(&self, max_dimension: usize) -> usize {
        match (max_dimension, self.preview_max_dimension) {
            (0, Some(limit)) => limit,
            (requested, Some(limit)) => requested.min(limit),
            (requested, None) => requested,
        }
    }

    fn active_source(&self, niho3: bool) -> &SessionSource {
        if niho3 {
            &self.niho3.as_ref().expect("prepared niho3").source
        } else {
            self.source.as_ref()
        }
    }

    fn niho3_mode(&self, settings: &DevelopSettings) -> Result<Option<RawEngine>, Error> {
        let signed = matches!(
            self.source.as_ref(),
            SessionSource::WorkingCopy {
                meta: WorkingCopyMeta::Raw {
                    encoding: Some(WorkingCopyEncoding::SignedGamma18V1 { .. }),
                    ..
                },
                ..
            }
        );
        let raw = matches!(
            self.source.as_ref(),
            SessionSource::WorkingCopy {
                meta: WorkingCopyMeta::Raw { .. },
                ..
            }
        );
        if settings.engine == settings::ENGINE_NIHO_6 {
            if raw {
                return Err(Error::IncompatibleWorkingCopy(
                    "niho-6 supports JPEG / PNG originals and raster working copies only".into(),
                ));
            }
            return Ok(niho6::uses_response(settings).then_some(RawEngine::Niho6));
        }
        let engine = match settings.engine.as_str() {
            settings::ENGINE_NIHO_3 => Some(RawEngine::Niho3),
            settings::ENGINE_NIHO_4 => Some(RawEngine::Niho4),
            settings::ENGINE_NIHO_5 => Some(RawEngine::Niho4),
            settings::ENGINE_NIHO_7 => Some(RawEngine::Niho4),
            _ => None,
        };
        if signed && engine.is_none() {
            return Err(Error::IncompatibleWorkingCopy(
                "signed-gamma18-v1 requires engine niho-3 or newer signed RAW engine".into(),
            ));
        }
        if raw && engine.is_some() && !signed {
            return Err(Error::IncompatibleWorkingCopy(
                if matches!(
                    settings.engine.as_str(),
                    settings::ENGINE_NIHO_5 | settings::ENGINE_NIHO_7
                ) {
                    format!(
                        "{} RAW requires encoding signed-gamma18-v1",
                        settings.engine
                    )
                } else {
                    "niho-3/niho-4 RAW requires encoding signed-gamma18-v1".into()
                },
            ));
        }
        if matches!(
            settings.engine.as_str(),
            settings::ENGINE_NIHO_4 | settings::ENGINE_NIHO_5 | settings::ENGINE_NIHO_7
        ) && !raw
        {
            return Err(Error::IncompatibleWorkingCopy(format!(
                "{} supports signed RAW working copies only",
                settings.engine
            )));
        }
        if engine == Some(RawEngine::Niho4)
            && self.working_copy_meta().and_then(niho4::camera).is_none()
        {
            return Err(Error::IncompatibleWorkingCopy(format!(
                "{} does not support this camera calibration",
                settings.engine
            )));
        }
        Ok(raw.then_some(engine).flatten())
    }

    fn niho3_preparation_target(
        &self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Option<RawPreparationTarget> {
        if quality != Quality::Interactive
            || max_dimension == 0
            || rendered_geometry(settings).is_some()
        {
            return None;
        }
        let (width, height) = self.source.size();
        let (target_width, target_height) = resize::fitted_size(width, height, max_dimension);
        ((target_width, target_height) != (width, height)).then_some(RawPreparationTarget {
            width: target_width,
            height: target_height,
            filter: self.filter,
        })
    }

    fn ensure_niho3(
        &mut self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<bool, Error> {
        let Some(engine) = self.niho3_mode(settings)? else {
            return Ok(false);
        };
        if engine == RawEngine::Niho6 {
            return self.ensure_niho6(settings, max_dimension, quality);
        }
        let target = self.niho3_preparation_target(settings, max_dimension, quality);
        let (image, meta) = match self.source.as_ref() {
            SessionSource::WorkingCopy { image, meta } => (image, meta),
            SessionSource::Raster(_) => unreachable!(),
        };
        let key = match engine {
            RawEngine::Niho3 => {
                pipeline::niho3_preparation_key(meta, settings, target.map(|value| value.niho3()))
            }
            RawEngine::Niho4 => {
                pipeline::niho4_preparation_key(meta, settings, target.map(|value| value.niho4()))
                    .map_err(|error| Error::Niho4Prepare(error.to_string()))?
            }
            RawEngine::Niho6 => unreachable!("ensure_niho6"),
        };
        if self
            .niho3
            .as_ref()
            .is_none_or(|prepared| prepared.key != key)
        {
            let previous = self.niho3.take();
            let sized = self.sized.take();
            let full = target.is_none();
            // Only the full master these settings release onto is worth
            // keeping: a drag of a master input (WB, EV, H/S, Texture, CNR)
            // drops it before preparing, as a full preparation drops a
            // stale one (one full master in memory).
            let release_key = match (target, engine) {
                (None, _) => key.clone(),
                (Some(_), RawEngine::Niho3) => {
                    pipeline::niho3_preparation_key(meta, settings, None)
                }
                (Some(_), RawEngine::Niho4) => {
                    pipeline::niho4_preparation_key(meta, settings, None)
                        .map_err(|error| Error::Niho4Prepare(error.to_string()))?
                }
                (Some(_), RawEngine::Niho6) => unreachable!("ensure_niho6"),
            };
            self.parked_niho3 = self.parked_niho3.take().filter(|p| p.key == release_key);
            let parked = self.parked_niho3.take_if(|p| p.key == key);
            // Move the source-only analysis cache into the replacement so
            // slider drags do not duplicate its full-resolution CNR source
            // or canonical coefficient maps at peak memory.
            let current = match previous {
                Some(previous) => {
                    if previous.full && !full && previous.key == release_key {
                        self.parked_niho3 = Some(ParkedNiho3 {
                            key: previous.key,
                            source: previous.source,
                            approximate_white_balance: previous.approximate_white_balance,
                            sized,
                        });
                    }
                    Some(previous.analysis)
                }
                None => None,
            };
            let cached_analysis = match current {
                Some(current) if current.serves(engine, image, meta, settings) => Some(current),
                current => self
                    .niho3_seed
                    .as_ref()
                    .and_then(|seed| seed.upgrade(engine))
                    .filter(|seed| seed.serves(engine, image, meta, settings))
                    .or(current),
            };
            match (parked, cached_analysis) {
                (Some(parked), Some(analysis)) => {
                    self.niho3 = Some(PreparedNiho3 {
                        key: parked.key,
                        full: true,
                        source: parked.source,
                        settings: niho3::downstream_settings(settings),
                        approximate_white_balance: parked.approximate_white_balance,
                        analysis,
                    });
                    self.sized = parked.sized;
                }
                (_, cached_analysis) => {
                    let prepared = match engine {
                        RawEngine::Niho3 => {
                            let cached = match cached_analysis {
                                Some(RawAnalysisCache::Niho3(cache)) => Some(cache),
                                _ => None,
                            };
                            let prepared = pipeline::prepare_niho3(
                                image,
                                meta,
                                settings,
                                target.map(|value| value.niho3()),
                                cached,
                            )
                            .map_err(|error| Error::Niho3Prepare(error.to_string()))?;
                            (
                                prepared.image,
                                prepared.meta,
                                prepared.settings,
                                prepared.key,
                                prepared.approximate_white_balance,
                                RawAnalysisCache::Niho3(prepared.analysis),
                            )
                        }
                        RawEngine::Niho4 => {
                            let cached = match cached_analysis {
                                Some(RawAnalysisCache::Niho4(cache)) => Some(cache),
                                _ => None,
                            };
                            let prepared = pipeline::prepare_niho4(
                                image,
                                meta,
                                settings,
                                target.map(|value| value.niho4()),
                                cached,
                            )
                            .map_err(|error| Error::Niho4Prepare(error.to_string()))?;
                            (
                                prepared.image,
                                prepared.meta,
                                prepared.settings,
                                prepared.key,
                                prepared.approximate_white_balance,
                                RawAnalysisCache::Niho4(prepared.analysis),
                            )
                        }
                        RawEngine::Niho6 => unreachable!("ensure_niho6"),
                    };
                    self.niho3 = Some(PreparedNiho3 {
                        key: prepared.3,
                        full,
                        source: SessionSource::WorkingCopy {
                            image: prepared.0,
                            meta: prepared.1,
                        },
                        settings: prepared.2,
                        approximate_white_balance: prepared.4,
                        analysis: prepared.5,
                    });
                }
            }
            self.framed = None;
            self.stats.clear();
            // Post/color/drag cubes depend on their own settings keys, not
            // on the prepared RAW pixels. Keep them across WB/EV/H/S edits.
            self.local = None;
        }
        self.niho3.as_mut().expect("prepared niho3").settings =
            niho3::downstream_settings(settings);
        Ok(true)
    }

    /// The `niho-6` master for these settings: the whole source (Final, a
    /// geometry) or its display-size reduction (unframed reduced
    /// Interactive frames) with the response applied, from the analysis of
    /// the whole photo. One master at a time.
    fn ensure_niho6(
        &mut self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<bool, Error> {
        let target = self.niho3_preparation_target(settings, max_dimension, quality);
        let (w, h) = match target {
            Some(t) => (t.width, t.height),
            None => self.source.size(),
        };
        // While dragging (Interactive) the analysis this session's last frame
        // used serves: making it again for each exposure tick costs the
        // networks every frame. The released frame (Final) uses the exact
        // exposure, as a one-shot render. Only this session's own frames count
        // (preset previews and auto candidates share the cache at their own
        // exposures and do not reuse while dragging).
        let analysis = match (
            quality,
            self.niho6_reuse_while_dragging,
            self.niho6_last_used.clone(),
        ) {
            (Quality::Interactive, true, Some(analysis)) => analysis,
            _ => self.niho6_analysis(niho6::analysis_exposure(settings))?,
        };
        self.niho6_last_used = Some(Arc::clone(&analysis));
        let key = niho6::preparation_key(w, h, settings, analysis.exposure_ev);
        if self
            .niho3
            .as_ref()
            .is_none_or(|prepared| prepared.key != key)
        {
            self.niho3 = None;
            self.parked_niho3 = None;
            self.sized = None;
            let reduced = target.map(|t| self.source.reduced(t.width, t.height, t.filter));
            let base = reduced.as_ref().unwrap_or(self.source.as_ref());
            let image = pipeline::prepare_niho6(base.image(), base.space(), &analysis, settings)
                .map_err(|e| Error::Niho6Prepare(e.to_string()))?;
            self.niho3 = Some(PreparedNiho3 {
                key,
                full: target.is_none(),
                source: self.source.with_image(image),
                settings: settings.clone(),
                approximate_white_balance: false,
                analysis: RawAnalysisCache::Niho6,
            });
            self.framed = None;
            self.stats.clear();
            self.local = None;
        }
        self.niho3.as_mut().expect("prepared niho6").settings = settings.clone();
        Ok(true)
    }

    /// Drops a master of earlier frames when these render from the source
    /// (a `niho-6` photo whose Highlights / Shadows went back to the
    /// directions the response does not take): its reductions, window,
    /// statistics and local pass were of the master.
    fn release_master(&mut self) {
        if self.niho3.take().is_some() {
            self.parked_niho3 = None;
            self.sized = None;
            self.framed = None;
            self.stats.clear();
            self.local = None;
        }
    }

    fn at_size(&mut self, max_dimension: usize, niho3: bool) -> usize {
        let (w, h) = self.active_source(niho3).size();
        let (tw, th) = if max_dimension == 0 {
            (w, h)
        } else {
            resize::fitted_size(w, h, max_dimension)
        };
        let key = tw.max(th);
        if (tw, th) == (w, h) {
            return 0;
        }
        if self.sized.as_ref().map(|(k, _)| *k) != Some(key) {
            let reduced = self.active_source(niho3).reduced(tw, th, self.filter);
            self.sized = Some((key, reduced));
            self.stats.retain(|(k, _, _)| *k != key);
        }
        key
    }

    /// Renders at `max_dimension` (0 = working size; with a geometry, the
    /// cropped frame's size is capped by it and never enlarged,
    /// [`frame::plan`]).
    pub fn render(
        &mut self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<Rendered, Error> {
        let issues = settings.validate();
        if !issues.is_empty() {
            return Err(Error::InvalidSettings(issues));
        }
        let max_dimension = self.capped_dimension(max_dimension);
        let use_niho3 = self.ensure_niho3(settings, max_dimension, quality)?;
        if !use_niho3 {
            self.release_master();
        }
        let render_settings = if use_niho3 {
            self.niho3
                .as_ref()
                .expect("prepared niho3")
                .settings
                .clone()
        } else {
            settings.clone()
        };
        let settings = &render_settings;
        if let Some(g) = rendered_geometry(settings) {
            return self.render_framed(settings, g, max_dimension, quality, use_niho3);
        }
        self.framed = None;
        let key = self.at_size(max_dimension, use_niho3);
        let source = if key == 0 {
            if use_niho3 {
                &self.niho3.as_ref().expect("prepared niho3").source
            } else {
                self.source.as_ref()
            }
        } else {
            &self.sized.as_ref().expect("sized").1
        };
        let mut rendered = match source {
            SessionSource::Raster(raster) => {
                let cached = self
                    .stats
                    .iter()
                    .find(|(k, q, _)| *k == key && *q == quality)
                    .map(|(_, _, s)| *s);
                let (frame, cubes, stats) = pipeline::render_raster_in_session(
                    raster,
                    None,
                    settings,
                    quality,
                    cached,
                    pipeline::RenderCaches::new(
                        self.cubes.as_ref(),
                        &mut self.local,
                        &mut self.effects,
                    ),
                );
                if let (None, Some(s)) = (cached, stats) {
                    self.stats.push((key, quality, s));
                }
                self.cubes = Some(cubes);
                frame
            }
            SessionSource::WorkingCopy { image, meta } => {
                let wc = pipeline::WorkingCopy { image, meta };
                let (frame, cubes) = pipeline::render_working_copy_in_session(
                    &wc,
                    None,
                    settings,
                    quality,
                    self.cubes.as_ref(),
                    &mut self.local,
                    &mut self.effects,
                );
                self.cubes = Some(cubes);
                frame
            }
        };
        if use_niho3
            && self
                .niho3
                .as_ref()
                .is_some_and(|prepared| prepared.approximate_white_balance)
            && !rendered.approximations.contains(&"absoluteWhiteBalance")
        {
            rendered.approximations.push("absoluteWhiteBalance");
        }
        Ok(rendered)
    }

    /// A frame with a geometry: the window's working image (kept while the
    /// geometry and the size stay, in place of the per-size reduction),
    /// the statistics of the whole source, the output cut from the window.
    fn render_framed(
        &mut self,
        settings: &DevelopSettings,
        g: &Geometry,
        max_dimension: usize,
        quality: Quality,
        use_niho3: bool,
    ) -> Result<Rendered, Error> {
        let key = frame::frame_key(g, max_dimension);
        if self.framed.as_ref().is_none_or(|f| f.key != key) {
            // One working image in memory at a time.
            self.framed = None;
            self.sized = None;
            let (w, h) = self.active_source(use_niho3).size();
            let plan = frame::plan(g, w, h, max_dimension).map_err(geometry_error)?;
            let image = (!plan.window_is_source()).then(|| {
                let active = self.active_source(use_niho3);
                let window = frame::working_image(active.image(), &plan, self.filter);
                active.with_image(window)
            });
            self.framed = Some(Framed {
                window_key: format!(
                    "{key}|{}x{}|{:?}",
                    plan.window_width, plan.window_height, plan.output
                ),
                key,
                image,
                plan,
            });
        }
        let framed = self.framed.as_ref().expect("framed");
        let active_source = if use_niho3 {
            &self.niho3.as_ref().expect("prepared niho3").source
        } else {
            self.source.as_ref()
        };
        let framing = pipeline::Framing {
            stats_source: active_source.image(),
            long_edge: framed.plan.scale_long_edge,
            output: framed.plan.output,
            key: &framed.window_key,
        };
        let mut rendered = match framed.image.as_ref().unwrap_or(active_source) {
            SessionSource::Raster(raster) => {
                let cached = self
                    .stats
                    .iter()
                    .find(|(k, q, _)| *k == SOURCE_STATS_KEY && *q == quality)
                    .map(|(_, _, s)| *s);
                let (frame, cubes, stats) = pipeline::render_raster_in_session(
                    raster,
                    Some(&framing),
                    settings,
                    quality,
                    cached,
                    pipeline::RenderCaches::new(
                        self.cubes.as_ref(),
                        &mut self.local,
                        &mut self.effects,
                    ),
                );
                if let (None, Some(s)) = (cached, stats) {
                    self.stats.push((SOURCE_STATS_KEY, quality, s));
                }
                self.cubes = Some(cubes);
                frame
            }
            SessionSource::WorkingCopy { image, meta } => {
                let wc = pipeline::WorkingCopy { image, meta };
                let (frame, cubes) = pipeline::render_working_copy_in_session(
                    &wc,
                    Some(&framing),
                    settings,
                    quality,
                    self.cubes.as_ref(),
                    &mut self.local,
                    &mut self.effects,
                );
                self.cubes = Some(cubes);
                frame
            }
        };
        if use_niho3
            && self
                .niho3
                .as_ref()
                .is_some_and(|prepared| prepared.approximate_white_balance)
            && !rendered.approximations.contains(&"absoluteWhiteBalance")
        {
            rendered.approximations.push("absoluteWhiteBalance");
        }
        Ok(rendered)
    }

    /// "自動" ([`auto`]): these settings with the six Light sliders and
    /// Vibrance set for this photo as they render it (within its crop).
    /// The Session's kept frame state is left as it was.
    pub fn auto_settings(&mut self, settings: &DevelopSettings) -> Result<DevelopSettings, Error> {
        self.auto_outcome(settings).map(|o| o.settings)
    }

    /// [`Session::auto_settings`] with what it measured.
    pub fn auto_outcome(&mut self, settings: &DevelopSettings) -> Result<auto::Outcome, Error> {
        let issues = settings.validate();
        if !issues.is_empty() {
            return Err(Error::InvalidSettings(issues));
        }
        let use_niho3 = self.niho3_mode(settings)?;
        // niho-6: a candidate's Highlights / Shadows need the prepared master.
        if use_niho3.is_some() || settings.engine == settings::ENGINE_NIHO_6 {
            // Auto candidates use an isolated Session so their full-source
            // preparation, canonical 750 analysis, geometry, and rendering
            // are identical to normal NIHO 3 frames without mutating the
            // parent's caches. It shares the parent's analysis (the same
            // source's CNR result and coefficients; coefficients it computes
            // first are the ones the parent would compute).
            let mut isolated = Session::with_shared_source(Arc::clone(&self.source), self.filter);
            isolated.niho3_seed = self.niho3_analysis();
            isolated.share_niho6_analysis(self);
            let raw = use_niho3.is_some_and(|engine| engine != RawEngine::Niho6);
            return auto::try_run(settings, raw, |candidate| {
                isolated.render(candidate, auto::PROXY_LONG_EDGE, auto::PROXY_QUALITY)
            });
        }
        // The proxy: the crop (or the whole photo) at the proxy size from
        // the working image, made here and dropped after.
        let source = self.source.image();
        let (w, h) = (source.width, source.height);
        let plan = match rendered_geometry(settings) {
            Some(g) => Some(frame::plan(g, w, h, auto::PROXY_LONG_EDGE).map_err(geometry_error)?),
            None => None,
        };
        let proxy = match &plan {
            Some(plan) => {
                (!plan.window_is_source()).then(|| frame::working_image(source, plan, self.filter))
            }
            None => {
                let (tw, th) = resize::fitted_size(w, h, auto::PROXY_LONG_EDGE);
                ((tw, th) != (w, h)).then(|| LinearImage {
                    width: tw,
                    height: th,
                    data: resize::resample(&source.data, w, h, tw, th, self.filter),
                })
            }
        };
        let proxy = proxy.map(|image| self.source.with_image(image));
        let image = proxy.as_ref().unwrap_or(self.source.as_ref());
        let framing = plan.as_ref().map(|plan| pipeline::Framing {
            stats_source: source,
            long_edge: plan.scale_long_edge,
            output: plan.output,
            key: "auto",
        });
        let quality = auto::PROXY_QUALITY;
        // Read-only: the Session's cubes and (with a geometry, whose
        // statistics read the whole source) statistics when they match.
        let mut stats = plan.as_ref().and_then(|_| {
            self.stats
                .iter()
                .find(|(k, q, _)| *k == SOURCE_STATS_KEY && *q == quality)
                .map(|(_, _, s)| *s)
        });
        let raw = matches!(
            self.source.as_ref(),
            SessionSource::WorkingCopy {
                meta: WorkingCopyMeta::Raw { .. },
                ..
            }
        );
        let mut cubes = None;
        let mut local = None;
        let mut effects = effects::EffectsCache::default();
        let session_cubes = self.cubes.as_ref();
        Ok(auto::run(settings, raw, |s| {
            let kept = cubes.as_ref().or(session_cubes);
            let (frame, used) = match image {
                SessionSource::Raster(raster) => {
                    let (frame, used, computed) = pipeline::render_raster_in_session(
                        raster,
                        framing.as_ref(),
                        s,
                        quality,
                        stats,
                        pipeline::RenderCaches::new(kept, &mut local, &mut effects),
                    );
                    stats = stats.or(computed);
                    (frame, used)
                }
                SessionSource::WorkingCopy { image, meta } => {
                    pipeline::render_working_copy_in_session(
                        &pipeline::WorkingCopy { image, meta },
                        framing.as_ref(),
                        s,
                        quality,
                        kept,
                        &mut local,
                        &mut effects,
                    )
                }
            };
            cubes = Some(used);
            frame
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_is_rendered_cropped() {
        let crop = r#"{"v":2,"geometry":{"crop":{"left":0.25,"top":0,"right":1,"bottom":1}}}"#;
        let png = encode::encode_png(&[128u8; 8 * 6 * 4], 8, 6).unwrap();
        let options = RenderOptions {
            max_dimension: 0,
            ..Default::default()
        };
        let frame = render(&png, crop, &options).unwrap();
        assert_eq!((frame.width, frame.height), (6, 6));
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let settings = parse_settings(crop).unwrap();
        let framed = session.render(&settings, 0, Quality::Final).unwrap();
        assert_eq!(framed.rgba, frame.rgba);
        assert_eq!(output_size(&settings, 8, 6, 0).unwrap(), (6, 6));
        // An identity geometry renders as none.
        let identity = r#"{"v":2,"geometry":{"rotate":180,"flipH":true,"flipV":true}}"#;
        let whole = render(&png, identity, &options).unwrap();
        assert_eq!((whole.width, whole.height), (8, 6));
        // A turned crop that is not a rectangle is invalid.
        let bad =
            r#"{"v":2,"geometry":{"angle":45,"crop":{"left":0,"top":0.5,"right":1,"bottom":0.5}}}"#;
        match render(&png, bad, &options) {
            Err(Error::InvalidSettings(list)) => assert_eq!(list[0].code, "invalidCrop"),
            other => panic!("expected invalidCrop, got {other:?}"),
        }
    }

    /// What a Session keeps between frames, by identity (the local pass is
    /// checked by its pixels in `tests/auto.rs`).
    fn kept_state(s: &Session) -> impl PartialEq + std::fmt::Debug {
        let image = |src: &SessionSource| src.image().data.as_ptr() as usize;
        let arc = |c: &Option<std::sync::Arc<lut::Cube>>| {
            c.as_ref().map(|c| c.as_ref() as *const _ as usize)
        };
        (
            s.sized.as_ref().map(|(k, src)| (*k, image(src))),
            s.framed.as_ref().map(|f| {
                (
                    f.key.clone(),
                    f.window_key.clone(),
                    f.image.as_ref().map(image),
                )
            }),
            s.stats.iter().map(|(k, q, _)| (*k, *q)).collect::<Vec<_>>(),
            s.cubes.as_ref().map(|c| {
                (
                    c.post_key.clone(),
                    c.color_key.clone(),
                    arc(&c.post),
                    arc(&c.color),
                    c.drag.as_ref().map(|d| d.as_ref() as *const _ as usize),
                )
            }),
            s.local.is_some(),
        )
    }

    #[test]
    fn auto_leaves_the_kept_frame_state_as_it_was() {
        let (w, h) = (960usize, 640usize);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let v = ((i % w) * 255 / w) as u8 / 2 + ((i / w) % 37) as u8;
                [v, v / 2 + 40, 255 - v, 255]
            })
            .collect();
        let png = encode::encode_png(&rgba, w, h).unwrap();
        let mut s = DevelopSettings::neutral();
        s.shadows = 30.0;
        s.vibrance = 10.0;
        let cropped = parse_settings(
            r#"{"v":2,"shadows":30,"vibrance":10,"geometry":{"crop":{"left":0.1,"top":0.2,"right":0.8,"bottom":0.9}}}"#,
        )
        .unwrap();
        for settings in [s, cropped] {
            let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
            session.render(&settings, 600, Quality::Final).unwrap();
            let mut dragged = settings.clone();
            dragged.vibrance += 5.0;
            session.render(&dragged, 600, Quality::Interactive).unwrap();
            let before = kept_state(&session);
            session.auto_settings(&settings).unwrap();
            assert_eq!(kept_state(&session), before);
        }
    }

    #[test]
    fn niho6_dragging_reuses_this_sessions_analysis_not_a_previews() {
        let (w, h) = (480usize, 320usize);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let v = ((i % w) * 255 / w) as u8 / 2 + ((i / w) % 37) as u8;
                [v, v / 2 + 40, 255 - v, 255]
            })
            .collect();
        let png = encode::encode_png(&rgba, w, h).unwrap();
        let settings =
            parse_settings(r#"{"v":2,"engine":"niho-6","highlights":-40,"shadows":30}"#).unwrap();
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        session.render(&settings, 600, Quality::Final).unwrap();
        let exposure_of = |s: &Session| s.niho6_last_used.as_ref().map(|a| a.exposure_ev);
        assert_eq!(exposure_of(&session), Some(0.0));

        // A preset preview at another exposure analyses at its own exposure (the
        // shared cache now holds it) and does not reuse while dragging.
        let mut preview = session.thumbnail(160);
        let mut brighter = settings.clone();
        brighter.exposure = 1.0;
        preview
            .render(&brighter, 160, Quality::Interactive)
            .unwrap();
        assert_eq!(exposure_of(&preview), Some(1.0));
        assert!(!preview.niho6_reuse_while_dragging);

        // Dragging in the photo keeps using the analysis of its own last frame,
        // not the preview's.
        let mut dragged = settings.clone();
        dragged.vibrance = 10.0;
        session.render(&dragged, 600, Quality::Interactive).unwrap();
        assert_eq!(exposure_of(&session), Some(0.0));
    }

    #[test]
    fn before_settings_keep_the_frame_and_drop_the_colors() {
        let edited = r#"{"v":2,"engine":"niho-1","base":"b1","exposure":1.5,"shadows":40,"hsl":{"red":{"hue":10}},"geometry":{"rotate":90,"crop":{"left":0.1,"top":0,"right":1,"bottom":1}}}"#;
        let before = parse_settings(&before_settings(edited).unwrap()).unwrap();
        let s = parse_settings(edited).unwrap();
        assert!(before.is_neutral());
        assert_eq!(
            (before.v, &before.base, &before.geometry),
            (2, &s.base, &s.geometry)
        );
        assert_eq!((before.engine, before.look), (s.engine, s.look));
    }
}
