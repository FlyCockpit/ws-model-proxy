import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  endOfLocalDay,
  latestMcpPatCustomDate,
  MCP_PAT_NAME_MAX_LENGTH,
  MCP_PAT_NO_EXPIRY_DISABLED_REASON,
  mcpPatClientExpiryCapMs,
} from "@ws-model-proxy/auth/mcp-pat-limits";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Copy, Eye, EyeOff, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { isBadRequest, isConflict, isForbidden } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

function tokenAllowsCliCommands(token: object): boolean {
  return Object.getOwnPropertyDescriptor(token, "allowCliCommands")?.value === true;
}

function copyToClipboard(value: string, message: string) {
  void navigator.clipboard.writeText(value).then(() => toast.success(message));
}

// Preset values are the day counts themselves so the Select value maps 1:1 to
// the wire math in resolveExpiresAtIso.
const EXPIRY_NONE = "none";
const EXPIRY_CUSTOM = "custom";
const EXPIRY_PRESET_DAYS = { "30": 30, "90": 90, "180": 180, "365": 365 } as const;

type ExpiryChoice = typeof EXPIRY_NONE | keyof typeof EXPIRY_PRESET_DAYS | typeof EXPIRY_CUSTOM;

function toLocalDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// ISO strings on the wire: the procedure's z.coerce.date() accepts them and
// they survive the JSON codec untouched. null = no expiry.
function resolveExpiresAtIso(
  choice: ExpiryChoice,
  customDate: string,
  now = new Date(),
): string | null {
  if (choice === EXPIRY_NONE) return null;
  const capMs = mcpPatClientExpiryCapMs(now.getTime());
  if (choice === EXPIRY_CUSTOM) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customDate);
    if (!match) return null;
    // End of a local day can sit past the exact 365×24h cap.
    const end = endOfLocalDay(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return new Date(Math.min(end.getTime(), capMs)).toISOString();
  }
  const days = EXPIRY_PRESET_DAYS[choice];
  return new Date(Math.min(now.getTime() + days * 24 * 60 * 60 * 1000, capMs)).toISOString();
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  return error as Record<string, unknown>;
}

function mentionsExpiryIssue(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(mentionsExpiryIssue);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.path) && record.path.includes("expiresAt")) return true;
  return Object.values(record).some(mentionsExpiryIssue);
}

function createErrorMessageKey(error: unknown): string {
  if (isConflict(error)) return "settings:mcp.tokens.capReached";
  const record = errorRecord(error);
  const data = record?.data;
  if (
    isForbidden(error) &&
    data &&
    typeof data === "object" &&
    "reason" in data &&
    (data as { reason?: unknown }).reason === MCP_PAT_NO_EXPIRY_DISABLED_REASON
  ) {
    return "settings:mcp.tokens.noExpiryDisabled";
  }
  if (isBadRequest(error) && mentionsExpiryIssue(data)) {
    return "settings:mcp.tokens.expiryInvalid";
  }
  return "settings:mcp.tokens.createFailed";
}

