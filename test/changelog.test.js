import assert from "node:assert/strict";
import { test } from "node:test";
import { selectChangelog } from "../src/changelog.js";

const changelog = "# Changelog\n\n## 1.2.0 - today\n\nNew.\n\n## 1.1.0 - yesterday\n\nOld.\n";

test("selects changelog versions without invoking a model", () => {
  assert.match(selectChangelog(changelog, "last 1").text, /1\.2\.0/);
  assert.doesNotMatch(selectChangelog(changelog, "last 1").text, /1\.1\.0/);
  assert.match(selectChangelog(changelog, "1.1.0").text, /Old/);
  assert.equal(selectChangelog(changelog, "summarize last 1").summarize, true);
});
