"""NIElytics 0.2 APIs over validated prepared records, never a science fallback.

Annual rainfall is not daily gauge rainfall: no IMD daily classification, SPI,
antecedent-rainfall correlation, or heat/drought matching is inferred from it.
The library has no state-difference API; comparison differences remain null.
Regional event-catalog overlap is not simultaneous occurrence or causation.
"""

from __future__ import annotations

from datetime import datetime
import math
from typing import TYPE_CHECKING

import pandas as pd
from nielytics.core import statistics
from nielytics.geospatial.aggregation import aggregate_hazards_by_region
from nielytics.geospatial.india_names import normalize_state_name
from nielytics.hazards.multi_hazard import MultiHazardAnalyzer
from nielytics.insights import InsightEngine

from app.core.errors import AppError
from app.models import Envelope, Metadata, Period
from app.services.analytics_models import (
    ComparisonPoint,
    ComparisonResult,
    Insight,
    MultiHazardRelationship,
    RelationshipObservation,
)

if TYPE_CHECKING:
    from app.repositories.dataset_repository import DatasetRepository


_SUMMARY_METHOD = (
    "nielytics.core.statistics.summarize(columns=['value'], ddof=1) over the "
    "selected prepared state annual rainfall totals; arithmetic mean, not a "
    "spatial aggregation or a daily rainfall classification. Standard deviation "
    "is a sample statistic in the input unit."
)
_OVERLAP_METHOD = (
    "nielytics.hazards.multi_hazard.MultiHazardAnalyzer."
    "regional_multi_hazard_overlap(region_type='state', region_column='state') "
    "on the selected flood and landslide catalog records. The library tests "
    "presence of distinct hazard catalogs in a state across the selected period; "
    "it does not match event dates or calculate a temporal correlation."
)
_OVERLAP_LIMITATIONS = [
    "Catalog overlap across this period does not establish simultaneous events or causation.",
    "Only floods and landslides have compatible state event-catalog schemas; annual rainfall, "
    "regional temperature, national drought, and basin cyclone records are not substituted.",
    "Event catalog completeness and reporting density are not established by this analysis.",
]


def _unsupported(reason: str) -> AppError:
    return AppError("UNSUPPORTED_ANALYSIS", reason, 422, {"reason": reason})


def _period(rows: list[dict]) -> Period:
    years = [row["year"] for row in rows]
    return Period(start=str(min(years)), end=str(max(years))) if years else Period()


def _selected(rows: list[dict], state_id: str, parameters: dict) -> list[dict]:
    start, end = parameters.get("start_year"), parameters.get("end_year")
    return sorted(
        (row for row in rows if row["state_id"] == state_id
         and (start is None or row["year"] >= start)
         and (end is None or row["year"] <= end)),
        key=lambda row: row["year"],
    )


_NWIC_STATE_FIXES = {
    "andaman & nicobar island": "Andaman and Nicobar Islands",
    "arunanchal pradesh": "Arunachal Pradesh",
    "dadra & nagar havelli and daman & diu": "Dadra and Nagar Haveli and Daman and Diu",
}


def _clean_state_name(name: str) -> str | None:
    fixed = _NWIC_STATE_FIXES.get(name.strip().lower(), name)
    return normalize_state_name(fixed)


def _state_name(repository: DatasetRepository, state_id: str) -> str:
    for state in repository.states().data:
        if state["state_id"] == state_id:
            return state["name"]
    raise AppError("STATE_NOT_FOUND", "State identifier is absent from the prepared catalog.", 404)

def _rainfall(repository: DatasetRepository) -> tuple[list[dict], Metadata]:
    rows, meta = repository.records("rainfall")
    if (meta.metric != "rainfall_annual_total" or meta.unit != "mm"
            or meta.time_resolution not in {"year", "annual"}
            or meta.geographic_level != "state"):
        raise _unsupported(
            "Annual rainfall analysis requires prepared metadata declaring metric "
            "rainfall_annual_total, unit mm, state scope, and annual/year resolution. "
            "Generic rainfall, anomalies, monthly readings, and unspecified aggregation "
            "cannot be interpreted as state annual totals."
        )
    if any(row["value"] < 0 for row in rows):
        raise _unsupported("Negative prepared values cannot represent annual rainfall totals.")
    identities = [(row["state_id"], row["year"]) for row in rows]
    if len(set(identities)) != len(identities):
        raise _unsupported(
            "Annual rainfall analysis requires exactly one prepared total per state and year; "
            "multiple dated observations cannot be summed or treated as independent annual totals."
        )
    return rows, meta


