"""Synthetic, temporary test-only data; none is a ClimateLens observation."""

from copy import deepcopy
import json
import os
from pathlib import Path

import pandas as pd
import pytest

from app.core.errors import AppError
from app.models import Metadata
from app.repositories.dataset_repository import DatasetRepository


def metadata(**changes):
    value = {
        "metric": "test-only declared metric",
        "unit": "test-only units",
        "geographic_level": "state",
        "time_resolution": "annual",
        "period": {"start": "2000", "end": "2001"},
        "source_ids": ["test-source"],
        "method": "Test fixture, not a scientific method",
        "observation_count": 17,
        "limitations": ["Synthetic test-only fixture"],
    }
    value.update(changes)
    return value


def source():
    return {
        "id": "test-source",
        "name": "Synthetic test-only source",
        "provider": "Test suite",
        "url": "https://example.invalid/test-only",
        "geographic_coverage": "Synthetic region",
        "temporal_coverage": "Synthetic period",
        "data_format": "JSON",
        "purpose": "Automated tests only",
        "provenance_status": "synthetic-test-only",
        "limitations": ["Not a real source"],
    }


class Store:
    def __init__(self, root):
        self.root = root
        self.manifest = {
            "version": 1,
            "processed_at": "2001-01-01T00:00:00Z",
            "metadata": metadata(metric="test-only catalog", observation_count=93),
            "sources": [source()],
            "datasets": {},
            "capabilities": {"comparison": {"metrics": ["test-only"]}},
        }
        self.save()

    def save(self):
        (self.root / "manifest.json").write_text(
            json.dumps(self.manifest, allow_nan=False), encoding="utf-8"
        )

    def add(self, name, rows, *, format="json", scope="state", **meta):
        extension = {"json": ".json", "geojson": ".geojson", "parquet": ".parquet"}[format]
        path = self.root / (name + extension)
        if format == "parquet":
            path.write_bytes(b"test-only placeholder; reader is monkeypatched")
        else:
            path.write_text(json.dumps(rows, allow_nan=False), encoding="utf-8")
        record_count = len(rows.get("features", [])) if isinstance(rows, dict) else len(rows)
        meta.setdefault("observation_count", record_count)
        self.manifest["datasets"][name] = {
            "path": path.name,
            "format": format,
            "meta": metadata(geographic_level=scope, **meta),
        }
        self.save()
        return path

    def repository(self):
        return DatasetRepository(self.root)


@pytest.fixture
def store(tmp_path):
    value = Store(tmp_path)
    value.add("states", states())
    return value


def states():
    return [{"state_id": "TEST-A", "name": "Test-only State A"}]


def boundary(geometry=None):
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"state_id": "TEST-A", "name": "Test-only State A"},
            "geometry": geometry or {
                "type": "Polygon",
                "coordinates": [[[70, 20], [71, 20], [71, 21], [70, 20]]],
            },
        }],
    }


def assert_error(code, call):
    with pytest.raises(AppError) as caught:
        call()
    assert caught.value.code == code
    assert caught.value.status_code == 503


def test_catalog_uses_declared_metadata_and_capabilities_without_calculation(store):
    store.add("states", states())
    repository = store.repository()
    result = repository.metadata()
    assert result.status == "ok"
    assert result.meta.model_dump() == Metadata.model_validate(store.manifest["metadata"]).model_dump()
    assert result.data == {
        "processed_at": store.manifest["processed_at"],
        "capabilities": store.manifest["capabilities"],
        "datasets": {"states": store.manifest["datasets"]["states"]["meta"]},
    }
    assert repository.states().meta.observation_count == 1
    assert repository.states().data == states()
    assert repository.sources().data == [source()]
    assert repository.sources().meta.observation_count == 93


def test_catalog_returns_do_not_mutate_cached_manifest(store):
    repository = store.repository()
    result = repository.metadata()
    result.data["capabilities"]["comparison"]["metrics"].append("mutated")
    result.meta.limitations.clear()
    sources = repository.sources()
    sources.data[0]["name"] = "mutated"
    assert repository.metadata().data["capabilities"] == store.manifest["capabilities"]
    assert repository.metadata().meta.limitations == ["Synthetic test-only fixture"]
    assert repository.sources().data == [source()]


