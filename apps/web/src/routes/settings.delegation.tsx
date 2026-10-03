import { createFileRoute } from "@tanstack/react-router";

import { DelegationSettingsPanel } from "../components/settings/DelegationSettings";

export const Route = createFileRoute("/settings/delegation")({
  component: DelegationRoute,
});

function DelegationRoute() {
  return <DelegationSettingsPanel />;
}
