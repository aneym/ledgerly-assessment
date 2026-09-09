/** Correlation follows a purchase; a query parameter must never change its seller. */
export function checkoutHref(key: string, rawCorrelation: string | string[] | undefined): string {
  const params = new URLSearchParams({ product: key });
  const correlation = Array.isArray(rawCorrelation) ? rawCorrelation[0] : rawCorrelation;
  if (
    correlation &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlation)
  ) {
    params.set("correlationId", correlation);
  }
  return `/checkout/new?${params}`;
}
