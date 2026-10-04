"""Snapshot the zea file-format key tree into ``site/zea_keys.json``.

The site labels each HDF5 key a dataset documents with its description, unit and
axis names from the zea spec, and flags keys the spec does not define. Run this whenever the
zea version the dataset targets changes (it needs zea installed; ``build.py`` does not)::

    python site/zea_keys.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import zea
from zea.data import spec as zspec

OUT = Path(__file__).resolve().parent / "zea_keys.json"


def walk(cls: type, prefix: str, keys: dict) -> None:
    meta = cls.FIELD_METADATA
    for name, entry in cls.SCHEMA.items():
        path = prefix + name
        sub = entry.get("spec")
        info = meta.get(name, {})
        keys[path] = {
            "kind": "group" if sub is not None else "field",
            # The spec docs use RST inline literals; the site renders plain text.
            "description": re.sub(r"``(.+?)``", r"\1", info.get("description", "")),
            "unit": info.get("unit"),
        }
        if sub is None:
            # Alternative shapes, each a list of axis names, literal sizes or "...".
            keys[path]["shapes"] = [
                list(shape) for shape in zspec.Spec._expected_shapes(entry["shape"])
            ]
        else:
            walk(sub, path + "/", keys)


def main() -> None:
    keys: dict[str, dict] = {}
    # Keys are normalised without the tracks/track_N/ prefix, so per-track fields
    # (data/, scan/, label, transmit_only) share the root namespace with file-level ones.
    walk(zspec.TrackSpec, "", keys)
    walk(zspec.FileSpec, "", keys)
    OUT.write_text(
        json.dumps({"zea_version": zea.__version__, "keys": dict(sorted(keys.items()))}, indent=1)
        + "\n"
    )
    print(f"Wrote {len(keys)} keys (zea {zea.__version__}) to {OUT}")


if __name__ == "__main__":
    main()