def test_empty_catalog_and_datasets_are_explicit_no_data(store):
    store.manifest["sources"] = []
    store.manifest["metadata"]["source_ids"] = []
    store.save()
    store.add("states", [], source_ids=[])
    store.add("boundaries", {"type": "FeatureCollection", "features": []}, format="geojson", source_ids=[])
    repository = store.repository()
    assert repository.metadata().status == "ok"
    assert repository.sources().status == "no_data"
    assert repository.states().status == "no_data"
    assert repository.boundaries().status == "no_data"
    assert repository.records("states")[0] == []


def test_missing_manifest_recovers_when_it_arrives(tmp_path):
    repository = DatasetRepository(tmp_path)
    assert_error("DATASET_UNAVAILABLE", repository.metadata)
    Store(tmp_path)
    assert repository.metadata().status == "ok"


def test_missing_dataset_is_not_cached_forever(store):
    repository = store.repository()
    assert repository.has("rainfall") is False
    assert_error("DATASET_UNAVAILABLE", lambda: repository.records("rainfall"))
    path = store.add("rainfall", [{"state_id": "TEST-A", "year": 2000, "value": 0}])
    assert repository.has("rainfall") is True
    assert repository.records("rainfall")[0][0]["value"] == 0
    path.unlink()
    assert repository.has("rainfall") is False
    assert_error("DATASET_UNAVAILABLE", lambda: repository.records("rainfall"))
    store.add("rainfall", [])
    assert repository.records("rainfall")[0] == []


def test_deleting_cached_manifest_does_not_serve_stale_data(store):
    repository = store.repository()
    repository.metadata()
    (store.root / "manifest.json").unlink()
    assert_error("DATASET_UNAVAILABLE", repository.metadata)
    store.manifest["processed_at"] = "2002-01-01T00:00:00Z"
    store.save()
    assert repository.metadata().data["processed_at"] == "2002-01-01T00:00:00Z"


@pytest.mark.parametrize("relative", [
    "../outside.json", "/outside.json", "C:/outside.json", "C:outside.json",
    "..\\outside.json", "\\\\server\\share\\outside.json", ".", "", "bad\x00.json",
    "sub/../../outside.json", "sub/../states.json", "states.json:stream",
])
def test_unsafe_paths_are_manifest_errors(store, relative):
    store.add("states", states())
    store.manifest["datasets"]["states"]["path"] = relative
    store.save()
    assert_error("DATASET_INVALID", store.repository().metadata)


def test_symlink_escape_is_rejected(store, tmp_path):
    outside = tmp_path.parent / (tmp_path.name + "-outside.json")
    outside.write_text("[]", encoding="utf-8")
    link = tmp_path / "linked.json"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("Symlinks are unavailable for this test account")
    try:
        store.add("states", states())
        store.manifest["datasets"]["states"]["path"] = link.name
        store.save()
        assert_error("DATASET_INVALID", store.repository().metadata)
    finally:
        outside.unlink(missing_ok=True)


def test_symlink_retargeting_cannot_reuse_cached_path(store, tmp_path):
    original = store.add("states", states())
    link = tmp_path / "linked.json"
    try:
        link.symlink_to(original)
    except (OSError, NotImplementedError):
        pytest.skip("Symlinks are unavailable for this test account")
    store.manifest["datasets"]["states"]["path"] = link.name
    store.save()
    repository = store.repository()
    assert repository.states().data == states()
    outside = tmp_path.parent / (tmp_path.name + "-retargeted.json")
    outside.write_text("[]", encoding="utf-8")
    try:
        link.unlink()
        link.symlink_to(outside)
        assert_error("DATASET_INVALID", repository.states)
    finally:
        outside.unlink(missing_ok=True)


@pytest.mark.parametrize("mutation", [
    lambda m: m.update(version=2),
    lambda m: m.update(version=True),
    lambda m: m.update(extra="not allowed"),
    lambda m: m.pop("metadata"),
    lambda m: m.update(datasets=[]),
    lambda m: m["datasets"]["states"].update(extra="not allowed"),
    lambda m: m["datasets"]["states"].update(format="xlsx"),
    lambda m: m["datasets"]["states"].update(path="states.parquet"),
    lambda m: m["datasets"]["states"]["meta"].update(source_ids=["unknown"]),
    lambda m: m["metadata"].update(source_ids=["unknown"]),
    lambda m: m["metadata"].update(observation_count=-1),
    lambda m: m["metadata"].update(extra="not allowed"),
    lambda m: m["sources"].append(deepcopy(m["sources"][0])),
    lambda m: m["sources"][0].update(url="file:///local/secret"),
    lambda m: m["sources"][0].update(url="javascript:alert(1)"),
    lambda m: m["sources"][0].update(url="https://"),
    lambda m: m["sources"][0].update(extra="not allowed"),
])
def test_manifest_strict_validation(store, mutation):
    store.add("states", states())
    mutation(store.manifest)
    store.save()
    assert_error("DATASET_INVALID", store.repository().metadata)


