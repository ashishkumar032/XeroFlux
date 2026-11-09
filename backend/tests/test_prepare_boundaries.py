"""Synthetic projected triangles only: no official boundaries or climate values."""

from copy import deepcopy
import json
from pathlib import Path
from zipfile import ZipFile

import pytest
from pyproj import Transformer

from prepare_boundaries import PreparationError, main, prepare_boundaries, reproject_collection


CRS_NAME = "urn:ogc:def:crs:EPSG::7755"
CATALOG = {"TEST-A": "Synthetic State A"}
ARCHIVE_URL = "https://example.invalid/synthetic-boundaries.zip"


def project_ring(ring):
    transformer = Transformer.from_crs("EPSG:4326", CRS_NAME, always_xy=True)
    return [list(transformer.transform(*position, errcheck=True)) for position in ring]


def collection(geometry=None):
    triangle = [[81.0, 19.0], [82.0, 19.0], [81.0, 20.0], [81.0, 19.0]]
    return {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": CRS_NAME}},
        "bbox": [0, 0, 1, 1],  # Deliberately projected/stale; must be replaced.
        "features": [{
            "type": "Feature",
            "bbox": [0, 0, 1, 1],
            "properties": {"stcode": "TEST-A", "state_name": "Synthetic State A", "test_only": True},
            "geometry": geometry or {"type": "Polygon", "coordinates": [project_ring(triangle)]},
        }],
    }


def meta(count):
    return {
        "metric": "synthetic catalog",
        "unit": None,
        "geographic_level": "state",
        "time_resolution": "static",
        "period": {"start": None, "end": None},
        "source_ids": ["nwic_boundaries"],
        "method": "Synthetic test-only fixture",
        "observation_count": count,
        "limitations": ["Synthetic test-only data"],
    }


