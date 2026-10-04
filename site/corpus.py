"""Condense the stats scan into ``site/hub/corpus.json``, the numbers the page shows.

The HDF5 metadata is ``stats/data/files/``, which ``stats/refresh_data.py`` keeps up
to date (see ``site/README.md``), and the file sizes are in ``stats/data/tree.json``.
Every HDF5 file belongs to the dataset whose folder holds it (the deepest folder with a
data card). Per dataset, and for all of them together, this counts files, bytes, frames
and subjects, classifies each file's medium, transmit scheme, probe and signal, and
bins the acquisition parameters over edges shared by all datasets, so that the page can
add up any selection of datasets. It also lists the keys each dataset's files hold.

The rules below read what the files say about themselves; ``site/metadata_fixes.md`` lists
the few places where they correct it. A new dataset needs only a short name (see
``site/README.md``). This refuses to leave out an HDF5 file the scan has no metadata for,
unless ``--allow-partial``. ``update.py`` runs this after ``cards.py``.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

SITE = Path(__file__).resolve().parent
STATS = SITE.parent / "stats" / "data"
CORPUS = SITE / "hub" / "corpus.json"
FILES = SITE / "hub" / "files.json"
CARDS = SITE / "hub" / "cards.json"

# The medium: simulation is checked first because simulated media are often called
# phantoms; then the first rule matching the subject type the file states, then the first
# matching its description, credit, annotations and path. "Synthetic aperture" is a scheme.
ANIMAL = r"animal|porcine|pig|swine|mouse|mice|murine|rats?|rodent|rabbit|sheep|canine|bovine"
MEDIA = {
    "simulation": r"simulat\w*|in[- ]silico|k-?wave|field ?ii|fullwave|numerical"
    r"|digital (breast )?phantom|synthetic(?![ -]aperture)",
    "ex_vivo": r"ex[- ]vivo",
    "in_vivo": rf"in[- ]?vivo|clinical|volunteer|patient|human|{ANIMAL}",
    "phantom": r"phantom|in[- ]?vitro|tissue[- ]mimicking|wire target|cirs|ats",
}

# Probe names that files spell differently, under the name the most used probes chart
# counts them by. Each dataset keeps the names its files give. Why each is here:
# site/metadata_fixes.md.
PROBE_ALIASES = {
    "C5-2v": ["verasonics_c5_2v"],
    "L11-5v": ["verasonics_l11_5v", "Elevation Focused Linear Array Transducer"],
    "L11-4v": ["verasonics_l11_4v"],
    # oslo's "P4-1" files have 64 elements (a P4-2); a P4-1 has 96.
    "P4-2v": ["Verasonics P4-2v", "P4-2", "custom_p4_2_64_element", "P4-1"],
    "Siemens ACUSON 10L4": ["Simulated 10L4 Transducer"],
}
PROBE_NAME = {alias: name for name, aliases in PROBE_ALIASES.items() for alias in aliases}

# Simulated USCT whose card calls the stored transmit fields placeholders, so they say
# nothing about the scheme.
PLACEHOLDER_TRANSMITS = ("unc-openpros/",)

# Optional metadata, as a key (or group) in the file or an ``@``-prefixed root attribute.
COVERAGE = {
    "description": "@description",
    "us_machine": "@us_machine",
    "credit": "metadata/credit",
    "subject_id": "metadata/subject/id",
    "subject_type": "metadata/subject/type",
    "anatomy": "metadata/annotations/anatomy",
    "view": "metadata/annotations/view",
    "label": "metadata/annotations/label",
    "probe_name": "probe/name",
    "probe_type": "probe/type",
    "probe_fc": "probe/probe_center_frequency",
    "text_report": "metadata/text_report",
    "ecg": "metadata/ecg",
    "probe_pose": "metadata/probe_pose",
    "metrics": "metrics",
    "track_schedule": "track_schedule",
}

# Quantities with a range and a histogram: name -> (per file or per track, bins per decade).
QUANTITIES = {
    "frames": ("tracks", 4),
    "n_tx": ("tracks", 4),
    "n_ax": ("tracks", 8),
    "n_el": ("tracks", 4),
    "fc_mhz": ("tracks", 8),
    "fs_mhz": ("tracks", 8),
    "fs_over_fc": ("tracks", 8),
    "prf": ("tracks", 4),
    "frame_rate": ("tracks", 4),
    "depth_cm": ("tracks", 8),
    "compression": ("files", 4),
    "file_bytes": ("files", 3),
}
# Quantities binned at fixed thresholds instead of log steps: lower edges, and whether the
# first bin is open below. The last bin is always open above.
FIXED_BINS = {
    "n_el": ([1, 2, 50, 100, 150, 200, 300, 500, 1000], False),
    "frames": ([1, 2, 10, 100], False),
    "file_bytes": ([0, 2e7, 5e7, 1e8, 2e8, 1e9, 1e10, 1e11], True),
}
LAYOUT_VALUES = 3  # text values listed per key in a dataset's layout


def keys(record: dict) -> dict[str, dict]:
    """Every key in a file, without the tracks/track_N/ prefix, with its type, its shapes
    and, for a scalar, its values."""
    found = {}
    for layout in [record["keys"], *(t["keys"] for t in record["tracks"])]:
        for key, (dtype, shape, *value) in layout.items():
            entry = found.setdefault(key, {"dtype": dtype, "shapes": [], "values": []})
            if shape not in entry["shapes"]:
                entry["shapes"].append(shape)
            for v in value:
                if isinstance(v, float):
                    # Float32 noise such as 0.003000000026077032; JSON has no inf or nan.
                    v = float(f"{v:.6g}") if math.isfinite(v) else str(v)
                if v is not None and v not in entry["values"]:
                    entry["values"].append(v)
    return found


def medium(record: dict) -> str:
    # Underscores are word characters, so "2d_phantom" would not match \bphantom\b.
    subject = re.sub(r"[_/-]+", " ", str(record.get("subject_type") or ""))
    fields = ["attr_description", "credit", "annot_label", "annot_anatomy"]
    text = " ".join(str(record.get(k) or "") for k in fields)
    text += " " + re.sub(r"[_/]+", " ", record["path"])

    def hit(name, source):
        return re.search(rf"\b({MEDIA[name]})\b", source, re.I)

    if hit("simulation", subject) or hit("simulation", text):
        return "simulation"
    for source in (subject, text):
        for name in ("ex_vivo", "in_vivo", "phantom"):
            if hit(name, source):
                return name
    return "unknown"


def species(record: dict) -> str:
    text = f"{record.get('subject_type')} {record.get('attr_description')} {record['path']}"
    return "animal" if re.search(rf"\b({ANIMAL})\b", text, re.I) else "human"


def closed_curve(record: dict) -> bool:
    """Whether the elements go round a closed curve: in the x-z plane, as deep as wide."""
    x, y, z = ((record.get(f"probe_aperture_{a}") or 0) for a in "xyz")
    return x > 1e-3 and y <= 1e-3 and 0.9 <= z / x <= 1.1


def probe_class(record: dict) -> str:
    """A probe type from the vocabulary: the stated type if it names one, else the
    element positions (a matrix spanning x and y, a curve spanning x and z, or a line
    along x alone). A curved probe whose curve is as deep as it is wide is a ring: us4us
    stores its ring probe as "curved"."""
    kind = str(record.get("probe_type") or "").lower()
    name = str(record.get("probe_name") or "").lower()
    for vocab_id, pattern in [
        ("row_column", r"row.?col"),
        ("ivus", r"ivus"),
        ("ring", r"\bring"),
        ("linear", r"linear"),
        ("phased", r"phased"),
        ("curvilinear", r"curv|convex"),
        ("matrix", r"matrix|2d"),
    ]:
        if re.search(pattern, f"{kind} {name}"):
            return "ring" if vocab_id == "curvilinear" and closed_curve(record) else vocab_id
    if record.get("probe_n_el") == 1:
        return "single_element"
    # More than a millimetre along x, y, z.
    x, y, z = ((record.get(f"probe_aperture_{a}") or 0) > 1e-3 for a in "xyz")
    if x and y:
        return "matrix"
    if x and z:
        return "ring" if closed_curve(record) else "curvilinear"
    # A one-axis array could also be phased, which is why a stated type wins above.
    if x and not kind:
        return "linear"
    return "other" if kind else "unspecified"


# Track labels that name a coded transmit, which the weights cannot always show.
CODED_LABELS = ("hadamard", "chirp")


def transmit_kinds(track: dict) -> list[str]:
    """The kinds of transmit in a track: plane, diverging or focused from the focus
    distances, except that a single active element is synthetic aperture at any focus,
    and negative weights or a Hadamard or chirp label mark a coded transmit. An
    array that never transmits only listens (passive), and a single element that is the
    whole probe is a rotating IVUS catheter (other)."""
    active = track.get("tx_active_el_median")
    if any(code in str(track.get("label") or "").lower() for code in CODED_LABELS):
        return ["coded"]
    if track.get("tx_active_el_max") == 0:
        return ["passive"]
    if active is not None and active <= 1.5:
        return ["other"] if track.get("n_el") == 1 else ["synthetic_aperture"]
    if track.get("tx_has_negative_apod"):
        return ["coded"]
    names = {"plane": "plane_wave", "diverging": "diverging_wave", "focused": "focused"}
    return [names[k] for k in track.get("transmit_kinds", {})]


def acquisition(path: str) -> str:
    """The acquisition a file is of: one too large for a file is split into "_part2of3"
    files."""
    return re.sub(r"_?part\d+of\d+", "", path, flags=re.I)


def track_rows(record: dict) -> list[dict]:
    """One row per track: the raw data's axes (frames, transmits, samples, elements,
    channels) and the acquisition parameters."""
    rows = []
    for track in record["tracks"]:
        shape = track.get("raw_shape") or []
        frames, n_tx, n_ax, n_el, n_ch = shape if len(shape) == 5 else [None] * 5
        fs, fc = track.get("sampling_frequency"), track.get("center_frequency")
        depth = n_ax / fs * (track.get("sound_speed") or 1540) / 2 if n_ax and fs else None
        kinds = transmit_kinds(track)
        if record["path"].startswith(PLACEHOLDER_TRANSMITS):
            kinds = ["tomographic"]
        rows.append(
            {
                "frames": frames,
                "n_tx": n_tx,
                "n_ax": n_ax,
                "n_el": n_el,
                "transmits": (frames or 0) * (n_tx or 0),
                "samples": (frames or 0) * (n_tx or 0) * (n_ax or 0) * (n_el or 0) * (n_ch or 1),
                "raw_bytes": track.get("raw_nbytes", 0),
                "stored": track.get("raw_storage_size"),
                "fc_mhz": fc and fc / 1e6,
                "fs_mhz": fs and fs / 1e6,
                "fs_over_fc": fs and fc and fs / fc,
                "prf": track.get("prf"),
                "frame_rate": track.get("frame_rate"),
                "depth_cm": depth and depth * 100,
                "scheme": kinds[0] if len(kinds) == 1 else "mixed" if kinds else "unknown",
                "kinds": kinds,
                "dtype": track.get("raw_dtype"),
                "iq": "complex" in str(track.get("raw_dtype")) or n_ch == 2,
            }
        )
    return rows


def file_row(record: dict, size: int) -> dict:
    tracks = track_rows(record)
    found = keys(record)
    attrs = {k: record.get(f"attr_{k}") for k in record.get("attr_keys", [])}
    raw = sum(t["raw_bytes"] for t in tracks)
    # The scan skips the stored size of heavily chunked data. The file size is no stand-in:
    # some files hold derived images larger than the channel data.
    stored = sum(t["stored"] for t in tracks) if all(t["stored"] for t in tracks) else None

    def has(key: str) -> bool:
        if key.startswith("@"):
            return attrs.get(key[1:]) not in (None, "")
        return any(k == key or k.startswith(key + "/") for k in found)

    return {
        "path": record["path"],
        "tracks": tracks,
        "acquisition": acquisition(record["path"]),
        "file_bytes": size,
        "compression": raw / stored if raw and stored else None,
        "medium": medium(record),
        "species": species(record),
        "probe_class": probe_class(record),
        "iq": any(t["iq"] for t in tracks),
        "keys": found,
        "attrs": {k: v for k, v in attrs.items() if v is not None},
        "coverage": {name: has(key) for name, key in COVERAGE.items()},
        "subject": record.get("subject_id"),
        "probe": record.get("probe_name"),
        "probe_n_el": record.get("probe_n_el"),
        "probe_fc_mhz": sig(record["probe_center_frequency"] / 1e6)
        if record.get("probe_center_frequency")
        else None,
        "scanner": attrs.get("us_machine"),
        "zea_version": attrs.get("zea_version"),
    }


def counts(values, weights=None) -> dict:
    """How often each value occurs (or the sum of its weights), largest first."""
    total = collections.Counter()
    for v, w in zip(values, weights or [1] * len(values)):
        if v is not None:
            total[str(v)] += w
    return dict(total.most_common())


def probe_datasets(datasets: dict[str, list[dict]]) -> dict:
    """Per probe, the datasets that use it: "real" those with a file of it that is no
    simulation, "simulated" those whose files of it all are. Most used first."""
    out = collections.defaultdict(lambda: {"real": 0, "simulated": 0})
    for files in datasets.values():
        simulated = collections.defaultdict(set)
        for f in files:
            if f["probe"] is not None:
                simulated[str(PROBE_NAME.get(f["probe"], f["probe"]))].add(
                    f["medium"] == "simulation"
                )
        for name, kinds in simulated.items():
            out[name]["simulated" if kinds == {True} else "real"] += 1
    return dict(sorted(out.items(), key=lambda e: (-sum(e[1].values()), e[0])))


def sig(x: float, digits: int = 4):
    """A number for JSON: ints stay ints, floats keep ``digits`` significant digits."""
    return int(x) if float(x).is_integer() else float(f"{x:.{digits}g}")


def edges(name: str, values: list[float]) -> list:
    """Histogram bin edges: the fixed thresholds, or 10^(k / per decade) steps."""
    top = max(values)
    if name in FIXED_BINS:
        lower = FIXED_BINS[name][0]
        return [sig(e) for e in lower] + [max(math.ceil(top), int(lower[-1]) + 1)]
    per_decade = QUANTITIES[name][1]
    first = math.floor(math.log10(min(values)) * per_decade)
    last = max(math.ceil(math.log10(top) * per_decade), first + 1)
    return [sig(10 ** (k / per_decade)) for k in range(first, last + 1)]


def bin_medians(values: list[float], edges: list) -> list:
    """The median of the values in each bin, None for an empty one; its bins are those of
    np.histogram, which closes only the last at its top."""
    values = np.asarray(values, dtype=float)
    values = values[(values >= edges[0]) & (values <= edges[-1])]
    which = np.minimum(np.searchsorted(edges, values, side="right") - 1, len(edges) - 2)
    bins = [values[which == i] for i in range(len(edges) - 1)]
    return [sig(float(np.median(b))) if b.size else None for b in bins]


def quantity(files: list[dict], name: str) -> list[float]:
    rows = files if QUANTITIES[name][0] == "files" else [t for f in files for t in f["tracks"]]
    return [r[name] for r in rows if r[name]]


def spread(numbers: list) -> list:
    """Min, median and max."""
    return [sig(x, 6) for x in (min(numbers), np.median(numbers), max(numbers))]


def layout(files: list[dict]) -> dict:
    """What a dataset's files hold: every key with its type, the number of files that have
    it, the min, median and max of each axis of its shape and of a numeric value, and a
    few of its other values; and the root attributes' values."""
    found, attrs = {}, collections.defaultdict(list)
    for f in files:
        for key, info in f["keys"].items():
            entry = found.setdefault(
                key, {"dtype": info["dtype"], "in": 0, "shapes": [], "values": []}
            )
            entry["in"] += 1
            entry["shapes"] += info["shapes"]
            entry["values"] += info["values"]
        for name, v in f["attrs"].items():
            if v not in attrs[name] and len(attrs[name]) < LAYOUT_VALUES:
                attrs[name].append(v)
    keys = {}
    for key, entry in sorted(found.items()):
        # Per number of axes, which nearly always has one value per key.
        ranks = sorted({len(shape) for shape in entry["shapes"]})
        shapes = [[s for s in entry["shapes"] if len(s) == n] for n in ranks]
        keys[key] = {
            "dtype": entry["dtype"],
            "in": entry["in"],
            "shapes": [[spread(axis) for axis in zip(*same)] for same in shapes],
        }
        numbers = [v for v in entry["values"] if type(v) in (int, float)]
        text = sorted({v for v in entry["values"] if type(v) not in (int, float)}, key=str)
        if numbers:
            keys[key]["range"] = spread(numbers)
        if text:
            # Every anatomy, as the targets filter is matched against them.
            shown = text if key == COVERAGE["anatomy"] else text[:LAYOUT_VALUES]
            keys[key].update(values=shown, distinct=len(text))
    return {
        "tracks": sorted({len(f["tracks"]) for f in files}),
        "attrs": dict(sorted(attrs.items())),
        "keys": keys,
    }


