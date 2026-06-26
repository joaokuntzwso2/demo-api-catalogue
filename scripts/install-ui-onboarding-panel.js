#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const candidateDirs = [
  'api-catalogue-ui',
  'catalogue-ui',
  'ui',
  'frontend'
];

function findUiDir() {
  for (const dir of candidateDirs) {
    const packageJson = path.join(dir, 'package.json');
    const src = path.join(dir, 'src');
    if (fs.existsSync(packageJson) && fs.existsSync(src)) {
      return dir;
    }
  }

  throw new Error(`Could not find UI directory. Tried: ${candidateDirs.join(', ')}`);
}

const uiDir = findUiDir();
const srcDir = path.join(uiDir, 'src');
const componentsDir = path.join(srcDir, 'components');
fs.mkdirSync(componentsDir, { recursive: true });

const componentPath = path.join(componentsDir, 'OnboardingPanel.jsx');
const cssPath = path.join(componentsDir, 'OnboardingPanel.css');

fs.writeFileSync(componentPath, `import { useEffect, useMemo, useRef, useState } from 'react';
import './OnboardingPanel.css';

const CONTROL_BASE =
  import.meta.env.VITE_PLATFORM_CONTROL_URL || 'http://localhost:6400';

export default function OnboardingPanel() {
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState(null);
  const [selectedActionId, setSelectedActionId] = useState('');
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const eventSourceRef = useRef(null);
  const logRef = useRef(null);

  const availableActions = useMemo(() => {
    return options?.availableActions || [];
  }, [options]);

  async function loadOptions() {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(\`\${CONTROL_BASE}/api/onboarding/options\`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || \`HTTP \${response.status}\`);
      }

      setOptions(payload);

      const firstAvailable = payload.availableActions?.[0]?.id || '';
      setSelectedActionId((current) => {
        if (current && payload.availableActions?.some((action) => action.id === current)) {
          return current;
        }
        return firstAvailable;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOptions();

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

  async function startOnboarding() {
    if (!selectedActionId) {
      return;
    }

    setError('');
    setLogs([]);
    setJob(null);

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    try {
      const response = await fetch(\`\${CONTROL_BASE}/api/onboarding/jobs\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          actionId: selectedActionId
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || \`HTTP \${response.status}\`);
      }

      setJob(payload);

      const eventSource = new EventSource(
        \`\${CONTROL_BASE}/api/onboarding/jobs/\${payload.id}/events\`
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
        loadOptions();
      });

      eventSource.onerror = () => {
        setLogs((current) => [
          ...current,
          {
            type: 'stderr',
            text: '\\nLog stream disconnected. Check npm run platform:control.\\n',
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
    <section className="onboarding-panel">
      <div className="onboarding-panel__header">
        <div>
          <h2>Onboard a new API</h2>
          <p>
            Select an API that is not yet onboarded. The UI will run the approved
            platform onboarding command and stream the logs in real time.
          </p>
        </div>

        <button
          type="button"
          className="onboarding-panel__refresh"
          onClick={loadOptions}
          disabled={loading || running}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="onboarding-panel__error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="onboarding-panel__empty">Loading onboarding options...</div>
      ) : (
        <>
          <div className="onboarding-panel__summary">
            <strong>Already onboarded:</strong>{' '}
            {options?.onboardedApis?.length
              ? options.onboardedApis.join(', ')
              : 'none yet'}
          </div>

          {availableActions.length === 0 ? (
            <div className="onboarding-panel__empty">
              All configured demo APIs are already onboarded.
            </div>
          ) : (
            <div className="onboarding-panel__options">
              {availableActions.map((action) => (
                <label
                  key={action.id}
                  className={
                    selectedActionId === action.id
                      ? 'onboarding-panel__option onboarding-panel__option--selected'
                      : 'onboarding-panel__option'
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

                    <small>
                      Missing: {action.missingApis.join(', ')}
                    </small>
                  </div>
                </label>
              ))}
            </div>
          )}

          <button
            type="button"
            className="onboarding-panel__button"
            onClick={startOnboarding}
            disabled={!selectedActionId || running || availableActions.length === 0}
          >
            {running ? 'Onboarding in progress...' : 'Onboard selected API'}
          </button>
        </>
      )}

      <div className="onboarding-panel__job">
        <div className="onboarding-panel__job-title">
          <strong>Execution log</strong>
          {job && (
            <span className={\`onboarding-panel__status onboarding-panel__status--\${String(job.status).toLowerCase()}\`}>
              {job.status}
            </span>
          )}
        </div>

        <pre className="onboarding-panel__logs" ref={logRef}>
          {logs.length === 0
            ? 'No onboarding job running yet.'
            : logs.map((entry, index) => \`[\${entry.type}] \${entry.text}\`).join('')}
        </pre>
      </div>
    </section>
  );
}
`);

