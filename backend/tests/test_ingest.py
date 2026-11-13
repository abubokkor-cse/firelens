"""The near-real-time bridge must cover each day exactly once."""
import datetime as dt

from scripts.ingest_global import stale_windows

D = dt.date


def names(days, sensor="M"):
    return [f"{sensor}_nrt_{d:%Y%m%d}.parquet" for d in days]


def covered(files):
    days = []
    for f in files:
        s = f.split("_nrt_")[1][:8]
        start = D(int(s[:4]), int(s[4:6]), int(s[6:8]))
        days += [start + dt.timedelta(days=i) for i in range(5)]
    return days


def test_windows_left_from_the_old_grid_are_removed():
    # July's science file moved the grid from 1 Jul, 6 Jul … 31 Jul, 5 Aug … to 1 Aug, 6 Aug …
    old = names(D(2026, 7, 31) + dt.timedelta(days=5 * k) for k in range(1, 8))
    new = names(D(2026, 8, 1) + dt.timedelta(days=5 * k) for k in range(8))
    gone = stale_windows(old + new, D(2026, 7, 31), D(2026, 11, 4))
    kept = [f for f in old + new if f not in gone]
    assert set(gone) == set(old) and set(kept) == set(new)
    assert len(covered(kept)) == len(set(covered(kept)))     # no day twice


def test_recent_and_science_covered_windows_are_refetched():
    std, today = D(2026, 7, 31), D(2026, 11, 4)
    files = names([D(2026, 7, 27), D(2026, 8, 1), D(2026, 10, 30)]) + ["M_202607.parquet"]
    assert stale_windows(files, std, today) == names([D(2026, 7, 27), D(2026, 10, 30)])


def test_the_published_shards_of_4_november_lose_exactly_the_old_grid():
    dates = "0801 0805 0806 0810 0811 0815 0816 0820 0821 0825 0826 0830 0831 0904 0905 0909 0910 0914 0915 0919 0920 0924 0925 0929 0930 1004 1005 1009 1010 1014 1015 1019 1020 1025 1030 1104".split()
    files = [f"V_nrt_2026{d}.parquet" for d in dates]
    gone = stale_windows(files, D(2026, 7, 31), D(2026, 11, 4))
    kept = sorted(set(files) - set(gone))
    assert len(covered(kept)) == len(set(covered(kept)))
    assert kept[0].endswith("0801.parquet") and kept[-1].endswith("1025.parquet")  # 30 Oct and 4 Nov are refetched