def aggregate(files: list[dict], bins: dict) -> dict:
    """Everything the page shows for a set of files (one dataset, or all of them)."""
    tracks = [t for f in files for t in f["tracks"]]
    in_vivo = [f for f in files if f["medium"] == "in_vivo"]
    out = {
        "files": len(files),
        "acquisitions": len({f["acquisition"] for f in files}),
        "tracks": len(tracks),
        "bytes": sum(f["file_bytes"] for f in files),
        "raw_bytes": sum(t["raw_bytes"] for t in tracks),
        "frames": sum(t["frames"] or 0 for t in tracks),
        "transmits": sum(t["transmits"] for t in tracks),
        "samples": sum(t["samples"] for t in tracks),
        "subjects": len({f["subject"] for f in files} - {None}),
        "subjects_in_vivo": len({f["subject"] for f in in_vivo} - {None}),
        "medium": counts([f["medium"] for f in files]),
        "medium_bytes": counts([f["medium"] for f in files], [f["file_bytes"] for f in files]),
        "species": counts([f["species"] for f in in_vivo]),
        "scheme": counts([t["scheme"] for t in tracks]),
        "transmit_kinds": counts([k for t in tracks for k in t["kinds"]]),
        "probe_class": counts([f["probe_class"] for f in files]),
        "signal": {"rf": sum(not f["iq"] for f in files), "iq": sum(f["iq"] for f in files)},
        "signal_bytes": {
            "rf": sum(f["file_bytes"] for f in files if not f["iq"]),
            "iq": sum(f["file_bytes"] for f in files if f["iq"]),
        },
        "dtype": counts([t["dtype"] for t in tracks]),
        "probes": counts([f["probe"] for f in files]),
        "scanners": counts([f["scanner"] for f in files]),
        "zea_version": counts([f["zea_version"] for f in files]),
        "coverage": {name: sum(f["coverage"][name] for f in files) for name in COVERAGE},
        "range": {},
        "hist": {},
    }
    for name in QUANTITIES:
        values = quantity(files, name)
        out["range"][name] = None
        if values:
            median = float(np.median(values))
            out["range"][name] = {
                "min": sig(min(values)),
                "median": sig(median),
                "max": sig(max(values)),
            }
        out["hist"][name] = np.histogram(values, bins=bins[name])[0].tolist()
    return out