@pytest.mark.parametrize("text", ["{", "[]", '{"version":1,"version":1}',
                                    '{"version":NaN}', '{"version":1e999}', '\ufeff{}'])
def test_malformed_manifest_is_graceful_and_can_recover(store, text):
    repository = store.repository()
    (store.root / "manifest.json").write_text(text, encoding="utf-8")
    assert_error("DATASET_INVALID", repository.metadata)
    store.save()
    assert repository.metadata().status == "ok"


@pytest.mark.parametrize("name,scope", [("drought", "state"), ("temperature", "national")])
def test_scientific_scope_is_declared_not_reinterpreted(store, name, scope):
    store.add(name, [], scope=scope)
    assert_error("DATASET_INVALID", store.repository().metadata)


@pytest.mark.parametrize("name,row,scope", [
    ("states", {"state_id": "TEST-A", "name": "Test-only State A"}, "state"),
    ("rainfall", {"state_id": "TEST-A", "year": 2000, "value": 0}, "state"),
    ("drought", {"year": 2000, "value": 0.25}, "national"),
    ("temperature", {"region": "Test-only region", "year": 2000, "month": 1, "value": 0}, "regional"),
    ("floods", {"event_id": "test-event", "state_id": None, "year": 2000, "attributes": {"note": "test only"}}, "state"),
    ("landslides", {"event_id": "test-event", "timestamp": "2000-01-01", "longitude": 70, "latitude": 20}, "state"),
    ("cyclones", {"storm_id": "test-storm", "name": "Synthetic test storm", "year": 2000}, "basin"),
    ("tracks", {"storm_id": "test-storm", "timestamp": "2000-01-01T00:00:00Z", "longitude": 70, "latitude": 20,
                "wind": 0, "wind_unit": "test-only unit", "pressure": None}, "track"),
])
def test_records_use_each_parent_model_and_reject_extras(store, name, row, scope):
    store.add(name, [row], scope=scope)
    if name == "tracks":
        store.add("cyclones", [{
            "storm_id": "test-storm", "name": "Synthetic test storm", "year": 2000,
        }], scope="basin")
    repository = store.repository()
    records, declared = repository.records(name)
    assert len(records) == 1
    assert all(records[0][key] == value for key, value in row.items())
    assert isinstance(declared, Metadata)
    assert declared.observation_count == 1
    row["undeclared"] = "not allowed"
    store.add(name, [row], scope=scope)
    assert_error("DATASET_INVALID", lambda: repository.records(name))


@pytest.mark.parametrize("rows", [
    {"records": []}, [None], [{"state_id": "TEST-A"}],
    [{"state_id": 1, "name": "Wrong type"}], states() + states(),
])
def test_invalid_state_records_rejected(store, rows):
    store.add("states", rows)
    assert_error("DATASET_INVALID", store.repository().states)


@pytest.mark.parametrize("row", [
    {"state_id": "TEST-A", "year": "2000", "value": 1},
    {"state_id": "TEST-A", "year": True, "value": 1},
    {"state_id": "TEST-A", "year": 2000, "value": "1"},
])
def test_records_are_not_coerced(store, row):
    store.add("rainfall", [row])
    assert_error("DATASET_INVALID", lambda: store.repository().records("rainfall"))


@pytest.mark.parametrize("text", ['[NaN]', '[Infinity]', '[1e999]', '[{"state_id":"A","state_id":"B"}]', '{'])
def test_invalid_json_records_raise_app_error(store, text):
    path = store.add("states", [])
    path.write_text(text, encoding="utf-8")
    assert_error("DATASET_INVALID", store.repository().states)


def test_cached_records_are_isolated_and_updated_files_are_visible(store):
    path = store.add("states", states())
    repository = store.repository()
    first = repository.states()
    first.data[0]["name"] = "mutated"
    assert repository.states().data == states()
    stat = path.stat()
    path.write_text(json.dumps([{"state_id": "TEST-B", "name": "Test-only State B"}]), encoding="utf-8")
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    assert repository.states().data[0]["state_id"] == "TEST-B"


