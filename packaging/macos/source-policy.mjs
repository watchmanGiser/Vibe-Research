// Exact root files and explicit directories: private sidecars are never root-file matches.
export const allowedSource = /^(?:(?:AGENTS\.md|LICENSE|NOTICE|codex-version\.json|vibe-research\.config\.json|\.vibe-research-root|orchestrator\/package(?:-lock)?\.json|scripts\/check-node\.mjs)$|(?:orchestrator\/(?:src|hooks)|\.agents\/skills|calc|backtest|datasources|providers)\/)/;
export const blockedSource = /(^|\/)(\.local|\.git|\.env(?:\..*)?|auth\.json|__pycache__|node_modules|tests?|\.pytest_cache)(\/|$)|\.(pem|key|pyc|log|bak|backup|private)$/i;
