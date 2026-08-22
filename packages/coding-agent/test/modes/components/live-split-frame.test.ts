import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	LIVE_SPLIT_LAYOUT,
	LiveSplit,
	type RailRowBudget,
	setComposerColumn,
	transcriptColumnWidth,
} from "@oh-my-pi/pi-coding-agent/modes/components/live-split";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Container, type NativeScrollbackLiveRegion, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

/** Append-only transcript: every rendered row is declared final. */
class Transcript implements Component, NativeScrollbackLiveRegion {
	renders = 0;
	#lines: string[] = [];

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	render(_width?: number): string[] {
		this.renders++;
		return this.#lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#lines.length;
	}
}

/**
 * Transcript that narrows itself to the column the composer is not using -
 * what `ColumnTranscriptContainer` does in production.
 */
class ColumnTranscript extends Transcript {
	widths: number[] = [];

	override render(width: number): string[] {
		this.widths.push(transcriptColumnWidth(width));
		return super.render();
	}
}

class Mutable implements Component, RailRowBudget {
	/** Every budget the split pushed, newest last. */
	budgets: number[] = [];

	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = [...lines];
	}

	setRailRowBudget(rows: number): void {
		this.budgets.push(rows);
	}

	render(): string[] {
		return this.lines;
	}
}

function plain(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

const OPTS = { minLeft: 80, minRail: 40, maxRail: 60 };

describe("LiveSplit in a real frame", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		setComposerColumn(false);
	});

	it("paints the rail beside the composer and repaints it without recommitting the transcript", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(200, 12, 10_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new Transcript();
		const composer = new Mutable(["> prompt"]);
		const rail = new Mutable(["TODO 1 pending"]);
		tui.addChild(transcript);
		tui.addChild(new LiveSplit([composer], [rail], OPTS));

		try {
			tui.start();
			transcript.setLines(["TRANSCRIPT-000", "TRANSCRIPT-001"]);
			tui.requestRender();
			await scheduler.drain(term);

			const viewport = plain(term.getViewport());
			const composerRow = viewport.find(row => row.startsWith("> prompt"));
			expect(composerRow).toBeDefined();
			// Composer on the left, rail past the divider on the same row: rail width
			// is min(60, floor(200/3)) = 60, leaving 137 composer columns and a
			// three-column divider, so rail content starts at column 140.
			expect(composerRow).toContain("TODO 1 pending");
			expect(composerRow!.indexOf("TODO 1 pending")).toBe(140);

			// The rail is the sticky HUD's new home: updating it must repaint in
			// place, never re-emit the committed transcript rows.
			rail.setLines(["TODO 1 done", "TODO 2 pending"]);
			tui.requestRender();
			await scheduler.drain(term);

			const buffer = plain(term.getScrollBuffer());
			expect(buffer.filter(row => row.startsWith("TRANSCRIPT-000")).length).toBe(1);
			expect(buffer.filter(row => row.includes("> prompt")).length).toBe(1);
			const updated = plain(term.getViewport()).find(row => row.includes("> prompt"));
			expect(updated).toContain("TODO 1 done");
			// The rail is taller than the composer: the extra row is padded on the
			// left and still carries the divider.
			const overflow = plain(term.getViewport()).find(row => row.includes("TODO 2 pending"));
			expect(overflow).toBeDefined();
			expect(overflow!.indexOf("TODO 2 pending")).toBe(140);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps a composer-scoped repaint scoped: the transcript is not re-rendered", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(200, 12, 10_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new Transcript();
		// Production depth: the editor sits in its own container inside the split,
		// so the TUI must walk two levels to find the split as the owning root.
		const editor = new Mutable(["> prompt"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(transcript);
		tui.addChild(new LiveSplit([editorContainer], [new Mutable(["TODO 1 pending"])], OPTS));

		try {
			tui.start();
			transcript.setLines(["TRANSCRIPT-000", "TRANSCRIPT-001"]);
			tui.requestRender();
			await scheduler.drain(term);

			const before = transcript.renders;
			editor.setLines(["> prompt typed"]);
			tui.requestComponentRender(editor);
			await scheduler.drain(term);

			// A keystroke repaint must reuse the transcript's committed segment. If
			// the split hides its children from root resolution, this downgrades to
			// a full compose and the transcript re-renders.
			expect(transcript.renders).toBe(before);
			expect(plain(term.getViewport()).some(row => row.startsWith("> prompt typed"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	/**
	 * Production shape of the column layout: the transcript reserves the
	 * composer's columns itself (ColumnTranscriptContainer does this by
	 * overriding render), so the two halves have to agree on the seam.
	 */
	it("paints the transcript left of a composer that sits in the right column", async () => {
		if (process.platform === "win32") return;
		setComposerColumn(true);

		const term = new VirtualTerminal(200, 12, 10_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new ColumnTranscript();
		const editor = new Mutable(["> prompt"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(transcript);
		tui.addChild(
			new LiveSplit([editorContainer], [new Mutable(["TODO 1 pending"])], LIVE_SPLIT_LAYOUT, [
				new Mutable(["status line"]),
			]),
		);

		try {
			tui.start();
			transcript.setLines(["TRANSCRIPT-000", "TRANSCRIPT-001"]);
			tui.requestRender();
			await scheduler.drain(term);

			// 200 - maxRail 96 - divider 3 = 101 transcript columns.
			expect(transcript.widths.at(-1)).toBe(101);
			const viewport = plain(term.getViewport());
			const composerRow = viewport.find(row => row.includes("> prompt"));
			expect(composerRow!.indexOf("> prompt")).toBe(104);
			expect(viewport.find(row => row.includes("TODO 1 pending"))!.indexOf("TODO 1 pending")).toBe(104);
			// Footer spans both columns, so it starts at column 0.
			expect(viewport.find(row => row.includes("status line"))!.indexOf("status line")).toBe(0);

			// A keystroke must still repaint in place: the transcript is committed
			// at the narrowed width and must not be re-rendered or re-emitted.
			const before = transcript.renders;
			editor.setLines(["> prompt typed"]);
			tui.requestComponentRender(editor);
			await scheduler.drain(term);

			expect(transcript.renders).toBe(before);
			const buffer = plain(term.getScrollBuffer());
			expect(buffer.filter(row => row.startsWith("TRANSCRIPT-000")).length).toBe(1);
			expect(plain(term.getViewport()).some(row => row.includes("> prompt typed"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	/**
	 * The composer column is pinned to the viewport bottom: the HUDs sit at the
	 * top of the block and the free rows go between them, so the prompt is where
	 * the eye (and the muscle memory) expects it however short the session is.
	 */
	it("pins the composer column to the bottom of the viewport and publishes the HUD budget", async () => {
		if (process.platform === "win32") return;
		setComposerColumn(true);

		// 32 rows: tall enough that the honest budget clears the rail floor, so
		// this case measures the pin arithmetic rather than the floor.
		const term = new VirtualTerminal(200, 32, 10_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new ColumnTranscript();
		const editor = new Mutable(["> prompt"]);
		const hud = new Mutable(["TODO 1 pending"]);
		const split = new LiveSplit([editor], [hud], LIVE_SPLIT_LAYOUT, [new Mutable(["status line"])]);
		tui.addChild(transcript);
		tui.addChild(split);

		try {
			tui.start();
			transcript.setLines(["TRANSCRIPT-000", "TRANSCRIPT-001"]);
			tui.requestRender();
			await scheduler.drain(term);

			const viewport = plain(term.getViewport());
			// 32 rows - 2 transcript = 30 for the block; footer and composer take
			// one each, so the HUDs may spend 28 and the pad fills the rest.
			expect(hud.budgets.at(-1)).toBe(28);
			expect(viewport.findIndex(row => row.includes("> prompt"))).toBe(30);
			expect(viewport.findIndex(row => row.includes("status line"))).toBe(31);
			expect(viewport.findIndex(row => row.includes("TODO 1 pending"))).toBe(2);

			// A taller HUD eats the pad, never the composer's row.
			hud.setLines(["TODO 1 done", "TODO 2 pending", "TODO 3 pending"]);
			tui.requestRender();
			await scheduler.drain(term);

			const grown = plain(term.getViewport());
			expect(grown.findIndex(row => row.includes("> prompt"))).toBe(30);
			expect(grown.findIndex(row => row.includes("TODO 3 pending"))).toBe(4);
			// Once the frame outgrows the viewport the pad is gone: the block
			// behaves exactly as an unpinned one, the transcript scrolls off the
			// top, and the composer lands on the bottom rows on its own.
			transcript.setLines(Array.from({ length: 60 }, (_, i) => `TRANSCRIPT-${String(i).padStart(3, "0")}`));
			tui.requestRender();
			await scheduler.drain(term);

			const scrolled = plain(term.getViewport());
			expect(hud.budgets.at(-1)).toBe(16);
			expect(scrolled.findIndex(row => row.includes("TODO 1 done"))).toBe(27);
			expect(scrolled.findIndex(row => row.includes("> prompt"))).toBe(30);
			expect(scrolled.findIndex(row => row.includes("status line"))).toBe(31);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	/**
	 * The elastic-HUD contract: a rail child that sizes itself to the published
	 * budget must see *this* frame's number, not the previous frame's, or the
	 * HUD lags a keystroke behind every time the composer grows a row.
	 */
	it("publishes the HUD budget before the rail children render", async () => {
		if (process.platform === "win32") return;
		setComposerColumn(true);

		const term = new VirtualTerminal(200, 32, 10_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new ColumnTranscript();
		const editor = new Mutable(["> prompt"]);
		// Records the budget it was handed at the moment it renders: a HUD that
		// read a stale number would lag the composer by a keystroke.
		const seen: number[] = [];
		class Elastic implements Component, RailRowBudget {
			#budget = 0;
			setRailRowBudget(rows: number): void {
				this.#budget = rows;
			}
			render(): string[] {
				seen.push(this.#budget);
				return Array.from({ length: this.#budget }, (_, i) => `HUD-${i}`);
			}
		}
		const split = new LiveSplit([editor], [new Elastic()], LIVE_SPLIT_LAYOUT, [new Mutable(["status line"])]);
		tui.addChild(transcript);
		tui.addChild(split);

		try {
			tui.start();
			transcript.setLines(["TRANSCRIPT-000", "TRANSCRIPT-001"]);
			tui.requestRender();
			await scheduler.drain(term);

			// 32 rows - 2 transcript - 1 footer - 1 composer = 28.
			expect(seen.at(-1)).toBe(28);
			const viewport = plain(term.getViewport());
			expect(viewport.findIndex(row => row.includes("HUD-27"))).toBe(29);
			expect(viewport.findIndex(row => row.includes("> prompt"))).toBe(30);

			// A composer that grows two rows hands the HUD two fewer, in the same
			// frame: nothing is clipped and the prompt stays on the bottom row.
			editor.setLines(["> prompt", "> second", "> third"]);
			tui.requestComponentRender(split);
			await scheduler.drain(term);

			expect(seen.at(-1)).toBe(26);
			const grown = plain(term.getViewport());
			expect(grown.findIndex(row => row.includes("HUD-25"))).toBe(27);
			expect(grown.some(row => row.includes("HUD-26"))).toBe(false);
			expect(grown.findIndex(row => row.includes("> third"))).toBe(30);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