def _metadata(*, metric: str, unit: str | None, period: Period, sources: list[str],
              method: str | None, count: int, limitations: list[str],
              resolution: str = "annual") -> Metadata:
    return Metadata(metric=metric, unit=unit, geographic_level="state",
                    time_resolution=resolution, period=period, source_ids=sources,
                    method=method, observation_count=count, limitations=limitations)


def _empty(operation: str, meta: Metadata, reason: str) -> dict:
    # No analytical call has executed for empty/incompatible coverage.
    meta = meta.model_copy(update={"observation_count": 0, "method": None,
                                   "limitations": [*meta.limitations, reason]})
    return Envelope(status="no_data", data=None if operation == "compare" else [],
                    meta=meta).model_dump(mode="json")


def _compare_event_counts(parameters: dict, repository: DatasetRepository) -> dict:
    metric = parameters["metric"]
    dataset = "floods" if metric == "flood_event_count" else "landslides"
    a, b = parameters["state_a"], parameters["state_b"]
    if a == b:
        raise _unsupported("State event comparison requires two distinct states.")
    _state_name(repository, a)
    _state_name(repository, b)
    start, end = parameters["start_year"], parameters["end_year"]
    if start > end:
        raise _unsupported("The requested comparison period is reversed.")
    rows, source = repository.records(dataset)
    catalog_years = sorted({
        row.get("year") or int(row["timestamp"][:4])
        for row in rows
        if (row.get("year") is not None or row.get("timestamp"))
        and start <= (row.get("year") or int(row["timestamp"][:4])) <= end
    })
    limitations = [
        *source.limitations,
        "Counts reflect documented catalog events matched to each state per catalog year; years with zero reported events for a state are 0 in that catalog year, not proof of zero hazard.",
        "Unequal reporting density between states can affect documented event counts.",
    ]
    method = (
        "nielytics.geospatial.aggregation.aggregate_hazards_by_region(region_type='state') "
        "and nielytics.core.statistics.summarize over documented annual state catalog counts."
    )
    period = Period(start=str(start), end=str(end))
    meta = _metadata(metric=metric, unit="events", period=period, sources=source.source_ids,
                     method=method, count=0, limitations=limitations)
    if not catalog_years:
        return _empty("compare", meta, "No catalog years fall within the requested comparison period.")
    counts_a = {year: 0 for year in catalog_years}
    counts_b = {year: 0 for year in catalog_years}
    matched = 0
    for row in rows:
        year = row.get("year") or (int(row["timestamp"][:4]) if row.get("timestamp") else None)
        if year not in counts_a:
            continue
        if row.get("state_id") == a:
            counts_a[year] += 1
            matched += 1
        elif row.get("state_id") == b:
            counts_b[year] += 1
            matched += 1
    meta.observation_count = len(catalog_years) * 2
    total_a = float(sum(counts_a.values()))
    total_b = float(sum(counts_b.values()))
    diff = total_b - total_a
    pct = round((diff / total_a) * 100.0, 2) if total_a != 0 else None
    series = []
    for year in catalog_years:
        va = float(counts_a[year])
        vb = float(counts_b[year])
        ydiff = vb - va
        ypct = round((ydiff / va) * 100.0, 2) if va != 0 else None
        series.append(ComparisonPoint(year=year, state_a=va, state_b=vb, absolute_difference=ydiff, percentage_difference=ypct))
    result = ComparisonResult(
        state_a=a, state_b=b, metric=metric, unit="events", period=period,
        series=series, state_a_value=total_a, state_b_value=total_b,
        absolute_difference=diff, percentage_difference=pct,
    )
    return Envelope(status="ok", data=result.model_dump(mode="json"), meta=meta).model_dump(mode="json")


