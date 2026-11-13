# FireLens

**One fire record for the whole planet — MODIS and VIIRS harmonized into a burning activity calendar, 2000 to today.**

NASA Space Apps Challenge 2026 · *Harmonization of MODIS and VIIRS Hot Spots* · Team Aquila, Rajshahi, Bangladesh

**Live:** https://firelens.tech

---

## The problem

Satellites have mapped active fires since 2000, but the record is split. MODIS sees the Earth in 1 km pixels; VIIRS,
since 2012, in 375 m pixels — and finds about four times as many fire pixels (up to seventeen times at night). Put the
two together and global fire detections jump from 4.3 million in 2011 to 17.5 million in 2012. Fire did not quadruple;
the satellite changed. Fire managers are left without one consistent picture of when and where burning happens.

FireLens puts both sensors on one scale and turns the result into a tool for early warning, science and land management.

## What it does

- **Any area of interest.** Search a place, click a country, draw a box, upload a GeoJSON boundary, type a latitude
  and longitude with a radius (or `W, S, E, N`), or press *Fires near me*.
- **Any date range — down to a single day.** Harmonized total for the dates, the same dates in every year since 2000
  with their 2003–2025 median, the range's rank among all years, every hotspot detected (map and day-by-day chart),
  and downloads: a CSV of every hotspot, daily and per-year tables, PNG charts and map, or everything as one ZIP.
- **Burning activity calendar.** Every month (with its number, the monthly median and yearly totals) or week since 2000
  on one grid — fire count, intensity (FRP) or anomaly — with the area's *critical period*: the weeks that normally hold 80 % of its burning. Colour ramps include viridis and
  cividis (colour-blind safe) with a numeric legend; the calendar downloads as PNG, SVG or CSV.
- **Compared with the median.** This month so far, the last full month and the year to date against the 2003–2025
  median for the same days, with their rank; the typical year month by month; the most-burning years and months.
- **Unusual conditions.** Early or late onset, surges and suppression against the 2003–2025 baseline, plus an
  eight-week outlook built from the past seasons that looked most like this one.
- **Always current.** The archive grows every day; between updates, any area is topped up from the FIRMS
  near-real-time feed, so it runs to within the hour.
- **Live fires.** Today's detections, each marked *confirmed* (seen by two satellites), *likely* or *possible*, and a
  *where to look now* list of cells burning furthest above their own normal.
- **Fire alerts by email.** Strong fires, confirmed fires or an unusual week for your area — checked every hour.
- **Area report.** A one-page printable summary for responders and land managers.

## How the harmonization works

| Step | What we do |
| :--- | :--- |
| Sources | Every MODIS (MCD14ML C6/C6.1), VIIRS S-NPP (VNP14IMGML) and NOAA-20 (VJ114IMGML) detection since Nov 2000 — 486 million — plus the FIRMS near-real-time feed after the last monthly file. |
| Cleaning | Vegetation fires only (*type 0*): volcanoes, industrial sources and gas flares removed. MODIS confidence ≥ 30 %, VIIRS nominal/high. |
| Grid | 0.25° cells × a fixed 52-week year: detections, summed FRP, night detections (about 225 MB for the planet). |
| Model | A gradient-boosted Poisson model predicts MODIS detections in a cell-week from VIIRS count, FRP, night share, latitude, season and the cell's long-run VIIRS/MODIS ratio. |
| Anchoring | A per-area factor aligns the VIIRS-based record with that area's own MODIS record over 2012–2019. |
| Gaps | NASA's official missing-data table: MODIS weeks are scaled for missing Terra/Aqua days; S-NPP gaps are filled from NOAA-20 (S-NPP ÷ NOAA-20 ≈ 1.02). |
| One record | MODIS to 2011, then VIIRS in MODIS-equivalent units, continued by NOAA-20 — so it survives the retirement of MODIS and Suomi-NPP. |

The calendar shows weeks, but percentiles, z-scores and alerts use two-week windows: the MODIS user guide warns that
fire series binned shorter than about eight days are biased by orbit geometry.

## Does it work?

Trained on 2012–2021, tested on 2022–2026 in 211 countries (country-week totals):

| Method | R² | Mean abs. error | Bias |
| :--- | ---: | ---: | ---: |
| **FireLens model** | **0.941** | **74.7** | +1.4 % |
| One global ratio (learned) | 0.909 | 106.0 | +1.5 % |
| One global ratio (literature, 4.2) | 0.910 | 104.5 | −1.1 % |

The gain is largest where fires differ from the global mix: India (R² 0.94 vs 0.63), Canada (0.93 vs 0.67), Nigeria
(0.98 vs 0.83). In four countries the single ratio does slightly better.

Known events it finds without being told:

| Event | In the harmonized record |
| :--- | :--- |
| Canada 2023 | highest of 27 years, 5.4× the 2003–2025 mean |
| Black Summer, SE Australia 2019–20 | highest season, 5.0×; late December 2019 flagged extreme |
| California 2020 | highest year, 3.7× |
| Indonesia 2015 | highest year, 3.1× |
| Aqua MODIS outage, April 2022 | Bangladesh 2022 flagged as under-detected |

