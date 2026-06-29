import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AlertTriangle, CheckCircle2, Clock, DatabaseZap, RefreshCcw, Search } from 'lucide-react';
import './styles.css';
import OnboardingPanel from './components/OnboardingPanel.jsx';
import ContractValidationPanel from "./components/ContractValidationPanel";

const API_BASE = import.meta.env.VITE_STATUS_API_BASE_URL || '';
const STATUS_PREFIX = import.meta.env.VITE_STATUS_API_PREFIX || '/catalogue-status/v1';

const statusOrder = ['RED', 'YELLOW', 'UNKNOWN', 'GREY', 'DEPRECATED', 'GREEN'];

function buildUrl(prefix, path) {
  const base = String(API_BASE || '').replace(/\/+$/, '');
  const cleanPrefix = String(prefix || '').replace(/\/+$/, '');
  const cleanPath = String(path || '').replace(/^\/+/, '');

  return `${base}${cleanPrefix}/${cleanPath}`;
}

async function readJson(response) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  return JSON.parse(text);
}



function clickableHealthUrl(api) {
  return (
    api?.gatewayHealthBrowserUrl ||
    api?.healthBrowserUrl ||
    api?.healthUrl ||
    ""
  );
}

function HealthUrlLink({ api }) {
  const displayUrl = clickableHealthUrl(api);
  const invokeUrl = api?.secureHealthInvokeUrl || displayUrl;

  if (!displayUrl) {
    return <span className="muted">—</span>;
  }

  return (
    <a
      className="health-url-link"
      href={invokeUrl}
      target="_blank"
      rel="noreferrer"
      title="Invoke the APIM-published endpoint through platform-control with the OAuth application token"
    >
      {displayUrl}
    </a>
  );
}

function displayApiName(api) {
  return api?.displayName || api?.apiDisplayName || api?.name || 'unknown-api';
}


function displayDomain(api) {
  const categories = Array.isArray(api?.categories) ? api.categories : [];
  return api?.category || categories[0] || api?.domain || 'Unclassified';
}

function statusRank(status) {
  const index = statusOrder.indexOf(status || 'UNKNOWN');
  return index === -1 ? statusOrder.indexOf('UNKNOWN') : index;
}

function Badge({ status }) {
  const label = status || 'UNKNOWN';
  return <span className={`badge badge-${label.toLowerCase()}`}>{label}</span>;
}

