"""Opt-in integration tests against locally prepared real source records, no mocks.

Set CLIMATELENS_REAL_DATA_TESTS=1 after running both preparation CLIs.
Absent required assets fail this opt-in run; they never substitute synthetic data.
"""
import os
from io import BytesIO
from datetime import datetime
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from app.main import create_app
from app.core.config import Config
from app.repositories.dataset_repository import DatasetRepository

pytestmark = pytest.mark.skipif(os.getenv('CLIMATELENS_REAL_DATA_TESTS') != '1', reason='Explicit opt-in required for local real-source assets')

@pytest.fixture(scope='module')
def actual():
    config = Config()
    repository = DatasetRepository(config.data_dir)
    with TestClient(create_app(config)) as client:
        yield repository, client


def test_actual_official_geometry_joins_only_verified_catalog_ids(actual):
    repository, client = actual
    state_ids = {row['state_id'] for row in repository.states().data}
    response = client.get('/api/v1/boundaries')
    assert response.status_code == 200
    features = response.json()['data']['features']
    assert {feature['properties']['state_id'] for feature in features} == state_ids
    assert response.headers['cache-control'] == 'public, max-age=300'
    assert response.json()['meta']['source_ids'] == ['nwic_boundaries']


def test_actual_cyclone_track_preserves_chronological_source_observations(actual):
    repository, client = actual
    storms, _ = repository.records('cyclones')
    selected = next((storm for storm in storms if storm['name'].strip().upper() == 'FANI' and storm['year'] == 2019), storms[0])
    response = client.get('/api/v1/cyclones/'+selected['storm_id']+'/track')
    assert response.status_code == 200
    points = response.json()['data']
    timestamps = [datetime.fromisoformat(point['timestamp'].replace('Z', '+00:00')) for point in points]
    assert timestamps == sorted(timestamps)
    assert all(point['storm_id'] == selected['storm_id'] for point in points)
    assert all(point['wind'] is None or point['wind_unit'] == 'kts' for point in points)
    assert all(-180 <= point['longitude'] <= 180 and -90 <= point['latitude'] <= 90 for point in points)
    assert response.json()['meta']['observation_count'] == len(points)


def test_actual_nielytics_event_count_and_pdf_match_selected_evidence(actual):
    repository, client = actual
    states = repository.states().data
    selected = next(row for row in states if row['name'].lower() == 'karnataka')
    parameters = dict(state_id=selected['state_id'], start_year=2007, end_year=2023)
    expected = 0
    for dataset in ('floods', 'landslides'):
        rows, _ = repository.records(dataset)
        expected += sum(row['state_id'] == selected['state_id'] and row['year'] is not None and 2007 <= row['year'] <= 2023 for row in rows)
    response = client.get('/api/v1/insights', params=parameters)
    assert response.status_code == 200
    insight = response.json()['data'][0]
    assert insight['computed_value'] == expected
    assert 'InsightEngine.generate_insights' in insight['method']
    assert set(insight['source_ids']).issubset({source['id'] for source in repository.sources().data})
    report = client.get('/api/v1/reports/state/'+selected['state_id'], params={'start_year':2007,'end_year':2023,'format':'pdf'})
    assert report.status_code == 200 and report.headers['content-type'] == 'application/pdf'
    text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(report.content)).pages)
    assert selected['name'] in text
    assert all(source_id in text for source_id in insight['source_ids'])
