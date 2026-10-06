/**
 * Prints AGENT_MANAGER_LOGIN_PASSWORD_HASH for a password typed at the prompt,
 * so the password itself never lands in a file, a command line or shell
 * history. Paste the printed line into the instance's .env beside
 * AGENT_MANAGER_LOGIN_USER.
 *
 *   node scripts/hash-password.mjs
 *   node scripts/hash-password.mjs >> .env      # prompt goes to stderr
 */
import { createInterface } from 'node:readline'
import { hashPassword } from '../server/utils/passwordLogin.ts'

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    // Echo nothing while the password is typed.
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s) }
    rl.question(question, (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer) })
  })
}

const first = await ask('Password: ')
const again = await ask('Again: ')
if (!first) { console.error('No password entered.'); process.exit(1) }
if (first !== again) { console.error('The two entries differ.'); process.exit(1) }
console.log(`AGENT_MANAGER_LOGIN_PASSWORD_HASH=${await hashPassword(first)}`)