def profile(f: dict, bins: dict) -> dict:
    """One file's aggregate and layout, so build.py can classify it like a dataset."""
    one = aggregate([f], bins)
    anatomy = f["keys"].get(COVERAGE["anatomy"], {}).get("values", [])
    return {
        **{
            k: one[k]
            for k in (
                "medium",
                "species",
                "transmit_kinds",
                "probe_class",
                "signal",
                "dtype",
                "coverage",
            )
        },
        "range": {k: one["range"][k] for k in ("fc_mhz", "n_el", "frames")},
        "layout": {"keys": {COVERAGE["anatomy"]: {"values": anatomy}} if anatomy else {}},
        "keys": sorted(f["keys"]),
    }


def file_index(datasets: dict[str, list[dict]], bins: dict) -> dict:
    """Each dataset's files as [path in its folder, profile index, size], and the profiles."""
    out = {}
    for did, files in sorted(datasets.items()):
        profiles, rows = {}, []  # most files of a dataset share a profile, so keep each once
        for f in sorted(files, key=lambda f: f["path"]):
            text = json.dumps(profile(f, bins), sort_keys=True)
            rows.append(
                [
                    f["path"].removeprefix(did + "/"),
                    profiles.setdefault(text, len(profiles)),
                    f["file_bytes"],
                ]
            )
        out[did] = {"profiles": [json.loads(t) for t in profiles], "files": rows}
    return out


