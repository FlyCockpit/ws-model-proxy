import { useEffect, useRef } from "react";

import {
  type GuardedWizardCapacity,
  type GuardedWizardLocalModel,
  minimumSelectedPhysicalContext,
  safeContextControls,
} from "@/lib/guarded-pool-wizard-validation";

export function capacityDerivedDefaults({
  selectedIds,
  models,
  capacities,
  contextCeilingCustomized,
  contextMarginCustomized,
}: {
  selectedIds: readonly string[];
  models: readonly GuardedWizardLocalModel[];
  capacities: readonly GuardedWizardCapacity[];
  contextCeilingCustomized: boolean;
  contextMarginCustomized: boolean;
}) {
  const physicalMaximum = minimumSelectedPhysicalContext(selectedIds, models, capacities);
  if (physicalMaximum == null) return null;
  const safe = safeContextControls(physicalMaximum);
  return {
    contextCeiling: contextCeilingCustomized ? undefined : safe.contextCeiling,
    contextMargin: contextMarginCustomized ? undefined : safe.contextMargin,
  };
}

export function useCapacityDerivedDefaults({
  selectedIds,
  models,
  capacities,
  contextCeilingCustomized,
  contextMarginCustomized,
  apply,
}: {
  selectedIds: readonly string[];
  models: readonly GuardedWizardLocalModel[];
  capacities: readonly GuardedWizardCapacity[];
  contextCeilingCustomized: boolean;
  contextMarginCustomized: boolean;
  apply: (defaults: { contextCeiling?: number; contextMargin?: number }) => void;
}) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const physicalMaximum = minimumSelectedPhysicalContext(selectedIds, models, capacities);
  useEffect(() => {
    if (physicalMaximum == null) return;
    const safe = safeContextControls(physicalMaximum);
    applyRef.current({
      contextCeiling: contextCeilingCustomized ? undefined : safe.contextCeiling,
      contextMargin: contextMarginCustomized ? undefined : safe.contextMargin,
    });
  }, [contextCeilingCustomized, contextMarginCustomized, physicalMaximum]);
}
