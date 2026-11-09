import logging
from datetime import date
from typing import Annotated, Generic, TypeVar, Literal
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from app.core.config import Config
from app.core.errors import AppError
from app.models import (Metadata, ErrorResponse, Health, Source, StateRecord, RainfallRecord, DroughtRecord, TemperatureRecord, EventRecord, StormRecord, TrackRecord)
from app.repositories.dataset_repository import DatasetRepository
from app.services.climate_service import ClimateService
from app.services.analytics_service import AnalyticsService
from app.services.reports_service import ReportService
from app.services.analytics_models import Insight, ComparisonResult, MultiHazardRelationship
from app.services.assistant_service import AssistantService

logger = logging.getLogger('uvicorn.error')
T = TypeVar('T')
class Result(BaseModel, Generic[T]):
    status: Literal['ok', 'no_data']
    data: T
    meta: Metadata
class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
class Capabilities(BaseModel):
    available_datasets: list[str] = Field(default_factory=list)
    comparison_metrics: list[str] = Field(default_factory=list)
    rainfall_observation_dates: list[str] = Field(default_factory=list)
    available_years: dict[str, list[int]] = Field(default_factory=dict)
    available_hazards: list[str] = Field(default_factory=list)
    observed_replay: list[str] = Field(default_factory=list)
    boundaries: bool = False
    omitted_datasets: dict[str, str] = Field(default_factory=dict)
class Catalog(BaseModel):
    processed_at: str
    capabilities: Capabilities
    datasets: dict[str, Metadata]
Coordinate = Annotated[list[float], Field(min_length=2, max_length=3)]
class PolygonGeometry(BaseModel):
    type: Literal['Polygon']
    coordinates: list[list[Coordinate]]
class MultiPolygonGeometry(BaseModel):
    type: Literal['MultiPolygon']
    coordinates: list[list[list[Coordinate]]]
class BoundaryProperties(BaseModel):
    state_id: str
    name: str
class BoundaryFeature(BaseModel):
    type: Literal['Feature']
    properties: BoundaryProperties
    geometry: PolygonGeometry | MultiPolygonGeometry
class GeometryCollection(BaseModel):
    type: Literal['FeatureCollection']
    features: list[BoundaryFeature]
    crs: dict | None = None

class AssistantQueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    context: dict | None = None
class AssistantQueryResponse(BaseModel):
    answer: str
    sources: list[str] = Field(default_factory=list)
    links: list[dict] = Field(default_factory=list)
    provider: str
Year = Annotated[int, Query(ge=1800, le=date.today().year)]
StateID = Annotated[str, Query(min_length=1, max_length=100)]

