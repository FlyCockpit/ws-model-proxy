import { create } from "zustand";

/**
 * Whether a page has taken the whole viewport (the maximized terminal): the root shell then hides
 * its Header and BottomNav and the app frame its sidebar and page padding. Not persisted: it is
 * set while the page that asked for it is shown (see `useHideAppChrome`).
 */
export const useAppChrome = create<{
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}>()((set) => ({
  hidden: false,
  setHidden: (hidden) => set({ hidden }),
}));