def folders(paths: list[str], sizes: dict[str, int]) -> list[dict]:
    """The folders holding a dataset's HDF5 files on the Hub, with a file count and size."""
    out = collections.defaultdict(lambda: {"files": 0, "bytes": 0})
    for path in paths:
        folder = out[path.rsplit("/", 1)[0]]
        folder["files"] += 1
        folder["bytes"] += sizes[path]
    return [{"path": path, **counts} for path, counts in sorted(out.items())]


# The probe classes of the paper's figure, in the order it lists them.
PAPER_PROBE_ORDER = [
    "linear",
    "curved",
    "ring",
    "matrix",
    "phased",
    "IVUS",
    "ring / matrix",
    "custom",
    "unspecified",
    "other",
]


def paper_probe_class(record: dict) -> str:
    """The probe type, normalised into the paper's classes."""
    t = (record.get("probe_type") or "").strip().lower()
    name = (record.get("probe_name") or "").lower()
    axes = record.get("probe_geometry_axes")
    n_el = record.get("probe_n_el")
    if t in ("linear",):
        return "linear"
    if t in ("phased", "phased_array", "phased array"):
        return "phased"
    # A stated curved array whose elements go all the way round is a ring: us4us
    # stores its ring probe as "curved".
    if t in ("curved", "convex"):
        return "ring" if closed_curve(record) else "curved"
    if t == "matrix" or (n_el and n_el >= 512 and axes == 2):
        return "matrix"
    if "ring" in name or "ring" in t or (t in ("", "custom") and closed_curve(record)):
        return "ring"
    if "ivus" in name:
        return "IVUS"
    if t == "custom":
        if axes and axes >= 2:
            return "ring / matrix"
        return "custom"
    # No probe/type at all: fall back on the stored geometry. A one-axis array
    # is linear (it could also be a phased array, which is why a stated type
    # always wins above). A two-axis array of 256+ elements that no name marks as
    # a ring is a matrix: resolvestroke's SN2652 is its 32x32 probe, stored as
    # 256 virtual elements.
    if not t and axes == 1:
        return "linear"
    if not t and axes and axes >= 2 and n_el and n_el >= 256:
        return "matrix"
    return t or "unspecified"


