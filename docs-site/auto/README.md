# flint-docs-site — `auto/` directory

This directory was scaffolded by [Substrate](https://github.com/op4z/substrate) and is now
owned by your project. The framework reads from your copy at runtime; it
will never silently overwrite a file here.

## Layout

| Subdirectory    | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `commands/`     | Per-command documentation (your slash-command surface)             |
| `instructions/` | Per-action playbooks (audits, reviews, scaffolds)                  |
| `scripts/`      | Local shell scripts that extend Substrate's defaults               |
| `config/`       | Project identity, command registry, workflow definitions           |
| `standards/`    | Your team's coding / architecture standards docs                   |
| `audits/`       | Audit report output (one subdirectory per audit type)              |
| `docs/`         | Living documentation (decisions, knowledge, changelogs)            |

## Useful commands

```bash
substrate audit --list             # Enumerate scaffolded audits
substrate audit --type pre-merge   # Run a specific audit
substrate create --template package-ts --name foo
```

## Upgrading

Substrate tracks every scaffolded file in `auto/.substrate-manifest.json`
along with its template version and content hash. `substrate upgrade`
diffs your edits against new template versions and offers a three-way
merge.
