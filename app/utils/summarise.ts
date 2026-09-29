/** One line, clipped at 90 characters: agent descriptions run to whole paragraphs, and a picker showing them whole is unreadable. */
export function summarise(text?: string): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine
}
