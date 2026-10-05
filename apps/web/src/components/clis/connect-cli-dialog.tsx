import { Link } from "@tanstack/react-router";
import { env } from "@ws-model-proxy/env/web";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ws-model-proxy/ui/components/dialog";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CopyableModelId } from "@/components/forwarder-dashboard-sections";

/** How to attach another machine: one command, then approve it in the browser. */
export function ConnectCliDialog({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="touch">
            <Plus className="size-4" />
            {t("dashboard:clis.connect.button")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dashboard:clis.connect.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:clis.connect.description")}</DialogDescription>
        </DialogHeader>
        <ol className="min-w-0 space-y-3 text-sm">
          <li className="min-w-0 space-y-1">
            <p>{t("dashboard:clis.connect.install")}</p>
          </li>
          <li className="min-w-0 space-y-1">
            <p>{t("dashboard:clis.connect.server")}</p>
            <CopyableModelId
              modelId={`wsmp config set-server ${env.VITE_SERVER_URL}`}
              copyLabel={t("dashboard:clis.connect.copyCommand")}
            />
          </li>
          <li className="min-w-0 space-y-1">
            <p>{t("dashboard:clis.connect.login")}</p>
            <CopyableModelId
              modelId="wsmp login"
              copyLabel={t("dashboard:clis.connect.copyCommand")}
            />
          </li>
          <li className="min-w-0 space-y-1">
            <p>{t("dashboard:clis.connect.approve")}</p>
          </li>
          <li className="min-w-0 space-y-1">
            <p>{t("dashboard:clis.connect.endpoints")}</p>
            <CopyableModelId
              modelId="wsmp endpoints add local http://127.0.0.1:11434"
              copyLabel={t("dashboard:clis.connect.copyCommand")}
            />
          </li>
          <li className="min-w-0 space-y-1">
            <p>{t("dashboard:clis.connect.service")}</p>
            <CopyableModelId
              modelId="wsmp service install"
              copyLabel={t("dashboard:clis.connect.copyCommand")}
            />
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          {t("dashboard:clis.connect.tokensHint")}{" "}
          <Link
            to="/$lang/dashboard/cli-tokens"
            params={{ lang }}
            className={buttonVariants({ variant: "link", size: "sm" })}
          >
            {t("dashboard:nav.cliTokens")}
          </Link>
        </p>
      </DialogContent>
    </Dialog>
  );
}
