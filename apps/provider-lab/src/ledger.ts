export interface LabChargeRecord {
  id: string;
  provider: string;
  providerRef: string;
  idempotencyKey: string;
  amountMinor: string;
  currency: string;
  status: 'succeeded' | 'failed' | 'pending';
  createdAt: Date;
}

/**
 * Independent in-memory ledger kept by Provider Lab.
 * 
 * WHY THIS IS CRUCIAL:
 * The Provider Lab is the external world. Its ledger is the authoritative, independent
 * ground truth for proving the core invariant: ZERO DUPLICATE CHARGES.
 * When tests assert that no customer was charged twice, they verify against this ledger.
 */
class ProviderLabLedger {
  private charges: LabChargeRecord[] = [];

  recordCharge(charge: Omit<LabChargeRecord, 'id' | 'createdAt'>): LabChargeRecord {
    // Check if idempotency key already exists for this provider
    const existing = this.charges.find(
      (c) => c.provider === charge.provider && c.idempotencyKey === charge.idempotencyKey
    );
    if (existing) {
      return existing;
    }

    const record: LabChargeRecord = {
      id: `lab_chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...charge,
      createdAt: new Date(),
    };
    this.charges.push(record);
    return record;
  }

  getCharges(): readonly LabChargeRecord[] {
    return [...this.charges];
  }

  findByRef(provider: string, providerRef: string): LabChargeRecord | undefined {
    return this.charges.find((c) => c.provider === provider && c.providerRef === providerRef);
  }

  reset(): void {
    this.charges = [];
  }
}

export const labLedger = new ProviderLabLedger();
