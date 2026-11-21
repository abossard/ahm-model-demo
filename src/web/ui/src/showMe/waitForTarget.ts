/** A route, disclosure, or virtual list may mount its destination after the click. */
export function waitForTarget(find: () => Element | null, signal: AbortSignal): Promise<Element | null> {
  if (signal.aborted) return Promise.resolve(null);
  const mounted = find();
  if (mounted) return Promise.resolve(mounted);
  return new Promise(resolve => {
    function finish(element: Element | null) {
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(element);
    }
    const cancel = () => finish(null);
    const observer = new MutationObserver(() => {
      const element = find();
      if (element) finish(element);
    });
    const timer = setTimeout(cancel, 15_000);
    signal.addEventListener("abort", cancel, { once: true });
    observer.observe(document.body, { childList: true, attributes: true, subtree: true });
  });
}
