import { useQuery } from "@tanstack/react-query";
import { AGENT_SCOPES, type AgentScope } from "@ws-model-proxy/api/contracts";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import { agentScopeLabelKey, type EditableAgentAccess } from "@/lib/agent-access";
import { orpc } from "@/utils/orpc";

/** Shared by consent, minting and editing. The nodes.list contract returns only owned nodes. */
export function AgentAccessChoice({
  value,
  onChange,
  availableScopes = AGENT_SCOPES,
  disabled = false,
}: {
  value: EditableAgentAccess;
  onChange: (next: EditableAgentAccess) => void;
  availableScopes?: readonly AgentScope[];
  disabled?: boolean;
}) {
  const { t } = useTranslation(["access"]);
  const id = useId();
  const [selectedNodeIds, setSelectedNodeIds] = useState(value.nodeIds ?? []);
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), enabled: value.nodeIds !== null });
  const selectable = AGENT_SCOPES.filter((scope) => availableScopes.includes(scope));
  return (
    <div className="min-w-0 space-y-4">
      <fieldset disabled={disabled} className="min-w-0 space-y-1">
        <legend className="text-sm font-medium">{t("access:agents.scopesTitle")}</legend>
        {selectable.length > 1 ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="my-2"
            disabled={disabled}
            onClick={() => onChange({ ...value, scopes: [...selectable] })}
          >
            {t("access:agents.everything")}
          </Button>
        ) : null}
        {selectable.map((scope) => (
          <label
            key={scope}
            htmlFor={`${id}-${scope}`}
            className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted"
          >
            <Checkbox
              id={`${id}-${scope}`}
              className="mt-1"
              checked={scope === "read" || value.scopes.includes(scope)}
              disabled={disabled || scope === "read"}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  scopes: AGENT_SCOPES.filter(
                    (candidate) =>
                      candidate === "read" ||
                      (candidate === scope ? checked === true : value.scopes.includes(candidate)),
                  ),
                })
              }
            />
            <span className="min-w-0 text-sm">
              <span className="block font-medium">
                {t(`access:agents.scopes.${agentScopeLabelKey[scope]}.name`)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(`access:agents.scopes.${agentScopeLabelKey[scope]}.description`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={disabled} className="min-w-0 space-y-1">
        <legend className="text-sm font-medium">{t("access:agents.nodesTitle")}</legend>
        {(["all", "selected"] as const).map((choice) => (
          <label
            key={choice}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 p-2"
          >
            <input
              type="radio"
              className="size-4 shrink-0 appearance-none rounded-full border border-muted-foreground bg-transparent dark:bg-input/30 checked:border-primary checked:bg-primary dark:checked:bg-primary checked:shadow-[inset_0_0_0_3px_var(--background)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              disabled={disabled}
              name={`${id}-nodes`}
              value={choice}
              checked={choice === "all" ? value.nodeIds === null : value.nodeIds !== null}
              onChange={() => {
                if (choice === "all" && value.nodeIds !== null) {
                  setSelectedNodeIds(value.nodeIds);
                }
                onChange({ ...value, nodeIds: choice === "all" ? null : selectedNodeIds });
              }}
            />
            <span className="min-w-0 text-sm">
              {t(choice === "all" ? "access:agents.allNodes" : "access:agents.onlyNodes")}
            </span>
          </label>
        ))}
        {value.nodeIds !== null ? (
          <div className="min-w-0 rounded-md border p-2">
            {nodes.isPending ? (
              <div className="space-y-2" aria-hidden="true">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : nodes.isError ? (
              <InlineRetry
                message={t("access:agents.nodesFailed")}
                onRetry={() => nodes.refetch()}
              />
            ) : nodes.data.nodes.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">{t("access:agents.noNodes")}</p>
            ) : (
              nodes.data.nodes.map((node) => (
                <label
                  key={node.id}
                  htmlFor={`${id}-node-${node.id}`}
                  className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted"
                >
                  <Checkbox
                    id={`${id}-node-${node.id}`}
                    checked={value.nodeIds?.includes(node.id)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...value,
                        nodeIds:
                          checked === true
                            ? [...(value.nodeIds ?? []), node.id]
                            : (value.nodeIds ?? []).filter((nodeId) => nodeId !== node.id),
                      })
                    }
                  />
                  <span className="min-w-0 break-words text-sm">{node.name ?? node.slug}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
        {value.nodeIds?.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("access:agents.noNodesSelected")}</p>
        ) : null}
      </fieldset>
    </div>
  );
}

export function AgentAccessSummary({ scopes, nodeIds }: EditableAgentAccess) {
  const { t } = useTranslation(["access"]);
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions(),
    enabled: nodeIds !== null && nodeIds.length > 0,
  });
  const slugs = nodeIds?.map((id) => nodes.data?.nodes.find((node) => node.id === id)?.slug);
  const names = slugs?.every((slug) => slug !== undefined) ? slugs.join(", ") : undefined;
  const nodeLabel =
    nodeIds === null
      ? t("access:agents.allNodes")
      : nodeIds.length > 0 && nodeIds.length <= 3 && names
        ? names
        : t("access:agents.nodeCount", { count: nodeIds.length });
  return (
    <p className="min-w-0 max-w-full text-xs text-muted-foreground">
      {scopes.length > 0 ? (
        <span className="min-w-0 break-words">
          {scopes
            .map((scope) => t(`access:agents.scopes.${agentScopeLabelKey[scope]}.name`))
            .join(", ")}
        </span>
      ) : null}
      {scopes.length > 0 ? " " : null}
      <span className="inline-flex min-w-0 max-w-full items-baseline gap-1 align-bottom">
        {scopes.length > 0 ? <span aria-hidden="true">·</span> : null}
        <span className="min-w-0 max-w-96 truncate" title={names ?? nodeLabel}>
          {nodeLabel}
        </span>
      </span>
    </p>
  );
}
