import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useOlderSettledShelves, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import {
  groupSidebarThreadsByProject,
  sidebarFolderExpansionKeys,
  sidebarFolderRowId,
  sidebarShelfRowId,
  threadShellKey,
  type SidebarShelf,
  type SidebarListItem,
  type SidebarSection,
} from "../Sidebar.logic";

const INITIAL_COUNT = 10;
const PAGE_SIZE = 25;
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

type Sections = Record<SidebarSection, readonly EnvironmentThreadShell[]>;

function routeOnly(threads: readonly EnvironmentThreadShell[], key: string | null) {
  const route = key === null ? undefined : threads.find((thread) => threadShellKey(thread) === key);
  return route ? [route] : EMPTY_THREADS;
}

function projectScopes(group: SidebarProjectSnapshot, environmentIds: ReadonlySet<EnvironmentId>) {
  const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
  for (const { environmentId, projectId } of group.memberProjectRefs) {
    if (!environmentIds.has(environmentId)) continue;
    const ids = byEnvironment.get(environmentId);
    if (ids) ids.push(projectId);
    else byEnvironment.set(environmentId, [projectId]);
  }
  return [...byEnvironment].map(([environmentId, projectIds]) => ({ environmentId, projectIds }));
}

function sidebarLists(
  groups: readonly SidebarProjectSnapshot[] | null,
  threads: readonly EnvironmentThreadShell[],
  sections: Sections,
  sectionByKey: ReadonlyMap<string, SidebarSection>,
) {
  if (groups !== null) {
    const folders = groupSidebarThreadsByProject(groups, threads, () => true);
    // A thread shell can arrive before its project. Keep it in the inbox until it has a folder.
    if (folders.reduce((n, folder) => n + folder.threads.length, 0) === threads.length) {
      return folders.map(({ group, threads }) => {
        const sections: Record<SidebarSection, EnvironmentThreadShell[]> = {
          pinned: [],
          active: [],
          working: [],
          snoozed: [],
          settled: [],
        };
        for (const thread of threads)
          sections[sectionByKey.get(threadShellKey(thread))!].push(thread);
        return { group, threads, sections };
      });
    }
  }
  return [{ group: null, threads, sections }];
}

