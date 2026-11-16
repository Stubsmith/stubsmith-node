import { beforeEach } from "vitest";
import { StubsmithClient } from "../../src/client.js";
import { resetWarnOnceForTests } from "../../src/env.js";
import { resetRejectedKeyWarningForTests } from "../../src/refusals.js";

// No test backend syncs by default, so the sender's hold for the first rules sync would delay every capture
// by its full bound. Tests of the hold itself set it back.
StubsmithClient.firstSyncHoldMs = 0;

// Once-per-process warnings: every test starts with them unspent.
beforeEach(() => {
  resetWarnOnceForTests();
  resetRejectedKeyWarningForTests();
});