export function McpTokensPanel({
  createEnabled,
  allowNoExpiry,
}: {
  createEnabled: boolean;
  allowNoExpiry: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [allowCliCommands, setAllowCliCommands] = useState(false);
  const defaultExpiryChoice: ExpiryChoice = allowNoExpiry ? EXPIRY_NONE : "90";
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>(defaultExpiryChoice);
  const [customDate, setCustomDate] = useState("");
  const [secret, setSecret] = useState("");
  const [showRevoked, setShowRevoked] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);

  const {
    data: tokens,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.mcpTokens.listMine.queryOptions({ input: { includeRevoked: showRevoked } }));

  const create = useMutation(
    orpc.mcpTokens.create.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.listMine.queryKey() });
        setSecret(result.secret);
        toast.success(t("settings:mcp.tokens.created"));
      },
      onError: (error) => {
        toast.error(t(createErrorMessageKey(error)));
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
  // Single source for both the trigger's label lookup (Root `items`) and the
  // popup entries, so the No-expiry option appears/disappears in lockstep.
  const expiryItems = [
    ...(allowNoExpiry
      ? [{ value: EXPIRY_NONE, label: t("settings:mcp.tokens.noExpiryOption") }]
      : []),
    { value: "30", label: t("settings:mcp.tokens.days30") },
    { value: "90", label: t("settings:mcp.tokens.days90") },
    { value: "180", label: t("settings:mcp.tokens.days180") },
    { value: "365", label: t("settings:mcp.tokens.days365") },
    { value: EXPIRY_CUSTOM, label: t("settings:mcp.tokens.customOption") },
  ] as const;
  const now = new Date();
  const minCustomDate = toLocalDateInput(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  );
  // End of local today+365 is past the exact 365×24h server cap for most of the day.
  const maxCustomDate = toLocalDateInput(latestMcpPatCustomDate(now));
  const trimmedName = name.trim();
  const nameIsValid = trimmedName.length >= 1 && trimmedName.length <= MCP_PAT_NAME_MAX_LENGTH;
  const nameInvalid = name.length > 0 && !nameIsValid;
  const customDateBlocked =
    expiryChoice === EXPIRY_CUSTOM && (customDate < minCustomDate || customDate > maxCustomDate);

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
                  setAllowCliCommands(false);
                  setExpiryChoice(defaultExpiryChoice);
                  setCustomDate("");
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
                    if (!nameIsValid || customDateBlocked || secret) return;
                    const expiresAt = resolveExpiresAtIso(expiryChoice, customDate);
                    if (expiryChoice !== EXPIRY_NONE && expiresAt === null) return;
                    const createInput = {
                      name: trimmedName,
                      allowWrite,
                      allowCliCommands: allowWrite && allowCliCommands,
                      expiresAt,
                    };
                    create.mutate(createInput);
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
                          maxLength={MCP_PAT_NAME_MAX_LENGTH}
                          onChange={(event) => setName(event.target.value)}
                          autoComplete="off"
                          aria-invalid={nameInvalid || undefined}
                          aria-describedby={nameInvalid ? "mcp-token-name-error" : undefined}
                        />
                        {nameInvalid ? (
                          <p id="mcp-token-name-error" className="text-sm text-destructive">
                            {t("settings:mcp.tokens.nameInvalid")}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex min-h-[44px] items-start gap-3">
                        <Checkbox
                          id="mcp-token-write"
                          checked={allowWrite}
                          onCheckedChange={(checked) => {
                            const next = checked === true;
                            setAllowWrite(next);
                            if (!next) setAllowCliCommands(false);
                          }}
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
                      {allowWrite ? (
                        <div className="flex min-h-[44px] items-start gap-3">
                          <Checkbox
                            id="mcp-token-cli-commands"
                            checked={allowCliCommands}
                            onCheckedChange={(checked) => setAllowCliCommands(checked === true)}
                          />
                          <div className="space-y-1">
                            <Label htmlFor="mcp-token-cli-commands">
                              {t("settings:mcp.tokens.allowCliCommands")}
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              {t("settings:mcp.tokens.allowCliCommandsHelp")}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      <div className="space-y-2">
                        <Label htmlFor="mcp-token-expiry">
                          {t("settings:mcp.tokens.expiryLabel")}
                        </Label>
                        <Select
                          items={expiryItems}
                          value={expiryChoice}
                          onValueChange={(value) => {
                            if (value !== null) setExpiryChoice(value as ExpiryChoice);
                          }}
                        >
                          <SelectTrigger id="mcp-token-expiry" className="w-full min-h-[44px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {expiryItems.map((item) => (
                              <SelectItem
                                key={item.value}
                                value={item.value}
                                className="min-h-[44px]"
                              >
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-sm text-muted-foreground">
                          {t("settings:mcp.tokens.expiryHelp")}
                        </p>
                        {expiryChoice === EXPIRY_NONE && allowCliCommands ? (
                          <p className="text-sm text-destructive" role="status">
                            {t("settings:mcp.tokens.allowCliCommandsNoExpiryWarning")}
                          </p>
                        ) : null}
                      </div>
                      {expiryChoice === EXPIRY_CUSTOM ? (
                        <div className="space-y-2">
                          <Label htmlFor="mcp-token-expiry-date">
                            {t("settings:mcp.tokens.customDateLabel")}
                          </Label>
                          <Input
                            id="mcp-token-expiry-date"
                            type="date"
                            value={customDate}
                            min={minCustomDate}
                            max={maxCustomDate}
                            className="min-h-[44px]"
                            onChange={(event) => setCustomDate(event.target.value)}
                          />
                        </div>
                      ) : null}
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
                        disabled={create.isPending || !nameIsValid || customDateBlocked}
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
        <div className="flex min-h-[44px] items-start gap-3">
          <Checkbox
            id="mcp-tokens-show-revoked"
            checked={showRevoked}
            onCheckedChange={(checked) => setShowRevoked(checked === true)}
          />
          <div className="space-y-1">
            <Label htmlFor="mcp-tokens-show-revoked">{t("settings:mcp.tokens.showRevoked")}</Label>
          </div>
        </div>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings:mcp.tokens.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {tokens.map((token) => {
              const revoked = token.revokedAt !== null;
              const expired =
                token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();
              return (
                <li
                  key={token.id}
                  className={cn(
                    "min-w-0 space-y-2 rounded-md border p-3",
                    (revoked || expired) && "opacity-60",
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="font-medium break-words">{token.name}</p>
                        {revoked ? (
                          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {t("settings:mcp.tokens.revokedBadge")}
                          </span>
                        ) : expired ? (
                          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {t("settings:mcp.tokens.expiredBadge")}
                          </span>
                        ) : null}
                        {tokenAllowsCliCommands(token) ? (
                          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {t("settings:mcp.tokens.allowCliCommandsBadge")}
                          </span>
                        ) : null}
                      </div>
                      <code className="mt-1 block font-mono text-xs break-all text-muted-foreground">
                        {token.lookupPrefix}…
                      </code>
                    </div>
                    <Button
                      type="button"
                      variant="destructive"
                      className="min-h-[44px] shrink-0"
                      disabled={revoke.isPending || revoked}
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
              );
            })}
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
