/**
 * Operator terminals (interactive steps) are not in this preview yet: a start or profile apply
 * whose runtime has an interactive step is refused in its preview instead of being sent to a
 * node that would refuse it. The operator-terminal chunk turns this on.
 */
export const INTERACTIVE_STEPS_SUPPORTED = false;
export const INTERACTIVE_UNSUPPORTED_MESSAGE =
  "This runtime has a step a person runs in a terminal; interactive steps are not supported in this preview yet.";
