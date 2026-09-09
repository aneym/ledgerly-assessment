import Link from "next/link";
import type { ReactNode } from "react";
import { getSession } from "@/lib/session";
import { WhopMark } from "./brand/WhopMark";
import { Wordmark } from "./brand/Wordmark";
import { DevPanelMount } from "./dev/dev-panel-mount";
import { SearchIcon } from "./icons";
import { PillLink } from "./pill";

type Props = {
  /** data-screen for the tour overlay. */
  screen: string;
  /** Which top link is current. */
  section?: "browse" | "creators" | "sell";
  searchQuery?: string;
  children: ReactNode;
};

/** Nav plus footer around every screen. Server component: reads the session for the user slot. */
export async function Shell({ screen, section, searchQuery = "", children }: Props) {
  const session = await getSession();
  return (
    <div className="screen" data-screen={screen}>
      <header className="nav">
        <div className="wrap">
          <Wordmark variant="nav" />
          <nav className="navlinks" aria-label="Main">
            <Link href="/browse" aria-current={section === "browse" ? "page" : undefined}>
              Browse
            </Link>
            <Link href="/#creators" aria-current={section === "creators" ? "page" : undefined}>
              Creators
            </Link>
            <Link
              href="/sell"
              aria-current={section === "sell" ? "page" : undefined}
              data-tour="home.nav.sell"
            >
              Sell on Ledgerly
            </Link>
          </nav>
          <form className="search" action="/browse" method="get">
            <SearchIcon />
            <input
              key={searchQuery}
              type="search"
              name="q"
              defaultValue={searchQuery}
              placeholder="Search products and creators"
              aria-label="Search products and creators"
              data-tour="home.search"
            />
          </form>
          <div className="navend">
            {session ? (
              <>
                <Link className="navlink" href="/library">
                  Library
                </Link>
                <Link className="navlink" href="/account" data-tour="home.nav.signin">
                  Account
                </Link>
              </>
            ) : (
              <Link className="navlink" href="/signin" data-tour="home.nav.signin">
                Sign in
              </Link>
            )}
            {section === "sell" ? null : (
              <PillLink tone="ink" size="sm" href="/sell">
                Start selling
              </PillLink>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
      <DevPanelMount />
      <footer className="storefoot">
        <div className="wrap">
          <Wordmark variant="footer" />
          <i aria-hidden="true" />
          <span>Every price shows the 8% fee before checkout.</span>
          <i aria-hidden="true" />
          <span>
            Payments by <WhopMark />
          </span>
          <i aria-hidden="true" />
          <Link href="/handoff">Handoff</Link>
        </div>
      </footer>
    </div>
  );
}
