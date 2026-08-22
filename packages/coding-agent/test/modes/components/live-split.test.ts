import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	LIVE_SPLIT_LAYOUT,
	LiveSplit,
	type RailRowBudget,
	setComposerColumn,
	transcriptColumnWidth,
} from "@oh-my-pi/pi-coding-agent/modes/components/live-split";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, CURSOR_MARKER, visibleWidth } from "@oh-my-pi/pi-tui";

function stub(lines: string[]): Component {
	return { render: () => lines };
}

/** Component that reports the width it was rendered at. */
function widthProbe(seen: number[]): Component {
	return {
		render: (width: number) => {
			seen.push(width);
			return ["x"];
		},
	};
}

/** Rail child that records every budget the split pushed, newest last. */
class BudgetProbe implements Component, RailRowBudget {
	readonly budgets: number[] = [];

	setRailRowBudget(rows: number): void {
		this.budgets.push(rows);
	}

	render(): string[] {
		return ["TODO 1"];
	}
}

const OPTS = { minLeft: 80, minRail: 40, maxRail: 60 };

describe("LiveSplit", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("places rail content to the right of the composer at a fixed column", () => {
		const split = new LiveSplit([stub(["composer"])], [stub(["todo A", "todo B"])], OPTS);
		const lines = split.render(200);

		expect(lines.length).toBe(2);
		// 200 - min(60, 66) - 3 = 137 columns of composer, then " | ".
		const railStart = lines.map(l => l.indexOf("todo"));
		expect(railStart[0]).toBeGreaterThan(0);
		expect(visibleWidth(lines[0]!.slice(0, railStart[0]!))).toBe(140);
		expect(railStart[0]).toBe(railStart[1]);
		expect(lines[1]).toContain("todo B");
	});

	it("measures the cursor sentinel as zero width so the rail does not shift on the cursor row", () => {
		const withCursor = `pro${CURSOR_MARKER}mpt`;
		const split = new LiveSplit([stub([withCursor, "plain"])], [stub(["rail", "rail"])], OPTS);
		const lines = split.render(200);

		const cursorRow = lines[0]!.replaceAll(CURSOR_MARKER, "");
		expect(cursorRow.indexOf("rail")).toBe(lines[1]!.indexOf("rail"));
	});

	it("collapses to the pre-split stack when the terminal is too narrow", () => {
		const railSeen: number[] = [];
		const leftSeen: number[] = [];
		const split = new LiveSplit([widthProbe(leftSeen)], [widthProbe(railSeen)], OPTS);

		// 100 columns: a 40-column rail would leave 57 for the composer (< 80).
		const lines = split.render(100);
		expect(lines).toEqual(["x", "x"]);
		expect(leftSeen).toEqual([100]);
		expect(railSeen.at(-1)).toBe(100);
	});

	it("claims no columns when the rail has nothing to show", () => {
		const leftSeen: number[] = [];
		const split = new LiveSplit([widthProbe(leftSeen)], [stub([])], OPTS);

		expect(split.render(200)).toEqual(["x"]);
		expect(leftSeen).toEqual([200]);
	});

	it("pads short columns so every row spans both columns", () => {
		const split = new LiveSplit([stub(["one"])], [stub(["a", "b", "c"])], OPTS);
		const lines = split.render(200);

		expect(lines.length).toBe(3);
		for (const line of lines) expect(visibleWidth(line)).toBeGreaterThanOrEqual(140);
	});

	it("reports the whole block as a pinned, fully mutable live region", () => {
		const split = new LiveSplit([stub(["composer"])], [stub(["todo"])], OPTS);

		expect(split.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		split.render(200);
		expect(split.getNativeScrollbackLiveRegionStart()).toBe(0);
		expect(split.isNativeScrollbackLiveRegionPinned()).toBe(true);
	});
});

/**
 * Column layout: the composer leaves the bottom of the frame for the right
 * column and the transcript keeps the left one. The transcript is not a child
 * of the split (its rows are already committed), so the contract is split in
 * two: `transcriptColumnWidth` reserves the columns and the split fills them.
 */
