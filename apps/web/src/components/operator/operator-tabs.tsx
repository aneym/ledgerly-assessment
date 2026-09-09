"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/sellers", label: "Sellers" },
  { href: "/admin/ledger", label: "Ledger" },
  { href: "/admin/issues", label: "Issues" },
] as const;

export function OperatorTabs() {
  const pathname = usePathname();
  return (
    <nav className="op-tabs" aria-label="Operator">
      {TABS.map((tab) => {
        const current = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link key={tab.href} href={tab.href} aria-current={current ? "page" : undefined}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
