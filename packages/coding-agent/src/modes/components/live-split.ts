/**
 * Two-column wrapper for the bottom live region.
 *
 * Only the live region can do this. Transcript rows are committed to native
 * scrollback and immutable, so a second column can exist solely beside rows
 * that still repaint.
 *
 * Two layouts, selected by `tui.composerColumn`:
 *
 * - `rail` (default): composer on the left, a status rail on the right hosting
 *   the HUDs that would otherwise consume transcript height (todo, subagents),
 *   which is why the split is a net height win rather than decoration.
 * - `column`: the composer itself moves into the right column with the HUDs
 *   stacked above it, and the transcript keeps the left column - it reserves
 *   those columns itself via {@link transcriptColumnWidth}, since its rows are
 *   painted once and can never be re-laid-out.
 *
 * A footer (the status line) spans both columns below them in either layout.
 *
 * Below the width threshold the rail collapses and every child renders in its
 * original stacked order, so a narrow terminal behaves exactly as before.
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

/** Shared empty child list: the left column is unused in the column layout. */
const EMPTY: readonly Component[] = [];

export interface LiveSplitOptions {
	/** Minimum content columns the left column needs to keep the rail. */
	minLeft: number;
	/** Minimum content columns the rail needs to be worth showing. */
	minRail: number;
	/** Upper bound on rail width; the rail never takes more than a third. */
	maxRail: number;
	/** Geometry used while the composer owns the right column. */
	column?: LiveSplitOptions;
}

/**
 * Opt-in signal for a rail child that can size itself to the rows the layout
 * has spare. Pushed before the child renders, so an elastic HUD sees this
 * frame's number rather than the previous frame's; zero whenever the layout has
 * no spare rows to give, which is every frame of the stacked layout.
 */
export interface RailRowBudget {
	setRailRowBudget(rows: number): void;
}

/**
 * Rail geometry: the composer keeps the wide left column, the HUDs get a
 * readable strip. Column geometry has to be wide enough to *type* in, so it
 * trades transcript width for composer width.
 */
export const LIVE_SPLIT_LAYOUT: LiveSplitOptions = {
	minLeft: 80,
	minRail: 40,
	maxRail: 60,
	column: { minLeft: 60, minRail: 56, maxRail: 96 },
};

let composerColumn = false;

/** Live setting mirror: read on every render, so a toggle needs no restart. */
export function setComposerColumn(enabled: boolean): void {
	composerColumn = enabled;
}

/**
 * Columns the transcript may paint into. The split owns only live rows, so
 * everything above it has to reserve the composer's column on its own.
 * Returns the full width whenever the column layout is off or does not fit.
 */
export function transcriptColumnWidth(width: number): number {
	if (!composerColumn) return width;
	const options = LIVE_SPLIT_LAYOUT.column ?? LIVE_SPLIT_LAYOUT;
	const rail = railColumns(width, options, false);
	return rail > 0 ? width - rail - DIVIDER_COLUMNS : width;
}

/**
 * A rail is decoration and must never outgrow a third of the frame. A composer
 * column is where the user types: it takes `maxRail` as soon as the transcript
 * still clears `minLeft`, otherwise the third-cap would leave the layout dead
 * between `minLeft + minRail + 3` and `3 * minRail` columns.
 */
function railColumns(width: number, options: LiveSplitOptions, capByThird: boolean): number {
	const ceiling = capByThird ? Math.floor(width / 3) : width - DIVIDER_COLUMNS - options.minLeft;
	const rail = Math.min(options.maxRail, ceiling);
	if (rail < options.minRail) return 0;
	return width - rail - DIVIDER_COLUMNS >= options.minLeft ? rail : 0;
}

export class LiveSplit implements Component, NativeScrollbackLiveRegion {
	/**
	 * Flat child list in stacked order. The TUI resolves a component's owning
	 * root child by walking `children`, which is how a scoped repaint (editor
	 * keystroke, spinner tick) stays a partial render instead of a full frame:
	 * without this the composer would be invisible to that walk.
	 */
	readonly children: readonly Component[];

	/** Rail order while the composer lives in the column: HUDs above composer. */
	readonly #columnOrder: readonly Component[];

	#hasRows = false;

