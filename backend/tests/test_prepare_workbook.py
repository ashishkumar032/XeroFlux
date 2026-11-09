"""Tiny synthetic ZIP/XML fixtures only; no observed workbook data is copied."""

from datetime import datetime
from io import StringIO
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import pandas as pd
import pytest

from prepare_workbook import (
    NS,
    Observations,
    PreparationBlocked,
    Quality,
    Workbook,
    coordinates,
    extract_cyclones,
    extract_events,
    extract_rainfall,
    extract_references,
    extract_states,
    metadata,
    prepare,
    resolve_state,
    source_timestamp,
    state_lookup,
)


def letter(index):
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def synthetic_workbook(tmp_path: Path, sheets: dict, *, shared=False) -> Path:
    """Minimal test-only OOXML container, not a full workbook fixture copy."""
    path = tmp_path / "synthetic-test-only.xlsx"
    with zipfile.ZipFile(path, "w") as archive:
        workbook = ET.Element(NS + "workbook")
        sheet_nodes = ET.SubElement(workbook, NS + "sheets")
        relationships = ET.Element("Relationships", xmlns="http://schemas.openxmlformats.org/package/2006/relationships")
        for index, (name, rows) in enumerate(sheets.items(), 1):
            ET.SubElement(sheet_nodes, NS + "sheet", {"name": name, "sheetId": str(index), "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id": f"rId{index}"})
            ET.SubElement(relationships, "Relationship", {"Id": f"rId{index}", "Target": f"worksheets/sheet{index}.xml", "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"})
            worksheet = ET.Element(NS + "worksheet")
            data = ET.SubElement(worksheet, NS + "sheetData")
            for row_number, row in enumerate(rows, 1):
                row_node = ET.SubElement(data, NS + "row", r=str(row_number))
                for column, value in enumerate(row, 1):
                    if value is None:
                        continue
                    attributes = {"r": f"{letter(column)}{row_number}", "t": "inlineStr"}
                    if shared and value == "SHARED_TEST_ONLY":
                        attributes["t"] = "s"
                    cell = ET.SubElement(row_node, NS + "c", attributes)
                    if attributes["t"] == "s":
                        ET.SubElement(cell, NS + "v").text = "0"
                    elif isinstance(value, tuple):
                        inline = ET.SubElement(cell, NS + "is")
                        for text in value:
                            run = ET.SubElement(inline, NS + "r")
                            ET.SubElement(run, NS + "t").text = text
                    else:
                        inline = ET.SubElement(cell, NS + "is")
                        ET.SubElement(inline, NS + "t").text = value
            archive.writestr(f"xl/worksheets/sheet{index}.xml", ET.tostring(worksheet))
        archive.writestr("xl/workbook.xml", ET.tostring(workbook))
        archive.writestr("xl/_rels/workbook.xml.rels", ET.tostring(relationships))
        if shared:
            archive.writestr("xl/sharedStrings.xml", f'<sst xmlns="{NS[1:-1]}"><si><t> shared exact text </t></si></sst>')
    return path


def quality():
    stream = StringIO()
    return Quality(stream), stream


def reference_rows():
    lines = ["source_line"]
    for number, category in enumerate(("LANDSLIDES", "INDIA BOUNDARIES", "DROUGHT", "HEAT", "FLOOD", "RAINFALL", "CYCLONES"), 1):
        lines.extend([
            f"{number}. {category} - SYNTHETIC TEST ONLY",
            "", "Dataset Name: Synthetic test-only catalog", "",
            "Source: Synthetic test-only provider", "",
            "Organization: Synthetic test-only organization", "",
            "Format: CSV", "", "Coverage: Synthetic region", "",
            "Dataset Source:", f"https://example.invalid/catalog/{number}", "",
            "Direct Download:", f"https://example.invalid/download/{number}", "",
            "Purpose:", "Synthetic tests only.", "",
        ])
    return [[line] for line in lines]


def complete_sheets():
    return {
        "Sources_Reference": reference_rows(),
        "Manifest": [["worksheet", "omitted_content_or_limitation"], ["State_Attributes", "GEOMETRY OMITTED: synthetic test only"]],
        "State_Attributes": [["stcode", "state_name"], ["01", "Test State"]],
        "Flood_Raw": [["UEI", "Start Date", "State", "Latitude", "Longitude", "Description"], ["TEST-FLOOD", "02-07-2000 03:04", "Test State", "21", "80", " test-only raw\ntext "]],
        "Landslide_Raw": [["event_id", "event_date", "admin_division_name", "latitude", "longitude"], ["TEST-LANDSLIDE", "03/12/2001 12:00:00 AM", "Test District", "", ""]],
        "Rainfall_Raw": [["State", "Date", "Daily Actual", "Daily Normal"], ["Test State", "2002-08-19", "4.1", "9.9"]],
        "Cyclone_Raw": [
            ["SID", "SEASON", "BASIN", "NAME", "ISO_TIME", "LAT", "LON", "WMO_WIND", "WMO_PRES"],
            [" ", "Year", " ", " ", " ", "degrees_north", "degrees_east", "kts", "mb"],
            ["TEST-STORM", "2002", "NI", "TEST ONLY", "2003-01-01 00:00:00", "10", "80", " ", "999"],
        ],
    }


