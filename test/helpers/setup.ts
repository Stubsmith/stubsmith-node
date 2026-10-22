import { StubsmithClient } from "../../src/client.js";

// No test backend syncs by default, so the sender's hold for the first rules sync would delay every capture
// by its full bound. Tests of the hold itself set it back.
StubsmithClient.firstSyncHoldMs = 0;
