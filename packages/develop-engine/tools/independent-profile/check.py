#!/usr/bin/env python3
"""Reproduce the public fit and evaluate the frozen held-out source split in CI."""
import hashlib
import json
from pathlib import Path
from fit import generate

root = Path(__file__).resolve().parents[2]
data = root / 'fixtures/independent-profile/dc-s5-v1.measurements.json'
spec, report = generate(json.loads(data.read_bytes()))
report['measurementsSha256'] = hashlib.sha256(data.read_bytes()).hexdigest()
expected_spec = json.loads((root / 'crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.spec.json').read_text())
expected_report = json.loads((root / 'fixtures/independent-profile/dc-s5-v1.validation.json').read_text())
if spec != expected_spec or report != expected_report or not report['passed']:
    raise SystemExit('independent fit/held-out validation differs from the committed evidence')
print('Independent DCP: analytic fit reproduced; two held-out owner photos passed the frozen color-only gates.')
