import { create } from "zustand";

export const useConfirmation = create<{ message: string | null; finish: ((accepted: boolean) => void) | null }>(() => ({ message: null, finish: null }));
export function confirmAction(message: string): Promise<boolean> {
  if (useConfirmation.getState().finish) return Promise.resolve(false);
  return new Promise(resolve => useConfirmation.setState({ message, finish: accepted => {
    useConfirmation.setState({ message: null, finish: null }); resolve(accepted);
  } }));
}