function SummaryCard({ title, value, icon }) {
  return (
    <div className="summary-card">
      <div className="summary-icon">{icon}</div>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function App() {
  const [apis, setApis] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastLoadError, setLastLoadError] = useState(null); const [syncingCatalogue, setSyncingCatalogue] = useState(false); const [syncMessage, setSyncMessage] = useState(null);

  async function load() {
    setLoading(true);
    setLastLoadError(null);

    try {
      const [apisRes, summaryRes] = await Promise.all([
        fetch(buildUrl(STATUS_PREFIX, 'apis')),
        fetch(buildUrl(STATUS_PREFIX, 'summary'))
      ]);

      const nextApisRaw = (await readJson(apisRes)) || [];
      const nextSummary = (await readJson(summaryRes)) || {
        total: nextApisRaw.length,
        counts: {}
      };

      const nextApis = [...nextApisRaw].sort(
        (a, b) => statusRank(a.consumerStatus) - statusRank(b.consumerStatus)
      );

      setApis(nextApis);
      setSummary(nextSummary);

      setSelected((currentSelected) => {
        if (!currentSelected) {
          return null;
        }

        return nextApis.find((api) => api.apiId === currentSelected.apiId) || null;
      });
    } catch (error) {
      console.error('[catalogue-ui] Failed to load cached API status', error);
      setLastLoadError(error.message || String(error));
    } finally {
      setLoading(false);
    }
  }

  async function syncCatalogue() {
  setSyncingCatalogue(true);
  setLastLoadError(null);
  setSyncMessage("Sincronizando assinaturas do DevPortal e reexecutando avaliação...");

  try {
    const response = await fetch("/api/catalogue-sync/run", {
      method: "POST"
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(payload.message || text || `HTTP ${response.status}`);
    }

    setSyncMessage(payload.message || "Catálogo sincronizado e avaliação executada.");
    await load();

    setTimeout(() => {
      load();
    }, 2500);

    setTimeout(() => {
      load();
    }, 7000);
  } catch (error) {
    console.error("[catalogue-ui] Failed to sync catalogue subscriptions", error);
    setLastLoadError(error.message || String(error));
    setSyncMessage(null);
  } finally {
    setSyncingCatalogue(false);
  }
} useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();

    return apis.filter((api) => {
      if (!q) {
        return true;
      }

      return [
        api.name,
        displayDomain(api),
        api.owner?.team,
        api.runtime,
        api.criticality,
        api.consumerStatus
      ].some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [apis, filter]);

  return (
    <main>
      <OnboardingPanel />
      <ContractValidationPanel />
      <section className="hero">
        <div>
          <p className="eyebrow">WSO2 API Platform + WSO2 Integration Platform</p>
          <h1>Catálogo Corporativo de APIs</h1>
          <p className="subtitle">
            Visão demo de descoberta, ownership, health, contrato e SLA em uma experiência centralizada.
          </p>
        </div>

        <button onClick={load} disabled={loading}>
          <RefreshCcw size={16} /> Atualizar leitura</button> <button className="ghost" onClick={syncCatalogue} disabled={syncingCatalogue || loading}>{syncingCatalogue ? 'Sincronizando...' : 'Sync assinaturas & avaliar'}
        </button>
      </section>

      {syncMessage ? ( <div className="sync-message">{syncMessage}</div> ) : null} {lastLoadError ? (
        <section className="toolbar">
          <span style={{ color: '#b42318' }}>
            Erro ao carregar status: {lastLoadError}
          </span>
        </section>
      ) : null}

      <section className="summary-grid">
        <SummaryCard
          title="APIs registradas"
          value={summary?.total ?? apis.length}
          icon={<DatabaseZap />}
        />
        <SummaryCard
          title="Saudáveis"
          value={summary?.counts?.GREEN ?? 0}
          icon={<CheckCircle2 />}
        />
        <SummaryCard
          title="Em atenção"
          value={(summary?.counts?.YELLOW ?? 0) + (summary?.counts?.UNKNOWN ?? 0)}
          icon={<AlertTriangle />}
        />
        <SummaryCard
          title="Críticas"
          value={summary?.counts?.RED ?? 0}
          icon={<Activity />}
        />
      </section>

      <section className="toolbar">
        <div className="search">
          <Search size={16} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Buscar por API, domínio, time, runtime ou criticidade"
          />
        </div>

        <span>
          {loading ? 'Atualizando leitura...' : 'Lendo último resultado conhecido'}
        </span>
      </section>

      <section className="content">
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>API</th>
                <th>Domínio</th>
                <th>Owner</th>
                <th>Runtime</th>
                <th>Criticidade</th>
                <th>Liveness</th>
                <th>Contrato</th>
                <th>SLA</th>
                <th>Último check do MI</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((api) => (
                <tr
                  key={api.apiId}
                  onClick={() => setSelected(api)}
                  className={selected?.apiId === api.apiId ? 'selected' : ''}
                >
                  <td>
                    <strong>{displayApiName(api)}</strong>
                    <small>{api.version} · {api.lifecycle}</small>
                  </td>

                  <td>{displayDomain(api)}</td>

                  <td>
                    {api.owner?.team}
                    <small>{api.owner?.email}</small>
                  </td>

                  <td>{api.runtime}</td>

                  <td>
                    {api.criticality}
                    <small>{api.checkFrequency}</small>
                  </td>

                  <td>
                    <Badge
                      status={
                        api.liveness?.status === 'OK'
                          ? 'GREEN'
                          : api.liveness?.status === 'FAILED'
                            ? 'RED'
                            : api.liveness?.status === 'SKIPPED'
                              ? 'GREY'
                              : 'UNKNOWN'
                      }
                    />
                  </td>

                  <td>
                    <Badge
                      status={
                        api.contract?.status === 'OK'
                          ? 'GREEN'
                          : api.contract?.status === 'FAILED'
                            ? 'YELLOW'
                            : api.contract?.status === 'SKIPPED'
                              ? 'GREY'
                              : 'UNKNOWN'
                      }
                    />
                  </td>

                  <td>
                    <Badge status={api.consumerStatus} />
                  </td>

                  <td>
                    <span className="last-check">
                      <Clock size={14} />
                      {api.checkedAt ? new Date(api.checkedAt).toLocaleTimeString() : 'Pendente'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="details">
          {selected ? (
            <>
              <h2>{displayApiName(selected)}</h2>
              <Badge status={selected.consumerStatus} />

              <dl>
                <dt>Owner</dt>
                <dd>{selected.owner?.team} · {selected.owner?.email}</dd>

                <dt>Runtime</dt>
                <dd>{selected.runtime}</dd>

                <dt>Criticidade</dt>
                <dd>{selected.criticality} · {selected.checkFrequency}</dd>

                <dt>SLA target</dt>
                <dd>{selected.slaTarget} · {selected.sla?.status}</dd>

                <dt>Liveness</dt>
                <dd>
                  {selected.liveness?.status} · HTTP {selected.liveness?.httpStatus ?? '-'} ·{' '}
                  {selected.liveness?.latencyMs ?? '-'}ms
                </dd>

                <dt>Contrato</dt>
                <dd>
                  {selected.contract?.status}
                  {selected.contract?.reasons?.length
                    ? ` · ${selected.contract.reasons.join('; ')}`
                    : ''}
                </dd>

                <dt>Health URL</dt>
                <dd className="url"><HealthUrlLink api={selected} /></dd>

                <dt>Último check executado pelo MI</dt>
                <dd>
                  {selected.checkedAt
                    ? new Date(selected.checkedAt).toLocaleString()
                    : 'Pendente'}
                </dd>
              </dl>
            </>
          ) : (
            <div className="empty-details">
              Selecione uma API para ver detalhes operacionais.
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
