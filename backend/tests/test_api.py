"""Synthetic prepared-data fixtures: never production observations."""
import json
from datetime import date
from fastapi.testclient import TestClient
from app.main import create_app
from app.core.config import Config


def prepared(tmp_path):
    source = dict(id='test_only', name='SYNTHETIC TEST ONLY', provider='Test suite', url='https://example.test/source', geographic_coverage='Test polygons only', temporal_coverage='2019', data_format='json', purpose='Isolated API tests', provenance_status='synthetic', limitations=['Not observed climate data'])
    def meta(metric, level='state', resolution='year', unit=None):
        return dict(metric=metric, unit=unit, geographic_level=level, time_resolution=resolution, period={'start':'2019','end':'2019'},source_ids=['test_only'],method='Synthetic prepared values; no climate calculation',observation_count=0,limitations=['TEST ONLY'])
    datasets={}
    def dataset(name, rows, level='state', resolution='year', unit=None, format='json'):
        path=name+('.geojson' if format=='geojson' else '.json')
        (tmp_path/path).write_text(json.dumps(rows),encoding='utf-8')
        metadata=meta(name,level,resolution,unit)
        metadata['observation_count']=len(rows['features']) if isinstance(rows,dict) else len(rows)
        datasets[name]=dict(path=path,format=format,meta=metadata)
    dataset('states',[{'state_id':'T-A','name':'Synthetic A'},{'state_id':'T-B','name':'Synthetic B'}])
    dataset('rainfall',[{'state_id':'T-A','year':2019,'value':0},{'state_id':'T-B','year':2019,'value':12}],unit='mm')
    dataset('drought',[{'year':2019,'value':4}],'national',unit='%')
    dataset('temperature',[{'region':'Synthetic region','year':2019,'month':1,'value':25}],'regional','month','°C')
    events=[dict(event_id=str(i),state_id='T-A',year=2019,timestamp=None,longitude=80 if i==0 else None,latitude=20 if i==0 else None,attributes={'note':'SYNTHETIC'}) for i in range(3)]
    dataset('floods',events)
    dataset('landslides',events)
    dataset('cyclones',[{'storm_id':'TEST-STORM','name':'TEST ONLY','year':2019}],'basin','event')
    dataset('tracks',[dict(storm_id='TEST-STORM',timestamp=timestamp,longitude=80,latitude=20,wind=10,wind_unit='knots',pressure=None,pressure_unit=None) for timestamp in ['2019-01-02T00:00:00Z','2019-01-01T00:00:00Z']],'point','observation')
    dataset('boundaries',{'type':'FeatureCollection','features':[{'type':'Feature','properties':{'state_id':'T-A','name':'Synthetic A'},'geometry':{'type':'Polygon','coordinates':[[[80,20],[81,20],[81,21],[80,20]]]}}]},format='geojson')
    (tmp_path/'manifest.json').write_text(json.dumps(dict(version=1,processed_at='2026-01-01T00:00:00Z',metadata=meta('catalog','catalog','catalog'),sources=[source],datasets=datasets,capabilities={'comparison_metrics':[]})),encoding='utf-8')
    return TestClient(create_app(Config(data_dir=tmp_path,analytics_module=None,cors_origins=['http://localhost:5173'])))


def test_missing_files_are_unavailable_not_zero(tmp_path):
    client=TestClient(create_app(Config(data_dir=tmp_path)))
    assert client.get('/api/v1/health').json()['data_ready'] is False
    for path in ['/metadata','/sources','/states','/boundaries','/map/rainfall?year=2019']:
        response=client.get('/api/v1'+path)
        assert response.status_code==503
        assert 'data' not in response.json()
        assert response.json()['error']['code']=='DATASET_UNAVAILABLE'


def test_rainfall_zero_is_observed_and_empty_is_distinct(tmp_path):
    client=prepared(tmp_path)
    response=client.get('/api/v1/trends/rainfall?state_id=T-A&start_year=2019&end_year=2019')
    assert response.status_code==200
    assert response.json()['data'][0]['value'] == 0.0
    assert response.json()['data'][0]['state_id'] == 'T-A'
    assert response.json()['status']=='ok'
    empty=client.get('/api/v1/map/rainfall?year=2018').json()
    assert empty['status']=='no_data' and empty['data']==[]
    assert empty['meta']['observation_count']==0
    assert empty['meta']['period']=={'start':None,'end':None}


def test_input_validation_and_unknown_identifiers(tmp_path):
    client=prepared(tmp_path)
    for query in ['year=0',f'year={date.today().year+1}','year=abc']:
        assert client.get('/api/v1/map/rainfall?'+query).status_code==422
    assert client.get('/api/v1/trends/rainfall?state_id=unknown').status_code==404
    assert client.get('/api/v1/trends/drought?start_year=2020&end_year=2019').status_code==422
    assert client.get('/api/v1/trends/drought?start_year=2019').status_code==422
    assert client.get('/api/v1/compare?state_a=T-A&state_b=T-A&metric=rainfall_annual_total&start_year=2019&end_year=2019').status_code==422
    assert client.get('/api/v1/compare?state_a=T-A&state_b=T-B&metric=temperature&start_year=2019&end_year=2019').status_code==422


