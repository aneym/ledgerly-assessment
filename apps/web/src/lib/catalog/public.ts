import { connection } from "next/server";
import { createPublicCatalogRepo } from "../../../../../packages/db/src/repos/public-catalog";
import { getCommerce } from "../commerce";
import type { SellerIdentity } from "../seller/identity";
import { getServer } from "../server";
import { getSession } from "../session";
import { hasPersistentCatalog } from "./published";
import { createCatalogReader } from "./reader";

function reader() {
  return createCatalogReader({
    configured: hasPersistentCatalog(process.env),
    async rows(sellerId) {
      await connection();
      return createPublicCatalogRepo(getServer().db).list(sellerId);
    },
    authz: { getSession, getSellerOwner: (id) => getCommerce().users.getSellerOwner(id) },
  });
}
/** Absent configuration supports static publication. Configured read errors propagate. */
export async function readPublicCatalog() {
  return reader().publicCatalog();
}
export async function readSellerCatalog(seller: SellerIdentity) {
  return reader().sellerCatalog(seller);
}
