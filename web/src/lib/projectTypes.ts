import type { ProjectType } from "../api";

export interface TypeInfo {
  label: string;
  /** One line shown when choosing. */
  blurb: string;
  /** What it starts with. */
  starts: string;
  /** The view the Work tab opens on. */
  view: "list" | "board" | "timeline" | "queue";
}

export const PROJECT_TYPES: ProjectType[] = ["delivery", "pipeline", "support", "initiative"];

export const TYPE_INFO: Record<ProjectType, TypeInfo> = {
  delivery: {
    label: "Delivery",
    blurb: "A planned piece of work with dates and milestones.",
    starts: "To do · Doing · Review · Done, with a timeline",
    view: "timeline",
  },
  pipeline: {
    label: "Sales pipeline",
    blurb: "Leads moving through stages until they're won or lost.",
    starts: "New · Contacted · Qualified · Won · Lost, as a board with deal values and a forecast",
    view: "board",
  },
  support: {
    label: "Support",
    blurb: "Requests from customers that need an answer.",
    starts: "New · In progress · Waiting on customer · Resolved, as a queue with service clocks",
    view: "queue",
  },
  initiative: {
    label: "Initiative",
    blurb: "A simple list of work for a team or a goal.",
    starts: "To do · Doing · Done, as a list",
    view: "list",
  },
};
