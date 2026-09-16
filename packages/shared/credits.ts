export const creditCosts = { conversation: 30, photo: 150 } as const;
export type CreditKind = keyof typeof creditCosts;
export interface CreditCharge {
  sequence: number;
  kind: CreditKind;
  amount: number;
}
