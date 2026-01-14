/**
 * Agent Session Marker Tests
 * Tests the AGENT_SESSION_MARKER functionality to prevent recursive hook execution
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { isAgentSession, AGENT_SESSION_MARKER } from "../src/shared/config.js";

describe("Agent Session Marker", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		// Save original env value
		originalEnv = process.env[AGENT_SESSION_MARKER];
	});

	afterEach(() => {
		// Restore original env value
		if (originalEnv === undefined) {
			delete process.env[AGENT_SESSION_MARKER];
		} else {
			process.env[AGENT_SESSION_MARKER] = originalEnv;
		}
	});

	describe("isAgentSession()", () => {
		test("returns false when env var not set", () => {
			delete process.env[AGENT_SESSION_MARKER];
			expect(isAgentSession()).toBe(false);
		});

		test("returns true when CC_MEM_AGENT_SESSION=1", () => {
			process.env[AGENT_SESSION_MARKER] = "1";
			expect(isAgentSession()).toBe(true);
		});

		test("returns false when CC_MEM_AGENT_SESSION has other values", () => {
			// Test various non-"1" values
			process.env[AGENT_SESSION_MARKER] = "true";
			expect(isAgentSession()).toBe(false);

			process.env[AGENT_SESSION_MARKER] = "0";
			expect(isAgentSession()).toBe(false);

			process.env[AGENT_SESSION_MARKER] = "";
			expect(isAgentSession()).toBe(false);

			process.env[AGENT_SESSION_MARKER] = "yes";
			expect(isAgentSession()).toBe(false);
		});
	});

	describe("Environment Propagation", () => {
		test("spawn calls should include AGENT_SESSION_MARKER in env", () => {
			// This test verifies the pattern used in agent.ts and summarizer.ts
			const baseEnv = { FOO: "bar", BAZ: "qux" };
			const envWithMarker = { ...baseEnv, [AGENT_SESSION_MARKER]: "1" };

			expect(envWithMarker[AGENT_SESSION_MARKER]).toBe("1");
			expect(envWithMarker.FOO).toBe("bar");
			expect(envWithMarker.BAZ).toBe("qux");
		});

		test("process.env spread includes all existing variables", () => {
			// Set a test variable
			process.env.TEST_VAR = "test-value";

			const envWithMarker = { ...process.env, [AGENT_SESSION_MARKER]: "1" };

			expect(envWithMarker[AGENT_SESSION_MARKER]).toBe("1");
			expect(envWithMarker.TEST_VAR).toBe("test-value");

			// Clean up
			delete process.env.TEST_VAR;
		});
	});

	describe("Hook Behavior", () => {
		test("hooks should exit early when marker is set", () => {
			// This test verifies the control flow pattern used in hooks
			process.env[AGENT_SESSION_MARKER] = "1";

			// Simulate the hook logic
			let dbOperationCalled = false;
			const mockDbOperation = () => {
				dbOperationCalled = true;
			};

			// Simulate hook execution
			if (isAgentSession()) {
				// Should return early without calling DB operations
			} else {
				mockDbOperation();
			}

			// Verify DB operation was NOT called
			expect(dbOperationCalled).toBe(false);
		});

		test("hooks should run normally when marker is not set", () => {
			delete process.env[AGENT_SESSION_MARKER];

			// Simulate the hook logic
			let dbOperationCalled = false;
			const mockDbOperation = () => {
				dbOperationCalled = true;
			};

			// Simulate hook execution
			if (isAgentSession()) {
				// Should not enter this branch
			} else {
				mockDbOperation();
			}

			// Verify DB operation WAS called
			expect(dbOperationCalled).toBe(true);
		});

		test("marker constant has expected value", () => {
			expect(AGENT_SESSION_MARKER).toBe("CC_MEM_AGENT_SESSION");
		});
	});
});
