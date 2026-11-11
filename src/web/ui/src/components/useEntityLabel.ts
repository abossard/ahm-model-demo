import { useStore } from "../store/store";

/** The name a person reads for an entity of the model on screen: its display name, or the name Azure gives it. */
export function useEntityLabel(name: string | undefined): string | null {
  return useStore((state) => {
    if (name === undefined) return null;
    return state.model.kind === "success" ? (state.model.value.entities.find((entity) => entity.name === name)?.displayName ?? name) : name;
  });
}
