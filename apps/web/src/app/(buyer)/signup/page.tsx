import type { Metadata } from "next";
import { Shell } from "@/components";
import { AuthForm } from "@/components/buyer/AuthForm";

export const metadata: Metadata = { title: "Create your account · Ledgerly" };

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export default async function SignUpPage(props: PageProps<"/signup">) {
  const search = await props.searchParams;
  return (
    <Shell screen="signup">
      <div className="by-wash">
        <div className="by-auth">
          <section className="by-auth-card" aria-labelledby="signup-title">
            <h1 id="signup-title" className="by-h1">
              Create your account
            </h1>
            <AuthForm
              mode="signup"
              next={first(search.next)}
              correlationId={first(search.correlationId)}
            />
          </section>
        </div>
      </div>
    </Shell>
  );
}
