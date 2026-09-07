import { listCheckouts } from '../../utils/workspace'

/** The product checkouts on this instance, with branch and uncommitted-change counts. */
export default defineEventHandler(() => listCheckouts())
