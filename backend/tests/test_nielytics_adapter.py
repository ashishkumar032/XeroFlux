"""SYNTHETIC TEST ONLY: real NIElytics calls, no production observations.

These tests require the actual nielytics distribution in the active environment.
They deliberately do not skip, emulate the package, or substitute a plugin.
"""

from copy import deepcopy
import json
from unittest.mock import Mock

import pandas as pd
import pytest
from nielytics.core import statistics
from nielytics.insights import InsightEngine
from nielytics.hazards.multi_hazard import MultiHazardAnalyzer

from app.core.config import Config
from app.core.errors import AppError
from app.repositories.dataset_repository import DatasetRepository
import app.services.nielytics_adapter as adapter
from app.services.analytics_service import AnalyticsService
from app.services.nielytics_adapter import analyze


@pytest.fixture
def prepared(tmp_path):
    """Write only isolated temporary, conspicuously synthetic prepared records."""
    def create(*, rainfall=None, floods=None, landslides=None, rain_meta=None,
               missing=(), state_name="Orissa"):
        rainfall = deepcopy(rainfall if rainfall is not None else [
            {"state_id": state, "year": year, "value": float(value)}
            for state, values in (("OD", [0, 100, 200]), ("KL", [20, 120, 220]))
            for year, value in zip((2019, 2020, 2021), values, strict=True)
        ])
        def event(identity, year, timestamp=None, state="OD"):
            return dict(event_id=identity, state_id=state, year=year,
                        timestamp=timestamp, longitude=None, latitude=None,
                        attributes={"test_only": "SYNTHETIC, not real observations"})
        payloads = {
            "states": [{"state_id": "OD", "name": state_name},
                       {"state_id": "KL", "name": "Kerala"}],
            "rainfall": rainfall,
            "floods": floods if floods is not None else [event("test-flood", 2019)],
            "landslides": landslides if landslides is not None else [event("test-slide", 2021)],
        }
        def metadata(metric, count, source):
            return dict(metric=metric, unit="mm" if metric == "rainfall_annual_total" else None,
                        geographic_level="state", time_resolution="annual" if metric == "rainfall_annual_total" else "event",
                        period={"start": "2019", "end": "2021"}, source_ids=[source],
                        method="SYNTHETIC prepared fixture, not a scientific calculation",
                        observation_count=count, limitations=["SYNTHETIC TEST ONLY"])
        datasets = {}
        for name, rows in payloads.items():
            if name in missing:
                continue
            metric = "rainfall_annual_total" if name == "rainfall" else name
            source = f"test-{name}"
            meta = metadata(metric, len(rows), source)
            if name == "rainfall" and rain_meta:
                meta.update(rain_meta)
            (tmp_path / f"{name}.json").write_text(json.dumps(rows), encoding="utf-8")
            datasets[name] = {"path": f"{name}.json", "format": "json", "meta": meta}
        sources = [dict(id=f"test-{name}", name="SYNTHETIC TEST ONLY", provider="Test suite",
                        url=None, geographic_coverage="Synthetic observations with state labels",
                        temporal_coverage="Synthetic 2019-2021", data_format="json",
                        purpose="Isolated adapter tests only", provenance_status="synthetic",
                        limitations=["Not real climate observations"])
                   for name in payloads]
        (tmp_path / "manifest.json").write_text(json.dumps(dict(
            version=1, processed_at="2026-01-01T00:00:00Z",
            metadata=metadata("catalog", 0, "test-states"), datasets=datasets,
            sources=sources, capabilities={"comparison_metrics": ["rainfall_annual_total"]},
        )), encoding="utf-8")
        return DatasetRepository(tmp_path)
    return create


def compare_parameters(**updates):
    return dict(state_a="OD", state_b="KL", metric="rainfall_annual_total",
                start_year=2019, end_year=2021) | updates


def test_comparison_executes_real_summary_and_retains_only_available_results(prepared, monkeypatch):
    spy = Mock(wraps=statistics.summarize)
    monkeypatch.setattr(statistics, "summarize", spy)
    result = analyze(operation="compare", parameters=compare_parameters(), repository=prepared())
    assert spy.call_count == 2
    assert result["status"] == "ok"
    assert result["data"]["state_a_value"] == 100.0
    assert result["data"]["state_b_value"] == 120.0
    assert [point["year"] for point in result["data"]["series"]] == [2019, 2020, 2021]
    assert result["data"]["series"][0]["state_a"] == 0.0
    assert result["data"]["absolute_difference"] is None
    assert result["data"]["percentage_difference"] is None
    assert all(point["absolute_difference"] is None for point in result["data"]["series"])
    assert result["meta"]["observation_count"] == 6
    assert result["meta"]["source_ids"] == ["test-rainfall"]
    assert "summarize" in result["meta"]["method"]


