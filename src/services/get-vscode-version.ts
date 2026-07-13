const FALLBACK = "1.104.3"

export async function getVSCodeVersion() {
  try {
    const response = await fetch(
      "https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin",
    )

    const pkgbuild = await response.text()
    const pkgverRegex = /pkgver=([0-9.]+)/
    const match = pkgbuild.match(pkgverRegex)

    if (match) {
      return match[1]
    }

    return FALLBACK
  } catch {
    return FALLBACK
  }
}
