// A namespace is not execution authority: exact branch remains approval-bound.
export const managedTaskBranch=value=>typeof value==='string'&&/^(?:dsh-task|acceptance)\/[a-z0-9][a-z0-9-]{0,63}$/.test(value);