@pytest.fixture
def prepared_catalog(tmp_path):
    output = tmp_path / "processed"
    output.mkdir()
    (output / "states.json").write_text(json.dumps([
        {"state_id": state_id, "name": name} for state_id, name in CATALOG.items()
    ]), encoding="utf-8")
    manifest = {
        "version": 1,
        "processed_at": "2000-01-01T00:00:00+00:00",
        "metadata": meta(1),
        "datasets": {"states": {"path": "states.json", "format": "json", "meta": meta(1)}},
        "sources": [{
            "id": "nwic_boundaries",
            "name": "Synthetic boundary source",
            "provider": "Synthetic test provider",
            "url": ARCHIVE_URL,
            "geographic_coverage": "Synthetic triangle",
            "temporal_coverage": "Test only",
            "data_format": "GeoJSON ZIP",
            "purpose": "Tests only",
            "provenance_status": "synthetic-test-only",
            "limitations": ["Not official source data"],
        }],
        "capabilities": {"test_marker": ["preserve unchanged"]},
    }
    (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return output, manifest


def archive_at(path, data=None):
    with ZipFile(path, "w") as archive:
        archive.writestr("synthetic_NWIC.GeoJSON", json.dumps(collection() if data is None else data))
    return path


def test_reprojects_declared_projected_triangle_without_swapping_axes():
    source = collection()
    snapshot = deepcopy(source)
    result = reproject_collection(source, CATALOG)
    ring = result["features"][0]["geometry"]["coordinates"][0]
    expected = [[81, 19], [82, 19], [81, 20], [81, 19]]
    for actual, wanted in zip(ring, expected, strict=True):
        assert actual == pytest.approx(wanted, abs=1e-8)
    assert ring[0][0] > 80 and ring[0][1] < 20
    assert result["bbox"] == pytest.approx([81, 19, 82, 20], abs=1e-8)
    assert "crs" not in result
    assert "bbox" not in result["features"][0]
    assert result["features"][0]["properties"] == {
        "stcode": "TEST-A", "state_name": "Synthetic State A", "test_only": True,
        "state_id": "TEST-A", "name": "Synthetic State A",
    }
    assert source == snapshot
    preparation = result["preparation"]
    assert preparation["source_crs"] == CRS_NAME
    assert preparation["target_crs"] == "EPSG:4326"
    assert preparation["always_xy"] is True
    assert preparation["method"] == "reproject"
    assert preparation["feature_count"] == 1


def test_preserves_multipolygon_islands_holes_every_vertex_and_full_extent():
    outer = [[80, 18], [83, 18], [80, 21], [80, 18]]
    hole = [[80.2, 18.2], [80.4, 18.2], [80.2, 18.4], [80.2, 18.2]]
    island = [[90, 10], [90.2, 10], [90, 10.2], [90, 10]]
    original = [[outer, hole], [island]]
    source = collection({
        "type": "MultiPolygon",
        "coordinates": [[project_ring(ring) for ring in polygon] for polygon in original],
    })
    result = reproject_collection(source, CATALOG)
    geometry = result["features"][0]["geometry"]
    assert geometry["type"] == "MultiPolygon"
    assert len(geometry["coordinates"]) == 2
    for actual_polygon, expected_polygon in zip(geometry["coordinates"], original, strict=True):
        for actual_ring, expected_ring in zip(actual_polygon, expected_polygon, strict=True):
            for actual, expected in zip(actual_ring, expected_ring, strict=True):
                assert actual == pytest.approx(expected, abs=1e-8)
    assert result["bbox"] == pytest.approx([80, 10, 90.2, 21], abs=1e-8)


def test_name_matching_uses_only_workbook_outer_whitespace_normalization():
    source = collection()
    source["features"][0]["properties"]["state_name"] = "  Synthetic State A  "
    result = reproject_collection(source, CATALOG)
    assert result["features"][0]["properties"]["name"] == "Synthetic State A"
    assert result["features"][0]["properties"]["state_name"] == "  Synthetic State A  "


def test_boundary_publication_preserves_unrelated_assets_and_catalog_entries(prepared_catalog, tmp_path):
    output, before = prepared_catalog
    states_before = (output / "states.json").read_bytes()
    unrelated = output / "unrelated.bin"
    unrelated.write_bytes(b"unchanged unrelated asset")
    result = prepare_boundaries(archive_at(tmp_path / "source.zip"), output)
    after = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    spec = after["datasets"].pop("boundaries")
    assert after["datasets"] == before["datasets"]
    assert after["sources"] == before["sources"]
    assert after["capabilities"]["test_marker"] == before["capabilities"]["test_marker"]
    assert spec["path"] == "boundaries.geojson"
    assert spec["format"] == "geojson"
    assert spec["meta"]["observation_count"] == 1
    assert spec["meta"]["source_ids"] == ["nwic_boundaries"]
    assert "reproject" in spec["meta"]["method"]
    assert CRS_NAME in spec["meta"]["method"]
    assert ARCHIVE_URL in spec["meta"]["method"]
    assert (output / "states.json").read_bytes() == states_before
    assert unrelated.read_bytes() == b"unchanged unrelated asset"
    boundaries = json.loads((output / "boundaries.geojson").read_text(encoding="utf-8"))
    assert result == boundaries["preparation"]
    assert result["archive_url"] == ARCHIVE_URL
    assert result["archive_member"] == "synthetic_NWIC.GeoJSON"
    assert result["feature_count"] == len(boundaries["features"])
    assert not list(output.glob(".*.tmp"))


@pytest.mark.parametrize("problem", ["missing_crs", "invalid_crs", "conflicting_crs", "empty_features", "unsupported_geometry", "nonfinite", "unclosed", "unknown_code", "wrong_name", "duplicate", "outside_range"])
def test_rejects_invalid_sources(problem):
    source = collection()
    feature = source["features"][0]
    if problem == "missing_crs":
        del source["crs"]
    elif problem == "invalid_crs":
        source["crs"]["properties"]["name"] = "invalid-crs-test-only"
    elif problem == "conflicting_crs":
        feature["crs"] = {"type": "name", "properties": {"name": "EPSG:4326"}}
    elif problem == "empty_features":
        source["features"] = []
    elif problem == "unsupported_geometry":
        feature["geometry"] = {"type": "LineString", "coordinates": [[1, 2], [3, 4]]}
    elif problem == "nonfinite":
        feature["geometry"]["coordinates"][0][1][0] = float("nan")
    elif problem == "unclosed":
        feature["geometry"]["coordinates"][0][-1] = [0, 0]
    elif problem == "unknown_code":
        feature["properties"]["stcode"] = "UNKNOWN"
    elif problem == "wrong_name":
        feature["properties"]["state_name"] = "Not the catalog name"
    elif problem == "duplicate":
        source["features"].append(deepcopy(feature))
    elif problem == "outside_range":
        source["crs"]["properties"]["name"] = "EPSG:4326"
        feature["geometry"]["coordinates"] = [[[81, 95], [82, 95], [81, 96], [81, 95]]]
    with pytest.raises(PreparationError):
        reproject_collection(source, CATALOG)


def test_invalid_source_does_not_change_existing_files(prepared_catalog, tmp_path):
    output, _ = prepared_catalog
    boundary = output / "boundaries.geojson"
    boundary.write_bytes(b"previous boundary payload")
    manifest_before = (output / "manifest.json").read_bytes()
    invalid = collection()
    invalid["features"][0]["properties"]["stcode"] = "UNKNOWN"
    with pytest.raises(PreparationError, match="existing states catalog"):
        prepare_boundaries(archive_at(tmp_path / "invalid.zip", invalid), output)
    assert (output / "manifest.json").read_bytes() == manifest_before
    assert boundary.read_bytes() == b"previous boundary payload"
    assert not list(output.glob(".*.tmp"))


def test_missing_manifest_is_clear_error_and_cli_returns_failure(tmp_path, capsys):
    output = tmp_path / "not-prepared"
    archive = archive_at(tmp_path / "synthetic.zip")
    assert main(["--archive", str(archive), "--output", str(output)]) == 1
    assert "run workbook preparation first" in capsys.readouterr().err
    assert not output.exists()


def test_missing_official_source_is_rejected(prepared_catalog, tmp_path):
    output, manifest = prepared_catalog
    manifest["sources"] = []
    manifest["metadata"]["source_ids"] = []
    manifest["datasets"]["states"]["meta"]["source_ids"] = []
    (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PreparationError, match="nwic_boundaries"):
        prepare_boundaries(archive_at(tmp_path / "synthetic.zip"), output)
    assert not (output / "boundaries.geojson").exists()


def test_manifest_replace_failure_never_truncates_existing_manifest(prepared_catalog, tmp_path, monkeypatch):
    import prepare_boundaries as module

    output, _ = prepared_catalog
    original = (output / "manifest.json").read_bytes()
    real_replace = module.os.replace

    def fail_manifest(source, destination):
        if Path(destination).name == "manifest.json":
            raise OSError("Synthetic publication failure")
        return real_replace(source, destination)

    monkeypatch.setattr(module.os, "replace", fail_manifest)
    with pytest.raises(OSError, match="publication failure"):
        prepare_boundaries(archive_at(tmp_path / "synthetic.zip"), output)
    assert (output / "manifest.json").read_bytes() == original
    assert not list(output.glob(".*.tmp"))


def test_rejects_ambiguous_archive_without_mutating_catalog(prepared_catalog, tmp_path):
    output, _ = prepared_catalog
    original = (output / "manifest.json").read_bytes()
    archive = archive_at(tmp_path / "ambiguous.zip")
    with ZipFile(archive, "a") as source:
        source.writestr("second.geojson", json.dumps(collection()))
    with pytest.raises(PreparationError, match="exactly one"):
        prepare_boundaries(archive, output)
    assert (output / "manifest.json").read_bytes() == original
    assert not (output / "boundaries.geojson").exists()


def test_missing_states_catalog_never_guesses_ids(prepared_catalog, tmp_path):
    output, manifest = prepared_catalog
    manifest["datasets"].pop("states")
    (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    original = (output / "manifest.json").read_bytes()
    with pytest.raises(PreparationError, match="no state IDs will be guessed"):
        prepare_boundaries(archive_at(tmp_path / "synthetic.zip"), output)
    assert (output / "manifest.json").read_bytes() == original
    assert not (output / "boundaries.geojson").exists()

def test_published_boundaries_enable_map_capability_and_clear_only_resolved_omission(prepared_catalog, tmp_path):
    output, manifest = prepared_catalog
    manifest["capabilities"].update({
        "boundaries": False, "available_datasets": ["states"],
        "omitted_datasets": {"boundaries": "Geometry absent", "drought": "Unknown columns"},
    })
    (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    prepare_boundaries(archive_at(tmp_path / "synthetic.zip"), output)
    published = json.loads((output / "manifest.json").read_text(encoding="utf-8"))["capabilities"]
    assert published["boundaries"] is True
    assert "boundaries" in published["available_datasets"]
    assert published["omitted_datasets"] == {"drought": "Unknown columns"}
