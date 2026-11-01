import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { sidebarMarkerId } from "../Sidebar.logic";
import { SidebarSectionPlaceholder } from "./SidebarListMarkers";

// The sidebar strategy gives every item a transform once a drag starts.
const stationary: SortingStrategy = () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1 });

function Row() {
  const { setNodeRef, listeners } = useSortable({ id: "row" });
  return (
    <li ref={setNodeRef} {...listeners} data-testid="row" style={{ height: 40 }}>
      Row
    </li>
  );
}

function Fixture() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 1 } }));
  return (
    <DndContext sensors={sensors} autoScroll={false}>
      <SortableContext
        items={["row", sidebarMarkerId("settled-placeholder")]}
        strategy={stationary}
      >
        <div data-testid="scroller" style={{ height: 160, overflow: "auto" }}>
          <ul>
            <Row />
            <li style={{ height: 2000 }} />
            <SidebarSectionPlaceholder
              marker="settled-placeholder"
              label="Settled"
              showHint
              isDropTarget={false}
            />
          </ul>
        </div>
      </SortableContext>
    </DndContext>
  );
}

function pointer(type: string, target: EventTarget, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: 10,
      clientY: y,
    }),
  );
}

describe("SidebarSectionPlaceholder", () => {
  it("leaves the list scroll alone when a drag starts with the drop hint far out of view", async () => {
    await using screen = await render(<Fixture />, { router: false });
    const scroller = screen.getByTestId("scroller").element();
    const row = screen.getByTestId("row").element();
    const { top } = row.getBoundingClientRect();

    pointer("pointerdown", row, top + 5);
    pointer("pointermove", document, top + 15);
    const hint = screen.getByTestId("sidebar-settled-placeholder").element();
    // The reveal effect runs in the same commit that applies the drag transform.
    await vi.waitFor(() =>
      expect(getComputedStyle(hint).transform !== "none" || scroller.scrollTop !== 0).toBe(true),
    );

    expect(scroller.scrollTop).toBe(0);
    pointer("pointerup", document, top + 15);
  });
});
