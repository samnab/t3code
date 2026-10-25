import { createFileRoute } from "@tanstack/react-router";
import { OptimizersSettingsPanel } from "../components/settings/OptimizersSettings";

export const Route = createFileRoute("/_chat/settings/optimizers")({
  component: OptimizersSettingsPanel,
});
