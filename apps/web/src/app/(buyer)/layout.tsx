import "@/components/buyer/buyer.css";

// Fonts come from the root layout (Fraunces with opsz and italic, Geist, Geist Mono).
export default function BuyerLayout({ children }: LayoutProps<"/">) {
  return <div className="contents">{children}</div>;
}
