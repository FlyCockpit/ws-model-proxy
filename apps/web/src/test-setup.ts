import { configure } from "@testing-library/react";

// DOM tests await real conditions (queries settling, renders committing). The
// deadline only bounds a genuine hang; testing-library's 1 s default is shorter
// than a cold first render on a loaded CI runner or shared host.
configure({ asyncUtilTimeout: 10_000 });
