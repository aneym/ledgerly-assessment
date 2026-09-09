/**
 * Test identities for the dev panel and the guided tour: names and emails only, so no
 * password ever reaches a browser bundle. The rows mirror fixtures/demo/test-users.json
 * (test/dev-identities.test.ts keeps them equal). Signing in as a profile goes through
 * /demo/profile/<role> (lib/demo-profile-url.ts), which mints the session server-side;
 * `newBuyer()` mints a unique email for a real sign-up so the database gets a new row
 * each run.
 */

export type SellerCountry = "US" | "DE" | "BR" | "CA" | "KR" | "PT";

export type Identity = { name: string; email: string };
export type SellerIdentity = Identity & { country: SellerCountry };
export type SellerFormValues = { name: string; email: string; country: SellerCountry };

export type SampleProduct = {
  title: string;
  subtitle: string;
  category: string;
  price: string;
  description: string;
  fileName: string;
  coverName: string;
};

export type TestIdentities = {
  buyer: Identity;
  seller: SellerIdentity;
  operator: Identity;
  sellerForms: Partial<Record<SellerCountry, SellerFormValues>> &
    Record<"US" | "DE" | "BR", SellerFormValues>;
  sampleProduct: SampleProduct;
};

export const TEST_IDENTITIES: TestIdentities = {
  buyer: { name: "Ada Buyer", email: "buyer.demo@ledgerly.test" },
  seller: { name: "Onda Sounds", email: "onda@ledgerly.test", country: "BR" },
  operator: { name: "Ledgerly Ops", email: "ops.demo@ledgerly.test" },
  sellerForms: {
    US: { name: "Mara Okonkwo", email: "mara@ledgerly.test", country: "US" },
    DE: { name: "Studio Kontur", email: "kontur@ledgerly.test", country: "DE" },
    BR: { name: "Onda Sounds", email: "onda@ledgerly.test", country: "BR" },
  },
  sampleProduct: {
    title: "Onda Drum Library",
    subtitle: "600 one-shots and loops",
    category: "Audio",
    price: "25.00",
    description:
      "Drums recorded in Sao Paulo. 600 one-shots and 40 loops as 24-bit WAV, sorted by kit. For producers who want acoustic weight without samples that everyone already has.",
    fileName: "onda-drum-library-sample.zip",
    coverName: "onda-drum-library-cover.png",
  },
};

const pad = (n: number) => String(n).padStart(2, "0");

/** buyer+20260908-143012@ledgerly.test, local time, so two runs never collide within a second. */
export function newBuyer(at: Date = new Date()): Identity & { password: string } {
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return {
    name: TEST_IDENTITIES.buyer.name,
    email: `buyer+${stamp}@ledgerly.test`,
    // A throwaway for the sign-up form of a brand-new fictional account, not a stored credential.
    password: `demo-${stamp}-signup`,
  };
}