def test_pagination_coordinates_chronology_and_scopes(tmp_path):
    client=prepared(tmp_path)
    floods=client.get('/api/v1/events/floods?state_id=T-A&year=2019&limit=1&offset=1').json()
    assert floods['data']['total']==3 and floods['data']['items'][0]['event_id']=='1'
    landslides=client.get('/api/v1/events/landslides?valid_coordinates=true').json()
    assert [row['event_id'] for row in landslides['data']['items']]==['0']
    assert client.get('/api/v1/events/floods?limit=501').status_code==422
    track=client.get('/api/v1/cyclones/TEST-STORM/track').json()['data']
    assert [row['timestamp'] for row in track]==['2019-01-01T00:00:00Z','2019-01-02T00:00:00Z']
    assert client.get('/api/v1/cyclones/missing/track').status_code==404
    assert client.get('/api/v1/trends/drought').json()['meta']['geographic_level']=='national'
    assert client.get('/api/v1/trends/temperature?region=Synthetic%20region').json()['data'][0]['month']==1


def test_geometry_metadata_cors_and_science_dependency(tmp_path):
    client=prepared(tmp_path)
    boundaries=client.get('/api/v1/boundaries')
    assert boundaries.status_code==200
    assert boundaries.json()['data']['features'][0]['geometry']['coordinates'][0][0]==[80,20]
    assert boundaries.headers['cache-control']=='public, max-age=300'
    catalog=client.get('/api/v1/metadata').json()['data']
    assert catalog['datasets']['rainfall']['unit']=='mm'
    assert client.get('/api/v1/insights?state_id=T-A').json()['error']['code']=='ANALYTICS_UNAVAILABLE'
    assert client.get('/api/v1/multi-hazard?state_id=T-A').status_code==503
    allowed=client.get('/api/v1/health',headers={'Origin':'http://localhost:5173'})
    assert allowed.headers['access-control-allow-origin']=='http://localhost:5173'
    denied=client.get('/api/v1/health',headers={'Origin':'https://untrusted.example'})
    assert 'access-control-allow-origin' not in denied.headers


def test_pdf_contains_real_supplied_fixture_rows(tmp_path):
    from io import BytesIO
    from pypdf import PdfReader
    client=prepared(tmp_path)
    response=client.get('/api/v1/reports/state/T-A?start_year=2019&end_year=2019&format=pdf')
    assert response.status_code==200 and response.headers['content-type']=='application/pdf'
    reader=PdfReader(BytesIO(response.content))
    text='\n'.join(page.extract_text() for page in reader.pages)
    assert 'ClimateLens' in text and 'Synthetic A' in text and '2019' in text
    assert client.get('/api/v1/reports/state/T-A?start_year=2018&end_year=2018').status_code==503


def test_unexpected_error_is_sanitized(tmp_path):
    client=prepared(tmp_path)
    def broken():
        raise RuntimeError('SECRET INTERNAL DETAIL')
    client.app.state.repository.metadata=broken
    client=TestClient(client.app,raise_server_exceptions=False)
    response=client.get('/api/v1/metadata')
    assert response.status_code==500
    assert response.json()['error']['code']=='INTERNAL_ERROR'
    assert 'SECRET' not in response.text

def test_daily_rainfall_requires_a_date_for_unambiguous_map_values(tmp_path):
    client = prepared(tmp_path)
    rows = [
        {'state_id': 'T-A', 'year': 2019, 'date': '2019-01-01', 'value': 0},
        {'state_id': 'T-A', 'year': 2019, 'date': '2019-01-02', 'value': 7},
    ]
    (tmp_path / 'rainfall.json').write_text(json.dumps(rows), encoding='utf-8')
    manifest = json.loads((tmp_path / 'manifest.json').read_text(encoding='utf-8'))
    manifest['datasets']['rainfall']['meta']['time_resolution'] = 'day'
    (tmp_path / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    ambiguous = client.get('/api/v1/map/rainfall?year=2019')
    assert ambiguous.status_code == 422
    assert ambiguous.json()['error']['code'] == 'OBSERVATION_DATE_REQUIRED'
    observed = client.get('/api/v1/map/rainfall?year=2019&observation_date=2019-01-02').json()
    assert observed['data'][0]['value'] == 7
    assert observed['meta']['period'] == {'start': '2019-01-02', 'end': '2019-01-02'}
    assert client.get('/api/v1/map/rainfall?year=2019&observation_date=2018-01-01').status_code == 422
