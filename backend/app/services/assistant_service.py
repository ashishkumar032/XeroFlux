import logging
import re
from collections import Counter
from datetime import date
from typing import Any
import httpx
from app.core.config import Config
from app.core.errors import AppError

logger = logging.getLogger('uvicorn.error')

SYSTEM_PROMPT = """You are the ClimateLens India AI Assistant.
Your job is to answer user queries truthfully, grounded in real climate evidence, historical telemetry, and real-time forecasts.

STYLE & FORMATTING:
- Answer directly and concisely in the very first sentence.
- Use clean Markdown with **bold** values and structured bullet points (•).
- Never output raw Markdown URLs or link blocks like "[label](#/url)"; the web UI renders interactive buttons automatically.
- Keep tone professional, evidence-first, and informative.

WEATHER & RAIN PREDICTIONS ("Will it rain tomorrow in X", "Weather forecast for Y"):
- If LIVE WEATHER PREDICTION data is provided in the context, answer directly with that prediction in the first sentence (e.g., "No, rain is unlikely tomorrow in Karnataka with only a 6% chance of precipitation and 0.0 mm expected rainfall...").
- Detail the forecasted condition, rain probability (%), expected precipitation (mm), and temperature range.
- Connect this forecast to the ClimateLens historical rainfall trends (seasonal transitions, wet-day ratios).

HISTORICAL DISASTER & CLIMATE QUERIES ("Last flood in UP", "Cyclone records in Odisha"):
- Answer directly with the exact date, district, casualty/damage figures, and historical frequency from the DATA CONTEXT.
- State verified limitations (e.g. daily rainfall units are undeclared in source; landslide provenance is unverified; cyclone tracks are basin-wide positions).
"""

STATE_ALIASES = {
    'jammu': '01', 'kashmir': '01', 'himachal': '02', 'punjab': '03', 'chandigarh': '04', 'uttarakhand': '05',
    'haryana': '06', 'delhi': '07', 'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
    'arunachal': '12', 'arunanchal': '12', 'nagaland': '13', 'manipur': '14', 'mizoram': '15', 'tripura': '16',
    'meghalaya': '17', 'assam': '18', 'west bengal': '19', 'jharkhand': '20', 'odisha': '21', 'orissa': '21',
    'chhattisgarh': '22', 'madhya pradesh': '23', 'gujarat': '24', 'dadra': '38', 'daman': '38',
    'maharashtra': '27', 'andhra': '28', 'karnataka': '29', 'goa': '30', 'lakshadweep': '31', 'kerala': '32',
    'tamil nadu': '33', 'tamilnadu': '33', 'puducherry': '34', 'pondicherry': '34', 'andaman': '35',
    'telangana': '36', 'ladakh': '37',
}
SHORT_ALIASES = {'up': '09', 'mp': '23', 'ap': '28', 'tn': '33', 'wb': '19', 'hp': '02', 'j&k': '01', 'jk': '01', 'dl': '07'}

HAZARDS = {
    'floods': ('flood', 'inundat', 'waterlog'),
    'landslides': ('landslide', 'mudslide', 'slope'),
    'cyclones': ('cyclone', 'storm', 'hurricane', 'typhoon'),
    'rainfall': ('rain', 'monsoon', 'precipitation', 'shower', 'wet'),
}

WEATHER_TRIGGERS = [
    'rain', 'weather', 'forecast', 'tomorrow', 'predict', 'temperature', 'temp', 'humidity', 'wind', 'sunny', 'hot', 'cold', 'shower'
]

