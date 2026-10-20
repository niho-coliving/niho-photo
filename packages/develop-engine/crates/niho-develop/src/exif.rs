//! The EXIF an exported JPEG carries (F7 #17127, Epic #17114 Decision 10):
//! the capture date and time, orientation 1 and sRGB. Nothing else: no
//! location, no camera, no maker notes. Without the capture date, the
//! iPhone Photos library sorts an exported photo by the day it was saved.
//!
//! [`with_capture_exif`] puts one APP1 `Exif` segment into a baseline JPEG
//! (the crate's own encoder or a browser canvas), after SOI and JFIF APP0,
//! and drops any EXIF segment already there; without a capture time it only
//! drops them (no EXIF at all). The TIFF is little endian:
//!
//! - IFD0: `Orientation` (1), `YCbCrPositioning` (1), `ExifIFDPointer`
//! - Exif IFD: `ExifVersion` ("0232"), `DateTimeOriginal`,
//!   `OffsetTimeOriginal`, `ComponentsConfiguration` (YCbCr),
//!   `SubSecTimeOriginal` (milliseconds, when not 0), `ColorSpace` (1 =
//!   sRGB), `FlashpixVersion` ("0100"), `PixelXDimension` / `PixelYDimension`
//!   (from the frame header)
//!
//! (the tags EXIF 2.32 requires of a compressed JPEG, so `exiftool
//! -validate` reports nothing).
//!
//! The capture time is an instant (the photo row's `capturedAt`, UTC) shown
//! at an offset the caller picks (the photo's own offset is not kept; NIHO
//! reads EXIF without one as Japan time), written as that local clock time
//! with its `OffsetTimeOriginal`.

use std::fmt;

/// The capture time of an export: an instant and the UTC offset to show it
/// at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureTime {
    /// Milliseconds since 1970-01-01T00:00:00Z.
    pub epoch_ms: i64,
    /// Offset from UTC in minutes (Japan: 540).
    pub offset_minutes: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExifError {
    /// The input is not a JPEG (no SOI) or a segment runs past the end.
    NotJpeg,
    /// `capturedAt` is not an ISO 8601 date-time with seconds.
    InvalidDateTime(String),
    /// The offset is outside -14:00..+14:00 or the year outside 1..9999.
    OutOfRange,
}

impl fmt::Display for ExifError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExifError::NotJpeg => write!(f, "input is not a baseline JPEG"),
            ExifError::InvalidDateTime(s) => write!(f, "not an ISO 8601 date-time: {s}"),
            ExifError::OutOfRange => write!(f, "capture time or offset out of range"),
        }
    }
}

impl std::error::Error for ExifError {}

const MAX_OFFSET_MINUTES: i32 = 14 * 60;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number (`civil_from_days`).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

