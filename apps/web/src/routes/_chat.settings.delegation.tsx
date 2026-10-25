import { createFileRoute } from "@tanstack/react-router";
import { DelegationSettingsPanel } from "../components/settings/DelegationSettings";

export const Route = createFileRoute("/_chat/settings/delegation")({
  component: DelegationSettingsPanel,
});
