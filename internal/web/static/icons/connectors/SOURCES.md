# Connector logos

Brand logos shown in the connector rows on the admin Connections page
(`/connections`). Each file was downloaded once, rebuilt from its path data
only (no ids, metadata, scripts, styles or external references), and is
served from `/static/icons/connectors/`. The stylesheet picks a logo by the
row's id; see the "Connector logo tile" block in `internal/web/styles/theme.css`.

All logos are trademarks of their respective owners and are used only to
identify the integrations.

| File | Source | Licence | Notes |
|---|---|---|---|
| `google.svg` | Devicon `icons/google/google-original.svg` (https://github.com/devicons/devicon) | MIT | white backing shape removed |
| `slack.svg` | Devicon `icons/slack/slack-original.svg` | MIT | original four colours |
| `gitlab.svg` | Devicon `icons/gitlab/gitlab-original.svg` | MIT | original colours |
| `aws.svg`, `aws-dark.svg` | Devicon `icons/amazonwebservices/amazonwebservices-original-wordmark.svg` | MIT | dark variant recolours the `#252f3e` wordmark to `#f3f0e8`; orange smile unchanged. Used for AWS Account and AWS Bedrock |
| `linear.svg` | Simple Icons `icons/linear.svg` (https://github.com/simple-icons/simple-icons) | CC0-1.0 | brand colour `#5E6AD2` |
| `asana.svg` | Simple Icons `icons/asana.svg` | CC0-1.0 | brand colour `#F06A6A` |
| `gemini.svg` | Simple Icons `icons/googlegemini.svg` | CC0-1.0 | brand colour `#8E75B2` |
| `github.svg`, `github-dark.svg` | Simple Icons `icons/github.svg` | CC0-1.0 | near-black brand: ink `#161513` / cream `#f3f0e8` variants |
| `notion.svg`, `notion-dark.svg` | Simple Icons `icons/notion.svg` | CC0-1.0 | near-black brand: ink / cream variants |
| `anthropic.svg`, `anthropic-dark.svg` | Simple Icons `icons/anthropic.svg` | CC0-1.0 | near-black brand (`#191919`): ink / cream variants |

No logo (neutral plug placeholder): OpenAI (removed from Simple Icons, not
in Devicon), OpenAI-Compatible, Hyperstack, HTTP Proxy, MCP Proxy, and the
test mock connector.
