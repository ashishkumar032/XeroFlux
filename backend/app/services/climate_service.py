from datetime import datetime
from app.core.errors import AppError
from app.models import Envelope, Period


class ClimateService:
    """Filter prepared observations; do not derive or aggregate climate values."""
    def __init__(self, repository):
        self.repository = repository

    def validate_state(self, state_id: str):
        states = self.repository.states().data
        if not any(state['state_id'] == state_id for state in states):
            raise AppError('STATE_NOT_FOUND', 'State ID is not present in the verified catalog.', 404)

    def select(self, name, *, state_id=None, start_year=None, end_year=None, year=None, region=None, storm_id=None, limit=None, offset=0, valid_coordinates=False, observation_date=None):
        if state_id is not None:
            self.validate_state(state_id)
        rows, meta = self.repository.records(name)
        if state_id is not None:
            rows = [row for row in rows if row.get('state_id') == state_id]
        if year is not None:
            rows = [row for row in rows if row.get('year') == year]
        if observation_date is not None:
            rows = [row for row in rows if row.get('date') == observation_date]
        if start_year is not None:
            rows = [row for row in rows if row.get('year') is not None and start_year <= row['year'] <= end_year]
        if region is not None:
            rows = [row for row in rows if row.get('region') == region]
        if storm_id is not None:
            rows = [row for row in rows if row.get('storm_id') == storm_id]
        if valid_coordinates:
            rows = [row for row in rows if row.get('longitude') is not None and row.get('latitude') is not None]
        if name == 'tracks':
            rows = sorted(rows, key=lambda row: datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00')))
        else:
            rows = sorted(rows, key=lambda row: (row.get('year') or 0, row.get('date') or '', row.get('month') or 0, row.get('event_id', ''), row.get('storm_id', ''), row.get('state_id', '')))
        total = len(rows)
        if limit is not None:
            rows = rows[offset:offset + limit]
        dates = [row.get('timestamp') or row.get('date') for row in rows if row.get('timestamp') or row.get('date')]
        years = [str(row['year']) for row in rows if row.get('year') is not None]
        labels = dates or years
        period = Period(start=min(labels), end=max(labels)) if labels else Period()
        meta = meta.model_copy(update={'observation_count': len(rows), 'period': period})
        data = {'items': rows, 'total': total, 'limit': limit, 'offset': offset} if limit is not None else rows
        return Envelope(status='ok' if rows else 'no_data', data=data, meta=meta)

    def rainfall_map(self, year, observation_date=None):
        if observation_date is not None and observation_date.year != year:
            raise AppError('INVALID_PERIOD', 'observation_date must fall in the selected year.', 422)
        result = self.select('rainfall', year=year, observation_date=observation_date.isoformat() if observation_date else None)
        identifiers = [row['state_id'] for row in result.data]
        if len(set(identifiers)) != len(identifiers):
            raise AppError('OBSERVATION_DATE_REQUIRED', 'Multiple source dates exist per state. Select observation_date; annual totals are not inferred.', 422)
        return result

    def track(self, storm_id):
        storms, _ = self.repository.records('cyclones')
        if not any(storm['storm_id'] == storm_id for storm in storms):
            raise AppError('STORM_NOT_FOUND', 'Storm ID is not present in the verified catalog.', 404)
        return self.select('tracks', storm_id=storm_id)
