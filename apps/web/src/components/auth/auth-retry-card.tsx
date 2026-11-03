import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { useTranslation } from "react-i18next";

/** A failed load on the sign-in and sign-up pages: what went wrong and a retry button. */
export function AuthRetryCard({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["common"]);
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button className="min-h-[44px] w-full" onClick={onRetry}>
          {t("common:actions.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