def test_sparse_inline_rich_and_shared_strings_preserve_exact_source_text(tmp_path):
    path = synthetic_workbook(tmp_path, {"Synthetic": [["first", "second", "third"], [("  exact ", "rich\ntext  "), None, "SHARED_TEST_ONLY"], []]}, shared=True)
    with Workbook(path) as workbook:
        records = list(workbook.records("Synthetic"))
    assert records == [(2, {"first": "  exact rich\ntext  ", "second": "", "third": " shared exact text "}), (3, {"first": "", "second": "", "third": ""})]


@pytest.mark.parametrize("value,dataset,expected", [
    ("02-07-1967 13:04", "floods", "1967-07-02T13:04:00"),
    ("03/12/2007 12:00:00 AM", "landslides", "2007-03-12T00:00:00"),
    ("03/12/2007 01:02:03 PM", "landslides", "2007-03-12T13:02:03"),
    ("03/12/2007", "landslides", "2007-03-12"),
    ("2000-01-02 03:04:05", "tracks", "2000-01-02T03:04:05Z"),
    ("31-02-2000 00:00", "floods", None),
    ("", "landslides", None),
])
def test_source_dates_have_no_invented_timezone_or_day(value, dataset, expected):
    assert source_timestamp(value, dataset) == expected
    if expected and dataset != "tracks":
        assert datetime.fromisoformat(expected).tzinfo is None


def test_state_identifiers_are_source_codes_and_safe_normalization_only(tmp_path):
    path = synthetic_workbook(tmp_path, {"State_Attributes": [["stcode", "state_name"], ["01", "Test-State"], ["09", "Other State"]]})
    q, _ = quality()
    with Workbook(path) as workbook:
        states = extract_states(workbook, q)
    assert states[0] == {"state_id": "01", "name": "Test-State"}
    lookup = state_lookup(states)
    assert resolve_state(" TEST state ", lookup) == "01"
    assert resolve_state("Test-State, Other State", lookup) is None
    assert resolve_state("Test District", lookup) is None
    assert resolve_state("TS", lookup) is None
    assert resolve_state("", lookup) is None


def test_ambiguous_normalized_catalog_names_are_not_joined():
    lookup = state_lookup([{"state_id": "01", "name": "Test-State"}, {"state_id": "02", "name": "Test State"}])
    assert resolve_state("Test State", lookup) is None


@pytest.mark.parametrize("latitude,longitude", [("", "80"), ("-999", "80"), ("NaN", "80"), ("20", "999"), ("20", "Infinity"), ("bad", "80")])
def test_invalid_coordinate_or_sentinel_nulls_the_pair(latitude, longitude):
    q, stream = quality()
    assert coordinates({"lat": latitude, "lon": longitude}, "lat", "lon", q, "test", 2) == (None, None)
    assert '"prepared": null' in stream.getvalue()


def test_zero_is_not_a_missing_coordinate():
    q, _ = quality()
    assert coordinates({"lat": "0", "lon": "0"}, "lat", "lon", q, "test", 2) == (0.0, 0.0)


def test_multistate_and_district_events_keep_source_attributes(tmp_path):
    sheets = complete_sheets()
    sheets["Flood_Raw"][1][2] = "Test State, Other State"
    path = synthetic_workbook(tmp_path, sheets)
    q, _ = quality()
    with Workbook(path) as workbook:
        lookup = state_lookup(extract_states(workbook, q))
        floods = extract_events(workbook, "floods", lookup, q)
        landslides = extract_events(workbook, "landslides", lookup, q)
    assert floods[0]["state_id"] is None
    assert floods[0]["attributes"]["State"] == "Test State, Other State"
    assert floods[0]["attributes"]["Description"] == " test-only raw\ntext "
    assert landslides[0]["state_id"] is None
    assert landslides[0]["latitude"] is None
    assert landslides[0]["longitude"] is None


def test_exact_source_deduplication_and_conflicting_identity_evidence():
    q, stream = quality()
    seen = Observations("test", q)
    assert seen.accept(("test-only-id",), {"value": " 1 "}, 2)
    assert not seen.accept(("test-only-id",), {"value": " 1 "}, 3)
    assert not seen.accept(("test-only-id",), {"value": "1"}, 4)
    assert q.counts["test.exact_duplicate"] == 1
    assert q.counts["test.conflicting_duplicate"] == 1
    assert q.blockers[0]["first_row"] == 2
    assert '"source": {"value": "1"}' in stream.getvalue()


