import { createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgStudio, createWidgets } from 'ag-studio-react';
import type { AgRegistry, AgWidgetDefinition } from 'ag-studio-react';
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness } from 'ag-studio';
import type { AgAiAgentRunner, AgAiHarnessSetup, AgDefaultWidgetDefinition, AgReportState, AgStudioApi } from 'ag-studio';
import './dashboard.css';

type AuditEvent = {
  id: string; request_id: string; status: string; kind: string;
  disclosed_fields: string[]; occurred_at: string;
};
type AuditData = { events: AuditEvent[]; credits: number; studioLicense: string };
type Insights = { configured: boolean; rows: [string, number][] };
const context = createContext<AuditData['events']>([]);
const labels: Record<string, string> = {
  agent_response: 'Agent response', checkout_started: 'Checkout opened',
  credits_granted: 'Credits granted', needs_review: 'Needs review',
  approval_required: 'Approval required', processing: 'Verifying payment', credits_available: 'Credits available',
};
const label = (value: string) => labels[value] ?? value;

function Timeline() {
  const events = useContext(context);
  return <section className="widget"><h2>Purchase timeline</h2>
    {events.length === 0 ? <p>Purchase activity appears here after an agent requests a top-up.</p> :
      <ol className="timeline">{events.map(event => <li key={event.id}>
        <span><strong>{label(event.kind)}</strong><small>{event.request_id.slice(0, 8)}</small></span>
        <span className="status">{label(event.status)}</span>
        <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleTimeString()}</time>
      </li>)}</ol>}
  </section>;
}

function Disclosure() {
  const events = useContext(context);
  const [selected, setSelected] = useState('');
  const responses = events.filter(event => event.kind === 'agent_response');
  const response = responses.find(event => event.id === selected) ?? responses[0];
  return <section className="widget"><h2>What the agent saw</h2>
    {!response ? <p>Tool response fields appear after the first MCP request.</p> : <>
      <label htmlFor="disclosure">Tool response</label>
      <select id="disclosure" value={response.id} onChange={event => setSelected(event.target.value)}>
        {responses.map(item => <option key={item.id} value={item.id}>
          {item.request_id.slice(0, 8)} · {label(item.status)} · {new Date(item.occurred_at).toLocaleTimeString()}
        </option>)}
      </select>
      <ul className="fields">{response.disclosed_fields.map(field => <li key={field}><code>{field}</code></li>)}</ul>
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
      timeline: { xTrack: 0, yTrack: 0, xSpan: 15, ySpan: 10 },
      disclosure: { xTrack: 15, yTrack: 0, xSpan: 9, ySpan: 10 },
    },
  }],
  selectedPageId: 'audit',
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
  async function refresh() {
    try {
      const next = await get<AuditData>('/audit/data');
      if (next.studioLicense) AgStudioLicenseManager.setLicenseKey(next.studioLicense);
      setData(next);
      setError(false);
    } catch { setError(true); }
    try {
      setInsights(await get<Insights>('/audit/insights'));
      setInsightError(false);
    } catch { setInsightError(true); }
  }
  useEffect(() => { void refresh(); }, []);

  return <>
    <header><a href="/audit">Payment Access</a><span>Sandbox</span></header>
    <main>
      <div className="intro"><div><h1>Payment audit</h1><p>Follow credit purchases and review what the coding agent received.</p></div>
        <button onClick={() => void refresh()}>Refresh activity</button></div>
      {error && <p role="alert">Audit activity is unavailable. Refresh the page to sign in again.</p>}
      {data && <>
        <div className="summary">
          <div><span>Available credits</span><strong>{data.credits}</strong></div>
          <div><span>Recent audit events</span><strong>{data.events.length}</strong></div>
          <div><span>Elasticsearch</span><strong>{insightError ? 'Unavailable' : insights?.configured ? 'Connected' : 'Not configured'}</strong>
            {insights?.rows.map(([status, count]) => <small key={status}>{label(status)} · {count}</small>)}</div>
        </div>
        <context.Provider value={data.events}>
          <div className="studio">
            <AgStudio<Registry> data={{ sources: [{ id: 'audit', data: data.events }] }}
              widgets={widgets} initialState={initialState} mode="edit" panels={{ edit: { right: ['ai'] } }}
              modules={[AgStudioAiModule]} ai={ai} />
          </div>
        </context.Provider>
      </>}
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