export function useSidebarThreadLists(input: {
  groups: readonly SidebarProjectSnapshot[] | null;
  keepEmpty: (group: SidebarProjectSnapshot) => boolean;
  sections: Sections;
  sectionByKey: ReadonlyMap<string, SidebarSection>;
  threads: readonly EnvironmentThreadShell[];
  scopes: readonly OlderSettledScope[];
  projectScopeKey: string | null;
  routeRowKey: string | null;
  departingRowKey: string | null;
}) {
  const [working, setWorking] = useLocalStorage(
    "t3code:sidebar:working-expanded",
    false,
    Schema.Boolean,
  );
  const [snoozed, setSnoozed] = useLocalStorage(
    "t3code:sidebar:snoozed-expanded",
    false,
    Schema.Boolean,
  );
  const [settled, setSettled] = useLocalStorage(
    "t3code:sidebar:settled-expanded",
    false,
    Schema.Boolean,
  );
  const flatExpanded = { working, snoozed, settled };
  const setFlatExpanded = { working: setWorking, snoozed: setSnoozed, settled: setSettled };
  const expandedById = useUiStateStore((store) => store.projectExpandedById);
  const setExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const [tail, setTail] = useState({
    scope: input.projectScopeKey,
    counts: new Map<string, number>(),
  });
  if (tail.scope !== input.projectScopeKey) {
    setTail({ scope: input.projectScopeKey, counts: new Map() });
  }
  const routeKey = input.routeRowKey;
  const shelfRouteKey = routeKey === input.departingRowKey ? null : routeKey;
  const lists = sidebarLists(input.groups, input.threads, input.sections, input.sectionByKey).map(
    (list) => {
      const { group } = list;
      const folderRow = group ? sidebarFolderRowId(group.projectKey) : undefined;
      const collapsed =
        group !== null && !resolveProjectExpanded(expandedById, sidebarFolderExpansionKeys(group));
      const isExpanded = (shelf: SidebarShelf) =>
        folderRow === undefined
          ? flatExpanded[shelf]
          : (expandedById[sidebarShelfRowId(shelf, folderRow)] ?? false);
      const countKey = folderRow ?? "";
      const limit =
        tail.scope === input.projectScopeKey
          ? (tail.counts.get(countKey) ?? INITIAL_COUNT)
          : INITIAL_COUNT;
      return { ...list, folderRow, collapsed, isExpanded, limit, countKey };
    },
  );
  const environmentIds = new Set(input.scopes.map((scope) => scope.environmentId));
  const shelves = useOlderSettledShelves(
    lists.map((list) => ({
      scopes: list.group ? projectScopes(list.group, environmentIds) : input.scopes,
      visibleCount: !list.collapsed && list.isExpanded("settled") ? list.limit : 0,
    })),
  );
  const listed = lists.map((list, i) => list.sections.settled.filter(shelves[i]!.isListed));
  useOlderSettledShelfGrowth(
    shelves,
    listed.map((threads) => threads.length),
  );

  const visibleLists = lists.flatMap((list, i) => {
    const { sections, group, collapsed, folderRow } = list;
    const shelf = shelves[i]!;
    const unloaded = shelf.unloadedCount(list.threads);
    const settledCount = sections.settled.length + unloaded;
    if (list.threads.length + unloaded === 0 && (!group || !input.keepEmpty(group))) return [];

    const settledPage = listed[i]!.slice(0, list.limit);
    const routeSettled = routeOnly(sections.settled, shelfRouteKey);
    if (routeSettled[0] && !settledPage.includes(routeSettled[0]))
      settledPage.push(routeSettled[0]);
    const rows: Sections = {
      pinned: collapsed ? routeOnly(sections.pinned, routeKey) : sections.pinned,
      active: collapsed ? routeOnly(sections.active, routeKey) : sections.active,
      working:
        !collapsed && list.isExpanded("working")
          ? sections.working
          : routeOnly(sections.working, routeKey),
      snoozed:
        !collapsed && list.isExpanded("snoozed")
          ? sections.snoozed
          : routeOnly(sections.snoozed, shelfRouteKey),
      settled: !collapsed && list.isExpanded("settled") ? settledPage : routeSettled,
    };
    const items: SidebarListItem[] = [];
    const visibleThreads: EnvironmentThreadShell[] = [];
    const addRows = (section: SidebarSection) => {
      for (const thread of rows[section]) {
        items.push({ kind: "thread", key: threadShellKey(thread), section });
        visibleThreads.push(thread);
      }
    };
    if (!group) items.push({ kind: "marker", marker: "pinned-header" });
    addRows("pinned");
    if (!group)
      items.push(
        { kind: "marker", marker: "pinned-divider" },
        { kind: "marker", marker: "active-placeholder" },
      );
    addRows("active");
    const counts = {
      working: sections.working.length,
      snoozed: sections.snoozed.length,
      settled: settledCount,
    };
    for (const section of ["working", "snoozed", "settled"] as const) {
      if (!collapsed && (counts[section] > 0 || (!group && section === "settled"))) {
        items.push({ kind: "marker", marker: `${section}-header` });
      }
      if (!group && section === "settled")
        items.push({ kind: "marker", marker: "settled-placeholder" });
      addRows(section);
    }
    const moreCount = Math.min(settledCount - settledPage.length, PAGE_SIZE);
    return [
      {
        group,
        folderRow,
        collapsed,
        items,
        counts,
        rows,
        visibleThreads,
        hiddenThreads: collapsed
          ? list.threads.filter((thread) => !visibleThreads.includes(thread))
          : EMPTY_THREADS,
        unloaded,
        settledVisibleCount: list.limit,
        isExpanded: list.isExpanded,
        toggleShelf: (section: SidebarShelf) => {
          if (folderRow)
            setExpanded(sidebarShelfRowId(section, folderRow), !list.isExpanded(section));
          else setFlatExpanded[section]((open) => !open);
        },
        more:
          !collapsed && list.isExpanded("settled") && moreCount > 0
            ? {
                count: moreCount,
                loading: shelf.loading,
                failed: shelf.failed,
                show: () => {
                  if (shelf.loading) return;
                  shelf.retry();
                  setTail((current) => ({
                    scope: current.scope,
                    counts: new Map(current.counts).set(
                      list.countKey,
                      (current.counts.get(list.countKey) ?? INITIAL_COUNT) + PAGE_SIZE,
                    ),
                  }));
                },
              }
            : null,
      },
    ];
  });

  return {
    lists: visibleLists,
    toggleProjectFolder: (group: SidebarProjectSnapshot) => {
      const expanded = resolveProjectExpanded(expandedById, sidebarFolderExpansionKeys(group));
      // Legacy cwd keys omit the environment. Only read them as a fallback.
      setExpanded(
        [group.projectKey, ...group.memberProjects.map((member) => member.physicalProjectKey)],
        !expanded,
      );
    },
  };
}