impl CaptureTime {
    /// Reads an ISO 8601 date-time with seconds (`2026-09-17T02:12:59Z`,
    /// fractional seconds and a `±HH:MM` offset allowed; without a zone it
    /// is UTC), shown at `offset_minutes`.
    pub fn from_iso(text: &str, offset_minutes: i32) -> Result<Self, ExifError> {
        let bad = || ExifError::InvalidDateTime(text.to_string());
        let b = text.trim().as_bytes();
        let digits = |range: std::ops::Range<usize>| -> Result<i64, ExifError> {
            let part = b.get(range).ok_or_else(bad)?;
            if part.is_empty() || !part.iter().all(u8::is_ascii_digit) {
                return Err(bad());
            }
            Ok(part.iter().fold(0i64, |n, c| n * 10 + i64::from(c - b'0')))
        };
        let expect = |i: usize, c: u8| -> Result<(), ExifError> {
            (b.get(i) == Some(&c)).then_some(()).ok_or_else(bad)
        };
        let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
        expect(4, b'-')?;
        expect(7, b'-')?;
        if !matches!(b.get(10), Some(b'T' | b't' | b' ')) {
            return Err(bad());
        }
        let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
        expect(13, b':')?;
        expect(16, b':')?;
        let mut i = 19;
        let mut millis = 0i64;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut end = start;
            while b.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return Err(bad());
            }
            // Milliseconds: the first three digits, padded.
            for k in 0..3 {
                millis = millis * 10
                    + b.get(start + k)
                        .filter(|_| start + k < end)
                        .map_or(0, |c| i64::from(c - b'0'));
            }
            i = end;
        }
        let zone_minutes = match b.get(i) {
            None => 0,
            Some(b'Z' | b'z') if i + 1 == b.len() => 0,
            Some(sign @ (b'+' | b'-')) if i + 6 == b.len() => {
                expect(i + 3, b':')?;
                let hours = digits(i + 1..i + 3)?;
                let minutes = digits(i + 4..i + 6)?;
                if minutes > 59 || hours > 14 || (hours == 14 && minutes != 0) {
                    return Err(bad());
                }
                let m = hours * 60 + minutes;
                if *sign == b'-' {
                    -m
                } else {
                    m
                }
            }
            _ => return Err(bad()),
        };
        if !(1..=12).contains(&month)
            || day < 1
            || day > days_in_month(year, month)
            || hour > 23
            || minute > 59
            || second > 59
        {
            return Err(bad());
        }
        let local_seconds =
            days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
        let time = Self {
            epoch_ms: (local_seconds - zone_minutes * 60) * 1000 + millis,
            offset_minutes,
        };
        time.validate()?;
        Ok(time)
    }

    fn validate(&self) -> Result<(), ExifError> {
        if self.offset_minutes.abs() > MAX_OFFSET_MINUTES {
            return Err(ExifError::OutOfRange);
        }
        let (year, ..) = self.local_fields();
        if !(1..=9999).contains(&year) {
            return Err(ExifError::OutOfRange);
        }
        Ok(())
    }

    /// (year, month, day, hour, minute, second, millisecond) at the offset.
    fn local_fields(&self) -> (i64, i64, i64, i64, i64, i64, i64) {
        let local_ms = self.epoch_ms + i64::from(self.offset_minutes) * 60_000;
        let millis = local_ms.rem_euclid(1000);
        let seconds = local_ms.div_euclid(1000);
        let (days, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
        let (y, m, d) = civil_from_days(days);
        (
            y,
            m,
            d,
            of_day / 3600,
            of_day / 60 % 60,
            of_day % 60,
            millis,
        )
    }

    /// `DateTimeOriginal`: `YYYY:MM:DD HH:MM:SS` at the offset.
    pub fn date_time_original(&self) -> String {
        let (y, mo, d, h, mi, s, _) = self.local_fields();
        format!("{y:04}:{mo:02}:{d:02} {h:02}:{mi:02}:{s:02}")
    }

    /// `SubSecTimeOriginal` (milliseconds), `None` on a whole second.
    pub fn sub_sec_time_original(&self) -> Option<String> {
        let ms = self.local_fields().6;
        (ms != 0).then(|| format!("{ms:03}"))
    }

    /// `OffsetTimeOriginal`: `±HH:MM`.
    pub fn offset_time_original(&self) -> String {
        let sign = if self.offset_minutes < 0 { '-' } else { '+' };
        let m = self.offset_minutes.unsigned_abs();
        format!("{sign}{:02}:{:02}", m / 60, m % 60)
    }
}

const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_UNDEFINED: u16 = 7;

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    /// The value bytes (inline when 4 bytes or fewer).
    data: Vec<u8>,
}

fn ascii(tag: u16, text: &str) -> Entry {
    let mut data = text.as_bytes().to_vec();
    data.push(0);
    Entry {
        tag,
        kind: TYPE_ASCII,
        count: data.len() as u32,
        data,
    }
}

fn short(tag: u16, value: u16) -> Entry {
    Entry {
        tag,
        kind: TYPE_SHORT,
        count: 1,
        data: value.to_le_bytes().to_vec(),
    }
}

