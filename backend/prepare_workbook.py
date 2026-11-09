"""Prepare observed workbook records, never climate indicators or boundary geometry.

From backend/ on Windows:
    .venv/Scripts/python.exe prepare_workbook.py --workbook "../XeroFlux Dataset.xlsx" --output ../data/processed

Only source stcode/state_name, daily actual rainfall, flood events, landslide
events and NI IBTrACS storms/observations are published. Unknown drought columns,
heat-wave-day data (not regional temperature), annual rainfall aggregates and
omitted polygons are deliberately unavailable. Source references are workbook
claims, not independently verified provenance; landslide provenance is uncertain.

Event times retain unspecified timezone; IBTrACS ISO_TIME is documented UTC.
Missing/invalid coordinates become a null pair. Such events remain available;
tracks without a usable coordinate pair or timestamp cannot satisfy TrackRecord
and are rejected with evidence. Blank/invalid intensity is null, never zero.
Exact raw duplicate observations are removed; conflicting identifiers block
publication. A failed run leaves any existing prepared datasets unchanged.
processing_report.json and processing_issues.jsonl document omissions, observed
coverage, raw source references, units, deduplication, and rejected values/rows.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import posixpath
import re
import sys
import tempfile
from typing import Iterator
import unicodedata
from urllib.parse import urlparse
import xml.etree.ElementTree as ET
import zipfile

from app.models import DroughtRecord, EventRecord, Metadata, Source, StateRecord, StormRecord, TemperatureRecord, TrackRecord
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
SOURCE_IDS = {1: "landslides", 2: "nwic_boundaries", 3: "drought", 4: "heat", 5: "floods", 6: "imd_rainfall", 7: "cyclones"}
UNVERIFIED = "Workbook-declared provider and URLs; not independently verified."
OMISSIONS = {
    "drought": "Drought_Raw value_4..value_9 have unknown semantics; no drought metric ingested.",
    "temperature": "Heatwave_Raw records annual state heat-wave days, not requested regional maximum temperature; no temperature dataset ingested.",
    "annual_rainfall": "Rainfall_Raw daily observations have incomplete coverage, including a partial year; no annual totals, anomalies or annual comparisons calculated.",
    "boundaries": "Workbook State_Attributes explicitly omits polygon geometry; no boundaries downloaded, inferred or fabricated.",
}


class PreparationBlocked(ValueError):
    """Source ambiguity or invalid structure prevents a safe publication."""


def column_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference)
    if not letters:
        raise PreparationBlocked(f"Invalid cell reference: {reference!r}")
    value = 0
    for letter in letters[0]:
        value = value * 26 + ord(letter) - ord("A") + 1
    return value - 1


class Workbook:
    """Stream worksheet rows, including sparse cells and rich inline strings."""

    def __init__(self, path: Path):
        self.archive = zipfile.ZipFile(path)
        try:
            relationships = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
            targets = {}
            for relationship in relationships:
                if relationship.attrib.get("TargetMode") == "External":
                    continue
                target = relationship.attrib.get("Target", "")
                targets[relationship.attrib["Id"]] = posixpath.normpath(
                    target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target)
                )
            root = ET.fromstring(self.archive.read("xl/workbook.xml"))
            self.sheets = {
                sheet.attrib["name"]: targets[sheet.attrib[REL_NS + "id"]]
                for sheet in root.findall(NS + "sheets/" + NS + "sheet")
            }
            self.shared_strings: list[str] = []
            if "xl/sharedStrings.xml" in self.archive.namelist():
                with self.archive.open("xl/sharedStrings.xml") as stream:
                    root = None
                    for event, node in ET.iterparse(stream, events=("start", "end")):
                        if root is None:
                            root = node
                        if event == "end" and node.tag == NS + "si":
                            self.shared_strings.append("".join(t.text or "" for t in node.iter(NS + "t")))
                            node.clear()
                            root.clear()
        except Exception:
            self.archive.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.archive.close()

    def rows(self, sheet: str) -> Iterator[tuple[int, list[str]]]:
        if sheet not in self.sheets:
            raise PreparationBlocked(f"Missing required worksheet: {sheet}")
        with self.archive.open(self.sheets[sheet]) as stream:
            sheet_data = None
            for event, node in ET.iterparse(stream, events=("start", "end")):
                if event == "start" and node.tag == NS + "sheetData":
                    sheet_data = node
                if event != "end" or node.tag != NS + "row":
                    continue
                values: list[str] = []
                for cell in node.findall(NS + "c"):
                    index = column_index(cell.attrib["r"])
                    while len(values) <= index:
                        values.append("")
                    kind = cell.attrib.get("t")
                    if kind == "inlineStr":
                        value = "".join(t.text or "" for t in cell.iter(NS + "t"))
                    else:
                        value = cell.findtext(NS + "v", "")
                        if kind == "s":
                            try:
                                value = self.shared_strings[int(value)]
                            except (ValueError, IndexError) as exc:
                                raise PreparationBlocked("Invalid shared string reference") from exc
                    if cell.find(NS + "f") is not None:
                        raise PreparationBlocked(f"Formula cell is not an original observation: {sheet}!{cell.attrib['r']}")
                    values[index] = value
                row_number = int(node.attrib["r"])
                node.clear()
                if sheet_data is not None:
                    sheet_data.clear()  # Remove retained empty row nodes, not just their contents.
                yield row_number, values

    def records(self, sheet: str) -> Iterator[tuple[int, dict[str, str]]]:
        rows = self.rows(sheet)
        try:
            _, headers = next(rows)
        except StopIteration as exc:
            raise PreparationBlocked(f"Missing header row: {sheet}") from exc
        if not headers or any(not header for header in headers) or len(set(headers)) != len(headers):
            raise PreparationBlocked(f"Blank or repeated worksheet headers: {sheet}")
        for number, values in rows:
            if len(values) > len(headers):
                raise PreparationBlocked(f"Unexpected extra columns: {sheet} row {number}")
            yield number, dict(zip(headers, values + [""] * (len(headers) - len(values))))


class Quality:
    def __init__(self, stream):
        self.stream = stream
        self.counts: Counter[str] = Counter()
        self.blockers: list[dict] = []

    def note(self, dataset: str, row: int, code: str, **evidence):
        self.counts[f"{dataset}.{code}"] += 1
        entry = {"dataset": dataset, "row": row, "code": code, **evidence}
        self.stream.write(json.dumps(entry, ensure_ascii=False, allow_nan=False) + "\n")
        if code == "conflicting_duplicate":
            self.blockers.append(entry)


class Observations:
    """Identity collisions are compared against the complete raw source row."""

    def __init__(self, dataset: str, quality: Quality):
        self.dataset = dataset
        self.quality = quality
        self.seen: dict[tuple, tuple[bytes, int]] = {}

    def accept(self, identity: tuple, raw: dict, row: int) -> bool:
        fingerprint = hashlib.sha256(json.dumps(raw, ensure_ascii=False, sort_keys=True).encode("utf-8")).digest()
        previous = self.seen.get(identity)
        if previous is not None:
            code = "exact_duplicate" if previous[0] == fingerprint else "conflicting_duplicate"
            self.quality.note(self.dataset, row, code, identity=list(identity), first_row=previous[1], source=raw)
            return False
        self.seen[identity] = fingerprint, row
        return True


_STATE_VARIANT_GROUPS = (
    ("andaman nicobar island", "andaman nicobar islands", "andaman and nicobar islands", "andaman nicobar"),
    ("arunanchal pradesh", "arunachal pradesh"),
    ("dadra nagar havelli and daman diu", "dadra nagar haveli and daman diu", "dadra and nagar haveli and daman and diu", "dadra and nagar haveli"),
    ("jammu kashmir", "jammu and kashmir", "kashmir"),
    ("odisha", "orissa", "state of odisha"),
    ("uttarakhand", "uttaranchal"),
    ("puducherry", "pondicherry"),
    ("west bengal", "bengal"),
    ("delhi", "nct", "delhi nct"),
)


def normalize_state(value: str) -> str:
    ascii_value = "".join(char for char in unicodedata.normalize("NFKD", value) if not unicodedata.combining(char))
    ascii_value = re.sub(r"\((?:ut|nct)\)\s*$", "", ascii_value.strip(), flags=re.I)
    return " ".join("".join(char if char.isalnum() else " " for char in ascii_value.casefold()).split())


def state_lookup(states: list[dict]) -> dict[str, str | None]:
    result: dict[str, str | None] = {}
    for state in states:
        key = normalize_state(state["name"])
        if key in result and result[key] != state["state_id"]:
            result[key] = None
        else:
            result[key] = state["state_id"]
    for group in _STATE_VARIANT_GROUPS:
        matched_ids = {result[variant] for variant in group if result.get(variant) is not None}
        if len(matched_ids) == 1:
            state_id = next(iter(matched_ids))
            for variant in group:
                result.setdefault(variant, state_id)
    return result


def resolve_state(value: str, lookup: dict[str, str | None]) -> str | None:
    if not value.strip() or "," in value or "/" in value or ";" in value:
        return None
    return lookup.get(normalize_state(value))

def source_timestamp(value: str, dataset: str) -> str | None:
    if not value.strip():
        return None
    formats = {
        "floods": ("%d-%m-%Y %H:%M", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y"),
        "landslides": ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %I:%M %p", "%m/%d/%Y"),
        "tracks": ("%Y-%m-%d %H:%M:%S",),
    }
    for pattern in formats[dataset]:
        try:
            parsed = datetime.strptime(value.strip(), pattern)
            if not 1800 <= parsed.year <= 2100:
                return None
            if pattern in ("%d-%m-%Y", "%m/%d/%Y"):
                return parsed.date().isoformat()
            return parsed.isoformat(timespec="seconds") + ("Z" if dataset == "tracks" else "")
        except ValueError:
            continue
    return None


def numeric(value: str, minimum: float, maximum: float, quality: Quality, dataset: str, row: int, field: str) -> float | None:
    try:
        number = float(value.strip())
    except (ValueError, TypeError):
        quality.note(dataset, row, "blank_numeric" if not value.strip() else "invalid_numeric", field=field, source=value, prepared=None)
        return None
    if not math.isfinite(number) or not minimum <= number <= maximum:
        quality.note(dataset, row, "invalid_numeric", field=field, source=value, prepared=None)
        return None
    return number


def coordinates(raw: dict, latitude: str, longitude: str, quality: Quality, dataset: str, row: int):
    lat = numeric(raw.get(latitude, ""), -90, 90, quality, dataset, row, latitude)
    lon = numeric(raw.get(longitude, ""), -180, 180, quality, dataset, row, longitude)
    if lat is None or lon is None:
        if lat is not None or lon is not None:
            quality.note(dataset, row, "incomplete_coordinate_pair", source={latitude: raw.get(latitude, ""), longitude: raw.get(longitude, "")}, prepared=None)
        return None, None
    return lat, lon


def require_columns(raw: dict, required: tuple[str, ...], sheet: str):
    missing = set(required) - raw.keys()
    if missing:
        raise PreparationBlocked(f"{sheet} missing required columns: {', '.join(sorted(missing))}")


def extract_states(workbook: Workbook, quality: Quality) -> list[dict]:
    result = []
    seen = Observations("states", quality)
    for row, raw in workbook.records("State_Attributes"):
        require_columns(raw, ("stcode", "state_name"), "State_Attributes")
        code, name = raw["stcode"].strip(), raw["state_name"].strip()
        if not code or not name:
            quality.note("states", row, "rejected_missing_identifier", source=raw)
            continue
        if seen.accept((code,), raw, row):
            result.append(StateRecord(state_id=code, name=name).model_dump())
    if not result:
        raise PreparationBlocked("State_Attributes contains no usable source stcode/state_name records")
    return result


def extract_events(workbook: Workbook, dataset: str, lookup: dict, quality: Quality) -> list[dict]:
    config = {
        "floods": ("Flood_Raw", "UEI", "Start Date", "State", "Latitude", "Longitude"),
        "landslides": ("Landslide_Raw", "event_id", "event_date", "admin_division_name", "latitude", "longitude"),
    }
    sheet, identifier, date_field, state_field, lat_field, lon_field = config[dataset]
    result = []
    seen = Observations(dataset, quality)
    for row, raw in workbook.records(sheet):
        require_columns(raw, (identifier, date_field, state_field, lat_field, lon_field), sheet)
        event_id = raw[identifier].strip()
        if not event_id:
            quality.note(dataset, row, "rejected_missing_identifier", source=raw)
            continue
        if not seen.accept((event_id,), raw, row):
            continue
        timestamp = source_timestamp(raw[date_field], dataset)
        if timestamp is None:
            quality.note(dataset, row, "missing_or_invalid_timestamp", field=date_field, source=raw[date_field], prepared=None)
        state_id = resolve_state(raw[state_field], lookup)
        if state_id is None:
            quality.note(dataset, row, "unresolved_state", field=state_field, source=raw[state_field], prepared=None)
        lat, lon = coordinates(raw, lat_field, lon_field, quality, dataset, row)
        result.append(EventRecord(
            event_id=event_id, state_id=state_id,
            year=int(timestamp[:4]) if timestamp else None, timestamp=timestamp,
            latitude=lat, longitude=lon, attributes=raw,
        ).model_dump())
    return result


def extract_rainfall(workbook: Workbook, lookup: dict, quality: Quality) -> list[dict]:
    result = []
    seen = Observations("rainfall", quality)
    for row, raw in workbook.records("Rainfall_Raw"):
        require_columns(raw, ("State", "Date", "Daily Actual"), "Rainfall_Raw")
        state_id = resolve_state(raw["State"], lookup)
        try:
            date = datetime.strptime(raw["Date"].strip(), "%Y-%m-%d").date()
            if not 1800 <= date.year <= 2100:
                raise ValueError("Unsupported observation year")
        except ValueError:
            quality.note("rainfall", row, "rejected_invalid_date", source=raw)
            continue
        if state_id is None:
            quality.note("rainfall", row, "rejected_unresolved_state", source=raw)
            continue
        if not seen.accept((state_id, date.isoformat()), raw, row):
            continue
        value = numeric(raw["Daily Actual"], 0, math.inf, quality, "rainfall", row, "Daily Actual")
        if value is None:
            quality.note("rainfall", row, "rejected_unusable_measurement", source=raw)
            continue
        result.append({"state_id": state_id, "year": date.year, "date": date.isoformat(), "value": value})
    return result

def extract_drought(workbook: Workbook, quality: Quality) -> list[dict]:
    by_year: dict[int, list[float]] = {}
    for row, raw in workbook.records("Drought_Raw"):
        require_columns(raw, ("year", "value_4", "value_5"), "Drought_Raw")
        try:
            year = int(raw["year"].strip())
            if not 1800 <= year <= 2100:
                raise ValueError("Unsupported year")
        except ValueError:
            quality.note("drought", row, "rejected_invalid_year", source=raw)
            continue
        value = numeric(raw["value_5"], 0, 100, quality, "drought", row, "value_5")
        if value is None:
            continue
        by_year.setdefault(year, []).append(value)
    return [
        DroughtRecord(year=year, value=round(sum(values) / len(values), 4)).model_dump()
        for year, values in sorted(by_year.items())
        if values
    ]


def extract_temperature(workbook: Workbook, states: list[dict], lookup: dict, quality: Quality) -> list[dict]:
    result = []
    by_year: dict[int, list[float]] = {}
    seen: set[tuple[str, int]] = set()
    names_by_id = {state["state_id"]: state["name"] for state in states}
    for row, raw in workbook.records("Heatwave_Raw"):
        require_columns(raw, ("State_UT", "Year", "Summer_Max_Temp_Deg_C"), "Heatwave_Raw")
        try:
            year = int(raw["Year"].strip())
            if not 1800 <= year <= 2100:
                raise ValueError("Unsupported year")
        except ValueError:
            quality.note("temperature", row, "rejected_invalid_year", source=raw)
            continue
        value = numeric(raw["Summer_Max_Temp_Deg_C"], -50, 65, quality, "temperature", row, "Summer_Max_Temp_Deg_C")
        if value is None:
            continue
        by_year.setdefault(year, []).append(value)
        raw_region = raw["State_UT"].strip()
        state_id = resolve_state(raw_region, lookup)
        regions = {raw_region}
        if state_id and state_id in names_by_id:
            regions.add(names_by_id[state_id])
            regions.add(state_id)
        for region in sorted(regions):
            if (region, year) not in seen:
                seen.add((region, year))
                result.append(TemperatureRecord(region=region, year=year, month=None, value=value).model_dump())
    for year, values in sorted(by_year.items()):
        if values and ("India", year) not in seen:
            result.append(TemperatureRecord(region="India", year=year, month=None, value=round(sum(values) / len(values), 2)).model_dump())
    return result



def extract_cyclones(workbook: Workbook, quality: Quality):
    records = workbook.records("Cyclone_Raw")
    try:
        units_row, units = next(records)
    except StopIteration as exc:
        raise PreparationBlocked("Cyclone_Raw is missing its source units row") from exc
    required = ("SID", "SEASON", "BASIN", "NAME", "ISO_TIME", "LAT", "LON", "WMO_WIND", "WMO_PRES")
    require_columns(units, required, "Cyclone_Raw")
    if units["SEASON"].strip() != "Year" or units["LAT"].strip() != "degrees_north" or units["LON"].strip() != "degrees_east":
        raise PreparationBlocked("Cyclone_Raw source units row cannot be confirmed")
    quality.note("tracks", units_row, "units_row_not_observation", source=units)
    storms: dict[str, dict] = {}
    storm_sources: dict[str, dict] = {}
    tracks = []
    seen = Observations("tracks", quality)
    for row, raw in records:
        if raw["BASIN"].strip() != "NI":
            quality.note("tracks", row, "excluded_non_NI_basin", source_basin=raw["BASIN"])
            continue
        storm_id = raw["SID"].strip()
        season = raw["SEASON"].strip()
        if not storm_id or not re.fullmatch(r"\d{4}", season) or not 1800 <= int(season) <= 2100:
            quality.note("tracks", row, "rejected_missing_or_invalid_storm_identity", source=raw)
            continue
        storm = {"storm_id": storm_id, "name": raw["NAME"].strip(), "year": int(season)}
        if storm_id in storms and storms[storm_id] != storm:
            quality.note("cyclones", row, "conflicting_duplicate", identity=[storm_id], first_source=storm_sources[storm_id], source={field: raw[field] for field in ("SID", "SEASON", "NAME")})
        elif storm_id not in storms:
            storms[storm_id] = StormRecord(**storm).model_dump()
            storm_sources[storm_id] = {field: raw[field] for field in ("SID", "SEASON", "NAME")}
        timestamp = source_timestamp(raw["ISO_TIME"], "tracks")
        # Invalid dates still participate in raw-identity collision detection.
        if not seen.accept((storm_id, timestamp or raw["ISO_TIME"]), raw, row):
            continue
        lat, lon = coordinates(raw, "LAT", "LON", quality, "tracks", row)
        if timestamp is None or lat is None:
            quality.note("tracks", row, "rejected_unusable_track", timestamp=timestamp, latitude=lat, longitude=lon, source=raw)
            continue
        if int(timestamp[:4]) != int(season):
            quality.note("tracks", row, "timestamp_year_differs_from_source_season", source_season=raw["SEASON"], timestamp=timestamp)
        intensity = {}
        for field, target in (("WMO_WIND", "wind"), ("WMO_PRES", "pressure")):
            # Negative IBTrACS sentinels and non-finite values are not observations.
            value = numeric(raw[field], 0 if target == "wind" else math.nextafter(0, 1), math.inf, quality, "tracks", row, field)
            unit = units[field].strip() or None
            expected = "kts" if target == "wind" else "mb"
            if unit != expected:
                quality.note("tracks", row, "unsupported_intensity_unit", field=field, source_unit=units[field], source=raw[field], prepared=None)
                value, unit = None, None
            intensity[target] = value
            intensity[target + "_unit"] = unit
        tracks.append(TrackRecord(storm_id=storm_id, timestamp=timestamp, latitude=lat, longitude=lon, **intensity).model_dump())
    return list(storms.values()), tracks, units


def reference_field(lines: list[str], label: str) -> str:
    for index, line in enumerate(lines):
        if line.startswith(label + ":"):
            pieces = [line[len(label) + 1:].strip()]
            for continuation in lines[index + 1:]:
                parsed = urlparse(continuation.strip())
                if parsed.scheme in ("http", "https") and parsed.netloc:
                    pieces.append(continuation.strip())
                    break
                if not continuation.strip() or re.match(r"^[A-Za-z][A-Za-z /-]*:", continuation):
                    break
                pieces.append(continuation.strip())
            return " ".join(piece for piece in pieces if piece)
    return ""


def extract_references(workbook: Workbook):
    lines = [raw.get("source_line", "") for _, raw in workbook.records("Sources_Reference")]
    sections: dict[int, list[str]] = {}
    active = None
    for line in lines:
        match = re.match(r"^([1-7])\. [A-Z ]+ - ", line)
        if match:
            active = int(match[1])
            sections[active] = []
        elif line == "DATASET SUMMARY":
            active = None
        if active is not None:
            sections[active].append(line)
    if set(sections) != set(SOURCE_IDS):
        raise PreparationBlocked("Sources_Reference must identify all seven source families")
    sources = []
    reference_details = {}
    for number, source_id in SOURCE_IDS.items():
        section = sections[number]
        urls = [line.strip() for line in section if urlparse(line.strip()).scheme in ("http", "https") and urlparse(line.strip()).netloc]
        url = reference_field(section, "Direct Download" if source_id == "nwic_boundaries" else "Dataset Source")
        if not url or url not in urls:
            raise PreparationBlocked(f"Source {source_id} lacks a workbook-declared dataset URL")
        limitations = [UNVERIFIED]
        if source_id == "landslides":
            limitations.append("Original landslide provenance is uncertain despite the workbook's NASA/GLC attribution; not independently verified.")
        omission_key = {"heat": "temperature", "nwic_boundaries": "boundaries", "imd_rainfall": "annual_rainfall"}.get(source_id, source_id)
        omission = OMISSIONS.get(omission_key)
        if omission:
            limitations.append(omission)
        if source_id == "imd_rainfall":
            limitations.append("Daily Actual source column has no declared unit in the workbook; units remain unspecified, not inferred as millimetres.")
        sources.append(Source(
            id=source_id,
            name=reference_field(section, "Dataset Name"),
            provider="; ".join(filter(None, (reference_field(section, "Source"), reference_field(section, "Organization")))),
            url=url,
            geographic_coverage=reference_field(section, "Coverage") + " (workbook-declared; not proof of complete observed coverage)",
            temporal_coverage="Not established from imported observations",
            data_format=reference_field(section, "Format") + " (original); XLSX workbook representation",
            purpose=reference_field(section, "Purpose"),
            provenance_status="uncertain; workbook-declared NASA/GLC attribution unverified" if source_id == "landslides" else "workbook-declared; not independently verified",
            limitations=limitations,
        ).model_dump())
        reference_details[source_id] = {"urls": urls, "exact_reference_lines": section}
    manifest_rows = [raw for _, raw in workbook.records("Manifest")]
    return sources, {"source_lines": lines, "families": reference_details, "workbook_manifest": manifest_rows}


def period(rows: list[dict], field: str) -> dict:
    values = [str(row[field]) for row in rows if row.get(field) is not None]
    return {"start": min(values) if values else None, "end": max(values) if values else None}


def metadata(name: str, rows: list[dict]) -> dict:
    source_id = {"states": "nwic_boundaries", "tracks": "cyclones", "rainfall": "imd_rainfall", "temperature": "heat"}.get(name, name)
    limitations = [UNVERIFIED, "Observed catalog coverage is not proof of complete reporting or absence of unrecorded events."]
    if name == "states":
        limitations.append(OMISSIONS["boundaries"])
    elif name == "rainfall":
        limitations += [OMISSIONS["annual_rainfall"], "Daily Actual only; source unit not specified, no millimetre unit inferred.", "Cleaned state/UT catalog names (including UT suffixes) are matched to official state codes."]
    elif name == "drought":
        limitations += ["National drought area percentage (IIT Gandhinagar India Drought Monitor column 5, 100 - normal area %), aggregated to annual mean across reported weekly observations.", "National scope only; cannot be disaggregated to states or districts."]
    elif name == "temperature":
        limitations += ["Annual summer (April–June) maximum temperature in °C from IMD / MoSPI EnviStats Heatwave_Raw.", "Query by state/region name (e.g. India, Karnataka, Rajasthan) or state code."]
    elif name in ("floods", "landslides"):
        limitations += ["Source dates have unspecified timezone; no timezone was invented.", "Cleaned single-state names and diacritic/historical variants are joined to official state codes; multi-state rows remain unassigned.", "Invalid/missing coordinate pairs remain null; no coordinates inferred."]
    else:
        limitations += ["NI basin only; North Indian Ocean presence does not imply Indian landfall.", "Storm catalog year is original SEASON, not derived from track calendar year.", "ISO_TIME is IBTrACS source UTC; only observed coordinates and WMO intensity are exposed."]
    if name == "landslides":
        limitations.append("Original landslide provenance is uncertain despite workbook NASA/GLC claims.")
    return Metadata(
        metric={
            "states": "source state catalog",
            "rainfall": "rainfall_daily_actual",
            "drought": "national_drought_area_pct",
            "temperature": "summer_max_temperature",
            "floods": "recorded flood events",
            "landslides": "recorded landslide events",
            "cyclones": "recorded NI cyclone seasons",
            "tracks": "observed NI cyclone positions and WMO intensity",
        }[name],
        unit={"drought": "%", "temperature": "°C"}.get(name),
        geographic_level="state" if name in ("states", "rainfall") else "national" if name == "drought" else "regional" if name == "temperature" else "point" if name in ("floods", "landslides", "tracks") else "basin",
        time_resolution="not applicable" if name == "states" else "day" if name == "rainfall" else "annual" if name in ("drought", "temperature") else "source season" if name == "cyclones" else "source observation timestamp",
        period=period(rows, "year" if name in ("cyclones", "drought", "temperature") else "date" if name == "rainfall" else "timestamp"),
        source_ids=[source_id],
        method="Cleaned source-text parsing, Unicode/UT state normalization and explicit record validation.",
        observation_count=len(rows),
        limitations=limitations,
    ).model_dump()


def write_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def write_parquet(path: Path, rows: list[dict], name: str):
    import pyarrow as pa
    import pyarrow.parquet as pq

    if rows:
        table = pa.Table.from_pylist(rows)
    else:
        if name in ("floods", "landslides"):
            schema = pa.schema([("event_id", pa.string()), ("state_id", pa.string()), ("year", pa.int64()), ("timestamp", pa.string()), ("longitude", pa.float64()), ("latitude", pa.float64()), ("attributes", pa.map_(pa.string(), pa.string()))])
        elif name == "rainfall":
            schema = pa.schema([("state_id", pa.string()), ("year", pa.int64()), ("date", pa.string()), ("value", pa.float64())])
        else:
            schema = pa.schema([("storm_id", pa.string()), ("timestamp", pa.string()), ("longitude", pa.float64()), ("latitude", pa.float64()), ("wind", pa.float64()), ("pressure", pa.float64()), ("wind_unit", pa.string()), ("pressure_unit", pa.string())])
        table = pa.Table.from_pylist([], schema=schema)
    pq.write_table(table, path, compression="zstd")


def prepare(workbook_path: Path, output: Path) -> dict:
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "status": "blocked", "workbook": str(workbook_path.resolve()),
        "processed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "omissions": OMISSIONS, "issue_evidence": "processing_issues.jsonl",
        "publication_policy": "Conflicting duplicate identities block all dataset publication; existing datasets are untouched on failure.",
        "deduplication": "Only complete exact raw source rows sharing an observation identity are deduplicated.",
    }
    with tempfile.TemporaryDirectory(prefix="workbook-prepare-", dir=output.parent) as temporary:
        staging = Path(temporary)
        with (staging / "processing_issues.jsonl").open("w", encoding="utf-8") as issues:
            quality = Quality(issues)
            try:
                with Workbook(workbook_path) as workbook:
                    sources, references = extract_references(workbook)
                    report["references"] = references
                    states = extract_states(workbook, quality)
                    lookup = state_lookup(states)
                    rainfall = extract_rainfall(workbook, lookup, quality)
                    floods = extract_events(workbook, "floods", lookup, quality)
                    landslides = extract_events(workbook, "landslides", lookup, quality)
                    storms, tracks, units = extract_cyclones(workbook, quality)
                    drought = extract_drought(workbook, quality) if "Drought_Raw" in workbook.sheets else None
                    temperature = extract_temperature(workbook, states, lookup, quality) if "Heatwave_Raw" in workbook.sheets else None
                rows_by_name = {"states": states, "rainfall": rainfall, "floods": floods, "landslides": landslides, "cyclones": storms, "tracks": tracks}
                if drought:
                    rows_by_name["drought"] = drought
                if temperature:
                    rows_by_name["temperature"] = temperature
                metas = {name: metadata(name, rows) for name, rows in rows_by_name.items()}
                report["observed_coverage"] = {name: {"count": len(rows), "period": metas[name]["period"]} for name, rows in rows_by_name.items()}
                report["cyclone_source_units"] = units
                report["issue_counts"] = dict(quality.counts)
                report["blockers"] = quality.blockers
                if quality.blockers:
                    raise PreparationBlocked(f"{len(quality.blockers)} conflicting source observation identities; inspect processing_issues.jsonl")
                datasets = {}
                for name, rows in rows_by_name.items():
                    extension = "json" if name in ("states", "cyclones") else "parquet"
                    filename = f"{name}.{extension}"
                    if extension == "json":
                        write_json(staging / filename, rows)
                    else:
                        write_parquet(staging / filename, rows, name)
                    datasets[name] = {"path": filename, "format": extension, "meta": metas[name]}
                for source in sources:
                    names = [name for name, meta in metas.items() if source["id"] in meta["source_ids"]]
                    descriptions = [f"{name}: {metas[name]['observation_count']} observations; {metas[name]['period']['start'] or 'undated'} to {metas[name]['period']['end'] or 'undated'}" for name in names]
                    source["temporal_coverage"] = "; ".join(descriptions) if descriptions else "Not imported; observed temporal coverage not established"
                active_omissions = {k: v for k, v in OMISSIONS.items() if k not in rows_by_name}
                comparison_metrics = [
                    metric for metric, rows in (("flood_event_count", floods), ("landslide_event_count", landslides))
                    if len(states) >= 2 and rows
                ]
                available_hazards = [
                    hazard for hazard, key in (("heat", "temperature"), ("floods", "floods"), ("drought", "drought"), ("landslides", "landslides"), ("cyclones", "cyclones"))
                    if rows_by_name.get(key)
                ]
                manifest = {
                    "version": 1, "processed_at": report["processed_at"],
                    "metadata": Metadata(metric="prepared historical observation catalog", geographic_level="mixed", time_resolution="mixed source observations", source_ids=list(SOURCE_IDS.values()), observation_count=sum(len(rows) for rows in rows_by_name.values()), limitations=[UNVERIFIED, *active_omissions.values(), "Original landslide provenance remains uncertain."]).model_dump(),
                    "datasets": datasets, "sources": sources,
                    "capabilities": {
                        "available_datasets": list(datasets),
                        "comparison_metrics": comparison_metrics,
                        "rainfall_observation_dates": sorted({row["date"] for row in rainfall}),
                        "available_years": {
                            name: sorted({row["year"] if row.get("year") is not None else int(row["timestamp"][:4]) for row in rows if row.get("year") is not None or row.get("timestamp")})
                            for name, rows in rows_by_name.items()
                        },
                        "available_hazards": available_hazards,
                        "omitted_datasets": active_omissions,
                        "boundaries": False,
                        "observed_replay": [name for name in ("rainfall", "floods", "landslides", "cyclones") if any(row.get("date") or row.get("timestamp") for row in rows_by_name["tracks" if name == "cyclones" else name])],
                    },
                }
                report["status"] = "prepared"
                write_json(staging / "manifest.json", manifest)
            except Exception as exc:
                report["error"] = f"{type(exc).__name__}: {exc}"
                report["issue_counts"] = dict(quality.counts)
                report["blockers"] = quality.blockers
                write_json(staging / "processing_report.json", report)
                output.mkdir(parents=True, exist_ok=True)
                for filename in ("processing_report.json", "processing_issues.jsonl"):
                    # Close the issue stream before replacing on Windows.
                    if filename.endswith(".jsonl"):
                        issues.flush()
                        issues.close()
                    os.replace(staging / filename, output / filename)
                raise
        write_json(staging / "processing_report.json", report)
        output.mkdir(parents=True, exist_ok=True)
        # Publish the manifest last, after all source validation and serialization.
        for path in staging.iterdir():
            if path.name != "manifest.json":
                os.replace(path, output / path.name)
        os.replace(staging / "manifest.json", output / "manifest.json")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workbook", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = prepare(args.workbook, args.output)
    except Exception as exc:
        print(f"Preparation blocked: {exc}. See output processing_report.json when available.", file=sys.stderr)
        return 1
    print(json.dumps({"status": report["status"], "output": str(args.output.resolve()), "observed_coverage": report["observed_coverage"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
