import { DevPanel } from "./dev-panel";
import { ProfileSwitch } from "./profile-switch";

/**
 * Gate for the dev panel. Server component: it reads DEMO_MODE (the same
 * server-only flag that gates the API and the events stream) or development
 * mode, and renders the client panel only when one of them is on. The flag
 * never reaches the browser, so it cannot be flipped from there. The profile
 * switcher next to it has its own gate (DEMO_PROFILES_ENABLED) and renders
 * nothing otherwise.
 */
export function DevPanelMount() {
  const enabled = process.env.DEMO_MODE === "1" || process.env.NODE_ENV === "development";
  if (!enabled) return null;
  return (
    <>
      <ProfileSwitch next={null} />
      <DevPanel />
    </>
  );
}
