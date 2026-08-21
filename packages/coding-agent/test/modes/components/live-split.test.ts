import { beforeAll, describe, expect, it } from "bun:test";
import { LiveSplit } from "@oh-my-pi/pi-coding-agent/modes/components/live-split";
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
