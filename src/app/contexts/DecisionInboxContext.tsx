import { createContext, useContext, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { DecisionInboxItem } from "../../components/chat/decision-inbox";

export interface DecisionInboxContextValue {
  showDecisionInbox: boolean;
  setShowDecisionInbox: Dispatch<SetStateAction<boolean>>;
  decisionInboxLoading: boolean;
  setDecisionInboxLoading: Dispatch<SetStateAction<boolean>>;
  decisionInboxItems: DecisionInboxItem[];
  setDecisionInboxItems: Dispatch<SetStateAction<DecisionInboxItem[]>>;
  decisionReplyBusyKey: string | null;
  setDecisionReplyBusyKey: Dispatch<SetStateAction<string | null>>;
}

const DecisionInboxContext = createContext<DecisionInboxContextValue | null>(null);

export interface DecisionInboxProviderProps {
  children?: ReactNode;
}

export function DecisionInboxProvider({ children }: DecisionInboxProviderProps) {
  const [showDecisionInbox, setShowDecisionInbox] = useState(false);
  const [decisionInboxLoading, setDecisionInboxLoading] = useState(false);
  const [decisionInboxItems, setDecisionInboxItems] = useState<DecisionInboxItem[]>([]);
  const [decisionReplyBusyKey, setDecisionReplyBusyKey] = useState<string | null>(null);

  const value = useMemo<DecisionInboxContextValue>(
    () => ({
      showDecisionInbox,
      setShowDecisionInbox,
      decisionInboxLoading,
      setDecisionInboxLoading,
      decisionInboxItems,
      setDecisionInboxItems,
      decisionReplyBusyKey,
      setDecisionReplyBusyKey,
    }),
    [showDecisionInbox, decisionInboxLoading, decisionInboxItems, decisionReplyBusyKey],
  );

  return <DecisionInboxContext.Provider value={value}>{children}</DecisionInboxContext.Provider>;
}

export function useDecisionInbox(): DecisionInboxContextValue {
  const ctx = useContext(DecisionInboxContext);
  if (!ctx) {
    throw new Error("useDecisionInbox must be used within a DecisionInboxProvider");
  }
  return ctx;
}
