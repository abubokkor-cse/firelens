"""Hotspot search: request planning over FIRMS products, cleaning flags and harmonized weights."""
import datetime as dt

import pandas as pd

from app.services import hotspots as hs

D = dt.date
AVAIL = {"MODIS_SP": (D(2000, 11, 1), D(2026, 8, 31)), "MODIS_NRT": (D(2026, 9, 1), D(2026, 11, 3)),
         "VIIRS_SNPP_SP": (D(2012, 1, 20), D(2026, 7, 31)), "VIIRS_SNPP_NRT": (D(2026, 8, 1), D(2026, 11, 2))}


def test_plan_switches_from_standard_to_nrt_in_5_day_pieces():
    jobs = hs.plan("MODIS", D(2026, 8, 25), D(2026, 9, 9), AVAIL)
    assert [j[0] for j in jobs] == ["MODIS_SP", "MODIS_SP", "MODIS_NRT", "MODIS_NRT"]
    assert all(n <= 5 for _, _, n in jobs)
    covered = sorted(d + dt.timedelta(days=k) for _, d, n in jobs for k in range(n))
    assert covered == [D(2026, 8, 25) + dt.timedelta(days=k) for k in range(16)]


def test_plan_skips_days_before_a_sensor_exists():
    assert hs.plan("VIIRS_SNPP", D(2011, 12, 1), D(2011, 12, 31), AVAIL) == []


def _df(rows):
    return pd.DataFrame(rows, columns=["sensor", "acq_date", "confidence", "type"])


def test_cleaning_flags_follow_the_archive_rules():
    df = _df([("MODIS", "2010-01-01", "25", 0), ("MODIS", "2010-01-01", "80", 0), ("MODIS", "2010-01-01", "80", 2),
              ("VIIRS_SNPP", "2020-01-01", "l", None), ("VIIRS_SNPP", "2020-01-01", "h", None)])
    assert list(hs._used(df)) == [False, True, False, False, True]


def test_weights_use_the_record_sensor_for_each_era():
    conv = {"snpp": 0.25, "noaa20": 0.26}
    df = _df([("MODIS", "2010-05-01", "80", 0), ("VIIRS_SNPP", "2020-05-01", "n", 0), ("MODIS", "2020-05-01", "80", 0),
              ("VIIRS_NOAA20", "2020-05-01", "n", 0), ("VIIRS_NOAA20", "2020-05-02", "n", 0)])
    df["used_in_record"] = hs._used(df)
    w = list(hs.weights(df, conv))
    # MODIS counts before 2012; S-NPP after; MODIS after 2012 is not double counted; NOAA-20 only fills S-NPP-less days.
    assert w == [1.0, 0.25, 0.0, 0.0, 0.26]


def test_a_large_search_ends_on_a_whole_day():
    counts = pd.Series({"2024-09-01": 100, "2024-09-02": 150, "2024-09-03": 200})
    assert hs.whole_days(counts, 300) == "2024-09-02"
    assert hs.whole_days(counts, 50) == "2024-09-01"   # always at least the first day
    assert hs.whole_days(counts, 1000) == "2024-09-03"


def _firms_csv(n, date="2024-09-01"):
    head = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type\n"
    return (head + "".join(f"-10.5,-55.5,330,0.4,0.4,{date},{1200 + i % 50},N,VIIRS,n,2,290,5.5,D,0\n" for i in range(n))).encode()


def test_rows_stay_compact_and_mixed_batches_stack(monkeypatch):
    a = hs._normalise("VIIRS_SNPP", "VIIRS_SNPP_SP", _firms_csv(5), D(2024, 9, 1), D(2024, 9, 2), None, None)
    b = hs._normalise("VIIRS_NOAA20", "VIIRS_NOAA20_NRT", _firms_csv(3, "2024-09-02"), D(2024, 9, 1), D(2024, 9, 2), None, None)
    df = hs._concat([a, b])
    assert len(df) == 8 and all(str(df[c].dtype) == "category" for c in hs.CATEGORIES)
    assert set(df["product"].astype(str)) == {"standard", "near-real-time"}
    assert df["used_in_record"].all()


def test_search_stops_early_and_says_so(monkeypatch):
    monkeypatch.setattr(hs.settings, "FIRMS_API_KEY", "k")
    monkeypatch.setattr(hs, "MAX_ROWS", 12)
    monkeypatch.setattr(hs, "availability", lambda: {"VIIRS_SNPP_SP": (D(2012, 1, 20), D(2026, 7, 31))})
    calls = []

    def fake(url):
        day = url.rsplit("/", 1)[1]
        calls.append(day)
        return _firms_csv(10, day)

    monkeypatch.setattr(hs, "_get", fake)
    from app.models.schemas import BoundingBox
    box = BoundingBox(west=-60, south=-12, east=-50, north=-5)
    res = hs.search(box, D(2024, 8, 1), D(2024, 9, 30), ("VIIRS_SNPP",))
    assert res["truncated"] and len(calls) == 2        # stopped after 2 of 13 requests
    assert res["complete_through"] == D(2024, 8, 1) and len(res["rows"]) == 10
    s = hs.summary(res)
    assert s["truncated"] and s["daily"][-1]["date"] == "2024-08-01"
