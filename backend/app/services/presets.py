"""
Named areas of interest shown as quick regions in the app. Pre-built reports are published for these
and for every country in the archive (scripts/build_reports.py); the frontend's REG table mirrors them.
"""
PRESETS = {
    "Global": {"country": None, "bbox": None},
    "Bangladesh": {"country": "Bangladesh", "bbox": {"west": 88, "south": 20.6, "east": 92.7, "north": 26.6}},
    "Amazon": {"country": None, "bbox": {"west": -65, "south": -15, "east": -50, "north": -5}},
    "California": {"country": None, "bbox": {"west": -124.5, "south": 32.5, "east": -114, "north": 42}},
    "Argentina": {"country": "Argentina", "bbox": {"west": -73.6, "south": -55.1, "east": -53.6, "north": -21.8}},
    "Australia": {"country": "Australia", "bbox": {"west": 112.9, "south": -43.7, "east": 153.7, "north": -10.6}},
    "India": {"country": "India", "bbox": {"west": 68.1, "south": 6.7, "east": 97.4, "north": 35.5}},
    "Thailand": {"country": "Thailand", "bbox": {"west": 97.3, "south": 5.6, "east": 105.6, "north": 20.5}},
    "Indonesia": {"country": "Indonesia", "bbox": {"west": 95, "south": -11, "east": 141, "north": 6}},
    "Canada": {"country": "Canada", "bbox": {"west": -141, "south": 41.7, "east": -52.6, "north": 83.1}},
    "SE Australia": {"country": None, "bbox": {"west": 140, "south": -39, "east": 154, "north": -27}},
}


def slug(name: str) -> str:
    """ASCII file name for a pre-built report ('Curaçao' → 'curacao', 'São Tomé' → 'sao-tome'); must match slugOf()
    in the frontend."""
    import re
    import unicodedata
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]", "-", ascii_name.strip().lower())).strip("-")
