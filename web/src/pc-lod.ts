// Which nodes to add for what is on the screen now: level of detail that follows the view. A COPC node at depth d holds points about
// `spacingFt` apart, the file's spacing halved for each level, so how far apart they are on the screen is the node's size on the screen times
// a constant of the file (spacing over the file's size). A node is worth reading when the level above it (whose points are twice as far
// apart) would be coarser on the screen than a target, and it is on the screen. So zooming in reads finer levels, only where you look.
// No DOM here.

import { boxesOverlap, coveredShare, DEFAULT_BUDGET, type Box, type Budget, type NodeRef } from './pc-plan.ts';

export interface Pt { x: number; y: number }

/** The screen, as far as this needs to know it: where a grid position (feet) is in pixels, and how big the screen is. */
export interface View {
  project(x: number, y: number): Pt;
  width: number;
  height: number;
}

/** How far apart, in pixels, points should be on the screen at the most: a finer cloud would be more points than there are pixels to show them. */
export const TARGET_SPACING_PX = 3;
/** A node this much (of the screen's size) outside the screen still counts as on it, so a small pan does not show gaps. */
export const MARGIN = 0.15;

interface Placed { side: number; centre: Pt; onScreen: boolean }

/** A node's size on the screen (its longer side, in pixels), its middle, and whether any of it is on the screen. */
export function place(node: NodeRef, view: View): Placed | null {
  const [x0, y0, x1, y1] = node.box;
  const a = view.project(x0, y0), b = view.project(x1, y0), c = view.project(x1, y1), d = view.project(x0, y1);
  const corners = [a, b, c, d];
  if (corners.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null; // beyond the horizon of a tilted map
  const side = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(d.x - a.x, d.y - a.y), Math.hypot(c.x - b.x, c.y - b.y), Math.hypot(c.x - d.x, c.y - d.y));
  const minX = Math.min(...corners.map((p) => p.x)), maxX = Math.max(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y)), maxY = Math.max(...corners.map((p) => p.y));
  const mx = view.width * MARGIN, my = view.height * MARGIN;
  const onScreen = boxesOverlap([minX, minY, maxX, maxY], [-mx, -my, view.width + mx, view.height + my]);
  return { side, centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, onScreen };
}

/** Whether a node is fine enough to be wanted: the level above it would have its points more than `targetPx` apart on the screen. */
export const wanted = (node: NodeRef, side: number, targetPx = TARGET_SPACING_PX): boolean =>
  2 * side * (node.spacingFt / (node.box[2] - node.box[0])) > targetPx;

export interface ForView {
  targetPx?: number;
  /** Whether a node is already on the map (or on its way). */
  skip: (node: NodeRef) => boolean;
  /** The area the nodes were found for (a rectangle round it), to judge how much of a node is wanted. */
  aoi: Box;
  budget?: Budget;
}

/**
 * The nodes to read for the screen as it is: on the screen, wanted at this zoom, not already loaded, coarse levels first and, within a level, those
 * nearest the middle of the screen first, as many as the budget allows (points estimated as a node's points times the share of it inside the area).
 */
export function nodesForView(nodes: readonly NodeRef[], view: View, o: ForView): NodeRef[] {
  const budget = o.budget ?? DEFAULT_BUDGET;
  const middle = { x: view.width / 2, y: view.height / 2 };
  const candidates: { node: NodeRef; distance: number }[] = [];
  for (const node of nodes) {
    if (o.skip(node)) continue;
    const placed = place(node, view);
    if (!placed || !placed.onScreen || !wanted(node, placed.side, o.targetPx)) continue;
    candidates.push({ node, distance: Math.hypot(placed.centre.x - middle.x, placed.centre.y - middle.y) });
  }
  candidates.sort((a, b) => a.node.depth - b.node.depth || a.distance - b.distance);
  const out: NodeRef[] = [];
  let points = 0, bytes = 0;
  for (const { node } of candidates) {
    const p = node.count * coveredShare(node.box, o.aoi);
    if (out.length > 0 && (points + p > budget.maxPoints || bytes + node.length > budget.maxBytes)) break;
    out.push(node);
    points += p;
    bytes += node.length;
  }
  return out;
}
