import { displaySeller } from "@/lib/catalog/display-name";
import type { Issue, LedgerRow, SellerRef } from "./types";

/**
 * The operator screens show business names, never external ids. Every record that
 * carries a seller block passes through here once, at the data boundary, so the rows,
 * inspectors, picker and assistant card all agree.
 */

export function displayRef<T extends SellerRef>(seller: T): T {
  return { ...seller, name: displaySeller({ id: seller.id, name: seller.name }).name };
}

export function displayRow(row: LedgerRow): LedgerRow {
  return { ...row, seller: displayRef(row.seller) };
}

export function displayIssue(issue: Issue): Issue {
  if (!issue.seller) return issue;
  const name = displaySeller({ id: issue.seller.id, name: issue.seller.name }).name;
  return { ...issue, seller: { ...issue.seller, name } };
}
