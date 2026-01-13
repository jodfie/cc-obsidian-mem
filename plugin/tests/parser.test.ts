/**
 * Parser Tests
 * Tests XML parsing for observations and summaries
 */

import { describe, test, expect } from "bun:test";
import {
	parseObservations,
	parseSummary,
	hasObservations,
	hasSummary,
	hasSkipIndicator,
	extractLastAssistantMessage,
} from "../src/sdk/parser.js";

describe("Parser", () => {
	describe("parseObservations", () => {
		test("parses valid observation XML", () => {
			const xml = `
				Some text before
				<observation>
					<type>decision</type>
					<title>Use SQLite for storage</title>
					<subtitle>Replacing JSON files</subtitle>
					<facts>
						<fact>ACID guarantees</fact>
						<fact>FTS5 search support</fact>
					</facts>
					<concepts>
						<concept>database</concept>
						<concept>architecture</concept>
					</concepts>
					<narrative>SQLite provides better reliability.</narrative>
					<files_read>
						<file>config.ts</file>
					</files_read>
					<files_modified>
						<file>database.ts</file>
					</files_modified>
				</observation>
				Some text after
			`;

			const observations = parseObservations(xml);

			expect(observations).toHaveLength(1);
			expect(observations[0].type).toBe("decision");
			expect(observations[0].title).toBe("Use SQLite for storage");
			expect(observations[0].subtitle).toBe("Replacing JSON files");
			expect(observations[0].facts).toEqual(["ACID guarantees", "FTS5 search support"]);
			expect(observations[0].concepts).toEqual(["database", "architecture"]);
			expect(observations[0].narrative).toBe("SQLite provides better reliability.");
			expect(observations[0].files_read).toEqual(["config.ts"]);
			expect(observations[0].files_modified).toEqual(["database.ts"]);
		});

		test("parses multiple observations", () => {
			const xml = `
				<observation>
					<type>bugfix</type>
					<title>Fix null pointer</title>
				</observation>
				<observation>
					<type>feature</type>
					<title>Add caching</title>
				</observation>
			`;

			const observations = parseObservations(xml);

			expect(observations).toHaveLength(2);
			expect(observations[0].type).toBe("bugfix");
			expect(observations[0].title).toBe("Fix null pointer");
			expect(observations[1].type).toBe("feature");
			expect(observations[1].title).toBe("Add caching");
		});

		test("uses default type for invalid type", () => {
			const xml = `
				<observation>
					<type>invalid_type</type>
					<title>Some observation</title>
				</observation>
			`;

			const observations = parseObservations(xml, "discovery");

			expect(observations).toHaveLength(1);
			expect(observations[0].type).toBe("discovery");
		});

		test("uses default type when type is missing", () => {
			const xml = `
				<observation>
					<title>Some observation</title>
				</observation>
			`;

			const observations = parseObservations(xml, "change");

			expect(observations).toHaveLength(1);
			expect(observations[0].type).toBe("change");
		});

		test("returns empty array for missing title", () => {
			const xml = `
				<observation>
					<type>decision</type>
					<subtitle>No title here</subtitle>
				</observation>
			`;

			const observations = parseObservations(xml);

			expect(observations).toHaveLength(0);
		});

		test("filters out placeholder values", () => {
			const xml = `
				<observation>
					<type>decision</type>
					<title>Real title</title>
					<facts>
						<fact>A specific actionable fact</fact>
						<fact>Real fact here</fact>
					</facts>
					<concepts>
						<concept>Related concept from the concept list</concept>
						<concept>security</concept>
					</concepts>
				</observation>
			`;

			const observations = parseObservations(xml);

			expect(observations).toHaveLength(1);
			expect(observations[0].facts).toEqual(["Real fact here"]);
			expect(observations[0].concepts).toEqual(["security"]);
		});

		test("returns empty array for no observations", () => {
			const xml = "Just some plain text without any XML";

			const observations = parseObservations(xml);

			expect(observations).toHaveLength(0);
		});

		test("handles malformed XML gracefully", () => {
			const xml = `
				<observation>
					<type>decision
					<title>Unclosed tags
				</observation>
			`;

			// Should not throw, just return empty or partial results
			const observations = parseObservations(xml);
			expect(observations).toHaveLength(0);
		});

		test("handles whitespace in tags", () => {
			const xml = `
				<observation>
					<type>  decision  </type>
					<title>  Trimmed title  </title>
				</observation>
			`;

			const observations = parseObservations(xml);

			expect(observations).toHaveLength(1);
			expect(observations[0].type).toBe("decision");
			expect(observations[0].title).toBe("Trimmed title");
		});
	});

	describe("parseSummary", () => {
		test("parses valid summary XML", () => {
			const xml = `
				<summary>
					<request>Implement feature X</request>
					<investigated>Looked at module Y</investigated>
					<learned>Pattern Z works well</learned>
					<completed>Added the feature</completed>
					<next_steps>Write tests</next_steps>
					<notes>Consider caching</notes>
				</summary>
			`;

			const summary = parseSummary(xml);

			expect(summary.skip).toBe(false);
			expect(summary.request).toBe("Implement feature X");
			expect(summary.investigated).toBe("Looked at module Y");
			expect(summary.learned).toBe("Pattern Z works well");
			expect(summary.completed).toBe("Added the feature");
			expect(summary.next_steps).toBe("Write tests");
			expect(summary.notes).toBe("Consider caching");
		});

		test("returns skip=true for skip_summary tag", () => {
			const xml = "Some response with <skip_summary/> in it";

			const summary = parseSummary(xml);

			expect(summary.skip).toBe(true);
			expect(summary.request).toBeNull();
		});

		test("handles self-closing skip_summary tag", () => {
			const xml = "<skip_summary />";

			const summary = parseSummary(xml);

			expect(summary.skip).toBe(true);
		});

		test("returns nulls for missing summary", () => {
			const xml = "No summary here";

			const summary = parseSummary(xml);

			expect(summary.skip).toBe(false);
			expect(summary.request).toBeNull();
			expect(summary.completed).toBeNull();
		});

		test("filters placeholder values in summary fields", () => {
			const xml = `
				<summary>
					<request>Real request</request>
					<investigated>placeholder text</investigated>
					<learned>Actual learning</learned>
				</summary>
			`;

			const summary = parseSummary(xml);

			expect(summary.request).toBe("Real request");
			expect(summary.investigated).toBeNull();
			expect(summary.learned).toBe("Actual learning");
		});
	});

	describe("Helper Functions", () => {
		test("hasObservations returns true when observation tag exists", () => {
			expect(hasObservations("<observation>content</observation>")).toBe(true);
			expect(hasObservations("<OBSERVATION>content</OBSERVATION>")).toBe(true);
			expect(hasObservations("no observation here")).toBe(false);
		});

		test("hasSummary returns true when summary tag exists", () => {
			expect(hasSummary("<summary>content</summary>")).toBe(true);
			expect(hasSummary("<SUMMARY>content</SUMMARY>")).toBe(true);
			expect(hasSummary("no summary here")).toBe(false);
		});

		test("hasSkipIndicator detects skip tags", () => {
			expect(hasSkipIndicator("<skip_summary/>")).toBe(true);
			expect(hasSkipIndicator("<skip_summary />")).toBe(true);
			expect(hasSkipIndicator("<skip/>")).toBe(true);
			expect(hasSkipIndicator("<skip />")).toBe(true);
			expect(hasSkipIndicator("no skip here")).toBe(false);
		});

		test("extractLastAssistantMessage finds last assistant message", () => {
			const messages = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
				{ role: "user", content: "Question" },
				{ role: "assistant", content: "Answer" },
			];

			expect(extractLastAssistantMessage(messages)).toBe("Answer");
		});

		test("extractLastAssistantMessage returns null for no assistant messages", () => {
			const messages = [
				{ role: "user", content: "Hello" },
				{ role: "user", content: "Another question" },
			];

			expect(extractLastAssistantMessage(messages)).toBeNull();
		});

		test("extractLastAssistantMessage returns null for empty array", () => {
			expect(extractLastAssistantMessage([])).toBeNull();
		});
	});
});
