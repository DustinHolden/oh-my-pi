/**
 * Two-column wrapper for the bottom live region: the composer stack on the
 * left, a status rail on the right.
 *
 * Only the live region can do this. Transcript rows are committed to native
 * scrollback and immutable, so a right-hand column can exist solely beside
 * rows that still repaint — the composer block. The rail therefore hosts the
 * HUDs that would otherwise consume transcript height (todo, subagents), which
 * is why the split is a net height win rather than decoration.
 *
 * Below the width threshold the rail collapses and its children render in
 * their original stacked order, so a narrow terminal behaves exactly as before.
 */
import {
	type Component,
	CURSOR_MARKER,
	type NativeScrollbackLiveRegion,
	padding,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/** Columns consumed by the ` │ ` divider between the two columns. */
const DIVIDER_COLUMNS = 3;

export interface LiveSplitOptions {
	/** Minimum content columns the left (composer) column needs to keep the rail. */
	minLeft: number;
	/** Minimum content columns the rail needs to be worth showing. */
	minRail: number;
	/** Upper bound on rail width; the rail never takes more than a third. */
	maxRail: number;
}

export class LiveSplit implements Component, NativeScrollbackLiveRegion {
	/**
	 * Flat child list in stacked order. The TUI resolves a component's owning
	 * root child by walking `children`, which is how a scoped repaint (editor
	 * keystroke, spinner tick) stays a partial render instead of a full frame:
	 * without this the composer would be invisible to that walk.
	 */
	readonly children: readonly Component[];

	#hasRows = false;

	constructor(
		private readonly left: readonly Component[],
		private readonly rail: readonly Component[],
		private readonly options: LiveSplitOptions,
	) {
		this.children = [...left, ...rail];
	}

	/**
	 * The whole block is mutable: nothing inside it may commit to native
	 * scrollback as final content, and its offscreen rows are clipped rather
	 * than snapshotted (the anchored-HUD contract it inherits from the children
	 * it now owns).
	 */
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#hasRows ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}

	render(width: number): readonly string[] {
		const railWidth = this.#railWidth(width);
		const railLines: string[] = [];
		if (railWidth > 0) {
			for (const child of this.rail) railLines.push(...child.render(railWidth));
		}

		// No rail (too narrow, or nothing to show beside the composer): stack
		// everything at full width in the pre-split order.
		if (railLines.length === 0) {
			const stacked: string[] = [];
			for (const child of this.rail) stacked.push(...child.render(width));
			for (const child of this.left) stacked.push(...child.render(width));
			this.#hasRows = stacked.length > 0;
			return stacked;
		}

		const leftWidth = width - railWidth - DIVIDER_COLUMNS;
		const leftLines: string[] = [];
		for (const child of this.left) leftLines.push(...child.render(leftWidth));

		const divider = theme.fg("dim", ` ${theme.boxRound.vertical} `);
		const rows = Math.max(leftLines.length, railLines.length);
		const combined: string[] = new Array(rows);
		for (let i = 0; i < rows; i++) {
			const line = leftLines[i] ?? "";
			const pad = Math.max(0, leftWidth - measure(line));
			combined[i] = line + padding(pad) + divider + (railLines[i] ?? "");
		}
		this.#hasRows = rows > 0;
		return combined;
	}

	#railWidth(width: number): number {
		const rail = Math.min(this.options.maxRail, Math.floor(width / 3));
		if (rail < this.options.minRail) return 0;
		return width - rail - DIVIDER_COLUMNS >= this.options.minLeft ? rail : 0;
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}

	dispose(): void {
		for (const child of this.children) child.dispose?.();
	}
}

/**
 * Visible columns, ignoring the in-band cursor sentinel. `Bun.stringWidth`
 * counts the APC marker as five printable columns, which would shift the rail
 * left on exactly the editor's cursor row.
 */
function measure(line: string): number {
	return visibleWidth(line.includes(CURSOR_MARKER) ? line.replaceAll(CURSOR_MARKER, "") : line);
}
