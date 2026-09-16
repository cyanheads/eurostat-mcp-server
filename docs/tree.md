# eurostat-mcp-server - Directory Structure

Generated on: 2026-09-16 09:14:40

```text
eurostat-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── eurostat-dataset.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── eurostat-browse-themes.tool.ts
│   │           ├── eurostat-dataframe-describe.tool.ts
│   │           ├── eurostat-dataframe-query.tool.ts
│   │           ├── eurostat-download-dataset.tool.ts
│   │           ├── eurostat-get-dataset-info.tool.ts
│   │           ├── eurostat-get-dimension-values.tool.ts
│   │           ├── eurostat-query-dataset.tool.ts
│   │           └── eurostat-search-datasets.tool.ts
│   ├── services/
│   │   ├── eurostat-bulk/
│   │   │   ├── eurostat-bulk-service.ts
│   │   │   └── types.ts
│   │   ├── eurostat-catalogue/
│   │   │   ├── eurostat-catalogue-service.ts
│   │   │   └── types.ts
│   │   ├── eurostat-data/
│   │   │   ├── eurostat-data-service.ts
│   │   │   ├── sdmx-metadata.ts
│   │   │   └── types.ts
│   │   ├── canvas-accessor.ts
│   │   └── eurostat-codelists.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── eurostat-sdmx-metadata.ts
│   │   ├── sts-inpr-m-ie-confidential.json
│   │   └── sts-inpr-m-ie-empty.json
│   ├── helpers/
│   │   └── real-canvas.ts
│   ├── prompts/
│   ├── resources/
│   │   └── eurostat-dataset.resource.test.ts
│   ├── services/
│   │   ├── canvas-accessor.test.ts
│   │   ├── eurostat-bulk-service.test.ts
│   │   ├── eurostat-catalogue-service.test.ts
│   │   ├── eurostat-data-service.test.ts
│   │   └── eurostat-sdmx-metadata.test.ts
│   └── tools/
│       ├── eurostat-browse-themes.tool.test.ts
│       ├── eurostat-dataframe-describe.tool.test.ts
│       ├── eurostat-dataframe-query.tool.test.ts
│       ├── eurostat-download-dataset.tool.test.ts
│       ├── eurostat-get-dataset-info.tool.test.ts
│       ├── eurostat-get-dimension-values.tool.test.ts
│       ├── eurostat-query-dataset.tool.test.ts
│       ├── eurostat-search-datasets.tool.test.ts
│       └── security-and-edge-cases.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
