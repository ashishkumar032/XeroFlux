"""Synthetic test-only plugins and observations; never production climate data."""

from copy import deepcopy
from io import BytesIO
import sys
from types import ModuleType

import pytest
from pypdf import PdfReader

from app.core.config import Config
from app.core.errors import AppError
from app.models import Envelope, Metadata
from app.services.analytics_service import AnalyticsService
from app.services.reports_service import ReportService


def metadata(**updates):
    value = {
        "metric": "rainfall", "unit": "mm", "geographic_level": "state",
        "time_resolution": "annual", "period": {"start": "2019", "end": "2020"},
        "source_ids": ["test-source"], "method": "Prepared values; no calculation here",
        "observation_count": 2, "limitations": ["Synthetic test-only coverage"],
    }
    value.update(updates)
    return value


def insight(**updates):
    value = {
        "id": "synthetic-insight", "title": "Supplied test finding",
        "description": "Synthetic plugin evidence, not a real climate finding.",
        "region": "Test State", "computed_value": 123.45, "unit": "mm",
        "geographic_resolution": "state", "period": {"start": "2019", "end": "2020"},
        "statistics": {"supplied_value": 123.45}, "source_ids": ["test-source"],
        "method": "Supplied test-only method", "observation_count": 2,
        "limitations": ["Synthetic insight limitation"],
    }
    value.update(updates)
    return value


def comparison(**updates):
    value = {
        "state_a": "TS", "state_b": "OTHER", "metric": "rainfall", "unit": "mm",
        "period": {"start": "2019", "end": "2020"},
        "series": [{"year": 2019, "state_a": 100.0, "state_b": 125.0,
                    "absolute_difference": 25.0, "percentage_difference": 25.0}],
    }
    value.update(updates)
    return value


class PreparedRepository:
    def __init__(self, datasets=None):
        self.datasets = datasets if datasets is not None else {}

    def sources(self):
        return Envelope(status="ok", data=[{
            "id": "test-source", "name": "Synthetic source", "provider": "Test provider",
            "url": "https://example.test/prepared", "geographic_coverage": "Test State",
            "temporal_coverage": "2019-2020", "data_format": "JSON", "purpose": "Tests only",
            "provenance_status": "Synthetic test fixture", "limitations": ["Not real observations"],
        }], meta=Metadata.model_validate(metadata()))

    def states(self):
        return Envelope(status="ok", data=[{"state_id": "TS", "name": "Test <State> & Coast"}],
                        meta=Metadata.model_validate(metadata()))

    def records(self, name):
        if name not in self.datasets:
            raise AppError("DATASET_UNAVAILABLE", "No prepared test dataset")
        return self.datasets[name], Metadata.model_validate(metadata(metric=name))


@pytest.fixture
def plugin(monkeypatch, tmp_path):
    def install(data=None, meta=None, status="ok", analyze=None):
        module = ModuleType("synthetic_climatelens_plugin")
        module.analyze = analyze or (lambda **kwargs: {
            "status": status, "data": deepcopy(data if data is not None else [insight()]),
            "meta": deepcopy(meta if meta is not None else metadata()),
        })
        monkeypatch.setitem(sys.modules, module.__name__, module)
        repository = PreparedRepository()
        return AnalyticsService(Config(data_dir=tmp_path, analytics_module=module.__name__), repository)
    return install


def test_explicit_plugin_receives_protocol_and_preserves_evidence(plugin):
    calls = []
    expected_meta = metadata(method=None)

    def analyze(**kwargs):
        calls.append(kwargs)
        return {"status": "ok", "data": [insight(method=None)], "meta": expected_meta}

    service = plugin(analyze=analyze)
    result = service.execute("insights", {"state_id": "TS"})
    assert calls == [{"operation": "insights", "parameters": {"state_id": "TS"},
                      "repository": service.repository}]
    assert result.meta.model_dump() == expected_meta
    assert result.data[0]["method"] is None
    assert result.data[0]["computed_value"] == 123.45


def test_missing_configuration_never_imports(monkeypatch, tmp_path):
    def unexpected_import(name):
        pytest.fail(f"Unconfigured module imported: {name}")
    monkeypatch.setattr("app.services.analytics_service.importlib.import_module", unexpected_import)
    with pytest.raises(AppError) as caught:
        AnalyticsService(Config(data_dir=tmp_path, analytics_module=None), PreparedRepository()).execute("insights", {})
    assert (caught.value.code, caught.value.status_code) == ("ANALYTICS_UNAVAILABLE", 503)


