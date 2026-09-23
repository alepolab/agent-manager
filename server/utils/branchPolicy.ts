/**
 * Moved to `shared/branchPolicy.ts` so the Products page can show the same
 * base-branch preview the runner computes, from the same code. This re-export
 * keeps the server-side import path working; there is no second implementation.
 */
export { baseBranchFor, describeBranchChoice, type BranchChoice, type WorkOrigin } from '../../shared/branchPolicy.ts'
