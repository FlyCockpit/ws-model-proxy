import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ws-model-proxy/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@ws-model-proxy/ui/components/popover";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { AudioLines, ChevronsUpDown, Image, Video } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PoolPrivacyBadge } from "@/components/pool-privacy-badge";
import type { AttachmentModalities } from "@/lib/image-attachments";

import type { ModelOption } from "./chat-test-types";

function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter(
    (option) =>
      option.modelId.toLowerCase().includes(needle) || option.label.toLowerCase().includes(needle),
  );
}

function ModelModalityIcons({ modalities }: { modalities: AttachmentModalities }) {
  const { t } = useTranslation(["common", "dashboard"]);
  const icons = [
    { enabled: modalities.image, Icon: Image, label: t("dashboard:models.vision") },
    { enabled: modalities.audio, Icon: AudioLines, label: t("dashboard:models.audio") },
    { enabled: modalities.video, Icon: Video, label: t("dashboard:models.video") },
  ];

  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {icons.map(({ enabled, Icon, label }) =>
        enabled ? <Icon key={label} className="size-3.5" aria-label={label} /> : null,
      )}
    </span>
  );
}

export function ModelPicker({
  options,
  value,
  onValueChange,
  disabled = false,
}: {
  options: ModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.modelId === value);
  const filtered = useMemo(() => filterModelOptions(options, query), [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t("dashboard:chatTest.modelPicker")}
            disabled={disabled || options.length === 0}
            className={cn(
              "h-auto min-h-[44px] min-w-0 flex-1 justify-between gap-2 py-2 font-normal whitespace-normal! md:w-80 md:flex-none",
              !selected && "text-muted-foreground",
            )}
          />
        }
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left">
          <span className="min-w-0 break-all">
            {selected?.modelId ?? t("dashboard:chatTest.modelPicker")}
          </span>
          {selected?.kind === "MODEL_POOL" ? (
            <PoolPrivacyBadge external={selected.effectiveProviderEgress === true} />
          ) : null}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--anchor-width)] min-w-[min(100vw-2rem,20rem)] max-w-[calc(100vw-1rem)] p-0"
        align="end"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("dashboard:chatTest.modelFilterPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filtered.length === 0 ? (
              <CommandEmpty>{t("dashboard:chatTest.modelFilterEmpty")}</CommandEmpty>
            ) : (
              <CommandGroup>
                {filtered.map((option) => (
                  <CommandItem
                    key={`${option.kind}:${option.id}`}
                    value={option.modelId}
                    data-checked={option.modelId === value}
                    onSelect={() => {
                      onValueChange(option.modelId);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" title={option.label}>
                        {option.label}
                      </span>
                      <span className="block break-all font-mono text-[11px] text-muted-foreground">
                        {option.modelId}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2">
                      {option.kind === "MODEL_POOL" ? (
                        <PoolPrivacyBadge external={option.effectiveProviderEgress === true} />
                      ) : null}
                      <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {option.kind === "MODEL_POOL"
                          ? t("dashboard:chatTest.modelKinds.pool")
                          : t("dashboard:chatTest.modelKinds.direct")}
                      </span>
                      <ModelModalityIcons modalities={option.attachmentModalities} />
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
