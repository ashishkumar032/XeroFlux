from typing import Any, Literal
from datetime import date, datetime
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from urllib.parse import urlparse

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

class Period(StrictModel):
    start: str | None = None
    end: str | None = None

class Metadata(StrictModel):
    metric: str
    unit: str | None = None
    geographic_level: str
    time_resolution: str
    period: Period = Field(default_factory=Period)
    source_ids: list[str] = Field(default_factory=list)
    method: str | None = None
    observation_count: int = Field(ge=0)
    limitations: list[str] = Field(default_factory=list)

class Envelope(StrictModel):
    status: Literal["ok", "no_data"]
    data: Any
    meta: Metadata

class Source(StrictModel):
    id: str
    name: str
    provider: str
    url: str | None = None
    geographic_coverage: str
    temporal_coverage: str
    data_format: str
    purpose: str
    provenance_status: str
    limitations: list[str] = Field(default_factory=list)
    @field_validator("url")
    @classmethod
    def safe_url(cls, value):
        if value is not None and (urlparse(value).scheme not in ("http", "https") or not urlparse(value).netloc):
            raise ValueError("Source URL must be absolute HTTP(S)")
        return value

class StateRecord(StrictModel):
    state_id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1)

class RainfallRecord(StrictModel):
    state_id: str
    year: int = Field(ge=1800, le=2100)
    value: float
    date: str | None = None
    @model_validator(mode="after")
    def date_matches_year(self):
        if self.date is not None and date.fromisoformat(self.date).year != self.year:
            raise ValueError("Rainfall source date must match year")
        return self

class DroughtRecord(StrictModel):
    year: int = Field(ge=1800, le=2100)
    value: float

class TemperatureRecord(DroughtRecord):
    region: str
    month: int | None = Field(default=None, ge=1, le=12)

class EventRecord(StrictModel):
    event_id: str
    state_id: str | None = None
    year: int | None = Field(default=None, ge=1800, le=2100)
    timestamp: str | None = None
    longitude: float | None = Field(default=None, ge=-180, le=180)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    attributes: dict[str, Any] = Field(default_factory=dict)
    @model_validator(mode="after")
    def coordinate_pair(self):
        if (self.longitude is None) != (self.latitude is None):
            raise ValueError("Coordinates must both be supplied or both absent")
        if self.timestamp is not None:
            parsed = datetime.fromisoformat(self.timestamp.replace("Z", "+00:00"))
            if self.year is not None and self.year != parsed.year:
                raise ValueError("Event year and source timestamp disagree")
        return self

class StormRecord(StrictModel):
    storm_id: str
    name: str
    year: int = Field(ge=1800, le=2100)

class TrackRecord(StrictModel):
    storm_id: str
    timestamp: str
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    wind: float | None = None
    pressure: float | None = None
    wind_unit: str | None = None
    pressure_unit: str | None = None
    @field_validator("timestamp")
    @classmethod
    def timestamp_valid(cls, value):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Track timestamps must include source timezone")
        return value
    @model_validator(mode="after")
    def intensity_units(self):
        if self.wind is not None and not self.wind_unit or self.pressure is not None and not self.pressure_unit:
            raise ValueError("Intensity measurements require source units")
        return self

class ErrorDetail(StrictModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
class ErrorResponse(StrictModel):
    error: ErrorDetail
class Health(StrictModel):
    status: Literal["ok"] = "ok"
    service: str = "ClimateLens India"
    data_ready: bool = Field(description="Prepared manifest is valid; individual datasets may still be unavailable. See metadata limitations.")
    analytics_configured: bool = Field(description="An analytics module is configured, not proof of successful scientific execution.")
    limitations: list[str]
