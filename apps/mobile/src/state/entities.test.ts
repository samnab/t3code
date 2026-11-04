import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadFamily,
} from "@t3tools/contracts";
import {
  presentThreadShell,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";

const fixture = vi.hoisted(() => ({ registry: null as AtomRegistry.AtomRegistry | null }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: <A>(atom: Atom.Atom<A>) => fixture.registry!.get(atom),
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./projects", () => ({ environmentProjects: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("./assets", () => ({ projectFaviconUrlAtom: {} }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: {},
  projectGlyphKey: {},
}));
vi.mock("./threads", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const shells = Atom.make<ReadonlyMap<string, ReturnType<typeof presentThreadShell>>>(new Map());
  const family = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, string>>(
    AsyncResult.initial(),
  );
  return {
    environmentThreadDetails: {},
    environmentThreadShells: {
      threadShellAtom: (ref: { threadId: string }) =>
        Atom.make((get) => get(shells).get(ref.threadId) ?? null),
      threadRefsAtom: Atom.make([]),
    },
    threadFamilies: { familyAtom: () => family },
    testAtoms: { shells, family },
  };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/reactivity");
  const { EMPTY_SHELL_STATE } = await import("@t3tools/client-runtime/state/shell");
  const state = Atom.make(EMPTY_SHELL_STATE);
  return { environmentShell: { stateValueAtom: () => state }, testShell: state };
});

import { resolveThreadLink, useLiveThreadLinkLabels } from "./entities";

const environmentId = EnvironmentId.make("7a31051f-0548-4565-b69f-360ed083efb5");
const threadId = ThreadId.make("56032bd4-f15e-4d85-8e84-e3c1a58ae546");
const href = `t3-thread://v2/${environmentId}/${threadId}`;
const markdown = `Resumed <${href}> with Opus on high, fast mode off.`;
const target = {
  ...v2ThreadShell,
  id: threadId,
  projectId: ProjectId.make("synthetic-other-project"),
  title: "Plan Recurring Cashflows for Instruments",
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
} satisfies typeof v2ThreadShell;

async function setup() {
  const { testAtoms } = await vi.importMock<{
    testAtoms: {
      shells: Atom.Writable<ReadonlyMap<string, ReturnType<typeof presentThreadShell>>>;
      family: Atom.Writable<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, string>>;
    };
  }>("./threads");
  const { testShell } = await vi.importMock<{ testShell: Atom.Writable<EnvironmentShellState> }>(
    "./shell",
  );
  const registry = AtomRegistry.make();
  fixture.registry = registry;
  return { registry, testShell, ...testAtoms };
}

describe("mobile thread link resolution", () => {
  it("labels and opens a raw v2 link to an existing cross-project thread omitted from the shell", async () => {
    const { registry, family } = await setup();
    try {
      expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
        "Resumed Thread no longer available with Opus on high, fast mode off.",
      );
      registry.set(family, AsyncResult.success({ snapshotSequence: 4, threads: [target] }));
      expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
        `Resumed [${target.title}](${href}) with Opus on high, fast mode off.`,
      );
      const link = parseThreadLinkHref(href);
      expect(link).not.toBeNull();
      expect(link && resolveThreadLink((atom) => registry.get(atom), link, environmentId)).toEqual({
        environmentId,
        threadId,
      });
    } finally {
      registry.dispose();
      fixture.registry = null;
    }
  });

  it.each([
    "pending",
    "denied",
    "missing",
    "removed",
    "reconnected",
    "archived",
    "deleted",
  ] as const)("keeps an unresolved %s target unavailable and unopenable", async (state) => {
    const { registry, family, testShell } = await setup();
    try {
      registry.set(
        family,
        state === "pending"
          ? AsyncResult.initial(true)
          : state === "denied"
            ? AsyncResult.failure(Cause.fail("Unauthorized"))
            : AsyncResult.success({
                snapshotSequence: 4,
                threads:
                  state === "missing"
                    ? []
                    : [
                        {
                          ...target,
                          archivedAt: state === "archived" ? target.createdAt : null,
                          deletedAt: state === "deleted" ? target.createdAt : null,
                        },
                      ],
              }),
      );
      if (state === "removed")
        registry.set(testShell, {
          ...registry.get(testShell),
          removedAt: new Map([[threadId, 5]]),
        });
      if (state === "reconnected")
        registry.set(testShell, {
          ...registry.get(testShell),
          snapshot: Option.some({
            schemaVersion: 1,
            snapshotSequence: 6,
            projects: [],
            threads: [],
            archivedThreads: [],
            olderSettled: { before: "2026-11-01T00:00:00.000Z", asOfSequence: 6, counts: [] },
          }),
        });
      expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
        "Resumed Thread no longer available with Opus on high, fast mode off.",
      );
      const link = parseThreadLinkHref(href);
      expect(
        link && resolveThreadLink((atom) => registry.get(atom), link, environmentId),
      ).toBeNull();
      const otherEnvironment = EnvironmentId.make("synthetic-other-environment");
      expect(useLiveThreadLinkLabels(markdown, otherEnvironment)).toBe(
        "Resumed Thread on another machine with Opus on high, fast mode off.",
      );
    } finally {
      registry.dispose();
      fixture.registry = null;
    }
  });

  it("prefers the live shell title over an older family read", async () => {
    const { registry, family, shells } = await setup();
    try {
      registry.set(family, AsyncResult.success({ snapshotSequence: 4, threads: [target] }));
      registry.set(
        shells,
        new Map([
          [threadId, presentThreadShell(environmentId, { ...target, title: "Renamed thread" })],
        ]),
      );
      expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
        `Resumed [Renamed thread](${href}) with Opus on high, fast mode off.`,
      );
    } finally {
      registry.dispose();
      fixture.registry = null;
    }
  });
});
