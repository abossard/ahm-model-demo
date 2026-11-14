import { useState } from "react";
import { readDisclosure, writeDisclosure, type DisclosureKey } from "../model/disclosure";

/** Whether the explanation is open, how to toggle it, and whether the viewer has never opened it. */
export function useDisclosure(key: DisclosureKey): readonly [boolean, () => void, boolean] {
  const [state, setState] = useState(() => readDisclosure(key, () => window.localStorage));
  const open = state === "open";
  const toggle = (): void => {
    writeDisclosure(key, !open, () => window.localStorage);
    setState(open ? "closed" : "open");
  };
  return [open, toggle, state === "unseen"];
}
