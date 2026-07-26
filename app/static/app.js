(() => {
  "use strict";

  const state = {
    data: null,
    selectedEntity: null,
    selectedCard: null,
    lastObservedAt: null,
    cards: new Map(),
    depths: new Map(),
  };

  const elements = {
    modelName: document.getElementById("model-name"),
    globalState: document.getElementById("global-state"),
    observedTime: document.getElementById("observed-time"),
    refresh: document.getElementById("refresh-button"),
    retry: document.getElementById("retry-button"),
    summary: document.getElementById("topology-summary"),
    loading: document.getElementById("loading-topology"),
    error: document.getElementById("model-error"),
    errorMessage: document.getElementById("model-error-message"),
    errorObserved: document.getElementById("model-error-observed"),
    empty: document.getElementById("model-empty"),
    topology: document.getElementById("topology"),
    entityPlane: document.getElementById("entity-plane"),
    connectors: document.getElementById("connectors"),
    discoveredLane: document.getElementById("discovered-lane"),
    discoveredEntities: document.getElementById("discovered-entities"),
    entityTemplate: document.getElementById("entity-template"),
    workspace: document.getElementById("report-workspace"),
    reportTitle: document.getElementById("report-title"),
    reportContext: document.getElementById("report-entity-context"),
    closeReport: document.getElementById("close-report"),
    form: document.getElementById("report-form"),
    signal: document.getElementById("report-signal"),
    healthState: document.getElementById("report-state"),
    value: document.getElementById("report-value"),
    reason: document.getElementById("report-reason"),
    customReasonField: document.getElementById("custom-reason-field"),
    customReason: document.getElementById("report-custom-reason"),
    customReasonError: document.getElementById("custom-reason-error"),
    expiry: document.getElementById("report-expiry"),
    previewEntity: document.getElementById("preview-entity"),
    previewSignal: document.getElementById("preview-signal"),
    previewState: document.getElementById("preview-state"),
    previewValue: document.getElementById("preview-value"),
    previewReason: document.getElementById("preview-reason"),
    previewExpiry: document.getElementById("preview-expiry"),
    submitReport: document.getElementById("submit-report"),
    reportFeedback: document.getElementById("report-feedback"),
    runJourney: document.getElementById("run-journey"),
    journeyFeedback: document.getElementById("journey-feedback"),
  };

  const statePresentation = {
    Healthy: { icon: "✓", className: "state-healthy" },
    Degraded: { icon: "△", className: "state-degraded" },
    Unhealthy: { icon: "×", className: "state-unhealthy" },
    Unknown: { icon: "?", className: "state-unknown" },
    Deleted: { icon: "⊘", className: "state-deleted" },
  };

  const feedbackPresentation = {
    pristine: { icon: "◇", className: "feedback-pristine" },
    invalid: { icon: "!", className: "feedback-invalid" },
    submitting: { icon: "↥", className: "feedback-submitting" },
    accepted: { icon: "✓", className: "feedback-accepted" },
    evaluated: { icon: "✓", className: "feedback-evaluated" },
    pending: { icon: "…", className: "feedback-pending" },
    error: { icon: "×", className: "feedback-error" },
  };

  function textNode(value) {
    return document.createTextNode(String(value));
  }

  function setText(element, value) {
    element.textContent = value == null ? "" : String(value);
  }

  function formatTime(value, unavailable = "Unavailable") {
    if (!value) {
      return unavailable;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return unavailable;
    }
    return parsed.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  }

  function setBadge(element, healthState) {
    const normalized = statePresentation[healthState] ? healthState : "Unknown";
    const presentation = statePresentation[normalized];
    element.classList.remove(
      "state-healthy",
      "state-degraded",
      "state-unhealthy",
      "state-unknown",
      "state-deleted",
    );
    element.classList.add(presentation.className);
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = presentation.icon;
    const label = document.createElement("span");
    label.textContent = normalized;
    element.replaceChildren(icon, label);
  }

  function setFeedback(feedbackState, message) {
    const presentation = feedbackPresentation[feedbackState];
    elements.reportFeedback.className =
      `report-feedback ${presentation.className}`;
    elements.reportFeedback.dataset.state = feedbackState;
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = presentation.icon;
    const label = document.createElement("span");
    label.textContent = message;
    elements.reportFeedback.replaceChildren(icon, label);
  }

  async function responseJson(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("The service returned an unexpected response.");
    }
    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload &&
        payload.error &&
        typeof payload.error.message === "string"
          ? payload.error.message
          : "The request could not be completed.";
      const error = new Error(message);
      error.status = response.status;
      error.retryable = Boolean(payload && payload.error && payload.error.retryable);
      error.operationId =
        payload && payload.error ? payload.error.operationId : null;
      throw error;
    }
    return payload;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      ...options,
    });
    return responseJson(response);
  }

  function setLoading() {
    elements.loading.hidden = false;
    elements.error.hidden = true;
    elements.empty.hidden = true;
    elements.topology.hidden = true;
    elements.topology.setAttribute("aria-busy", "true");
    elements.refresh.disabled = true;
    setText(elements.summary, "Reading entities and relationships afresh…");
  }

  function setLoadError(error) {
    elements.loading.hidden = true;
    elements.empty.hidden = true;
    elements.topology.hidden = true;
    elements.error.hidden = false;
    elements.topology.setAttribute("aria-busy", "false");
    elements.refresh.disabled = false;
    setText(elements.errorMessage, error.message);
    setText(
      elements.errorObserved,
      state.lastObservedAt
        ? `Last successful observation: ${formatTime(state.lastObservedAt)}.`
        : "No successful observation yet.",
    );
    setText(elements.summary, "Live data unavailable. Retry the read.");
    setBadge(elements.globalState, "Unknown");
    setText(elements.observedTime, "Current observation unavailable");
  }

  function calculateDepths(data) {
    const names = new Set(data.entities.map((entity) => entity.name));
    const incoming = new Map(data.entities.map((entity) => [entity.name, 0]));
    const children = new Map(data.entities.map((entity) => [entity.name, []]));
    data.relationships.forEach((relationship) => {
      if (
        names.has(relationship.parentEntityName) &&
        names.has(relationship.childEntityName)
      ) {
        incoming.set(
          relationship.childEntityName,
          incoming.get(relationship.childEntityName) + 1,
        );
        children
          .get(relationship.parentEntityName)
          .push(relationship.childEntityName);
      }
    });
    const roots = data.entities
      .filter((entity) => incoming.get(entity.name) === 0)
      .map((entity) => entity.name);
    const depths = new Map();
    const queue = roots.map((name) => [name, 0]);
    while (queue.length) {
      const [name, depth] = queue.shift();
      if (depths.has(name) && depths.get(name) <= depth) {
        continue;
      }
      depths.set(name, depth);
      children.get(name).forEach((child) => queue.push([child, depth + 1]));
    }
    return depths;
  }

  function signalSummary(entity) {
    if (!entity.signals.length) {
      return "Current signals: none reported.";
    }
    const descriptions = entity.signals.map((signal) => {
      if (signal.name === "database-connectivity-probe") {
        return `${signal.name} (${signal.healthState || "Unknown"}, read-only)`;
      }
      if (signal.name === entity.report.signalName) {
        return `${signal.name} (${signal.healthState || "Unknown"}, reportable)`;
      }
      return `${signal.name} (${signal.healthState || "Unknown"})`;
    });
    return `Current signals: ${descriptions.join("; ")}.`;
  }

  function createEntityCard(entity, previousStates) {
    const card = elements.entityTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.entityName = entity.name;
    card.dataset.depth = String(state.depths.get(entity.name) || 0);
    card.style.setProperty(
      "--entity-depth",
      String(state.depths.get(entity.name) || 0),
    );
    card.classList.toggle("positioned", Boolean(entity.canvasPosition));
    card.classList.toggle("unpositioned", !entity.canvasPosition);
    card.setAttribute(
      "aria-label",
      `${entity.displayName}, ${entity.healthState} health`,
    );

    setText(card.querySelector(".entity-impact"), `${entity.impact} impact`);
    setText(card.querySelector(".entity-display-name"), entity.displayName);
    setText(card.querySelector(".entity-name"), entity.name);
    setBadge(card.querySelector(".entity-state"), entity.healthState);
    setText(
      card.querySelector(".entity-parents"),
      entity.parents.length ? entity.parents.join(", ") : "None",
    );
    setText(
      card.querySelector(".entity-children"),
      entity.children.length ? entity.children.join(", ") : "None",
    );
    setText(
      card.querySelector(".entity-evaluation"),
      entity.latestEvaluationAt
        ? `${formatTime(entity.latestEvaluationAt)} (latest signal evaluation)`
        : "Unavailable in current signal status",
    );
    setText(
      card.querySelector(".entity-transition"),
      entity.latestTransitionAt
        ? `${formatTime(entity.latestTransitionAt)} (latest entity transition)`
        : "Unavailable until recent history is read",
    );
    setText(card.querySelector(".entity-signals"), signalSummary(entity));

    const origin = card.querySelector(".entity-origin");
    if (entity.unlinked) {
      origin.hidden = false;
      setText(origin, "Unlinked entity: Azure returned no live relationship.");
    } else if (entity.discoveredBy) {
      origin.hidden = false;
      setText(origin, `Discovered by ${entity.discoveredBy}.`);
    }

    const reportButton = card.querySelector(".report-button");
    reportButton.disabled = !entity.report.eligible;
    if (!entity.report.eligible) {
      reportButton.title = "This current entity is Deleted and is not reportable.";
    }
    reportButton.addEventListener("click", () => openReport(entity, card));
    card
      .querySelector(".detail-button")
      .addEventListener("click", () => loadEntityDetail(entity, card));

    if (
      previousStates.has(entity.name) &&
      previousStates.get(entity.name) !== entity.healthState
    ) {
      card.classList.add("state-changed");
      window.setTimeout(() => card.classList.remove("state-changed"), 180);
    }
    return card;
  }

  function populateSelect(select, options, selectedValue) {
    const optionNodes = options.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    });
    select.replaceChildren(...optionNodes);
    const available = options.some(
      (option) => String(option.value) === String(selectedValue),
    );
    select.value = available ? selectedValue : options[0].value;
  }

  function configureReportOptions(options) {
    const current = {
      signal: elements.signal.value || options.signalName,
      healthState: elements.healthState.value || "Healthy",
      value: elements.value.value || "null",
      reason: elements.reason.value || "demo-test",
      expiry: elements.expiry.value || "30",
    };
    populateSelect(
      elements.signal,
      [{ value: options.signalName, label: options.signalName }],
      current.signal,
    );
    populateSelect(
      elements.healthState,
      options.healthStates.map((value) => ({ value, label: value })),
      current.healthState,
    );
    populateSelect(
      elements.value,
      options.values.map((value) => ({
        value: value == null ? "null" : String(value),
        label: value == null ? "Not reported" : String(value),
      })),
      current.value,
    );
    populateSelect(
      elements.reason,
      options.reasonPresets,
      current.reason,
    );
    populateSelect(
      elements.expiry,
      options.expiries.map((value) => ({
        value: String(value),
        label: `${value} minute${value === 1 ? "" : "s"}`,
      })),
      current.expiry,
    );
  }

  function renderModel(data) {
    const previousStates = new Map(
      state.data
        ? state.data.entities.map((entity) => [entity.name, entity.healthState])
        : [],
    );
    state.data = data;
    state.lastObservedAt = data.observedAt;
    state.cards.clear();
    state.depths = calculateDepths(data);

    setText(
      elements.modelName,
      `${data.model.name} · ${data.model.location} · ${data.model.provisioningState}`,
    );
    setBadge(elements.globalState, data.model.healthState);
    setText(elements.observedTime, `Observed ${formatTime(data.observedAt)}`);
    setText(
      elements.summary,
      `${data.entities.length} entities · ${data.relationships.length} live relationships`,
    );
    configureReportOptions(data.reportOptions);

    elements.entityPlane.replaceChildren();
    elements.discoveredEntities.replaceChildren();
    elements.connectors.replaceChildren();

    if (!data.entities.length) {
      elements.loading.hidden = true;
      elements.error.hidden = true;
      elements.topology.hidden = true;
      elements.empty.hidden = false;
      elements.refresh.disabled = false;
      return;
    }

    data.entities.forEach((entity) => {
      const card = createEntityCard(entity, previousStates);
      state.cards.set(entity.name, card);
      if (entity.canvasPosition) {
        elements.entityPlane.append(card);
      } else {
        elements.discoveredEntities.append(card);
      }
    });
    elements.discoveredLane.hidden = !data.entities.some(
      (entity) => !entity.canvasPosition,
    );
    elements.loading.hidden = true;
    elements.error.hidden = true;
    elements.empty.hidden = true;
    elements.topology.hidden = false;
    elements.topology.setAttribute("aria-busy", "false");
    elements.refresh.disabled = false;
    window.requestAnimationFrame(layoutTopology);
  }

  function layoutTopology() {
    if (!state.data || elements.topology.hidden) {
      return;
    }
    const wide = window.matchMedia("(min-width: 1120px)").matches;
    const positioned = state.data.entities.filter(
      (entity) => entity.canvasPosition,
    );
    if (!wide || !positioned.length) {
      elements.entityPlane.style.removeProperty("height");
      state.cards.forEach((card) => {
        card.style.removeProperty("left");
        card.style.removeProperty("top");
      });
      elements.connectors.replaceChildren();
      return;
    }

    const planeWidth = elements.entityPlane.clientWidth;
    const cardWidth = 248;
    const xValues = positioned.map((entity) => Number(entity.canvasPosition.x));
    const yValues = [
      ...new Set(
        positioned.map((entity) => Number(entity.canvasPosition.y)),
      ),
    ].sort((left, right) => left - right);
    const layerHeights = yValues.map((yValue) =>
      Math.max(
        ...positioned
          .filter(
            (entity) => Number(entity.canvasPosition.y) === yValue,
          )
          .map((entity) => state.cards.get(entity.name).offsetHeight),
      ),
    );
    const layerTops = [];
    let nextLayerTop = 20;
    layerHeights.forEach((height) => {
      layerTops.push(nextLayerTop);
      nextLayerTop += height + 72;
    });
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const usableWidth = Math.max(0, planeWidth - cardWidth - 32);
    positioned.forEach((entity) => {
      const card = state.cards.get(entity.name);
      const x =
        maxX === minX
          ? usableWidth / 2
          : ((Number(entity.canvasPosition.x) - minX) / (maxX - minX)) *
            usableWidth;
      const yRank = yValues.indexOf(Number(entity.canvasPosition.y));
      card.style.left = `${16 + x}px`;
      card.style.top = `${layerTops[yRank]}px`;
    });
    elements.entityPlane.style.height =
      `${Math.max(420, nextLayerTop - 32)}px`;
    window.requestAnimationFrame(drawConnectors);
  }

  function drawConnectors() {
    if (
      !state.data ||
      !window.matchMedia("(min-width: 1120px)").matches
    ) {
      elements.connectors.replaceChildren();
      return;
    }
    const topologyRect = elements.topology.getBoundingClientRect();
    const paths = [];
    state.data.relationships.forEach((relationship) => {
      const parent = state.cards.get(relationship.parentEntityName);
      const child = state.cards.get(relationship.childEntityName);
      if (!parent || !child) {
        return;
      }
      const parentRect = parent.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      const startX = parentRect.left + parentRect.width / 2 - topologyRect.left;
      const startY = parentRect.bottom - topologyRect.top;
      const endX = childRect.left + childRect.width / 2 - topologyRect.left;
      const endY = childRect.top - topologyRect.top;
      const bend = Math.max(30, Math.abs(endY - startY) / 2);
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`,
      );
      path.setAttribute("class", "connector-line");
      path.dataset.parent = relationship.parentEntityName;
      path.dataset.child = relationship.childEntityName;
      if (
        state.selectedEntity &&
        (relationship.parentEntityName === state.selectedEntity.name ||
          relationship.childEntityName === state.selectedEntity.name)
      ) {
        path.classList.add("connector-active");
      }
      paths.push(path);
    });
    elements.connectors.setAttribute(
      "viewBox",
      `0 0 ${Math.max(1, elements.topology.scrollWidth)} ${Math.max(
        1,
        elements.topology.scrollHeight,
      )}`,
    );
    elements.connectors.replaceChildren(...paths);
  }

  async function loadModel() {
    setLoading();
    try {
      const data = await fetchJson("/api/health-model");
      renderModel(data);
    } catch (error) {
      setLoadError(error);
    }
  }

  function closeReportWorkspace(returnFocus = true) {
    elements.workspace.hidden = true;
    if (state.selectedCard) {
      state.selectedCard.removeAttribute("aria-current");
      if (returnFocus) {
        state.selectedCard.querySelector(".report-button").focus();
      }
    }
    state.selectedEntity = null;
    state.selectedCard = null;
    drawConnectors();
  }

  function currentReason() {
    if (elements.reason.value === "custom") {
      return elements.customReason.value.trim() || "Custom reason not entered";
    }
    const option = elements.reason.selectedOptions[0];
    return option ? option.textContent : "Not selected";
  }

  function updatePreview() {
    const custom = elements.reason.value === "custom";
    elements.customReasonField.hidden = !custom;
    elements.customReason.required = custom;
    if (!custom) {
      elements.customReason.removeAttribute("aria-invalid");
      elements.customReasonError.hidden = true;
      elements.customReasonField.classList.remove("field-invalid");
    }
    setText(
      elements.previewEntity,
      state.selectedEntity
        ? `${state.selectedEntity.displayName} (${state.selectedEntity.name})`
        : "Not selected",
    );
    setText(elements.previewSignal, elements.signal.value || "Not selected");
    setText(elements.previewState, elements.healthState.value || "Not selected");
    setText(
      elements.previewValue,
      elements.value.value === "null" ? "Not reported" : elements.value.value,
    );
    setText(elements.previewReason, currentReason());
    setText(
      elements.previewExpiry,
      `${elements.expiry.value} minute${
        elements.expiry.value === "1" ? "" : "s"
      }`,
    );
  }

  function openReport(entity, card) {
    if (!entity.report.eligible) {
      return;
    }
    if (state.selectedCard) {
      state.selectedCard.removeAttribute("aria-current");
    }
    state.selectedEntity = entity;
    state.selectedCard = card;
    card.setAttribute("aria-current", "true");
    elements.workspace.hidden = false;
    setText(elements.reportTitle, `Stage a report for ${entity.displayName}`);
    setText(
      elements.reportContext,
      `${entity.name} · current health ${entity.healthState} · ${entity.impact} impact`,
    );
    elements.signal.value = entity.report.signalName;
    elements.healthState.value = "Healthy";
    elements.value.value = "null";
    elements.reason.value = "demo-test";
    elements.expiry.value = "30";
    elements.customReason.value = "";
    elements.submitReport.disabled = false;
    setFeedback("pristine", "Choose values and review the exact report.");
    updatePreview();
    drawConnectors();
    elements.workspace.scrollIntoView({ block: "start" });
    elements.signal.focus();
  }

  function validateReport() {
    if (!state.selectedEntity) {
      setFeedback("invalid", "Select a current entity first.");
      return false;
    }
    if (elements.reason.value === "custom") {
      const value = elements.customReason.value.trim();
      if (!value || value.length > 280) {
        elements.customReason.setAttribute("aria-invalid", "true");
        elements.customReasonError.hidden = false;
        elements.customReasonField.classList.add("field-invalid");
        setFeedback("invalid", "Enter a custom reason before submitting.");
        elements.customReason.focus();
        return false;
      }
    }
    elements.customReason.removeAttribute("aria-invalid");
    elements.customReasonError.hidden = true;
    elements.customReasonField.classList.remove("field-invalid");
    return true;
  }

  function reportRequestBody() {
    const body = {
      signalName: elements.signal.value,
      healthState: elements.healthState.value,
      value:
        elements.value.value === "null"
          ? null
          : Number(elements.value.value),
      reasonPreset: elements.reason.value,
      expiresInMinutes: Number(elements.expiry.value),
    };
    if (elements.reason.value === "custom") {
      body.customReason = elements.customReason.value.trim();
    }
    return body;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function evaluationMatches(detail, accepted) {
    const current = detail.canonicalSignal.current;
    const observations = [
      ...(current ? [current] : []),
      ...detail.canonicalSignal.history,
    ];
    return observations.some(
      (observation) =>
        observation.reportId === accepted.reportId &&
        observation.healthState === accepted.requestedState,
    );
  }

  async function pollForEvaluation(accepted) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(2000);
      try {
        const detail = await fetchJson(
          `/api/entities/${encodeURIComponent(accepted.entityName)}`,
        );
        if (evaluationMatches(detail, accepted)) {
          setFeedback(
            "evaluated",
            `${accepted.requestedState} was evaluated for the matching report correlation.`,
          );
          await loadModel();
          return;
        }
      } catch (_error) {
        // Acceptance remains true even when a later observation is unavailable.
      }
    }
    setFeedback(
      "pending",
      "Accepted, but matching evaluation was not observed before polling ended.",
    );
  }

  async function submitReport(event) {
    event.preventDefault();
    if (!validateReport()) {
      return;
    }
    const entity = state.selectedEntity;
    const requestBody = reportRequestBody();
    elements.submitReport.disabled = true;
    setFeedback("submitting", "Submitting one report to Azure…");
    try {
      const accepted = await fetchJson(
        `/api/entities/${encodeURIComponent(entity.name)}/health-reports`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        },
      );
      setFeedback(
        "accepted",
        `Accepted as ${accepted.reportId}. Waiting for Azure evaluation.`,
      );
      await pollForEvaluation(accepted);
    } catch (error) {
      const correlation = error.operationId
        ? ` Operation ${error.operationId}.`
        : "";
      const retry = error.retryable ? " You can retry." : "";
      setFeedback("error", `${error.message}${correlation}${retry}`);
    } finally {
      elements.submitReport.disabled = false;
    }
  }

  function appendDetailLine(container, label, value) {
    const paragraph = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    paragraph.append(strong, textNode(value));
    container.append(paragraph);
  }

  async function loadEntityDetail(entity, card) {
    const detailContainer = card.querySelector(".entity-detail");
    const detailButton = card.querySelector(".detail-button");
    detailContainer.hidden = false;
    detailContainer.replaceChildren(textNode("Reading recent history…"));
    detailButton.disabled = true;
    try {
      const detail = await fetchJson(
        `/api/entities/${encodeURIComponent(entity.name)}`,
      );
      detailContainer.replaceChildren();
      if (detail.transitions.length) {
        detail.transitions.slice(0, 3).forEach((transition) => {
          appendDetailLine(
            detailContainer,
            `${transition.previousState || "Unknown"} to ${transition.healthState}`,
            `${formatTime(transition.occurredAt)} (entity transition)`,
          );
        });
        setText(
          card.querySelector(".entity-transition"),
          `${formatTime(detail.transitions[0].occurredAt)} (latest entity transition)`,
        );
      } else {
        appendDetailLine(
          detailContainer,
          "Entity transitions",
          "No recent transitions in the server-owned window",
        );
      }
      if (detail.canonicalSignal.history.length) {
        appendDetailLine(
          detailContainer,
          "Latest report signal",
          `${detail.canonicalSignal.history[0].healthState} at ${formatTime(
            detail.canonicalSignal.history[0].occurredAt,
          )} (signal evaluation)`,
        );
      } else {
        appendDetailLine(
          detailContainer,
          "Report signal history",
          "No recent canonical signal points",
        );
      }
    } catch (error) {
      detailContainer.replaceChildren();
      appendDetailLine(detailContainer, "History unavailable", error.message);
    } finally {
      detailButton.disabled = false;
    }
  }

  async function runJourney() {
    elements.runJourney.disabled = true;
    setText(
      elements.journeyFeedback,
      "Running one Queue and PostgreSQL request journey…",
    );
    try {
      const result = await fetchJson("/api/demo-request", { method: "POST" });
      const queueHead = result.queue_head
        ? `${result.queue_head.request_id} (${result.queue_head.label})`
        : "none visible";
      setText(
        elements.journeyFeedback,
        `Completed request ${result.request_id}. Queue message ${result.just_enqueued.message_id}. Queue head ${queueHead}. PostgreSQL rows ${result.row_count}.`,
      );
    } catch (error) {
      setText(elements.journeyFeedback, `Request journey failed. ${error.message}`);
    } finally {
      elements.runJourney.disabled = false;
    }
  }

  elements.refresh.addEventListener("click", loadModel);
  elements.retry.addEventListener("click", loadModel);
  elements.closeReport.addEventListener("click", () => closeReportWorkspace());
  elements.form.addEventListener("submit", submitReport);
  elements.form.addEventListener("input", updatePreview);
  elements.form.addEventListener("change", updatePreview);
  elements.runJourney.addEventListener("click", runJourney);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.workspace.hidden) {
      closeReportWorkspace();
    }
  });

  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame !== null) {
      window.cancelAnimationFrame(resizeFrame);
    }
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null;
      layoutTopology();
    });
  });

  loadModel();
})();
