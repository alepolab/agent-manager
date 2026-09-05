import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export default defineEventHandler(async () => {
  // Only meaningful when the browser and the server share a desktop.
  if (process.env.LOCAL_DESKTOP !== '1') throw createError({ statusCode: 404, message: 'Not available on a shared server' })
  const platform = process.platform

  if (platform === 'darwin') {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'tell app "Finder" to activate' -e 'POSIX path of (choose folder with prompt "Select project folder")'`
      )
      return { path: stdout.trim().replace(/\/$/, '') }
    } catch (err: any) {
      // Exit code 1 = user cancelled — not an error
      if (err.code === 1 || (err.stderr && /User canceled|cancelled/i.test(err.stderr))) {
        return { path: null }
      }
      throw createError({ statusCode: 500, message: err.stderr?.trim() || err.message })
    }
  }

  if (platform === 'win32') {
    try {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "Select project folder"',
        '$d.ShowNewFolderButton = $true',
        'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }',
      ].join('; ')
      const { stdout } = await execAsync(`powershell -Command "${script}"`)
      return { path: stdout.trim() || null }
    } catch (err: any) {
      throw createError({ statusCode: 500, message: err.message })
    }
  }

  // Linux
  try {
    const { stdout } = await execAsync('zenity --file-selection --directory --title="Select project folder"')
    return { path: stdout.trim() || null }
  } catch (err: any) {
    if (err.code === 1) return { path: null } // cancelled
    try {
      const { stdout } = await execAsync('kdialog --getexistingdirectory .')
      return { path: stdout.trim() || null }
    } catch {
      throw createError({ statusCode: 500, message: 'No folder picker available (install zenity or kdialog)' })
    }
  }
})
