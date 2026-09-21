# prunesh marketplace

The official plugin registry for [prunesh](https://github.com/prunesh/prunesh-core). Browse and install plugins that extend prunesh with support for additional commands.

**Site:** https://prunesh.github.io/marketplace

---

## Installing plugins

```bash
# Latest version from the marketplace
prunesh plugin install prunesh/date

# Pinned version
prunesh plugin install prunesh/date@v0.3.0

# Direct from a Go module (bypasses the marketplace)
prunesh plugin install github.com/prunesh/prunesh-date@v0.3.0
```

---

## Publishing a plugin

### 1. Build your plugin

Your plugin must implement the `stdin/v1` protocol. See the [plugin authoring guide](https://github.com/prunesh/prunesh-core#writing-a-plugin) and the reference plugin [prunesh/date](https://github.com/prunesh/prunesh-date).

Your release must include:
- A `prunesh.json` manifest as a release asset
- Pre-built binaries for each platform listed in `prunesh.json`, named with the pattern `<command>-<os>-<arch>` (e.g. `date-linux-amd64`, `date-darwin-arm64`)

### 2. Add the publish workflow

Copy [`templates/publish.yml`](templates/publish.yml) to `.github/workflows/publish.yml` in your plugin repo and replace `<author>/<command>` with your plugin ID (e.g. `jmeiracorbal/kubectl`).

```yaml
- name: Publish to marketplace
  run: |
    curl -sf -X POST \
      https://prunesh-marketplace-worker.prunesh-marketplace-worker.workers.dev/publish \
      -H "Content-Type: application/json" \
      -d '{
        "oidc_token": "${{ steps.oidc.outputs.token }}",
        "plugin_id": "author/command",
        "version": "${{ github.ref_name }}",
        "repo": "https://github.com/${{ github.repository }}"
      }'
```

### 3. Publish a release

Create a GitHub release with a tag (`v1.0.0`). The workflow runs automatically, validates your plugin against the `stdin/v1` contract, and registers it in the marketplace within minutes.

The first publication of a new plugin ID creates its registry entry automatically — no PR required.

---

## How it works

```
GitHub Release (author repo)
  └─ publish.yml → POST /publish + OIDC token
        └─ Cloudflare Worker (validates OIDC, no secrets distributed)
              └─ repository_dispatch → prunesh/marketplace
                    └─ handle-publish.yml
                          ├─ Downloads prunesh.json from release assets
                          ├─ Resolves binary URLs per platform
                          ├─ Runs stdin/v1 contract probe
                          └─ Commits version file + updates index
                                └─ pages.yml → generates registry.json → GitHub Pages
```

- **No shared tokens** — authentication uses short-lived OIDC tokens from GitHub Actions
- **Immutable versions** — published version files are never overwritten
- **No manual review** — the contract probe is the gatekeeper; if it passes, the plugin is live

---

## Repository structure

```
marketplace/
  plugins/              # one YAML pointer per registered plugin
  site/
    index.html          # marketplace UI
    modules/
      <author>/
        <command>/
          index.json          # latest version pointer (updated on each release)
          v1.0.0.json         # immutable version file
  templates/
    publish.yml         # workflow template for plugin authors
  worker/
    src/index.html      # Cloudflare Worker (OIDC validation + dispatch)
  docs/
    setup.md            # infrastructure setup guide
  .github/workflows/
    pages.yml           # generates registry.json + deploys Pages
    handle-publish.yml  # receives publish events, validates, commits
```