def create_app(config: Config | None = None) -> FastAPI:
    config = config or Config()
    repository = DatasetRepository(config.data_dir)
    climate = ClimateService(repository)
    analytics = AnalyticsService(config, repository)
    reports = ReportService(repository, analytics)
    assistant = AssistantService(config, climate, repository)

    @asynccontextmanager
    async def lifespan(app):
        logger.info('ClimateLens starting; prepared data directory: %s. No downloads or workbook ingestion.', config.data_dir)
        yield
    app = FastAPI(title='ClimateLens India API', version='1.0.0', description='Historical observations only. Missing dependencies return explicit 503 errors; no fabricated fallback data. Analytics requires an explicitly configured science adapter.', lifespan=lifespan)
    app.state.repository = repository
    app.state.analytics = analytics
    app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins, allow_methods=['GET', 'POST'], allow_headers=['Accept', 'Content-Type'], expose_headers=['Content-Disposition'])
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    @app.exception_handler(AppError)
    async def known_error(request, exc):
        return JSONResponse(status_code=exc.status_code, content={'error': {'code': exc.code, 'message': exc.message, 'details': exc.details}})
    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        return JSONResponse(status_code=422, content={'error': {'code': 'INVALID_REQUEST', 'message': 'Query or path parameters are invalid.', 'details': {'issues': [{'location': list(e['loc']), 'message': e['msg']} for e in exc.errors()]}}})
    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        logger.exception('Unhandled API failure', exc_info=exc)
        return JSONResponse(status_code=500, content={'error': {'code': 'INTERNAL_ERROR', 'message': 'An internal error occurred. No fallback values were substituted.', 'details': {}}})

    errors = {code: {'model': ErrorResponse} for code in [404,422,500,503]}
    def period(start_year, end_year):
        if (start_year is None) != (end_year is None) or (start_year is not None and start_year > end_year):
            raise AppError('INVALID_PERIOD', 'Supply both start_year and end_year in chronological order, or omit both.', 422)
    prefix = '/api/v1'

    @app.get(prefix+'/health', response_model=Health)
    def health():
        try:
            repository.metadata()
            ready = True
        except AppError:
            ready = False
        return Health(data_ready=ready, analytics_configured=bool(config.analytics_module), limitations=[] if ready else ['Prepared data manifest is absent or invalid. Scientific endpoints are unavailable.'])

    @app.get(prefix+'/metadata', response_model=Result[Catalog], responses=errors)
    def metadata():
        return repository.metadata()
    @app.get(prefix+'/sources', response_model=Result[list[Source]], responses=errors)
    def sources():
        return repository.sources()
    @app.get(prefix+'/states', response_model=Result[list[StateRecord]], responses=errors)
    def states():
        return repository.states()
    @app.get(prefix+'/boundaries', response_model=Result[GeometryCollection], responses=errors)
    def boundaries(response: Response):
        result = repository.boundaries()
        response.headers['Cache-Control'] = 'public, max-age=300'
        return result
    @app.get(prefix+'/map/rainfall', response_model=Result[list[RainfallRecord]], responses=errors)
    def rainfall_map(year: Year, observation_date: date | None = None):
        return climate.rainfall_map(year, observation_date)
    @app.get(prefix+'/trends/rainfall', response_model=Result[list[RainfallRecord]], responses=errors)
    def rainfall(state_id: StateID, start_year: Year | None = None, end_year: Year | None = None):
        period(start_year,end_year)
        return climate.select('rainfall',state_id=state_id,start_year=start_year,end_year=end_year)
    @app.get(prefix+'/trends/drought', response_model=Result[list[DroughtRecord]], responses=errors)
    def drought(start_year: Year | None = None, end_year: Year | None = None):
        period(start_year,end_year)
        return climate.select('drought',start_year=start_year,end_year=end_year)
    @app.get(prefix+'/trends/temperature', response_model=Result[list[TemperatureRecord]], responses=errors)
    def temperature(region: Annotated[str, Query(min_length=1,max_length=100)], start_year: Year | None = None, end_year: Year | None = None):
        period(start_year,end_year)
        return climate.select('temperature',region=region,start_year=start_year,end_year=end_year)

    def event_query(name,state_id,year,limit,offset,valid_coordinates):
        return climate.select(name,state_id=state_id,year=year,limit=limit,offset=offset,valid_coordinates=valid_coordinates)
    @app.get(prefix+'/events/floods', response_model=Result[Page[EventRecord]], responses=errors)
    def floods(state_id: StateID | None = None, year: Year | None = None, limit: int = Query(100,ge=1,le=500), offset: int = Query(0,ge=0), valid_coordinates: bool = False):
        return event_query('floods',state_id,year,limit,offset,valid_coordinates)
    @app.get(prefix+'/events/landslides', response_model=Result[Page[EventRecord]], responses=errors)
    def landslides(state_id: StateID | None = None, year: Year | None = None, limit: int = Query(100,ge=1,le=500), offset: int = Query(0,ge=0), valid_coordinates: bool = False):
        return event_query('landslides',state_id,year,limit,offset,valid_coordinates)
    @app.get(prefix+'/cyclones', response_model=Result[Page[StormRecord]], responses=errors)
    def cyclones(year: Year | None = None, limit: int = Query(100,ge=1,le=500), offset: int = Query(0,ge=0)):
        return climate.select('cyclones',year=year,limit=limit,offset=offset)
    @app.get(prefix+'/cyclones/{storm_id}/track', response_model=Result[list[TrackRecord]], responses=errors)
    def track(storm_id: str):
        return climate.track(storm_id)
    @app.get(prefix+'/compare', response_model=Result[ComparisonResult | None], responses=errors)
    def compare(state_a: StateID,state_b: StateID, metric: Annotated[str,Query(min_length=1,max_length=100)],start_year: Year,end_year: Year):
        period(start_year,end_year)
        if state_a == state_b:
            raise AppError('INVALID_COMPARISON','Select two distinct states.',422)
        climate.validate_state(state_a)
        climate.validate_state(state_b)
        capabilities = repository.metadata().data['capabilities']
        if metric not in capabilities.get('comparison_metrics', []) or metric not in ['rainfall_annual_total','rainfall_anomaly','flood_event_count','landslide_event_count']:
            raise AppError('UNSUPPORTED_METRIC','Metric is not declared comparable by the prepared data manifest.',422)
        return analytics.execute('compare',dict(state_a=state_a,state_b=state_b,metric=metric,start_year=start_year,end_year=end_year))
    @app.get(prefix+'/insights', response_model=Result[list[Insight]], responses=errors)
    def insights(state_id: StateID,start_year: Year | None = None,end_year: Year | None = None):
        period(start_year,end_year)
        climate.validate_state(state_id)
        return analytics.execute('insights',dict(state_id=state_id,start_year=start_year,end_year=end_year))
    @app.get(prefix+'/multi-hazard', response_model=Result[list[MultiHazardRelationship]], responses=errors)
    def multi_hazard(state_id: StateID,start_year: Year | None = None,end_year: Year | None = None):
        period(start_year,end_year)
        climate.validate_state(state_id)
        return analytics.execute('multi_hazard',dict(state_id=state_id,start_year=start_year,end_year=end_year))
    @app.get(prefix+'/reports/state/{state_id}', responses={**errors,200:{'content':{'application/pdf':{'schema':{'type':'string','format':'binary'}}},'description':'Observed evidence PDF'}}, response_class=Response)
    def report(state_id: str,start_year: Year,end_year: Year,format: Literal['pdf']='pdf'):
        period(start_year,end_year)
        content = reports.generate(state_id,start_year,end_year)
        return Response(content,media_type='application/pdf',headers={'Content-Disposition':f'attachment; filename="climatelens-{start_year}-{end_year}.pdf"','Cache-Control':'no-store'})
    @app.post(prefix+'/assistant', response_model=AssistantQueryResponse)
    def assistant_query(body: AssistantQueryRequest):
        res = assistant.query(body.query, body.context)
        return AssistantQueryResponse(**res)
    return app

app = create_app()
