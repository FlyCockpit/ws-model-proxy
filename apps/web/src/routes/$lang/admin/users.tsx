import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { hasRole } from "@ws-model-proxy/auth/roles";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
} from "@ws-model-proxy/config/locales";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { TFunction } from "i18next";
import { Archive, ArchiveRestore, Copy, MoreVertical, Plus, Shield, Trash } from "lucide-react";
import { type RefObject, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { LabelledSelect } from "@/components/labelled-select";
import { SegmentedControl } from "@/components/segmented-control";
import { announceArchivedWithUndo } from "@/hooks/archive-undo";
import { useClientDateText } from "@/hooks/use-client-date-text";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHaptics } from "@/hooks/use-haptics";
import { useNamespaceT } from "@/i18n/use-namespace-t";
import { orpc } from "@/utils/orpc";

type StatusFilter = "all" | "active" | "archived";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerified: boolean;
  invitePending: boolean;
  banned: boolean | null;
  banReason: string | null;
  deletionRequestedAt: Date | string | null;
  createdAt: Date | string;
};

function buildInviteSchema(t: TFunction<"admin">) {
  return z.object({
    email: z.string().email(t("users.inviteEmailRequired")),
    name: z.string().trim().min(1, t("users.inviteNameRequired")).max(100),
    role: z.enum(["user", "admin"]),
    locale: z.enum(SUPPORTED_LOCALES),
  });
}

export const Route = createFileRoute("/$lang/admin/users")({
  staticData: { pendingShape: "list", pendingWidth: "wide" },
  component: AdminUsers,
});

