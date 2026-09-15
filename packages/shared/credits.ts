export const creditCosts = { conversation: 20, photo: 100 } as const;
export type CreditKind = keyof typeof creditCosts;
export interface CreditCharge {
  sequence: number;
  kind: CreditKind;
  amount: number;
}
