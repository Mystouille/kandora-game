/**
 * Single selection point for the active table tile design.
 *
 * Changing this one export swaps the whole table's tile artwork and
 * metrics. `TableRenderer` defaults to this value but accepts a
 * design via constructor options, so tests and a future runtime
 * picker can pass another registered design without editing here.
 */
import type { TileDesign } from "./tileDesign";
import { tenhouTileDesign } from "./designs/tenhouTileDesign";

export const ACTIVE_TILE_DESIGN: TileDesign = tenhouTileDesign;
