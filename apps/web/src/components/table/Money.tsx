const PREFIX: Record<string, string> = { USD: "$", EUR: "€", BRL: "R$" };

export type MoneyValue = { amountMinor: number; currency: string };

const format = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$55.20" or "−$55.20" with a true minus sign. Two decimals always. */
export function moneyText(value: MoneyValue): string {
  const prefix = PREFIX[value.currency] ?? `${value.currency} `;
  const text = format.format(Math.abs(value.amountMinor) / 100);
  return `${value.amountMinor < 0 ? "−" : ""}${prefix}${text}`;
}

/**
 * Money in a table cell or an inspector line. The sign sits in its own 1ch slot
 * so digits stay aligned; a negative keeps U+2212 and takes ink-2. The currency
 * suffix renders in mono and shows only inside a table marked data-currency="mixed",
 * or when `suffix` is set.
 */
export function Money({
  value,
  text,
  negative,
  suffix,
}: {
  value?: MoneyValue | null;
  /** Preformatted amount without its sign, when the caller already has a string. */
  text?: string;
  /** With `text`: whether to show the minus in the slot. Read from `value` otherwise. */
  negative?: boolean;
  /** Force the mono currency code after the number. */
  suffix?: boolean;
}) {
  if (!value && text === undefined) return null;
  const neg = value ? value.amountMinor < 0 : Boolean(negative);
  const body = value ? moneyText({ ...value, amountMinor: Math.abs(value.amountMinor) }) : text;
  const ccy = value?.currency;
  return (
    <span className={neg ? "money is-neg" : "money"}>
      <i className="sign">{neg ? "−" : ""}</i>
      {body}
      {ccy && <span className={suffix ? "ccy show" : "ccy"}>{ccy}</span>}
    </span>
  );
}