# Probes whose files give no centre frequency, with the frequency range their maker
# lists; the middle of the range stands in for it. Both are us4us probes the Waterloo
# datasets use, identified by name, element count and pitch in the us4us ARRUS probe
# dictionary: the Ultrasonix L14-5/38 (128 elements, 0.3048 mm, 5-14 MHz) and the
# Esaote AL2442 (192 elements, 0.21 mm, 3-11 MHz). The 5 MHz they transmit at is a
# setting of the sequence.
NOMINAL_RANGE_HZ = {"L14-5": (5e6, 14e6), "AL2442": (3e6, 11e6)}

# Probes whose files give no centre frequency but whose data card states it:
# kaist-snubh-barreleye ("the probe nameplate centre frequency is 10 MHz"), resolvestroke
# ("a 32x32 matrix array probe at 2 MHz"; SN2652 is its 256-element sub-aperture, SN2672
# the whole of it) and wpi's pipeline.yaml ("the JP_Linear_68 linear array (68 elements,
# 10 MHz, ...)"). Resolve Stroke is put at 2.1 MHz so that its 1024-element dot does not
# hide us4us's 1024-element ring at 2 MHz in the figure.
DATA_CARD_HZ = {
    "192-element linear breast probe": 10e6,
    "SN2652": 2.1e6,
    "SN2672": 2.1e6,
    "JP_Linear_68 (eSAF rotational, MEASURED)": 10e6,
}


