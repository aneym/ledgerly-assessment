import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidRunId } from "./demo-profiles";

export const PROFILE_BINDING_COOKIE = "ledgerly_demo_profile";

/** The proof binds the issued run to the actual Better Auth user, not an email claim. */
export function profileBinding(userId: string, run: string, secret: string): string {
  if (!secret || !userId || !isValidRunId(run)) throw new Error("Invalid demo profile binding");
  return createHmac("sha256", secret)
    .update(JSON.stringify(["ledgerly-demo-profile-v1", userId, run]))
    .digest("hex");
}

export function hasProfileBinding(
  headers: Headers,
  userId: string,
  run: string,
  secret: string,
): boolean {
  if (!secret || !userId || !isValidRunId(run)) return false;
  const values = (headers.get("cookie") ?? "").split(";").flatMap((part) => {
    const [name, ...value] = part.trim().split("=");
    return name === PROFILE_BINDING_COOKIE ? [value.join("=")] : [];
  });
  if (values.length !== 1 || !/^[a-f0-9]{64}$/.test(values[0] ?? "")) return false;
  return timingSafeEqual(
    Buffer.from(values[0] as string, "hex"),
    Buffer.from(profileBinding(userId, run, secret), "hex"),
  );
}
