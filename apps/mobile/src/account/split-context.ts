import { createContext, useContext } from 'react';

export const SplitContext = createContext(false);

/** True while an account page is rendered beside the persistent account list. */
export const useSplitDetail = () => useContext(SplitContext);