/// Writes one IFD at `offset` (from the TIFF header) with its out-of-line
/// values right after it; returns the bytes. Entries must be sorted by tag.
fn ifd(entries: &[Entry], offset: u32) -> Vec<u8> {
    let table = 2 + entries.len() * 12 + 4;
    let mut extra: Vec<u8> = Vec::new();
    let mut out = Vec::with_capacity(table + 64);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for e in entries {
        out.extend_from_slice(&e.tag.to_le_bytes());
        out.extend_from_slice(&e.kind.to_le_bytes());
        out.extend_from_slice(&e.count.to_le_bytes());
        if e.data.len() <= 4 {
            let mut inline = [0u8; 4];
            inline[..e.data.len()].copy_from_slice(&e.data);
            out.extend_from_slice(&inline);
        } else {
            let at = offset + table as u32 + extra.len() as u32;
            out.extend_from_slice(&at.to_le_bytes());
            extra.extend_from_slice(&e.data);
            if extra.len() % 2 == 1 {
                extra.push(0);
            }
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&extra);
    out
}

fn long(tag: u16, value: u32) -> Entry {
    Entry {
        tag,
        kind: TYPE_LONG,
        count: 1,
        data: value.to_le_bytes().to_vec(),
    }
}

/// The APP1 payload (`Exif\0\0` + TIFF) of a `width x height` export.
pub fn exif_payload(capture: Option<&CaptureTime>, width: u32, height: u32) -> Vec<u8> {
    const IFD0_OFFSET: u32 = 8;
    // IFD0: Orientation, YCbCrPositioning, ExifIFDPointer (all inline).
    let ifd0_len = 2 + 3 * 12 + 4;
    let exif_offset = IFD0_OFFSET + ifd0_len as u32;
    let ifd0 = ifd(
        &[
            short(0x0112, 1),
            short(0x0213, 1),
            Entry {
                tag: 0x8769,
                kind: TYPE_LONG,
                count: 1,
                data: exif_offset.to_le_bytes().to_vec(),
            },
        ],
        IFD0_OFFSET,
    );
    let mut exif_entries = vec![Entry {
        tag: 0x9000,
        kind: TYPE_UNDEFINED,
        count: 4,
        data: b"0232".to_vec(),
    }];
    if let Some(t) = capture {
        exif_entries.push(ascii(0x9003, &t.date_time_original()));
        exif_entries.push(ascii(0x9011, &t.offset_time_original()));
        if let Some(sub) = t.sub_sec_time_original() {
            exif_entries.push(ascii(0x9291, &sub));
        }
    }
    exif_entries.push(Entry {
        tag: 0x9101,
        kind: TYPE_UNDEFINED,
        count: 4,
        data: vec![1, 2, 3, 0],
    });
    exif_entries.push(short(0xA001, 1));
    exif_entries.push(Entry {
        tag: 0xA000,
        kind: TYPE_UNDEFINED,
        count: 4,
        data: b"0100".to_vec(),
    });
    exif_entries.push(long(0xA002, width));
    exif_entries.push(long(0xA003, height));
    exif_entries.sort_by_key(|e| e.tag);
    let exif_ifd = ifd(&exif_entries, exif_offset);
    let mut out = b"Exif\0\0".to_vec();
    out.extend_from_slice(b"II*\0");
    out.extend_from_slice(&IFD0_OFFSET.to_le_bytes());
    out.extend_from_slice(&ifd0);
    out.extend_from_slice(&exif_ifd);
    out
}

/// The frame size from the first SOF segment.
fn marker_code(jpeg: &[u8], start: usize) -> Option<(usize, u8)> {
    if jpeg.get(start) != Some(&0xFF) {
        return None;
    }
    let mut code = start + 1;
    while jpeg.get(code) == Some(&0xFF) {
        code += 1;
    }
    let marker = *jpeg.get(code)?;
    (marker != 0).then_some((code, marker))
}

fn segment_end(jpeg: &[u8], marker_code: usize, marker: u8) -> Option<usize> {
    if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
        return marker_code.checked_add(1);
    }
    let length_start = marker_code.checked_add(1)?;
    let length_bytes = jpeg.get(length_start..length_start.checked_add(2)?)?;
    let length = usize::from(u16::from_be_bytes([length_bytes[0], length_bytes[1]]));
    if length < 2 {
        return None;
    }
    let end = length_start.checked_add(length)?;
    (end <= jpeg.len()).then_some(end)
}

fn frame_size(jpeg: &[u8]) -> Result<(u32, u32), ExifError> {
    let mut pos = 2;
    while pos < jpeg.len() {
        let Some((marker_code, marker)) = marker_code(jpeg, pos) else {
            break;
        };
        if marker == 0xDA {
            break;
        }
        let Some(end) = segment_end(jpeg, marker_code, marker) else {
            break;
        };
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof && end.saturating_sub(marker_code + 3) >= 5 {
            let s = &jpeg[marker_code + 3..end];
            let height = u32::from(u16::from_be_bytes([s[1], s[2]]));
            let width = u32::from(u16::from_be_bytes([s[3], s[4]]));
            return Ok((width, height));
        }
        pos = end;
    }
    Err(ExifError::NotJpeg)
}

fn is_exif_app1(segment: &[u8], marker_offset: usize) -> bool {
    segment.get(marker_offset) == Some(&0xE1)
        && segment.get(marker_offset + 3..marker_offset + 9) == Some(&b"Exif\0\0"[..])
}