def probe_frequency(record: dict) -> float | None:
    """The probe's centre frequency in Hz: from the file, else the data card, else the
    middle of the probe's nominal range."""
    stored = record.get("probe_center_frequency")
    if stored and stored > 0:
        return stored
    if record.get("probe_name") in DATA_CARD_HZ:
        return DATA_CARD_HZ[record["probe_name"]]
    band = NOMINAL_RANGE_HZ.get(record.get("probe_name"))
    return sum(band) / 2 if band else None


def probes(records, owner) -> tuple[dict, list[dict]]:
    """The data of the paper's elements-against-frequency figure, in its probe classes
    (``paper_probe_class``, which differ from the page's).

    The acquisitions of each class, and of each probe setting (class, centre frequency and
    element count) with the datasets they are in. A setting needs both an element count
    and a centre frequency, above 100 kHz; ``probe_frequency`` fills in the probes whose
    files give none. An acquisition split over several files counts once."""

    def acquisitions(rows):
        first = {}
        for r in rows:
            first.setdefault(acquisition(r["path"]), r)
        return first.values()

    classes = collections.Counter(paper_probe_class(r) for r in acquisitions(records))
    order = [c for c in PAPER_PROBE_ORDER if c in classes] + [
        c for c in classes if c not in PAPER_PROBE_ORDER
    ]

    def frequency(r):
        return probe_frequency(r) or 0

    designed = [r for r in records if (r.get("probe_n_el") or 0) > 0 and frequency(r) > 1e5]
    settings = collections.defaultdict(collections.Counter)
    for r in acquisitions(designed):
        settings[(paper_probe_class(r), frequency(r), r["probe_n_el"])][owner(r["path"])] += 1
    rows = [
        {
            "class": c,
            "fc_mhz": sig(fc / 1e6),
            "n_el": int(n_el),
            "acquisitions": sum(ds.values()),
            "datasets": dict(ds.most_common()),
        }
        for (c, fc, n_el), ds in settings.items()
    ]
    rows.sort(key=lambda r: (order.index(r["class"]), r["fc_mhz"], r["n_el"]))
    return {c: classes[c] for c in order}, rows


