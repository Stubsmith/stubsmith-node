import { VERSION } from "./_version.js";
import { install, isInstalled } from "./instrument.js";

export { VERSION } from "./_version.js";
export { PrivacyPipeline } from "./privacy/index.js";
export { StubsmithClient } from "./client.js";
export { fixtures, fixturesBundle, Fixture, FixtureBundle } from "./fixtures.js";
export type { FixturesOptions } from "./fixtures.js";
export { fetchBundle, pullBundle } from "./pull.js";
export type { BundleSummary, FetchBundleOptions, PullBundleOptions, PullBundleResult } from "./pull.js";
export { install, isInstalled } from "./instrument.js";
export type {
  CaptureSource,
  CapturedExchange,
  FlushOptions,
  HeaderRecord,
  StubsmithOptions,
} from "./types.js";

export default { install, isInstalled, VERSION };

export { replay, replayAll, byStatus, StubNotFound, ReplayContext, ServedResponse, loadBundle, resolveBundle } from "./replay/index.js";
export type {
  Bundle,
  BundleEndpoint,
  BundleSample,
  BundleSource,
  BundleStub,
  BundleTruncated,
  BundleVariant,
  RecordedResponse,
  ReplayAllOptions,
  ReplayOptions,
  SelectFn,
} from "./replay/index.js";
