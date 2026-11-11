import type { ModelRef, ModelSelection } from "./types";

export const MODEL_LIST_LIMIT = 50;
const SUBSCRIPTION_HINT_LENGTH = 8;

export interface ModelGroup {
  readonly subscriptionId: string;
  readonly models: readonly ModelRef[];
}

export interface ModelListing {
  readonly groups: readonly ModelGroup[];
  readonly shown: number;
  readonly total: number;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function modelKey(model: ModelSelection): string {
  return `${model.subscriptionId}/${model.resourceGroup}/${model.name}`;
}

export function subscriptionHint(subscriptionId: string): string {
  return subscriptionId.slice(0, SUBSCRIPTION_HINT_LENGTH);
}

export function sortModelsByNameThenGroup(
  models: readonly ModelRef[],
): readonly ModelRef[] {
  return [...models].sort(
    (left, right) =>
      normalized(left.name).localeCompare(normalized(right.name)) ||
      normalized(left.resourceGroup).localeCompare(normalized(right.resourceGroup)) ||
      normalized(left.subscriptionId).localeCompare(normalized(right.subscriptionId)),
  );
}

export function filterModels(
  models: readonly ModelRef[],
  query: string,
): readonly ModelRef[] {
  const needle = normalized(query);
  if (!needle) return models;
  return models.filter(
    (item) =>
      normalized(item.name).includes(needle) ||
      normalized(item.resourceGroup).includes(needle) ||
      normalized(item.subscriptionId).includes(needle),
  );
}

/**
 * Filters, sorts and caps the catalog for the picker, then groups what is left by subscription,
 * the default subscription first, so a few hundred models never reach the DOM at once.
 */
export function listModels(
  models: readonly ModelRef[],
  query: string,
  defaultSubscriptionId: string,
  limit: number = MODEL_LIST_LIMIT,
): ModelListing {
  const matches = sortModelsByNameThenGroup(filterModels(models, query));
  const shown = matches.slice(0, limit);
  const bySubscription = new Map<string, ModelRef[]>();
  for (const model of shown) {
    const group = bySubscription.get(model.subscriptionId);
    if (group) group.push(model);
    else bySubscription.set(model.subscriptionId, [model]);
  }
  const groups = [...bySubscription]
    .map(([subscriptionId, members]) => ({ subscriptionId, models: members }))
    .sort(
      (left, right) =>
        Number(right.subscriptionId === defaultSubscriptionId) -
          Number(left.subscriptionId === defaultSubscriptionId) ||
        left.subscriptionId.localeCompare(right.subscriptionId),
    );
  return { groups, shown: shown.length, total: matches.length };
}
