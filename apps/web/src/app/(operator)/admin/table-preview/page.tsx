import type { Metadata } from "next";
import { TablePreview } from "./preview";

export const metadata: Metadata = { title: "Table preview, Ledgerly operator" };

/**
 * Every state of the shared table system on one page, with fixture rows, so it
 * can be screenshotted at 1280 and 390. Not a product screen.
 */
export default function TablePreviewPage() {
  return (
    <div data-screen="admin.table-preview">
      <TablePreview />
    </div>
  );
}
