import { useQuery } from "@tanstack/react-query";
import { AGENT_SCOPES, type AgentScope } from "@ws-model-proxy/api/contracts";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { AdvancedSection } from "@ws-model-proxy/ui/components/form-page";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { TFunction } from "i18next";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import {
  agentAccessPresets,
  agentScopeLabelKey,
  type EditableAgentAccess,
  matchAgentAccessPreset,
} from "@/lib/agent-access";
import { orpc } from "@/utils/orpc";

const RADIO_CLASS =
  "size-4 shrink-0 appearance-none rounded-full border border-muted-foreground bg-transparent dark:bg-input/30 checked:border-primary checked:bg-primary dark:checked:bg-primary checked:shadow-[inset_0_0_0_3px_var(--background)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

/**
 * Shared by consent, minting and editing: an access level first (presets, the quick path), the
 * permissions one by one under a collapsed disclosure (opened by "Custom"), then the nodes. The nodes.list contract returns only owned nodes.
 */
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
  // "Custom" chosen by hand keeps the grid open for editing even while it matches a preset.
  const [customChosen, setCustomChosen] = useState(false);
  const selectable = AGENT_SCOPES.filter((scope) => availableScopes.includes(scope));
  // The one-by-one grid starts open only when the starting access matches no preset; choosing
  // "Custom" opens it (a native <details>, opened from the event, no effect).
  const [gridStartsOpen] = useState(
    () => matchAgentAccessPreset(value.scopes, selectable) === null,
  );
  const gridRef = useRef<HTMLDetailsElement>(null);
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), enabled: value.nodeIds !== null });
  const presets = agentAccessPresets(selectable);
  const matched = matchAgentAccessPreset(value.scopes, selectable);
  const ceiling = selectable.length < AGENT_SCOPES.length;
  const presetOptions = [
    ...presets.map((preset) => ({
      key: preset.id,
      name: t(`access:agents.presets.${preset.id}.name`),
      description:
        preset.id === "full" && ceiling
          ? t("access:agents.presets.full.ceilingDescription")
          : t(`access:agents.presets.${preset.id}.description`),
      checked: !customChosen && matched === preset.id,
      choose: () => {
        setCustomChosen(false);
        onChange({ ...value, scopes: preset.scopes });
      },
    })),
    {
      key: "custom" as const,
      name: t("access:agents.presets.custom.name"),
      description: t("access:agents.presets.custom.description"),
      checked: customChosen || matched === null,
      choose: () => {
        setCustomChosen(true);
        if (gridRef.current) gridRef.current.open = true;
      },
    },
  ];
  const chosenNames = selectable
    .filter((scope) => scope === "read" || value.scopes.includes(scope))
    .map((scope) => t(`access:agents.scopes.${agentScopeLabelKey[scope]}.name`))
    .join(", ");
  const grid = (
    <div className="grid min-w-0 gap-x-3 gap-y-1 @md:grid-cols-2">
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
    </div>
  );
  return (
    <div className="@container min-w-0 space-y-6">
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        <legend className="mb-2 text-base font-semibold">{t("access:agents.scopesTitle")}</legend>
        {presets.length > 0 ? (
          <div
            role="radiogroup"
            aria-label={t("access:agents.presetsLabel")}
            className="grid min-w-0 gap-2 @md:grid-cols-2"
          >
            {presetOptions.map((option) => (
              <label
                key={option.key}
                className={cn(
                  "flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  option.checked ? "border-primary bg-muted" : "hover:bg-muted/50",
                )}
              >
                <input
                  type="radio"
                  className={cn(RADIO_CLASS, "mt-0.5")}
                  name={`${id}-preset`}
                  value={option.key}
                  checked={option.checked}
                  disabled={disabled}
                  aria-labelledby={`${id}-preset-${option.key}`}
                  aria-describedby={`${id}-preset-${option.key}-description`}
                  onChange={option.choose}
                />
                <span className="min-w-0 text-sm">
                  <span id={`${id}-preset-${option.key}`} className="block font-medium">
                    {option.name}
                  </span>
                  <span
                    id={`${id}-preset-${option.key}-description`}
                    className="block text-xs text-muted-foreground"
                  >
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {presets.length > 0 ? (
          <AdvancedSection
            gridClassName="lg:grid-cols-1"
            title={t("access:agents.scopesDetail")}
            summary={chosenNames}
            ref={gridRef}
            defaultOpen={gridStartsOpen}
          >
            {grid}
          </AdvancedSection>
        ) : (
          grid
        )}
      </fieldset>
      <fieldset disabled={disabled} className="min-w-0 space-y-1">
        <legend className="mb-2 text-base font-semibold">{t("access:agents.nodesTitle")}</legend>
        {(["all", "selected"] as const).map((choice) => (
          <label
            key={choice}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 p-2"
          >
            <input
              type="radio"
              className={RADIO_CLASS}
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
          <div className="grid min-w-0 rounded-md border p-2 @md:grid-cols-2">
            {nodes.isPending ? (
              <div className="space-y-2 @md:col-span-2" aria-hidden="true">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : nodes.isError ? (
              <InlineRetry
                className="@md:col-span-2"
                message={t("access:agents.nodesFailed")}
                onRetry={() => nodes.refetch()}
              />
            ) : nodes.data.nodes.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground @md:col-span-2">
                {t("access:agents.noNodes")}
              </p>
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

/**
 * One line saying what the chosen access amounts to ("Run models · All my nodes"), for the action
 * bar of the sheets that mint or edit access.
 */
export function agentAccessSummaryText(
  t: TFunction<readonly ["access", ...string[]]>,
  value: EditableAgentAccess,
  availableScopes: readonly AgentScope[] = AGENT_SCOPES,
): string {
  const selectable = AGENT_SCOPES.filter((scope) => availableScopes.includes(scope));
  const preset = matchAgentAccessPreset(value.scopes, selectable);
  const count = new Set<AgentScope>(["read", ...value.scopes]).size;
  const access = preset
    ? t(`access:agents.presets.${preset}.name`)
    : t("access:agents.summary.custom", { count });
  const nodes =
    value.nodeIds === null
      ? t("access:agents.allNodes")
      : t("access:agents.nodeCount", { count: value.nodeIds.length });
  return `${access} · ${nodes}`;
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
