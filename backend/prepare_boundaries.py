"""Manually reproject an official NWIC archive into the existing prepared catalog.

Run from backend: python prepare_boundaries.py --archive ../data/raw/state_nwic_geojson.zip --output ../data/processed
No downloads, state-name inference, geometry simplification, or climate calculations occur.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile

from pyproj import CRS, Transformer
from pyproj.exceptions import ProjError

from app.models import StateRecord
from app.repositories.dataset_repository import DatasetRepository, _Manifest


SOURCE_ID = "nwic_boundaries"


class PreparationError(ValueError):
    """The supplied source or prepared catalog cannot safely be imported."""


def _read_json(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8-sig") as stream:
            return json.load(stream)
    except (OSError, ValueError) as exc:
        raise PreparationError(f"Cannot read JSON at {path}: {exc}") from exc


def _catalog(output: Path) -> tuple[dict, bytes, dict[str, str], str]:
    manifest_path = output / "manifest.json"
    try:
        original = manifest_path.read_bytes()
        raw = json.loads(original)
        manifest = _Manifest.model_validate(raw, strict=True)
    except (OSError, ValueError) as exc:
        raise PreparationError(
            "An existing valid manifest.json and states catalog are required; "
            "run workbook preparation first. " + str(exc)
        ) from exc
    spec = manifest.datasets.get("states")
    if spec is None:
        raise PreparationError("manifest.json must declare the existing states catalog; no state IDs will be guessed")
    # Reuse repository validation for confined paths, record shapes and duplicate IDs.
    try:
        rows, _ = DatasetRepository(output).records("states")
    except Exception as exc:
        raise PreparationError(f"Cannot load existing manifest states catalog: {exc}") from exc
    if not rows:
        raise PreparationError("The existing states catalog is empty; no state IDs will be guessed")
    catalog = {StateRecord.model_validate(row).state_id: row["name"] for row in rows}
    source = next((source for source in manifest.sources if source.id == SOURCE_ID), None)
    if source is None:
        raise PreparationError(f"manifest.json must declare official source {SOURCE_ID!r}")
    if not source.url or urlparse(source.url).scheme not in {"https", "http"}:
        raise PreparationError(f"Source {SOURCE_ID!r} must provide its official archive URL")
    return raw, original, catalog, source.url


def _declared_crs(value: dict, label: str) -> tuple[str, CRS]:
    declaration = value.get("crs")
    if (
        not isinstance(declaration, dict)
        or declaration.get("type") != "name"
        or not isinstance(declaration.get("properties"), dict)
        or not isinstance(declaration["properties"].get("name"), str)
        or not declaration["properties"]["name"].strip()
    ):
        raise PreparationError(f"{label} must declare a named source CRS; no CRS will be guessed")
    name = declaration["properties"]["name"]
    try:
        crs = CRS.from_user_input(name)
    except ProjError as exc:
        raise PreparationError(f"Invalid declared source CRS {name!r}") from exc
    return name, crs


def _check_nested_crs(value: dict, source_crs: CRS, label: str) -> None:
    if "crs" in value:
        _, nested = _declared_crs(value, label)
        if not nested.equals(source_crs):
            raise PreparationError(f"{label} has a conflicting source CRS")


def _polygon(coordinates: Any, transformer: Transformer, extent: list[float]) -> list:
    if not isinstance(coordinates, list) or not coordinates:
        raise PreparationError("Polygon requires at least one ring")
    transformed = []
    for ring in coordinates:
        if not isinstance(ring, list) or len(ring) < 4:
            raise PreparationError("Each polygon ring requires at least four positions")
        for position in ring:
            if (
                not isinstance(position, list)
                or len(position) != 2
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in position)
            ):
                raise PreparationError("Source positions must be finite numeric x/y pairs")
        if ring[0] != ring[-1] or len({tuple(position) for position in ring[:-1]}) < 3:
            raise PreparationError("Source rings must be closed with at least three distinct vertices")
        try:
            longitudes, latitudes = transformer.transform(
                [position[0] for position in ring],
                [position[1] for position in ring],
                errcheck=True,
            )
        except ProjError as exc:
            raise PreparationError(f"Source coordinate cannot be transformed: {exc}") from exc
        result = []
        for longitude, latitude in zip(longitudes, latitudes, strict=True):
            if (
                not math.isfinite(longitude)
                or not math.isfinite(latitude)
                or not -180 <= longitude <= 180
                or not -90 <= latitude <= 90
            ):
                raise PreparationError("Transformed coordinate is outside finite EPSG:4326 longitude/latitude bounds")
            extent[0] = min(extent[0], longitude)
            extent[1] = min(extent[1], latitude)
            extent[2] = max(extent[2], longitude)
            extent[3] = max(extent[3], latitude)
            result.append([longitude, latitude])
        transformed.append(result)
    return transformed


def reproject_collection(collection: Any, catalog: dict[str, str]) -> dict:
    """Preserve every ring and vertex, matching both official code and name."""
    if not isinstance(collection, dict) or collection.get("type") != "FeatureCollection":
        raise PreparationError("Archive GeoJSON must be a FeatureCollection")
    source_name, source_crs = _declared_crs(collection, "FeatureCollection")
    try:
        transformer = Transformer.from_crs(source_crs, CRS.from_epsg(4326), always_xy=True)
    except ProjError as exc:
        raise PreparationError(f"Declared CRS cannot be reprojected to EPSG:4326: {exc}") from exc
    features = collection.get("features")
    if not isinstance(features, list) or not features:
        raise PreparationError("Source FeatureCollection requires nonempty features")
    result = []
    seen = set()
    extent = [math.inf, math.inf, -math.inf, -math.inf]
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise PreparationError("Every source boundary must be a GeoJSON Feature")
        _check_nested_crs(feature, source_crs, "Feature")
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            raise PreparationError("Every source feature requires stcode/state_name properties")
        state_id, name = properties.get("stcode"), properties.get("state_name")
        if not isinstance(state_id, str) or not isinstance(name, str) or catalog.get(state_id) != name.strip():
            raise PreparationError(
                f"Source stcode/state_name {state_id!r}/{name!r} do not exactly match the existing states catalog"
            )
        # Workbook preparation trims outer name whitespace only, not spelling or IDs.
        name = catalog[state_id]
        if state_id in seen:
            raise PreparationError(f"Duplicate source boundary for state {state_id!r}")
        seen.add(state_id)
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict):
            raise PreparationError(f"State {state_id!r} has no geometry")
        _check_nested_crs(geometry, source_crs, "Geometry")
        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates")
        if geometry_type == "Polygon":
            projected = _polygon(coordinates, transformer, extent)
        elif geometry_type == "MultiPolygon":
            if not isinstance(coordinates, list) or not coordinates:
                raise PreparationError("MultiPolygon requires at least one polygon")
            projected = [_polygon(polygon, transformer, extent) for polygon in coordinates]
        else:
            raise PreparationError(f"Unsupported boundary geometry {geometry_type!r}; expected Polygon or MultiPolygon")
        # Original projected bbox/crs must never survive onto longitude/latitude output.
        prepared_feature = {key: value for key, value in feature.items() if key not in {"crs", "bbox", "geometry", "properties"}}
        prepared_feature["properties"] = {**properties, "state_id": state_id, "name": name}
        prepared_feature["geometry"] = {"type": geometry_type, "coordinates": projected}
        result.append(prepared_feature)
    output = {
        "type": "FeatureCollection",
        "bbox": extent,
        "features": result,
        "preparation": {
            "source_crs": source_name,
            "source_crs_wkt": source_crs.to_wkt(),
            "target_crs": "EPSG:4326",
            "coordinate_order": "longitude, latitude",
            "always_xy": True,
            "method": "reproject",
            "transformer_description": transformer.description,
            "transformer_definition": transformer.definition,
            "simplification": "none; every source polygon, island, hole and vertex retained",
            "feature_count": len(result),
            "extent": extent,
        },
    }
    # Enforce exactly the production reader's geometry and identity contract too.
    DatasetRepository._validate_boundaries(output, catalog)
    return output


def _stage_json(path: Path, value: Any) -> Path:
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        return temporary
    except BaseException:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise


def prepare_boundaries(archive: Path, output: Path) -> dict:
    """Validate everything before atomically replacing either prepared JSON file."""
    output = output.resolve()
    manifest, original_manifest, catalog, archive_url = _catalog(output)
    try:
        with ZipFile(archive) as source:
            members = [member for member in source.infolist() if not member.is_dir() and member.filename.lower().endswith((".geojson", ".json"))]
            if len(members) != 1:
                raise PreparationError("Archive must contain exactly one GeoJSON/JSON boundary member")
            member = members[0]
            with source.open(member) as stream:
                collection = json.load(stream)
    except (OSError, BadZipFile, ValueError) as exc:
        raise PreparationError(f"Cannot read boundary archive {archive}: {exc}") from exc
    prepared = reproject_collection(collection, catalog)
    prepared["preparation"].update({
        "archive_url": archive_url,
        "archive_member": member.filename,
        "source_id": SOURCE_ID,
        "processed_at": datetime.now(timezone.utc).isoformat(),
    })
    source_crs = prepared["preparation"]["source_crs"]
    manifest["datasets"]["boundaries"] = {
        "path": "boundaries.geojson",
        "format": "geojson",
        "meta": {
            "metric": "official state boundaries",
            "unit": "degrees longitude/latitude",
            "geographic_level": "state",
            "time_resolution": "static",
            "period": {"start": None, "end": None},
            "source_ids": [SOURCE_ID],
            "method": (
                f"reproject: pyproj Transformer.from_crs({source_crs!r}, 'EPSG:4326', always_xy=True); "
                "all source Polygon/MultiPolygon rings and vertices retained without simplification; "
                "stcode and state_name matched to existing states catalog (outer name whitespace trimmed only). "
                f"Archive: {archive_url}. Full transformed extent (west, south, east, north): {prepared['bbox']}"
            ),
            "observation_count": len(prepared["features"]),
            "limitations": ["Administrative geometry reflects the supplied official archive; no boundary vintage is inferred."],
        },
    }
    capabilities = manifest["capabilities"]
    capabilities["boundaries"] = True
    available = capabilities.setdefault("available_datasets", [])
    if "boundaries" not in available:
        available.append("boundaries")
    resolved_omission = capabilities.setdefault("omitted_datasets", {}).pop("boundaries", None)
    if resolved_omission:
        for metadata in [manifest["metadata"], *[source for source in manifest["sources"] if source["id"] == SOURCE_ID]]:
            metadata["limitations"] = [note for note in metadata["limitations"] if note != resolved_omission]
            metadata["limitations"].append("Geometry is supplied separately from the official archive; it is not present in the workbook.")
    manifest["metadata"]["observation_count"] = sum(spec["meta"]["observation_count"] for spec in manifest["datasets"].values())
    count_note = "Catalog observation_count sums prepared rows and boundary features; it is not a count of distinct disasters."
    if count_note not in manifest["metadata"]["limitations"]:
        manifest["metadata"]["limitations"].append(count_note)
    _Manifest.model_validate(manifest, strict=True)
    staged = []
    try:
        boundary_stage = _stage_json(output / "boundaries.geojson", prepared)
        staged.append(boundary_stage)
        manifest_stage = _stage_json(output / "manifest.json", manifest)
        staged.append(manifest_stage)
        if (output / "manifest.json").read_bytes() != original_manifest:
            raise PreparationError("manifest.json changed during preparation; rerun against the current catalog")
        # Both payloads are complete and fsynced before publication. Manifest is last,
        # so a failed validation/serialization cannot register an incomplete dataset.
        os.replace(boundary_stage, output / "boundaries.geojson")
        os.replace(manifest_stage, output / "manifest.json")
    finally:
        for path in staged:
            path.unlink(missing_ok=True)
    return prepared["preparation"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True, help="Downloaded official NWIC boundary ZIP (no network access)")
    parser.add_argument("--output", type=Path, required=True, help="Existing workbook-prepared directory containing manifest.json and states")
    args = parser.parse_args(argv)
    try:
        result = prepare_boundaries(args.archive, args.output)
    except (PreparationError, OSError, ProjError, ValueError) as exc:
        print(f"Boundary preparation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
