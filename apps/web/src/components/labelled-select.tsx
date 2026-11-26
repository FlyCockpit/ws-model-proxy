import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { cn } from "@ws-model-proxy/ui/lib/utils";

export type SelectOption<T extends string> = { value: T; label: string };

/**
 * A Base UI select over a fixed list of labelled options. The same list feeds the menu and the
 * Root's `items`, so the closed select always shows the option's label, never its raw value
 * (`user`, `1`, `nvidia`). With a `placeholder`, `""` means nothing is picked yet and the closed
 * select says so.
 */
export function LabelledSelect<T extends string>({
  id,
  value,
  options,
  onValueChange,
  disabled,
  invalid,
  describedBy,
  placeholder,
  className,
}: {
  id: string;
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (next: T) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Shown while `value` is `""` (no option picked yet). */
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select
      value={placeholder !== undefined && value === "" ? null : value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger
        id={id}
        size="touch"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn("w-full min-w-0", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
