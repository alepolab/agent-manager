import { currentUser } from '../../utils/session'
import { teamStatus } from '../../utils/teamSync'
export default defineEventHandler(async (event) => teamStatus((await currentUser(event))?.login))
