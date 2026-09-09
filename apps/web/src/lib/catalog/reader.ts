import type { PublicCatalogRow } from "../../../../../packages/db/src/repos/public-catalog";
import { type AuthzDeps, authorizeSeller } from "../authz";
import type { SellerIdentity } from "../seller/identity";
import { fixtureCatalog, projectCatalog } from "./published";

export function createCatalogReader(deps: {
  configured: boolean;
  rows: (sellerId?: string) => Promise<PublicCatalogRow[]>;
  authz: AuthzDeps;
}) {
  return {
    async publicCatalog() {
      return deps.configured ? projectCatalog(await deps.rows()) : fixtureCatalog();
    },
    async sellerCatalog(seller: Pick<SellerIdentity, "id" | "source">) {
      if (!deps.configured) {
        const catalog = fixtureCatalog();
        return {
          ...catalog,
          products:
            seller.source === "demo"
              ? catalog.products.filter((p) => p.sellerId === seller.id)
              : [],
        };
      }
      const authz = await authorizeSeller(deps.authz, seller.id);
      if (!authz.ok) return { ...projectCatalog([]), forbidden: true };
      return projectCatalog(await deps.rows(seller.id));
    },
  };
}