	constructor(
		private readonly left: readonly Component[],
		private readonly rail: readonly Component[],
		private readonly options: LiveSplitOptions,
		private readonly footer: readonly Component[] = [],
	) {
		this.children = [...left, ...rail, ...footer];
		this.#columnOrder = [...rail, ...left];
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

	/**
	 * Rows between this block's first row and the bottom of the viewport, fed by
	 * the engine each frame. Zero until the first frame reports.
	 */
	#rowsBelow = 0;

	setViewportRowsBelow(rows: number): void {
		this.#rowsBelow = rows;
	}

	render(width: number): readonly string[] {
		// Column layout: the composer joins the HUDs in the right column and the
		// left column is left to the transcript, which already reserved it.
		const column = composerColumn;
		const options = column ? (this.options.column ?? this.options) : this.options;
		const railChildren = column ? this.#columnOrder : this.rail;
		const leftChildren = column ? EMPTY : this.left;

		// The footer spans both columns: the status line is the densest row in
		// the frame and a third of the terminal truncates it.
		const footerLines: string[] = [];
		for (const child of this.footer) footerLines.push(...child.render(width));

		const railWidth = railColumns(width, options, !column);
		const railLines: string[] = [];
		if (railWidth > 0 && column) {
			// Bottom-pinned column: HUDs at the top of the block (beside the
			// transcript tail, where they have room to grow), the free viewport
			// rows in the middle, the composer flush with the screen bottom. The
			// pad collapses to nothing once the frame outgrows the viewport, so
			// a scrolling session behaves exactly as an unpinned one.
			//
			// Composer first: its height decides the budget the rail children are
			// handed, so an elastic HUD sees this frame's number. The budget is
			// deliberately independent of the HUDs' own height - one that shrank
			// as the HUD grew would oscillate.
			const composerLines: string[] = [];
			for (const child of this.left) composerLines.push(...child.render(railWidth));
			const budget = Math.max(0, this.#rowsBelow - footerLines.length - composerLines.length);
			const hudLines: string[] = [];
			for (const child of this.rail) {
				setRailRowBudget(child, budget);
				hudLines.push(...child.render(railWidth));
			}
			railLines.push(...hudLines);
			for (let i = Math.max(0, budget - hudLines.length); i > 0; i--) railLines.push("");
			railLines.push(...composerLines);
		} else if (railWidth > 0) {
			// Stacked rail: the HUDs are eating transcript height, so they get no
			// budget to spend. Pushed, not merely omitted, so a toggle-off or a
			// resize cannot leave a HUD spending rows the layout no longer has.
			for (const child of this.rail) {
				setRailRowBudget(child, 0);
				railLines.push(...child.render(railWidth));
			}
		}

		// No rail (too narrow, or nothing to show beside the composer): stack
		// everything at full width in the pre-split order.
		if (railLines.length === 0) {
			const stacked: string[] = [];
			for (const child of railChildren) {
				setRailRowBudget(child, 0);
				stacked.push(...child.render(width));
			}
			for (const child of leftChildren) stacked.push(...child.render(width));
			stacked.push(...footerLines);
			this.#hasRows = stacked.length > 0;
			return stacked;
		}

		const leftWidth = width - railWidth - DIVIDER_COLUMNS;
		const leftLines: string[] = [];
		for (const child of leftChildren) leftLines.push(...child.render(leftWidth));

		const divider = theme.fg("dim", ` ${theme.boxRound.vertical} `);
		const rows = Math.max(leftLines.length, railLines.length);
		const combined: string[] = new Array(rows + footerLines.length);
		for (let i = 0; i < rows; i++) {
			const line = leftLines[i] ?? "";
			const pad = Math.max(0, leftWidth - measure(line));
			combined[i] = line + padding(pad) + divider + (railLines[i] ?? "");
		}
		for (let i = 0; i < footerLines.length; i++) combined[rows + i] = footerLines[i]!;
		this.#hasRows = combined.length > 0;
		return combined;
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}

	dispose(): void {
		for (const child of this.children) child.dispose?.();
	}
}

/** Hands a rail child its row budget when it implements the opt-in protocol. */
function setRailRowBudget(child: Component, rows: number): void {
	(child as Component & Partial<RailRowBudget>).setRailRowBudget?.(rows);
}

/**
 * Visible columns, ignoring the in-band cursor sentinel. `Bun.stringWidth`
 * counts the APC marker as five printable columns, which would shift the rail
 * left on exactly the editor's cursor row.
 */
function measure(line: string): number {
	return visibleWidth(line.includes(CURSOR_MARKER) ? line.replaceAll(CURSOR_MARKER, "") : line);
}