function AdminUsers() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { trigger } = useHaptics();
  const { t } = useTranslation(["admin", "common"]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  /** Focus returns here when the invite flow (invite, then the invite link) closes. */
  const inviteButtonRef = useRef<HTMLButtonElement | null>(null);
  const [reveal, setReveal] = useState<{
    email: string;
    setPasswordUrl: string;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const list = useQuery(
    orpc.users.list.queryOptions({
      input: { limit: 100, search: debouncedSearch || undefined },
    }),
  );

  const setRole = useMutation({
    ...orpc.users.setRole.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        trigger("success");
        toast.success(t("admin:users.roleUpdated"));
      },
      onError: () => {
        trigger("error");
      },
    }),
    meta: { errorFallbackKey: "admin:users.roleUpdateFailed" },
  });

  const archive = useMutation({
    ...orpc.users.archive.mutationOptions({
      onSuccess: (_data, input) => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        trigger("success");
        announceArchivedWithUndo({
          message: t("admin:users.userArchived"),
          undoLabel: t("common:actions.undo"),
          onUndo: () => unarchive.mutate({ userId: input.userId }),
        });
      },
      onError: () => {
        trigger("error");
      },
    }),
    meta: { errorFallbackKey: "admin:users.archiveFailed" },
  });

  const unarchive = useMutation({
    ...orpc.users.unarchive.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        trigger("success");
        toast.success(t("admin:users.userRestored"));
      },
      onError: () => {
        trigger("error");
      },
    }),
    meta: { errorFallbackKey: "admin:users.restoreFailed", deletionEntity: "user" },
  });

  const resendInvite = useMutation({
    ...orpc.users.resendInvite.mutationOptions({
      onSuccess: (result, input) => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        if (result.emailSent) toast.success(t("admin:users.inviteSent"));
        else
          setReveal({
            email: list.data?.users.find((user) => user.id === input.userId)?.email ?? "",
            setPasswordUrl: result.setPasswordUrl,
          });
      },
      onError: () => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
      },
    }),
    meta: {
      errorFallbackKey: "admin:users.resendFailed",
      errorCodeKeys: { INVITE_NOT_PENDING: "admin:users.inviteNotPending" },
    },
  });

  const remove = useMutation({
    ...orpc.users.remove.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        trigger("success");
        if (data.pending) {
          toast.success(t("admin:users.userDeletePending"));
        } else {
          toast.success(t("admin:users.userDeleted"));
        }
        setDeleteId(null);
      },
      onError: () => {
        trigger("error");
      },
    }),
    meta: { errorFallbackKey: "admin:users.deleteFailed", deletionEntity: "user" },
  });

  const allUsers = (list.data?.users ?? []) as UserRow[];
  const filtered = allUsers.filter((u) => {
    if (statusFilter === "active") return !u.banned;
    if (statusFilter === "archived") return !!u.banned;
    return true;
  });
  const deleteTarget = allUsers.find((u) => u.id === deleteId) ?? null;

  return (
    <div className="container mx-auto min-w-0 max-w-7xl px-4 py-8 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("admin:users.title")}</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t("admin:users.description")}
          </p>
        </div>
        <Button
          ref={inviteButtonRef}
          onClick={() => {
            trigger("light");
            setInviteOpen(true);
          }}
          className="min-h-[44px]"
        >
          <Plus className="size-4" /> {t("admin:users.invite")}
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          value={statusFilter}
          onChange={setStatusFilter}
          items={[
            { value: "all", label: t("admin:users.tabAll") },
            { value: "active", label: t("admin:users.tabActive") },
            { value: "archived", label: t("admin:users.tabArchived") },
          ]}
        />
        <Input
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder={t("admin:users.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin:users.allUsers")}</CardTitle>
          <CardDescription>
            <UsersCountText
              pending={list.isPending}
              failed={list.isError}
              total={list.data?.total ?? 0}
              shown={filtered.length}
            />
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <UsersListContent
            pending={list.isPending}
            failed={list.isError}
            onRetry={() => list.refetch()}
            users={filtered}
            searching={Boolean(search.trim())}
            statusFilter={statusFilter}
            selfId={session.user.id}
            onSetRole={(user, role) => {
              trigger("light");
              setRole.mutate({ userId: user.id, role });
            }}
            onArchive={(user) => {
              trigger("warning");
              archive.mutate({ userId: user.id });
            }}
            onUnarchive={(user) => {
              trigger("light");
              unarchive.mutate({ userId: user.id });
            }}
            onResendInvite={(user) => resendInvite.mutate({ userId: user.id })}
            onDelete={(user) => {
              trigger("warning");
              setDeleteId(user.id);
            }}
          />
        </CardContent>
      </Card>

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        returnFocus={inviteButtonRef}
        onInvited={(payload) => {
          setInviteOpen(false);
          setReveal(payload);
          if (!payload) toast.success(t("admin:users.inviteSent"));
          queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        }}
      />

      <RevealInviteDialog
        reveal={reveal}
        onClose={() => setReveal(null)}
        returnFocus={inviteButtonRef}
      />

      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
        title={t("admin:users.deleteTitle")}
        description={t("admin:users.deleteDescription")}
        confirmToken={deleteTarget?.email ?? ""}
        typePrompt={t("admin:users.typeEmailToConfirm")}
        copyAriaLabel={t("admin:users.copyEmailAriaLabel")}
        inputMode="email"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          remove.mutate({ userId: deleteTarget.id });
        }}
      />
    </div>
  );
}

function UsersCountText({
  pending,
  failed,
  total,
  shown,
}: {
  pending: boolean;
  failed: boolean;
  total: number;
  shown: number;
}) {
  const { t } = useTranslation(["admin", "common"]);
  if (pending) return t("admin:users.loading");
  if (failed) return t("admin:users.loadFailedShort");
  return t("admin:users.totalCount", { count: total, shown, total });
}

type UserRowHandlers = {
  onSetRole: (user: UserRow, role: "user" | "admin") => void;
  onArchive: (user: UserRow) => void;
  onUnarchive: (user: UserRow) => void;
  onDelete: (user: UserRow) => void;
  onResendInvite: (user: UserRow) => void;
};