def build(cards: dict, allow_partial: bool = False) -> tuple[dict, dict]:
    revision = json.loads((STATS / "source_revision.json").read_text())["commit_sha"]
    if revision != cards["revision"]:
        raise SystemExit(
            f"The data cards are at {cards['revision'][:7]} but stats/data was scanned at "
            f"{revision[:7]}; run site/update.py"
        )
    tree = json.loads((STATS / "tree.json").read_text())
    sizes = {r["path"]: r["size"] for r in tree if r["path"].endswith((".hdf5", ".h5"))}
    paths = {r["path"] for r in tree}
    # Main's files even in a preview (update.py --pr): what they flag, such as a pipeline,
    # is downloaded from main.
    preview = cards.get("preview")
    # The scan stores what a folder's files share once; its own module reads it.
    sys.path.insert(0, str(STATS.parent))
    import scan_files

    scanned = scan_files.records()
    records = [r for r in scanned.values() if "error" not in r and r["path"] in sizes]
    # A file the scan could not read, or has not reached, would drop out of every number.
    missing = sorted(set(sizes) - {r["path"] for r in records})
    if missing:
        failed = collections.Counter(scanned[p]["error"] for p in missing if p in scanned)
        summary = (
            f"stats/data has no metadata for {len(missing):,} of the {len(sizes):,} HDF5 files"
            f" ({sum(failed.values()):,} failed to scan), such as {missing[0]}"
            + "".join(f"\n  {n:,} x {error}" for error, n in failed.most_common(3))
        )
        if not allow_partial:
            raise SystemExit(
                f"{summary}\nRun site/update.py again to scan them, or pass --allow-partial"
                " to leave them out of the statistics."
            )
        print(f"warning: {summary}\n  They are left out of the statistics.")
    ids = sorted(cards["cards"], key=len, reverse=True)

    def owner(path: str) -> str:
        # The deepest folder with a card; a folder without one is still a dataset.
        return next((i for i in ids if path.startswith(i + "/")), path.split("/")[0])

    datasets = collections.defaultdict(list)
    for record in records:
        datasets[owner(record["path"])].append(file_row(record, sizes[record["path"]]))
    on_hub = collections.defaultdict(list)
    for path in sizes:
        on_hub[owner(path)].append(path)
    everything = [f for files in datasets.values() for f in files]
    # Subject ids are unique within an institution: the Waterloo datasets share their
    # volunteers, while the same low numbers also occur at TU/e.
    subjects = collections.defaultdict(set)
    for did, files in datasets.items():
        institution = tuple(cards["cards"].get(did, {}).get("institutions") or [did])
        subjects[institution].update(f["subject"] for f in files if f["medium"] == "in_vivo")
    subjects_in_vivo = sum(len(ids - {None}) for ids in subjects.values())
    probe_classes, probe_settings = probes(records, owner)

    # The tracks at each pair of PRF and frame rate, for their scatter chart; None if unknown.
    def known(v):
        return sig(v) if v else None

    rates = collections.Counter(
        (known(t["prf"]), known(t["frame_rate"])) for f in everything for t in f["tracks"]
    )
    bins = {name: edges(name, quantity(everything, name)) for name in QUANTITIES}
    # Which ends of a fixed-bin histogram are open, for the page to name its bins.
    quantities = {name: {"per": per} for name, (per, _) in QUANTITIES.items()}
    for name, (_, open_below) in FIXED_BINS.items():
        quantities[name]["open"] = ["below", "above"] if open_below else ["above"]
    corpus = {
        "source": {
            "revision": cards["revision"],
            "date": cards["date"],
            "files_in_repo": len(sizes),
            "files_scanned": len(records),
            **({"pull_requests": preview["pull_requests"]} if preview else {}),
        },
        "quantities": quantities,
        "bins": bins,
        # Of all datasets, to label the bins by.
        "bin_medians": {
            name: bin_medians(quantity(everything, name), bins[name]) for name in QUANTITIES
        },
        "corpus": {
            **aggregate(everything, bins),
            "subjects_in_vivo": subjects_in_vivo,
            # Simulators are not scanners; the few large simulations would swamp the rest.
            "scanners": counts([f["scanner"] for f in everything if f["medium"] != "simulation"]),
            "probes": counts([PROBE_NAME.get(f["probe"], f["probe"]) for f in everything]),
            "probe_datasets": probe_datasets(datasets),
            "datasets": len(datasets),
            "probe_classes": probe_classes,
            "probe_settings": probe_settings,
            "prf_frame_rate": [
                [prf, rate, n]
                for (prf, rate), n in sorted(
                    rates.items(), key=lambda r: (r[0][0] or 0, r[0][1] or 0)
                )
            ],
        },
        "datasets": {
            did: {
                **aggregate(files, bins),
                "layout": layout(files),
                "folders": folders(on_hub[did], sizes),
                # The listing is sorted, so this is zea.Dataset(folder)[0] too.
                "first_file": min(on_hub[did]),
                "pipeline": f"{did}/pipeline.yaml" in paths,
                # Under the names the most used probes chart counts them by, to filter by.
                "probe_models": counts([PROBE_NAME.get(f["probe"], f["probe"]) for f in files]),
            }
            for did, files in sorted(datasets.items())
        },
    }
    return corpus, {"revision": cards["revision"], "datasets": file_index(datasets, bins)}


def main(allow_partial: bool = False) -> None:
    corpus, files = build(json.loads(CARDS.read_text()), allow_partial)
    CORPUS.write_text(json.dumps(corpus, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {CORPUS.relative_to(SITE.parent)}: {len(corpus['datasets'])} datasets")
    FILES.write_text(json.dumps(files, separators=(",", ":"), ensure_ascii=False) + "\n")
    count = sum(len(d["files"]) for d in files["datasets"].values())
    print(f"Wrote {FILES.relative_to(SITE.parent)}: {count} files")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="leave out the HDF5 files the scan has no metadata for",
    )
    main(parser.parse_args().allow_partial)
