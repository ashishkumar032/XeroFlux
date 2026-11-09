"""Explicit, optional backend analytics plugin boundary.

This is ClimateLens's new integration protocol, NOT a claimed NIElytics API:
CLIMATELENS_ANALYTICS_MODULE names one importable module exposing
``analyze(*, operation, parameters, repository) -> dict``. The dict must conform
to app.models.Envelope, including authentic method/limitations and registered
source IDs. Supported operations are compare, insights and multi_hazard.
For ok results, data is ComparisonResult, list[Insight], or
list[MultiHazardRelationship], respectively; lists must be nonempty.
For no_data, data is null for compare and [] for list operations, and
meta.observation_count is zero. No method is generated when one is absent.
No discovery, default module, or local scientific calculation is performed.
"""

import importlib
import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.errors import AppError
from app.services.analytics_models import ComparisonResult, Insight, MultiHazardRelationship
from app.models import Envelope

if TYPE_CHECKING:
    from app.repositories.dataset_repository import DatasetRepository


class AnalyticsService:
    OPERATIONS = frozenset({"compare", "insights", "multi_hazard"})

    def __init__(self, config: Config, repository: "DatasetRepository"):
        self.config = config
        self.repository = repository

    def execute(self, operation: str, parameters: dict) -> Envelope:
        if operation not in self.OPERATIONS:
            raise AppError("INVALID_ANALYTICS_OPERATION", "Unsupported analytics operation.", 400)
        if not self.config.analytics_module:
            raise self._unavailable()
        try:
            module = importlib.import_module(self.config.analytics_module)
            analyze = getattr(module, "analyze", None)
            if not callable(analyze):
                raise self._unavailable()
            result = analyze(operation=operation, parameters=parameters, repository=self.repository)
            if not isinstance(result, dict):
                raise ValueError("Plugin result must be an envelope dictionary")
            envelope = Envelope.model_validate(result)
            if envelope.status == "no_data":
                empty_data = envelope.data is None if operation == "compare" else envelope.data == []
                if not empty_data or envelope.meta.observation_count != 0:
                    raise ValueError("no_data requires empty data and zero observations")
            elif operation == "compare":
                comparison = ComparisonResult.model_validate(envelope.data)
                self._validate_comparison(comparison, envelope, parameters)
                if any(point.state_a is None or point.state_b is None for point in comparison.series):
                    envelope.status = "no_data"
                    envelope.data = None
                    envelope.meta = envelope.meta.model_copy(update={
                        "observation_count": 0,
                        "limitations": [
                            *envelope.meta.limitations,
                            "No valid paired-year comparison: the plugin returned missing state observations.",
                        ],
                    })
                else:
                    envelope.data = comparison.model_dump(mode="json")
            else:
                if not isinstance(envelope.data, list) or not envelope.data:
                    raise ValueError("ok analytics requires nonempty data")
                item_type = Insight if operation == "insights" else MultiHazardRelationship
                envelope.data = [item_type.model_validate(item).model_dump(mode="json") for item in envelope.data]
            json.dumps(envelope.model_dump(mode="json"), allow_nan=False)
            sources = self.repository.sources()
            known_ids = {
                source["id"] if isinstance(source, Mapping) else source.id
                for source in sources.data
            }
            declared_ids = set(envelope.meta.source_ids)
            declared_ids.update(self._source_ids(envelope.data))
            if not declared_ids.issubset(known_ids):
                raise AppError(
                    "ANALYTICS_FAILED",
                    "Analytics returned source references absent from the source catalog.",
                    500,
                )
            return envelope
        except AppError:
            raise
        except ImportError:
            raise self._unavailable() from None
        except Exception:
            raise AppError("ANALYTICS_FAILED", "The configured analytics service failed.", 500) from None

    @staticmethod
    def _validate_comparison(result: ComparisonResult, envelope: Envelope, parameters: dict) -> None:
        for field in ("state_a", "state_b", "metric"):
            if field in parameters and getattr(result, field) != parameters[field]:
                raise ValueError("Comparison does not match requested selection")
        if result.state_a == result.state_b:
            raise ValueError("Comparison requires distinct states")
        if result.unit != envelope.meta.unit or result.period != envelope.meta.period:
            raise ValueError("Comparison and envelope metadata disagree")
        for point in result.series:
            if "start_year" in parameters and point.year < parameters["start_year"]:
                raise ValueError("Comparison precedes requested period")
            if "end_year" in parameters and point.year > parameters["end_year"]:
                raise ValueError("Comparison exceeds requested period")
            if point.percentage_difference is not None and point.state_a in (None, 0):
                raise ValueError("Percentage difference requires a nonzero state_a baseline")
        if result.percentage_difference is not None and result.state_a_value in (None, 0):
            raise ValueError("Percentage difference requires a nonzero state_a baseline")

    @staticmethod
    def _unavailable() -> AppError:
        return AppError(
            "ANALYTICS_UNAVAILABLE",
            "An analytics plugin and its dependencies must be explicitly configured and available.",
            503,
        )

    @classmethod
    def _source_ids(cls, value: Any) -> set[str]:
        """Check source references in result items as well as envelope metadata."""
        found: set[str] = set()
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "source_id":
                    if not isinstance(child, str):
                        raise ValueError("Invalid source_id")
                    found.add(child)
                elif key == "source_ids":
                    if not isinstance(child, list) or any(not isinstance(item, str) for item in child):
                        raise ValueError("Invalid source_ids")
                    found.update(child)
                else:
                    found.update(cls._source_ids(child))
        elif isinstance(value, list):
            for child in value:
                found.update(cls._source_ids(child))
        return found