def test_comparison_does_not_drop_or_zero_fill_missing_years(prepared, monkeypatch):
    rows = [{"state_id": "OD", "year": 2019, "value": 0.0},
            {"state_id": "KL", "year": 2020, "value": 20.0}]
    spy = Mock(wraps=statistics.summarize)
    monkeypatch.setattr(statistics, "summarize", spy)
    result = analyze(operation="compare", parameters=compare_parameters(), repository=prepared(rainfall=rows))
    assert result["status"] == "no_data" and result["data"] is None
    assert result["meta"]["observation_count"] == 0
    assert result["meta"]["method"] is None
    assert "Missing years" in result["meta"]["limitations"][-1]
    spy.assert_not_called()


@pytest.mark.parametrize("metric", ["rainfall_anomaly", "flood_event_count", "landslide_event_count", "temperature", "drought"])
def test_incompatible_metrics_are_explicitly_unsupported(prepared, metric):
    with pytest.raises(AppError) as error:
        analyze(operation="compare", parameters=compare_parameters(metric=metric), repository=prepared())
    assert error.value.code == "UNSUPPORTED_ANALYSIS"
    assert error.value.status_code == 422
    assert error.value.details["reason"] == error.value.message


@pytest.mark.parametrize("updates", [
    {"metric": "rainfall"}, {"unit": "%"}, {"time_resolution": "monthly"},
    {"geographic_level": "national"},
])
def test_annual_metric_is_not_inferred_from_generic_or_incompatible_metadata(prepared, updates):
    with pytest.raises(AppError) as error:
        analyze(operation="compare", parameters=compare_parameters(), repository=prepared(rain_meta=updates))
    assert error.value.code == "UNSUPPORTED_ANALYSIS"


def test_insight_statistics_and_trend_are_actual_library_outputs(prepared, monkeypatch):
    expected_summary = statistics.summarize(pd.DataFrame({"value": [0.0, 100.0, 200.0]}))
    expected_trend = statistics.mann_kendall_test([0.0, 100.0, 200.0], alpha=0.05)
    summary_spy = Mock(wraps=statistics.summarize)
    trend_spy = Mock(wraps=statistics.mann_kendall_test)
    monkeypatch.setattr(statistics, "summarize", summary_spy)
    monkeypatch.setattr(statistics, "mann_kendall_test", trend_spy)
    result = analyze(operation="insights", parameters={"state_id": "OD"}, repository=prepared())
    assert summary_spy.call_count == trend_spy.call_count == 1
    summary, trend = result["data"]
    assert summary["computed_value"] == expected_summary.loc["value", "mean"]
    for key, value in summary["statistics"].items():
        assert value == expected_summary.loc["value", key]
    assert trend["statistics"] == expected_trend
    assert trend["computed_value"] == expected_trend["trend"]
    assert "mann_kendall_test" in trend["method"]
    assert trend["unit"] is None
    assert summary["observation_count"] == trend["observation_count"] == 3
    assert result["meta"]["observation_count"] == 3
    assert result["meta"]["period"] == {"start": "2019", "end": "2021"}
    assert all(item["source_ids"] == ["test-rainfall"] for item in result["data"])


def test_insight_filtering_precedes_library_call_and_small_sample_is_not_faked(prepared, monkeypatch):
    spy = Mock(wraps=statistics.mann_kendall_test)
    monkeypatch.setattr(statistics, "mann_kendall_test", spy)
    result = analyze(operation="insights", parameters={"state_id": "OD", "start_year": 2019, "end_year": 2019}, repository=prepared())
    assert len(result["data"]) == 1
    assert result["data"][0]["computed_value"] == 0.0
    assert result["data"][0]["statistics"]["std"] is None
    assert result["data"][0]["observation_count"] == 1
    assert any("not executed" in limitation for limitation in result["meta"]["limitations"])
    json.dumps(result, allow_nan=False)
    spy.assert_not_called()


def test_empty_insights_are_no_data_without_library_method(prepared, monkeypatch):
    spy = Mock(wraps=statistics.summarize)
    monkeypatch.setattr(statistics, "summarize", spy)
    result = analyze(operation="insights", parameters={"state_id": "OD", "start_year": 2000, "end_year": 2001}, repository=prepared())
    assert result["status"] == "no_data" and result["data"] == []
    assert result["meta"]["observation_count"] == 0
    assert result["meta"]["method"] is None
    spy.assert_not_called()


