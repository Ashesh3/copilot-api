export function isGithubOrigin(
  url: URL,
  options: { allowGithubApi?: boolean } = {},
): boolean {
  return (
    url.protocol === "https:"
    && (url.hostname === "githubcopilot.com"
      || url.hostname.endsWith(".githubcopilot.com")
      || (options.allowGithubApi === true && url.hostname === "api.github.com"))
  )
}
