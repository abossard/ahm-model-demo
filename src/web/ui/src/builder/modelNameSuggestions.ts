import type { ResourceScope } from "./types";

export const MODEL_PREFIX_LIMIT = 27;

function workloadName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .replace(/^(?:rg|hm|ca|app|func|vm|sql|aks)-/, "");
}

function sharedName(names: string[]): string {
  const words = (names[0] ?? "").split("-");
  while (words.length) {
    const stem = words.join("-");
    if (names.every(name => name === stem || name.startsWith(stem + "-"))) return stem;
    words.pop();
  }
  return "";
}

export function modelNameSuggestions({ groupIds, resourceIds }: Pick<ResourceScope, "groupIds" | "resourceIds">): string[] {
  const ids = [...groupIds, ...resourceIds];
  const names = ids.map(id => workloadName(id.split("/").pop() ?? "")).filter(Boolean);
  const groups = ids.map(id => workloadName(id.match(/\/resourceGroups\/([^/]+)/i)?.[1] ?? "")).filter(Boolean);
  const group = sharedName(groups);
  const workload = sharedName(names) || group || "workload";
  function format(stem: string, prefix: string, suffix = "") {
    const start = prefix || (/^[a-z]/.test(stem) ? "" : "hm-");
    const body = stem.slice(0, MODEL_PREFIX_LIMIT - start.length - suffix.length).replace(/-+$/, "");
    return start + body + suffix;
  }
  const suggestions = [format(workload, "hm-")];
  if (group && group !== workload) suggestions.push(format(group, "hm-"));
  suggestions.push(format(workload, "", "-health"), format(workload, "", "-availability"));
  return [...new Set(suggestions)].slice(0, 3);
}
