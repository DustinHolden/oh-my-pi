/**
 * Contract: on a wide terminal the sticky HUDs (todos, subagents, ...) move
 * into a right-hand rail beside the composer instead of stacking above it, and
 * a narrow terminal keeps the original stacked order. Asserted against the real
 * assembled `InteractiveMode` tree, not a stub split.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TODO = "wire the rail beside the composer";

describe("InteractiveMode live split", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-live-split-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined);
		await mode.init({ suppressWelcomeIntro: true });
		mode.setTodos([{ name: "Implementation", tasks: [{ content: TODO, status: "in_progress" }] }]);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function frame(width: number): string[] {
		return mode.ui.render(width).map(row => Bun.stripANSI(row).trimEnd());
	}

	it("hosts the todo HUD in a rail beside the composer on a wide terminal", () => {
		const rows = frame(200);
		// The composer's own chrome and rail content occupy one physical row: the
		// HUD is a second column, not a block stacked above the editor.
		const shared = rows.find(row => row.includes("╭── π") && row.includes("TODO"));
		expect(shared).toBeDefined();
		const todoRow = rows.find(row => row.includes(TODO));
		expect(todoRow).toBeDefined();
		// Rail content sits right of the divider, never at the left margin.
		expect(todoRow).toContain("│");
		expect(todoRow!.indexOf("│")).toBeLessThan(todoRow!.indexOf(TODO));
		expect(todoRow!.indexOf(TODO)).toBeGreaterThan(100);
	});

	it("stacks the todo HUD above the composer on a narrow terminal", () => {
		const rows = frame(90);
		const todoIndex = rows.findIndex(row => row.includes(TODO));
		const composerIndex = rows.findIndex(row => row.includes("╭── π"));
		expect(todoIndex).toBeGreaterThanOrEqual(0);
		expect(composerIndex).toBeGreaterThan(todoIndex);
		// No divider column: nothing shares a row with the composer.
		expect(rows.some(row => row.includes("╭── π") && row.includes("TODO"))).toBe(false);
	});
});