/// `jpeg` with one EXIF segment ([`exif_payload`]) after SOI and JFIF APP0
/// when `capture` is given, and without EXIF otherwise; any earlier EXIF
/// segment (location, camera) is removed either way. Other segments and the
/// scan are copied unchanged.
pub fn with_capture_exif(jpeg: &[u8], capture: Option<&CaptureTime>) -> Result<Vec<u8>, ExifError> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err(ExifError::NotJpeg);
    }
    let (width, height) = frame_size(jpeg)?;
    let app1 = match capture {
        Some(capture) => {
            let payload = exif_payload(Some(capture), width, height);
            let length = u16::try_from(payload.len() + 2).map_err(|_| ExifError::OutOfRange)?;
            let mut app1 = vec![0xFF, 0xE1];
            app1.extend_from_slice(&length.to_be_bytes());
            app1.extend_from_slice(&payload);
            app1
        }
        None => Vec::new(),
    };

    let mut out = Vec::with_capacity(jpeg.len() + app1.len());
    out.extend_from_slice(&jpeg[..2]);
    let mut pos = 2;
    let mut inserted = false;
    // Marker segments up to the start of scan; everything from SOS on is
    // copied as is.
    while pos < jpeg.len() {
        let Some((marker_code, marker)) = marker_code(jpeg, pos) else {
            break;
        };
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let Some(end) = segment_end(jpeg, marker_code, marker) else {
            return Err(ExifError::NotJpeg);
        };
        let segment = &jpeg[pos..end];
        let marker_offset = marker_code - pos;
        let payload_start = marker_offset + 3;
        let is_jfif =
            marker == 0xE0 && segment.get(payload_start..payload_start + 5) == Some(&b"JFIF\0"[..]);
        if !inserted && !is_jfif {
            out.extend_from_slice(&app1);
            inserted = true;
        }
        if !is_exif_app1(segment, marker_offset) {
            out.extend_from_slice(segment);
        }
        pos = end;
    }
    if !inserted {
        out.extend_from_slice(&app1);
    }
    out.extend_from_slice(&jpeg[pos..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (tag, type, count, value bytes) of each entry of an IFD.
    type Ifd = Vec<(u16, u16, u32, Vec<u8>)>;

    fn sample_jpeg(width: usize, height: usize) -> Vec<u8> {
        let rgba: Vec<u8> = (0..width * height)
            .flat_map(|i| [(i * 7 % 256) as u8, (i * 13 % 256) as u8, 128, 255])
            .collect();
        crate::encode::encode_jpeg(&rgba, width, height, 90).expect("encode")
    }

    /// The APP1 `Exif` payloads (after `Exif\0\0`) of a JPEG.
    fn exif_segments(jpeg: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut pos = 2;
        while pos < jpeg.len() {
            let Some((marker_code, marker)) = marker_code(jpeg, pos) else {
                break;
            };
            if marker == 0xDA || marker == 0xD9 {
                break;
            }
            let Some(end) = segment_end(jpeg, marker_code, marker) else {
                break;
            };
            let segment = &jpeg[pos..end];
            let marker_offset = marker_code - pos;
            if is_exif_app1(segment, marker_offset) {
                out.push(segment[marker_offset + 9..].to_vec());
            }
            pos = end;
        }
        out
    }

    /// Tag -> (type, count, value bytes) of the IFD at `offset` in a
    /// little-endian TIFF.
    fn read_ifd(tiff: &[u8], offset: usize) -> Ifd {
        let u16_at = |p: usize| u16::from_le_bytes([tiff[p], tiff[p + 1]]);
        let u32_at =
            |p: usize| u32::from_le_bytes([tiff[p], tiff[p + 1], tiff[p + 2], tiff[p + 3]]);
        let n = usize::from(u16_at(offset));
        (0..n)
            .map(|k| {
                let e = offset + 2 + k * 12;
                let (tag, kind, count) = (u16_at(e), u16_at(e + 2), u32_at(e + 4));
                let size = match kind {
                    TYPE_SHORT => 2,
                    TYPE_LONG => 4,
                    _ => 1,
                } * count as usize;
                let data = if size <= 4 {
                    tiff[e + 8..e + 8 + size].to_vec()
                } else {
                    let at = u32_at(e + 8) as usize;
                    tiff[at..at + size].to_vec()
                };
                (tag, kind, count, data)
            })
            .collect()
    }

    /// (IFD0, Exif IFD) of an export.
    fn tags(jpeg: &[u8]) -> (Ifd, Ifd) {
        let segments = exif_segments(jpeg);
        assert_eq!(segments.len(), 1, "one EXIF segment");
        let tiff = &segments[0];
        assert_eq!(&tiff[..4], b"II*\0");
        let ifd0 = read_ifd(
            tiff,
            u32::from_le_bytes([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize,
        );
        let pointer = ifd0.iter().find(|t| t.0 == 0x8769).expect("ExifIFDPointer");
        let exif_offset = u32::from_le_bytes(pointer.3[..4].try_into().unwrap()) as usize;
        (ifd0, read_ifd(tiff, exif_offset))
    }

    fn ascii_tag(ifd: &Ifd, tag: u16) -> Option<String> {
        ifd.iter().find(|t| t.0 == tag).map(|t| {
            assert_eq!(t.1, TYPE_ASCII);
            String::from_utf8(t.3[..t.3.len() - 1].to_vec()).unwrap()
        })
    }

    fn at(iso: &str, offset: i32) -> CaptureTime {
        CaptureTime::from_iso(iso, offset).unwrap()
    }

    #[test]
    fn capture_time_is_shown_at_the_offset() {
        let t = at("2026-09-17T02:12:59Z", 540);
        assert_eq!(t.date_time_original(), "2026:09:17 11:12:59");
        assert_eq!(t.offset_time_original(), "+09:00");
        assert_eq!(t.sub_sec_time_original(), None);
        assert_eq!(at("2026-09-17T11:12:59+09:00", 540), t);
        assert_eq!(at("2026-09-17 02:12:59", 540), t);
        let ms = at("2026-09-17T02:12:59.12Z", 540);
        assert_eq!(ms.sub_sec_time_original().as_deref(), Some("120"));
        assert_eq!(
            at("2026-09-17T02:12:59.123456Z", 540)
                .sub_sec_time_original()
                .as_deref(),
            Some("123")
        );
        // Across midnight and the year; negative offsets.
        assert_eq!(
            at("2026-12-31T20:00:00Z", 540).date_time_original(),
            "2027:01:01 05:00:00"
        );
        let west = at("2026-01-01T02:00:00Z", -300);
        assert_eq!(west.date_time_original(), "2025:12:31 21:00:00");
        assert_eq!(west.offset_time_original(), "-05:00");
        assert_eq!(
            at("2026-03-01T00:30:00Z", 330).offset_time_original(),
            "+05:30"
        );
        assert_eq!(
            at("2028-02-29T12:00:00Z", 0).date_time_original(),
            "2028:02:29 12:00:00"
        );
        assert_eq!(
            at("1969-12-31T23:59:59.5Z", 0).date_time_original(),
            "1969:12:31 23:59:59"
        );
    }

    #[test]
    fn invalid_capture_times_are_rejected() {
        for bad in [
            "",
            "2026-09-17",
            "2026-09-17T02:12Z",
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-09-17T24:00:00Z",
            "2026-09-17T02:12:59+0900",
            "2026-09-17T02:12:59+09:99",
            "2026-09-17T02:12:59+99:00",
            "2026-09-17T02:12:59+14:01",
            "2026-09-17T02:12:59-14:30",
            "2026-09-17T02:12:59.Z",
            "2026/09/17T02:12:59Z",
            "2026-09-17T02:12:59Zjunk",
        ] {
            assert!(
                matches!(
                    CaptureTime::from_iso(bad, 540),
                    Err(ExifError::InvalidDateTime(_))
                ),
                "{bad}"
            );
        }
        assert_eq!(
            CaptureTime::from_iso("2026-09-17T02:12:59Z", 15 * 60),
            Err(ExifError::OutOfRange)
        );
        assert!(CaptureTime::from_iso("2026-09-17T02:12:59+14:00", 0).is_ok());
    }

    #[test]
    fn export_carries_the_capture_date_orientation_and_srgb_only() {
        let input = sample_jpeg(40, 24);
        let out = with_capture_exif(&input, Some(&at("2026-09-17T02:12:59.5Z", 540))).unwrap();
        let (ifd0, exif) = tags(&out);
        let ids = |ifd: &Ifd| ifd.iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(ids(&ifd0), [0x0112, 0x0213, 0x8769]);
        assert_eq!(
            ids(&exif),
            [0x9000, 0x9003, 0x9011, 0x9101, 0x9291, 0xA000, 0xA001, 0xA002, 0xA003]
        );
        assert_eq!(ifd0[0].3, 1u16.to_le_bytes());
        assert_eq!(
            ascii_tag(&exif, 0x9003).as_deref(),
            Some("2026:09:17 11:12:59")
        );
        assert_eq!(ascii_tag(&exif, 0x9011).as_deref(), Some("+09:00"));
        assert_eq!(ascii_tag(&exif, 0x9291).as_deref(), Some("500"));
        let flashpix = exif.iter().find(|t| t.0 == 0xA000).unwrap();
        assert_eq!(flashpix.1, TYPE_UNDEFINED);
        assert_eq!(flashpix.2, 4);
        assert_eq!(flashpix.3, b"0100");
        let value = |tag: u16| exif.iter().find(|t| t.0 == tag).unwrap().3.clone();
        assert_eq!(value(0xA001), 1u16.to_le_bytes());
        assert_eq!(value(0xA002), 40u32.to_le_bytes());
        assert_eq!(value(0xA003), 24u32.to_le_bytes());
        // JFIF APP0 stays right after SOI; the EXIF segment follows it.
        assert_eq!(&out[..4], &[0xFF, 0xD8, 0xFF, 0xE0]);
        let app0_len = usize::from(u16::from_be_bytes([out[4], out[5]]));
        assert_eq!(&out[4 + app0_len..4 + app0_len + 2], &[0xFF, 0xE1]);
        // The scan is untouched: the same pixels.
        let a = image::load_from_memory(&input).unwrap().to_rgb8();
        let b = image::load_from_memory(&out).unwrap().to_rgb8();
        assert_eq!(a.as_raw(), b.as_raw());
    }

    #[test]
    fn marker_fill_bytes_are_skipped_and_preserved() {
        let mut input = sample_jpeg(12, 8);
        assert_eq!(&input[2..4], &[0xFF, 0xE0]);
        input.insert(3, 0xFF);

        let out = with_capture_exif(&input, Some(&at("2026-09-17T02:12:59Z", 540))).unwrap();

        assert_eq!(&out[2..5], &[0xFF, 0xFF, 0xE0]);
        assert_eq!(exif_segments(&out).len(), 1);
        let (_, exif) = tags(&out);
        assert!(exif.iter().any(|tag| tag.0 == 0xA000));
    }

    #[test]
    fn without_a_capture_time_no_exif_is_written() {
        let input = sample_jpeg(8, 8);
        let out = with_capture_exif(&input, None).unwrap();
        assert!(exif_segments(&out).is_empty());
        assert_eq!(out, input);
        // An earlier EXIF is still removed.
        let dated = with_capture_exif(&input, Some(&at("2026-01-01T00:00:00Z", 540))).unwrap();
        assert_eq!(with_capture_exif(&dated, None).unwrap(), input);
    }

    #[test]
    fn an_earlier_exif_with_location_and_camera_is_replaced() {
        let input = sample_jpeg(16, 16);
        // An APP1 EXIF with Make and a GPS IFD pointer, after APP0.
        let mut tiff = b"II*\0".to_vec();
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&ifd(
            &[
                ascii(0x010F, "Panasonic"),
                Entry {
                    tag: 0x8825,
                    kind: TYPE_LONG,
                    count: 1,
                    data: 0u32.to_le_bytes().to_vec(),
                },
            ],
            8,
        ));
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        app1.extend_from_slice(&payload);
        let app0_end = 4 + usize::from(u16::from_be_bytes([input[4], input[5]]));
        let mut with_old = input[..app0_end].to_vec();
        with_old.extend_from_slice(&app1);
        with_old.extend_from_slice(&input[app0_end..]);
        assert_eq!(exif_segments(&with_old).len(), 1);

        let out = with_capture_exif(&with_old, Some(&at("2026-01-01T00:00:00Z", 540))).unwrap();
        let (ifd0, exif) = tags(&out);
        assert!(ifd0
            .iter()
            .chain(&exif)
            .all(|t| !matches!(t.0, 0x010F | 0x0110 | 0x8825)));
        // Applying it twice keeps one segment.
        let again = with_capture_exif(&out, Some(&at("2026-01-01T00:00:00Z", 540))).unwrap();
        assert_eq!(again, out);
    }

    #[test]
    fn non_jpeg_input_is_rejected() {
        assert_eq!(
            with_capture_exif(b"\x89PNG\r\n", None),
            Err(ExifError::NotJpeg)
        );
        let mut truncated = sample_jpeg(8, 8);
        truncated.truncate(12);
        assert_eq!(with_capture_exif(&truncated, None), Err(ExifError::NotJpeg));
    }
}
