import { beforeAll, describe, expect, it } from "bun:test";
import { LiveSplit } from "@oh-my-pi/pi-coding-agent/modes/components/live-split";
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

	render(): string[] {
		this.renders++;
		return this.#lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#lines.length;
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
});
