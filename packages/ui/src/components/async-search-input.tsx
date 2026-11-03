import { InputGroup, InputGroupAddon } from "@ws-model-proxy/ui/components/input-group";
import { Command as CommandPrimitive } from "cmdk";
import { LoaderIcon, SearchIcon } from "lucide-react";

/**
 * The search field at the top of an async combobox's command list: a spinner while results
 * load, a search icon otherwise. Render it inside a `Command`.
 */
function AsyncSearchInput({
  placeholder,
  value,
  onValueChange,
  isLoading,
}: {
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
  isLoading: boolean;
}) {
  return (
    <div data-slot="command-input-wrapper" className="border-b pb-0">
      <InputGroup className="h-8 border-none border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className="w-full text-xs outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={placeholder}
          value={value}
          onValueChange={onValueChange}
        />
        <InputGroupAddon>
          {isLoading ? (
            <LoaderIcon className="size-4 shrink-0 animate-spin opacity-50" />
          ) : (
            <SearchIcon className="size-4 shrink-0 opacity-50" />
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

export { AsyncSearchInput };
