/**
 * What GitHub sign-in asks for.
 *
 * By default it asks for repository access too (`repo`, `read:packages`), and
 * the token it gets becomes the person's token for runs: pushes, pull requests,
 * image pulls. That makes approving the OAuth app for an organisation a grant
 * of write access to every repository each member can reach, held by the
 * server in a token that does not expire.
 *
 * GITHUB_SIGNIN_SCOPE=identity narrows sign-in to proving who someone is and
 * that they are in the org (`read:user user:email read:org`). Repository work
 * then needs each person's own personal access token on their Profile - a
 * fine-grained one, scoped to the repositories and expiring - and the sign-in
 * token is not stored at all.
 */
export const GITHUB_SIGNIN_VAR = 'GITHUB_SIGNIN_SCOPE'

const IDENTITY_SCOPES = 'read:org read:user user:email'
// read:packages is not optional when sign-in supplies the run's token: the
// products' images live in GHCR, and the stack-provisioner pulls them with it.
const REPO_SCOPES = 'read:org repo read:packages read:user user:email'

/** True when GitHub sign-in only identifies people, and grants no repository access. */
export function signInIdentityOnly(): boolean {
  return process.env[GITHUB_SIGNIN_VAR] === 'identity'
}

export function signInScopes(): string {
  return signInIdentityOnly() ? IDENTITY_SCOPES : REPO_SCOPES
}
