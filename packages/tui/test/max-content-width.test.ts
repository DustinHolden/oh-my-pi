/**
 * Contract for `tui.maxContentWidth`: the cap narrows the measure prose is
 * wrapped at without shrinking the frame, so an ultrawide terminal stops
 * handing paragraphs 300-column lines while boxes and rules still span the
 * full width. 0 (default) disables the cap. The render cache must key on the
 * capped measure, or a setting change serves pre-cap rows.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Box } from "../src/components/box";
import { Markdown } from "../src/components/markdown";
import { setMaxContentWidth } from "../src/utils";
import { defaultMarkdownTheme } from "./test-themes";

const PROSE = `${"lorem ipsum dolor sit amet ".repeat(30)}end.`;

function longest(lines: readonly string[]): number {
	return Math.max(...lines.map(line => Bun.stringWidth(line.trimEnd())));
}

describe("tui.maxContentWidth", () => {
	afterEach(() => {
		setMaxContentWidth(0);
	});

	it("wraps prose at the cap while the frame keeps the terminal width", () => {
		const md = new Markdown(PROSE, 1, 0, defaultMarkdownTheme);

		setMaxContentWidth(0);
		md.invalidate();
		const uncapped = md.render(300);
		expect(longest(uncapped)).toBeGreaterThan(200);

		setMaxContentWidth(100);
		md.invalidate();
		const capped = md.render(300);
		expect(longest(capped)).toBeLessThanOrEqual(100);
		// Same text, so a narrower measure must produce more rows.
		expect(capped.length).toBeGreaterThan(uncapped.length);
	});

	it("never widens a terminal narrower than the cap", () => {
		const md = new Markdown(PROSE, 1, 0, defaultMarkdownTheme);
		setMaxContentWidth(200);
		md.invalidate();
		expect(longest(md.render(60))).toBeLessThanOrEqual(60);
	});

	it("leaves box chrome spanning the full terminal width", () => {
		const box = new Box(1, 0);
		box.addChild(new Markdown(PROSE, 0, 0, defaultMarkdownTheme));

		setMaxContentWidth(100);
		box.invalidate();
		const rows = box.render(200);
		expect(rows[0]!.length).toBeGreaterThanOrEqual(200);
	});

	it("re-wraps live rows when the cap changes at the same width", () => {
		const md = new Markdown(PROSE, 1, 0, defaultMarkdownTheme);
		setMaxContentWidth(120);
		const wide = md.render(300);

		// No invalidate(): a cache keyed on the raw terminal width would serve
		// the previous cap's rows for an unchanged width.
		setMaxContentWidth(60);
		const narrow = md.render(300);
		expect(longest(narrow)).toBeLessThanOrEqual(60);
		expect(narrow.length).toBeGreaterThan(wide.length);
	});
});
