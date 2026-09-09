import { createFileRoute } from "@tanstack/react-router";

import { OptimizersSettingsPanel } from "../components/settings/OptimizersSettings";

export const Route = createFileRoute("/settings/optimizers")({
  component: OptimizersRoute,
});

function OptimizersRoute() {
  return <OptimizersSettingsPanel />;
}
