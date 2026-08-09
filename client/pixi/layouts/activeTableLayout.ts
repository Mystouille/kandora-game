/**
 * Single selection point for the active table layout. Changing this
 * one export swaps the whole board's zone geometry. `TableRenderer`
 * defaults to it but accepts a config via constructor options and can
 * replace it at runtime via `setLayoutConfig`, so responsive/route
 * code can switch presets without editing here.
 */
import type { TableLayoutConfig } from "../tableLayout";
import { currentTableLayout } from "./currentTableLayout";

export const ACTIVE_TABLE_LAYOUT: TableLayoutConfig = currentTableLayout;