function UsersListContent({
  pending,
  failed,
  onRetry,
  users,
  searching,
  statusFilter,
  selfId,
  ...handlers
}: {
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  users: UserRow[];
  searching: boolean;
  statusFilter: StatusFilter;
  selfId: string;
} & UserRowHandlers) {
  const { t } = useTranslation(["admin", "common"]);
  if (pending) return <ListSkeleton />;
  if (failed) {
    return (
      <InlineRetry className="py-12" message={t("admin:users.loadFailed")} onRetry={onRetry} />
    );
  }
  if (users.length === 0) {
    return <UsersEmptyState searching={searching} statusFilter={statusFilter} />;
  }
  return (
    <ul className="divide-y">
      {users.map((user) => (
        <UserListItem key={user.id} user={user} isSelf={user.id === selfId} {...handlers} />
      ))}
    </ul>
  );
}

function emptyUsersTitleKey(searching: boolean, statusFilter: StatusFilter) {
  if (searching) return "admin:users.noMatch" as const;
  if (statusFilter === "archived") return "admin:users.noArchived" as const;
  if (statusFilter === "active") return "admin:users.noActive" as const;
  return "admin:users.noUsersYet" as const;
}

function UsersEmptyState({
  searching,
  statusFilter,
}: {
  searching: boolean;
  statusFilter: StatusFilter;
}) {
  const { t } = useTranslation(["admin", "common"]);
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-sm font-medium">{t(emptyUsersTitleKey(searching, statusFilter))}</p>
      <p className="text-sm text-muted-foreground">
        {searching ? t("admin:users.tryDifferentQuery") : t("admin:users.inviteFirst")}
      </p>
    </div>
  );
}

function UserListItem({
  user,
  isSelf,
  onSetRole,
  onArchive,
  onUnarchive,
  onResendInvite,
  onDelete,
}: { user: UserRow; isSelf: boolean } & UserRowHandlers) {
  const { t } = useTranslation(["admin", "common"]);
  const isAdmin = hasRole(user.role, "admin");
  const isArchived = !!user.banned;
  const isDeleting = Boolean(user.deletionRequestedAt);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:items-center">
      {/* The actions stay beside the name; they drop below it only when the name column would go
          under 12rem (a large browser font size on a phone). */}
      <div className="min-w-0 grow basis-48">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="truncate">{user.name || user.email}</span>
          {isSelf && (
            <span className="rounded-full border bg-muted px-1.5 py-0.5 text-xs font-medium uppercase min-w-0 [overflow-wrap:anywhere] text-muted-foreground">
              {t("admin:users.youBadge")}
            </span>
          )}
          <RolePill isAdmin={isAdmin} />
          {isDeleting && <DeletingPill />}
          {isArchived && !isDeleting && <ArchivedPill />}
          {!user.emailVerified && <UnverifiedPill />}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] sm:truncate">
          {user.email} · {t("admin:users.joined")} <JoinedDate value={user.createdAt} />
          {user.banReason ? ` · ${user.banReason}` : ""}
        </p>
      </div>
      <UserActions
        user={user}
        isSelf={isSelf}
        isAdmin={isAdmin}
        isArchived={isArchived}
        onSetRole={(role) => onSetRole(user, role)}
        onArchive={() => onArchive(user)}
        onUnarchive={() => onUnarchive(user)}
        onResendInvite={() => onResendInvite(user)}
        onDelete={() => onDelete(user)}
      />
    </li>
  );
}