def _compare(parameters: dict, repository: DatasetRepository) -> dict:
    metric = parameters.get("metric")
    advertised = repository.metadata().data["capabilities"].get("comparison_metrics") or []
    if metric in ("flood_event_count", "landslide_event_count") and metric in advertised:
        return _compare_event_counts(parameters, repository)
    if metric != "rainfall_annual_total":
        raise _unsupported(
            "This installed NIElytics API supports descriptive comparison of prepared "
            "annual rainfall totals only. Rainfall anomalies require a declared baseline; "
            "event catalogs do not establish annual zero-event coverage, and the library "
            "does not supply an equivalent annual event-count comparison API."
        )
    a, b = parameters["state_a"], parameters["state_b"]
    if a == b:
        raise _unsupported("Annual rainfall comparison requires two distinct states.")
    _state_name(repository, a)
    _state_name(repository, b)
    rows, source = _rainfall(repository)
    left, right = _selected(rows, a, parameters), _selected(rows, b, parameters)
    start, end = parameters["start_year"], parameters["end_year"]
    expected = set(range(start, end + 1))
    if not expected:
        raise _unsupported("The requested comparison period is reversed.")
    limitations = [*source.limitations,
                  "NIElytics supplies descriptive means, not state differences; absolute "
                  "and percentage differences are not calculated by this adapter.",
                  "Prepared state totals are accepted as supplied; this call does not "
                  "validate their upstream spatial aggregation or station coverage."]
    meta = _metadata(metric="rainfall_annual_total", unit=source.unit,
                     period=Period(start=str(start), end=str(end)), sources=source.source_ids,
                     method=_SUMMARY_METHOD, count=len(left) + len(right), limitations=limitations)
    if {row["year"] for row in left} != expected or {row["year"] for row in right} != expected:
        return _empty("compare", meta,
                      "Both states require an observed annual total in every requested year. "
                      "Missing years are neither filled with zero nor silently dropped.")
    paired_method = _SUMMARY_METHOD.replace("selected prepared state", "fully paired prepared state")
    meta.method = paired_method
    # Only schema/column adaptation and year alignment occur here. All summaries
    # are produced by the real library; difference fields deliberately stay null.
    left_summary = statistics.summarize(pd.DataFrame(left), columns=["value"], ddof=1)
    right_summary = statistics.summarize(pd.DataFrame(right), columns=["value"], ddof=1)
    result = ComparisonResult(
        state_a=a, state_b=b, metric="rainfall_annual_total", unit=source.unit,
        period=meta.period,
        series=[ComparisonPoint(year=x["year"], state_a=x["value"], state_b=y["value"])
                for x, y in zip(left, right, strict=True)],
        state_a_value=float(left_summary.loc["value", "mean"]),
        state_b_value=float(right_summary.loc["value", "mean"]),
    )
    return Envelope(status="ok", data=result.model_dump(mode="json"), meta=meta).model_dump(mode="json")


def _rainfall_insights(parameters: dict, repository: DatasetRepository) -> dict:
    state_id = parameters["state_id"]
    name = _state_name(repository, state_id)
    rows, source = _rainfall(repository)
    selected = _selected(rows, state_id, parameters)
    limitations = [*source.limitations,
                  "Descriptive statistics summarize available prepared annual observations, "
                  "not daily extremes, climate forecasts, or a climatological normal.",
                  "Unobserved years are not filled; catalog and station coverage have not "
                  "been independently established by this call."]
    meta = _metadata(metric="rainfall_annual_total", unit=source.unit, period=_period(selected),
                     sources=source.source_ids, method=_SUMMARY_METHOD, count=len(selected),
                     limitations=limitations)
    if not selected:
        return _empty("insights", meta, "No prepared annual rainfall observations match the selection.")
    frame = pd.DataFrame(selected)
    summary = statistics.summarize(frame, columns=["value"], ddof=1).loc["value"]
    values = {key: float(summary[key]) if math.isfinite(float(summary[key])) else None
              for key in ("count", "mean", "median", "std", "min", "max", "q25", "q75")}
    if len(selected) < 3:
        limitations.append("Fewer than three annual observations: NIElytics Mann-Kendall test was not executed.")
    gaps = set(range(selected[0]["year"], selected[-1]["year"] + 1)) - {row["year"] for row in selected}
    if gaps:
        limitations.append("Selected annual observations have missing intervening years; no values were interpolated.")
    if len(selected) < 2:
        limitations.append("Sample standard deviation is undefined for one observation and is returned as null.")
    meta.limitations = list(limitations)
    common = dict(region=name, unit=source.unit, geographic_resolution="state", period=meta.period,
                  source_ids=source.source_ids, observation_count=len(selected), limitations=limitations)
    insights = [Insight(
        id=f"rainfall-summary:{state_id}:{meta.period.start}:{meta.period.end}",
        title="Observed annual rainfall summary",
        description="NIElytics descriptive statistics of the selected prepared annual rainfall totals. "
                    "The computed value is their arithmetic mean in mm.",
        computed_value=values["mean"], statistics=values, method=_SUMMARY_METHOD, **common,
    )]
    if len(selected) >= 3:
        trend = statistics.mann_kendall_test(frame["value"], alpha=0.05)
        method = ("nielytics.core.statistics.mann_kendall_test(alpha=0.05) on annual rainfall "
                  "totals sorted by their observed year; nonparametric monotonic trend test "
                  "with tie correction, no interpolation and no prediction.")
        insights.append(Insight(
            id=f"rainfall-trend:{state_id}:{meta.period.start}:{meta.period.end}",
            title="Annual rainfall Mann-Kendall test",
            description=f"NIElytics returned trend classification '{trend['trend']}' for the "
                        "selected observations. This is not a forecast or a test of causation.",
            computed_value=trend["trend"], statistics=trend, method=method,
            **{**common, "unit": None},
        ))
        meta.method = f"{_SUMMARY_METHOD} {method}"
    return Envelope(status="ok", data=[item.model_dump(mode="json") for item in insights],
                    meta=meta).model_dump(mode="json")