COMMON_CITIES = {
    'mysore': ('Mysore', '29'), 'mysuru': ('Mysore', '29'),
    'bangalore': ('Bengaluru', '29'), 'bengaluru': ('Bengaluru', '29'),
    'mumbai': ('Mumbai', '27'), 'pune': ('Pune', '27'), 'nagpur': ('Nagpur', '27'),
    'delhi': ('Delhi', '07'), 'new delhi': ('New Delhi', '07'),
    'kolkata': ('Kolkata', '19'), 'calcutta': ('Kolkata', '19'),
    'chennai': ('Chennai', '33'), 'madras': ('Chennai', '33'),
    'hyderabad': ('Hyderabad', '36'), 'ahmedabad': ('Ahmedabad', '24'), 'surat': ('Surat', '24'),
    'jaipur': ('Jaipur', '08'), 'lucknow': ('Lucknow', '09'), 'kanpur': ('Kanpur', '09'),
    'varanasi': ('Varanasi', '09'), 'patna': ('Patna', '10'), 'bhopal': ('Bhopal', '23'),
    'indore': ('Indore', '23'), 'chandigarh': ('Chandigarh', '04'), 'guwahati': ('Guwahati', '18'),
    'kochi': ('Kochi', '32'), 'cochin': ('Kochi', '32'),
    'thiruvananthapuram': ('Thiruvananthapuram', '32'), 'trivandrum': ('Thiruvananthapuram', '32'),
    'srinagar': ('Srinagar', '01'), 'jammu': ('Jammu', '01'), 'leh': ('Leh', '37'),
    'dehradun': ('Dehradun', '05'), 'shimla': ('Shimla', '02'), 'ranchi': ('Ranchi', '20'),
    'bhubaneswar': ('Bhubaneswar', '21'), 'raipur': ('Raipur', '22'), 'gangtok': ('Gangtok', '11'),
    'agartala': ('Agartala', '16'), 'shillong': ('Shillong', '17'), 'imphal': ('Imphal', '14'),
    'aizawl': ('Aizawl', '15'), 'kohima': ('Kohima', '13'), 'itanagar': ('Itanagar', '12'),
    'panaji': ('Panaji', '30'), 'port blair': ('Port Blair', '35'), 'kavaratti': ('Kavaratti', '31'),
    'pondicherry': ('Puducherry', '34')
}

def _resolve_location(prompt: str, state_name: str | None) -> tuple[str, str | None]:
    lower = prompt.lower()
    for city_key, (city_name, sid) in COMMON_CITIES.items():
        if re.search(rf'\b{re.escape(city_key)}\b', lower):
            return city_name, sid
    m = re.search(r'\b(?:in|at|for|around|of)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\b', prompt)
    if m:
        cand = m.group(1).strip()
        stop_words = {'the', 'tomorrow', 'today', 'next', 'this', 'a', 'an', 'our', 'forecast', 'weather', 'rain', 'prediction'}
        if cand.lower() not in stop_words and len(cand) > 2:
            return cand, None
    if state_name:
        return state_name, None
    return 'New Delhi', '07'


def _find_state(text: str, states: dict[str, str]) -> str | None:
    lower = text.lower()
    for alias, sid in STATE_ALIASES.items():
        if alias in lower:
            return sid
    for alias, sid in SHORT_ALIASES.items():
        if re.search(rf'(?<![a-z]){re.escape(alias)}(?![a-z])', lower):
            return sid
    for sid, name in states.items():
        if name.lower() in lower:
            return sid
    return None


def _event_line(event: dict) -> str:
    attrs = event.get('attributes') or {}
    when = (event.get('timestamp') or str(event.get('year') or 'date not recorded'))[:10]
    place = attrs.get('Districts') or attrs.get('Location') or attrs.get('event_title') or attrs.get('gazeteer_closest_point') or 'place not recorded'
    cause = attrs.get('Main Cause') or attrs.get('landslide_category') or ''
    extras = [f'cause: {cause}' for _ in [0] if cause]
    for label, key in (('human fatality', 'Human fatality'), ('fatalities', 'fatality_count')):
        if attrs.get(key):
            extras.append(f'{label}: {attrs[key]}')
    return f'{when} | {place}' + (f' | {"; ".join(extras)}' if extras else '')


