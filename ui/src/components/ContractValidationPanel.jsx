import { useEffect, useMemo, useRef, useState } from "react";
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeUpper(value) {
  return normalizeText(value).toUpperCase();
}

function inferRuntimeActionFromText(value) {
  const text = normalizeUpper(value);

  if (
    text.includes("RED") ||
    text.includes("DOWN") ||
    text.includes("FAILED") ||
    text.includes("ERROR") ||
    text.includes("UNKNOWN") ||
    text.includes("GREY") ||
    text.includes("GRAY") ||
    text.includes("UNAVAILABLE")
  ) {
    return {
      action: "start",
      label: "Start API"
    };
  }

  return {
    action: "stop",
    label: "Stop API"
  };
}

async function readJsonResponse(response, label) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!contentType.includes("application/json")) {
    throw new Error(
      `${label} returned non-JSON response. HTTP ${response.status}. First bytes: ${text.slice(0, 80)}`
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
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const apisRef = useRef([]);

  const selectedApi = useMemo(
    () => apis.find((api) => api.name === selectedName),
    [apis, selectedName]
  );


  function apiNameFromText(text) {
    return apisRef.current.find((api) => String(text || "").includes(api.name))?.name || null;
  }

  function applyApiToEditor(api) {
    if (!api) {
      return;
    }

    setSelectedName(api.name);
    setRequestText(stringifyJson(api.effectiveRequest));
    setPayloadText(stringifyJson(api.effectivePayload));
    setResult(null);
    setMessage("");
  }

  async function loadOptions(preferredApiName = selectedName) {
    setLoading(true);

    try {
      const response = await fetch("/api/contract-validation/options");
      const data = await readJsonResponse(response, "Contract validation options");
      const loadedApis = data.apis || [];

      apisRef.current = loadedApis;
      setApis(loadedApis);

      const nextSelected =
        loadedApis.find((api) => api.name === preferredApiName) ||
        loadedApis[0];

      if (nextSelected) {
        applyApiToEditor(nextSelected);
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  }

  function openForApi(apiName) {
    if (!apiName) {
      return;
    }

    setOpen(true);
    setResult(null);

    const existingApi = apisRef.current.find((api) => api.name === apiName);

    if (existingApi) {
      applyApiToEditor(existingApi);
      return;
    }

    setSelectedName(apiName);
    loadOptions(apiName);
  }

  async function runRuntimeAction(apiName, action) {
    if (!apiName || runtimeBusy) {
      return;
    }

    setRuntimeBusy(true);
    setRuntimeMessage(`${action === "stop" ? "Stopping" : "Starting"} ${apiName}...`);

    try {
      const response = await fetch("/api/runtime-control/services", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          apiName,
          action
        })
      });

      const data = await readJsonResponse(response, "Runtime control");

      setRuntimeMessage(data.message || `${apiName} updated.`);

      setTimeout(() => {
        window.location.reload();
      }, 1200);
    } catch (e) {
      setRuntimeMessage(e.message);
    } finally {
      setRuntimeBusy(false);
    }
  }

  useEffect(() => {
    loadOptions("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!apis.length) {
      return undefined;
    }

    let decorateTimer = null;

    function clearDecorations() {
      document
        .querySelectorAll(".contract-validation-contract-target")
        .forEach((element) => {
          element.classList.remove("contract-validation-contract-target");
          element.removeAttribute("data-contract-validation-api-name");
          element.removeAttribute("title");
        });

      document
        .querySelectorAll(".api-runtime-control-target")
        .forEach((element) => {
          element.classList.remove("api-runtime-control-target");
          element.removeAttribute("data-runtime-api-name");
          element.removeAttribute("data-runtime-action");
          element.removeAttribute("data-runtime-label");
          element.removeAttribute("title");
        });
    }

    function markContractTarget(element, apiName) {
      if (!element || !apiName || element.closest(".contract-validation-modal")) {
        return;
      }

      // Contract editing must only be available from real API rows.
      // Do not decorate table headers, summary cards, side/details panels, or modal content.
      const tableBodyCell = element.closest("tbody td");

      if (!tableBodyCell) {
        return;
      }

      if (
        element.closest("thead") ||
        element.closest("th") ||
        element.closest(".details") ||
        element.closest(".detail-panel") ||
        element.closest(".api-details") ||
        element.closest("aside")
      ) {
        return;
      }

      element.classList.add("contract-validation-contract-target");
      element.setAttribute("data-contract-validation-api-name", apiName);
      element.setAttribute("title", `Edit validation contract for ${apiName}`);
    }

    function markRuntimeTarget(element, apiName) {
      if (!element || !apiName || element.closest(".contract-validation-modal")) {
        return;
      }

      // Runtime Start/Stop must only be available from real API rows.
      // Do not decorate table headers, summary cards, side/details panels, or modal content.
      const tableBodyCell = element.closest("tbody td");

      if (!tableBodyCell) {
        return;
      }

      if (
        element.closest("thead") ||
        element.closest("th") ||
        element.closest(".details") ||
        element.closest(".detail-panel") ||
        element.closest(".api-details") ||
        element.closest("aside")
      ) {
        return;
      }

      const { action, label } = inferRuntimeActionFromText(element.textContent);

      element.classList.add("api-runtime-control-target");
      element.setAttribute("data-runtime-api-name", apiName);
      element.setAttribute("data-runtime-action", action);
      element.setAttribute("data-runtime-label", label);
      element.setAttribute("title", `${label} for ${apiName}`);
    }

    function decorateTableCells() {
      document.querySelectorAll("table").forEach((table) => {
        const headerCells = Array.from(table.querySelectorAll("thead th"));

        if (!headerCells.length) {
          return;
        }

        const contractIndex = headerCells.findIndex((header) => {
          const label = normalizeUpper(header.textContent);
          return label === "CONTRATO" || label === "CONTRACT";
        });

        const livenessIndex = headerCells.findIndex((header) => {
          const label = normalizeUpper(header.textContent);
          return label === "LIVENESS" || label === "LIVE";
        });

        table.querySelectorAll("tbody tr").forEach((row) => {
          const apiName = apiNameFromText(row.textContent);
          const cells = Array.from(row.children);

          if (contractIndex >= 0) {
            markContractTarget(cells[contractIndex], apiName);
          }

          if (livenessIndex >= 0) {
            markRuntimeTarget(cells[livenessIndex], apiName);
          }
        });
      });
    }

    function findNearestApiContainer(startElement) {
      let current = startElement;

      for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
        const apiName = apiNameFromText(current.textContent);

        if (apiName) {
          return {
            element: current,
            apiName
          };
        }

        current = current.parentElement;
      }

      return null;
    }

    function decorateDetailLines() {
      Array.from(document.querySelectorAll("*")).forEach((element) => {
        const label = normalizeUpper(element.textContent);

        if (
          label !== "CONTRATO" &&
          label !== "CONTRACT" &&
          label !== "LIVENESS" &&
          label !== "LIVE"
        ) {
          return;
        }

        if (element.closest(".contract-validation-modal")) {
          return;
        }

        const apiContainer = findNearestApiContainer(element.parentElement);

        if (!apiContainer) {
          return;
        }

        const targetLine = element.parentElement || element;

        if (label === "CONTRATO" || label === "CONTRACT") {
          markContractTarget(targetLine, apiContainer.apiName);
        }

        if (label === "LIVENESS" || label === "LIVE") {
          markRuntimeTarget(targetLine, apiContainer.apiName);
        }
      });
    }

    function decorate() {
      clearDecorations();
      decorateTableCells();
      decorateDetailLines();
    }

    function handleClick(event) {
      const contractTarget = event.target.closest?.(".contract-validation-contract-target");

      if (contractTarget) {
        const apiName = contractTarget.getAttribute("data-contract-validation-api-name");

        if (apiName) {
          event.preventDefault();
          event.stopPropagation();
          openForApi(apiName);
          return;
        }
      }

      const runtimeTarget = event.target.closest?.(".api-runtime-control-target");

      if (runtimeTarget) {
        const apiName = runtimeTarget.getAttribute("data-runtime-api-name");
        const action = runtimeTarget.getAttribute("data-runtime-action");

        if (apiName && action) {
          event.preventDefault();
          event.stopPropagation();
          runRuntimeAction(apiName, action);
        }
      }
    }

    decorate();

    const observer = new MutationObserver(() => {
      clearTimeout(decorateTimer);
      decorateTimer = setTimeout(decorate, 150);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    document.addEventListener("click", handleClick, true);

    return () => {
      clearTimeout(decorateTimer);
      observer.disconnect();
      document.removeEventListener("click", handleClick, true);
      clearDecorations();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apis, runtimeBusy]);

  function selectApi(name) {
    const api = apis.find((item) => item.name === name);

    if (api) {
      applyApiToEditor(api);
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
      setMessage("Overrides saved, MI validation redeployed, probe triggered, and screen will refresh.");

      setTimeout(() => {
        window.location.reload();
      }, 1200);

      await loadOptions(selectedName);
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {runtimeMessage ? (
        <div className="api-runtime-control-toast">
          {runtimeMessage}
        </div>
      ) : null}

      {open ? (
        <div className="contract-validation-modal">
          <div className="contract-validation-modal__backdrop" onClick={() => setOpen(false)} />

          <section className="contract-validation-modal__panel">
            <div className="contract-validation-modal__header">
              <div>
                <h2>Contract validation editor</h2>
                <p>
                  Edit request and expected response contracts for the selected API, then redeploy
                  MI validation artifacts and run the probe again.
                </p>
              </div>

              <div className="contract-validation-modal__header-actions">
                <button type="button" onClick={() => loadOptions(selectedName)} disabled={loading}>
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
                    miReadiness: result.miReadiness,
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