def test_cyclone_units_row_season_utc_and_NI_filter(tmp_path):
    sheets = complete_sheets()
    sheets["Cyclone_Raw"].append(["OTHER-STORM", "2002", "NA", "TEST", "2002-01-01 00:00:00", "10", "80", "20", "1000"])
    sheets["Cyclone_Raw"].append(["TEST-STORM", "2002", "NI", "TEST ONLY", "2003-01-01 03:00:00", "-999", "80", "20", "1000"])
    path = synthetic_workbook(tmp_path, sheets)
    q, _ = quality()
    with Workbook(path) as workbook:
        storms, tracks, units = extract_cyclones(workbook, q)
    assert storms == [{"storm_id": "TEST-STORM", "name": "TEST ONLY", "year": 2002}]
    assert len(tracks) == 1
    assert tracks[0]["timestamp"] == "2003-01-01T00:00:00Z"
    assert tracks[0]["wind"] is None
    assert tracks[0]["wind_unit"] == "kts"
    assert tracks[0]["pressure"] == 999
    assert tracks[0]["pressure_unit"] == units["WMO_PRES"] == "mb"
    assert q.counts["tracks.units_row_not_observation"] == 1
    assert q.counts["tracks.excluded_non_NI_basin"] == 1
    assert q.counts["tracks.rejected_unusable_track"] == 1


def test_rainfall_is_daily_actual_with_no_annual_aggregation_or_aliases(tmp_path):
    sheets = complete_sheets()
    sheets["Rainfall_Raw"].extend([["Test State", "2002-08-20", "0", "20"], ["TS", "2002-08-20", "99", "20"], ["Test State", "2002-08-21", "-999", "20"]])
    path = synthetic_workbook(tmp_path, sheets)
    q, _ = quality()
    with Workbook(path) as workbook:
        rows = extract_rainfall(workbook, {"test state": "01"}, q)
    assert rows == [{"state_id": "01", "year": 2002, "date": "2002-08-19", "value": 4.1}, {"state_id": "01", "year": 2002, "date": "2002-08-20", "value": 0.0}]
    meta = metadata("rainfall", rows)
    assert meta["metric"] == "rainfall_daily_actual"
    assert meta["unit"] is None
    assert meta["time_resolution"] == "day"
    assert meta["period"] == {"start": "2002-08-19", "end": "2002-08-20"}
    assert q.counts["rainfall.rejected_unresolved_state"] == 1
    assert q.counts["rainfall.rejected_unusable_measurement"] == 1


def test_source_catalog_includes_all_seven_unverified_families(tmp_path):
    path = synthetic_workbook(tmp_path, complete_sheets())
    with Workbook(path) as workbook:
        sources, evidence = extract_references(workbook)
    assert len(sources) == 7
    assert {source["id"] for source in sources} == {"landslides", "nwic_boundaries", "drought", "heat", "floods", "imd_rainfall", "cyclones"}
    assert all("not independently verified" in source["provenance_status"] or "unverified" in source["provenance_status"] for source in sources)
    assert "uncertain" in sources[0]["provenance_status"]
    assert sources[1]["url"] == "https://example.invalid/download/2"
    assert evidence["families"]["imd_rainfall"]["urls"] == ["https://example.invalid/catalog/6", "https://example.invalid/download/6"]


def test_preparation_writes_contract_records_parquet_and_honest_coverage(tmp_path):
    path = synthetic_workbook(tmp_path, complete_sheets())
    output = tmp_path / "prepared"
    report = prepare(path, output)
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert report["status"] == "prepared"
    assert set(manifest["datasets"]) == {"states", "rainfall", "floods", "landslides", "cyclones", "tracks"}
    assert manifest["capabilities"]["comparison_metrics"] == []
    assert manifest["capabilities"]["rainfall_observation_dates"] == ["2002-08-19"]
    assert "analytics" not in manifest["capabilities"]
    assert not manifest["capabilities"]["boundaries"]
    assert json.loads((output / "states.json").read_text()) == [{"state_id": "01", "name": "Test State"}]
    assert pd.read_parquet(output / "floods.parquet").iloc[0]["attributes"]["Description"] == " test-only raw\ntext "
    assert manifest["datasets"]["tracks"]["meta"]["period"] == {"start": "2003-01-01T00:00:00Z", "end": "2003-01-01T00:00:00Z"}
    assert (output / "processing_issues.jsonl").is_file()
    assert report["references"]["workbook_manifest"][0]["worksheet"] == "State_Attributes"


def test_conflicting_duplicates_block_publication_and_preserve_existing_manifest(tmp_path):
    sheets = complete_sheets()
    sheets["Flood_Raw"].append(["TEST-FLOOD", "02-07-2000 03:04", "Test State", "22", "80", "conflicting test-only row"])
    path = synthetic_workbook(tmp_path, sheets)
    output = tmp_path / "prepared"
    output.mkdir()
    (output / "manifest.json").write_text("existing-user-prepared-manifest", encoding="utf-8")
    with pytest.raises(PreparationBlocked, match="conflicting source observation"):
        prepare(path, output)
    assert (output / "manifest.json").read_text() == "existing-user-prepared-manifest"
    assert not (output / "floods.parquet").exists()
    report = json.loads((output / "processing_report.json").read_text(encoding="utf-8"))
    assert report["status"] == "blocked"
    assert report["issue_counts"]["floods.conflicting_duplicate"] == 1
