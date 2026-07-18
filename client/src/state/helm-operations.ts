import { create } from 'zustand';

interface HelmOperationsState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useHelmOperationsStore = create<HelmOperationsState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