describe("LiveSplit composer column", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		setComposerColumn(false);
	});

	it("reserves the composer's columns for the transcript only while enabled", () => {
		expect(transcriptColumnWidth(200)).toBe(200);
		setComposerColumn(true);
		// Composer takes maxRail (96) plus the 3-column divider: a column the
		// user types in is not capped to a third of the frame the way a rail is.
		expect(transcriptColumnWidth(200)).toBe(101);
		// 130 columns is below 3 * minRail, so a third-cap would have killed the
		// layout here: the composer gets what is left above the 60-column floor.
		expect(transcriptColumnWidth(130)).toBe(60);
		// Too narrow for a 56-column composer beside 60 columns of transcript:
		// the layout collapses and the transcript keeps the full width.
		expect(transcriptColumnWidth(100)).toBe(100);
		expect(transcriptColumnWidth(118)).toBe(118);
		// 119 = minLeft 60 + minRail 56 + divider 3: the exact floor.
		expect(transcriptColumnWidth(119)).toBe(60);
	});

	it("moves the composer into the right column under the HUDs", () => {
		setComposerColumn(true);
		const split = new LiveSplit([stub(["> prompt"])], [stub(["TODO 1"])], LIVE_SPLIT_LAYOUT);
		const lines = split.render(200);

		expect(lines.length).toBe(2);
		// HUD first, composer below it - both in the right column at 101 + 3.
		expect(Bun.stripANSI(lines[0]!).indexOf("TODO 1")).toBe(104);
		expect(Bun.stripANSI(lines[1]!).indexOf("> prompt")).toBe(104);
		// Left column is the transcript's: the split leaves it blank.
		expect(Bun.stripANSI(lines[1]!).slice(0, 101).trim()).toBe("");
	});

	it("renders the composer at the column width, not the terminal width", () => {
		setComposerColumn(true);
		const seen: number[] = [];
		const split = new LiveSplit([widthProbe(seen)], [stub(["TODO 1"])], LIVE_SPLIT_LAYOUT);
		split.render(200);

		expect(seen).toEqual([96]);
	});

	it("spans the footer across both columns in either layout", () => {
		const footerSeen: number[] = [];
		const split = new LiveSplit([stub(["> prompt"])], [stub(["TODO 1"])], LIVE_SPLIT_LAYOUT, [
			widthProbe(footerSeen),
		]);

		split.render(200);
		setComposerColumn(true);
		split.render(200);

		expect(footerSeen).toEqual([200, 200]);
		// Footer is the last row, below both columns.
		const lines = split.render(200);
		expect(Bun.stripANSI(lines.at(-1)!)).toBe("x");
	});

	it("collapses to the plain stack when the terminal is too narrow", () => {
		setComposerColumn(true);
		const split = new LiveSplit([stub(["> prompt"])], [stub(["TODO 1"])], LIVE_SPLIT_LAYOUT, [stub(["status"])]);
		const lines = split.render(100).map(line => Bun.stripANSI(line));

		// Stacked order with the composer back at the bottom, footer last.
		expect(lines).toEqual(["TODO 1", "> prompt", "status"]);
	});

	/**
	 * A HUD sizes itself to the budget it was last handed, so a layout that
	 * stops being a column has to say so. Both exits from the pinned branch push
	 * zero explicitly - otherwise a resize below the floor, or a toggle-off,
	 * leaves the HUD spending viewport rows the layout no longer owns and the
	 * block overdraws the transcript.
	 */
	it("pushes a zero budget when a resize collapses the column, and restores it on the way back", () => {
		setComposerColumn(true);
		const hud = new BudgetProbe();
		const split = new LiveSplit([stub(["> prompt"])], [hud], LIVE_SPLIT_LAYOUT);
		split.setViewportRowsBelow(10);

		// 10 rows below, no footer, one composer row: the HUD may spend 9.
		split.render(200);
		// 100 columns leaves the composer 37 - under minRail 56 - so the column
		// collapses to the plain stack.
		split.render(100);
		split.render(200);

		expect(hud.budgets).toEqual([9, 0, 9]);
	});

	it("pushes a zero budget when the composer column is turned off", () => {
		setComposerColumn(true);
		const hud = new BudgetProbe();
		const split = new LiveSplit([stub(["> prompt"])], [hud], LIVE_SPLIT_LAYOUT);
		split.setViewportRowsBelow(10);

		split.render(200);
		setComposerColumn(false);
		// Stacked rail: the HUD is eating transcript height now, not viewport
		// rows the composer left behind.
		split.render(200);

		expect(hud.budgets).toEqual([9, 0]);
	});
});
