import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useOlderSettledShelves } from "./olderSettledShelf";

const environmentId = EnvironmentId.make("env-a");
const first = ProjectId.make("project-a");
const second = ProjectId.make("project-b");

function Shelves(props: { projects: ProjectId[][] }) {
  const shelves = useOlderSettledShelves(
    props.projects.map((projectIds) => ({
      scopes: [{ environmentId, projectIds }],
      visibleCount: 10,
    })),
  );
  return (
    <>
      <output>{shelves.map((shelf) => shelf.pages.get(environmentId) ?? 0).join(",")}</output>
      <button type="button" onClick={() => shelves[0]!.grow(new Map([[environmentId, 1]]))}>
        Grow
      </button>
    </>
  );
}

describe("useOlderSettledShelves", () => {
  it("keeps pages with their shelf when folders and their member projects reorder", async () => {
    const third = ProjectId.make("project-c");
    await using screen = await render(
      <Shelves projects={[[first, second], [third]]} />,
      // A bare hook host; nothing here links or navigates.
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Grow" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("1,0");

    // Loading a page can reorder the sidebar's projects; the shelf must not drop its pages.
    await screen.rerender(<Shelves projects={[[third], [second, first]]} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("0,1");
  });
});
