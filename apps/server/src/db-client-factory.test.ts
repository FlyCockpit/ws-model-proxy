// UTC driver regression runs in the server Vitest lane; fixture lives in db
// (pg + adapter mocks) but is excluded from @ws-model-proxy/db check-types.
import "../../../packages/db/src/client-factory.test-helper";
