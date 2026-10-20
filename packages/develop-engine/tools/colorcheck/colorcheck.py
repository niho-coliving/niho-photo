#!/usr/bin/env python3
"""colorcheck CLI entry: python3 colorcheck.py <compare|render|preset|chart|report|fixture|gates> ...

See README.md.  The implementation lives in the colorcheck/ package next to
this file (the package takes precedence over this script on import).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from colorcheck.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