@pytest.mark.parametrize("missing_function", [False, True])
def test_missing_module_or_function_is_unavailable(monkeypatch, tmp_path, missing_function):
    name = "nonexistent_test_analytics_module"
    if missing_function:
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    with pytest.raises(AppError) as caught:
        AnalyticsService(Config(data_dir=tmp_path, analytics_module=name), PreparedRepository()).execute("compare", {})
    assert caught.value.code == "ANALYTICS_UNAVAILABLE"
    assert caught.value.status_code == 503


def test_plugin_dependency_missing_is_unavailable(plugin):
    def analyze(**kwargs):
        raise ModuleNotFoundError("private dependency path")
    with pytest.raises(AppError) as caught:
        plugin(analyze=analyze).execute("insights", {})
    assert caught.value.code == "ANALYTICS_UNAVAILABLE"
    assert "private" not in caught.value.message


def test_unexpected_plugin_exception_is_sanitized(plugin):
    def analyze(**kwargs):
        raise RuntimeError("secret database password")
    with pytest.raises(AppError) as caught:
        plugin(analyze=analyze).execute("insights", {})
    assert (caught.value.code, caught.value.status_code) == ("ANALYTICS_FAILED", 500)
    assert "password" not in caught.value.message


def test_plugin_declared_error_is_preserved(plugin):
    expected = AppError("INSUFFICIENT_COVERAGE", "No common period", 422, {"metric": "rainfall"})
    def analyze(**kwargs):
        raise expected
    with pytest.raises(AppError) as caught:
        plugin(analyze=analyze).execute("compare", {})
    assert caught.value is expected


@pytest.mark.parametrize("nested", [False, True])
def test_unregistered_source_id_is_rejected(plugin, nested):
    service = plugin(data=[insight(source_ids=["invented-source"])] if nested else [insight()],
                     meta=metadata(source_ids=["test-source"] if nested else ["invented-source"]))
    with pytest.raises(AppError) as caught:
        service.execute("insights", {})
    assert (caught.value.code, caught.value.status_code) == ("ANALYTICS_FAILED", 500)


@pytest.mark.parametrize("data,meta,status", [
    ([], metadata(), "ok"),
    ([{"title": "Missing evidence fields"}], metadata(), "ok"),
    ([insight(extra_field="forbidden")], metadata(), "ok"),
    ([insight()], metadata(observation_count=0), "no_data"),
    ([], metadata(observation_count=1), "no_data"),
])
def test_invalid_plugin_envelopes_rejected(plugin, data, meta, status):
    with pytest.raises(AppError) as caught:
        plugin(data=data, meta=meta, status=status).execute("insights", {})
    assert caught.value.code == "ANALYTICS_FAILED"


def test_list_operation_no_data_remains_explicit(plugin):
    result = plugin(data=[], meta=metadata(observation_count=0), status="no_data").execute("insights", {})
    assert result.status == "no_data"
    assert result.data == []
    assert result.meta.observation_count == 0


def test_compare_retains_only_supplied_differences(plugin):
    supplied = comparison()
    result = plugin(data=supplied).execute("compare", {
        "state_a": "TS", "state_b": "OTHER", "metric": "rainfall", "start_year": 2019, "end_year": 2020,
    })
    assert result.data["series"] == supplied["series"]
    assert result.data["absolute_difference"] is None
    assert result.data["percentage_difference"] is None


@pytest.mark.parametrize("changes,parameters", [
    ({"state_a": "WRONG"}, {"state_a": "TS"}),
    ({"state_b": "WRONG"}, {"state_b": "OTHER"}),
    ({"metric": "floods"}, {"metric": "rainfall"}),
    ({"unit": "metres"}, {}),
    ({"period": {"start": "2000", "end": "2020"}}, {}),
    ({}, {"start_year": 2020}),
    ({}, {"end_year": 2018}),
])
def test_wrong_comparison_selection_is_rejected(plugin, changes, parameters):
    with pytest.raises(AppError) as caught:
        plugin(data=comparison(**changes)).execute("compare", parameters)
    assert caught.value.code == "ANALYTICS_FAILED"


def test_unpaired_comparison_returns_no_data_not_zero(plugin):
    value = comparison(series=[{"year": 2019, "state_a": 100, "state_b": None}])
    result = plugin(data=value).execute("compare", {})
    assert result.status == "no_data"
    assert result.data is None
    assert result.meta.observation_count == 0
    assert "paired-year" in result.meta.limitations[-1]


