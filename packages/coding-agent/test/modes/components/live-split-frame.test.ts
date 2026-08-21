import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	LIVE_SPLIT_LAYOUT,
	LiveSplit,
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

class Mutable implements Component {
	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = [...lines];
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
});
