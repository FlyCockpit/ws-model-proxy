import { createFormHook, createFormHookContexts } from "@tanstack/react-form";

/**
 * TanStack Form with field groups: a form built with `useAppForm` can render a reusable group of
 * fields (`withFieldGroup`) under one of its keys, such as the runtime definition editor under
 * `spec`. Plain `useForm` stays fine for forms without groups.
 */
const { fieldContext, formContext } = createFormHookContexts();

export const { useAppForm, withFieldGroup } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {},
  formComponents: {},
});

/** The `group` a `withFieldGroup` render receives, for helpers that render part of a group. */
export type FieldGroupOf<TData> = Parameters<
  Parameters<typeof withFieldGroup<TData, unknown>>[0]["render"]
>[0]["group"];
