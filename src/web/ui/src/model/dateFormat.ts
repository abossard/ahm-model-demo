/** A formatter per time zone, built once: making an `Intl.DateTimeFormat` costs far more than formatting with it. */
export function formatterByZone(options: Intl.DateTimeFormatOptions): (timeZone?: string) => Intl.DateTimeFormat {
  const cache = new Map<string | undefined, Intl.DateTimeFormat>();
  return (timeZone) => {
    let formatter = cache.get(timeZone);
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat("en-GB", { ...options, ...(timeZone === undefined ? {} : { timeZone }) });
      cache.set(timeZone, formatter);
    }
    return formatter;
  };
}
