"""Read validated, prepared datasets only; never calculate climate measurements.

Storage convention (introduced by this backend, not a supplied science format):
manifest.json has version, processed_at, metadata, datasets, sources and capabilities.
Each dataset declares path, format and meta. JSON record datasets are bare arrays;
boundaries are GeoJSON FeatureCollections. Paths are relative to the data root.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import json
import math
from pathlib import Path, PureWindowsPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from app.core.errors import AppError
from app.models import (
    DroughtRecord,
    Envelope,
    EventRecord,
    Metadata,
    RainfallRecord,
    Source,
    StateRecord,
    StormRecord,
    TemperatureRecord,
    TrackRecord,
)


class _DatasetSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    format: Literal["parquet", "json", "geojson"]
    meta: Metadata


class _Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    processed_at: str
    metadata: Metadata
    datasets: dict[str, _DatasetSpec]
    sources: list[Source]
    capabilities: dict[str, Any]


@dataclass(frozen=True)
class _CachedPayload:
    path: Path
    signature: tuple[int, int, int, int]
    value: Any


_RECORD_MODELS = {
    "states": StateRecord,
    "rainfall": RainfallRecord,
    "drought": DroughtRecord,
    "temperature": TemperatureRecord,
    "floods": EventRecord,
    "landslides": EventRecord,
    "cyclones": StormRecord,
    "tracks": TrackRecord,
}
_EXTENSIONS = {"parquet": ".parquet", "json": ".json", "geojson": ".geojson"}
_ALLOWED_CRS = {
    "EPSG:4326",
    "urn:ogc:def:crs:EPSG::4326",
    "urn:ogc:def:crs:OGC:1.3:CRS84",
    "OGC:CRS84",
}


def _invalid(message: str, dataset: str | None = None) -> AppError:
    return AppError(
        "DATASET_INVALID", message, details={"dataset": dataset} if dataset else {}
    )


def _unavailable(message: str, dataset: str | None = None) -> AppError:
    return AppError(
        "DATASET_UNAVAILABLE", message, details={"dataset": dataset} if dataset else {}
    )


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number: {value}")


def _json_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON numbers must be finite")
    return number


class DatasetRepository:
    def __init__(self, data_dir: Path):
        self._root = Path(data_dir).resolve()
        self._manifest: _Manifest | None = None
        self._manifest_signature: tuple[int, int, int, int, str] | None = None
        self._payloads: dict[str, _CachedPayload] = {}

    def _confined_path(self, relative: str) -> Path:
        # Interpret Windows absolute paths too, even when deployed on POSIX.
        windows_path = PureWindowsPath(relative)
        if (
            not relative
            or "\x00" in relative
            or "\\" in relative
            or ":" in relative
            or windows_path.is_absolute()
            or windows_path.drive
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
        ):
            raise _invalid("Dataset paths must be relative paths inside the data root")
        try:
            resolved = (self._root / relative).resolve()
            resolved.relative_to(self._root)
        except (OSError, RuntimeError, ValueError) as exc:
            raise _invalid("Dataset path escapes or cannot resolve inside the data root") from exc
        if resolved == self._root:
            raise _invalid("Dataset path must identify a file")
        return resolved

    @staticmethod
    def _signature(path: Path, dataset: str | None = None) -> tuple[int, int, int, int]:
        try:
            stat = path.stat()
            if not path.is_file():
                raise _unavailable("Prepared dataset file is not available", dataset)
        except OSError as exc:
            raise _unavailable("Prepared dataset file is not available", dataset) from exc
        return stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_ino

    @staticmethod
    def _read_json(path: Path, dataset: str | None = None) -> Any:
        try:
            with path.open("r", encoding="utf-8") as stream:
                return json.load(
                    stream,
                    object_pairs_hook=_json_object,
                    parse_constant=_reject_constant,
                    parse_float=_json_float,
                )
        except OSError as exc:
            raise _unavailable("Prepared dataset file cannot be read", dataset) from exc
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise _invalid("Prepared dataset is not valid JSON", dataset) from exc

    def _load_manifest(self) -> _Manifest:
        path = self._confined_path("manifest.json")
        try:
            raw = self._read_json(path)
            # Small manifests can be rewritten within one filesystem clock tick.
            # Include content so same-size updates never reuse stale declarations.
            signature = (*self._signature(path), json.dumps(raw, sort_keys=True))
        except AppError:
            self._manifest = None
            self._manifest_signature = None
            self._payloads.clear()
            raise
        if self._manifest is not None and signature == self._manifest_signature:
            return self._manifest
        self._manifest = None
        self._manifest_signature = None
        self._payloads.clear()
        try:
            if not isinstance(raw, dict) or type(raw.get("version")) is not int:
                raise ValueError("Manifest version must be an integer")
            manifest = _Manifest.model_validate(raw, strict=True)
            source_ids = [source.id for source in manifest.sources]
            if any(not source_id for source_id in source_ids) or len(set(source_ids)) != len(source_ids):
                raise ValueError("Source identifiers must be nonempty and unique")
            catalog = set(source_ids)
            for meta in [manifest.metadata, *(spec.meta for spec in manifest.datasets.values())]:
                if not set(meta.source_ids).issubset(catalog):
                    raise ValueError("Metadata references an unknown source identifier")
            for name, spec in manifest.datasets.items():
                if not name:
                    raise ValueError("Dataset names must not be empty")
                resolved = self._confined_path(spec.path)
                if Path(spec.path).suffix.lower() != _EXTENSIONS[spec.format]:
                    raise ValueError("Dataset extension does not match its declared format")
                if resolved == path:
                    raise ValueError("Manifest cannot also be a dataset")
                if spec.format == "geojson" and name != "boundaries":
                    raise ValueError("GeoJSON format is only supported for boundaries")
                if name == "boundaries" and spec.format not in ("json", "geojson"):
                    raise ValueError("Boundaries must be a JSON or GeoJSON FeatureCollection")
                expected_scope = {"drought": "national", "temperature": "regional"}.get(name)
                if expected_scope and spec.meta.geographic_level != expected_scope:
                    raise ValueError(f"{name} metadata must declare {expected_scope} coverage")
        except (ValidationError, ValueError) as exc:
            raise _invalid("Manifest does not match the prepared-data contract") from exc
        self._manifest = manifest
        self._manifest_signature = signature
        return manifest

    def _load_payload(self, name: str) -> tuple[Any, Metadata]:
        manifest = self._load_manifest()
        spec = manifest.datasets.get(name)
        if spec is None:
            raise _unavailable("Prepared dataset is not declared in the manifest", name)
        # Re-resolve on every access: a changed symlink must not bypass confinement.
        path = self._confined_path(spec.path)
        try:
            signature = self._signature(path, name)
        except AppError:
            self._payloads.pop(name, None)
            raise
        cached = self._payloads.get(name)
        if cached is not None and cached.path == path and cached.signature == signature:
            return cached.value, spec.meta.model_copy(deep=True)
        if spec.format in ("json", "geojson"):
            value = self._read_json(path, name)
        else:
            try:
                import pandas as pd

                # Arrow-backed nullable integers retain their source type beside nulls.
                frame = pd.read_parquet(path, dtype_backend="pyarrow")
                # Preserve missing prepared values as null, not IEEE NaN in JSON.
                value = frame.astype(object).where(pd.notna(frame), None).to_dict(orient="records")
            except OSError as exc:
                raise _unavailable("Prepared parquet file cannot be read", name) from exc
            except ImportError as exc:
                raise _unavailable("Parquet support is not installed on the server", name) from exc
            except Exception as exc:
                raise _invalid("Prepared parquet file cannot be decoded", name) from exc
        self._payloads[name] = _CachedPayload(path, signature, value)
        return value, spec.meta.model_copy(deep=True)

    def has(self, name: str) -> bool:
        manifest = self._load_manifest()
        spec = manifest.datasets.get(name)
        if spec is None:
            return False
        path = self._confined_path(spec.path)
        try:
            self._signature(path, name)
        except AppError as exc:
            if exc.code == "DATASET_UNAVAILABLE":
                return False
            raise
        return True

    def metadata(self) -> Envelope:
        manifest = self._load_manifest()
        return Envelope(
            status="ok",
            data={
                "processed_at": manifest.processed_at,
                "capabilities": deepcopy(manifest.capabilities),
                "datasets": {
                    name: spec.meta.model_dump(mode="json")
                    for name, spec in manifest.datasets.items()
                },
            },
            meta=manifest.metadata.model_copy(deep=True),
        )

    def sources(self) -> Envelope:
        manifest = self._load_manifest()
        return Envelope(
            status="ok" if manifest.sources else "no_data",
            data=[source.model_dump(mode="json") for source in manifest.sources],
            meta=manifest.metadata.model_copy(deep=True),
        )

    def states(self) -> Envelope:
        rows, meta = self.records("states")
        return Envelope(status="ok" if rows else "no_data", data=rows, meta=meta)

    def records(self, name: str) -> tuple[list[dict], Metadata]:
        if name == "boundaries":
            envelope = self.boundaries()
            return envelope.data["features"], envelope.meta
        raw, meta = self._load_payload(name)
        model = _RECORD_MODELS.get(name)
        if model is None:
            raise _invalid("No record model is defined for this dataset", name)
        if not isinstance(raw, list):
            raise _invalid("Record datasets must contain a JSON array of objects", name)
        try:
            records = [model.model_validate(row, strict=True).model_dump(mode="json") for row in raw]
            if meta.observation_count != len(records):
                raise ValueError("Declared observation count must match prepared record count")
            if name != "states" and records and not meta.source_ids:
                raise ValueError("Nonempty observations require declared source identifiers")
            identity_fields = {
                "states": ("state_id",),
                "rainfall": ("state_id", "year", "date"),
                "temperature": ("region", "year", "month"),
                "drought": ("year",),
                "floods": ("event_id",),
                "landslides": ("event_id",),
                "cyclones": ("storm_id",),
                "tracks": ("storm_id", "timestamp"),
            }[name]
            identities = [tuple(row[field] for field in identity_fields) for row in records]
            if len(identities) != len(set(identities)):
                raise ValueError("Prepared record identifiers must be unique")
            referenced_states = {
                row["state_id"] for row in records
                if name != "states" and row.get("state_id") is not None
            }
            if referenced_states:
                state_rows, _ = self.records("states")
                state_ids = {row["state_id"] for row in state_rows}
                if not referenced_states.issubset(state_ids):
                    raise ValueError("Record state identifiers must reference the state catalog")
            if name == "tracks" and records:
                storms, _ = self.records("cyclones")
                storm_ids = {row["storm_id"] for row in storms}
                if any(row["storm_id"] not in storm_ids for row in records):
                    raise ValueError("Track storm identifiers must reference the cyclone catalog")
        except (ValidationError, ValueError) as exc:
            raise _invalid("Prepared records do not match their declared record model", name) from exc
        return records, meta

    def boundaries(self) -> Envelope:
        raw, meta = self._load_payload("boundaries")
        states, _ = self.records("states")
        catalog = {state["state_id"]: state["name"] for state in states}
        try:
            self._validate_boundaries(raw, catalog)
            if meta.observation_count != len(raw["features"]):
                raise ValueError("Declared observation count must match boundary feature count")
            if raw["features"] and not meta.source_ids:
                raise ValueError("Nonempty boundaries require declared source identifiers")
        except (ValueError, TypeError, RecursionError) as exc:
            raise _invalid("Boundaries must be valid EPSG:4326 state polygons", "boundaries") from exc
        return Envelope(
            status="ok" if raw["features"] else "no_data",
            data=deepcopy(raw),
            meta=meta,
        )

    @staticmethod
    def _validate_crs(value: dict) -> None:
        if "crs" in value:
            crs = value["crs"]
            if (
                not isinstance(crs, dict)
                or crs.get("type") != "name"
                or not isinstance(crs.get("properties"), dict)
                or crs["properties"].get("name") not in _ALLOWED_CRS
            ):
                raise ValueError("Only EPSG:4326 longitude/latitude coordinates are supported")

    @classmethod
    def _validate_boundaries(cls, value: Any, catalog: dict[str, str]) -> None:
        if not isinstance(value, dict) or value.get("type") != "FeatureCollection":
            raise ValueError("Expected a FeatureCollection")
        cls._validate_crs(value)
        features = value.get("features")
        if not isinstance(features, list):
            raise ValueError("FeatureCollection requires a features array")
        identifiers = set()
        for feature in features:
            if not isinstance(feature, dict) or feature.get("type") != "Feature":
                raise ValueError("Every boundary must be a Feature")
            cls._validate_crs(feature)
            properties = feature.get("properties")
            if not isinstance(properties, dict):
                raise ValueError("Boundary properties are required")
            state_id, name = properties.get("state_id"), properties.get("name")
            if not isinstance(state_id, str) or not isinstance(name, str):
                raise ValueError("Boundary state_id and name must be strings")
            if catalog.get(state_id) != name or state_id in identifiers:
                raise ValueError("Boundary identity must uniquely match the state catalog")
            identifiers.add(state_id)
            geometry = feature.get("geometry")
            if not isinstance(geometry, dict):
                raise ValueError("Boundary geometry is required")
            cls._validate_crs(geometry)
            coordinates = geometry.get("coordinates")
            if geometry.get("type") == "Polygon":
                cls._validate_polygon(coordinates)
            elif geometry.get("type") == "MultiPolygon":
                if not isinstance(coordinates, list) or not coordinates:
                    raise ValueError("MultiPolygon requires polygons")
                for polygon in coordinates:
                    cls._validate_polygon(polygon)
            else:
                raise ValueError("Only Polygon and MultiPolygon boundaries are supported")

    @staticmethod
    def _validate_polygon(polygon: Any) -> None:
        if not isinstance(polygon, list) or not polygon:
            raise ValueError("Polygon requires an exterior ring")
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                raise ValueError("Polygon rings require at least four positions")
            for position in ring:
                if not isinstance(position, list) or len(position) != 2:
                    raise ValueError("Positions must be longitude/latitude pairs")
                longitude, latitude = position
                if any(
                    type(number) not in (int, float)
                    or (type(number) is float and not math.isfinite(number))
                    for number in position
                ):
                    raise ValueError("Positions must contain finite numeric coordinates")
                if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
                    raise ValueError("Position lies outside EPSG:4326 bounds")
            if ring[0] != ring[-1] or len({tuple(position) for position in ring[:-1]}) < 3:
                raise ValueError("Polygon rings must be closed and contain three distinct vertices")
