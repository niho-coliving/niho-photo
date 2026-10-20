//! Minimal TIFF container (one IFD) for DCP files, and a reader for TIFF-like files
//! (DCP, DNG/TIFF, RW2). The reader follows DNG SubIFD pointers for raw metadata only.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};

pub const TYPE_BYTE: u16 = 1;
pub const TYPE_ASCII: u16 = 2;
pub const TYPE_SHORT: u16 = 3;
pub const TYPE_LONG: u16 = 4;
pub const TYPE_RATIONAL: u16 = 5;
pub const TYPE_SBYTE: u16 = 6;
pub const TYPE_UNDEFINED: u16 = 7;
pub const TYPE_SSHORT: u16 = 8;
pub const TYPE_SLONG: u16 = 9;
pub const TYPE_SRATIONAL: u16 = 10;
pub const TYPE_FLOAT: u16 = 11;
pub const TYPE_DOUBLE: u16 = 12;

/// TIFF magic of a DNG camera profile file ("IIRC" when little-endian).
pub const MAGIC_DCP: u16 = 0x4352;
/// Classic TIFF / DNG magic.
pub const MAGIC_TIFF: u16 = 42;
/// Panasonic RW2 magic ("IIU\0").
pub const MAGIC_RW2: u16 = 0x55;

/// A value to write.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Ascii(String),
    Short(Vec<u16>),
    Long(Vec<u32>),
    SRational(Vec<(i32, i32)>),
    Float(Vec<f32>),
}

impl Value {
    fn type_code(&self) -> u16 {
        match self {
            Value::Ascii(_) => TYPE_ASCII,
            Value::Short(_) => TYPE_SHORT,
            Value::Long(_) => TYPE_LONG,
            Value::SRational(_) => TYPE_SRATIONAL,
            Value::Float(_) => TYPE_FLOAT,
        }
    }

    fn count(&self) -> usize {
        match self {
            Value::Ascii(s) => s.len() + 1,
            Value::Short(v) => v.len(),
            Value::Long(v) => v.len(),
            Value::SRational(v) => v.len(),
            Value::Float(v) => v.len(),
        }
    }

    fn bytes_le(&self) -> Vec<u8> {
        let mut out = Vec::new();
        match self {
            Value::Ascii(s) => {
                out.extend_from_slice(s.as_bytes());
                out.push(0);
            }
            Value::Short(v) => v
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Value::Long(v) => v
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Value::SRational(v) => v.iter().for_each(|(n, d)| {
                out.extend_from_slice(&n.to_le_bytes());
                out.extend_from_slice(&d.to_le_bytes());
            }),
            Value::Float(v) => v
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
        }
        out
    }
}