def test_real_multihazard_api_reports_catalog_overlap_not_simultaneity(prepared, monkeypatch):
    spy = Mock(wraps=MultiHazardAnalyzer.regional_multi_hazard_overlap)
    monkeypatch.setattr(MultiHazardAnalyzer, "regional_multi_hazard_overlap", spy)
    result = analyze(operation="multi_hazard", parameters={"state_id": "OD"}, repository=prepared())
    assert spy.call_count == 1
    relationship = result["data"][0]
    assert relationship["region"] == "Odisha"
    assert relationship["hazards"] == ["flood", "landslide"]
    assert relationship["observation_count"] == 2
    assert {item["year"] for item in relationship["observations"]} == {2019, 2021}
    assert all(item["timestamp"] is None for item in relationship["observations"])
    assert set(relationship["source_ids"]) == {"test-floods", "test-landslides"}
    assert relationship["period"] == {"start": "2019", "end": "2021"}
    assert "does not match event dates" in relationship["method"]
    assert any("causation" in limitation for limitation in relationship["limitations"])


def test_multihazard_respects_period_and_does_not_imply_unobserved_hazards_absent(prepared):
    result = analyze(operation="multi_hazard", parameters={"state_id": "OD", "start_year": 2019, "end_year": 2019}, repository=prepared())
    assert result["status"] == "no_data" and result["data"] == []
    assert result["meta"]["observation_count"] == 0
    assert "does not establish absence" in result["meta"]["limitations"][-1]
    assert result["meta"]["source_ids"] == ["test-floods"]


def test_multihazard_keeps_source_precision_and_discloses_undated_exclusions(prepared):
    floods = [dict(event_id="undated-test", state_id="OD", year=None, timestamp=None),
              dict(event_id="timestamp-only-test", state_id="OD", year=None, timestamp="2020-05-03T10:00:00Z")]
    result = analyze(operation="multi_hazard", parameters={"state_id": "OD"}, repository=prepared(floods=floods))
    observations = result["data"][0]["observations"]
    flood = next(item for item in observations if item["hazard"] == "flood")
    assert flood["year"] == 2020 and flood["timestamp"] == "2020-05-03T10:00:00Z"
    assert len(observations) == 2
    assert any("Excluded 1 floods" in text for text in result["meta"]["limitations"])


@pytest.mark.parametrize("missing", [("floods",), ("landslides",)])
def test_missing_catalog_is_unsupported_not_a_fake_empty_analysis(prepared, missing):
    with pytest.raises(AppError) as error:
        analyze(operation="multi_hazard", parameters={"state_id": "OD"}, repository=prepared(missing=missing))
    assert error.value.code == "UNSUPPORTED_ANALYSIS"


def test_unknown_region_normalization_is_unsupported(prepared):
    with pytest.raises(AppError) as error:
        analyze(operation="multi_hazard", parameters={"state_id": "OD"}, repository=prepared(state_name="Synthetic Unrecognized Region"))
    assert error.value.code == "UNSUPPORTED_ANALYSIS"


def test_adapter_results_pass_the_existing_plugin_models_and_source_validation(prepared, tmp_path):
    service = AnalyticsService(Config(data_dir=tmp_path, analytics_module="app.services.nielytics_adapter"), prepared())
    for operation, parameters in (("compare", compare_parameters()),
                                  ("insights", {"state_id": "OD"}),
                                  ("multi_hazard", {"state_id": "OD"})):
        result = service.execute(operation, parameters)
        assert result.status == "ok"
        assert result.meta.source_ids
        json.dumps(result.model_dump(mode="json"), allow_nan=False)


def test_unsupported_operation_is_never_success(prepared):
    with pytest.raises(AppError) as error:
        analyze(operation="forecast", parameters={}, repository=prepared())
    assert error.value.code == "UNSUPPORTED_ANALYSIS"


def test_event_insight_executes_real_aggregation_and_rule_engine_without_rainfall(prepared, monkeypatch):
    aggregate_spy = Mock(wraps=adapter.aggregate_hazards_by_region)
    engine_spy = Mock(wraps=InsightEngine().generate_insights)
    monkeypatch.setattr(adapter, "aggregate_hazards_by_region", aggregate_spy)
    monkeypatch.setattr(InsightEngine, "generate_insights", engine_spy)
    repository = prepared(missing=("rainfall",))
    result = analyze(operation="insights", parameters={"state_id": "OD"}, repository=repository)
    assert aggregate_spy.call_count == engine_spy.call_count == 1
    aggregate = engine_spy.call_args.args[0][0]
    assert aggregate.feature == "regional_hazard_aggregation"
    assert aggregate.data["regions"]["Odisha"]["event_count"] == 2
    insight = result["data"][0]
    assert insight["title"] == "NIElytics reported-event summary"
    assert "not a comparison with other states" in insight["description"]
    assert insight["computed_value"] == insight["statistics"]["event_count"] == 2
    assert insight["unit"] == "events"
    assert insight["region"] == "Odisha"
    assert insight["observation_count"] == 2
    assert insight["period"] == {"start": "2019", "end": "2021"}
    assert set(insight["source_ids"]) == {"test-floods", "test-landslides"}
    assert "InsightEngine.generate_insights" in insight["method"]
    assert any("not a ranking" in limitation for limitation in insight["limitations"])
    assert any("rainfall totals are unavailable" in limitation for limitation in insight["limitations"])
    assert aggregate.data["regions"]["Odisha"]["date_range"] is None


