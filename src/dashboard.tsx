import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgStudio, createWidgets } from 'ag-studio-react';
import type { AgRegistry, AgWidgetDefinition } from 'ag-studio-react';
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness, studioTheme } from 'ag-studio';
import type { AgAiAgentRunner, AgAiHarnessSetup, AgDefaultWidgetDefinition, AgReportState, AgStudioApi } from 'ag-studio';
import './payment-ui.css';
import './dashboard.css';

type AuditEvent = {
  id: string; request_id: string; status: string; kind: string;
  disclosed_fields: string[]; occurred_at: string;
};
type AuditData = { events: AuditEvent[]; credits: number; studioLicense: string };
type Insights = { configured: boolean; rows: [string, number][] };
type AuditView = {
  events: AuditEvent[];
  responses: AuditEvent[];
  response?: AuditEvent;
  selectResponse: (id: string) => void;
};
const context = createContext<AuditView>({ events: [], responses: [], selectResponse: () => {} });
const noEvents: AuditEvent[] = [];
const labels: Record<string, string> = {
  agent_response: 'Agent response', checkout_started: 'Checkout opened',
  credits_granted: 'Credits granted', needs_review: 'Needs review',
  approval_required: 'Approval required', processing: 'Verifying payment', credits_available: 'Credits available',
};
const label = (value: string) => labels[value] ?? value;
const eventDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const eventTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const optionTime = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function Timeline() {
  const { events, response, selectResponse } = useContext(context);
  return <section className="widget">
    <div className="widget-heading"><h2>Purchase timeline</h2><span>Newest first</span></div>
    {events.length === 0 ? <p className="empty-state">Purchase activity appears after an agent requests a top-up.</p> :
      <ol className="timeline">{events.map(event => {
        const occurred = new Date(event.occurred_at);
        const active = event.id === response?.id;
        return <li key={event.id} className={active ? 'active-event' : undefined}>
          <div className="event-name">
            {event.kind === 'agent_response'
              ? <button type="button" className="event-action" aria-pressed={active}
                  aria-label={`Inspect agent response for request ${event.request_id.slice(0, 8)}, ${eventDate.format(occurred)} ${eventTime.format(occurred)}`}
                  onClick={() => selectResponse(event.id)}>{label(event.kind)}</button>
              : <strong>{label(event.kind)}</strong>}
            <code>{event.request_id.slice(0, 8)}</code>
          </div>
          <span className="status" data-status={event.status}>{label(event.status)}</span>
          <time dateTime={event.occurred_at}>{eventDate.format(occurred)}<span>{eventTime.format(occurred)}</span></time>
        </li>;
      })}</ol>}
  </section>;
}

function Disclosure() {
  const { responses, response, selectResponse } = useContext(context);
  const selectId = useId();
  return <section className="widget">
    <div className="widget-heading"><h2>What the agent saw</h2></div>
    {!response ? <p className="empty-state">Tool response fields appear after the first agent request.</p> : <>
      <label className="response-label" htmlFor={selectId}>Tool response</label>
      <select className="response-select" id={selectId} value={response.id} onChange={event => selectResponse(event.target.value)}>
        {responses.map(item => <option key={item.id} value={item.id}>
          {label(item.status)} / {item.request_id.slice(0, 8)} / {optionTime.format(new Date(item.occurred_at))}
        </option>)}
      </select>
      <div aria-live="polite">
        <p className="response-state status" data-status={response.status}>{label(response.status)}</p>
        <p className="field-heading">Fields shared <span>{response.disclosed_fields.length}</span></p>
        {response.disclosed_fields.length > 0
          ? <ul className="fields">{response.disclosed_fields.map(field => <li key={field}><code>{field}</code></li>)}</ul>
          : <p className="empty-state">This response shared no fields.</p>}
      </div>
    </>}
  </section>;
}

