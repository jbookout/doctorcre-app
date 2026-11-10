import { recordRoutes } from "../home/routes.tsx";
import { createWatchClient } from "./client.ts";
import { WatchControl } from "./control.tsx";

const client = createWatchClient();
export function HomeWatchDetail({ open_url }: { open_url: string | null }) {
  const source = recordRoutes.source({ open_url });
  if (!source) return null;
  const url = new URL(source, "https://doctorcre.invalid");
  const lease = url.pathname === "/leases" ? url.searchParams.get("lease") : null;
  if (!lease) return null;
  return (
    <section aria-label="Lease watch details">
      <p>This alert is separate from its watch. Snoozing or settling the card keeps the watch.</p>
      <WatchControl key={lease} subject={{ subject_type: "lease", subject_id: lease }} client={client} />
    </section>
  );
}
