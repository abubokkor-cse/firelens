"""Calendar-month and date-range statistics on a synthetic record whose answers are known exactly."""
import datetime as dt

import numpy as np
import pandas as pd
import pytest

from app.services import fire_record as fr


def record(cur_year=2026, cur_week=40, surge=None, through=None):
    """MODIS 7 detections a week every year; VIIRS S-NPP 28 a week from 2012 (ratio 4) → harmonized 1 per day."""
    rows = []
    for y in range(2000, cur_year + 1):
        for w in range(1, 53):
            rows.append(("M", y, w, 7.0, 70.0))
            if y >= 2012:
                rows.append(("V", y, w, 28.0 * (surge.get((y, w), 1) if surge else 1), 140.0))
    return fr.FireRecord(pd.DataFrame(rows, columns=["sensor", "year", "week", "n", "frp"]), cur_year, cur_week, through=through)


@pytest.fixture(autouse=True)
def no_gap_table(monkeypatch):
    """Isolate the synthetic record from FIRMS' official missing-data table."""
    monkeypatch.setattr(fr.store, "missing_days", lambda: {})


def test_shift_handles_leap_day():
    assert fr._shift(dt.date(2024, 2, 29), 1) == dt.date(2025, 2, 28)
    assert fr._shift(dt.date(2023, 7, 28), 3) == dt.date(2026, 7, 28)


def test_month_table_sums_calendar_days():
    rec = record()
    M = rec.month_table()
    i = 2005 - fr.FIRST_YEAR
    days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30]
    assert np.allclose(M[i, :11], days)              # exactly 1 harmonized detection per day
    assert np.isnan(M[0, 0])                         # 2000 before MODIS (Nov 2000) is not covered
    assert np.isnan(M[-1, 11])                       # current year: December not reached


def test_range_stats_same_dates_and_rank():
    surge = {(2026, w): 3 for w in range(10, 13)}    # three weeks of 3× burning in 2026
    rec = record(surge=surge)
    r = rec.range_stats(dt.date(2026, 3, 5), dt.date(2026, 3, 25))
    assert r["available"] and r["days"] == 21
    sd = r["same_dates"]
    assert sd["rank"] == 1                           # the surge year is the highest of all years
    assert sd["x_median"] > 2
    assert sd["median"] == pytest.approx(21, abs=1.5)


def test_range_is_clipped_to_the_record():
    rec = record(cur_week=40)
    r = rec.range_stats(dt.date(2026, 9, 1), dt.date(2026, 12, 31))
    assert r["end_clipped_to"] == rec.data_end().isoformat()


def test_month_stats_shape():
    rec = record(surge={(2026, 30): 5})
    ms = rec.month_stats()
    assert len(ms["climatology"]) == 12 and ms["statistic"] == "median"
    assert ms["top_months"][0]["year"] == 2026 and ms["top_months"][0]["month"] == 7
    assert ms["year_to_date"]["rank"] == 1
    assert ms["last_full_month"]["month"] == 9


def test_every_view_of_a_month_gives_the_same_number():
    rec = record(surge={(2026, 10): 3})
    M, ms = rec.month_table(), rec.month_stats()
    by = {(r["year"], r["month"]): r for r in rec.monthly()}
    for t in ms["top_months"]:
        assert by[(t["year"], t["month"])]["harmonized"] == t["value"]
    assert by[(2005, 3)]["harmonized"] == pytest.approx(M[5, 2], abs=.05)
    assert by[(2005, 3)]["complete"] and by[(2005, 3)]["median"] == pytest.approx(31, abs=.1)


def test_a_month_that_just_ended_counts_as_complete():
    # 4 Nov 2026: week 43 ended 28 Oct, week 44 is in progress. October is over and must be the last full month.
    rec = record(cur_week=43, through=dt.date(2026, 11, 4))
    assert rec.data_end() == dt.date(2026, 11, 3)
    ms = rec.month_stats()
    assert (ms["last_full_month"]["year"], ms["last_full_month"]["month"]) == (2026, 10)
    assert ms["current_month"]["month"] == 11 and ms["current_month"]["days"] == 3


def test_short_ranges_are_flagged_as_weekly_averages():
    rec = record()
    assert rec.range_stats(dt.date(2026, 3, 5), dt.date(2026, 3, 5))["resolution"] == "weekly average"
    assert rec.range_stats(dt.date(2026, 3, 5), dt.date(2026, 3, 25))["resolution"] == "weekly"
