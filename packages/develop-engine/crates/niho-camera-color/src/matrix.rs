//! Small 3×3 matrix helpers (f64, row-major).

pub type Vec3 = [f64; 3];
pub type Mat3 = [[f64; 3]; 3];

pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Row-major slice of 9 → matrix.
pub fn from_row_major(v: &[f64]) -> Option<Mat3> {
    if v.len() != 9 || v.iter().any(|x| !x.is_finite()) {
        return None;
    }
    Some([[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]])
}

pub fn to_row_major(m: &Mat3) -> [f64; 9] {
    [
        m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
    ]
}

pub fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
        }
    }
    out
}

pub fn mul_vec(m: &Mat3, v: &Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub fn diag(v: &Vec3) -> Mat3 {
    [[v[0], 0.0, 0.0], [0.0, v[1], 0.0], [0.0, 0.0, v[2]]]
}

pub fn scale(m: &Mat3, k: f64) -> Mat3 {
    let mut out = *m;
    for row in out.iter_mut() {
        for cell in row.iter_mut() {
            *cell *= k;
        }
    }
    out
}

pub fn det(m: &Mat3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// Inverse by the adjugate. `None` when the matrix is (numerically) singular.
pub fn inverse(m: &Mat3) -> Option<Mat3> {
    let d = det(m);
    let norm = m.iter().flatten().fold(0.0_f64, |acc, x| acc.max(x.abs()));
    if !d.is_finite() || norm == 0.0 || d.abs() <= 1e-12 * norm * norm * norm {
        return None;
    }
    let inv_d = 1.0 / d;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_d,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_d,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_d,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_d,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_d,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_d,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_d,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_d,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_d,
        ],
    ])
}

/// `w * a + (1 - w) * b`.
pub fn blend(a: &Mat3, b: &Mat3, w: f64) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = w * a[r][c] + (1.0 - w) * b[r][c];
        }
    }
    out
}

pub fn to_f32(m: &Mat3) -> [[f32; 3]; 3] {
    let mut out = [[0.0_f32; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = m[r][c] as f32;
        }
    }
    out
}

pub fn max_abs_diff(a: &Mat3, b: &Mat3) -> f64 {
    let mut worst = 0.0_f64;
    for r in 0..3 {
        for c in 0..3 {
            worst = worst.max((a[r][c] - b[r][c]).abs());
        }
    }
    worst
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_roundtrip() {
        let m = [[1.0, 0.125, 0.0], [0.0, 1.0, 0.25], [0.125, 0.0, 1.0]];
        let inv = inverse(&m).expect("invertible");
        assert!(max_abs_diff(&mul(&m, &inv), &IDENTITY) < 1e-12);
        assert!(max_abs_diff(&mul(&inv, &m), &IDENTITY) < 1e-12);
    }

    #[test]
    fn singular_is_none() {
        let m = [[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [0.0, 1.0, 1.0]];
        assert!(inverse(&m).is_none());
    }
}