type Widget = AgWidgetDefinition<'timeline' | 'disclosure'>;
interface Registry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | Widget)[];
}
const widgets = createWidgets<Registry>({
  additionalTypes: [
    { id: 'timeline', label: 'Purchase timeline', comp: Timeline, defaultSize: { width: 650, height: 380 },
      minSize: { width: 220, height: 150 }, form: params => params.createDefaults({}) },
    { id: 'disclosure', label: 'Agent disclosure', comp: Disclosure, defaultSize: { width: 380, height: 380 },
      minSize: { width: 180, height: 150 }, form: params => params.createDefaults({}) },
  ],
  menu: [{ label: 'Payment audit', widgetIds: ['timeline', 'disclosure'] }],
});
const initialState: AgReportState<Registry> = {
  pages: [{
    id: 'audit', widgets: { timeline: { type: 'timeline' }, disclosure: { type: 'disclosure' } },
    widgetLayout: {
      timeline: { xTrack: 0, yTrack: 0, xSpan: 15, ySpan: 12 },
      disclosure: { xTrack: 15, yTrack: 0, xSpan: 9, ySpan: 12 },
    },
  }],
  selectedPageId: 'audit',
};
const auditTheme = studioTheme.withParams({
  fontFamily: 'Geist, system-ui, sans-serif',
  foregroundColor: 'var(--ink)',
  textColor: 'var(--ink)',
  backgroundColor: 'var(--surface)',
  accentColor: 'var(--accent)',
  borderColor: 'var(--border)',
  studioMinHeight: 0,
  studioMinWidth: 0,
  studioWrapperSpacing: 8,
  studioWrapperBorder: false,
  studioWrapperBackgroundColor: 'var(--surface)',
  studioPanelContainerBackgroundColor: 'var(--surface)',
  studioPanelContainerBorder: '1px solid var(--border)',
  studioCanvasBackgroundColor: 'var(--ground)',
  studioAiPanelInputMessageBackgroundColor: 'var(--raised)',
  studioPopupBackgroundColor: 'var(--raised)',
});
const auditLayout = {
  rowHeight: 29, pagePadding: 12, widgetPadding: 10, widgetBorderRadius: 8,
  backgroundColor: 'var(--ground)', widgetBackgroundColor: 'var(--surface)', widgetBorderEnabled: false,
};

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error('Audit data unavailable');
  return response.json() as Promise<T>;
}

const auditAgent: AgAiAgentRunner = {
  id: 'payment-audit', name: 'Payment audit assistant',
  description: 'Answers common payment questions from your workspace audit events.',
  async *run(input, { signal }) {
    const { threadId, runId } = input;
    yield { type: 'RUN_STARTED', threadId, runId };
    try {
      const { events } = await get<AuditData>('/audit/data', signal);
      const question = input.messages.findLast(message => message.role === 'user')?.content.toLowerCase() ?? '';
      let answer: string;
      if (/fields|see|shared|disclos/.test(question)) {
        const response = events.find(event => event.kind === 'agent_response');
        answer = response ? 'The latest agent response contained ' + response.disclosed_fields.join(', ') + '.'
          : 'There are no recorded agent responses yet.';
      } else {
        const latest = new Map<string, AuditEvent>();
        for (const event of events) if (!latest.has(event.request_id)) latest.set(event.request_id, event);
        const pending = [...latest.values()].filter(event => event.status === 'approval_required' || event.status === 'processing');
        answer = pending.length
          ? pending.map(event => event.request_id.slice(0, 8) + ' is ' +
            (event.status === 'processing' ? 'waiting for payment verification.' : 'waiting for buyer approval.')).join('\n')
          : 'No top-ups in the audit window are waiting for approval or verification.';
      }
      yield { type: 'TEXT_MESSAGE_START', messageId: runId, role: 'assistant' };
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId: runId, delta: answer };
      yield { type: 'TEXT_MESSAGE_END', messageId: runId };
      yield { type: 'RUN_FINISHED', threadId, runId };
    } catch {
      if (!signal?.aborted) yield { type: 'RUN_ERROR', message: 'Audit data is unavailable. Try again.' };
    }
  },
};
const ai: AgAiHarnessSetup = ({ api }) => createAiHarness(api as AgStudioApi, () => ({
  primary: auditAgent.id, agents: [auditAgent], promptStarters: [
    { label: 'Pending top-ups', prompt: 'Why is a top-up pending?' },
    { label: 'Agent visibility', prompt: 'What fields did the agent see?' },
  ],
}));

