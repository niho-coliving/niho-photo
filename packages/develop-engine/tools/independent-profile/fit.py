#!/usr/bin/env python3
"""Fit an independently measured DCP from owned RAW/camera-JPEG sample pairs.

The analytic least-squares solve has no camera-matrix initial value. The fitted
mapping is white-preserving camera-WB RGB -> linear sRGB. The validation compares
chromaticity at matched luminance; it is not a tone or chart-calibration claim.
All validation scenes remain out of the fit. Python standard library only.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

SRGB_XYZ_D65 = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]
BRADFORD_D65_D50 = [[1.0478112, 0.0228866, -0.0501270], [0.0295424, 0.9904844, -0.0170491], [-0.0092345, 0.0150436, 0.7521316]]
D50 = [0.96422, 1.0, 0.82521]


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def apply(matrix, value):
    return [sum(row[k] * value[k] for k in range(3)) for row in matrix]


def inverse(matrix):
    # Gaussian elimination, with no imported camera or profile prior.
    rows = [list(row) + [float(i == j) for j in range(3)] for i, row in enumerate(matrix)]
    for index in range(3):
        pivot = max(range(index, 3), key=lambda i: abs(rows[i][index]))
        rows[index], rows[pivot] = rows[pivot], rows[index]
        factor = rows[index][index]
        if abs(factor) < 1e-10:
            raise ValueError('measured matrix is singular')
        rows[index] = [v / factor for v in rows[index]]
        for i in range(3):
            if i != index:
                factor = rows[i][index]
                rows[i] = [a - factor * b for a, b in zip(rows[i], rows[index])]
    return [row[3:] for row in rows]


def unit(rgb):
    total = sum(rgb)
    if total <= 0 or any(not math.isfinite(v) or v < 0 for v in rgb):
        raise ValueError('invalid measurement')
    return [v / total for v in rgb]


def fit(scenes):
    normal = [[0.0, 0.0], [0.0, 0.0]]
    target = [[0.0, 0.0] for _ in range(3)]
    train = [s for s in scenes if s['split'] == 'train']
    if len(train) < 3:
        raise ValueError('at least three independent training photos required')
    for scene in train:
        for camera, reference in scene['pairs']:
            x, y = unit(camera), unit(reference)
            features = [x[0] - x[2], x[1] - x[2]]
            weight = 1 / len(scene['pairs'])  # every photo has equal influence
            for a in range(2):
                for b in range(2):
                    normal[a][b] += weight * features[a] * features[b]
                for channel in range(3):
                    target[channel][a] += weight * features[a] * (y[channel] - x[2])
    a, b = normal[0]
    c, d = normal[1]
    determinant = a * d - b * c
    if abs(determinant) < 1e-12:
        raise ValueError('insufficient measured color diversity')
    matrix = []
    for u, v in target:
        red, green = (d * u - b * v) / determinant, (a * v - c * u) / determinant
        matrix.append([red, green, 1 - red - green])
    inverse(matrix)  # fail before serializing an unusable profile
    return matrix


def lab(xyz):
    def f(t):
        return t ** (1 / 3) if t > (6 / 29) ** 3 else t / (3 * (6 / 29) ** 2) + 4 / 29
    x, y, z = [f(v / w) for v, w in zip(xyz, D50)]
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]


def validate(scenes, matrix, gates):
    xyz_matrix = mul(BRADFORD_D65_D50, SRGB_XYZ_D65)
    results = []
    for scene in scenes:
        errors = []
        for camera, reference in scene['pairs']:
            prediction = [max(0, v) for v in apply(matrix, camera)]
            actual_xyz = apply(xyz_matrix, prediction)
            reference_xyz = apply(xyz_matrix, reference)
            gain = reference_xyz[1] / max(actual_xyz[1], 1e-12)
            got = lab([v * gain for v in actual_xyz])
            expected = lab(reference_xyz)
            errors.append(math.sqrt(sum((a - b) ** 2 for a, b in zip(got, expected))))
        errors.sort()
        mean = sum(errors) / len(errors)
        p95 = errors[math.ceil(len(errors) * .95) - 1]
        results.append({'id': scene['id'], 'split': scene['split'], 'pairs': len(errors), 'meanDeltaE76': round(mean, 5), 'p95DeltaE76': round(p95, 5)})
    validation = [r for r in results if r['split'] == 'validation']
    passed = len(validation) >= 2 and all(r['pairs'] >= gates['minimumPairsPerScene'] and r['meanDeltaE76'] <= gates['validationMeanDeltaE76'] and r['p95DeltaE76'] <= gates['validationP95DeltaE76'] for r in validation)
    return {'schema': 'niho.independent-profile-validation/1', 'metric': 'CIE76 with per-sample XYZ Y matched; color only, no tone/chart claim', 'gatesFrozenBeforeFit': gates, 'scenes': results, 'passed': passed}


def generate(dataset):
    scenes = dataset['scenes']
    sources = [s['rawSha256'] for s in scenes]
    if len(sources) != len(set(sources)) or any(s['split'] not in ('train', 'validation') for s in scenes):
        raise ValueError('source overlap or invalid split')
    matrix = fit(scenes)
    forward = mul(mul(BRADFORD_D65_D50, SRGB_XYZ_D65), matrix)
    # Exact white preservation after DCP SRATIONAL quantization.
    for index, row in enumerate(forward):
        scale = D50[index] / sum(row)
        forward[index] = [round(v * scale, 4) for v in row]
    color = inverse(mul(SRGB_XYZ_D65, matrix))
    spec = {'schema': 'niho-base-raw.dcp-spec/1', 'profileName': 'NIHO DC-S5 independent camera-JPEG v1',
            'uniqueCameraModel': 'Panasonic DC-S5', 'copyright': 'Copyright 2026 NIHO. Independently fitted from owner RAW and camera JPEG measurements; no external profile coefficients.',
            'embedPolicy': 2, 'calibrationSignature': 'com.niho.develop-engine', 'illuminant1': 21,
            'colorMatrix1': [round(v, 4) for row in color for v in row], 'illuminant2': None, 'colorMatrix2': None,
            'forwardMatrix1': [v for row in forward for v in row], 'forwardMatrix2': None, 'hueSatMap': None,
            'baselineExposureOffset': 0.0, 'defaultBlackRender': 0, 'toneCurve': None, 'lookTable': None}
    # Evaluate the quantized profile that is actually serialized, rather than the unquantized fit.
    serialized_matrix = mul(inverse(mul(BRADFORD_D65_D50, SRGB_XYZ_D65)), forward)
    report = validate(scenes, serialized_matrix, dataset['gate'])
    report['initialCameraMatrix'] = 'none; analytic solve from owned measurement pairs'
    report['measurementsCameraToSrgb'] = [[round(v, 9) for v in row] for row in matrix]
    return spec, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('measurements', type=Path)
    parser.add_argument('--spec', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    paths = [args.measurements, args.spec, args.report]
    if len({p.resolve() for p in paths}) != 3 or any(a.exists() and b.exists() and a.samefile(b) for i, a in enumerate(paths) for b in paths[i+1:]):
        parser.error('input and output paths must be distinct')
    data = args.measurements.read_bytes()
    spec, report = generate(json.loads(data))
    report['measurementsSha256'] = hashlib.sha256(data).hexdigest()
    args.spec.write_text(json.dumps(spec, indent=2) + '\n')
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print('independent profile validation:', 'PASS' if report['passed'] else 'FAIL')
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
