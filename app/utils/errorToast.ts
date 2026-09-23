/**
 * One shape for the hand-rolled catches that end in `toast.add()`.
 *
 * The server's message already says why - `requireCapability` names the role
 * that holds the capability, and `requireGateRole` names whose gate it is - so
 * the title only has to name what failed. Except on a refusal: "Failed to save
 * agent" above "Ask operator" asks the same question twice and answers it two
 * different ways, so a 403 gets a title that agrees with its own description.
 */
export function errorToast(title: string, e: unknown) {
  const err = e as { statusCode?: number, message?: string, data?: { statusCode?: number, message?: string } }
  const statusCode = err?.statusCode ?? err?.data?.statusCode
  return {
    title: statusCode === 403 ? 'Not allowed' : title,
    description: err?.data?.message || err?.message,
    color: 'error' as const,
  }
}
