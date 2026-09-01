export const DEFAULT_GITHUB_DOMAIN = "github.com"

export interface GitHubCredential {
  instanceDomain: string
  token: string
}

const GHE_CLOUD_SUFFIX = ".ghe.com"

export function normalizeGitHubDomain(value: string): string {
  const input = value.trim()
  if (!input) throw new TypeError("GitHub instance domain is required")

  let url: URL
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`,
    )
  } catch {
    throw new TypeError(`Invalid GitHub instance domain: ${value}`)
  }

  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new TypeError(
      "GitHub instance must be an HTTPS hostname without a path, port, query, or credentials",
    )
  }

  const hostname = url.hostname.toLowerCase()
  if (
    hostname !== DEFAULT_GITHUB_DOMAIN
    && !hostname.endsWith(GHE_CLOUD_SUFFIX)
  ) {
    throw new TypeError(
      "GitHub instance must be github.com or a GitHub Enterprise Cloud *.ghe.com domain",
    )
  }

  return hostname
}

export function parseGitHubCredential(value: string): GitHubCredential {
  const input = value.trim()
  if (!input) throw new TypeError("GitHub token entry is empty")

  const separator = input.indexOf(":")
  if (separator === -1) {
    return { instanceDomain: DEFAULT_GITHUB_DOMAIN, token: input }
  }

  const instanceDomain = normalizeGitHubDomain(input.slice(0, separator))
  const token = input.slice(separator + 1).trim()
  if (!token)
    throw new TypeError("GitHub token is required after the instance domain")

  return { instanceDomain, token }
}

export function parseGitHubCredentials(value: string): Array<GitHubCredential> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseGitHubCredential(entry))
}

export function formatGitHubCredential(credential: GitHubCredential): string {
  return credential.instanceDomain === DEFAULT_GITHUB_DOMAIN ?
      credential.token
    : `${credential.instanceDomain}:${credential.token}`
}

export function githubBaseUrl(instanceDomain: string): string {
  return `https://${normalizeGitHubDomain(instanceDomain)}`
}

export function isGitHubEnterpriseCloud(instanceDomain: string): boolean {
  return normalizeGitHubDomain(instanceDomain) !== DEFAULT_GITHUB_DOMAIN
}

export function githubApiBaseUrl(instanceDomain: string): string {
  const domain = normalizeGitHubDomain(instanceDomain)
  return domain === DEFAULT_GITHUB_DOMAIN ?
      "https://api.github.com"
    : `https://api.${domain}`
}

export function defaultCopilotApiBaseUrl(instanceDomain: string): string {
  const domain = normalizeGitHubDomain(instanceDomain)
  return domain === DEFAULT_GITHUB_DOMAIN ?
      "https://api.githubcopilot.com"
    : `https://copilot-api.${domain}`
}

export function normalizeCopilotApiBaseUrl(
  value: string,
  instanceDomain: string,
): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || (url.pathname !== "/" && url.pathname !== "")
      || url.search
      || url.hash
    ) {
      return undefined
    }

    const domain = normalizeGitHubDomain(instanceDomain)
    const expectedHost =
      domain === DEFAULT_GITHUB_DOMAIN ?
        new Set([
          "api.githubcopilot.com",
          "api.individual.githubcopilot.com",
          "api.business.githubcopilot.com",
          "api.enterprise.githubcopilot.com",
        ])
      : new Set([`copilot-api.${domain}`])
    if (!expectedHost.has(url.hostname.toLowerCase())) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export function resolveCopilotApiBaseUrl(
  instanceDomain: string,
  discoveredUrl?: string,
  accountType = "individual",
): string {
  if (discoveredUrl) {
    const normalized = normalizeCopilotApiBaseUrl(discoveredUrl, instanceDomain)
    if (normalized) return normalized
  }

  const domain = normalizeGitHubDomain(instanceDomain)
  if (domain !== DEFAULT_GITHUB_DOMAIN) {
    return defaultCopilotApiBaseUrl(domain)
  }

  return accountType === "individual" ?
      defaultCopilotApiBaseUrl(domain)
    : `https://api.${accountType}.githubcopilot.com`
}
