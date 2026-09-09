import type { Metadata } from "next";
import { Shell } from "@/components";
import { AuthForm } from "@/components/buyer/AuthForm";

export const metadata: Metadata = { title: "Sign in · Ledgerly" };

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export default async function SignInPage(props: PageProps<"/signin">) {
  const search = await props.searchParams;
  return (
    <Shell screen="signin">
      <div className="by-wash">
        <div className="by-auth">
          <section className="by-auth-card" aria-labelledby="signin-title">
            <h1 id="signin-title" className="by-h1">
              Sign in
            </h1>
            <AuthForm
              mode="signin"
              next={first(search.next)}
              correlationId={first(search.correlationId)}
            />
          </section>
        </div>
      </div>
    </Shell>
  );
}
