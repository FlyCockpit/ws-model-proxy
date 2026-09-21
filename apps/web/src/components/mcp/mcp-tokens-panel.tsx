import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Copy, Eye, EyeOff, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { isConflict } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

function copyToClipboard(value: string, message: string) {
  void navigator.clipboard.writeText(value).then(() => toast.success(message));
}

export function McpTokensPanel({ createEnabled }: { createEnabled: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [secret, setSecret] = useState("");
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);

  const {
    data: tokens,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.mcpTokens.listMine.queryOptions());

  const create = useMutation(
    orpc.mcpTokens.create.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.listMine.queryKey() });
        setSecret(result.secret);
        toast.success(t("settings:mcp.tokens.created"));
      },
      onError: (error) => {
        toast.error(
          isConflict(error)
            ? t("settings:mcp.tokens.capReached")
            : t("settings:mcp.tokens.createFailed"),
        );
      },
    }),
  );

  const revoke = useMutation(
    orpc.mcpTokens.revokeMine.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.listMine.queryKey() });
        toast.success(t("settings:mcp.tokens.revoked"));
        setPendingRevokeId(null);
      },
      onError: () => {
        toast.error(t("settings:mcp.tokens.revokeFailed"));
      },
    }),
  );

  const pendingToken = tokens?.find((token) => token.id === pendingRevokeId);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:mcp.tokens.title")}</CardTitle>
          <CardDescription>{t("settings:mcp.tokens.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-9 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return <InlineRetry message={t("settings:mcp.tokens.loadFailed")} onRetry={() => refetch()} />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>{t("settings:mcp.tokens.title")}</CardTitle>
            <CardDescription>{t("settings:mcp.tokens.description")}</CardDescription>
          </div>
          {createEnabled ? (
            <Dialog
              open={createOpen}
              onOpenChange={(open) => {
                setCreateOpen(open);
                if (!open) {
                  setName("");
                  setAllowWrite(false);
                  setSecret("");
                }
              }}
            >
              <DialogTrigger
                render={
                  <Button type="button" className="min-h-[44px] shrink-0">
                    <Plus className="size-4" />
                    {t("settings:mcp.tokens.create")}
                  </Button>
                }
              />
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{t("settings:mcp.tokens.createTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("settings:mcp.tokens.createDescription")}
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (name && !secret) create.mutate({ name, allowWrite });
                  }}
                >
                  {secret ? (
                    <p className="text-sm">
                      {t("settings:mcp.tokens.name")}: <span className="font-medium">{name}</span>
                    </p>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="mcp-token-name">{t("settings:mcp.tokens.name")}</Label>
                        <Input
                          id="mcp-token-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      <div className="flex min-h-[44px] items-start gap-3">
                        <Checkbox
                          id="mcp-token-write"
                          checked={allowWrite}
                          onCheckedChange={(checked) => setAllowWrite(checked === true)}
                        />
                        <div className="space-y-1">
                          <Label htmlFor="mcp-token-write">
                            {t("settings:mcp.tokens.allowWrite")}
                          </Label>
                          <p className="text-sm text-muted-foreground">
                            {t("settings:mcp.tokens.allowWriteHelp")}
                          </p>
                        </div>
                      </div>
                    </>
                  )}
                  {secret ? (
                    <div className="space-y-3">
                      <SecretBlock
                        label={t("settings:mcp.tokens.secret")}
                        value={secret}
                        help={t("settings:mcp.tokens.oneTimeHelp")}
                      />
                      <SecretBlock
                        label={t("settings:mcp.tokens.mcpUrl")}
                        value={`${origin}/mcp`}
                        help={t("settings:mcp.tokens.mcpUrlHelp")}
                        masked={false}
                      />
                      <SecretBlock
                        label={t("settings:mcp.tokens.grokConfig")}
                        value={t("settings:mcp.tokens.grokTemplate", { origin, secret })}
                        help={t("settings:mcp.tokens.grokConfigHelp")}
                        multiline
                      />
                    </div>
                  ) : null}
                  <DialogFooter>
                    {secret ? (
                      <Button
                        type="button"
                        className="min-h-[44px]"
                        onClick={() => setCreateOpen(false)}
                      >
                        {t("common:actions.close")}
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        className="min-h-[44px]"
                        disabled={!name || create.isPending}
                      >
                        {create.isPending
                          ? t("settings:mcp.tokens.creating")
                          : t("settings:mcp.tokens.create")}
                      </Button>
                    )}
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("settings:mcp.tokens.createDisabled")}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings:mcp.tokens.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {tokens.map((token) => (
              <li key={token.id} className="min-w-0 space-y-2 rounded-md border p-3">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{token.name}</p>
                    <code className="mt-1 block font-mono text-xs break-all text-muted-foreground">
                      {token.lookupPrefix}…
                    </code>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-[44px] shrink-0"
                    disabled={revoke.isPending}
                    onClick={() => setPendingRevokeId(token.id)}
                  >
                    {t("settings:mcp.tokens.revoke")}
                  </Button>
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {token.scopes.map((scope) => (
                    <li
                      key={scope}
                      className="min-w-0 break-all rounded bg-muted px-2 py-0.5 font-mono text-xs"
                    >
                      {scope}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {token.lastUsedAt
                    ? t("settings:mcp.tokens.lastUsed", {
                        date: new Date(token.lastUsedAt).toLocaleString(),
                      })
                    : t("settings:mcp.tokens.neverUsed")}
                  {token.expiresAt
                    ? ` · ${t("settings:mcp.tokens.expires", {
                        date: new Date(token.expiresAt).toLocaleDateString(),
                      })}`
                    : ` · ${t("settings:mcp.tokens.noExpiry")}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={pendingRevokeId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevokeId(null);
        }}
      >
        <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! data-[size=sm]:max-w-[calc(100%-2rem)]! data-[size=sm]:sm:max-w-md!">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:mcp.tokens.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 max-w-full break-words">
              {t("settings:mcp.tokens.revokeDescription", {
                name: pendingToken?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel
              className="min-h-[44px] w-full sm:w-auto"
              disabled={revoke.isPending}
            >
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-[44px] w-full sm:w-auto"
              disabled={revoke.isPending || pendingRevokeId === null}
              onClick={() => {
                if (pendingRevokeId === null) return;
                revoke.mutate({ id: pendingRevokeId });
              }}
            >
              {revoke.isPending
                ? t("settings:mcp.tokens.revoking")
                : t("settings:mcp.tokens.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function SecretBlock({
  label,
  value,
  help,
  multiline = false,
  masked = true,
}: {
  label: string;
  value: string;
  help: string;
  multiline?: boolean;
  masked?: boolean;
}) {
  const { t } = useTranslation(["common", "settings"]);
  const [visible, setVisible] = useState(false);
  const revealed = !masked || visible;

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex min-w-0 items-start gap-2">
        {multiline ? (
          <pre className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-md border bg-background p-3 font-mono text-xs whitespace-pre">
            {revealed ? value : "••••••••••••••••••••••••"}
          </pre>
        ) : (
          <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap border bg-background px-3 py-3 font-mono text-xs tracking-wide">
            {revealed ? value : "••••••••••••••••••••••••"}
          </code>
        )}
        <Button
          type="button"
          size="icon-touch"
          variant="outline"
          className="shrink-0"
          onClick={() => copyToClipboard(value, t("common:actions.copied"))}
          aria-label={t("settings:mcp.tokens.copy")}
        >
          <Copy className="size-4" />
        </Button>
        {masked ? (
          <Button
            type="button"
            size="icon-touch"
            variant="outline"
            className="shrink-0"
            onClick={() => setVisible((current) => !current)}
            aria-label={visible ? t("settings:mcp.tokens.hide") : t("settings:mcp.tokens.show")}
            aria-pressed={visible}
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}
