import { useEffect, useMemo, useRef, useState } from 'react';
import './OnboardingPanel.css';

const CONTROL_BASE =
  import.meta.env.VITE_PLATFORM_CONTROL_URL || 'http://localhost:6400';

function pretty(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export default function OnboardingPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState(null);
  const [selectedActionId, setSelectedActionId] = useState('');
  const [requestEditors, setRequestEditors] = useState({});
  const [payloadEditors, setPayloadEditors] = useState({});
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const eventSourceRef = useRef(null);
  const logRef = useRef(null);

  const availableActions = useMemo(() => {
    return options?.availableActions || [];
  }, [options]);

  const selectedAction = useMemo(() => {
    return availableActions.find((action) => action.id === selectedActionId) || null;
  }, [availableActions, selectedActionId]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  async function loadOptions() {
    setLoading(true);
    setError('');
    setOptions(null);

    try {
      const response = await fetch(`${CONTROL_BASE}/api/onboarding/options`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      setOptions(payload);

      const firstAvailable = payload.availableActions?.[0]?.id || '';

      setSelectedActionId((current) => {
        if (current && payload.availableActions?.some((action) => action.id === current)) {
          return current;
        }

        return firstAvailable;
      });

      const nextRequests = {};
      const nextPayloads = {};

      for (const action of payload.availableActions || []) {
        for (const apiName of action.missingApis || []) {
          const requestState = action.requests?.[apiName];
          const payloadState = action.payloads?.[apiName];

          nextRequests[apiName] = pretty(
            requestState?.effectiveRequest ||
            requestState?.overrideRequest ||
            requestState?.defaultRequest ||
            {}
          );

          nextPayloads[apiName] = pretty(
            payloadState?.effectivePayload ||
            payloadState?.overridePayload ||
            payloadState?.defaultPayload ||
            {}
          );
        }
      }

      setRequestEditors(nextRequests);
      setPayloadEditors(nextPayloads);
    } catch (e) {
      setError(
        `Could not connect to the local onboarding control server at ${CONTROL_BASE}. ` +
        `Start it with: npm run platform:control:start`
      );
      setOptions(null);
      setSelectedActionId('');
      setRequestEditors({});
      setPayloadEditors({});
    } finally {
      setLoading(false);
    }
  }

  function openModal() {
    setOpen(true);
    setError('');
    setOptions(null);
    setLogs([]);
    setJob(null);
    loadOptions();
  }

  function closeModal() {
    if (job?.status === 'RUNNING') {
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setOpen(false);
  }

  function updateRequestEditor(apiName, value) {
    setRequestEditors((current) => ({
      ...current,
      [apiName]: value
    }));
  }

  function updatePayloadEditor(apiName, value) {
    setPayloadEditors((current) => ({
      ...current,
      [apiName]: value
    }));
  }

  function resetRequestEditor(apiName) {
    const state = selectedAction?.requests?.[apiName] || {};

    setRequestEditors((current) => ({
      ...current,
      [apiName]: pretty(state.defaultRequest || {})
    }));
  }

  function resetPayloadEditor(apiName) {
    const state = selectedAction?.payloads?.[apiName] || {};

    setPayloadEditors((current) => ({
      ...current,
      [apiName]: pretty(state.defaultPayload || {})
    }));
  }

  function buildRequestOverrides() {
    const overrides = {};

    for (const apiName of selectedAction?.missingApis || []) {
      const raw = requestEditors[apiName] || '';
      const state = selectedAction?.requests?.[apiName] || {};
      const defaultRequest = state.defaultRequest || {};

      if (!raw.trim()) {
        overrides[apiName] = null;
        continue;
      }

      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Invalid JSON for contract request ${apiName}: ${e.message}`);
      }

      if (stableJson(parsed) === stableJson(defaultRequest)) {
        overrides[apiName] = null;
      } else {
        overrides[apiName] = parsed;
      }
    }

    return overrides;
  }

  function buildPayloadOverrides() {
    const overrides = {};

    for (const apiName of selectedAction?.missingApis || []) {
      const raw = payloadEditors[apiName] || '';
      const state = selectedAction?.payloads?.[apiName] || {};
      const defaultPayload = state.defaultPayload || {};

      if (!raw.trim()) {
        overrides[apiName] = null;
        continue;
      }

      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Invalid JSON for contract response ${apiName}: ${e.message}`);
      }

      if (stableJson(parsed) === stableJson(defaultPayload)) {
        overrides[apiName] = null;
      } else {
        overrides[apiName] = parsed;
      }
    }

    return overrides;
  }

  async function startOnboarding() {
    if (!selectedActionId) {
      return;
    }

    setError('');
    setLogs([]);
    setJob(null);

    let requestOverrides;
    let payloadOverrides;

    try {
      requestOverrides = buildRequestOverrides();
      payloadOverrides = buildPayloadOverrides();
    } catch (e) {
      setError(e.message);
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    try {
      const response = await fetch(`${CONTROL_BASE}/api/onboarding/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          actionId: selectedActionId,
          requestOverrides,
          payloadOverrides
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      setJob(payload);

      const eventSource = new EventSource(
        `${CONTROL_BASE}/api/onboarding/jobs/${payload.id}/events`
      );

      eventSourceRef.current = eventSource;

      eventSource.addEventListener('log', (event) => {
        const entry = JSON.parse(event.data);
        setLogs((current) => [...current, entry]);
      });

      eventSource.addEventListener('done', (event) => {
        const done = JSON.parse(event.data);

        setJob((current) => ({
          ...current,
          status: done.status,
          exitCode: done.exitCode,
          finishedAt: done.finishedAt
        }));

        eventSource.close();
        eventSourceRef.current = null;

        if (done.status === 'SUCCEEDED') {
          setLogs((current) => [
            ...current,
            {
              type: 'system',
              text: '\nEverything is ready. Refreshing the catalogue view...\n',
              at: new Date().toISOString()
            }
          ]);

          setTimeout(() => {
            setOpen(false);
            window.location.reload();
          }, 3000);
        } else {
          loadOptions();
        }
      });

      eventSource.onerror = () => {
        setLogs((current) => [
          ...current,
          {
            type: 'stderr',
            text: '\nLog stream disconnected. Check npm run platform:control:start.\n',
            at: new Date().toISOString()
          }
        ]);

        eventSource.close();
        eventSourceRef.current = null;
      };
    } catch (e) {
      setError(e.message);
    }
  }

  const running = job?.status === 'RUNNING';

  return (
    <>
      <button type="button" className="onboarding-launcher" onClick={openModal}>
        + Onboard API
      </button>

      {open && (
        <div className="onboarding-modal__backdrop">
          <div className="onboarding-modal" role="dialog" aria-modal="true">
            <div className="onboarding-modal__header">
              <div>
                <h2>Onboard a new API</h2>
                <p>
                  Select an API that is not yet onboarded. You can edit the contract
                  request and expected response for this run without changing committed metadata.
                </p>
              </div>

              <button
                type="button"
                className="onboarding-modal__close"
                onClick={closeModal}
                disabled={running}
              >
                ×
              </button>
            </div>

            <div className="onboarding-modal__toolbar">
              <button
                type="button"
                className="onboarding-modal__secondary"
                onClick={loadOptions}
                disabled={loading || running}
              >
                Refresh options
              </button>

              {running && (
                <span className="onboarding-modal__hint">
                  Keep this modal open while the job is running.
                </span>
              )}
            </div>

            {error && (
              <div className="onboarding-modal__error">
                {error}
              </div>
            )}

            {loading && (
              <div className="onboarding-modal__empty">
                Loading onboarding options...
              </div>
            )}

            {!loading && !error && options && (
              <>
                <div className="onboarding-modal__summary">
                  <strong>Already onboarded:</strong>{' '}
                  {options.onboardedApis?.length
                    ? options.onboardedApis.join(', ')
                    : 'none yet'}
                </div>

                {availableActions.length === 0 ? (
                  <div className="onboarding-modal__empty">
                    All configured demo APIs are already onboarded.
                  </div>
                ) : (
                  <div className="onboarding-modal__options">
                    {availableActions.map((action) => (
                      <label
                        key={action.id}
                        className={
                          selectedActionId === action.id
                            ? 'onboarding-modal__option onboarding-modal__option--selected'
                            : 'onboarding-modal__option'
                        }
                      >
                        <input
                          type="radio"
                          name="onboarding-action"
                          value={action.id}
                          checked={selectedActionId === action.id}
                          onChange={() => setSelectedActionId(action.id)}
                          disabled={running}
                        />

                        <div>
                          <strong>{action.label}</strong>
                          <p>{action.description}</p>
                          <small>Will onboard: {action.missingApis.join(', ')}</small>
                        </div>
                      </label>
                    ))}
                  </div>
                )}

                {selectedAction && (
                  <div className="onboarding-modal__contracts">
                    <h3>Contract request and response overrides</h3>
                    <p>
                      Values are pre-filled from committed contract metadata. Edited values are
                      stored only under <code>.runtime/</code> and are ignored by Git.
                    </p>

                    {selectedAction.missingApis.map((apiName) => {
                      const requestState = selectedAction.requests?.[apiName] || {};
                      const payloadState = selectedAction.payloads?.[apiName] || {};
                      const committedRequest = pretty(requestState.defaultRequest || {});
                      const committedPayload = pretty(payloadState.defaultPayload || {});
                      const requestValue = requestEditors[apiName] || '';
                      const payloadValue = payloadEditors[apiName] || '';

                      return (
                        <div className="onboarding-modal__contract-editor" key={apiName}>
                          <div className="onboarding-modal__payload-title">
                            <strong>{apiName}</strong>
                            <span>
                              {requestState.hasOverride || payloadState.hasOverride
                                ? 'Local override active'
                                : 'Using committed defaults'}
                            </span>
                          </div>

                          <div className="onboarding-modal__contract-grid">
                            <section className="onboarding-modal__contract-column">
                              <div className="onboarding-modal__contract-column-header">
                                <strong>Request consumed by Integrator</strong>
                              </div>

                              <textarea
                                value={requestValue}
                                onChange={(event) => updateRequestEditor(apiName, event.target.value)}
                                disabled={running}
                                spellCheck="false"
                              />

                              <div className="onboarding-modal__payload-actions">
                                <button
                                  type="button"
                                  className="onboarding-modal__tiny-button"
                                  onClick={() => resetRequestEditor(apiName)}
                                  disabled={running}
                                >
                                  Reset request
                                </button>

                                <small>
                                  Default: {committedRequest.replace(/\n/g, ' ')}
                                </small>
                              </div>
                            </section>

                            <section className="onboarding-modal__contract-column">
                              <div className="onboarding-modal__contract-column-header">
                                <strong>Expected response payload</strong>
                              </div>

                              <textarea
                                value={payloadValue}
                                onChange={(event) => updatePayloadEditor(apiName, event.target.value)}
                                disabled={running}
                                spellCheck="false"
                              />

                              <div className="onboarding-modal__payload-actions">
                                <button
                                  type="button"
                                  className="onboarding-modal__tiny-button"
                                  onClick={() => resetPayloadEditor(apiName)}
                                  disabled={running}
                                >
                                  Reset response
                                </button>

                                <small>
                                  Default: {committedPayload.replace(/\n/g, ' ')}
                                </small>
                              </div>
                            </section>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <button
                  type="button"
                  className="onboarding-modal__primary"
                  onClick={startOnboarding}
                  disabled={!selectedActionId || running || availableActions.length === 0}
                >
                  {running ? 'Onboarding in progress...' : 'Onboard selected API'}
                </button>
              </>
            )}

            <div className="onboarding-modal__job">
              <div className="onboarding-modal__job-title">
                <strong>Execution log</strong>
                {job && (
                  <span className={`onboarding-modal__status onboarding-modal__status--${String(job.status).toLowerCase()}`}>
                    {job.status}
                  </span>
                )}
              </div>

              <pre className="onboarding-modal__logs" ref={logRef}>
                {logs.length === 0
                  ? 'No onboarding job running yet.'
                  : logs.map((entry) => `[${entry.type}] ${entry.text}`).join('')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
