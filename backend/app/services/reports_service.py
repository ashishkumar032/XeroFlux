"""Render prepared observations and optional plugin evidence, never new statistics."""

import json
from collections.abc import Mapping
from datetime import datetime, timezone
from io import BytesIO
from typing import TYPE_CHECKING
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

from app.core.errors import AppError
from app.models import Metadata
from app.services.analytics_service import AnalyticsService

if TYPE_CHECKING:
    from app.repositories.dataset_repository import DatasetRepository


class ReportService:
    def __init__(self, repository: "DatasetRepository", analytics: AnalyticsService):
        self.repository = repository
        self.analytics = analytics

    def generate(self, state_id: str, start_year: int, end_year: int) -> bytes:
        states = [self._mapping(state) for state in self.repository.states().data]
        state = next((item for item in states if item["state_id"] == state_id), None)
        if state is None:
            raise AppError("STATE_NOT_FOUND", "The selected state is not in the prepared state catalog.", 404)

        sections: list[tuple[str, list[dict], Metadata]] = []
        notes: list[str] = []
        for name in ("rainfall", "floods", "landslides"):
            try:
                records, meta = self.repository.records(name)
            except AppError as exc:
                if exc.code != "DATASET_UNAVAILABLE":
                    raise
                notes.append(f"{name}: prepared dataset unavailable; no observations substituted.")
                continue
            selected = [
                row for row in records
                if row.get("state_id") == state_id
                and self._in_period(row, start_year, end_year)
            ]
            if selected:
                sections.append((name, selected, meta))
            else:
                notes.append(f"{name}: no prepared observations for the selected state and years.")

        insights = None
        try:
            result = self.analytics.execute(
                "insights", {"state_id": state_id, "start_year": start_year, "end_year": end_year}
            )
            if result.status == "ok" and result.data:
                insights = result
            else:
                notes.append("NIElytics insights: no evidence returned for this selection.")
        except AppError as exc:
            notes.append(f"NIElytics insights unavailable ({exc.code}): {exc.message}")

        if not sections and insights is None:
            raise AppError(
                "REPORT_UNAVAILABLE",
                "No prepared observations or supplied insights are available for this state and period.",
                503,
            )

        source_ids = {source_id for _, _, meta in sections for source_id in meta.source_ids}
        if insights is not None:
            source_ids.update(insights.meta.source_ids)
            for insight in insights.data:
                source_ids.update(insight["source_ids"])
        source_catalog = {
            source["id"]: source
            for source in (self._mapping(item) for item in self.repository.sources().data)
        }
        if not source_ids.issubset(source_catalog):
            raise AppError("REPORT_UNAVAILABLE", "Report evidence references unavailable source metadata.", 503)

        buffer = BytesIO()
        document = SimpleDocTemplate(
            buffer, pagesize=A4, rightMargin=42, leftMargin=42,
            topMargin=46, bottomMargin=46,
            title=f"ClimateLens - {state['name']} - {start_year}-{end_year}",
            author="ClimateLens",
        )
        styles = getSampleStyleSheet()
        story = []

        def paragraph(text, style="BodyText"):
            story.append(Paragraph(escape(str(text)).replace("\n", "<br/>"), styles[style]))
            story.append(Spacer(1, 6))

        def metadata(meta: Metadata):
            paragraph(f"Metric: {meta.metric}; unit: {meta.unit if meta.unit is not None else 'Not provided'}")
            paragraph(f"Geographic level: {meta.geographic_level}; time resolution: {meta.time_resolution}")
            paragraph(f"Prepared coverage: {meta.period.start or 'Not provided'} to {meta.period.end or 'Not provided'}")
            paragraph(f"Prepared dataset observation count (not a selection total): {meta.observation_count}")
            paragraph(f"Source IDs: {', '.join(meta.source_ids) or 'Not provided'}")
            paragraph(f"Method: {meta.method if meta.method is not None else 'Calculation details not provided'}")
            for limitation in meta.limitations:
                paragraph(f"Limitation: {limitation}")

        paragraph("ClimateLens India", "Title")
        paragraph("Historical evidence report | Powered by NIElytics", "Heading2")
        paragraph(f"State: {state['name']} ({state_id})")
        paragraph(f"Selected period: {start_year} to {end_year}")
        paragraph(f"Generated: {datetime.now(timezone.utc).date().isoformat()} (UTC)")
        paragraph(
            "This report reproduces prepared observations and available configured-plugin findings. "
            "It does not calculate new statistics, interpolate missing records, forecast future conditions, "
            "or provide official alerts. Missing observations are not zero."
        )
        for note in notes:
            paragraph(note)

        for name, rows, meta in sections:
            story.append(PageBreak())
            paragraph(f"Prepared {name} observations", "Heading1")
            metadata(meta)
            for row in rows:
                if name == "rainfall":
                    paragraph(
                        f"State: {row['state_id']} | Source period: {row.get('date') or row['year']} | "
                        f"Value: {row['value']} | Unit: {meta.unit if meta.unit is not None else 'Not provided'}"
                    )
                else:
                    # Render original fields, including attributes, without counting or deriving statistics.
                    paragraph(json.dumps(row, ensure_ascii=True, sort_keys=True, allow_nan=False))

        if insights is not None:
            story.append(PageBreak())
            paragraph("Supplied NIElytics evidence", "Heading1")
            metadata(insights.meta)
            for insight in insights.data:
                paragraph(insight["title"], "Heading2")
                paragraph(insight["description"])
                paragraph(f"Region: {insight['region']}")
                paragraph(f"Geographic resolution: {insight['geographic_resolution']}")
                paragraph(f"Supplied computed value: {insight['computed_value']} | Unit: {insight['unit'] if insight['unit'] is not None else 'Not provided'}")
                paragraph(f"Declared insight period: {insight['period']['start']} to {insight['period']['end']}")
                paragraph(f"Supplied statistics: {json.dumps(insight['statistics'], sort_keys=True, allow_nan=False)}")
                paragraph(f"Observation count: {insight['observation_count']}")
                paragraph(f"Source IDs: {', '.join(insight['source_ids']) or 'Not provided'}")
                paragraph(f"Method: {insight['method'] if insight['method'] is not None else 'Calculation details not provided'}")
                for limitation in insight["limitations"]:
                    paragraph(f"Limitation: {limitation}")

        story.append(PageBreak())
        paragraph("Sources and provenance", "Heading1")
        if not source_ids:
            paragraph("No source references were provided with this evidence; source lineage is unavailable.")
        for source_id in sorted(source_ids):
            source = source_catalog[source_id]
            paragraph(f"{source_id}: {source['name']}", "Heading2")
            paragraph(f"Provider: {source['provider']}")
            paragraph(f"URL: {source.get('url') or 'Not provided'}")
            paragraph(f"Coverage: {source['geographic_coverage']}; {source['temporal_coverage']}")
            paragraph(f"Format: {source['data_format']}; purpose: {source['purpose']}")
            paragraph(f"Provenance status: {source['provenance_status']}")
            for limitation in source["limitations"]:
                paragraph(f"Limitation: {limitation}")

        def footer(canvas, doc):
            canvas.saveState()
            canvas.setFillColor(colors.HexColor("#23374D"))
            canvas.setFont("Helvetica", 8)
            canvas.drawString(42, 25, "ClimateLens | Historical evidence only")
            canvas.drawRightString(A4[0] - 42, 25, f"Page {doc.page}")
            canvas.restoreState()

        document.build(story, onFirstPage=footer, onLaterPages=footer)
        return buffer.getvalue()

    @staticmethod
    def _mapping(value) -> dict:
        return dict(value) if isinstance(value, Mapping) else value.model_dump(mode="json")

    @staticmethod
    def _in_period(row: dict, start_year: int, end_year: int) -> bool:
        year = row.get("year")
        if year is None and row.get("timestamp"):
            try:
                year = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).year
            except (TypeError, ValueError):
                return False
        return year is not None and start_year <= year <= end_year
