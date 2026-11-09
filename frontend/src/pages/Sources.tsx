import { useEffect } from 'react';
import { AlertTriangle, BookOpen, Database, ShieldCheck } from 'lucide-react';
import { useApi } from '../api/client';
import { Evidence, QueryState } from '../components/DataPanels';
import { useFilters } from '../hooks/useFilters';

const requestedSources = [
  { id: 'landslides', name: 'Community landslide records' },
  { id: 'nwic_boundaries', name: 'NWIC official boundaries' },
  { id: 'drought', name: 'IIT Gandhinagar drought indicators' },
  { id: 'heat', name: 'IITM Pune / IMD regional temperature — requested family' },
  { id: 'floods', name: 'IIT Delhi flood records' },
  { id: 'imd_rainfall', name: 'IMD / NWIC rainfall observations' },
  { id: 'cyclones', name: 'NOAA IBTrACS cyclone observations' },
];

function safeUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export default function Sources() {
  const sources = useApi('/api/v1/sources');
  const catalog = useApi('/api/v1/metadata');
  const { filters } = useFilters();
  const selectedSource = filters.get('source_id');
  const records = sources.data?.data ?? [];
  const missingSources = requestedSources.filter((requested) => !records.some((source) => source.id === requested.id));
  if (selectedSource && !records.some((source) => source.id === selectedSource) && !missingSources.some((source) => source.id === selectedSource)) {
    missingSources.push({ id: selectedSource, name: selectedSource });
  }

  useEffect(() => {
    if (selectedSource && sources.data) {
      document.getElementById(`source-${selectedSource}`)?.scrollIntoView?.({ block: 'start' });
    }
  }, [selectedSource, sources.data, catalog.data]);

  return (
    <>
      <header className="page-heading">
        <h1>Sources and methodology</h1>
        <p className="muted">Trace provider declarations, imported coverage and processing methods.</p>
      </header>
      <section className="provenance-warning" aria-labelledby="landslide-warning-title">
        <h2 id="landslide-warning-title"><AlertTriangle size={22} aria-hidden="true" /> Landslide provenance is unverified</h2>
        <p>The original provenance of the community landslide records is unverified, including workbook NASA/GLC attribution. Do not interpret unreported events as absence of hazard or this collection as a complete official inventory.</p>
      </section>
      <section aria-labelledby="sources-title">
        <h2 id="sources-title"><Database size={22} aria-hidden="true" /> Source catalog</h2>
        <QueryState query={catalog} empty={catalog.data !== undefined && Object.keys(catalog.data.data.datasets).length === 0}>
          <p className="muted">Imported dataset catalog prepared: {catalog.data?.data.processed_at}. Provider-declared coverage is not the same as imported observation coverage.</p>
        </QueryState>
        <QueryState query={sources} empty={sources.data?.status === 'no_data' || (Boolean(sources.data) && records.length === 0)}>
          <div className="sources-workbench">
            <nav className="source-index" aria-label="Dataset index">
              <ul>
                {[...records, ...missingSources].map((source) => <li key={source.id}><a href={`#/sources?source_id=${encodeURIComponent(source.id)}`} aria-current={selectedSource === source.id ? 'location' : undefined}>{source.name}</a></li>)}
              </ul>
            </nav>
            <div className="source-articles">
              {records.map((source) => {
                const url = safeUrl(source.url);
                const importedDatasets = Object.entries(catalog.data?.data.datasets ?? {}).filter(([, metadata]) => metadata.source_ids?.includes(source.id));
                return (
                  <article className="source-article" id={`source-${source.id}`} key={source.id} aria-labelledby={`source-${source.id}-title`}>
                    <h3 id={`source-${source.id}-title`}>{source.name}</h3>
                    <p className="muted">Source ID: {source.id}</p>
                    <dl>
                      <dt>Provider</dt><dd>{source.provider}</dd>
                      <dt>Purpose declared by source</dt><dd>{source.purpose}</dd>
                      <dt>Format</dt><dd>{source.data_format}</dd>
                      <dt>Provider-declared geographical coverage</dt><dd>{source.geographic_coverage}</dd>
                      <dt>Provider-declared temporal coverage</dt><dd>{source.temporal_coverage}</dd>
                      <dt>Provenance status</dt><dd>{source.provenance_status}</dd>
                      <dt>Provider / download link</dt><dd>{url ? <a href={url} target="_blank" rel="noopener noreferrer">Open declared source for {source.name} (new tab)</a> : 'No valid HTTP(S) source URL provided'}</dd>
                    </dl>
                    <ul>{source.limitations?.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
                    {catalog.data && <section aria-labelledby={`source-${source.id}-imported-title`}>
                      <h4 id={`source-${source.id}-imported-title`}>Imported dataset coverage</h4>
                      {importedDatasets.length ? importedDatasets.map(([name, metadata]) => <div className="imported-dataset" key={name}>
                        <h5>{name}: {metadata.metric}</h5>
                        <dl>
                          <dt>Imported scope</dt><dd>{metadata.geographic_level}; {metadata.time_resolution}</dd>
                          <dt>Source-record count</dt><dd>{metadata.observation_count.toLocaleString()}</dd>
                          {(metadata.period?.start || metadata.period?.end) && <><dt>Imported period</dt><dd>{metadata.period?.start ?? 'Period not supplied'} — {metadata.period?.end ?? 'Period not supplied'}</dd></>}
                          <dt>Unit</dt><dd>{metadata.unit ?? 'Unit not declared'}</dd>
                        </dl>
                        <Evidence meta={metadata} />
                      </div>) : <p>No imported dataset declares this source ID.</p>}
                    </section>}
                  </article>
                );
              })}
              {missingSources.map((requested) => <article className="source-article" key={requested.id} id={`source-${requested.id}`}>
                <h3>{requested.name}</h3><p>Requested source family — backend source metadata unavailable.</p>
              </article>)}
            </div>
          </div>
        </QueryState>
        {sources.data && records.length === 0 && missingSources.map((requested) => <article className="source-article" key={requested.id} id={`source-${requested.id}`}>
          <h3>{requested.name}</h3><p>Requested source family — backend source metadata unavailable.</p>
        </article>)}
        <Evidence meta={sources.data?.meta} />
      </section>
      <section className="work-section" aria-labelledby="source-method-title">
        <h2 id="source-method-title"><BookOpen size={22} aria-hidden="true" /> Dataset methods and availability</h2>
        {catalog.data && <>
          {Object.entries(catalog.data.data.datasets).map(([name, metadata]) => <details key={name}>
            <summary>{name}: {metadata.metric}</summary>
            <Evidence meta={metadata} />
          </details>)}
          {Object.entries(catalog.data.data.capabilities.omitted_datasets ?? {}).map(([name, reason]) => <p key={name}><strong>{name} unavailable:</strong> {reason}</p>)}
        </>}
      </section>
      <section className="research-note" aria-labelledby="source-use-title">
        <h2 id="source-use-title"><ShieldCheck size={22} aria-hidden="true" /> Historical research, not emergency guidance</h2>
        <p>Provider attribution is not independent verification. No real-time forecasting, official alerts or validated future predictions. Missing observations are not zero; shared calendar years do not establish comparability. Regional temperature and national drought cannot be repurposed as state observations.</p>
      </section>
    </>
  );
}