def _event_inputs(
    parameters: dict, repository: DatasetRepository, *, require_both: bool,
) -> tuple[str, dict[str, pd.DataFrame], list[RelationshipObservation], list[str], Period, list[str]]:
    state_id = parameters["state_id"]
    name = _state_name(repository, state_id)
    normalized = _clean_state_name(name)
    if not normalized:
        raise _unsupported("NIElytics cannot normalize this prepared state name for regional event analysis.")
    datasets, observations, sources, limitations = {}, [], [], []
    for dataset, hazard in (("floods", "flood"), ("landslides", "landslide")):
        if not repository.has(dataset):
            if require_both:
                raise _unsupported("Regional catalog overlap requires both prepared floods and landslides datasets.")
            limitations.append(f"Prepared {dataset} catalog is unavailable and was not analyzed.")
            continue
        rows, source = repository.records(dataset)
        if source.geographic_level not in {"state", "point"}:
            raise _unsupported("Regional event analysis requires state-assigned events, not national or regional estimates.")
        if source.geographic_level == "point":
            limitations.append("Point-event catalogs are grouped only by their explicit source-matched state IDs; missing state assignments are excluded, not spatially inferred.")
        limitations.extend(source.limitations)
        chosen, undated = [], 0
        for row in rows:
            if row["state_id"] != state_id:
                continue
            year = row.get("year")
            if year is None and row.get("timestamp"):
                year = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).year
            if year is None:
                undated += 1
                continue
            if ((parameters.get("start_year") is not None and year < parameters["start_year"])
                    or (parameters.get("end_year") is not None and year > parameters["end_year"])):
                continue
            chosen.append({"state": normalized})
            observations.append(RelationshipObservation(
                hazard=hazard, event_id=row["event_id"], state_id=state_id, year=year,
                timestamp=row.get("timestamp"), longitude=row.get("longitude"), latitude=row.get("latitude"),
            ))
        if undated:
            limitations.append(f"Excluded {undated} {dataset} records for this state with no source year or timestamp.")
        datasets[hazard] = pd.DataFrame(chosen, columns=["state"])
        if chosen:
            sources.extend(source.source_ids)
    sources = list(dict.fromkeys(sources))
    period = _period([{"year": observation.year} for observation in observations])
    if not datasets:
        raise _unsupported("State event insights require at least one prepared flood or landslide catalog.")
    return normalized, datasets, observations, sources, period, list(dict.fromkeys(limitations))


