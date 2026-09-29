// Listener close regression runs in the server Vitest lane; the fixture lives
// in db (pg mock) but is excluded from @ws-model-proxy/db check-types.
import "../../../packages/db/src/postgres-notifications.test-helper";