function App() {
  const [data, setData] = useState<AuditData>();
  const [insights, setInsights] = useState<Insights>();
  const [insightError, setInsightError] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [selected, setSelected] = useState('');
  const [compactStudioOpen, setCompactStudioOpen] = useState(false);
  async function refresh() {
    setLoading(true);
    const activity = get<AuditData>('/audit/data').then(next => {
      if (next.studioLicense) AgStudioLicenseManager.setLicenseKey(next.studioLicense);
      setData(next);
      setLastUpdated(new Date());
      setError(false);
    }).catch(() => setError(true));
    const search = get<Insights>('/audit/insights').then(next => {
      setInsights(next);
      setInsightError(false);
    }).catch(() => setInsightError(true));
    await Promise.all([activity, search]);
    setLoading(false);
  }
  useEffect(() => { void refresh(); }, []);

  const events = data?.events ?? noEvents;
  const responses = useMemo(() => events.filter(event => event.kind === 'agent_response'), [events]);
  const studioData = useMemo(() => ({ sources: [{ id: 'audit', data: events }] }), [events]);
  const response = responses.find(event => event.id === selected) ?? responses[0];
  const latest = events[0];
  return <>
    <header className="site-header"><div className="site-header-inner">
      <a className="brand" href="/audit"><img className="brand-mark" src="/assets/on-my-tab.svg" alt="" width="28" height="28" />on my tab</a>
      <span className="environment">Sandbox</span>
    </div></header>
    <main className="audit-main">
      <div className="intro">
        <div><h1>Payment audit</h1><p>Track credit top-ups and see which fields reached the agent.</p></div>
        <div className="refresh">
          <span role="status">{loading ? 'Checking for activity…' : lastUpdated
            ? <time dateTime={lastUpdated.toISOString()}>Updated {eventTime.format(lastUpdated)}</time> : ''}</span>
          <button className="action action--quiet" type="button" aria-disabled={loading}
            onClick={() => { if (!loading) void refresh(); }}>Refresh activity</button>
        </div>
      </div>
      {error && <p className="audit-error" role="alert">{data
        ? 'Couldn’t refresh activity. The last successful update is still shown.'
        : <>Couldn’t load activity. Try refreshing or <a href="/audit">sign in again</a>.</>}</p>}
      <dl className="summary">
        <div className="payment-card balance-card">
          <dt>Available credits</dt><dd className="balance">{data ? data.credits.toLocaleString() : '—'}</dd>
        </div>
        <div><dt>Recent audit events</dt><dd>{data?.events.length ?? '—'}</dd></div>
        <div><dt>Latest purchase state</dt><dd>{latest
          ? <span className="status" data-status={latest.status}>{label(latest.status)}</span>
          : data ? 'No activity yet' : '—'}</dd></div>
      </dl>
      <context.Provider value={{ events, responses, response, selectResponse: setSelected }}>
        <div className="audit-workspace">
          <div className="compact-tools">
            <button className="action action--quiet" type="button" disabled={!data}
              aria-expanded={compactStudioOpen} aria-controls="audit-studio" onClick={() => setCompactStudioOpen(!compactStudioOpen)}>
              {compactStudioOpen ? 'Back to audit activity' : 'Open audit studio'}
            </button>
          </div>
          <div className="compact-audit" hidden={compactStudioOpen} aria-busy={loading && !data}>
            {loading && !data ? <p className="empty-state">Loading audit activity…</p> : <><Timeline /><Disclosure /></>}
          </div>
          <div className={`studio${compactStudioOpen ? ' studio--open' : ''}`} id="audit-studio">
            {data ?
            <AgStudio<Registry> data={studioData}
              widgets={widgets} initialState={initialState} layout={auditLayout} theme={auditTheme}
              className="studio-surface"
              mode="edit" panels={{ edit: { right: ['ai'] } }} modules={[AgStudioAiModule]} ai={ai} />
            : <div className="audit-preview" aria-busy={loading}>
                {loading ? <p className="empty-state">Loading audit activity…</p> : <><Timeline /><Disclosure /></>}
              </div>}
          </div>
        </div>
      </context.Provider>
      <section className="index-summary">
        <h2>Elasticsearch</h2>
        <p>{insightError ? 'Unavailable' : insights?.configured ? 'Connected' : insights ? 'Not configured' : 'Checking connection…'}</p>
        {!insightError && !!insights?.rows.length && <dl>
          {insights.rows.map(([status, count]) => <div key={status}><dt>{label(status)}</dt><dd>{count}</dd></div>)}
        </dl>}
      </section>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