/// Write a little-endian TIFF with a single IFD holding `entries` (sorted by tag on output).
/// Deterministic: the same entries always give the same bytes.
pub fn write_single_ifd_le(magic: u16, entries: &[(u16, Value)]) -> Result<Vec<u8>> {
    let mut sorted: Vec<&(u16, Value)> = entries.iter().collect();
    sorted.sort_by_key(|(tag, _)| *tag);
    for pair in sorted.windows(2) {
        if pair[0].0 == pair[1].0 {
            bail!("duplicate TIFF tag 0x{:04X}", pair[0].0);
        }
    }
    let n = sorted.len();
    let ifd_offset = 8usize;
    let ifd_len = 2 + 12 * n + 4;
    let mut data_offset = ifd_offset + ifd_len;
    let mut out = Vec::with_capacity(data_offset + 1024);
    out.extend_from_slice(b"II");
    out.extend_from_slice(&magic.to_le_bytes());
    out.extend_from_slice(&(ifd_offset as u32).to_le_bytes());
    out.extend_from_slice(&(n as u16).to_le_bytes());
    let mut blobs: Vec<(usize, Vec<u8>)> = Vec::new();
    for (tag, value) in &sorted {
        let bytes = value.bytes_le();
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&value.type_code().to_le_bytes());
        out.extend_from_slice(
            &u32::try_from(value.count())
                .context("TIFF value too long")?
                .to_le_bytes(),
        );
        if bytes.len() <= 4 {
            let mut inline = [0u8; 4];
            inline[..bytes.len()].copy_from_slice(&bytes);
            out.extend_from_slice(&inline);
        } else {
            data_offset = (data_offset + 3) & !3; // word (and float) alignment
            out.extend_from_slice(
                &u32::try_from(data_offset)
                    .context("TIFF too large")?
                    .to_le_bytes(),
            );
            let len = bytes.len();
            blobs.push((data_offset, bytes));
            data_offset += len;
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
    for (offset, bytes) in blobs {
        out.resize(offset, 0);
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

/// One entry of a parsed IFD: TIFF type, count and the raw value bytes (file byte order).
#[derive(Clone, Debug)]
pub struct RawEntry {
    pub typ: u16,
    pub count: usize,
    pub data: Vec<u8>,
}

/// The first IFD of a TIFF-like file.
#[derive(Clone, Debug)]
pub struct Ifd {
    pub little_endian: bool,
    pub magic: u16,
    pub entries: BTreeMap<u16, RawEntry>,
}

fn type_size(typ: u16) -> Option<usize> {
    Some(match typ {
        TYPE_BYTE | TYPE_ASCII | TYPE_SBYTE | TYPE_UNDEFINED => 1,
        TYPE_SHORT | TYPE_SSHORT => 2,
        TYPE_LONG | TYPE_SLONG | TYPE_FLOAT | 13 => 4,
        TYPE_RATIONAL | TYPE_SRATIONAL | TYPE_DOUBLE => 8,
        _ => return None,
    })
}

struct Reader<'a> {
    bytes: &'a [u8],
    le: bool,
}

impl Reader<'_> {
    fn slice(&self, offset: usize, len: usize) -> Result<&[u8]> {
        let end = offset.checked_add(len).context("TIFF offset overflow")?;
        self.bytes.get(offset..end).with_context(|| {
            format!(
                "TIFF data out of range ({offset}+{len} > {})",
                self.bytes.len()
            )
        })
    }
    fn u16_at(&self, offset: usize) -> Result<u16> {
        let b = self.slice(offset, 2)?;
        Ok(if self.le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }
    fn u32_at(&self, offset: usize) -> Result<u32> {
        let b = self.slice(offset, 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Ok(if self.le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    }
}

/// Parse the first IFD. Accepts classic TIFF/DNG (42), DCP (0x4352) and RW2 (0x55) magics, in
/// either byte order. Entries with unknown types are skipped.
pub fn read_first_ifd(bytes: &[u8]) -> Result<Ifd> {
    if bytes.len() < 8 {
        bail!("file too short for a TIFF header");
    }
    let le = match &bytes[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => bail!("not a TIFF-based file (no II/MM byte order mark)"),
    };
    let r = Reader { bytes, le };
    let magic = r.u16_at(2)?;
    if magic != MAGIC_TIFF && magic != MAGIC_DCP && magic != MAGIC_RW2 {
        bail!("unsupported TIFF magic 0x{magic:04X}");
    }
    let ifd_offset = r.u32_at(4)? as usize;
    read_ifd_at(&r, magic, ifd_offset)
}

/// Read the direct SubIFDs of the first classic TIFF/DNG IFD.
pub fn read_sub_ifds(bytes: &[u8]) -> Result<Vec<Ifd>> {
    let root = read_first_ifd(bytes)?;
    if root.magic != MAGIC_TIFF {
        return Ok(Vec::new());
    }
    let Some(entry) = root.entries.get(&330) else {
        return Ok(Vec::new());
    };
    if entry.typ != TYPE_LONG && entry.typ != 13 {
        return Ok(Vec::new());
    }

    let le = root.little_endian;
    let r = Reader { bytes, le };
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for offset in root.numbers(330).unwrap_or_default() {
        if !offset.is_finite() || offset < 8.0 || offset.fract() != 0.0 || offset > u32::MAX as f64
        {
            continue;
        }
        let offset = offset as usize;
        if seen.insert(offset) {
            result.push(read_ifd_at(&r, root.magic, offset)?);
        }
    }
    Ok(result)
}

fn read_ifd_at(r: &Reader<'_>, magic: u16, ifd_offset: usize) -> Result<Ifd> {
    let n = r.u16_at(ifd_offset)? as usize;
    let mut entries = BTreeMap::new();
    for i in 0..n {
        let e = i
            .checked_mul(12)
            .and_then(|n| ifd_offset.checked_add(2)?.checked_add(n))
            .context("TIFF IFD offset overflow")?;
        let at = |field: usize| e.checked_add(field).context("TIFF IFD offset overflow");
        let tag = r.u16_at(e)?;
        let typ = r.u16_at(at(2)?)?;
        let count = r.u32_at(at(4)?)? as usize;
        let Some(size) = type_size(typ) else {
            continue;
        };
        let len = count
            .checked_mul(size)
            .context("TIFF entry size overflow")?;
        let data = if len <= 4 {
            r.slice(at(8)?, len)?.to_vec()
        } else {
            let off = r.u32_at(at(8)?)? as usize;
            r.slice(off, len)?.to_vec()
        };
        entries.insert(tag, RawEntry { typ, count, data });
    }
    Ok(Ifd {
        little_endian: r.le,
        magic,
        entries,
    })
}

impl Ifd {
    pub fn has(&self, tag: u16) -> bool {
        self.entries.contains_key(&tag)
    }

    fn word(&self, b: &[u8]) -> u32 {
        let a = [b[0], b[1], b[2], b[3]];
        if self.little_endian {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        }
    }

    fn half(&self, b: &[u8]) -> u16 {
        if self.little_endian {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        }
    }

    /// Numeric values of any integer / rational / float type, as f64.
    // Keep Rust 1.85 compatibility; `as_chunks` is only stable since Rust 1.88.
    #[allow(clippy::chunks_exact_to_as_chunks)]
    pub fn numbers(&self, tag: u16) -> Option<Vec<f64>> {
        let e = self.entries.get(&tag)?;
        let d = &e.data;
        let v: Vec<f64> = match e.typ {
            TYPE_BYTE | TYPE_UNDEFINED => d.iter().map(|&x| x as f64).collect(),
            TYPE_SBYTE => d.iter().map(|&x| x as i8 as f64).collect(),
            TYPE_SHORT => d.chunks_exact(2).map(|c| self.half(c) as f64).collect(),
            TYPE_SSHORT => d
                .chunks_exact(2)
                .map(|c| self.half(c) as i16 as f64)
                .collect(),
            TYPE_LONG | 13 => d.chunks_exact(4).map(|c| self.word(c) as f64).collect(),
            TYPE_SLONG => d
                .chunks_exact(4)
                .map(|c| self.word(c) as i32 as f64)
                .collect(),
            TYPE_RATIONAL => d
                .chunks_exact(8)
                .map(|c| {
                    let (n, den) = (self.word(&c[0..4]) as f64, self.word(&c[4..8]) as f64);
                    if den == 0.0 {
                        0.0
                    } else {
                        n / den
                    }
                })
                .collect(),
            TYPE_SRATIONAL => d
                .chunks_exact(8)
                .map(|c| {
                    let (n, den) = (
                        self.word(&c[0..4]) as i32 as f64,
                        self.word(&c[4..8]) as i32 as f64,
                    );
                    if den == 0.0 {
                        0.0
                    } else {
                        n / den
                    }
                })
                .collect(),
            TYPE_FLOAT => d
                .chunks_exact(4)
                .map(|c| f32::from_bits(self.word(c)) as f64)
                .collect(),
            TYPE_DOUBLE => d
                .chunks_exact(8)
                .map(|c| {
                    let mut a = [0u8; 8];
                    a.copy_from_slice(c);
                    if self.little_endian {
                        f64::from_le_bytes(a)
                    } else {
                        f64::from_be_bytes(a)
                    }
                })
                .collect(),
            _ => return None,
        };
        Some(v)
    }

    /// FLOAT values exactly as stored (other numeric types converted).
    // Keep Rust 1.85 compatibility; `as_chunks` is only stable since Rust 1.88.
    #[allow(clippy::chunks_exact_to_as_chunks)]
    pub fn floats(&self, tag: u16) -> Option<Vec<f32>> {
        let e = self.entries.get(&tag)?;
        if e.typ == TYPE_FLOAT {
            return Some(
                e.data
                    .chunks_exact(4)
                    .map(|c| f32::from_bits(self.word(c)))
                    .collect(),
            );
        }
        Some(self.numbers(tag)?.into_iter().map(|x| x as f32).collect())
    }

    /// ASCII or BYTE (UTF-8) string without trailing NULs.
    pub fn string(&self, tag: u16) -> Option<String> {
        let e = self.entries.get(&tag)?;
        if !matches!(e.typ, TYPE_ASCII | TYPE_BYTE | TYPE_UNDEFINED) {
            return None;
        }
        let end = e.data.iter().position(|&b| b == 0).unwrap_or(e.data.len());
        Some(String::from_utf8_lossy(&e.data[..end]).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read() {
        let entries = vec![
            (0xC6F8, Value::Ascii("Name".into())),
            (0xC614, Value::Ascii("Make Model".into())),
            (0xC65A, Value::Short(vec![21])),
            (
                0xC621,
                Value::SRational(vec![(6250, 10000), (-1250, 10000)]),
            ),
            (0xC6FA, Value::Float(vec![1.5, -2.25, 0.1])),
        ];
        let bytes = write_single_ifd_le(MAGIC_DCP, &entries).unwrap();
        assert_eq!(&bytes[0..4], b"IIRC");
        let ifd = read_first_ifd(&bytes).unwrap();
        assert_eq!(ifd.magic, MAGIC_DCP);
        assert_eq!(ifd.string(0xC614).as_deref(), Some("Make Model"));
        assert_eq!(ifd.string(0xC6F8).as_deref(), Some("Name"));
        assert_eq!(ifd.numbers(0xC65A), Some(vec![21.0]));
        assert_eq!(ifd.numbers(0xC621), Some(vec![0.6250, -0.1250]));
        assert_eq!(ifd.floats(0xC6FA), Some(vec![1.5, -2.25, 0.1]));
        // Tags are written in ascending order.
        let first_tag = u16::from_le_bytes([bytes[10], bytes[11]]);
        assert_eq!(first_tag, 0xC614);
    }

    #[test]
    fn rejects_garbage() {
        assert!(read_first_ifd(b"hello world!").is_err());
        assert!(read_first_ifd(b"II").is_err());
    }

    #[test]
    fn reads_dng_subifd_baseline_exposure() {
        // IFD0 points at a raw CFA SubIFD. BaselineExposure is -1/2 EV in that IFD.
        let mut bytes = vec![0u8; 64];
        bytes[0..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&MAGIC_TIFF.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&330u16.to_le_bytes());
        bytes[12..14].copy_from_slice(&TYPE_LONG.to_le_bytes());
        bytes[14..18].copy_from_slice(&1u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&26u32.to_le_bytes());
        bytes[22..26].copy_from_slice(&0u32.to_le_bytes());
        bytes[26..28].copy_from_slice(&2u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&262u16.to_le_bytes()); // PhotometricInterpretation
        bytes[30..32].copy_from_slice(&TYPE_SHORT.to_le_bytes());
        bytes[32..36].copy_from_slice(&1u32.to_le_bytes());
        bytes[36..38].copy_from_slice(&32803u16.to_le_bytes()); // CFA
        bytes[40..42].copy_from_slice(&0xC62Au16.to_le_bytes()); // BaselineExposure
        bytes[42..44].copy_from_slice(&TYPE_SRATIONAL.to_le_bytes());
        bytes[44..48].copy_from_slice(&1u32.to_le_bytes());
        bytes[48..52].copy_from_slice(&56u32.to_le_bytes());
        bytes[52..56].copy_from_slice(&0u32.to_le_bytes());
        bytes[56..60].copy_from_slice(&(-1i32).to_le_bytes());
        bytes[60..64].copy_from_slice(&2i32.to_le_bytes());

        let root = read_first_ifd(&bytes).unwrap();
        assert_eq!(root.numbers(0xC62A), None);
        let sub_ifds = read_sub_ifds(&bytes).unwrap();
        assert_eq!(sub_ifds.len(), 1);
        assert_eq!(sub_ifds[0].numbers(0xC62A), Some(vec![-0.5]));
        assert_eq!(sub_ifds[0].numbers(262), Some(vec![32803.0]));
    }
}
