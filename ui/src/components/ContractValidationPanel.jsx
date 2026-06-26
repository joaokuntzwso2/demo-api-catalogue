import { useEffect, useMemo, useState } from "react";
import "./ContractValidationPanel.css";

function stringifyJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJson(label, value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
}

async function readJsonResponse(response, label) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!contentType.includes("application/json")) {
    throw new Error(
      `${label} returned non-JSON response. This usually means the Vite proxy is missing. ` +
        `HTTP ${response.status}. First bytes: ${text.slice(0, 80)}`
    );
  }

  const data = JSON.parse(text);

  if (!response.ok) {
    throw new Error(data.message || `${label} failed with HTTP ${response.status}`);
  }

  return data;
}

export default function ContractValidationPanel() {
  const [open, setOpen] = useState(false);
  const [apis, setApis] = useState([]);
  const [selectedName, setSelectedName] = useState("");
  const [requestText, setRequestText] = useState("{}");
  const [payloadText, setPayloadText] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);

  const selectedApi = useMemo(
    () => apis.find((api) => api.name === selectedName),
    [apis, selectedName]
  );

  async function loadOptions() {
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/contract-validation/options");
      const data = await readJsonResponse(response, "Contract validation options");
      const loadedApis = data.apis || [];

      setApis(loadedApis);

      const nextSelected =
        loadedApis.find((api) => api.name === selectedName) ||
        loadedApis[0];

      if (nextSelected) {
        setSelectedName(nextSelected.name);
        setRequestText(stringifyJson(nextSelected.effectiveRequest));
        setPayloadText(stringifyJson(nextSelected.effectivePayload));
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      loadOptions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function selectApi(name) {
    const api = apis.find((item) => item.name === name);

    setSelectedName(name);
    setResult(null);
    setMessage("");

    if (api) {
      setRequestText(stringifyJson(api.effectiveRequest));
      setPayloadText(stringifyJson(api.effectivePayload));
    }
  }

  async function applyAndRun() {
    setLoading(true);
    setMessage("");
    setResult(null);

    try {
      const request = parseJson("Request consumed by Integrator", requestText);
      const payload = parseJson("Expected response payload", payloadText);

      const response = await fetch("/api/contract-validation/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          apiName: selectedName,
          request,
          payload
        })
      });

      const data = await readJsonResponse(response, "Contract validation job");

      setResult(data);
      setMessage("Overrides saved, MI validation redeployed, and probe triggered.");
      await loadOptions();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="contract-validation-launcher"
        onClick={() => setOpen(true)}
      >
        Edit validation contracts
      </button>

      {open ? (
        <div className="contract-validation-modal">
          <div className="contract-validation-modal__backdrop" onClick={() => setOpen(false)} />

          <section className="contract-validation-modal__panel">
            <div className="contract-validation-modal__header">
              <div>
                <h2>Contract validation editor</h2>
                <p>
                  Edit request and expected response contracts for already-deployed APIs,
                  then redeploy MI validation artifacts and run the probe again.
                </p>
              </div>

              <div className="contract-validation-modal__header-actions">
                <button type="button" onClick={loadOptions} disabled={loading}>
                  Refresh
                </button>
                <button type="button" onClick={() => setOpen(false)} disabled={loading}>
                  Close
                </button>
              </div>
            </div>

            <div className="contract-validation-modal__toolbar">
              <label>
                API
                <select
                  value={selectedName}
                  onChange={(event) => selectApi(event.target.value)}
                  disabled={loading}
                >
                  {apis.map((api) => (
                    <option key={api.name} value={api.name}>
                      {api.name}
                      {api.hasRequestOverride || api.hasPayloadOverride
                        ? " · local override"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>

              {selectedApi ? (
                <div className="contract-validation-modal__meta">
                  <span>Expected HTTP {selectedApi.expectedHttpStatus}</span>
                  <span>Required: {(selectedApi.requiredFields || []).join(", ")}</span>
                </div>
              ) : null}
            </div>

            <div className="contract-validation-modal__grid">
              <label>
                Request consumed by Integrator
                <textarea
                  value={requestText}
                  onChange={(event) => setRequestText(event.target.value)}
                  spellCheck="false"
                  disabled={loading}
                />
              </label>

              <label>
                Expected response payload
                <textarea
                  value={payloadText}
                  onChange={(event) => setPayloadText(event.target.value)}
                  spellCheck="false"
                  disabled={loading}
                />
              </label>
            </div>

            <div className="contract-validation-modal__actions">
              <button type="button" onClick={applyAndRun} disabled={loading || !selectedName}>
                {loading ? "Applying and validating..." : "Apply, redeploy validation, and run probe"}
              </button>
            </div>

            {message ? <p className="contract-validation-modal__message">{message}</p> : null}

            {result ? (
              <pre className="contract-validation-modal__result">
                {JSON.stringify(
                  {
                    status: result.status,
                    apiName: result.apiName,
                    probe: result.probe,
                    reconcileExitCode: result.reconcile?.code
                  },
                  null,
                  2
                )}
              </pre>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