**Limits.** Satellites miss fires that are small, cool, under cloud or canopy, or between passes. Near-real-time weeks
have no fire-type field, so they are marked provisional until the science files replace them. Country totals use cells
assigned by their centre, so small countries with long borders can differ from FIRMS country counts by up to ~10 %.

## Run it locally

You need Node.js 18+, Python 3.11+ and a free [NASA FIRMS MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/).

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                       # add your FIRMS key

python -m scripts.ingest_global            # ~580 monthly files from the UMD fire archive (streamed, ~22 GB)
python -m scripts.ingest_global --nrt      # near-real-time bridge to today
python -m scripts.ingest_global --compact
python -m scripts.build_cells
python -m scripts.train_harmonizer
uvicorn app.main:app --reload --port 8000  # http://localhost:8000/docs

# Frontend
cd ../frontend
npm install
npm run dev                                # http://localhost:5173
```

`python -m scripts.ingest_global --update` keeps a local archive current. Tests: `pip install -r requirements-dev.txt`
then `python -m pytest tests`. The frontend reads `VITE_API_URL`
(default `http://localhost:8000/api/v1`) and, optionally, `VITE_REPORTS_URL` for pre-built reports.

## How it is deployed

```
frontend/   React + Vite + MapLibre             → Cloudflare Pages (firelens.tech)
backend/    FastAPI + DuckDB over Parquet tiles → Google Cloud Run
            archive and country reports         → Cloudflare R2
            daily / weekly / monthly updates    → Cloud Run jobs + Cloud Scheduler
            alert subscriptions                 → Firestore, emails via Resend
```

**How the archive stays current.** Each 10° tile is stored as two files. `hist` holds everything up to the last
monthly science file NASA has published for all three sensors and changes about once a month; `recent` holds the
months since, from the near-real-time feed, and is only about 10 MB for the whole planet. So the daily job rebuilds
and uploads just `recent`, in about two minutes. When NASA publishes a new month, the daily job starts a full rebuild
that moves it into `hist` and retrains the model. Country reports are rebuilt weekly and stored gzip-compressed; the
live top-up keeps every page current in between.

| Job | When | What it does |
| :--- | :--- | :--- |
| `scripts.update daily` | every day, 06:30 UTC | newest fires → `recent` tiles, upload only what changed |
| `scripts.update rebuild` | when a new NASA month is out | new month → `hist`, retrain, rebuild everything |
| `scripts.update reports` | Sundays | all country reports and the Global watchlist |

### API additions

| Endpoint | What it returns |
| :--- | :--- |
| `POST /api/v1/calendar/range?start=&end=` | Harmonized total, raw MODIS/VIIRS, weekly series, and the same dates in every year (median, rank) |
| `POST /api/v1/hotspots/search?start=&end=` | Every FIRMS detection in the AOI and dates (≤ 62 days): totals, daily table, strongest points |
| `POST /api/v1/hotspots/csv?start=&end=` | The same as CSV, one row per detection, with `used_in_record` and `harmonized_weight` |
| `POST /api/v1/hotspots/history?start=&end=` | Up to 7 days: the same dates in every year from real detections, with median and rank |

`/calendar/report` also returns `month_stats`, and `monthly` holds true calendar months (weeks spread over their days),
so a month shows the same number everywhere. A search holding more than 300,000 detections stops at its last complete
day and says so (`truncated`, `complete_through`). Hotspot searches read each day from the FIRMS standard product while
it exists and near-real-time after it (FIRMS' data-availability table), 5 days per request — FIRMS' limit.

1. **API:** store `firms-api-key`, `resend-api-key` and `alerts-run-token` in Secret Manager, then run
   `backend/deploy_cloudrun.sh`. It also creates the hourly alert job.
2. **Archive:** build it once (`python -m scripts.build_reports --out publish`) and upload it with
   `python -m scripts.update publish publish`, with `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` and `R2_PUBLIC_URL` set. Unchanged files are skipped.
3. **Update jobs:** add `r2-access-key-id` and `r2-secret-access-key` to Secret Manager, then run
   `backend/deploy_jobs.sh`. The API picks up each update by itself within three hours.
4. **Frontend:** build with `VITE_API_URL` and `VITE_REPORTS_URL`, deploy `frontend/dist` to Pages.

Interactive API documentation: `/docs` on the API.

## Data and references

- NASA FIRMS (https://firms.modaps.eosdis.nasa.gov) — near-real-time fires, area API, missing-data table.
- University of Maryland fire archive — monthly MODIS and VIIRS fire location files.
- Giglio, Schroeder and Justice (2016), *The Collection 6 MODIS active fire detection algorithm and fire products*,
  Remote Sensing of Environment 178, 31–41.
- Schroeder, Oliva, Giglio and Csiszar (2014), *The new VIIRS 375 m active fire detection data product*, Remote
  Sensing of Environment 143, 85–96.
- MODIS C6/C6.1 and VIIRS Collection 2 Active Fire user guides. Natural Earth 1:50m boundaries. Globe imagery © Esri,
  Maxar, Earthstar Geographics.

## Team

Team Aquila, Rajshahi, Bangladesh — MD. Abu Bokkor (developer and researcher) and Mst. Maharun Nasha Queen
(designer). Built for the NASA Space Apps Challenge 2026.

Released under the [MIT License](LICENSE).