def _event_insights(parameters: dict, repository: DatasetRepository, *, skipped_rainfall: str) -> dict:
    normalized, _, observations, sources, period, limitations = _event_inputs(
        parameters, repository, require_both=False)
    method = (
        "nielytics.geospatial.aggregation.aggregate_hazards_by_region("
        "region_type='state', region_column='state', hazard_column='hazard') "
        "followed by nielytics.insights.InsightEngine.generate_insights on that "
        "actual regional_hazard_aggregation result. Only the selected state and "
        "dated flood/landslide catalog entries are evaluated; no daily dates are invented."
    )
    limitations.extend([
        "Only the selected state is evaluated; the rule engine's highest-concentration "
        "wording is not a ranking against other states or a finding of unusual risk.",
        "Counts describe documented catalog entries, not event incidence rates or complete annual coverage.",
        f"Annual rainfall analysis was not executed: {skipped_rainfall}",
        "Flood and landslide catalog overlap or concentration does not establish causation.",
    ])
    meta = _metadata(metric="documented_event_count", unit="events", period=period,
                     sources=sources, method=method, count=len(observations),
                     limitations=limitations, resolution="event")
    if not observations:
        return _empty("insights", meta, "No dated state event records match this selection.")
    frame = pd.DataFrame([{"state": normalized, "hazard": item.hazard} for item in observations])
    aggregate = aggregate_hazards_by_region(
        frame, region_type="state", region_column="state", hazard_column="hazard")
    generated = InsightEngine().generate_insights([aggregate])
    insights = []
    for index, item in enumerate(generated.data["insights"]):
        metrics = item["metrics"]
        insights.append(Insight(
            id=f"event-insight:{parameters['state_id']}:{period.start}:{period.end}:{index}",
            title="NIElytics reported-event summary",
            description="Selected-state-only rule output, not a comparison with other states: "
                        + item["description"],
            region=item["geographic_scope"] or normalized,
            computed_value=metrics.get("event_count"), unit="events", geographic_resolution="state",
            period=period, statistics={
                "event_count": metrics.get("event_count"),
                "region": metrics.get("region"),
                "hazards": ", ".join(metrics.get("hazards", [])),
            }, source_ids=sources, method=method, observation_count=len(observations),
            limitations=[*limitations, *aggregate.warnings, *generated.warnings, *item["limitations"]],
        ))
    if not insights:
        return _empty("insights", meta, "The NIElytics rule engine returned no finding for these catalog records.")
    meta.limitations = list(dict.fromkeys([
        *limitations, *aggregate.warnings, *generated.warnings,
        *(limitation for item in insights for limitation in item.limitations),
    ]))
    return Envelope(status="ok", data=[item.model_dump(mode="json") for item in insights],
                    meta=meta).model_dump(mode="json")


def _insights(parameters: dict, repository: DatasetRepository) -> dict:
    skipped_rainfall = "Prepared annual rainfall totals are unavailable."
    if repository.has("rainfall"):
        try:
            return _rainfall_insights(parameters, repository)
        except AppError as error:
            if error.code != "UNSUPPORTED_ANALYSIS":
                raise
            skipped_rainfall = error.message
    return _event_insights(parameters, repository, skipped_rainfall=skipped_rainfall)


def _multi_hazard(parameters: dict, repository: DatasetRepository) -> dict:
    state_id = parameters["state_id"]
    normalized, datasets, observations, sources, period, limitations = _event_inputs(
        parameters, repository, require_both=True)
    meta = _metadata(metric="regional_event_catalog_overlap", unit=None, period=period,
                     sources=sources, method=_OVERLAP_METHOD, count=len(observations),
                     limitations=[*_OVERLAP_LIMITATIONS, *limitations], resolution="event")
    if not observations:
        return _empty("multi_hazard", meta, "No dated state event records match this selection.")
    result = MultiHazardAnalyzer.regional_multi_hazard_overlap(
        datasets, region_type="state", region_column="state")
    regional = result.data["matrix"].get(normalized)
    if not regional or not regional["multi_hazard_exposed"]:
        return _empty("multi_hazard", meta,
                      "NIElytics found no overlap of two documented hazard catalogs for this state and period. "
                      "This does not establish absence of hazards or events.")
    relationship = MultiHazardRelationship(
        id=f"catalog-overlap:{state_id}:{period.start}:{period.end}",
        title="Flood and landslide catalog overlap",
        description=f"NIElytics identified {normalized} in both event catalogs during the "
                    "selected period. Events need not share a date; this is regional exposure only.",
        hazards=regional["hazards"], region=normalized, state_ids=[state_id], period=period,
        observations=observations, source_ids=sources, method=_OVERLAP_METHOD,
        observation_count=len(observations), limitations=meta.limitations,
    )
    return Envelope(status="ok", data=[relationship.model_dump(mode="json")], meta=meta).model_dump(mode="json")


def analyze(*, operation: str, parameters: dict, repository: DatasetRepository) -> dict:
    """Execute only operations justified by installed APIs and prepared schemas."""
    operations = {"compare": _compare, "insights": _insights, "multi_hazard": _multi_hazard}
    if operation not in operations:
        raise _unsupported(f"NIElytics adapter does not support operation {operation!r}.")
    return operations[operation](parameters, repository)
