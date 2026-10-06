import { z } from "zod";
import {
  actorRefSchema,
  confirmDeleteSchema,
  descriptionSchema,
  idSchema,
  isoDateSchema,
  nameSchema,
  noInputSchema,
  noteSchema,
  okSchema,
  sha256Schema,
  slugSchema,
} from "./common";
import { mutation, query } from "./procedure";
import { previewOrOperationSchema } from "./runtimes";

export const profileItemViewSchema = z
  .object({
    id: idSchema,
    position: z.number().int().min(0),
    runtimeId: idSchema,
    runtimeSlug: z.string(),
    versionId: idSchema,
    versionNumber: z.number().int(),
    /** The runtime has a newer version than the pin. */
    pinOutdated: z.boolean(),
    count: z.number().int().min(1),
    /** Empty: any of the profile's nodes. */
    nodeIds: z.array(idSchema),
    runningNow: z.number().int(),
  })
  .strict();

export const profileViewSchema = z
  .object({
    id: idSchema,
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    editor: actorRefSchema,
    updatedAt: isoDateSchema,
    nodeIds: z.array(idSchema),
    /** "Hold node" lines: applying stops wsmp runtimes there and holds the node. */
    holds: z.array(z.object({ nodeId: idSchema, note: z.string().nullable() }).strict()),
    items: z.array(profileItemViewSchema),
    /** Every item runs as pinned and nothing else runs on the owned nodes. */
    satisfied: z.boolean(),
    lastApply: z
      .object({ operationId: idSchema, at: isoDateSchema, actor: actorRefSchema })
      .strict()
      .nullable(),
  })
  .strict();

const profileItemInput = z
  .object({
    runtimeId: idSchema,
    /** Omit to pin the runtime's current version (new items) or keep the pin (existing). */
    versionId: idSchema.optional(),
    count: z.number().int().min(1).max(64).default(1),
    nodeIds: z.array(idSchema).max(64).optional(),
  })
  .strict();

export const profilesContract = {
  list: query(
    "agent",
    noInputSchema,
    z.object({ profiles: z.array(profileViewSchema) }).strict(),
    "Profiles: owned nodes, pinned items, satisfied now, last apply.",
    ["profiles_get"],
  ),
  get: query(
    "agent",
    z.object({ profileId: idSchema }).strict(),
    profileViewSchema,
    "One profile.",
    ["profiles_get"],
  ),
  save: mutation(
    "agent",
    z
      .object({
        profileId: idSchema.optional(),
        slug: slugSchema,
        name: nameSchema,
        description: descriptionSchema.optional(),
        nodeIds: z.array(idSchema).min(1).max(64),
        /**
         * "Hold node" lines (owned nodes only). People only: an agent's save keeps the existing
         * hold lines and is refused (human_only) when it changes them.
         */
        holds: z
          .array(z.object({ nodeId: idSchema, note: noteSchema.optional() }).strict())
          .max(64)
          .optional(),
        items: z.array(profileItemInput).max(64),
        /** Move every pin to its runtime's current version. */
        updatePins: z.boolean().optional(),
        note: noteSchema.optional(),
      })
      .strict(),
    profileViewSchema,
    "Create or replace a profile (nodes it owns and what runs there).",
    ["profile_save"],
  ),
  delete: mutation(
    "agent",
    z.object({ profileId: idSchema, confirm: confirmDeleteSchema.optional() }).strict(),
    okSchema,
    "Delete a profile (nothing stops).",
    ["profile_delete"],
  ),
  apply: mutation(
    "agent",
    z
      .object({
        profileId: idSchema,
        preview: z.boolean().optional(),
        /**
         * Required for people (refused with preview_required / preview_stale): they apply exactly
         * the preview they confirmed. Agents may omit it.
         */
        fingerprint: sha256Schema.optional(),
      })
      .strict(),
    previewOrOperationSchema,
    "Apply (or preview): start the pinned items, stop other startable runtimes on the owned nodes, hold the nodes with a hold line and release the other owned nodes. Agents: refused whole if any owned node is Relay only.",
    ["profile_apply"],
  ),
} as const;
