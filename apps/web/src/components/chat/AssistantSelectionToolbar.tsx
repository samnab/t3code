import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect } from "react";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { readLocalApi } from "../../localApi";

/**
 * Right-click on selected assistant text offers to cite it in the composer,
 * in place of the platform's cut-and-paste menu.
 */
export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  useEffect(() => {
    if (!viewport) return;
    const onContextMenu = (event: MouseEvent) => {
      const captured = captureAssistantTextSelection(viewport, window.getSelection());
      const messageId = captured?.source.dataset.assistantCitationSource;
      const api = readLocalApi();
      if (!captured || !messageId || captured.selector.text.length === 0 || !api) return;
      event.preventDefault();
      event.stopPropagation();
      const citation: AssistantCitation = {
        version: 1,
        ...threadRef,
        messageId: MessageId.make(messageId),
        ...captured.selector,
      };
      const tooLong = citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
      void api.contextMenu
        .show(
          [
            { id: "cite", label: "Cite in composer", disabled: tooLong },
            { id: "copy", label: "Copy" },
          ],
          { x: event.clientX, y: event.clientY },
        )
        .then((action) => {
          if (action === "copy") {
            void navigator.clipboard.writeText(citation.text);
          } else if (action === "cite") {
            const sourceAnchor = { source: captured.source, range: captured.range, viewport };
            if (onCite(citation, sourceAnchor)) window.getSelection()?.removeAllRanges();
          }
        });
    };
    viewport.addEventListener("contextmenu", onContextMenu, true);
    return () => viewport.removeEventListener("contextmenu", onContextMenu, true);
  }, [onCite, threadRef, viewport]);

  return null;
}
