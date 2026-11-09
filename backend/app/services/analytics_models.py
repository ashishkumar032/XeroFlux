"""ClimateLens plugin output schemas; these are not an upstream NIElytics API.

All differences, statistics and relationships must be supplied by the configured
plugin. These models validate structure only, never calculate findings.
Insight.period and Insight.method are the time-period and methodology fields;
they retain those contract names rather than creating duplicate aliases.
"""

from datetime import datetime

from pydantic import Field, model_validator

from app.models import Period, StrictModel


class Insight(StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    region: str = Field(min_length=1)
    computed_value: float | str | None
    unit: str | None
    geographic_resolution: str = Field(min_length=1)
    period: Period
    statistics: dict[str, float | str | None]
    source_ids: list[str]
    method: str | None = None
    observation_count: int = Field(ge=0)
    limitations: list[str]


class ComparisonPoint(StrictModel):
    """Plugin-supplied differences; percentage baseline is state_a, never zero."""

    year: int = Field(ge=1800, le=2100)
    state_a: float | None
    state_b: float | None
    absolute_difference: float | None = None
    percentage_difference: float | None = None


class ComparisonResult(StrictModel):
    """Authoritative plugin output; absent summary values remain absent/null."""

    state_a: str = Field(min_length=1)
    state_b: str = Field(min_length=1)
    metric: str = Field(min_length=1)
    unit: str | None = None
    period: Period
    series: list[ComparisonPoint] = Field(min_length=1)
    state_a_value: float | None = None
    state_b_value: float | None = None
    absolute_difference: float | None = None
    percentage_difference: float | None = None


class RelationshipObservation(StrictModel):
    hazard: str = Field(min_length=1)
    event_id: str = Field(min_length=1)
    state_id: str | None = None
    year: int | None = Field(default=None, ge=1800, le=2100)
    timestamp: str | None = None
    longitude: float | None = Field(default=None, ge=-180, le=180)
    latitude: float | None = Field(default=None, ge=-90, le=90)

    @model_validator(mode="after")
    def consistent_observation(self):
        if (self.longitude is None) != (self.latitude is None):
            raise ValueError("Coordinates must both be supplied or both absent")
        if self.timestamp is not None:
            parsed = datetime.fromisoformat(self.timestamp.replace("Z", "+00:00"))
            if self.year is not None and parsed.year != self.year:
                raise ValueError("Timestamp and year disagree")
        return self


class MultiHazardRelationship(StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    hazards: list[str] = Field(min_length=2)
    region: str = Field(min_length=1)
    state_ids: list[str]
    period: Period
    observations: list[RelationshipObservation]
    source_ids: list[str]
    method: str | None = None
    observation_count: int = Field(ge=0)
    limitations: list[str]