def test_manifest_change_invalidates_cached_metadata_and_payloads(store):
    store.add("states", states())
    repository = store.repository()
    assert repository.states().meta.observation_count == 1
    store.manifest["datasets"]["states"]["meta"]["observation_count"] = 999
    store.manifest["capabilities"] = {"test_only_changed": True}
    store.save()
    assert repository.metadata().data["datasets"]["states"]["observation_count"] == 999
    assert_error("DATASET_INVALID", repository.states)
    assert repository.metadata().data["capabilities"] == {"test_only_changed": True}


def test_prepared_parquet_preserves_measured_zero_and_rejects_missing_measurement(store):
    path = store.add("rainfall", [], format="parquet", observation_count=1)
    pd.DataFrame([{"state_id": "TEST-A", "year": 2000, "value": 0.0}]).to_parquet(path, index=False)
    repository = store.repository()
    assert repository.records("rainfall")[0][0]["value"] == 0.0
    pd.DataFrame([{"state_id": "TEST-A", "year": 2000, "value": float("nan")}]).to_parquet(path, index=False)
    assert_error("DATASET_INVALID", lambda: repository.records("rainfall"))


def test_parquet_nullable_event_coordinates_become_null_not_nan(store, monkeypatch):
    store.add("floods", [], format="parquet", observation_count=1)
    monkeypatch.setattr(pd, "read_parquet", lambda _, **kwargs: pd.DataFrame([{
        "event_id": "test-only", "longitude": float("nan"), "latitude": float("nan"),
    }]))
    rows, _ = store.repository().records("floods")
    assert rows[0]["longitude"] is None
    assert rows[0]["latitude"] is None


@pytest.mark.parametrize("exception,code", [
    (ValueError("malformed test parquet"), "DATASET_INVALID"),
    (ImportError("test-only missing parquet engine"), "DATASET_UNAVAILABLE"),
    (FileNotFoundError("test-only vanished file"), "DATASET_UNAVAILABLE"),
])
def test_parquet_failures_are_graceful(store, monkeypatch, exception, code):
    store.add("rainfall", [], format="parquet")

    def fail(_, **kwargs):
        raise exception

    monkeypatch.setattr(pd, "read_parquet", fail)
    assert_error(code, lambda: store.repository().records("rainfall"))


def test_valid_polygon_and_multipolygon_are_returned_without_normalization(store):
    store.add("states", states())
    value = boundary()
    value["features"][0]["properties"]["official_source_attribute"] = "test-only retained"
    store.add("boundaries", value, format="geojson")
    repository = store.repository()
    assert repository.boundaries().data == value
    result = repository.boundaries()
    result.data["features"][0]["geometry"]["coordinates"][0][0][0] = 0
    assert repository.boundaries().data == value
    polygon = value["features"][0]["geometry"]["coordinates"]
    value["features"][0]["geometry"] = {"type": "MultiPolygon", "coordinates": [polygon]}
    value["crs"] = {"type": "name", "properties": {"name": "EPSG:4326"}}
    store.add("boundaries", value, format="json")
    assert repository.boundaries().data == value
    assert repository.records("boundaries")[0] == value["features"]


