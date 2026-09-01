export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const GITHUB_CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm"
export const GITHUB_WEB_CLIENT_SECRET =
  "68bbd667b6f1e954c1ab457717c147f221147eba"
export const GITHUB_USER_AGENT = "copilot-api"
export const GITHUB_APP_SCOPES = [
  "read:user",
  "read:org",
  "repo",
  "gist",
  "codespace",
].join(" ")