fs.writeFileSync(cssPath, `.onboarding-panel {
  margin: 24px 0;
  padding: 20px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.04);
}

.onboarding-panel__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}

.onboarding-panel__header h2 {
  margin: 0 0 6px;
}

.onboarding-panel__header p {
  margin: 0;
  opacity: 0.8;
}

.onboarding-panel__refresh,
.onboarding-panel__button {
  border: 0;
  border-radius: 10px;
  padding: 10px 14px;
  cursor: pointer;
  font-weight: 700;
}

.onboarding-panel__button {
  margin-top: 16px;
  width: 100%;
}

.onboarding-panel__refresh:disabled,
.onboarding-panel__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.onboarding-panel__summary {
  margin-bottom: 14px;
  font-size: 0.95rem;
}

.onboarding-panel__options {
  display: grid;
  gap: 10px;
}

.onboarding-panel__option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 12px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.6);
}

.onboarding-panel__option--selected {
  border-color: rgba(37, 99, 235, 0.8);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.onboarding-panel__option p {
  margin: 4px 0 8px;
  opacity: 0.8;
}

.onboarding-panel__option small {
  opacity: 0.75;
}

.onboarding-panel__empty,
.onboarding-panel__error {
  padding: 12px;
  border-radius: 10px;
  margin-bottom: 12px;
}

.onboarding-panel__empty {
  background: rgba(148, 163, 184, 0.16);
}

.onboarding-panel__error {
  background: rgba(239, 68, 68, 0.14);
  color: #991b1b;
}

.onboarding-panel__job {
  margin-top: 18px;
}

.onboarding-panel__job-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.onboarding-panel__status {
  font-size: 0.8rem;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.25);
}

.onboarding-panel__status--running {
  background: rgba(234, 179, 8, 0.22);
}

.onboarding-panel__status--succeeded {
  background: rgba(34, 197, 94, 0.22);
}

.onboarding-panel__status--failed {
  background: rgba(239, 68, 68, 0.22);
}

.onboarding-panel__logs {
  min-height: 220px;
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  padding: 14px;
  border-radius: 12px;
  background: #020617;
  color: #e2e8f0;
  font-size: 0.82rem;
}
`);

const appCandidates = [
  path.join(srcDir, 'App.jsx'),
  path.join(srcDir, 'App.tsx')
];

const appPath = appCandidates.find((candidate) => fs.existsSync(candidate));

if (!appPath) {
  console.log(`Created component files under ${componentsDir}`);
  console.log('Could not find App.jsx/App.tsx to auto-inject the panel.');
  console.log('Add this manually in your app:');
  console.log("import OnboardingPanel from './components/OnboardingPanel.jsx';");
  console.log('<OnboardingPanel />');
  process.exit(0);
}

let app = fs.readFileSync(appPath, 'utf8');

if (!app.includes('OnboardingPanel')) {
  const importLine = "import OnboardingPanel from './components/OnboardingPanel.jsx';\n";

  const importMatches = [...app.matchAll(/^import .*;$/gm)];
  if (importMatches.length > 0) {
    const lastImport = importMatches[importMatches.length - 1];
    const insertAt = lastImport.index + lastImport[0].length + 1;
    app = app.slice(0, insertAt) + importLine + app.slice(insertAt);
  } else {
    app = importLine + app;
  }

  const patterns = [
    /(<main[^>]*>)/,
    /(<div[^>]*className=["'][^"']*app[^"']*["'][^>]*>)/i,
    /(<div[^>]*>)/
  ];

  let injected = false;

  for (const pattern of patterns) {
    if (pattern.test(app)) {
      app = app.replace(pattern, `$1\n      <OnboardingPanel />`);
      injected = true;
      break;
    }
  }

  if (!injected) {
    console.log(`Created component files under ${componentsDir}`);
    console.log(`Could not safely inject into ${appPath}. Add <OnboardingPanel /> manually.`);
  } else {
    fs.writeFileSync(appPath, app);
    console.log(`Installed OnboardingPanel into ${appPath}`);
  }
} else {
  console.log(`OnboardingPanel already present in ${appPath}`);
}

console.log(`UI directory: ${uiDir}`);