@pytest.mark.parametrize("mutate", [
    lambda b: b.update(type="Polygon"),
    lambda b: b.update(features={}),
    lambda b: b.update(crs={"type": "name", "properties": {"name": "EPSG:3857"}}),
    lambda b: b["features"][0].update(type="NotAFeature"),
    lambda b: b["features"][0].update(properties=None),
    lambda b: b["features"][0]["properties"].update(state_id="UNKNOWN"),
    lambda b: b["features"][0]["properties"].update(name="Mismatched name"),
    lambda b: b["features"].append(deepcopy(b["features"][0])),
    lambda b: b["features"][0].update(geometry=None),
    lambda b: b["features"][0]["geometry"].update(type="Point", coordinates=[70, 20]),
    lambda b: b["features"][0]["geometry"].update(coordinates=[]),
    lambda b: b["features"][0]["geometry"].update(coordinates=[[]]),
    lambda b: b["features"][0]["geometry"].update(coordinates=[[[70, 20], [71, 20], [70, 20]]]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(-1, [72, 22]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(0, [181, 20]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(0, [70, -91]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(0, [True, 20]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(0, ["70", 20]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(0, [70, 20, 10]),
    lambda b: b["features"][0]["geometry"]["coordinates"][0].__setitem__(0, [10 ** 500, 20]),
    lambda b: b["features"][0]["geometry"]["coordinates"].append([[70, 20]]),
    lambda b: b["features"][0]["geometry"].update(type="MultiPolygon", coordinates=[[]]),
    lambda b: b["features"][0]["geometry"].update(type="MultiPolygon", coordinates=[
        b["features"][0]["geometry"]["coordinates"], [[[70, 20]]],
    ]),
])
def test_entire_boundary_geometry_and_catalog_identity_are_validated(store, mutate):
    store.add("states", states())
    value = boundary()
    mutate(value)
    store.add("boundaries", value, format="geojson")
    assert_error("DATASET_INVALID", store.repository().boundaries)


def test_boundary_catalog_changes_revalidate_cached_geometry(store):
    state_path = store.add("states", states())
    store.add("boundaries", boundary(), format="geojson")
    repository = store.repository()
    assert repository.boundaries().status == "ok"
    state_path.write_text('[{"state_id":"TEST-A","name":"Changed test-only name"}]', encoding="utf-8")
    assert_error("DATASET_INVALID", repository.boundaries)


def test_geojson_format_is_not_a_way_to_bypass_record_validation(store):
    store.add("rainfall", {"type": "FeatureCollection", "features": []}, format="geojson")
    assert_error("DATASET_INVALID", store.repository().metadata)


def test_boundaries_reject_parquet_instead_of_inventing_geometry(store):
    store.add("boundaries", [], format="parquet")
    assert_error("DATASET_INVALID", store.repository().metadata)


@pytest.mark.parametrize("name,row,scope", [
    ("rainfall", {"state_id": "TEST-A", "year": 2000, "value": 1}, "state"),
    ("drought", {"year": 2000, "value": 1}, "national"),
    ("temperature", {"region": "Test-only region", "year": 2000, "value": 1}, "regional"),
    ("floods", {"event_id": "test-only", "year": 2000}, "state"),
    ("landslides", {"event_id": "test-only", "year": 2000}, "state"),
    ("cyclones", {"storm_id": "test-only", "name": "Test-only storm", "year": 2000}, "basin"),
    ("tracks", {"storm_id": "test-only", "timestamp": "2000-01-01T00:00:00Z",
                "longitude": 70, "latitude": 20}, "track"),
])
def test_measurement_identities_are_unique(store, name, row, scope):
    store.add(name, [row, deepcopy(row)], scope=scope)
    assert_error("DATASET_INVALID", lambda: store.repository().records(name))


@pytest.mark.parametrize("name,row", [
    ("rainfall", {"state_id": "UNKNOWN", "year": 2000, "value": 1}),
    ("floods", {"event_id": "test-only", "state_id": "UNKNOWN", "year": 2000}),
    ("landslides", {"event_id": "test-only", "state_id": "UNKNOWN", "year": 2000}),
])
def test_nonnull_record_state_references_must_exist(store, name, row):
    store.add(name, [row])
    assert_error("DATASET_INVALID", lambda: store.repository().records(name))


def test_states_without_measurements_are_allowed_and_cached_records_recheck_catalog(store):
    store.add("states", states() + [{"state_id": "TEST-B", "name": "Test-only State B"}])
    store.add("rainfall", [{"state_id": "TEST-A", "year": 2000, "value": 0}])
    repository = store.repository()
    assert len(repository.states().data) == 2
    assert repository.records("rainfall")[0][0]["value"] == 0
    store.add("states", [{"state_id": "TEST-B", "name": "Test-only State B"}])
    assert_error("DATASET_INVALID", lambda: repository.records("rainfall"))


def test_distinct_rainfall_and_monthly_temperature_identities_are_allowed(store):
    store.add("states", states() + [{"state_id": "TEST-B", "name": "Test-only State B"}])
    store.add("rainfall", [
        {"state_id": "TEST-A", "year": 2000, "value": 0},
        {"state_id": "TEST-B", "year": 2000, "value": 0},
        {"state_id": "TEST-A", "year": 2001, "value": 0},
    ])
    store.add("temperature", [
        {"region": "Test-only region", "year": 2000, "month": 1, "value": 0},
        {"region": "Test-only region", "year": 2000, "month": 2, "value": 0},
    ], scope="regional")
    assert len(store.repository().records("rainfall")[0]) == 3
    assert len(store.repository().records("temperature")[0]) == 2


def test_track_storm_catalog_is_required_and_revalidated(store):
    store.add("tracks", [{
        "storm_id": "test-only-storm", "timestamp": "2000-01-01T00:00:00Z",
        "longitude": 70, "latitude": 20,
    }], scope="track")
    repository = store.repository()
    assert_error("DATASET_UNAVAILABLE", lambda: repository.records("tracks"))
    store.add("cyclones", [{
        "storm_id": "test-only-storm", "name": "Synthetic test storm", "year": 2000,
    }], scope="basin")
    assert len(repository.records("tracks")[0]) == 1
    store.add("cyclones", [{
        "storm_id": "different-test-storm", "name": "Other synthetic storm", "year": 2000,
    }], scope="basin")
    assert_error("DATASET_INVALID", lambda: repository.records("tracks"))


@pytest.mark.parametrize("declared_count", [0, 2])
def test_mismatched_observation_count_is_rejected_not_recalculated(store, declared_count):
    store.add("rainfall", [{"state_id": "TEST-A", "year": 2000, "value": 0}],
              observation_count=declared_count)
    repository = store.repository()
    assert repository.metadata().status == "ok"
    assert repository.metadata().data["datasets"]["rainfall"]["observation_count"] == declared_count
    assert_error("DATASET_INVALID", lambda: repository.records("rainfall"))


def test_boundary_observation_count_must_match_features(store):
    store.add("boundaries", boundary(), format="geojson", observation_count=0)
    assert_error("DATASET_INVALID", store.repository().boundaries)


@pytest.mark.parametrize("name,row,scope", [
    ("rainfall", {"state_id": "TEST-A", "year": 2000, "value": 1}, "state"),
    ("drought", {"year": 2000, "value": 1}, "national"),
    ("temperature", {"region": "Test-only region", "year": 2000, "value": 1}, "regional"),
    ("floods", {"event_id": "test-only", "year": 2000}, "state"),
    ("landslides", {"event_id": "test-only", "year": 2000}, "state"),
    ("cyclones", {"storm_id": "test-only", "name": "Test-only storm", "year": 2000}, "basin"),
    ("tracks", {"storm_id": "test-only", "timestamp": "2000-01-01T00:00:00Z",
                "longitude": 70, "latitude": 20}, "track"),
])
def test_nonempty_observations_require_provenance_but_empty_data_does_not(store, name, row, scope):
    store.add(name, [row], scope=scope, source_ids=[])
    repository = store.repository()
    assert_error("DATASET_INVALID", lambda: repository.records(name))
    store.add(name, [], scope=scope, source_ids=[])
    assert repository.records(name)[0] == []


def test_geometry_requires_provenance_while_state_catalog_can_be_unsourced(store):
    store.add("states", states(), source_ids=[])
    assert store.repository().states().status == "ok"
    store.add("boundaries", boundary(), format="geojson", source_ids=[])
    assert_error("DATASET_INVALID", store.repository().boundaries)

def test_same_clock_tick_manifest_update_does_not_reuse_stale_counts(store, monkeypatch):
    store.add("rainfall", [{"state_id": "TEST-A", "year": 2000, "value": 0}])
    repository = store.repository()
    original = repository._signature
    manifest_signature = original(store.root / "manifest.json")
    monkeypatch.setattr(repository, "_signature", lambda path, dataset=None: manifest_signature if path.name == "manifest.json" else original(path, dataset))
    assert repository.records("rainfall")[0][0]["value"] == 0
    store.add("rainfall", [])
    assert repository.records("rainfall")[0] == []

def test_parquet_nullable_event_year_is_not_coerced_to_float(store):
    import pyarrow as pa
    import pyarrow.parquet as pq
    path = store.add("floods", [], format="parquet", observation_count=2)
    pq.write_table(pa.Table.from_pylist([
        {"event_id": "dated", "year": 2000},
        {"event_id": "undated", "year": None},
    ]), path)
    rows, _ = store.repository().records("floods")
    assert rows[0]["year"] == 2000 and type(rows[0]["year"]) is int
    assert rows[1]["year"] is None
