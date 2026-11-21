import { useEffect, useState } from "react";
import { MODEL_PREFIX_LIMIT, modelNameSuggestions } from "./modelNameSuggestions";
import {
  errorMessage,
  type AzureResource,
  type BuilderTools,
  type ResourceGroup,
  type ResourceScope,
} from "./types";

interface Props {
  tools: BuilderTools;
  initial?: Partial<ResourceScope>;
  busy: boolean;
  onAnalyze: (scope: ResourceScope) => void;
}

const toggle = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];

export function ResourcesStep({ tools, initial, busy, onAnalyze }: Props) {
  const [scope, setScope] = useState<ResourceScope>({
    groupIds: initial?.groupIds ?? [],
    resourceIds: initial?.resourceIds ?? [],
    modelName: initial?.modelName ?? "",
    destinationGroupId: initial?.destinationGroupId ?? "",
  });
  const [groups, setGroups] = useState<ResourceGroup[] | null>(null);
  const [groupId, setGroupId] = useState(initial?.groupIds?.[0] ?? initial?.destinationGroupId ?? "");
  const [resources, setResources] = useState<AzureResource[] | null>(null);
  const [groupError, setGroupError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    setGroupError("");
    tools
      .groups()
      .then(({ groups: found }) => {
        if (!current) return;
        setGroups(found);
        setGroupId((previous) => (found.some((g) => g.id === previous) ? previous : (found[0]?.id ?? "")));
        setScope((previous) => ({
          ...previous,
          destinationGroupId: found.some((g) => g.id === previous.destinationGroupId)
            ? previous.destinationGroupId
            : (found[0]?.id ?? ""),
        }));
      })
      .catch((error) => {
        if (current) setGroupError(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, [tools, retry]);

  useEffect(() => {
    let current = true;
    setResources(null);
    setResourceError("");
    if (groupId)
      tools
        .resources(groupId)
        .then((result) => {
          if (current) setResources(result.resources);
        })
        .catch((error) => {
          if (current) setResourceError(errorMessage(error));
        });
    return () => {
      current = false;
    };
  }, [tools, groupId, retry]);

  const wholeGroup = scope.groupIds.includes(groupId);
  const group = groups?.find((g) => g.id === groupId);
  const destination = groups?.find((g) => g.id === scope.destinationGroupId);
  const selected = scope.groupIds.length + scope.resourceIds.length;
  const groupOptions = groups?.map((g) => (
    <option
      key={g.id}
      value={g.id}
      disabled={Boolean(selected && group && group.subscriptionId !== g.subscriptionId)}
    >
      {g.name} · {g.subscriptionId}
    </option>
  ));
  function browse(id: string) {
    setGroupId(id);
    const next = groups?.find((g) => g.id === id);
    if (next && !selected && destination?.subscriptionId !== next.subscriptionId) {
      setScope((previous) => ({ ...previous, destinationGroupId: id }));
    }
  }
  function toggleGroup() {
    const prefix = groupId.toLowerCase() + "/";
    setScope((previous) => ({
      ...previous,
      groupIds: toggle(previous.groupIds, groupId),
      resourceIds: previous.resourceIds.filter((id) => !id.toLowerCase().startsWith(prefix)),
    }));
  }
  function submit() {
    if (!busy && selected && scope.destinationGroupId && scope.modelName.trim())
      onAnalyze({ ...scope, modelName: scope.modelName.trim() });
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="builder-stack"
    >
      <h2>Select Azure resources</h2>
      <p className="lead">
        Include resource groups or individual resources from one subscription, up to 32 resources in total.
      </p>
      {groupError ? (
        <div role="alert" className="error">
          {groupError}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : groups === null ? (
        <p role="status">Loading your resource groups…</p>
      ) : !groups.length ? (
        <p role="status">No resource groups are available in this directory.</p>
      ) : (
        <>
          <div className="section">
            <label className="field">
              Browse resource group
              <select value={groupId} onChange={(event) => browse(event.target.value)}>
                {groupOptions}
              </select>
            </label>
            {group && (
              <label className="group-choice">
                <input
                  type="checkbox"
                  checked={wholeGroup}
                  disabled={!wholeGroup && (resources === null || resources.length > 32)}
                  onChange={toggleGroup}
                />
                Include the entire {group.name} resource group
              </label>
            )}
            {resources && resources.length > 32 && (
              <small>Choose individual resources from this group. It exceeds the 32-resource limit.</small>
            )}
            {resourceError ? (
              <div role="alert" className="error">
                {resourceError}{" "}
                <button type="button" onClick={() => setRetry((n) => n + 1)}>
                  Retry resource list
                </button>
              </div>
            ) : resources === null ? (
              <p className="muted" role="status">
                Loading resources…
              </p>
            ) : !resources.length ? (
              <p className="muted">This resource group has no listed resources.</p>
            ) : (
              <fieldset className="resource-list" aria-label="Resources in this group">
                {resources.map((resource) => (
                  <label className="resource" key={resource.id}>
                    <input
                      type="checkbox"
                      checked={wholeGroup || scope.resourceIds.includes(resource.id)}
                      disabled={
                        wholeGroup || (scope.resourceIds.length >= 32 && !scope.resourceIds.includes(resource.id))
                      }
                      onChange={() =>
                        setScope((previous) => ({
                          ...previous,
                          resourceIds: toggle(previous.resourceIds, resource.id),
                        }))
                      }
                    />
                    <span>
                      <strong>{resource.name}</strong>
                      <small>
                        {resource.type}
                        {resource.location ? " · " + resource.location : ""}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <p className="muted selection-count" role="status">
              {scope.groupIds.length} resource {scope.groupIds.length === 1 ? "group" : "groups"} and{" "}
              {scope.resourceIds.length} individual {scope.resourceIds.length === 1 ? "resource" : "resources"}{" "}
              selected
            </p>
          </div>
          <fieldset className="destination">
            <legend>New model destination</legend>
            <div className="field-grid">
              <div className="model-name-field">
                <label className="field">
                  Model name prefix
                  <input
                    required
                    autoComplete="off"
                    maxLength={MODEL_PREFIX_LIMIT}
                    pattern={"[A-Za-z]([A-Za-z0-9\\-]{0,25}[A-Za-z0-9])?"}
                    title="Use 1 to 27 letters, digits or hyphens. Begin with a letter and end with a letter or digit."
                    value={scope.modelName}
                    placeholder="e.g. orders"
                    onChange={(event) => setScope({ ...scope, modelName: event.target.value })}
                  />
                </label>
                <div className="name-suggestions" role="group" aria-label="Suggested model names">
                  <span>Suggestions</span>
                  {modelNameSuggestions(scope).map(name => (
                    <button key={name} type="button" aria-pressed={scope.modelName === name} disabled={busy}
                      onClick={() => setScope(previous => ({ ...previous, modelName: name }))}>
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                Destination resource group
                <select
                  required
                  value={scope.destinationGroupId}
                  onChange={(event) => {
                    const id = event.target.value;
                    if (!selected && groups.find((g) => g.id === id)?.subscriptionId !== group?.subscriptionId)
                      setGroupId(id);
                    setScope({ ...scope, destinationGroupId: id });
                  }}
                >
                  {groupOptions}
                </select>
              </label>
            </div>
            {destination && (
              <small>
                Subscription {destination.subscriptionId}. The preview shows the final unique model name.
              </small>
            )}
          </fieldset>
          <div className="actions">
            <button
              className="primary"
              type="button"
              onClick={(event) => {
                if (event.currentTarget.form?.reportValidity()) submit();
              }}
              disabled={busy || !selected || !scope.modelName.trim() || !scope.destinationGroupId}
            >
              Analyze resources
            </button>
          </div>
        </>
      )}
    </form>
  );
}