def test_event_insights_use_only_selected_observed_period_and_preserve_actual_engine_values(prepared, monkeypatch):
    spy = Mock(wraps=statistics.summarize)
    monkeypatch.setattr(statistics, "summarize", spy)
    result = analyze(operation="insights", parameters={"state_id": "OD", "start_year": 2021, "end_year": 2021},
                     repository=prepared(missing=("rainfall",)))
    insight = result["data"][0]
    assert insight["computed_value"] == 1
    assert insight["statistics"]["hazards"] == "landslide"
    assert insight["source_ids"] == ["test-landslides"]
    assert insight["observation_count"] == 1
    assert insight["period"] == {"start": "2021", "end": "2021"}
    spy.assert_not_called()


def test_single_available_catalog_can_generate_an_event_insight_with_limitation(prepared):
    result = analyze(operation="insights", parameters={"state_id": "OD"},
                     repository=prepared(missing=("rainfall", "landslides")))
    assert result["status"] == "ok"
    assert result["data"][0]["computed_value"] == 1
    assert result["data"][0]["source_ids"] == ["test-floods"]
    assert any("landslides catalog is unavailable" in text for text in result["meta"]["limitations"])


def test_event_insight_empty_selection_is_no_data_not_zero_event_finding(prepared):
    result = analyze(operation="insights", parameters={"state_id": "KL"},
                     repository=prepared(missing=("rainfall",)))
    assert result["status"] == "no_data" and result["data"] == []
    assert result["meta"]["observation_count"] == 0
    assert result["meta"]["method"] is None


def test_event_insight_passes_existing_service_output_and_provenance_validation(prepared, tmp_path):
    service = AnalyticsService(Config(data_dir=tmp_path, analytics_module="app.services.nielytics_adapter"),
                               prepared(missing=("rainfall",)))
    result = service.execute("insights", {"state_id": "OD"})
    assert result.status == "ok"
    assert result.data[0]["computed_value"] == 2
    assert result.meta.source_ids == ["test-floods", "test-landslides"]


def test_no_compatible_observation_schema_is_explicitly_unsupported(prepared):
    with pytest.raises(AppError) as error:
        analyze(operation="insights", parameters={"state_id": "OD"},
                repository=prepared(missing=("rainfall", "floods", "landslides")))
    assert error.value.code == "UNSUPPORTED_ANALYSIS"


def test_negative_values_cannot_be_labeled_annual_rainfall_totals(prepared):
    with pytest.raises(AppError) as error:
        analyze(operation="compare", parameters=compare_parameters(),
                repository=prepared(rainfall=[{"state_id": "OD", "year": 2019, "value": -1.0}]))
    assert error.value.code == "UNSUPPORTED_ANALYSIS"


def test_daily_or_unitless_rainfall_does_not_hide_supported_event_insight(prepared, monkeypatch):
    summary_spy = Mock(wraps=statistics.summarize)
    monkeypatch.setattr(statistics, "summarize", summary_spy)
    result = analyze(
        operation="insights", parameters={"state_id": "OD"},
        repository=prepared(rain_meta={"metric": "rainfall_daily_actual",
                                       "time_resolution": "day", "unit": None}),
    )
    assert result["status"] == "ok"
    assert result["data"][0]["title"] == "NIElytics reported-event summary"
    assert result["data"][0]["computed_value"] == 2
    assert set(result["meta"]["source_ids"]) == {"test-floods", "test-landslides"}
    assert any("Annual rainfall analysis was not executed:" in text
               and "rainfall_annual_total" in text for text in result["meta"]["limitations"])
    summary_spy.assert_not_called()

@pytest.mark.parametrize("scope,valid", [("point", True), ("national", False)])
def test_event_grouping_requires_explicit_state_assignments_not_national_estimates(prepared, tmp_path, scope, valid):
    repository = prepared(missing=("rainfall",))
    path = tmp_path / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    for name in ("floods", "landslides"):
        manifest["datasets"][name]["meta"]["geographic_level"] = scope
    path.write_text(json.dumps(manifest), encoding="utf-8")
    if not valid:
        with pytest.raises(AppError) as error:
            analyze(operation="insights", parameters={"state_id": "OD"}, repository=repository)
        assert error.value.code == "UNSUPPORTED_ANALYSIS"
    else:
        result = analyze(operation="insights", parameters={"state_id": "OD"}, repository=repository)
        assert result["data"][0]["computed_value"] == 2
        assert result["meta"]["geographic_level"] == "state"
