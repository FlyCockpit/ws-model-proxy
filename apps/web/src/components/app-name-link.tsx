import { Link } from "@tanstack/react-router";
import { env } from "@ws-model-proxy/env/web";

/**
 * The app name at the start of the header row. It always goes to the landing
 * page (`/$lang`).
 *
 * The name only takes the room the rest of the row leaves it, so it is the
 * first thing to give way and the controls never run past the header's
 * trailing line, whatever the name's length, the width or the locale. Its flex
 * basis is 0 (`basis-0 grow`): it grows into what is left after the controls,
 * up to its own width (`max-w-fit`), and never below a 44px target
 * (`min-w-11`). A shrink factor cannot do this: CSS has no shrink order, and
 * any factor still hands the controls a fraction of a pixel, enough to squeeze
 * the language trigger below its 44px. With a MainNav in the row the two share
 * what is left. The span's caps (160px, 224px from `sm:`, 320px from `lg:`)
 * keep a long name from taking the MainNav's room. A name that does not fit
 * ends in an ellipsis (the `truncate` span: an ellipsis needs a block box, and
 * `truncate` on the inline-flex link only clips), and the full name is the
 * link's `title` and accessible name.
 */
export function AppNameLink({ lang }: { lang: string }) {
  const appName = env.VITE_APP_NAME;
  return (
    <Link
      to="/$lang"
      params={{ lang }}
      className="inline-flex min-h-11 min-w-11 max-w-fit grow basis-0 items-center font-semibold text-lg"
      title={appName}
    >
      <span className="max-w-40 truncate sm:max-w-56 lg:max-w-80">{appName}</span>
    </Link>
  );
}