def test_zero_baseline_does_not_accept_percentage(plugin):
    value = comparison(series=[{"year": 2019, "state_a": 0, "state_b": 10, "percentage_difference": 100}])
    with pytest.raises(AppError) as caught:
        plugin(data=value).execute("compare", {})
    assert caught.value.code == "ANALYTICS_FAILED"
    value["series"][0]["percentage_difference"] = None
    result = plugin(data=value).execute("compare", {})
    assert result.data["series"][0]["state_a"] == 0
    assert result.data["series"][0]["percentage_difference"] is None


def test_relationship_source_and_timestamp_validation(plugin):
    relationship = {
        "id": "test-relationship", "title": "Synthetic relationship", "description": "Not causation",
        "hazards": ["floods", "landslides"], "region": "Test State", "state_ids": ["TS"],
        "period": {"start": "2019", "end": "2020"}, "observations": [{
            "hazard": "floods", "event_id": "test-event", "year": 2019,
            "timestamp": "2019-06-01T00:00:00Z", "longitude": 85, "latitude": 20,
        }], "source_ids": ["test-source"], "method": None, "observation_count": 1, "limitations": [],
    }
    assert plugin(data=[relationship]).execute("multi_hazard", {}).data[0]["method"] is None
    relationship["observations"][0]["timestamp"] = "2020-06-01T00:00:00Z"
    with pytest.raises(AppError) as caught:
        plugin(data=[relationship]).execute("multi_hazard", {})
    assert caught.value.code == "ANALYTICS_FAILED"


def unavailable_analytics(tmp_path, repository):
    return AnalyticsService(Config(data_dir=tmp_path, analytics_module=None), repository)


def test_report_pdf_contains_actual_scoped_rows_sources_and_limitations(tmp_path):
    repository = PreparedRepository({
        "rainfall": [
            {"state_id": "TS", "year": 2019, "value": 123.45},
            {"state_id": "OTHER", "year": 2019, "value": 987654.0},
            {"state_id": "TS", "year": 2018, "value": 888888.0},
        ],
        "floods": [{"event_id": "ACTUAL-TEST-EVENT", "state_id": "TS", "year": None,
                    "timestamp": "2019-07-01T12:00:00Z", "longitude": 85, "latitude": 20,
                    "attributes": {"description": "Recorded <event> & original attributes"}}],
    })
    pdf = ReportService(repository, unavailable_analytics(tmp_path, repository)).generate("TS", 2019, 2020)
    assert pdf.startswith(b"%PDF-")
    reader = PdfReader(BytesIO(pdf))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages) >= 4
    for expected in ("ClimateLens", "Test <State> & Coast", "2019", "123.45", "mm",
                     "ACTUAL-TEST-EVENT", "Recorded <event> & original attributes",
                     "test-source", "https://example.test/prepared", "Prepared values; no calculation here",
                     "Synthetic test-only coverage", "ANALYTICS_UNAVAILABLE", "landslides"):
        assert expected in text
    assert "987654" not in text
    assert "888888" not in text
    assert "Average rainfall" not in text


@pytest.mark.parametrize("datasets", [{}, {"rainfall": []}, {
    "rainfall": [{"state_id": "OTHER", "year": 2019, "value": 1}],
}])
def test_report_without_observations_or_insights_is_unavailable(tmp_path, datasets):
    repository = PreparedRepository(datasets)
    with pytest.raises(AppError) as caught:
        ReportService(repository, unavailable_analytics(tmp_path, repository)).generate("TS", 2019, 2020)
    assert (caught.value.code, caught.value.status_code) == ("REPORT_UNAVAILABLE", 503)


def test_report_validates_selected_state_before_generation(tmp_path):
    repository = PreparedRepository()
    with pytest.raises(AppError) as caught:
        ReportService(repository, unavailable_analytics(tmp_path, repository)).generate("UNKNOWN", 2019, 2020)
    assert caught.value.status_code == 404


def test_supplied_insights_can_support_report_without_observations(plugin):
    analytics = plugin()
    pdf = ReportService(analytics.repository, analytics).generate("TS", 2019, 2020)
    text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(pdf)).pages)
    assert "Supplied test finding" in text
    assert "Supplied test-only method" in text
    assert "123.45" in text
    assert "Synthetic insight limitation" in text


def test_no_data_plugin_cannot_create_blank_report(plugin):
    analytics = plugin(data=[], meta=metadata(observation_count=0), status="no_data")
    with pytest.raises(AppError) as caught:
        ReportService(analytics.repository, analytics).generate("TS", 2019, 2020)
    assert caught.value.code == "REPORT_UNAVAILABLE"
