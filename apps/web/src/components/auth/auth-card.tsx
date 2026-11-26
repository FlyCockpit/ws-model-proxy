import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";

/**
 * The signed-out auth screens' frame: the card centred in the page, except on a tall portrait
 * screen from md up (a portrait monitor or tablet), where centring left it floating mid-screen
 * under an empty upper half, so it starts in the upper part instead. Every auth page and its
 * loading state use it, so the card does not move when the page loads.
 */
export const AUTH_SCREEN_CLASS =
  "flex min-h-[80vh] items-center justify-center px-4 md:portrait:items-start md:portrait:pt-[15vh]";

/** The centred card the signed-out auth pages (reset, forgot, verify) share. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className={AUTH_SCREEN_CLASS}>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </div>
  );
}
