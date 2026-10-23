import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};

describe("chatThreadActions", () => {
  it("only treats an active stored selection marked explicit as an explicit pick", () => {
    const draft = {
      activeProvider: PROJECT_DEFAULT_SELECTION.instanceId,
      modelSelectionByProvider: {
        [PROJECT_DEFAULT_SELECTION.instanceId]: PROJECT_DEFAULT_SELECTION,
      },
      modelSelectionExplicit: true,
    };

    expect(hasExplicitComposerModelSelection(draft)).toBe(true);
    expect(hasExplicitComposerModelSelection({ ...draft, modelSelectionExplicit: false })).toBe(
      false,
    );
    expect(hasExplicitComposerModelSelection({ ...draft, activeProvider: null })).toBe(false);
  });
});
