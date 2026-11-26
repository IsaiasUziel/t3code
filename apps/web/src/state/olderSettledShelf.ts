import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedSettledThread,
  settledShelfFrontier,
  sortOlderSettledScopes,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettledScope,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { olderSettledThreads, threadFamilies } from "./threads";

const NO_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();

type ShelfInput = {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly visibleCount: number;
};

type ShelfScope = { readonly scope: OlderSettledScope; readonly pages: number };

const shelvesAtom = Atom.family((key: string) => {
  const scopes = JSON.parse(key) as ShelfScope[][];
  const atoms = scopes.map((entries) => olderSettledThreads.shelfAtom(entries));
  return Atom.make((get) => atoms.map((atom) => get(atom)));
});

/** Each expanded shelf pages only its own projects, even when several share an environment. */
export function useOlderSettledShelves(inputs: ReadonlyArray<ShelfInput>) {
  const [requested, setRequested] = useState<
    ReadonlyMap<string, ReadonlyMap<EnvironmentId, number>>
  >(new Map());
  const requests = inputs.map((input) => {
    const scopes = sortOlderSettledScopes(input.scopes);
    const key = JSON.stringify(scopes);
    const pages = input.visibleCount > 0 ? (requested.get(key) ?? NO_PAGES) : NO_PAGES;
    return {
      key,
      scopes,
      pages,
      visibleCount: input.visibleCount,
      entries: scopes.map((scope) => {
        const count = pages.get(scope.environmentId) ?? 0;
        // Before the first page, every project in an environment shares the same shell cut.
        return { scope: count ? scope : { ...scope, projectIds: null }, pages: count };
      }),
    };
  });
  const scopeKeys = new Set(requests.map((request) => request.key));
  if ([...requested.keys()].some((key) => !scopeKeys.has(key))) {
    setRequested(new Map([...requested].filter(([key]) => scopeKeys.has(key))));
  }
  const environments = useAtomValue(
    shelvesAtom(JSON.stringify(requests.map((request) => request.entries))),
  );
  // A page can change project activity order. Bind its rows independently of the order on screen.
  const loadedKey = JSON.stringify(
    requests
      .filter((request) => request.pages.size > 0)
      .sort((left, right) => left.key.localeCompare(right.key))
      .flatMap((request) => request.entries.filter((entry) => entry.pages > 0)),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the visible shelves' page rows into the thread family registry
  useEffect(() => {
    const releases = (JSON.parse(loadedKey) as ShelfScope[]).map(({ scope, pages }) =>
      threadFamilies.mountRows(
        appAtomRegistry,
        scope.environmentId,
        olderSettledThreads.rowsKey(scope, pages),
        olderSettledThreads.pageRowsAtom(scope, pages),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [loadedKey]);
  return requests.map(({ key, scopes, pages, entries, visibleCount }, index) => {
    const shelf = environments[index]!;
    const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
    const frontier = settledShelfFrontier([...shelf.values()]);
    const loaded = entries.filter((entry) => entry.pages > 0);
    return {
      environments: shelf,
      visibleCount,
      pages,
      grow: (next: ReadonlyMap<EnvironmentId, number>) =>
        setRequested((previous) => new Map(previous).set(key, next)),
      isListed: (thread: EnvironmentThreadShell) => isListedSettledThread(thread.source, frontier),
      unloadedCount: (threads: ReadonlyArray<EnvironmentThreadShell>) =>
        unloadedOlderSettledCount({ olderSettled: olderOf, scopes, threads }),
      loading: loaded.some(
        ({ scope }) => shelf.get(scope.environmentId)?.pages.status === "pending",
      ),
      failed: loaded.some(({ scope }) => shelf.get(scope.environmentId)?.pages.status === "failed"),
      retry: () => {
        for (const entry of loaded) {
          olderSettledThreads.retryPages(appAtomRegistry, entry.scope, entry.pages);
        }
      },
    };
  });
}

export function useOlderSettledShelfGrowth(
  shelves: ReturnType<typeof useOlderSettledShelves>,
  listedCounts: readonly number[],
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests the next older pages for each shelf that has not filled its visible rows
  useEffect(() => {
    shelves.forEach((shelf, index) => {
      const wanted = wantedOlderSettledPages({
        requested: shelf.pages,
        environments: shelf.environments,
        listedCount: listedCounts[index]!,
        visibleCount: shelf.visibleCount,
      });
      if (wanted !== shelf.pages) shelf.grow(wanted);
    });
  }, [shelves, listedCounts]);
}

/**
 * Threads of these projects that this client does not hold (older settled threads), for counts
 * shown outside the shelf, such as a removal confirm.
 */
export function readUnloadedThreadCount(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  return unloadedOlderSettledCount({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(members.map((member) => member.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: members.flatMap((member) =>
        member.environmentId === environmentId ? [member.id] : [],
      ),
    })),
    threads: threads.filter((thread) =>
      members.some(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ),
    ),
  });
}