class AssistantService:
    def __init__(self, config: Config, climate=None, repository=None):
        self.config = config
        self.climate = climate
        self.repository = repository

    def _states(self) -> dict[str, str]:
        try:
            return {s['state_id']: s['name'] for s in self.repository.states().data}
        except (AppError, AttributeError):
            return {}

    def _fetch_live_weather(self, prompt: str, state_name: str | None) -> tuple[str | None, str | None, str | None]:
        apiKey = self.config.weather_api_key or self.config.prediction_api_key
        if not apiKey:
            return None, None, None
        lower = prompt.lower()
        if not any(w in lower for w in WEATHER_TRIGGERS):
            return None, None, None

        target, inferred_sid = _resolve_location(prompt, state_name)
        url = f"https://api.weatherapi.com/v1/forecast.json?key={apiKey}&q={target}, India&days=2&aqi=no&alerts=no"
        try:
            with httpx.Client(timeout=4.0) as client:
                res = client.get(url)
                if res.status_code == 200:
                    d = res.json()
                    curr = d.get('current', {})
                    days = d.get('forecast', {}).get('forecastday', [])
                    if len(days) >= 2:
                        fc = days[1]
                        day = fc.get('day', {})
                        cond = day.get('condition', {}).get('text', 'Clear')
                        rain_pct = day.get('daily_chance_of_rain', 0)
                        precip_mm = day.get('totalprecip_mm', 0.0)
                        max_t = day.get('maxtemp_c', 0)
                        min_t = day.get('mintemp_c', 0)
                        loc_name = d.get('location', {}).get('name', target)
                        loc_region = d.get('location', {}).get('region', target)
                        summary = (
                            f"LIVE WEATHER FORECAST & PREDICTION (via live weather service for {loc_name}, {loc_region}, India):\n"
                            f"  - Tomorrow ({fc.get('date')}): Condition: \"{cond}\", Chance of rain: {rain_pct}%, Expected precipitation: {precip_mm} mm, Temperature: {min_t}°C to {max_t}°C\n"
                            f"  - Current conditions: {curr.get('temp_c')}°C, {curr.get('condition', {}).get('text')}, Humidity: {curr.get('humidity')}%, Wind: {curr.get('wind_kph')} kph"
                        )
                        return summary, loc_name, inferred_sid
        except Exception as exc:
            logger.warning("Live weather forecast request failed: %s", exc)
        return None, None, None


    def _build_context(self, prompt: str) -> tuple[str, list[str], str | None]:
        if self.climate is None:
            return 'No dataset access is configured.', [], None
        states = self._states()
        state_id = _find_state(prompt, states)
        state_name = states.get(state_id or '', None)
        lower = prompt.lower()
        wanted = [h for h, keys in HAZARDS.items() if any(k in lower for k in keys)]
        sources: list[str] = []

        # 1. Fetch live weather prediction for specific city or state
        weather_info, resolved_loc, inferred_sid = self._fetch_live_weather(prompt, state_name)
        if not state_id and inferred_sid:
            state_id = inferred_sid
            state_name = states.get(state_id, state_name)

        lines = [f'Today: {date.today().isoformat()}']
        if state_name:
            lines.append(f'State: {state_name} (id {state_id})')
        elif resolved_loc:
            lines.append(f'Location: {resolved_loc}, India')
        elif wanted:
            lines.append('No state named in the question.')

        if weather_info:
            lines.append(weather_info)
            if 'imd_rainfall' not in sources:
                sources.append('imd_rainfall')

        try:
            if ('rainfall' in wanted or weather_info) and state_id:
                res = self.climate.select('rainfall', state_id=state_id)
                rows = sorted(res.data, key=lambda r: r.get('date') or '')
                if rows:
                    if 'imd_rainfall' not in sources:
                        sources.append('imd_rainfall')
                    recent = rows[-14:]
                    wet = sum(1 for r in rows if r['value'] > 0)
                    lines.append(f'Rainfall (daily recorded values, unit not declared) {rows[0]["date"]} to {rows[-1]["date"]}, {len(rows)} days; {wet} days with value > 0 ({wet / len(rows):.0%}).')
                    lines.append('Last 14 days: ' + ', '.join(f'{r["date"]}={r["value"]:g}' for r in recent))
                    by_month = Counter(); wet_month = Counter()
                    for r in rows:
                        m = (r.get('date') or '')[:7]
                        by_month[m] += 1; wet_month[m] += r['value'] > 0
                    lines.append('Wet-day share by month: ' + ', '.join(f'{m}: {wet_month[m]}/{by_month[m]}' for m in sorted(by_month)))
            for hazard in ('floods', 'landslides'):
                if hazard in wanted and (state_id or hazard in wanted):
                    res = self.climate.select(hazard, state_id=state_id, limit=500, offset=0) if state_id else self.climate.select(hazard, limit=500, offset=0)
                    items = res.data['items']
                    if items:
                        if hazard not in sources:
                            sources.append(hazard)
                        items = sorted(items, key=lambda e: e.get('timestamp') or str(e.get('year') or ''), reverse=True)
                        lines.append(f'{hazard.title()} records{" for " + state_name if state_name else " (first 500 of catalog)"}: {res.data["total"]} total. Most recent: ')
                        lines.extend('  - ' + _event_line(e) for e in items[:5])
                        months = Counter((e.get('timestamp') or '')[5:7] for e in items if e.get('timestamp'))
                        if months:
                            lines.append('Records by calendar month (month: count): ' + ', '.join(f'{m}: {n}' for m, n in sorted(months.items())))
                        years = [e['year'] for e in items if e.get('year')]
                        if years:
                            lines.append(f'Years covered in these records: {min(years)}-{max(years)}')
                    else:
                        lines.append(f'No {hazard} records for {state_name or "this selection"}.')
            if 'cyclones' in wanted:
                year_match = re.search(r'\b(1[89]\d\d|20\d\d)\b', prompt)
                res = self.climate.select('cyclones', year=int(year_match.group(1)) if year_match else None, limit=100, offset=0)
                items = res.data['items']
                if 'cyclones' not in sources:
                    sources.append('cyclones')
                lines.append(f'Cyclone catalog: {res.data["total"]} storms{" in " + year_match.group(1) if year_match else ""}.')
                recent = sorted(items, key=lambda s: s['year'], reverse=True)[:6]
                lines.append('Sample: ' + ', '.join(f'{s["name"]} ({s["year"]})' for s in recent))
                lines.append('Cyclone positions are basin tracks and do not confirm Indian landfall.')
        except AppError as exc:
            lines.append(f'Data lookup unavailable: {exc.message}')

        if len(lines) <= 2:
            lines.append('Datasets: rainfall (2019–2026), floods and landslides (1967–2023), cyclones (1877–2023), regional heat, national drought.')
        return '\n'.join(lines), sources, state_id

    def _chat(self, url: str, key: str, model: str, prompt: str, context_text: str, route: str | None) -> str | None:
        user = f'DATA CONTEXT:\n{context_text}\n\nCurrent page: {route or "unknown"}\n\nQUESTION: {prompt}'
        payload = {'model': model, 'messages': [{'role': 'system', 'content': SYSTEM_PROMPT}, {'role': 'user', 'content': user}], 'max_tokens': 500, 'temperature': 0.2}
        try:
            with httpx.Client(timeout=15.0) as client:
                res = client.post(url, headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, json=payload)
            if res.status_code == 200:
                return res.json()['choices'][0]['message']['content']
            logger.warning('%s returned %d: %s', model, res.status_code, res.text[:200])
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            logger.warning('%s request failed: %s', model, exc)
        return None

    @staticmethod
    def _clean(text: str) -> str:
        text = re.sub(r'<think>[\s\S]*?</think>', '', text)
        text = re.sub(r'\[([^\]]*)\]\(#[^)]*\)', r'\1', text)
        text = re.sub(r'#/[\w\-/?=&%.]+', '', text)
        text = re.sub(r'\n?\s*Relevant (?:Deep )?Links:?[\s\S]*$', '', text, flags=re.I)
        return re.sub(r'\n{3,}', '\n\n', text).strip()

    @staticmethod
    def _links(prompt: str, state_id: str | None, sources: list[str]) -> list[dict[str, str]]:
        q = f'state_id={state_id}' if state_id else ''
        def href(path: str, extra: str = '') -> str:
            query = '&'.join(p for p in (extra, q) if p)
            return f'#/{path}' + (f'?{query}' if query else '')
        links: list[dict[str, str]] = []
        if 'floods' in sources:
            links.append({'label': 'Flood records in Disaster Explorer', 'href': href('explorer', 'hazard=floods')})
        if 'landslides' in sources:
            links.append({'label': 'Landslide records in Disaster Explorer', 'href': href('explorer', 'hazard=landslides')})
        if 'cyclones' in sources:
            links.append({'label': 'Cyclone Time Machine', 'href': '#/time-machine?hazard=cyclones'})
        if 'imd_rainfall' in sources:
            links.append({'label': 'Rainfall in Climate Atlas', 'href': href('overview')})
        if state_id and len(links) < 3:
            links.append({'label': 'NIElytics insights for this state', 'href': href('insights')})
        return links[:3]

    def query(self, prompt: str, context: dict | None = None) -> dict[str, Any]:
        context_text, sources, state_id = self._build_context(prompt)
        route = (context or {}).get('route')
        answer = provider = None
        if self.config.groq_api_key:
            answer = self._chat('https://api.groq.com/openai/v1/chat/completions', self.config.groq_api_key, 'qwen/qwen3.8-27b', prompt, context_text, route)
            provider = 'groq:qwen/qwen3.8-27b'
        if not answer and self.config.mistral_api_key:
            answer = self._chat('https://api.mistral.ai/v1/chat/completions', self.config.mistral_api_key, 'mistral-small-latest', prompt, context_text, route)
            provider = 'mistral:small'
        if answer:
            return {'answer': self._clean(answer), 'sources': sources, 'links': self._links(prompt, state_id, sources), 'provider': provider}
        return {'answer': 'The language model is unreachable right now. Retrieved from verified telemetry:\n\n' + context_text, 'sources': sources, 'links': self._links(prompt, state_id, sources), 'provider': 'local_grounding'}