function UserActions({
  user,
  isSelf,
  isAdmin,
  isArchived,
  onSetRole,
  onArchive,
  onUnarchive,
  onResendInvite,
  onDelete,
}: {
  user: UserRow;
  isSelf: boolean;
  isAdmin: boolean;
  isArchived: boolean;
  onSetRole: (role: "user" | "admin") => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onResendInvite: () => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px] min-w-[44px] shrink-0"
            aria-label={t("users.actionsAriaLabel", { name: user.name || user.email })}
          />
        }
      >
        <MoreVertical aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {isAdmin ? (
          <DropdownMenuItem disabled={isSelf} onClick={() => onSetRole("user")}>
            <Shield className="size-4" />
            {t("users.demoteToUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => onSetRole("admin")}>
            <Shield className="size-4" />
            {t("users.promoteToAdmin")}
          </DropdownMenuItem>
        )}
        {user.invitePending && !isArchived && !user.deletionRequestedAt && (
          <DropdownMenuItem onClick={onResendInvite}>{t("users.resendInvite")}</DropdownMenuItem>
        )}
        {isArchived ? (
          <DropdownMenuItem onClick={onUnarchive}>
            <ArchiveRestore className="size-4" />
            {t("users.restoreUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={isSelf} onClick={onArchive}>
            <Archive className="size-4" />
            {t("users.archiveUser")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={isSelf} onClick={onDelete}>
          <Trash className="size-4" />
          {t("users.deleteAction")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The join date in the browser's locale and timezone. The server has neither, so it renders the
 * UTC calendar date and the browser swaps in its own text after hydration, keeping the two
 * renders identical while hydrating.
 */
function JoinedDate({ value }: { value: Date | string }) {
  const { text, iso } = useClientDateText(value);
  return <time dateTime={iso}>{text}</time>;
}

function RolePill({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation("admin");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium uppercase min-w-0 [overflow-wrap:anywhere]",
        isAdmin
          ? "bg-violet-500/10 text-violet-700 dark:text-violet-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {isAdmin ? t("users.adminBadge") : t("users.userBadge")}
    </span>
  );
}

function ArchivedPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium uppercase min-w-0 [overflow-wrap:anywhere] text-amber-700 dark:text-amber-400">
      {t("users.archivedBadge")}
    </span>
  );
}

function DeletingPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-red-500/10 px-1.5 py-0.5 text-xs font-medium uppercase min-w-0 [overflow-wrap:anywhere] text-red-700 dark:text-red-400">
      {t("users.deletingBadge")}
    </span>
  );
}

function UnverifiedPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium uppercase min-w-0 [overflow-wrap:anywhere] text-muted-foreground">
      {t("users.unverifiedBadge")}
    </span>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={`user-skel-${i}`} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="size-9" />
        </li>
      ))}
    </ul>
  );
}

