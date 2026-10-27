// Compatibility tombstone: historical records remain in the ledger.
// This product no longer registers, authenticates, or approves with passkeys.
export class ApprovalAuth {
 constructor(){throw Error('APPROVAL_PASSKEY_RETIRED');}
}
