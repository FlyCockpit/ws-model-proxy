// Run the driver-level regression in the server's normal CI Vitest lane.
// Its fixture lives in db so pg/adapter mocks resolve against that package.
import "../../../packages/db/src/client-factory.test-helper";