function InviteUserDialog({
  open,
  onOpenChange,
  onInvited,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onInvited: (reveal: { email: string; setPasswordUrl: string } | null) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const tAdmin = useNamespaceT("admin");
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const invite = useMutation({
    ...orpc.users.invite.mutationOptions({
      // A failed invite may still have created the account (INVITE_INCOMPLETE): show it.
      onError: () => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
      },
    }),
    meta: {
      errorFallbackKey: "admin:users.inviteFailed",
      errorCodeKeys: {
        INVITE_INCOMPLETE: "admin:users.inviteIncomplete",
        INVITE_NOT_PENDING: "admin:users.inviteNotPending",
      },
    },
  });

  const form = useForm({
    defaultValues: {
      email: "",
      name: "",
      role: "user" as "user" | "admin",
      locale: isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE,
    },
    validators: { onChange: buildInviteSchema(tAdmin) },
    onSubmit: async ({ value }) => {
      let result: Awaited<ReturnType<typeof invite.mutateAsync>>;
      try {
        result = await invite.mutateAsync(value);
      } catch {
        // The mutation cache's error toast says what failed; the dialog stays open.
        return;
      }
      onInvited(
        result.emailSent ? null : { email: value.email, setPasswordUrl: result.setPasswordUrl },
      );
      form.reset();
    },
  });

  const formId = useId();
  const close = (next: boolean) => {
    if (!invite.isPending) {
      if (!next) form.reset();
      onOpenChange(next);
    }
  };

  // A bottom drawer on phones and a dialog from md up, like the app's other create flows (New
  // pool, New API key); the footer's submit button reaches the form through `form={formId}`.
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={close}
      returnFocus={returnFocus}
      title={t("admin:users.inviteTitle")}
      description={t("admin:users.inviteDescription")}
      footer={
        <div className="flex min-w-0 flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-[44px]"
            onClick={() => close(false)}
            disabled={invite.isPending}
          >
            {t("common:actions.cancel")}
          </Button>
          <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button
                type="submit"
                form={formId}
                className="min-h-[44px]"
                disabled={!canSubmit || isSubmitting || invite.isPending}
              >
                {isSubmitting || invite.isPending
                  ? t("admin:users.inviting")
                  : t("admin:users.sendInvite")}
              </Button>
            )}
          </form.Subscribe>
        </div>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className="space-y-3 pb-2"
      >
        <form.Field name="name">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>{t("admin:users.nameLabel")}</Label>
              <Input
                id={field.name}
                name={field.name}
                autoComplete="name"
                className="min-h-11"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>

        <form.Field name="email">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>{t("admin:users.emailLabel")}</Label>
              <Input
                id={field.name}
                name={field.name}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder={t("admin:users.emailPlaceholder")}
                className="min-h-11"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>

        <form.Field name="locale">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>{t("admin:users.localeLabel")}</Label>
              <LabelledSelect
                id={field.name}
                value={field.state.value}
                onValueChange={field.handleChange}
                options={SUPPORTED_LOCALES.map((locale) => ({
                  value: locale,
                  label: t(`common:locale.${locale}`),
                }))}
              />
              <p className="text-xs text-muted-foreground">{t("admin:users.localeDescription")}</p>
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="role">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>{t("admin:users.roleLabel")}</Label>
              <LabelledSelect
                id={field.name}
                value={field.state.value}
                onValueChange={field.handleChange}
                options={[
                  { value: "user", label: t("admin:users.roleUser") },
                  { value: "admin", label: t("admin:users.roleAdmin") },
                ]}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
      </form>
    </ResponsiveDialog>
  );
}

function FieldErrors({
  field,
}: {
  field: { state: { meta: { errors: Array<{ message?: string } | string | undefined> } } };
}) {
  const firstMessage = field.state.meta.errors.reduce<string | null>((acc, e) => {
    if (acc) return acc;
    const msg = typeof e === "string" ? e : e?.message;
    return msg ?? null;
  }, null);
  if (!firstMessage) return null;
  return <p className="text-sm text-destructive">{firstMessage}</p>;
}

function RevealInviteDialog({
  reveal,
  onClose,
  returnFocus,
}: {
  reveal: { email: string; setPasswordUrl: string } | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const { feedback, copy } = useCopyFeedback(2_000);
  const { t } = useTranslation(["admin", "common", "errors"]);
  const onCopy = async () => {
    if (!reveal) return;
    if (await copy(reveal.setPasswordUrl)) toast.success(t("admin:users.linkCopied"));
    else toast.error(t("errors:couldNotCopy"));
  };
  return (
    <ResponsiveDialog
      open={!!reveal}
      returnFocus={returnFocus}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("admin:users.revealTitle")}
      description={t("admin:users.revealNotEmailedDescription", { email: reveal?.email ?? "" })}
      footer={
        <Button onClick={onClose} className="min-h-[44px]">
          {t("admin:users.savedLink")}
        </Button>
      }
    >
      <div className="space-y-1.5 pb-2">
        <Label>{t("admin:users.setPasswordLinkLabel")}</Label>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border bg-muted px-2 py-1 font-mono text-sm">
            {reveal?.setPasswordUrl}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="min-h-[44px] min-w-[44px]"
            onClick={onCopy}
            aria-label={t("admin:users.copyInviteLinkAriaLabel")}
          >
            <Copy className="size-4" />{" "}
            <span className="sr-only">
              {feedback === "copied" ? t("common:actions.copied") : t("common:actions.copy")}
            </span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("admin:users.inviteLinkHint")}</p>
      </div>
    </ResponsiveDialog>
  );
}
