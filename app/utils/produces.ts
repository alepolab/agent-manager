/**
 * A produced filename the runner can never satisfy, caught while a person is
 * looking at it. `resolveRunArtifact` returns null for anything that resolves
 * outside the run's artifacts directory, and the output check turns that null
 * into "<name> was not written" - so a typo'd `../report.md` is an
 * unsatisfiable requirement whose only symptom is a step sent back, after it
 * has already run and spent its budget.
 */
export function producesError(names: string[] | undefined): string | null {
  for (const name of names ?? []) {
    if (/^[/\\]/.test(name) || /^[A-Za-z]:/.test(name) || name.includes('\\')) return `"${name}" must be a path inside the run's artifacts directory`
    if (name.split('/').includes('..')) return `"${name}" climbs out of the run's artifacts directory`
  }
  return null
}
